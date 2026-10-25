// The process seam: everything the extension does to the outside world goes
// through `execFile`, injectable so the suite can double `gortex hook`.
// The types below describe only what the extension uses, so a double stays a
// small object.

import { execFile as nodeExecFile } from "node:child_process";
import type { ExecFileOptions } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { extname, join, posix, win32 } from "node:path";

export interface ExecFileOpts {
  input?: string;
  maxBuffer?: number;
  timeout?: number;
  windowsHide?: boolean;
  signal?: AbortSignal;
}

export interface ProcessDeps {
  /** Resolves with the child's stdout. Its stderr is collected and dropped, never inherited. */
  execFile(command: string, args: string[], options?: ExecFileOpts): Promise<string>;
}

/**
 * The file `bin` names, directly or through PATH, or undefined. On Windows it
 * searches the way cross-spawn does for Pi's MCP: PATHEXT extensions, the bare
 * name only when it carries one, since npm puts an unspawnable sh script
 * beside its `.cmd` shim.
 */
export function resolveExecutable(
  bin: string,
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const windows = platform === "win32";
  const exts = windows ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean) : [];
  if (!windows || extname(bin) !== "") exts.unshift("");
  const candidates = /[\\/]/.test(bin)
    ? [bin]
    : (env.PATH ?? "").split(windows ? win32.delimiter : posix.delimiter).filter(Boolean).map((dir) => join(dir, bin));
  for (const path of candidates) {
    for (const ext of exts) {
      try {
        accessSync(path + ext, windows ? constants.F_OK : constants.X_OK);
        if (statSync(path + ext).isFile()) return path + ext;
      } catch {
        // not this one
      }
    }
  }
  return undefined;
}

const CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

function cmdQuote(arg: string): string {
  const quoted = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  return `"${quoted}"`.replace(CMD_META_CHARS, "^$1");
}

/**
 * The cmd.exe invocation for a command that resolves to a `.cmd` or `.bat`
 * file, escaped as cross-spawn escapes it. Node refuses to spawn those files
 * directly. `command` stays as written, so cmd.exe searches PATH itself.
 */
export function batchCommand(
  command: string,
  args: string[],
  comspec = "cmd.exe",
): { command: string; args: string[] } {
  const line = [win32.normalize(command).replace(CMD_META_CHARS, "^$1"), ...args.map(cmdQuote)].join(" ");
  return { command: comspec, args: ["/d", "/s", "/c", `"${line}"`] };
}

function run(command: string, args: string[], options: ExecFileOpts, extra: ExecFileOptions = {}) {
  const { input, ...rest } = options;
  let pid: number | undefined;
  const done = new Promise<string>((resolve, reject) => {
    const child = nodeExecFile(command, args, { ...rest, ...extra, encoding: "utf8" }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
    pid = child.pid;
    child.stdin?.on("error", () => {});
    child.stdin?.end(input ?? "");
  });
  return { pid, done };
}

/**
 * Runs a batch file through cmd.exe and, on timeout or abort, kills the whole
 * tree. Node would kill cmd.exe alone and leave the gortex under it running.
 */
function runBatch(batch: { command: string; args: string[] }, options: ExecFileOpts): Promise<string> {
  const { timeout, signal, ...rest } = options;
  const { pid, done } = run(batch.command, batch.args, rest, { windowsVerbatimArguments: true });
  return new Promise((resolve, reject) => {
    const settle = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const stop = (reason: Error) => {
      settle();
      if (pid !== undefined) nodeExecFile("taskkill", ["/T", "/F", "/PID", String(pid)], { windowsHide: true }, () => {});
      reject(reason);
    };
    const onAbort = () => stop(new Error("aborted"));
    const timer = timeout ? setTimeout(() => stop(new Error("timed out")), timeout) : undefined;
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    done.then(
      (out) => {
        settle();
        resolve(out);
      },
      (err: unknown) => {
        settle();
        reject(err);
      },
    );
  });
}

/** The real implementation, narrowed to the surface above. */
export const nodeProcessDeps: ProcessDeps = {
  execFile(command, args, options = {}) {
    const file = process.platform === "win32" ? resolveExecutable(command) : undefined;
    if (file && /\.(cmd|bat)$/i.test(file)) {
      return runBatch(batchCommand(command, args, process.env.ComSpec || process.env.COMSPEC), options);
    }
    return run(command, args, options).done;
  },
};

// The process seam: everything the extension does to the outside world goes
// through `execFileSync`, injectable so the suite can double `gortex hook`.
// The types below describe only what the extension uses, so a double stays a
// small object.

import { execFileSync as nodeExecFileSync } from "node:child_process";
import type { ExecFileSyncOptions } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { extname, join, posix, win32 } from "node:path";

export interface ExecFileSyncOpts {
  input?: string;
  encoding?: "utf8";
  maxBuffer?: number;
  timeout?: number;
  windowsHide?: boolean;
}

export interface ProcessDeps {
  execFileSync(command: string, args: string[], options?: ExecFileSyncOpts): string;
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

/** The real implementation, narrowed to the surface above. */
export const nodeProcessDeps: ProcessDeps = {
  execFileSync(command, args, options) {
    const file = process.platform === "win32" ? resolveExecutable(command) : undefined;
    if (file && /\.(cmd|bat)$/i.test(file)) {
      const batch = batchCommand(command, args, process.env.ComSpec || process.env.COMSPEC);
      // Honoured by execFileSync, which hands it to spawnSync, but missing from its type.
      const verbatim: ExecFileSyncOptions & { windowsVerbatimArguments: boolean } = {
        ...options,
        encoding: "utf8",
        windowsVerbatimArguments: true,
      };
      return String(nodeExecFileSync(batch.command, batch.args, verbatim));
    }
    return String(nodeExecFileSync(command, args, { ...options, encoding: "utf8" }));
  },
};

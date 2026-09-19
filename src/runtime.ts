// The process seam: everything the extension does to the outside world goes
// through `spawn` and `execFileSync`, injectable so the suite can drive the
// bridge against a fake `gortex mcp` child. The types below describe only what
// the bridge uses, so a double stays a small object.

import { execFileSync as nodeExecFileSync, spawn as nodeSpawn } from "node:child_process";
import type { SpawnOptions } from "node:child_process";

export interface ChildStream {
  on(event: string, listener: (chunk: unknown) => void): unknown;
}

export interface ChildStdin {
  on(event: string, listener: (err: unknown) => void): unknown;
  write(chunk: string): unknown;
}

/** The subset of ChildProcess the MCP bridge and the daemon launcher touch. */
export interface BridgeChild {
  stdout?: ChildStream;
  stderr?: ChildStream;
  stdin?: ChildStdin;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  kill(): unknown;
  unref?(): unknown;
}

export interface SpawnOpts {
  stdio?: "ignore" | ("pipe" | "ignore")[];
  detached?: boolean;
  env?: Record<string, string | undefined>;
}

export interface ExecFileSyncOpts {
  input?: string;
  encoding?: "utf8";
  maxBuffer?: number;
  timeout?: number;
}

export interface ProcessDeps {
  spawn(command: string, args: string[], options?: SpawnOpts): BridgeChild;
  execFileSync(command: string, args: string[], options?: ExecFileSyncOpts): string;
}

/**
 * The real implementations. The two casts are the whole impedance mismatch
 * between node's overloaded signatures and the narrow surface above; every
 * consumer downstream stays strictly typed.
 */
export const nodeProcessDeps: ProcessDeps = {
  spawn(command, args, options) {
    return nodeSpawn(command, args, (options ?? {}) as SpawnOptions) as unknown as BridgeChild;
  },
  execFileSync(command, args, options) {
    return String(nodeExecFileSync(command, args, { ...options, encoding: "utf8" }));
  },
};

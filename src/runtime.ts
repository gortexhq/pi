// The process seam: everything the extension does to the outside world goes
// through `execFileSync`, injectable so the suite can double `gortex hook`.
// The types below describe only what the extension uses, so a double stays a
// small object.

import { execFileSync as nodeExecFileSync } from "node:child_process";

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

/** The real implementation, narrowed to the surface above. */
export const nodeProcessDeps: ProcessDeps = {
  execFileSync(command, args, options) {
    return String(nodeExecFileSync(command, args, { ...options, encoding: "utf8" }));
  },
};

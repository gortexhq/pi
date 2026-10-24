// Stand-in for the process seam (src/runtime.ts), injected into the factory so
// the extension's `gortex hook` calls land here. No real `gortex` binary is
// involved. The control object below is the only steering surface the
// scenarios need.

import type { ExecFileSyncOpts, ProcessDeps } from "../../src/runtime.ts";

export interface HookCall {
  bin: string;
  args: string[];
  input: string | undefined;
  opts: ExecFileSyncOpts | undefined;
}

export interface Control {
  hookDecision: Record<string, unknown>;
  hookCalls: HookCall[];
  reset(overrides?: Partial<Control>): void;
}

export const control: Control = {
  // What the Go hook "writes back" for every callHook() envelope.
  hookDecision: {} as Record<string, unknown>,
  // Observations.
  hookCalls: [] as HookCall[],

  reset(overrides: Partial<Control> = {}) {
    this.hookDecision = {};
    this.hookCalls = [];
    Object.assign(this, overrides);
  },
};

export function execFileSync(bin: string, args: string[] = [], opts?: ExecFileSyncOpts): string {
  control.hookCalls.push({ bin, args: [...args], input: opts?.input, opts });
  return JSON.stringify(control.hookDecision);
}

export const mockDeps: ProcessDeps = { execFileSync };

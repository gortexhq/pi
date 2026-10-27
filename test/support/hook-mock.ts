// Stand-in for the process seam (src/runtime.ts), injected into the factory so
// the extension's `gortex hook` calls land here. No real `gortex` binary is
// involved. The control object below is the only steering surface the
// scenarios need.

import type { ExecFileOpts, ProcessDeps } from "../../src/runtime.ts";

export interface HookCall {
  bin: string;
  args: string[];
  input: string | undefined;
  opts: ExecFileOpts | undefined;
}

export interface Control {
  hookDecision: unknown;
  /** Per envelope event, in place of hookDecision. */
  hookDecisions: Record<string, unknown>;
  /** Written back verbatim instead of the JSON of hookDecision. */
  hookOutput: string | undefined;
  /** While set, every hook call waits for it, or rejects once its signal aborts. */
  hookGate: Promise<void> | undefined;
  hookCalls: HookCall[];
  reset(overrides?: Partial<Control>): void;
}

export const control: Control = {
  // What the Go hook "writes back" for every callHook() envelope.
  hookDecision: {},
  hookDecisions: {},
  hookOutput: undefined,
  hookGate: undefined,
  // Observations.
  hookCalls: [] as HookCall[],

  reset(overrides: Partial<Control> = {}) {
    this.hookDecision = {};
    this.hookDecisions = {};
    this.hookOutput = undefined;
    this.hookGate = undefined;
    this.hookCalls = [];
    Object.assign(this, overrides);
  },
};

/** A gate for control.hookGate and the function that opens it. */
export function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

export async function execFile(bin: string, args: string[] = [], opts?: ExecFileOpts): Promise<string> {
  control.hookCalls.push({ bin, args: [...args], input: opts?.input, opts });
  const held = control.hookGate;
  if (held) {
    const signal = opts?.signal;
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(new Error("aborted"));
      if (signal?.aborted) return abort();
      signal?.addEventListener("abort", abort, { once: true });
      void held.then(resolve);
    });
  }
  const event = (JSON.parse(opts?.input ?? "{}") as { event?: string }).event ?? "";
  const decision = event in control.hookDecisions ? control.hookDecisions[event] : control.hookDecision;
  return control.hookOutput ?? JSON.stringify(decision);
}

export const mockDeps: ProcessDeps = { execFile };

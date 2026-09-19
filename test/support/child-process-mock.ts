// Stand-in for the process seam (src/runtime.ts), injected into the factory so
// the extension's spawn()/execFileSync() calls land here. No real `gortex`
// binary is involved. The control object below is the only steering surface
// the scenarios need.

import { EventEmitter } from "node:events";

import type { BridgeChild, ExecFileSyncOpts, ProcessDeps, SpawnOpts } from "../../src/runtime.ts";

export interface HookCall {
  bin: string;
  args: string[];
  input: string | undefined;
}

export interface SpawnRecord {
  bin: string;
  args: string[];
  opts: SpawnOpts | undefined;
}

export interface Control {
  handshakeDelayMs: number;
  toolsListDelayMs: number;
  tools: unknown[];
  hookDecision: Record<string, unknown>;
  failFirstInitialize: boolean;
  holdNextChild: boolean;
  spawns: SpawnRecord[];
  hookCalls: HookCall[];
  children: FakeChild[];
  reset(overrides?: Partial<Control>): void;
}

export const control: Control = {
  // Delay before the child answers `initialize`.
  handshakeDelayMs: 0,
  // Delay before the child answers `tools/list`.
  toolsListDelayMs: 0,
  // Payload for tools/list.
  tools: [] as unknown[],
  // What the Go hook "writes back" for every callHook() envelope.
  hookDecision: {} as Record<string, unknown>,
  // Make the first initialize fail, to exercise start()'s single retry.
  failFirstInitialize: false,
  // Withhold the next spawned child's replies until releaseReplies(). A gate
  // lets a suite hold registration open for as long as it needs without
  // asserting on wall-clock latency.
  holdNextChild: false,

  // Observations.
  spawns: [] as SpawnRecord[],
  hookCalls: [] as HookCall[],
  children: [] as FakeChild[],

  reset(overrides: Partial<Control> = {}) {
    this.handshakeDelayMs = 0;
    this.toolsListDelayMs = 0;
    this.tools = [];
    this.hookDecision = {};
    this.failFirstInitialize = false;
    this.holdNextChild = false;
    this.spawns = [];
    this.hookCalls = [];
    this.children = [];
    Object.assign(this, overrides);
  },
};

let initializeAttempts = 0;

interface Deferred {
  send: () => void;
  delayMs: number;
}

export class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin: EventEmitter & { write: (line: string) => unknown } = Object.assign(new EventEmitter(), {
    write: (line: string) => this.onWrite(line),
  });
  killed = false;
  exited = false;
  held = false;
  pending: Deferred[] = [];

  private reply(obj: unknown, delayMs: number): void {
    const send = () => {
      if (this.killed || this.exited) return;
      this.stdout.emit("data", Buffer.from(JSON.stringify(obj) + "\n", "utf8"));
    };
    if (this.held) {
      this.pending.push({ send, delayMs });
      return;
    }
    if (delayMs > 0) setTimeout(send, delayMs).unref?.();
    else queueMicrotask(send);
  }

  /** Flush everything withheld and answer normally from here on. */
  releaseReplies(): void {
    this.held = false;
    const queued = this.pending;
    this.pending = [];
    for (const { send, delayMs } of queued) {
      if (delayMs > 0) setTimeout(send, delayMs).unref?.();
      else queueMicrotask(send);
    }
  }

  private onWrite(line: string): boolean {
    let msg: { id?: unknown; method?: unknown };
    try {
      msg = JSON.parse(String(line).trim());
    } catch {
      return true;
    }
    // Notifications carry no id and get no reply.
    if (typeof msg.id !== "number") return true;

    if (msg.method === "initialize") {
      initializeAttempts += 1;
      if (control.failFirstInitialize && initializeAttempts === 1) {
        this.reply(
          { jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "daemon warming up" } },
          control.handshakeDelayMs,
        );
        return true;
      }
      this.reply(
        { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: {} } },
        control.handshakeDelayMs,
      );
      return true;
    }

    if (msg.method === "tools/list") {
      this.reply({ jsonrpc: "2.0", id: msg.id, result: { tools: control.tools } }, control.toolsListDelayMs);
      return true;
    }

    if (msg.method === "tools/call") {
      this.reply({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "ok" }] } }, 0);
      return true;
    }

    this.reply({ jsonrpc: "2.0", id: msg.id, result: {} }, 0);
    return true;
  }

  /** Push an unsolicited server notification (used for list_changed re-sync). */
  notify(method: string, params: Record<string, unknown> = {}): void {
    this.stdout.emit("data", Buffer.from(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n", "utf8"));
  }

  kill(): void {
    if (this.killed) return;
    this.killed = true;
    this.exited = true;
    this.emit("exit", 0, null);
  }

  unref(): void {}
}

export function spawn(bin: string, args: string[] = [], opts?: SpawnOpts): BridgeChild {
  control.spawns.push({ bin, args: [...args], opts });

  // `gortex daemon start --detach` is fire-and-forget; the extension only
  // attaches an error handler and unrefs it.
  if (args[0] === "daemon") {
    const stub = Object.assign(new EventEmitter(), { unref: () => {}, kill: () => {} });
    return stub as unknown as BridgeChild;
  }

  const child = new FakeChild();
  child.held = control.holdNextChild;
  control.children.push(child);
  return child as unknown as BridgeChild;
}

export function execFileSync(bin: string, args: string[] = [], opts?: ExecFileSyncOpts): string {
  control.hookCalls.push({ bin, args: [...args], input: opts?.input });
  return JSON.stringify(control.hookDecision);
}

export const mockDeps: ProcessDeps = { spawn, execFileSync };

export function resetInitializeAttempts(): void {
  initializeAttempts = 0;
}

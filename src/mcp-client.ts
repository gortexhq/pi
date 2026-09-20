// MCP stdio client: newline-delimited JSON-RPC 2.0 over one `gortex mcp` child
// per session.

import type { BridgeChild, ProcessDeps } from "./runtime.ts";

export const INIT_TIMEOUT_MS = 60_000;
export const RPC_TIMEOUT_MS = 30_000;
// tools/call cap: generous enough for long analyzers, finite so a wedged
// daemon behind a still-alive child can't hang the agent turn forever.
export const CALL_TIMEOUT_MS = 600_000;
// A single JSON-RPC frame past this cap kills the child: the stream
// can't be resynced mid-frame.
export const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

// Identity reported as MCP clientInfo, plus the wire formats this client can
// decode: the daemon reads the capability and sends list-shaped results compact
// without needing a client-name allowlist entry.
export const CLIENT_NAME = "pi";
export const CLIENT_VERSION = "1.0.0";
export const WIRE_FORMATS: string[] = ["gcx"];
export const PROTOCOL_VERSION = "2025-06-18";

// Floor for the daemon. gortex v0.61.2 is where `gortex mcp` first served the
// persistent bridge this client dials; older daemons expose a fixed tool facade
// with nothing on the other end of the handshake.
export const MIN_GORTEX_VERSION = "0.61.2";

/**
 * Dotted-numeric comparison, prerelease and build suffixes ignored, since the
 * daemon reports "0.64.4" while its CLI prints "v0.64.4+2b5480bf". Unparseable
 * segments count as 0, so a version this cannot read never trips the warning.
 */
export function isBelowVersion(actual: string, floor: string): boolean {
  const parse = (v: string): number[] =>
    v
      .replace(/^v/, "")
      .split(/[+-]/)[0]!
      .split(".")
      .map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(actual);
  const b = parse(floor);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    if (delta !== 0) return delta < 0;
  }
  return false;
}

// Presets the proxy has to be told about. The daemon's own default surface
// already IS core/defer, so those pass nothing. Anything unrecognised (a typo,
// a stale sidecar value) is NOT forwarded: server-side it would parse as a
// one-tool allow-list and silently filter every promoted tool out of the
// session. Fail open to the daemon's default surface instead.
const FORWARDED_PRESETS = new Set(["edit", "nav", "readonly"]);

export interface MCPStdioClientOptions {
  bin: string;
  toolsPreset: string;
  deps: ProcessDeps;
  env?: Record<string, string | undefined>;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export interface ToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/**
 * ensureDaemon brings the shared Gortex daemon up before the MCP child dials
 * it. Idempotent, fire-and-forget (we don't block on the launcher's <=60s
 * readiness poll), and never throws, since a missing binary or spawn failure
 * must not take the extension down. The bridge's initialize retry absorbs the
 * warm-up window.
 */
export function ensureDaemon(bin: string, deps: ProcessDeps): void {
  try {
    const child = deps.spawn(bin, ["daemon", "start", "--detach"], {
      stdio: "ignore",
      detached: true,
    });
    child.on("error", () => {}); // binary missing / spawn failure: swallow
    // No teardown counterpart, by design: the daemon is shared, long-lived
    // infrastructure that outlives the session.
    child.unref?.();
  } catch {
    // never fatal
  }
}

/** textFromResult joins the text parts of an MCP tools/call result. */
export function textFromResult(result: unknown): string {
  const content = (result as { content?: unknown })?.content;
  const parts = Array.isArray(content) ? content : [];
  return parts
    .filter((c): c is { type: string; text: string } =>
      Boolean(c) && (c as { type?: unknown }).type === "text" &&
      typeof (c as { text?: unknown }).text === "string",
    )
    .map((c) => c.text)
    .join("\n");
}

export class MCPStdioClient {
  private child: BridgeChild | null = null;
  private buffer = "";
  private searchStart = 0;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private exited = true;
  private respawnPromise: Promise<void> | null = null;

  private readonly bin: string;
  private readonly toolsPreset: string;
  private readonly deps: ProcessDeps;
  private readonly env: Record<string, string | undefined>;

  // Fired on notifications/tools/list_changed (server-side promotion).
  onToolsListChanged: (() => void) | null = null;

  // Read off the handshake reply. Empty when the daemon withheld the field,
  // which reads as "unknown" everywhere and never as a mismatch.
  serverVersion = "";
  negotiatedProtocol = "";

  constructor(options: MCPStdioClientOptions) {
    this.bin = options.bin;
    this.toolsPreset = options.toolsPreset;
    this.deps = options.deps;
    this.env = options.env ?? process.env;
  }

  private childEnv(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...this.env };
    const preset = this.toolsPreset.trim().toLowerCase();
    // The daemon's own default surface already IS core/defer; only a
    // recognised non-default preset needs the proxy-side narrowing.
    if (!env.GORTEX_TOOLS && FORWARDED_PRESETS.has(preset)) {
      env.GORTEX_TOOLS = preset;
    }
    // Never let a preset hide-block tools promoted later by tools_search.
    if (env.GORTEX_TOOLS && !env.GORTEX_TOOLS_MODE) env.GORTEX_TOOLS_MODE = "defer";
    return env;
  }

  private spawnChild(): void {
    const child = this.deps.spawn(this.bin, ["mcp"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: this.childEnv(),
    });
    this.child = child;
    this.buffer = "";
    this.searchStart = 0;
    this.exited = false;
    child.stdout?.on("data", (chunk: unknown) => this.onData(chunk as Buffer));
    // Consume stderr so the child never blocks on a full pipe; routing it
    // to the terminal would corrupt Pi's TUI.
    child.stderr?.on("data", () => {});
    child.stdin?.on("error", () => {}); // EPIPE race: child may exit before stdin.write() finishes
    child.on("error", () => this.markExited(new Error("gortex mcp spawn failed")));
    child.on("exit", () => this.markExited(new Error("gortex mcp exited")));
  }

  private markExited(err: Error): void {
    if (this.exited && this.pending.size === 0) return;
    this.exited = true;
    this.child = null;
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    let nl: number;
    // Resume the newline scan where the previous chunk left off, so a
    // large frame split across many chunks does not re-scan the whole
    // growing buffer from index 0 on every data event.
    while ((nl = this.buffer.indexOf("\n", this.searchStart)) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      this.searchStart = 0;
      if (!line) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // non-JSON noise, ignore
      }
      this.dispatch(msg);
    }
    this.searchStart = this.buffer.length;
    if (this.buffer.length > MAX_BUFFER_BYTES) {
      // One frame past the cap is fatal for this child (no way to
      // resync mid-frame): pending requests reject, the next call
      // respawns a fresh child.
      this.buffer = "";
      this.searchStart = 0;
      const child = this.child;
      this.markExited(new Error(`gortex mcp frame exceeded ${MAX_BUFFER_BYTES} bytes`));
      try {
        child?.kill();
      } catch {
        // already gone
      }
    }
  }

  private dispatch(msg: unknown): void {
    const frame = msg as { id?: unknown; error?: { code?: number; message?: string }; result?: unknown; method?: unknown };
    if (frame && typeof frame.id === "number" && this.pending.has(frame.id)) {
      const p = this.pending.get(frame.id)!;
      this.pending.delete(frame.id);
      if (p.timer) clearTimeout(p.timer);
      if (frame.error) {
        p.reject(new Error(frame.error.message || `JSON-RPC error ${frame.error.code}`));
      } else {
        p.resolve(frame.result);
      }
      return;
    }
    if (frame && frame.method === "notifications/tools/list_changed") {
      try {
        this.onToolsListChanged?.();
      } catch {
        // best effort; never break the read loop.
      }
    }
  }

  private send(obj: Record<string, unknown>): void {
    if (!this.child || this.exited) throw new Error("gortex mcp is not running");
    this.child.stdin?.write(JSON.stringify(obj) + "\n");
  }

  // A single shared respawn: concurrent callers of request() against a
  // dead child all await the same spawn+initialize, so a burst of tool
  // calls can never fork multiple children.
  private respawn(): Promise<void> {
    if (!this.respawnPromise) {
      this.respawnPromise = (async () => {
        this.spawnChild();
        await this.initialize();
      })().finally(() => {
        this.respawnPromise = null;
      });
    }
    return this.respawnPromise;
  }

  async request(method: string, params: unknown, timeoutMs: number = RPC_TIMEOUT_MS): Promise<unknown> {
    if (this.exited) await this.respawn();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const entry: PendingRequest = { resolve, reject };
      if (Number.isFinite(timeoutMs)) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      this.pending.set(id, entry);
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        this.pending.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private notify(method: string, params: unknown): void {
    try {
      this.send({ jsonrpc: "2.0", method, params });
    } catch {
      // notifications are best-effort.
    }
  }

  private async initialize(): Promise<void> {
    const result = (await this.request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { experimental: { "gortex/wire": WIRE_FORMATS } },
        clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
      },
      INIT_TIMEOUT_MS,
    )) as { protocolVersion?: unknown; serverInfo?: { version?: unknown } } | null;
    const version = result?.serverInfo?.version;
    this.serverVersion = typeof version === "string" ? version : "";
    this.negotiatedProtocol =
      typeof result?.protocolVersion === "string" ? result.protocolVersion : "";
    this.notify("notifications/initialized", {});
  }

  // start spawns the child and runs the MCP handshake, retrying once
  // after a 1s backoff, since the daemon may still be warming up right
  // after ensureDaemon() kicked it off.
  async start(): Promise<void> {
    this.spawnChild();
    try {
      await this.initialize();
    } catch {
      await new Promise((r) => setTimeout(r, 1_000));
      if (this.exited) this.spawnChild();
      await this.initialize();
    }
  }

  async listTools(): Promise<ToolDescriptor[]> {
    const res = (await this.request("tools/list", {})) as { tools?: unknown };
    return Array.isArray(res?.tools) ? (res.tools as ToolDescriptor[]) : [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.request("tools/call", { name, arguments: args ?? {} }, CALL_TIMEOUT_MS);
  }

  stop(): void {
    const child = this.child;
    this.markExited(new Error("gortex mcp bridge stopped"));
    try {
      child?.kill();
    } catch {
      // already gone
    }
  }
}

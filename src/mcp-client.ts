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

/**
 * The variables `gortex mcp` needs on top of `env` to serve `toolsPreset`, the
 * spec resolveConfig validated (it already folds in the user's GORTEX_TOOLS).
 * Both are always set, so an inherited value resolveConfig rejected never
 * reaches the child; empty leaves the daemon's default surface.
 */
export function presetEnv(
  toolsPreset: string,
  env: Record<string, string | undefined>,
): Record<string, string> {
  if (toolsPreset === "") return { GORTEX_TOOLS: "", GORTEX_TOOLS_MODE: "" };
  // Never let a preset hide-block tools promoted later by tools_search.
  return { GORTEX_TOOLS: toolsPreset, GORTEX_TOOLS_MODE: env.GORTEX_TOOLS_MODE?.trim() || "defer" };
}

export interface MCPStdioClientOptions {
  bin: string;
  toolsPreset: string;
  /** The session's directory, which `gortex mcp` scopes the graph to. Default: the process cwd. */
  cwd?: string;
  deps: ProcessDeps;
  env?: Record<string, string | undefined>;
  callTimeoutMs?: number;
  maxFrameBytes?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/** A JSON-RPC error reply, with the server's code and data kept for the model. */
export class JsonRpcError extends Error {
  readonly code: number | undefined;
  readonly data: unknown;

  constructor(error: { code?: unknown; message?: unknown; data?: unknown }) {
    const code = typeof error.code === "number" ? error.code : undefined;
    let message = typeof error.message === "string" && error.message ? error.message : "JSON-RPC error";
    if (code !== undefined) message += ` (${code})`;
    if (error.data !== undefined) {
      message += `: ${typeof error.data === "string" ? error.data : JSON.stringify(error.data)}`;
    }
    super(message);
    this.name = "JsonRpcError";
    this.code = code;
    this.data = error.data;
  }
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
      windowsHide: true,
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
  // Raw bytes of the frame still being read. Frames are cut at the 0x0A byte
  // and decoded whole, so a character split across chunks survives.
  private chunks: Buffer[] = [];
  private bufferedBytes = 0;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private exited = true;
  private respawnPromise: Promise<void> | null = null;

  private readonly bin: string;
  private readonly toolsPreset: string;
  private readonly cwd: string | undefined;
  private readonly deps: ProcessDeps;
  private readonly env: Record<string, string | undefined>;
  private readonly callTimeoutMs: number;
  private readonly maxFrameBytes: number;

  // Fired on notifications/tools/list_changed (server-side promotion).
  onToolsListChanged: (() => void) | null = null;

  // Read off the handshake reply. Empty when the daemon withheld the field,
  // which reads as "unknown" everywhere and never as a mismatch.
  serverVersion = "";
  negotiatedProtocol = "";

  constructor(options: MCPStdioClientOptions) {
    this.bin = options.bin;
    this.toolsPreset = options.toolsPreset;
    this.cwd = options.cwd;
    this.deps = options.deps;
    this.env = options.env ?? process.env;
    this.callTimeoutMs = options.callTimeoutMs ?? CALL_TIMEOUT_MS;
    this.maxFrameBytes = options.maxFrameBytes ?? MAX_BUFFER_BYTES;
  }

  private childEnv(): Record<string, string | undefined> {
    return { ...this.env, ...presetEnv(this.toolsPreset, this.env) };
  }

  private spawnChild(): void {
    const child = this.deps.spawn(this.bin, ["mcp"], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.cwd,
      env: this.childEnv(),
      windowsHide: true,
    });
    this.child = child;
    this.chunks = [];
    this.bufferedBytes = 0;
    this.exited = false;
    child.stdout?.on("data", (chunk: unknown) => this.onData(chunk as Buffer));
    // Consume stderr so the child never blocks on a full pipe; routing it
    // to the terminal would corrupt Pi's TUI.
    child.stderr?.on("data", () => {});
    child.stdin?.on("error", () => {}); // EPIPE race: child may exit before stdin.write() finishes
    child.on("error", () => this.markExited(new Error("gortex mcp spawn failed")));
    child.on("exit", () => this.markExited(new Error("gortex mcp exited")));
    // The child and its pipes must never keep the event loop alive.
    child.unref?.();
    child.stdin?.unref?.();
    child.stdout?.unref?.();
    child.stderr?.unref?.();
  }

  private markExited(err: Error): void {
    if (this.exited && this.pending.size === 0) return;
    this.exited = true;
    this.child = null;
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) p.reject(err);
  }

  private onData(chunk: Buffer): void {
    let start = 0;
    let nl: number;
    while ((nl = chunk.indexOf(0x0a, start)) >= 0) {
      if (this.bufferedBytes + nl - start > this.maxFrameBytes) return this.overflow();
      const tail = chunk.subarray(start, nl);
      const frame = this.chunks.length > 0 ? Buffer.concat([...this.chunks, tail]) : tail;
      this.chunks = [];
      this.bufferedBytes = 0;
      start = nl + 1;
      this.onFrame(frame.toString("utf8").trim());
    }
    if (start >= chunk.length) return;
    this.chunks.push(start === 0 ? chunk : chunk.subarray(start));
    this.bufferedBytes += chunk.length - start;
    if (this.bufferedBytes > this.maxFrameBytes) this.overflow();
  }

  // One frame past the cap is fatal for this child (no way to resync
  // mid-frame): pending requests reject, the next call respawns a fresh child.
  private overflow(): void {
    this.chunks = [];
    this.bufferedBytes = 0;
    const child = this.child;
    this.markExited(new Error(`gortex mcp frame exceeded ${this.maxFrameBytes} bytes`));
    try {
      child?.kill();
    } catch {
      // already gone
    }
  }

  private onFrame(line: string): void {
    if (!line) return;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // non-JSON noise, ignore
    }
    if (msg && typeof msg === "object") this.dispatch(msg as Record<string, unknown>);
  }

  private dispatch(frame: Record<string, unknown>): void {
    const { id, method } = frame;
    if (typeof method === "string") {
      if (typeof id === "number" || typeof id === "string") this.answerServerRequest(id, method);
      else if (method === "notifications/tools/list_changed") {
        try {
          this.onToolsListChanged?.();
        } catch {
          // best effort; never break the read loop.
        }
      }
      return;
    }
    const error = frame.error as Record<string, unknown> | undefined;
    if (id === null && error) {
      // The server could not tell which request this answers, so none of
      // them will get a reply.
      const pending = [...this.pending.values()];
      this.pending.clear();
      for (const p of pending) p.reject(new JsonRpcError(error));
      return;
    }
    if (typeof id !== "number") return;
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (error) p.reject(new JsonRpcError(error));
    else p.resolve(frame.result);
  }

  private answerServerRequest(id: number | string, method: string): void {
    const reply =
      method === "ping"
        ? { jsonrpc: "2.0", id, result: {} }
        : { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
    try {
      this.send(reply);
    } catch {
      // the child is gone; nothing is waiting on the answer.
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

  /**
   * Sends one request. On abort or timeout the call is dropped and the server
   * is sent notifications/cancelled, so a late reply is ignored.
   */
  async request(
    method: string,
    params: unknown,
    timeoutMs: number = RPC_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const aborted = () => new Error(`${method} aborted`);
    if (signal?.aborted) throw aborted();
    if (this.exited) await this.respawn();
    if (signal?.aborted) throw aborted();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const onAbort = () => abandon(aborted());
      const settled = () => {
        if (entry.timer) clearTimeout(entry.timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const entry: PendingRequest = {
        resolve: (value) => {
          settled();
          resolve(value);
        },
        reject: (err) => {
          settled();
          reject(err);
        },
      };
      const abandon = (err: Error) => {
        if (this.pending.get(id) !== entry) return;
        this.pending.delete(id);
        entry.reject(err);
        // The MCP spec forbids cancelling initialize.
        if (method !== "initialize") this.notify("notifications/cancelled", { requestId: id, reason: err.message });
      };
      if (Number.isFinite(timeoutMs)) {
        entry.timer = setTimeout(() => abandon(new Error(`${method} timed out after ${timeoutMs}ms`)), timeoutMs);
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, entry);
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        this.pending.delete(id);
        entry.reject(err instanceof Error ? err : new Error(String(err)));
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

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return this.request("tools/call", { name, arguments: args ?? {} }, this.callTimeoutMs, signal);
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

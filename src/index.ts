// The extension factory: the readiness barrier and the Pi lifecycle wiring for
// both channels, graph tools over the MCP bridge and read discipline over the
// hook bridge. See docs/architecture.md for the design.

import type {
  ContextEvent,
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

import { resolveConfig } from "./config.ts";
import type { GortexConfig } from "./config.ts";
import { callHook, normalizeToolCall } from "./hook.ts";
import {
  MCPStdioClient,
  MIN_GORTEX_VERSION,
  PROTOCOL_VERSION,
  ensureDaemon,
  isBelowVersion,
} from "./mcp-client.ts";
import {
  NATIVE_READY_WAIT_MS,
  bareToolName,
  binaryResolves,
  daemonVersionFromBriefing,
  isNativeGortexTool,
  mcpConnectorLoaded,
  registerNativeServer,
  unregisterNativeServer,
  supportsNativeMcp,
  waitForNativeTools,
} from "./native.ts";
import { nodeProcessDeps } from "./runtime.ts";
import type { ProcessDeps } from "./runtime.ts";
import {
  clearSyncTimer,
  registerGortexTools,
  scheduleSyncTools,
} from "./tools.ts";
import {
  getBridgeError,
  getClient,
  getVersionWarning,
  gortexToolNames,
  setBridgeError,
  setClient,
  setVersionWarning,
} from "./state.ts";

export type { GortexConfig, SidecarConfig } from "./config.ts";

/**
 * How long before_agent_start waits for session_start to finish. Pi arms the
 * editor's submit handler before session_start runs, at startup and across
 * /reload and /new, so a fast prompt can reach the agent loop while
 * registration is still pending. Capped so a wedged daemon costs the first turn
 * seconds; start() alone can take ~2 min.
 */
export const READY_WAIT_MS = 15_000;

/**
 * Compares the daemon against what this extension is built for and, on a skew,
 * tells both audiences: the user through Pi's warning channel (which never
 * enters model context), the model through the orientation, so it knows a tool
 * may misbehave. Advisory only: the session keeps every tool it registered,
 * matching the fail-open posture in docs/architecture.md.
 */
function reportVersionSkew(
  ctx: ExtensionContext | undefined,
  serverVersion: string,
  negotiatedProtocol: string,
): void {
  const stale = serverVersion !== "" && isBelowVersion(serverVersion, MIN_GORTEX_VERSION);
  const protocolSkew = negotiatedProtocol !== "" && negotiatedProtocol !== PROTOCOL_VERSION;
  if (!stale && !protocolSkew) return;

  const installed = serverVersion === "" ? "an unreported version" : `gortex ${serverVersion}`;
  const user = stale
    ? `${installed} is older than ${MIN_GORTEX_VERSION}, which this extension needs. ` +
      `Graph tools and read discipline may be missing or wrong. Run \`gortex upgrade\`.`
    : `${installed} answered the handshake with MCP protocol ${negotiatedProtocol}, ` +
      `not the ${PROTOCOL_VERSION} this extension speaks. Tool calls may fail. ` +
      `Run \`gortex upgrade\`.`;

  setVersionWarning(
    stale
      ? `[Gortex] the daemon is ${installed}, older than the ${MIN_GORTEX_VERSION} this ` +
        `extension targets. A graph tool may be missing or behave unexpectedly. If one ` +
        `does, tell the user to run \`gortex upgrade\`.`
      : `[Gortex] the daemon negotiated MCP protocol ${negotiatedProtocol} instead of ` +
        `${PROTOCOL_VERSION}. A graph tool call may fail. If one does, tell the user to ` +
        `run \`gortex upgrade\`.`,
  );

  notifyUser(ctx, user);
}

/**
 * A warning for the user only. A Pi build without a UI (print/JSON mode) or
 * without notify must not take the session down over an advisory message.
 */
function notifyUser(ctx: ExtensionContext | undefined, message: string): void {
  try {
    if (ctx?.hasUI) ctx.ui.notify(message, "warning");
  } catch {
    // advisory only
  }
}

/** Test seams. Pi itself calls the factory with the `pi` object alone. */
export interface GortexExtensionOptions {
  /** Pre-resolved configuration; resolveConfig() runs when this is absent. */
  config?: GortexConfig;
  /** Process seam for spawn/execFileSync. */
  deps?: ProcessDeps;
  /** Readiness cap override. */
  readyWaitMs?: number;
  /** Override for the wait on Pi's built-in MCP connecting the gortex server. */
  nativeReadyWaitMs?: number;
}

export default function gortexExtension(pi: ExtensionAPI, options: GortexExtensionOptions = {}): void {
  const config = options.config ?? resolveConfig();
  // Pi 0.85's ExtensionAPI declares no `cwd`, so the hook envelope reads it
  // defensively and falls back to the process cwd. A Pi version that grows the
  // field is picked up when it exists.
  const piCwd = (): string => (pi as { cwd?: string })?.cwd ?? process.cwd();
  const deps = options.deps ?? nodeProcessDeps;
  const readyWaitMs = options.readyWaitMs ?? READY_WAIT_MS;
  const nativeReadyWaitMs = options.nativeReadyWaitMs ?? NATIVE_READY_WAIT_MS;

  // On a Pi with built-in MCP, Pi owns the tool channel: it spawns `gortex mcp`
  // (which starts the daemon itself), registers the tools and renders them.
  // A binary that does not resolve, or a registration Pi refuses, falls back to
  // the extension's own client, which reports its failure to the model.
  let nativeRefusal = "";
  let native = ((): boolean => {
    if (!config.nativeMcp || !supportsNativeMcp(pi) || !binaryResolves(config.bin)) return false;
    nativeRefusal = registerNativeServer(pi, config);
    return nativeRefusal === "";
  })();

  // Latched for the whole session once the first turn has run the
  // session_start hook, whether or not it produced anything to inject.
  let startupHookRan = false;
  // Orientation awaiting injection into the next LLM call, computed once per
  // session. The `context` hook appends it as a tail user message, because a
  // systemPrompt change sits at messages[0] and invalidates prefix caching.
  let pendingOrientation = "";

  // Settles when the current session_start handler is done: bridge up and
  // tools registered, or the handshake failed. Never rejects.
  //
  // Armed at factory time, because every session builds a fresh instance before
  // its session_start fires, so an instance can be asked for a turn before its
  // own handler has run. Every path that constructs an instance goes on to emit
  // session_start, so the wait ends.
  let sessionReady!: Promise<void>;
  let settleSessionReady: () => void = () => {};
  let sessionReadyPending = false;

  function armSessionReady(): void {
    if (sessionReadyPending) return; // keep the promise parked waiters hold
    sessionReadyPending = true;
    sessionReady = new Promise<void>((resolve) => {
      settleSessionReady = () => {
        sessionReadyPending = false;
        resolve();
      };
    });
  }
  armSessionReady();

  // Resolves true when session_start finished, false when the cap expired
  // first. The caller has to tell those apart, since a cap expiry leaves
  // bridgeError empty.
  function waitForSession(ms: number): Promise<boolean> {
    const ready = sessionReady;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ok);
      };
      const timer = setTimeout(() => done(false), ms);
      (timer as { unref?: () => void })?.unref?.();
      ready.then(() => done(true), () => done(true));
    });
  }

  // Pi resets the session's tool registry on every session_start, so
  // (re)register here. Clear the name guard first, since it persists across
  // sessions and would otherwise suppress re-registration. The previous
  // session's bridge child (if any) is stopped before a fresh handshake.
  pi.on("session_start", async (_event, ctx) => {
    startupHookRan = false;
    pendingOrientation = "";
    setBridgeError("");
    setVersionWarning("");
    armSessionReady(); // no-op when a turn is already parked on this session
    const settle = settleSessionReady; // this invocation's resolver
    try {
      await startSession(ctx);
    } finally {
      settle();
    }
  });

  // Stops the live bridge, if any, and clears the slot. Shared by
  // session_start and session_shutdown so both paths stay in sync.
  function stopBridge(): void {
    clearSyncTimer();
    const previous = getClient();
    if (previous) {
      previous.stop();
      setClient(null);
    }
  }

  // startSession holds the body of session_start so the readiness promise
  // above settles on every exit path, early returns included.
  async function startSession(ctx?: ExtensionContext): Promise<void> {
    if (native && !mcpConnectorLoaded(pi)) {
      unregisterNativeServer(pi);
      native = false;
    }
    if (native) return;
    if (nativeRefusal) notifyUser(ctx, `Pi refused the gortex MCP server (${nativeRefusal}), so the extension runs its own client.`);
    ensureDaemon(config.bin, deps);
    gortexToolNames.clear();
    stopBridge();
    const c = new MCPStdioClient({ bin: config.bin, toolsPreset: config.toolsPreset, deps });
    // Claim the slot before the first await: an overlapping
    // session_start (rapid /new or /reload) then sees and stops THIS
    // bridge instead of leaking its child mid-handshake.
    setClient(c);
    try {
      await c.start();
      if (getClient() !== c) return; // superseded while handshaking
      reportVersionSkew(ctx, c.serverVersion, c.negotiatedProtocol);
      c.onToolsListChanged = () => {
        scheduleSyncTools(pi);
      };
      await registerGortexTools(pi);
    } catch (err) {
      // daemon unreachable / binary missing / handshake or tools/list
      // failure: no graph tools this session; /reload (or the next
      // session_start) retries.
      c.stop();
      if (getClient() === c) {
        setClient(null);
        setBridgeError(err instanceof Error ? err.message : String(err));
      }
    }
  }

  // Fires before the agent loop's first LLM call. It can't mutate messages
  // itself, so it just parks the orientation for the `context` hook.
  pi.on("before_agent_start", async (_event, ctx) => {
    if (startupHookRan) return;
    startupHookRan = true; // before the first await, so a second turn can't race in
    // Pi awaits each listener, so this holds the turn until the tools are
    // registered and bridgeError reflects the handshake (or the cap expires).
    // session_start settles `native` first: it falls back when nothing connects MCP.
    const sessionDone = await waitForSession(readyWaitMs);
    const ready = native ? await waitForNativeTools(pi, nativeReadyWaitMs) : sessionDone;
    const decision = callHook(config.hookArgv, deps, {
      event: "session_start",
      cwd: ctx?.cwd ?? piCwd(),
    });
    // Pi's MCP keeps the handshake to itself, so the version comes from the briefing.
    if (native && decision.orientation) {
      reportVersionSkew(ctx, daemonVersionFromBriefing(decision.orientation), "");
    }
    const parts: string[] = [];
    const bridgeError = getBridgeError();
    if (bridgeError) {
      parts.push(
        `[Gortex] graph tools are unavailable this session (${bridgeError}). ` +
        `Tell the user to run /reload to retry the connection.`,
      );
      setBridgeError("");
    } else if (!ready) {
      // Cap expired mid-handshake: bridgeError is still empty, and this is the
      // only turn that reports it: startupHookRan latches above, so a
      // handshake that fails after the cap never reaches the branch above.
      parts.push(
        `[Gortex] graph tools were still registering when this turn began, so a tool ` +
        `named below may not be callable yet. If one is missing, say so and tell the ` +
        `user to retry, or to run /reload if it stays missing. Don't fall back to ` +
        `native tools.`,
      );
    }
    const versionWarning = getVersionWarning();
    if (versionWarning) {
      parts.push(versionWarning);
      setVersionWarning("");
    }
    if (decision.orientation) parts.push(decision.orientation);
    if (parts.length > 0) pendingOrientation = parts.join("\n\n");
    return;
  });

  // Fires before each LLM call with a mutable message array. Appends the
  // parked orientation once, clearing it only after the push lands so the
  // orientation survives a context shape this hook can't append to.
  // Pi exports ContextEvent but not its result type, so it is spelled out here.
  pi.on("context", (event: ContextEvent): { messages?: ContextEvent["messages"] } | void => {
    if (!pendingOrientation) return;
    try {
      const messages = (event as { messages?: unknown })?.messages;
      if (Array.isArray(messages)) {
        // Pi's AgentMessage also carries a `timestamp`; only the two fields
        // Pi reads for a tail user turn are pushed.
        messages.push({ role: "user", content: pendingOrientation } as ContextEvent["messages"][number]);
        pendingOrientation = "";
        return { messages: messages as ContextEvent["messages"] };
      }
    } catch {
      // best effort; never break context assembly.
    }
    return;
  });

  // Never let the bridge child outlive the session.
  pi.on("session_shutdown", async () => {
    stopBridge();
  });

  if (!config.enforce) return;

  // Enforcement: every non-Gortex tool call is checked against the Go hook.
  pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | void> => {
    const piName: string = (event as { toolName?: string })?.toolName ?? "";
    const piInput: Record<string, unknown> = (event?.input as Record<string, unknown>) ?? {};
    const isGortexTool = native ? isNativeGortexTool(piName) : gortexToolNames.has(piName);

    // A graph tool keeps its own name: Gortex's `read` is no Pi `read`.
    const norm = isGortexTool
      ? { tool_name: bareToolName(piName), tool_input: piInput }
      : normalizeToolCall(piName, piInput);
    const decision = callHook(config.hookArgv, deps, {
      event: "tool_call",
      tool_name: norm.tool_name,
      tool_input: norm.tool_input,
      cwd: ctx?.cwd ?? piCwd(),
      session_id: (ctx as { sessionManager?: { sessionId?: string } })?.sessionManager?.sessionId ?? "",
      is_gortex_tool: isGortexTool,
    });

    if (decision.block) {
      return { block: true, reason: decision.reason ?? "[Gortex] blocked: prefer graph tools." };
    }
    if (decision.additional_context) {
      // Soft guidance: surface it without blocking the call.
      try {
        pi.sendMessage(
          { customType: "gortex", content: decision.additional_context, display: true },
          { deliverAs: "steer" },
        );
      } catch {
        // sendMessage shape can vary across Pi versions; never fatal.
      }
    }
    return;
  });
}

// The extension factory: the readiness barrier and the Pi lifecycle wiring for
// both channels, graph tools through Pi's built-in MCP and read discipline over
// the hook bridge. See docs/architecture.md for the design.

import type {
  AgentBeforeSettleEventResult,
  BeforeAgentStartEventResult,
  BoundaryContextPreview,
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

import { resolveConfig } from "./config.ts";
import type { GortexConfig, ResolveConfigOptions } from "./config.ts";
import { watchEdits } from "./diff.ts";
import { STOP_HOOK_TIMEOUT_MS, callHook, normalizeToolCall } from "./hook.ts";
import {
  MIN_GORTEX_VERSION,
  TOOLS_READY_WAIT_MS,
  bareToolName,
  binaryResolves,
  daemonVersionFromBriefing,
  isBelowVersion,
  gortexToolsReady,
  isGortexTool,
  mcpConnectorLoaded,
  registerServer,
  supportsMcp,
  waitForGortexTools,
} from "./mcp.ts";
import { contentText, gortexRenderers, renderPostTask, sanitize } from "./render.ts";
import { nodeProcessDeps } from "./runtime.ts";
import type { ProcessDeps } from "./runtime.ts";

export type { GortexConfig, SidecarConfig } from "./config.ts";

/**
 * How long before_agent_start waits for session_start to run. Pi arms the
 * editor's submit handler before session_start runs, at startup and across
 * /reload and /new, so a fast prompt can reach the agent loop before the
 * server is registered. Capped so a session_start that never comes costs the
 * first turn seconds, not the session.
 */
const READY_WAIT_MS = 15_000;

/**
 * Compares the daemon against what this extension is built for and, on a skew,
 * tells both audiences: the user through Pi's warning channel (which never
 * enters model context), the model through the returned line, so it knows a
 * tool may misbehave. Advisory only, matching the fail-open posture in
 * docs/architecture.md. Returns "" when there is no skew.
 */
function reportVersionSkew(ctx: ExtensionContext | undefined, serverVersion: string): string {
  if (serverVersion === "" || !isBelowVersion(serverVersion, MIN_GORTEX_VERSION)) return "";
  notifyUser(
    ctx,
    `gortex ${serverVersion} is older than ${MIN_GORTEX_VERSION}, which this extension needs. ` +
      `Graph tools and read discipline may be missing or wrong. Run \`gortex upgrade\`.`,
  );
  return (
    `[Gortex] the daemon is gortex ${serverVersion}, older than the ${MIN_GORTEX_VERSION} this ` +
    `extension targets. A graph tool may be missing or behave unexpectedly. If one ` +
    `does, tell the user to run \`gortex upgrade\`.`
  );
}

const UNAVAILABLE = "[Gortex] graph tools are unavailable this session";

const NO_MCP_API =
  `${UNAVAILABLE}: this Pi has no built-in MCP, which the extension needs (Pi 1.0 or ` +
  `newer). Use Pi's own tools, and tell the user to upgrade Pi for graph tools.`;

const MCP_NOT_LOADED =
  `${UNAVAILABLE}: Pi's MCP support is not loaded (for example \`--no-mcp\`, or ` +
  `\`--no-extensions\` without \`-e builtin:mcp\`). Use Pi's own tools. If the user wants ` +
  `graph tools, tell them to start Pi with MCP enabled.`;

const binaryMissing = (bin: string): string =>
  `${UNAVAILABLE}: the gortex binary (\`${bin}\`) was not found. Use Pi's own tools, and ` +
  `tell the user to install Gortex or set GORTEX_BIN, then run /reload.`;

const refused = (reason: string): string =>
  `${UNAVAILABLE}: Pi refused the gortex MCP server (${reason}). Use Pi's own tools, and ` +
  `tell the user why and to run /reload once it is fixed.`;

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

/** Marks the messages this extension stores in the session. */
const GORTEX_MESSAGE_TYPE = "gortex";

interface GortexMessageDetails {
  /** Whether the content includes the session briefing, not only warnings. */
  briefing: boolean;
}

/** Kept out of the transcript; Pi still sends it to the model. */
function gortexMessage(content: string, briefing: boolean): BeforeAgentStartEventResult {
  const details: GortexMessageDetails = { briefing };
  return { message: { customType: GORTEX_MESSAGE_TYPE, content, display: false, details } };
}

/**
 * Whether a briefing already sits in what the model sees: after a resume or
 * /reload, or when compaction kept it. Answers false when Pi can't tell.
 */
function briefingInContext(ctx: ExtensionContext | undefined): boolean {
  try {
    return (ctx?.sessionManager.buildContextEntries() ?? []).some(
      (entry) =>
        entry.type === "custom_message" &&
        entry.customType === GORTEX_MESSAGE_TYPE &&
        (entry.details as GortexMessageDetails | undefined)?.briefing === true,
    );
  } catch {
    return false;
  }
}

/** Marks the post-task diagnostics, which the user sees too. */
const POST_TASK_MESSAGE_TYPE = "gortex-post-task";

const sessionIdOf = (ctx: ExtensionContext | undefined): string => ctx?.sessionManager?.getSessionId?.() ?? "";

/** The text of the last assistant message, which Gortex checks for unbacked claims. */
function lastAssistantText(messages: BoundaryContextPreview["contextMessages"]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === "assistant") return contentText(message.content);
  }
  return "";
}

/** Test seams. Pi itself calls the factory with the `pi` object alone. */
export interface GortexExtensionOptions {
  /** Fixed configuration; resolveConfig() runs per session when this is absent. */
  config?: GortexConfig;
  /** resolveConfig() seams; `cwd` stands in for the process cwd until a session supplies one. */
  resolve?: ResolveConfigOptions;
  /** Process seam for the hook. */
  deps?: ProcessDeps;
  /** Readiness cap override. */
  readyWaitMs?: number;
  /** Override for the wait on Pi's built-in MCP connecting the gortex server. */
  toolsReadyWaitMs?: number;
}

export default function gortexExtension(pi: ExtensionAPI, options: GortexExtensionOptions = {}): void {
  // Resolved again on every session_start from ctx.cwd, the directory the
  // session runs in. The factory has no session, so this first resolution only
  // serves a turn that outruns session_start.
  const configFor = (cwd?: string): GortexConfig =>
    options.config ?? resolveConfig({ ...options.resolve, cwd: cwd ?? options.resolve?.cwd });
  let config = configFor();
  const deps = options.deps ?? nodeProcessDeps;
  const readyWaitMs = options.readyWaitMs ?? READY_WAIT_MS;
  const toolsReadyWaitMs = options.toolsReadyWaitMs ?? TOOLS_READY_WAIT_MS;

  // Pi owns the tool channel: it spawns `gortex mcp` (which starts the daemon
  // itself), registers the tools and renders them. Registered on session_start,
  // once the session's config is known: Pi reads a registration made before its
  // own session_start handler, and connects one made after it. Every session,
  // reload included, builds a fresh instance, so this runs once per instance.
  //
  // Whether gortex tools may still appear: the server is registered, or Pi
  // refused it because another source already supplies one.
  let toolsExpected = false;
  // Why Pi refused the registration, reported only if no tools appear.
  let refusal = "";
  // Why this session cannot have graph tools, told to the model on the first turn.
  let unavailable = "";
  // Set once the first turn has waited for the tools.
  let toolsSettled = false;

  // Latched for the whole session once the first turn has run the
  // session_start hook, whether or not it produced anything to inject.
  let startupHookRan = false;
  // This session's briefing, kept so a compaction that summarises it away can
  // send it again on the next turn.
  let briefing = "";
  let briefingCompacted = false;
  // Gortex's symbol hints for the prompt about to run, requested on `input`,
  // where the text is still the line the user typed.
  let pendingHints: Promise<string> | undefined;
  // Set while the run that is ending was the continuation the diagnostics asked for.
  let postTaskContinued = false;

  // Settles once session_start has run on this instance. Armed at factory
  // time, because every session builds a fresh instance before its
  // session_start fires, so an instance can be asked for a turn before its own
  // handler has run. Every path that constructs an instance goes on to emit
  // session_start, so the wait ends.
  let markStarted!: () => void;
  const sessionStarted = new Promise<void>((resolve) => {
    markStarted = resolve;
  });

  // Resolves true once session_start has run, false when the cap expired first.
  function waitForSession(ms: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      (timer as { unref?: () => void })?.unref?.();
      void sessionStarted.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  pi.on("session_start", (_event, ctx) => {
    try {
      startSession(ctx);
    } finally {
      markStarted();
    }
  });

  // Synchronous, so session_start has no suspension point another session
  // could overlap.
  function startSession(ctx?: ExtensionContext): void {
    config = configFor(ctx?.cwd);
    if (!supportsMcp(pi)) {
      unavailable = NO_MCP_API;
      return;
    }
    // Checked before registering, so Pi never reports a server nothing connects.
    if (!mcpConnectorLoaded(pi)) {
      unavailable = MCP_NOT_LOADED;
      return;
    }
    if (!binaryResolves(config.bin)) {
      unavailable = binaryMissing(config.bin);
      return;
    }
    refusal = registerServer(pi, config);
    toolsExpected = true;
  }

  pi.on("session_compact", () => {
    briefingCompacted = true;
  });

  // Fires before the agent loop's first LLM call. The returned message is
  // stored in the session after the prompt, so every later LLM call carries it
  // and the system prompt, which prefix caching keys on, stays untouched.
  pi.on("before_agent_start", async (_event, ctx): Promise<BeforeAgentStartEventResult | void> => {
    postTaskContinued = false;
    const requested = pendingHints;
    pendingHints = undefined;
    if (startupHookRan) {
      const parts: string[] = [];
      let briefed = false;
      if (briefingCompacted) {
        briefingCompacted = false;
        briefed = briefing !== "" && !briefingInContext(ctx);
        if (briefed) parts.push(briefing);
      }
      const hints = await promptHints(requested);
      if (hints) parts.push(hints);
      if (parts.length === 0) return;
      return gortexMessage(parts.join("\n\n"), briefed);
    }
    startupHookRan = true; // before the first await, so a second turn can't race in
    // Pi awaits each listener, so this holds the turn until session_start has
    // run and Pi has registered the gortex tools (or a cap expires).
    const started = await waitForSession(readyWaitMs);
    const ready = started && toolsExpected ? await waitForGortexTools(pi, toolsReadyWaitMs) : started;
    toolsSettled = true;
    const decision = await callHook(config.hookArgv, deps, {
      event: "session_start",
      cwd: ctx?.cwd ?? process.cwd(),
    });
    const parts: string[] = [];
    if (unavailable) {
      // Another source of a `gortex` server, such as Pi's mcp.json, may still
      // supply the tools.
      if (!gortexToolsReady(pi)) parts.push(unavailable);
    } else if (refusal && !ready) {
      parts.push(refused(refusal));
      notifyUser(ctx, `Pi refused the gortex MCP server (${refusal}); graph tools are unavailable this session.`);
    } else if (!ready) {
      // The only turn that reports it: startupHookRan latches above.
      parts.push(
        `[Gortex] graph tools were still registering when this turn began, so a tool ` +
        `named below may not be callable yet. If one is missing, say so and tell the ` +
        `user to retry, or to run /reload if it stays missing. Don't fall back to ` +
        `Pi's own tools.`,
      );
    }
    // Pi's MCP keeps the handshake to itself, so the version comes from the briefing.
    if (decision.orientation) {
      const versionWarning = reportVersionSkew(ctx, daemonVersionFromBriefing(decision.orientation));
      if (versionWarning) parts.push(versionWarning);
    }
    let briefed = false;
    if (decision.orientation) {
      briefing = decision.orientation;
      // A resumed or reloaded session already holds it.
      briefed = !briefingInContext(ctx);
      if (briefed) parts.push(decision.orientation);
    }
    const hints = await promptHints(requested);
    if (hints) parts.push(hints);
    if (parts.length === 0) return;
    return gortexMessage(parts.join("\n\n"), briefed);
  });

  // Steering and follow-up messages typed mid-run never reach
  // before_agent_start, so they get no hints. The hook skips slash commands,
  // which is why the text goes out before skill expansion.
  pi.on("input", (event, ctx) => {
    if (event.streamingBehavior) return;
    pendingHints = (async () => {
      await waitForSession(readyWaitMs);
      if (!graphToolsPossible()) return "";
      const decision = await callHook(config.hookArgv, deps, {
        event: "prompt",
        prompt: event.text,
        cwd: ctx?.cwd ?? process.cwd(),
        session_id: sessionIdOf(ctx),
      });
      return decision.additional_context ?? "";
    })();
  });

  // Hints point at graph tools, so they are dropped when the session has none.
  async function promptHints(requested: Promise<string> | undefined): Promise<string> {
    const hints = requested ? await requested : "";
    return hints && graphToolsPossible() ? hints : "";
  }

  // Soft guidance waits for its own call's result, so the model reads the two
  // together. A nested call's result goes to the script that made it, so its
  // guidance waits for the top-level call's.
  const guidance = new Map<string, string>();
  // The top-level call each nested call in flight runs under.
  const roots = new Map<string, string>();

  // Every tool call goes to the Go hook, which records the files it writes for
  // the post-task diagnostics and, when enforcing, checks it.
  const forwardToolCall = (event: ToolCallEvent, ctx: ExtensionContext, recordOnly: boolean) => {
    const piName: string = (event as { toolName?: string })?.toolName ?? "";
    const piInput: Record<string, unknown> = (event?.input as Record<string, unknown>) ?? {};
    const gortexCall = isGortexTool(piName);

    // A graph tool keeps its own name: Gortex's `read` is no Pi `read`.
    const norm = gortexCall
      ? { tool_name: bareToolName(piName), tool_input: piInput }
      : normalizeToolCall(piName, piInput);
    return callHook(config.hookArgv, deps, {
      event: "tool_call",
      tool_name: norm.tool_name,
      tool_input: norm.tool_input,
      cwd: ctx?.cwd ?? process.cwd(),
      session_id: sessionIdOf(ctx),
      is_gortex_tool: gortexCall,
      ...(recordOnly ? { record_only: true } : {}),
    }, ctx?.signal);
  };

  // Records still in flight, which the post-task diagnostics wait for.
  const recording = new Set<Promise<unknown>>();
  const recordToolCall = (event: ToolCallEvent, ctx: ExtensionContext): void => {
    const record = forwardToolCall(event, ctx, true);
    recording.add(record);
    void record.finally(() => recording.delete(record));
  };

  const enforceReadDiscipline = async (event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | void> => {
    const decision = await forwardToolCall(event, ctx, false);

    if (decision.block) {
      return { block: true, reason: decision.reason ?? "[Gortex] blocked: prefer graph tools." };
    }
    let id = event.toolCallId;
    if (event.parentToolCallId) {
      id = roots.get(event.parentToolCallId) ?? event.parentToolCallId;
      roots.set(event.toolCallId, id);
    }
    if (decision.additional_context && id) {
      const parked = guidance.get(id);
      guidance.set(id, parked ? `${parked}\n\n${decision.additional_context}` : decision.additional_context);
    }
    return;
  };
  // Without graph tools, read discipline would block Pi's tools with nothing to
  // use instead. Until the first turn has waited for them, expected ones count.
  const graphToolsPossible = (): boolean =>
    gortexToolsReady(pi) || (!toolsSettled && toolsExpected);
  // Registered unconditionally, since a session's own sidecar can turn enforcement on.
  pi.on("tool_call", (event, ctx) => {
    if (!graphToolsPossible()) return;
    if (config.enforce) return enforceReadDiscipline(event, ctx);
    recordToolCall(event, ctx);
  });

  // Pi's last chance to continue before it settles: Gortex checks the work
  // this session did, and its findings go to the model for one more request.
  // An aborted or failed run never reaches here with "completed".
  pi.on("agent_before_settle", async (event, ctx): Promise<AgentBeforeSettleEventResult | void> => {
    const active = postTaskContinued;
    postTaskContinued = false;
    if (event.outcome !== "completed" || !graphToolsPossible()) return;
    await Promise.allSettled(recording);
    const decision = await callHook(config.hookArgv, deps, {
      event: "stop",
      cwd: ctx?.cwd ?? process.cwd(),
      session_id: sessionIdOf(ctx),
      last_assistant_message: lastAssistantText(event.context.contextMessages),
      stop_hook_active: active,
    }, ctx?.signal, STOP_HOOK_TIMEOUT_MS);
    // Pi has no loop guard of its own, so a continuation never asks for another.
    if (active) return;
    const content = sanitize((decision.block ? decision.reason : decision.additional_context) ?? "").trim();
    if (!content) return;
    postTaskContinued = true;
    return {
      entries: [
        ...event.entries,
        { type: "custom_message", customType: POST_TASK_MESSAGE_TYPE, content, display: true, details: { blocked: decision.block === true } },
      ],
      continue: true,
    };
  });

  pi.on("tool_result", (event) => {
    const text = guidance.get(event.toolCallId);
    if (text === undefined) return;
    guidance.delete(event.toolCallId);
    // Replacing the content drops structured content that is not returned with it.
    return { content: [...(event.content ?? []), { type: "text", text }], structuredContent: event.structuredContent };
  });
  // Pi emits this after tool_result, and also for a call that never produced one.
  pi.on("tool_execution_end", (event) => {
    guidance.delete(event.toolCallId);
    roots.delete(event.toolCallId);
  });

  // After enforcement, so a blocked call is never snapshotted.
  watchEdits(pi);
  // Pi < 1.0.1 has no tool renderers; the diffs are still stored.
  try {
    (pi as Partial<Pick<ExtensionAPI, "registerToolRenderer">>).registerToolRenderer?.(gortexRenderers);
  } catch {
    // drawing diffs is optional
  }
  try {
    pi.registerMessageRenderer(POST_TASK_MESSAGE_TYPE, renderPostTask);
  } catch {
    // Pi's default box draws it otherwise
  }
}

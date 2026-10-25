// Harness: the extension under Pi's own ExtensionRunner.
//
// Pi calls an extension factory with one argument, so the test seam rides a
// closure: DefaultResourceLoader takes `extensionFactories`, whose
// InlineExtension accepts `(pi) => gortexExtension(pi, options)`. That keeps
// the injected config and process double while Pi's real runner drives the
// lifecycle, so `emit()`'s sequential-await semantics, the tool registry and
// the event payload shapes are the oracle rather than a local imitation.
//
// Hermetic: a temp cwd and a temp agentDir (never getAgentDir(), which would
// load the developer's own ~/.pi extensions), and an in-memory session manager
// that writes nothing.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DefaultResourceLoader,
  ExtensionRunner,
  ModelRegistry,
  SessionManager,
  createEventBus,
  discoverAndLoadExtensions,
} from "@earendil-works/pi-coding-agent";
import type {
  Extension,
  ExtensionActions,
  ExtensionContextActions,
  ExtensionUIContext,
  ExtensionError,
  ExtensionRuntime,
  RegisteredMcpServer,
  SlashCommandInfo,
  ToolCallEventResult,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";

import type { GortexExtensionOptions } from "../../src/index.ts";
import type { Factory } from "./subject.ts";

// One root for every temp directory the suite makes, removed when the test
// process exits.
const ROOT = mkdtempSync(join(tmpdir(), `pi-gortex-test-${process.pid}-`));
process.on("exit", () => {
  rmSync(ROOT, { recursive: true, force: true });
});

let harnessCount = 0;

export interface ContextMessage {
  role: string;
  content: string;
}

export interface Notification {
  message: string;
  type: string | undefined;
}

export interface Harness {
  runner: ExtensionRunner;
  /** Messages the extension pushed through ExtensionActions.sendMessage. */
  sent: unknown[];
  /** Errors the runner swallowed out of a handler; real emit() never rejects. */
  errors: ExtensionError[];
  cwd: string;
  /** session_start, as Pi emits it, then Pi's check for servers nothing connects. */
  sessionStart(reason?: string): Promise<unknown>;
  /** session_shutdown, as Pi emits it before tearing the extension runtime down. */
  sessionShutdown(reason?: "quit" | "reload" | "new" | "resume" | "fork"): Promise<unknown>;
  /**
   * before_agent_start: the turn the readiness barrier holds. Stores the prompt
   * and any message the extension returns in the session, as Pi does.
   */
  turn(prompt?: string): Promise<unknown>;
  /** The messages the extension added since the previous call. */
  context(): Promise<ContextMessage[]>;
  /** The extension's messages among what the next LLM call would see. */
  modelContext(): ContextMessage[];
  /** session_compact after a compaction keeping the entries from `keepFrom` on (none by default). */
  compact(keepFrom?: string | null): Promise<unknown>;
  session: SessionManager;
  toolCall(toolName: string, input: Record<string, unknown>): Promise<ToolCallEventResult | undefined>;
  /** Aborts the signal handlers see on ctx.signal, as Esc does during a turn. */
  abort(): void;
  tools(): string[];
  /** The files Pi loaded this extension from. */
  extensionPaths(): string[];
  /** MCP servers the extension registered with pi.registerMcpServer(). */
  mcpServers(): RegisteredMcpServer[];
  /** Everything the extension pushed at the user through ctx.ui.notify. */
  notifications: Notification[];
}

// Only the members this extension touches are implemented; the rest stay
// unwired, which is what pi-mono's own runner tests do. Typing the partial
// keeps sendMessage checked against Pi's real SendMessageHandler.
function extensionActions(sent: unknown[], runner: () => ExtensionRunner): ExtensionActions {
  const partial: Partial<ExtensionActions> = {
    sendMessage: (message) => {
      sent.push(message);
    },
    getAllTools: () =>
      runner().getAllRegisteredTools().map((t) => ({ name: t.definition.name }) as ToolInfo),
    getCommands: () =>
      runner().getRegisteredCommands().map((c) => ({ name: c.invocationName }) as SlashCommandInfo),
    // The harness reads the registry live, so a tool registered mid-session needs no refresh.
    refreshTools: () => {},
  };
  return partial as ExtensionActions;
}

function extensionContextActions(signal: AbortSignal): ExtensionContextActions {
  const partial: Partial<ExtensionContextActions> = {
    isIdle: () => true,
    isProjectTrusted: () => true,
    getSignal: () => signal,
  };
  return partial as ExtensionContextActions;
}

/** A fresh, isolated {cwd, agentDir} pair under the suite's temp root. */
function tempDirs(): { cwd: string; agentDir: string } {
  const id = harnessCount++;
  const cwd = join(ROOT, `cwd-${id}`);
  const agentDir = join(ROOT, `agent-${id}`);
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  return { cwd, agentDir };
}

export interface HarnessLayout {
  /** A session to continue, the way /reload or a resume does. */
  session?: SessionManager;
  /** Run Pi from this directory under a git repo root, instead of from the root. */
  repoSubdir?: string;
}

export async function createHarness(
  factory: Factory,
  options: GortexExtensionOptions = {},
  { session, repoSubdir }: HarnessLayout = {},
): Promise<Harness> {
  const dirs = tempDirs();
  const { agentDir } = dirs;
  let cwd = dirs.cwd;
  if (repoSubdir) {
    mkdirSync(join(cwd, ".git"));
    cwd = join(cwd, repoSubdir);
    mkdirSync(cwd, { recursive: true });
  }
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    extensionFactories: [{ name: "gortex", factory: (pi) => factory(pi, options) }],
    // Everything the developer has installed stays out of this session.
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const { extensions, errors: loadErrors, runtime } = loader.getExtensions();
  if (loadErrors.length > 0) {
    throw new Error(`extension failed to load: ${JSON.stringify(loadErrors)}`);
  }

  return buildHarness(extensions, runtime, cwd, session);
}

/**
 * The same harness, loaded the way a user's Pi does it: through Pi's own
 * discovery, which reads package.json's `pi.extensions` manifest and loads the
 * TypeScript with jiti. Nothing is injected, so the extension resolves its own
 * config from the environment and runs the hook for real, so point GORTEX_BIN
 * somewhere harmless before calling.
 */
export async function createPackagedHarness(packageRoot: string): Promise<Harness> {
  const { cwd, agentDir } = tempDirs();
  const { extensions, errors, runtime } = await discoverAndLoadExtensions(
    [packageRoot],
    cwd,
    agentDir,
    createEventBus(),
  );
  if (errors.length > 0) {
    throw new Error(`extension failed to load: ${JSON.stringify(errors)}`);
  }
  return buildHarness(extensions, runtime, cwd);
}

// Every runner's swallowed errors, so a suite can assert them all at once.
const collected: ExtensionError[][] = [];

/** Asserts no harness built in this file collected a runner error; register with after(). */
export function assertNoRunnerErrors(): void {
  assert.deepEqual(collected.flat(), []);
}

function buildHarness(
  extensions: Extension[],
  runtime: ExtensionRuntime,
  cwd: string,
  session: SessionManager = SessionManager.inMemory(cwd),
): Harness {
  const sent: unknown[] = [];
  const errors: ExtensionError[] = [];
  collected.push(errors);
  let added: ContextMessage[] = [];
  const runner = new ExtensionRunner(
    extensions,
    runtime,
    cwd,
    session,
    // Never read by this extension; constructing a real one would reach for
    // the user's auth.json and the model catalog.
    new ModelRegistry(undefined as never),
  );
  runner.onError((err) => errors.push(err));
  const controller = new AbortController();
  runner.bindCore(extensionActions(sent, () => runner), extensionContextActions(controller.signal));

  // Without a UI context the runner reports hasUI false, so the extension's
  // user-facing warnings would be skipped rather than asserted on.
  const notifications: Notification[] = [];
  const ui: Partial<ExtensionUIContext> = {
    notify: (message: string, type?: string) => {
      notifications.push({ message, type });
    },
  };
  runner.setUIContext(ui as ExtensionUIContext, "tui");

  return {
    runner,
    sent,
    errors,
    cwd,
    notifications,
    async sessionStart(reason = "startup") {
      const result = await runner.emit({ type: "session_start", reason } as Parameters<ExtensionRunner["emit"]>[0]);
      runner.reportUnhandledMcpServers();
      return result;
    },
    sessionShutdown(reason: "quit" | "reload" | "new" | "resume" | "fork" = "quit") {
      return runner.emit({ type: "session_shutdown", reason } as Parameters<ExtensionRunner["emit"]>[0]);
    },
    session,
    async turn(prompt = "go") {
      const result = await runner.emitBeforeAgentStart(prompt, undefined, {} as never);
      session.appendMessage({ role: "user", content: prompt, timestamp: Date.now() });
      for (const message of result.messages) {
        session.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
        added.push({ role: "user", content: String(message.content) });
      }
      return result;
    },
    async context() {
      const out = added;
      added = [];
      return out;
    },
    modelContext() {
      return session
        .buildContextEntries()
        .filter((entry) => entry.type === "custom_message" && entry.customType === "gortex")
        .map((entry) => ({ role: "user", content: String((entry as { content: unknown }).content) }));
    },
    compact(keepFrom = null) {
      const compactionEntry = session.getEntry(session.appendCompaction("summary", keepFrom, 0));
      return runner.emit({
        type: "session_compact",
        compactionEntry,
        fromExtension: false,
        reason: "manual",
        willRetry: false,
      } as Parameters<ExtensionRunner["emit"]>[0]);
    },
    toolCall(toolName, input) {
      return runner.emitToolCall({ type: "tool_call", toolName, input } as Parameters<ExtensionRunner["emitToolCall"]>[0]);
    },
    abort() {
      controller.abort();
    },
    tools() {
      return runner.getAllRegisteredTools().map((t) => t.definition.name);
    },
    extensionPaths() {
      return runner.getExtensionPaths();
    },
    mcpServers() {
      return runtime.mcpServers.list();
    },
  };
}

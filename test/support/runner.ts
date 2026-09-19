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
  RegisteredTool,
  ToolCallEventResult,
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
  /** session_start, as Pi emits it. */
  sessionStart(reason?: string): Promise<unknown>;
  /** before_agent_start: the turn the readiness barrier holds. */
  turn(prompt?: string): Promise<unknown>;
  /** One context assembly pass; returns the messages the extension appended. */
  context(): Promise<ContextMessage[]>;
  toolCall(toolName: string, input: Record<string, unknown>): Promise<ToolCallEventResult | undefined>;
  tools(): string[];
  tool(name: string): RegisteredTool["definition"] | undefined;
  /** The files Pi loaded this extension from. */
  extensionPaths(): string[];
  /** Everything the extension pushed at the user through ctx.ui.notify. */
  notifications: Notification[];
}

// Only the members this extension touches are implemented; the rest stay
// unwired, which is what pi-mono's own runner tests do. Typing the partial
// keeps sendMessage checked against Pi's real SendMessageHandler.
function extensionActions(sent: unknown[]): ExtensionActions {
  const partial: Partial<ExtensionActions> = {
    sendMessage: (message) => {
      sent.push(message);
    },
  };
  return partial as ExtensionActions;
}

function extensionContextActions(): ExtensionContextActions {
  const partial: Partial<ExtensionContextActions> = {
    isIdle: () => true,
    isProjectTrusted: () => true,
    getSignal: () => undefined,
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

export async function createHarness(
  factory: Factory,
  options: GortexExtensionOptions = {},
): Promise<Harness> {
  const { cwd, agentDir } = tempDirs();
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

  return buildHarness(extensions, runtime, cwd);
}

/**
 * The same harness, loaded the way a user's Pi does it: through Pi's own
 * discovery, which reads package.json's `pi.extensions` manifest and loads the
 * TypeScript with jiti. Nothing is injected, so the extension resolves its own
 * config from the environment and spawns for real, so point GORTEX_BIN
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

function buildHarness(extensions: Extension[], runtime: ExtensionRuntime, cwd: string): Harness {
  const sent: unknown[] = [];
  const errors: ExtensionError[] = [];
  const runner = new ExtensionRunner(
    extensions,
    runtime,
    cwd,
    SessionManager.inMemory(cwd),
    // Never read by this extension; constructing a real one would reach for
    // the user's auth.json and the model catalog.
    new ModelRegistry(undefined as never),
  );
  runner.onError((err) => errors.push(err));
  runner.bindCore(extensionActions(sent), extensionContextActions());

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
    sessionStart(reason = "startup") {
      return runner.emit({ type: "session_start", reason } as Parameters<ExtensionRunner["emit"]>[0]);
    },
    turn(prompt = "go") {
      return runner.emitBeforeAgentStart(prompt, undefined, "SYSTEM", {} as never);
    },
    async context() {
      return (await runner.emitContext([])) as unknown as ContextMessage[];
    },
    toolCall(toolName, input) {
      return runner.emitToolCall({ type: "tool_call", toolName, input } as Parameters<ExtensionRunner["emitToolCall"]>[0]);
    },
    tools() {
      return runner.getAllRegisteredTools().map((t) => t.definition.name);
    },
    tool(name) {
      return runner.getToolDefinition(name);
    },
    extensionPaths() {
      return runner.getExtensionPaths();
    },
  };
}

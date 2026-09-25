// Tool registration: each tool the bridge lists becomes a native Pi tool whose
// execute() forwards to tools/call.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { textFromResult } from "./mcp-client.ts";
import type { ToolDescriptor } from "./mcp-client.ts";
import { getClient, gortexToolNames } from "./state.ts";
import { toolNameMap } from "./hook.ts";

// Pi's reserved built-in names (mirrors toolNameMap's keys). A bridge tool that
// reuses one would silently replace the built-in, breaking Pi's own rendering
// and anything hooked to it. Only "edit"/"read" collide today; guarding all
// seven covers built-ins Pi adds later.
const PI_RESERVED_TOOL_NAMES = new Set(Object.keys(toolNameMap));
const PI_ALIAS_PREFIX = "gortex_";

/**
 * piAliasName is unchanged unless name collides with a built-in above, in
 * which case it's registered under a `gortex_`-prefixed alias instead.
 */
export function piAliasName(name: string): string {
  return PI_RESERVED_TOOL_NAMES.has(name) ? PI_ALIAS_PREFIX + name : name;
}

/** piAliasedDescription front-loads the rename into the tool's own description. */
export function piAliasedDescription(bare: string, aliased: string, description: string): string {
  if (bare === aliased) return description;
  return (
    `Gortex's \`${bare}\` tool, registered as \`${aliased}\` because Pi has a built-in ` +
    `\`${bare}\`. Gortex guidance and denial messages that name \`${bare}\` mean this tool.` +
    `\n\n${description}`
  );
}

// Pi's own tool definitions are TypeBox-typed; the bridge's parameters are the
// daemon's raw JSON Schema, passed through untouched. This is the one place
// the two vocabularies meet.
type RegisterableTool = Parameters<ExtensionAPI["registerTool"]>[0];

interface BridgeToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute(toolCallId: string, params: Record<string, unknown>): Promise<unknown>;
  renderResult?: (result: unknown, options: { expanded?: boolean }) => unknown;
}

/**
 * safeRegister registers under the alias name (piAliasName). registerTool is a
 * map insert, so a repeat registration is harmless; the catch is for a late
 * registration from a superseded session, which throws once Pi has invalidated
 * that extension instance. Returns the name actually registered.
 */
export function safeRegister(pi: ExtensionAPI, def: BridgeToolDefinition): string {
  def.name = piAliasName(def.name);
  def.label = def.name;
  try {
    pi.registerTool(def as unknown as RegisterableTool);
  } catch {
    // already live this session, or this instance has been invalidated: the
    // existing registration stands.
  }
  return def.name;
}

function resultText(result: unknown): string {
  const structured = (result as { structuredContent?: unknown })?.structuredContent;
  return textFromResult(result) || JSON.stringify(structured ?? result ?? {});
}

/**
 * Registers one Gortex tool under its bare daemon name (or its alias).
 * Idempotent: a name already registered is skipped. Adds the name to
 * gortexToolNames so the read-discipline postures treat a call to it as a graph
 * query.
 *
 * renderResult collapses the result to nothing until the user expands it with
 * ctrl+o; Pi's fallback renderCall already shows the tool name.
 */
export function registerOneTool(pi: ExtensionAPI, desc: ToolDescriptor): void {
  const name = desc.name;
  if (!name) return;
  if (gortexToolNames.has(piAliasName(name))) return;
  const parameters =
    desc.inputSchema && typeof desc.inputSchema === "object"
      ? desc.inputSchema
      : { type: "object", properties: {} };
  const def: BridgeToolDefinition = {
    name,
    label: name,
    description: piAliasedDescription(name, piAliasName(name), (desc.description || name).trim()),
    parameters,
    async execute(_id: string, params: Record<string, unknown>) {
      const client = getClient();
      if (!client) throw new Error(`gortex ${name}: MCP bridge is not connected`);
      let result: unknown;
      try {
        result = await client.callTool(name, params ?? {});
      } catch (err) {
        throw new Error(`gortex ${name} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (name === "tools_search") {
        // The daemon just promoted the matches and fired list_changed;
        // register them NOW (bypassing the debounce) so every tool the
        // reply cites is already callable when the model reads it.
        await syncTools(pi);
      }
      const text = resultText(result);
      if ((result as { isError?: boolean })?.isError) throw new Error(text || `gortex ${name} failed`);
      return { content: [{ type: "text", text }], details: {} };
    },
  };
  def.renderResult = (result: unknown, options: { expanded?: boolean }) => {
    if (!options?.expanded) return new Text("", 0, 0);
    return new Text(resultText(result), 0, 0);
  };
  gortexToolNames.add(safeRegister(pi, def));
}

/** Registers the daemon's eager tool surface, discovery tool included. */
export async function registerGortexTools(pi: ExtensionAPI): Promise<void> {
  const client = getClient();
  if (!client) return;
  for (const desc of await client.listTools()) {
    if (!desc) continue;
    registerOneTool(pi, desc);
  }
}

/** Re-fetches the tool list after a list_changed and registers anything new. */
export async function syncTools(pi: ExtensionAPI): Promise<void> {
  try {
    await registerGortexTools(pi);
  } catch {
    // transient; the next promotion or session retries.
  }
}

// The daemon fires one list_changed per promoted tool, so a tools_search sweep
// arrives as a burst; debounce to a single trailing re-fetch. (The tools_search
// execute() path awaits syncTools directly, bypassing this timer.)
const SYNC_DEBOUNCE_MS = 200;
let syncTimer: ReturnType<typeof setTimeout> | null = null;

export function scheduleSyncTools(pi: ExtensionAPI): void {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    void syncTools(pi);
  }, SYNC_DEBOUNCE_MS);
}

/** Cancels a pending re-sync; a new session re-registers from scratch. */
export function clearSyncTimer(): void {
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
}

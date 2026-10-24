// The tool channel: the extension registers `gortex mcp` with Pi's built-in MCP
// and Pi owns the connection, the tool registry and the rendering. See
// docs/architecture.md.

import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { GortexConfig } from "./config.ts";

const MCP_SERVER_NAME = "gortex";
/** Pi names a server's tools `mcp__<server>__<tool>`. */
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

const SERVER_DESCRIPTION =
  "Gortex code graph of the indexed repositories: symbol search, source reads, usages, " +
  "call chains, change impact and graph-aware edits.";

// tools/call cap in seconds: generous enough for long analyzers, finite so a
// wedged daemon can't hang the agent turn forever. Pi's default is a minute.
const CALL_TIMEOUT_S = 600;

// Floor for the daemon: older ones serve a fixed tool facade that the
// extension's briefing and tool names do not match.
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
function presetEnv(
  toolsPreset: string,
  env: Record<string, string | undefined>,
): Record<string, string> {
  if (toolsPreset === "") return { GORTEX_TOOLS: "", GORTEX_TOOLS_MODE: "" };
  // Never let a preset hide-block tools promoted later by tools_search.
  return { GORTEX_TOOLS: toolsPreset, GORTEX_TOOLS_MODE: env.GORTEX_TOOLS_MODE?.trim() || "defer" };
}

// Read structurally: Pi does not enforce the peer dependency, so an older Pi
// can still load the extension without these members.
type McpApi = Pick<ExtensionAPI, "registerMcpServer" | "getAllTools" | "getCommands">;

export function supportsMcp(pi: ExtensionAPI): boolean {
  return typeof (pi as Partial<McpApi>).registerMcpServer === "function";
}

export function serverConfig(
  config: GortexConfig,
  env: Record<string, string | undefined> = process.env,
): Parameters<ExtensionAPI["registerMcpServer"]>[1] {
  return {
    command: config.bin,
    args: ["mcp"],
    env: presetEnv(config.toolsPreset, env),
    // Declared to the model like built-in tools, and the first prompt waits
    // for the connection. Codemode would hand scripts gcx text to parse.
    exposure: "direct",
    timeout: CALL_TIMEOUT_S,
    description: SERVER_DESCRIPTION,
  };
}

/** Registers the server; returns why it failed, or "" on success. */
export function registerServer(pi: ExtensionAPI, config: GortexConfig): string {
  try {
    (pi as McpApi).registerMcpServer(MCP_SERVER_NAME, serverConfig(config));
    return "";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Whether `bin` names an executable file, directly or through PATH. Pi reports
 * no connection failure to extensions, so a server that cannot spawn would
 * read as one still connecting.
 */
export function binaryResolves(bin: string, env: Record<string, string | undefined> = process.env): boolean {
  const exts = process.platform === "win32" ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")] : [""];
  const candidates = /[\\/]/.test(bin)
    ? [bin]
    : (env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, bin));
  return candidates.some((path) =>
    exts.some((ext) => {
      try {
        accessSync(path + ext, constants.X_OK);
        return statSync(path + ext).isFile();
      } catch {
        return false;
      }
    }),
  );
}

/**
 * The daemon version the session_start briefing reports, or "" when it names
 * none. The briefing is the only place it reaches the extension on Pi's MCP.
 */
export function daemonVersionFromBriefing(briefing: string): string {
  return /Gortex daemon [^(\n]*\(v(\d[^,\s)]*)/.exec(briefing)?.[1] ?? "";
}

/**
 * Whether an extension that connects MCP servers is loaded. Pi's own MCP
 * extension and the ones that replace it register `/mcp`; `--no-mcp` and
 * `-ne` without `builtin:mcp` leave a registration with nothing to connect it.
 * Read on session_start, once every extension has loaded. A Pi that cannot
 * list commands is trusted to connect the server.
 */
export function mcpConnectorLoaded(pi: ExtensionAPI): boolean {
  try {
    return (pi as McpApi).getCommands().some((command) => command.name === "mcp");
  } catch {
    return true;
  }
}

export function isGortexTool(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX);
}

/** The daemon's own name for a gortex tool, as Gortex guidance spells it. */
export function bareToolName(name: string): string {
  return isGortexTool(name) ? name.slice(MCP_TOOL_PREFIX.length) : name;
}

/** True once Pi has registered at least one tool from the gortex server. */
export function gortexToolsReady(pi: ExtensionAPI): boolean {
  try {
    return (pi as McpApi).getAllTools().some((tool) => isGortexTool(tool.name));
  } catch {
    return false;
  }
}

/**
 * How long the first turn waits for the gortex tools. Pi loads its MCP
 * extension after this one, so its own 10s wait for direct servers comes
 * later; this covers that window plus a daemon still warming up.
 */
export const TOOLS_READY_WAIT_MS = 15_000;

/** Resolves true once the gortex tools are registered, false when `ms` passes first. */
export async function waitForGortexTools(pi: ExtensionAPI, ms: number, pollMs = 100): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!gortexToolsReady(pi)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return true;
}

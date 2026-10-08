// The tool channel on Pi's built-in MCP (Pi >= 0.99): the extension registers
// `gortex mcp` with pi.registerMcpServer() and Pi owns the connection, the tool
// registry and the rendering. See docs/architecture.md.

import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { GortexConfig } from "./config.ts";
import { CALL_TIMEOUT_MS, presetEnv } from "./mcp-client.ts";

export const MCP_SERVER_NAME = "gortex";
/** Pi names a server's tools `mcp__<server>__<tool>`. */
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

const SERVER_DESCRIPTION =
  "Gortex code graph of the indexed repositories: symbol search, source reads, usages, " +
  "call chains, change impact and graph-aware edits.";

// Pi 0.87 declares none of the MCP members, so they are read structurally.
type NativeMcpApi = Pick<ExtensionAPI, "registerMcpServer" | "getAllTools">;

export function supportsNativeMcp(pi: ExtensionAPI): boolean {
  return typeof (pi as Partial<NativeMcpApi>).registerMcpServer === "function";
}

export function nativeServerConfig(
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
    timeout: CALL_TIMEOUT_MS / 1000,
    description: SERVER_DESCRIPTION,
  };
}

/** Registers the server; returns why it failed, or "" on success. */
export function registerNativeServer(pi: ExtensionAPI, config: GortexConfig): string {
  try {
    (pi as NativeMcpApi).registerMcpServer(MCP_SERVER_NAME, nativeServerConfig(config));
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

export function isNativeGortexTool(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX);
}

/** The daemon's own name for a native tool, as Gortex guidance spells it. */
export function bareToolName(name: string): string {
  return isNativeGortexTool(name) ? name.slice(MCP_TOOL_PREFIX.length) : name;
}

/** True once Pi has registered at least one tool from the gortex server. */
export function nativeToolsReady(pi: ExtensionAPI): boolean {
  try {
    return (pi as NativeMcpApi).getAllTools().some((tool) => isNativeGortexTool(tool.name));
  } catch {
    return false;
  }
}

/**
 * How long the first turn waits for the gortex tools on top of Pi's own wait.
 * Pi's MCP extension already holds the first prompt for up to 10s on a direct
 * server, so this only covers a daemon still warming up after that.
 */
export const NATIVE_READY_WAIT_MS = 5_000;

/** Resolves true once the gortex tools are registered, false when `ms` passes first. */
export async function waitForNativeTools(pi: ExtensionAPI, ms: number, pollMs = 100): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!nativeToolsReady(pi)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return true;
}

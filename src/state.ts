// Module-level session state.
//
// Shared at module level on purpose: a new invocation's session_start stops the
// previous invocation's bridge child, which works only while both invocations
// see the same `client`. Move this into the factory closure and every `/new`
// leaks a `gortex mcp` process.

import type { MCPStdioClient } from "./mcp-client.ts";

/** The session's live bridge, or null when the handshake failed. */
let client: MCPStdioClient | null = null;

/**
 * Why the bridge is down this session (empty when it is up). Surfaced once
 * through the orientation injection so the user learns that /reload retries
 * the handshake.
 */
let bridgeError = "";

/**
 * How the daemon is out of step with this extension (empty when it is not).
 * Surfaced once to the model alongside the orientation; the user learns about
 * it through ctx.ui.notify at session_start, which never reaches the model.
 */
let versionWarning = "";

/**
 * Names the Gortex tools are registered under in Pi. Usually the bare daemon
 * name, except for a few aliased to dodge Pi's built-ins (see piAliasName).
 * Tracks the post-alias name.
 */
export const gortexToolNames = new Set<string>();

export function getClient(): MCPStdioClient | null {
  return client;
}

export function setClient(next: MCPStdioClient | null): void {
  client = next;
}

export function getBridgeError(): string {
  return bridgeError;
}

export function setBridgeError(message: string): void {
  bridgeError = message;
}

export function getVersionWarning(): string {
  return versionWarning;
}

export function setVersionWarning(message: string): void {
  versionWarning = message;
}

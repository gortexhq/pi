// Shared fixtures. The per-suite choreography stays in the test files: for the
// barrier, when each event fires relative to the others IS the thing under test.

import { readFileSync } from "node:fs";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { GortexConfig } from "../../src/config.ts";
import type { GortexExtensionOptions } from "../../src/index.ts";
import { MCP_TOOL_PREFIX } from "../../src/mcp.ts";
import { control, mockDeps } from "./hook-mock.ts";
import { createHarness } from "./runner.ts";
import type { Harness } from "./runner.ts";
import { loadFactory } from "./subject.ts";
import type { Factory } from "./subject.ts";

export const ORIENTATION = "GORTEX-ORIENTATION: prefer graph tools over native reads.";

/**
 * A fully resolved config, passed explicitly so no suite depends on the
 * machine's environment or on a `gortex.json` the developer happens to have.
 * The server is only registered for a binary that resolves, and Pi never
 * spawns it here. The hook goes to the double; a suite that forgets `deps`
 * fails open instead of running `node hook`.
 */
export const CONFIG: GortexConfig = {
  bin: process.execPath,
  hookArgv: ["/nonexistent/gortex", "hook", "--agent=pi"],
  enforce: true,
  toolsPreset: "",
};

/**
 * Stands in for the extension Pi uses to connect MCP servers. Pi takes an
 * `mcp_servers_change` handler as the sign that one is loaded; the extension
 * looks for the `/mcp` command that comes with it.
 */
export function withMcpConnector(gortex: Factory): Factory {
  return (pi, opts) => {
    pi.registerCommand("mcp", { description: "Manage MCP servers", handler: async () => {} });
    pi.on("mcp_servers_change", () => {});
    gortex(pi, opts);
  };
}

/** A gortex tool under the name Pi's MCP gives it. */
export function stubTool(name: string): ToolDefinition {
  return {
    name: `${MCP_TOOL_PREFIX}${name}`,
    label: name,
    description: "A stand-in gortex tool.",
    parameters: { type: "object", properties: {} } as never,
    execute: async () => ({ content: [], details: {} }),
  };
}

/** Registers a gortex tool as if the server had connected. */
export function withConnectedTools(gortex: Factory): Factory {
  return (pi, opts) => {
    pi.registerTool(stubTool("search"));
    gortex(pi, opts);
  };
}

/** Hands the extension a `pi` whose registerMcpServer is replaced, or absent like on Pi < 0.99. */
export function withRegisterMcpServer(gortex: Factory, replacement: unknown): Factory {
  return (pi, opts) => {
    const patched = new Proxy(pi, {
      get: (target, key) => (key === "registerMcpServer" ? replacement : Reflect.get(target, key)),
    });
    gortex(patched, opts);
  };
}

export function options(overrides: Partial<GortexExtensionOptions> = {}): GortexExtensionOptions {
  return { config: CONFIG, deps: mockDeps, ...overrides };
}

/** A started session with an MCP connector loaded, unless `connector` is false. */
export async function gortexSession(
  factory?: Factory,
  config = CONFIG,
  orientation = ORIENTATION,
  connector = true,
): Promise<Harness> {
  control.reset({ hookDecision: { orientation } });
  const gortex = factory ?? (await loadFactory(0));
  const harness = await createHarness(
    connector ? withMcpConnector(gortex) : gortex,
    options({ config, toolsReadyWaitMs: 50 }),
  );
  await harness.sessionStart();
  return harness;
}

export const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The pid a child wrote to `file`, once it has. */
export async function pidFrom(file: string): Promise<number> {
  // A fence against a child that never starts, not a bound under test.
  for (let i = 0; i < 1000; i++) {
    const pid = Number(readFileSync(file, { encoding: "utf8", flag: "a+" }));
    if (pid) return pid;
    await delay(10);
  }
  throw new Error(`no pid in ${file}`);
}

/**
 * Whether `pid` exits. Node rejects a killed child's call once it has sent the
 * kill, before the child has exited, so this waits under a fence.
 */
export async function exits(pid: number): Promise<boolean> {
  const alive = (): boolean => {
    try {
      return process.kill(pid, 0);
    } catch {
      return false;
    }
  };
  for (let i = 0; i < 500 && alive(); i++) await delay(10);
  return !alive();
}

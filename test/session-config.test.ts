// Configuration follows the session's directory, and every child stays hidden
// on Windows.
//
// Why this suite exists: Pi runs a resumed session in the directory it was
// created in, which need not be where Pi was launched. Reading the project
// sidecar from the launch directory ran that session under another project's
// posture, binary and preset. Here the harness cwd is a temp directory while
// the test process runs from the repository, so the two always differ.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GortexExtensionOptions } from "../src/index.ts";
import { MCP_TOOL_PREFIX } from "../src/native.ts";
import { loadFactory } from "./support/subject.ts";
import type { Factory } from "./support/subject.ts";
import { createHarness } from "./support/runner.ts";
import type { Harness } from "./support/runner.ts";
import { control } from "./support/child-process-mock.ts";
import { ORIENTATION, TOOLS, options } from "./support/fixtures.ts";

const AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-gortex-session-config-"));
after(() => rmSync(AGENT_DIR, { recursive: true, force: true }));

/** Resolution from the real files, under an environment the suite controls. */
function resolving(env: Record<string, string>): GortexExtensionOptions {
  return options({ config: undefined, resolve: { env, agentDir: AGENT_DIR }, nativeReadyWaitMs: 50 });
}

function writeSidecar(cwd: string, sidecar: Record<string, unknown>): void {
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "gortex.json"), JSON.stringify(sidecar));
}

/** Stands in for the extension Pi uses to connect MCP servers, which also follows later registrations. */
function withMcpConnector(gortex: Factory): Factory {
  return (pi, opts) => {
    pi.registerCommand("mcp", { description: "Manage MCP servers", handler: async () => {} });
    pi.on("mcp_servers_change", () => {});
    gortex(pi, opts);
  };
}

/** The env of the one server the extension registered, if any. */
function serverEnv(harness: Harness): unknown {
  return (harness.mcpServers()[0]?.config as { env?: unknown } | undefined)?.env;
}

const OWN_CLIENT = { GORTEX_BIN: "/nonexistent/gortex", GORTEX_NATIVE_MCP: "0" };

describe("a session whose directory is not the launch directory", () => {
  let harness: Harness;

  before(async () => {
    control.reset({ tools: TOOLS, hookDecision: { orientation: ORIENTATION } });
    harness = await createHarness(await loadFactory(0), resolving(OWN_CLIENT));
    assert.notEqual(harness.cwd, process.cwd(), "the suite needs the two directories to differ");
    writeSidecar(harness.cwd, { hook_mode: "enrich" });
    await harness.sessionStart("resume");
    await harness.turn();
    await harness.toolCall("read", { path: "src/a.ts" });
  });

  it("runs the hook under that directory's posture", () => {
    assert.ok(control.hookCalls.length >= 2);
    for (const call of control.hookCalls) {
      assert.deepEqual(call.args, ["hook", "--agent=pi", "--mode=enrich"]);
    }
    assert.deepEqual(harness.errors, []);
  });
});

describe("a session sidecar that turns enforcement off", () => {
  it("leaves tool calls unchecked", async () => {
    control.reset({ tools: TOOLS });
    const harness = await createHarness(await loadFactory(0), resolving(OWN_CLIENT));
    writeSidecar(harness.cwd, { enforce: false });
    await harness.sessionStart();
    const before = control.hookCalls.length;
    await harness.toolCall("read", { path: "src/a.ts" });
    assert.equal(control.hookCalls.length, before);
    assert.deepEqual(harness.errors, []);
  });
});

describe("a session sidecar that changes the native server", () => {
  const NATIVE = { GORTEX_BIN: process.execPath };

  it("re-registers the server with that directory's preset", async () => {
    control.reset({ tools: TOOLS });
    const harness = await createHarness(withMcpConnector(await loadFactory(0)), resolving(NATIVE));
    assert.deepEqual(serverEnv(harness), { GORTEX_TOOLS: "", GORTEX_TOOLS_MODE: "" });
    writeSidecar(harness.cwd, { tools_preset: "nav" });
    await harness.sessionStart("resume");
    assert.equal(harness.mcpServers().length, 1);
    assert.deepEqual(serverEnv(harness), { GORTEX_TOOLS: "nav", GORTEX_TOOLS_MODE: "defer" });
    assert.deepEqual(control.spawns, [], "the extension's own client must stay down");
    assert.deepEqual(harness.errors, []);
  });

  it("withdraws it for the extension's own client when the sidecar opts out", async () => {
    control.reset({ tools: TOOLS });
    const harness = await createHarness(withMcpConnector(await loadFactory(0)), resolving(NATIVE));
    assert.equal(harness.mcpServers().length, 1);
    writeSidecar(harness.cwd, { native_mcp: false });
    await harness.sessionStart("resume");
    assert.deepEqual(harness.mcpServers(), []);
    assert.ok(control.spawns.some((s) => s.args[0] === "mcp"), "the own client never spawned");
    assert.ok(!harness.tools().some((name) => name.startsWith(MCP_TOOL_PREFIX)));
    assert.deepEqual(harness.errors, []);
  });
});

// Why: without windowsHide a detached `daemon start` gets its own console on
// Windows, and each synchronous hook call can flash one.
describe("every child process", () => {
  it("is spawned with its console hidden", async () => {
    control.reset({ tools: TOOLS, hookDecision: { orientation: ORIENTATION } });
    const harness = await createHarness(await loadFactory(0), options());
    await harness.sessionStart();
    await harness.turn();
    await harness.toolCall("read", { path: "src/a.ts" });

    assert.deepEqual(control.spawns.map((s) => s.args[0]).sort(), ["daemon", "mcp"]);
    for (const spawn of control.spawns) assert.equal(spawn.opts?.windowsHide, true, `${spawn.args[0]} is not hidden`);
    assert.ok(control.hookCalls.length >= 2);
    for (const call of control.hookCalls) assert.equal(call.opts?.windowsHide, true, "a hook call is not hidden");
    assert.deepEqual(harness.errors, []);
  });
});

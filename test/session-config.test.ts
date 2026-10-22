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
import { ORIENTATION, TOOLS, options, withMcpConnector } from "./support/fixtures.ts";

const ROOT = mkdtempSync(join(tmpdir(), "pi-gortex-session-config-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));
const AGENT_DIR = join(ROOT, "agent");
/** Stands in for the directory Pi was launched from. */
const LAUNCH_DIR = join(ROOT, "launch");
mkdirSync(AGENT_DIR);
mkdirSync(LAUNCH_DIR);

/** Resolution from the real files, under an environment the suite controls. */
function resolving(env: Record<string, string>): GortexExtensionOptions {
  return options({ config: undefined, resolve: { env, agentDir: AGENT_DIR, cwd: LAUNCH_DIR }, nativeReadyWaitMs: 50 });
}

function writeSidecar(cwd: string, sidecar: Record<string, unknown>): void {
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "gortex.json"), JSON.stringify(sidecar));
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
    writeSidecar(harness.cwd, { hook_mode: "enrich" });
    await harness.sessionStart("resume");
    await harness.turn();
    await harness.toolCall("read", { path: "src/a.ts" });
  });

  it("spawns the extension's own `gortex mcp` there", () => {
    const mcp = control.spawns.find((spawn) => spawn.args[0] === "mcp");
    assert.equal(mcp?.opts?.cwd, harness.cwd);
  });

  it("runs the hook under that directory's posture", () => {
    assert.ok(control.hookCalls.length >= 2);
    for (const call of control.hookCalls) {
      assert.deepEqual(call.args, ["hook", "--agent=pi", "--mode=enrich"]);
    }
    assert.deepEqual(harness.errors, []);
  });
});

describe("a session sidecar that sets enforcement", () => {
  after(() => rmSync(join(LAUNCH_DIR, ".pi"), { recursive: true, force: true }));

  it("checks tool calls when the launch directory turned it off", async () => {
    control.reset({ tools: TOOLS });
    writeSidecar(LAUNCH_DIR, { enforce: false });
    const harness = await createHarness(await loadFactory(0), resolving(OWN_CLIENT));
    writeSidecar(harness.cwd, { enforce: true });
    await harness.sessionStart();
    const before = control.hookCalls.length;
    await harness.toolCall("read", { path: "src/a.ts" });
    assert.equal(control.hookCalls.length, before + 1);
    assert.deepEqual(harness.errors, []);
  });

  it("leaves tool calls unchecked when it turns it off", async () => {
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

describe("the native server", () => {
  const NATIVE = { GORTEX_BIN: process.execPath };

  it("is registered on session_start with the session directory's preset", async () => {
    control.reset({ tools: TOOLS });
    writeSidecar(LAUNCH_DIR, { tools_preset: "edit" });
    const harness = await createHarness(withMcpConnector(await loadFactory(0)), resolving(NATIVE));
    rmSync(join(LAUNCH_DIR, ".pi"), { recursive: true, force: true });
    assert.deepEqual(harness.mcpServers(), [], "nothing may be registered before the session's config is known");
    writeSidecar(harness.cwd, { tools_preset: "nav" });
    await harness.sessionStart("resume");
    assert.equal(harness.mcpServers().length, 1);
    assert.deepEqual(serverEnv(harness), { GORTEX_TOOLS: "nav", GORTEX_TOOLS_MODE: "defer" });
    assert.deepEqual(control.spawns, [], "the extension's own client must stay down");
    assert.deepEqual(harness.errors, []);
  });

  it("is left alone by a later session with the same config, so Pi does not reconnect it", async () => {
    control.reset({ tools: TOOLS });
    let registrations = 0;
    const counting: Factory = (pi, opts) => {
      const register = pi.registerMcpServer.bind(pi);
      pi.registerMcpServer = (name, config) => {
        registrations += 1;
        register(name, config);
      };
      return withMcpConnector(gortex)(pi, opts);
    };
    const gortex = await loadFactory(0);
    const harness = await createHarness(counting, resolving(NATIVE));
    await harness.sessionStart();
    await harness.sessionStart("new");
    assert.equal(registrations, 1);
    assert.equal(harness.mcpServers().length, 1);
    assert.deepEqual(harness.errors, []);
  });

  it("is withdrawn for the extension's own client when a later session opts out", async () => {
    control.reset({ tools: TOOLS });
    const harness = await createHarness(withMcpConnector(await loadFactory(0)), resolving(NATIVE));
    await harness.sessionStart();
    assert.equal(harness.mcpServers().length, 1);
    writeSidecar(harness.cwd, { native_mcp: false });
    await harness.sessionStart("new");
    assert.deepEqual(harness.mcpServers(), []);
    assert.ok(control.spawns.some((s) => s.args[0] === "mcp"), "the own client never spawned");
    assert.ok(!harness.tools().some((name) => name.startsWith(MCP_TOOL_PREFIX)));
    assert.deepEqual(harness.errors, []);
  });

  it("is never registered when nothing connects MCP servers", async () => {
    control.reset({ tools: TOOLS });
    const harness = await createHarness(await loadFactory(0), resolving(NATIVE));
    await harness.sessionStart();
    assert.deepEqual(harness.mcpServers(), []);
    assert.ok(control.spawns.some((s) => s.args[0] === "mcp"), "the own client never spawned");
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

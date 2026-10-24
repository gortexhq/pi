// Configuration follows the session's directory, and every hook call stays
// hidden on Windows.
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
import { loadFactory } from "./support/subject.ts";
import { assertNoRunnerErrors, createHarness } from "./support/runner.ts";
import type { Harness } from "./support/runner.ts";
import { control } from "./support/hook-mock.ts";
import { ORIENTATION, options, withConnectedTools, withMcpConnector } from "./support/fixtures.ts";

after(assertNoRunnerErrors);

const ROOT = mkdtempSync(join(tmpdir(), "pi-gortex-session-config-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));
const AGENT_DIR = join(ROOT, "agent");
/** Stands in for the directory Pi was launched from. */
const LAUNCH_DIR = join(ROOT, "launch");
mkdirSync(AGENT_DIR);
mkdirSync(LAUNCH_DIR);

/** Resolution from the real files, under an environment the suite controls. */
function resolving(env: Record<string, string>): GortexExtensionOptions {
  return options({ config: undefined, resolve: { env, agentDir: AGENT_DIR, cwd: LAUNCH_DIR }, toolsReadyWaitMs: 50 });
}

function writeSidecar(cwd: string, sidecar: Record<string, unknown>): void {
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "gortex.json"), JSON.stringify(sidecar));
}

/** The env of the one server the extension registered, if any. */
function serverEnv(harness: Harness): unknown {
  return (harness.mcpServers()[0]?.config as { env?: unknown } | undefined)?.env;
}

const RESOLVING_BIN = { GORTEX_BIN: process.execPath };

async function connectedHarness(env: Record<string, string> = RESOLVING_BIN): Promise<Harness> {
  return createHarness(withMcpConnector(withConnectedTools(await loadFactory(0))), resolving(env));
}

describe("a session whose directory is not the launch directory", () => {
  let harness: Harness;

  before(async () => {
    control.reset({ hookDecision: { orientation: ORIENTATION } });
    harness = await connectedHarness();
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

describe("a session sidecar that sets enforcement", () => {
  after(() => rmSync(join(LAUNCH_DIR, ".pi"), { recursive: true, force: true }));

  it("checks tool calls when the launch directory turned it off", async () => {
    control.reset();
    writeSidecar(LAUNCH_DIR, { enforce: false });
    const harness = await connectedHarness();
    writeSidecar(harness.cwd, { enforce: true });
    await harness.sessionStart();
    const before = control.hookCalls.length;
    await harness.toolCall("read", { path: "src/a.ts" });
    assert.equal(control.hookCalls.length, before + 1);
    assert.deepEqual(harness.errors, []);
  });

  it("leaves tool calls unchecked when it turns it off", async () => {
    control.reset();
    const harness = await connectedHarness();
    writeSidecar(harness.cwd, { enforce: false });
    await harness.sessionStart();
    const before = control.hookCalls.length;
    await harness.toolCall("read", { path: "src/a.ts" });
    assert.equal(control.hookCalls.length, before);
    assert.deepEqual(harness.errors, []);
  });
});

describe("the gortex server", () => {
  it("is registered on session_start with the session directory's preset", async () => {
    control.reset();
    writeSidecar(LAUNCH_DIR, { tools_preset: "edit" });
    const harness = await createHarness(withMcpConnector(await loadFactory(0)), resolving(RESOLVING_BIN));
    rmSync(join(LAUNCH_DIR, ".pi"), { recursive: true, force: true });
    assert.deepEqual(harness.mcpServers(), [], "nothing may be registered before the session's config is known");
    writeSidecar(harness.cwd, { tools_preset: "nav" });
    await harness.sessionStart("resume");
    assert.equal(harness.mcpServers().length, 1);
    assert.deepEqual(serverEnv(harness), { GORTEX_TOOLS: "nav", GORTEX_TOOLS_MODE: "defer" });
    assert.deepEqual(harness.errors, []);
  });

  it("is never registered when nothing connects MCP servers", async () => {
    control.reset({ hookDecision: { orientation: ORIENTATION } });
    const harness = await createHarness(await loadFactory(0), resolving(RESOLVING_BIN));
    await harness.sessionStart();
    await harness.turn();
    assert.deepEqual(harness.mcpServers(), []);
    assert.match((await harness.context())[0]!.content, /MCP support is not loaded/);
    assert.deepEqual(harness.errors, []);
  });
});

// Why: each synchronous hook call can flash a console on Windows.
describe("every hook call", () => {
  it("runs with its console hidden", async () => {
    control.reset({ hookDecision: { orientation: ORIENTATION } });
    const harness = await createHarness(withMcpConnector(withConnectedTools(await loadFactory(0))), options());
    await harness.sessionStart();
    await harness.turn();
    await harness.toolCall("read", { path: "src/a.ts" });

    assert.ok(control.hookCalls.length >= 2);
    for (const call of control.hookCalls) assert.equal(call.opts?.windowsHide, true, "a hook call is not hidden");
    assert.deepEqual(harness.errors, []);
  });
});

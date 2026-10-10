// Session shutdown tears the bridge child down: the child's open stdio pipes
// hold the host's event loop, so a child left running past its session hangs
// a print or JSON run that already finished its work. Reload case: Pi
// re-imports the extension source, so only the previous generation's own
// session_shutdown can stop the child it spawned. Background: PR description.

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

import { loadFactory } from "./support/subject.ts";
import { createHarness } from "./support/runner.ts";
import type { Harness } from "./support/runner.ts";
import { control, resetInitializeAttempts } from "./support/child-process-mock.ts";
import type { FakeChild } from "./support/child-process-mock.ts";
import { ORIENTATION, TOOLS, options } from "./support/fixtures.ts";

describe("session_shutdown tearing the bridge child down", () => {
  let harness: Harness;
  let bridge: FakeChild;

  before(async () => {
    resetInitializeAttempts();
    control.reset({ tools: TOOLS, hookDecision: { orientation: ORIENTATION } });

    harness = await createHarness(await loadFactory(0), options());
    await harness.sessionStart("startup");
    // The daemon launcher stub never reaches control.children, so the first
    // entry is the bridge child session_start spawned.
    bridge = control.children[0]!;
    await harness.sessionShutdown("quit");
  });

  it("kills the bridge child when Pi shuts the session down", () => {
    assert.equal(bridge.killed, true, "the bridge child survived session_shutdown");
    assert.deepEqual(harness.errors, []);
  });

  it("a second session_shutdown is a safe no-op", async () => {
    await harness.sessionShutdown("quit");
    assert.equal(bridge.killed, true);
    assert.deepEqual(harness.errors, []);
  });

  it("spawned the child unref'd, pipes included", () => {
    // The child plus stdin, stdout and stderr: none of them may hold the
    // event loop, or a finished print/JSON run hangs at exit.
    for (const part of ["child", "stdin", "stdout", "stderr"] as const) {
      assert.equal(bridge.unrefCounts[part], 1, `expected ${part} unref'd exactly once`);
    }
  });

  it("gives the next session a fresh, live bridge", async () => {
    await harness.sessionStart("new");
    const next = control.children[1]!;
    assert.notEqual(next, bridge);
    assert.equal(next.killed, false);
    assert.equal(harness.tools().length, 3);
    assert.deepEqual(harness.errors, []);
  });
});

describe("reload replacing the session", () => {
  it("the previous generation's session_shutdown stops its own bridge", async () => {
    resetInitializeAttempts();
    control.reset({ tools: TOOLS, hookDecision: { orientation: ORIENTATION } });

    // Pi reloads by re-importing the extension: generation 1 cannot see
    // generation 0's client, so only the old instance can stop its child.
    const old = await createHarness(await loadFactory(0), options());
    await old.sessionStart("startup");
    const oldBridge = control.children.at(-1)!;

    const fresh = await createHarness(await loadFactory(1), options());
    await fresh.sessionStart("startup");
    const freshBridge = control.children.at(-1)!;
    assert.notEqual(freshBridge, oldBridge);

    await old.sessionShutdown("reload");
    assert.equal(oldBridge.killed, true, "reload leaked the previous generation's bridge child");
    assert.equal(freshBridge.killed, false, "the new generation's bridge must stay live");
    assert.deepEqual(old.errors, []);
    assert.deepEqual(fresh.errors, []);
  });
});

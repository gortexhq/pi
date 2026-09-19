// READY_WAIT_MS expiry: the barrier gives up once the cap passes, and the
// turn it lets through says so.
//
// Why this suite exists: the barrier parks a turn on a promise, so a daemon
// that never answers would park the session forever. The cap is what bounds
// that, and the warning on the released turn is the user's only signal that a
// tool may not be callable yet. Neither shows up until a handshake stalls,
// which no other suite arranges.
//
// The cap rides the factory options, which reach the extension through the
// inline-factory closure Pi's loader accepts.

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

import { loadFactory } from "./support/subject.ts";
import { createHarness } from "./support/runner.ts";
import type { ContextMessage, Harness } from "./support/runner.ts";
import { control, resetInitializeAttempts } from "./support/child-process-mock.ts";
import { ORIENTATION, TOOLS, options, startGatedSession } from "./support/fixtures.ts";

const CAP_MS = 20;

describe("the cap expires before registration finishes", () => {
  let harness: Harness;
  let toolsAtRelease: number;
  let turn1: ContextMessage[];
  let laterTurn: ContextMessage[];

  before(async () => {
    resetInitializeAttempts();
    control.reset({ tools: TOOLS, hookDecision: { orientation: ORIENTATION } });

    harness = await createHarness(await loadFactory(0), options({ readyWaitMs: CAP_MS }));

    // The child answers nothing until released, so registration cannot finish
    // while the turn is in flight however slow or fast the machine is.
    const { settled, child } = startGatedSession(harness);

    await harness.turn();
    toolsAtRelease = harness.tools().length;

    turn1 = await harness.context();

    child.releaseReplies();
    await settled;
    laterTurn = await harness.context();
  });

  it("releases the turn before the tools are live", () => {
    // The gate holds registration open, so this is the bounded-wait claim:
    // the cap, and nothing else, let the turn through.
    assert.equal(toolsAtRelease, 0);
  });

  it("still carries the orientation", () => {
    assert.equal(turn1.length, 1);
    assert.ok(turn1[0]!.content.includes(ORIENTATION));
  });

  it("warns that the tools are not callable yet", () => {
    assert.match(turn1[0]!.content, /still registering/i);
  });

  it("names /reload as the recovery", () => {
    assert.ok(turn1[0]!.content.includes("/reload"));
  });

  it("lands the registration after the cap anyway", () => {
    assert.equal(harness.tools().length, 3);
  });

  it("still explains the rename on a late-registered tool", () => {
    assert.ok((harness.tool("gortex_read")?.description ?? "").includes("`gortex_read`"));
  });

  it("injects nothing on later turns", () => {
    assert.equal(laterTurn.length, 0);
  });
});

// Overlapping session_start invocations on ONE extension instance: the turn
// parked on the newest invocation must not be released by an older one
// finishing. The failure mode guarded here: a single mutable
// `settleSessionReady` slot, reassigned by each arm, settles whichever promise
// is current when the OLD handler's finally runs.
//
// Why this suite exists: a regression guard. The resolver-per-invocation rule
// is easy to undo in a refactor, and the bug it prevents costs a turn its graph
// tools with nothing in the output to say why.
//
// Not reachable through Pi's own modes (every path that emits session_start
// constructs a fresh instance first), so the suite emits them directly on the
// real runner, which an embedder sharing one resourceLoader across sessions
// can also do.

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

import { loadFactory } from "./support/subject.ts";
import { createHarness } from "./support/runner.ts";
import type { ContextMessage, Harness } from "./support/runner.ts";
import { control, resetInitializeAttempts } from "./support/child-process-mock.ts";
import { ORIENTATION, TOOLS, options, startGatedSession } from "./support/fixtures.ts";

describe("a stale session_start settling mid-turn", () => {
  let harness: Harness;
  let injected: ContextMessage[];

  before(async () => {
    resetInitializeAttempts();
    control.reset({ tools: TOOLS, hookDecision: { orientation: ORIENTATION } });

    harness = await createHarness(await loadFactory(0), options({ readyWaitMs: 1_000 }));

    // A: superseded by B, so its start() rejects, backs off and retries. It
    // settles on its own schedule; nothing here depends on when.
    const a = harness.sessionStart("startup");

    // B: fast, and overlaps A.
    await harness.sessionStart("new");

    // C: gated until the turn is over, so only the readiness cap can release
    // the turn. A stale release would skip the cap's warning.
    const { settled: c, child: cChild } = startGatedSession(harness, "reload");

    const turn = harness.turn();
    await a;
    await turn;
    injected = await harness.context();

    cChild.releaseReplies();
    await c;
  });

  it("does not release the parked turn when the stale invocation settles", () => {
    assert.equal(injected.length, 1);
    assert.match(injected[0]!.content, /still registering/);
  });

  it("leaves the newest session's tools live", () => {
    assert.equal(harness.tools().length, 3);
  });
});

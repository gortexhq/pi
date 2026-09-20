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
import type { Harness } from "./support/runner.ts";
import { control, resetInitializeAttempts } from "./support/child-process-mock.ts";
import { ORIENTATION, TOOLS, delay, options, startGatedSession } from "./support/fixtures.ts";

describe("a stale session_start settling mid-turn", () => {
  let harness: Harness;
  let releasedWhenAFinished: number;
  let released: number;
  let aFinishedAt: number;

  before(async () => {
    resetInitializeAttempts();
    control.reset({ tools: TOOLS, hookDecision: { orientation: ORIENTATION } });

    harness = await createHarness(await loadFactory(0), options());

    // A: superseded by B, so its start() rejects, backs off and retries. It
    // settles on its own schedule; nothing here depends on when.
    const a = harness.sessionStart("startup");

    // B: fast, and overlaps A.
    await harness.sessionStart("new");

    // C: gated, so it is guaranteed to still be running when A settles.
    // Ordering is structural: A is awaited before C is ever released.
    const { settled: c, child: cChild } = startGatedSession(harness, "reload");

    const t0 = Date.now();
    released = 0;
    const turn = harness.turn().then(() => {
      released = Date.now() - t0;
    });

    await a;
    aFinishedAt = Date.now() - t0;

    // A settling releases the turn through a then(), so give that a full tick
    // to land before reading. C stays gated throughout, so correct code has
    // nothing that could release the turn no matter how long this waits.
    await delay(20);
    releasedWhenAFinished = released;

    cChild.releaseReplies();
    await turn;
    await c;
  });

  it("does not release the parked turn when the stale invocation settles", () => {
    assert.equal(
      releasedWhenAFinished,
      0,
      `released at ${releasedWhenAFinished}ms, while A settled at ${aFinishedAt}ms and C was still gated`,
    );
  });

  it("releases the turn once the invocation it parked on finishes", () => {
    assert.ok(released > 0, "the turn never resumed");
  });

  it("leaves the newest session's tools live", () => {
    assert.equal(harness.tools().length, 3);
  });
});

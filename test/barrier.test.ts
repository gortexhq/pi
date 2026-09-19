// The readiness barrier: a turn that arrives before the gortex tools are
// registered is held until they are, and the orientation is injected once.
//
// Why this suite exists: Pi accepts a prompt before session_start has run, so
// without the barrier the first turn of a session finds no graph tools and
// falls back to native reads, which is the one failure this extension exists to
// prevent. The hold leaves no trace in the output, so only a suite driving the
// real lifecycle can show it happening.
//
// Driven through Pi's own ExtensionRunner, so `emit()`'s sequential-await
// semantics, the property the barrier rests on, are the real ones.

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

import { loadFactory } from "./support/subject.ts";
import { createHarness } from "./support/runner.ts";
import type { ContextMessage, Harness } from "./support/runner.ts";
import { control, resetInitializeAttempts } from "./support/child-process-mock.ts";
import { ORIENTATION, TOOLS, delay, options } from "./support/fixtures.ts";

describe("a turn arriving mid-handshake", () => {
  let harness: Harness;
  let held: number;
  let turn1: ContextMessage[];
  let turn2: ContextMessage[];
  let turn3: ContextMessage[];

  before(async () => {
    resetInitializeAttempts();
    control.reset({
      handshakeDelayMs: 300,
      toolsListDelayMs: 300,
      tools: TOOLS,
      hookDecision: { orientation: ORIENTATION },
    });

    harness = await createHarness(await loadFactory(0), options());

    // Nothing awaits this, exactly how Pi reaches before_agent_start at startup.
    const started = harness.sessionStart();

    const t0 = Date.now();
    await harness.turn();
    held = Date.now() - t0;
    await started;

    turn1 = await harness.context();
    turn2 = await harness.context();
    await harness.turn();
    turn3 = await harness.context();
  });

  it("is held for the whole handshake", () => {
    assert.ok(held >= 500, `released after ${held}ms of a 300+300ms handshake`);
  });

  it("finds the tools live at the first LLM call", () => {
    assert.equal(harness.tools().length, 3);
  });

  it("carries the orientation on the first context push", () => {
    assert.equal(turn1.length, 1);
    assert.ok(turn1[0]!.content.includes(ORIENTATION));
  });

  it("injects nothing on a later push", () => {
    assert.equal(turn2.length, 0);
  });

  it("injects nothing on a second before_agent_start", () => {
    assert.equal(turn3.length, 0);
  });

  it("raises no extension errors", () => {
    // Pi's emit() swallows a handler throw into onError, so a broken handler
    // would otherwise leave every assertion above passing.
    assert.deepEqual(harness.errors, []);
  });
});

describe("a prompt submitted in the /reload gap", () => {
  let first: Harness;
  let second: Harness;
  let injected1: ContextMessage[];
  let injected2: ContextMessage[];
  let parkedBeforeSessionStart: boolean;
  let released: boolean;

  before(async () => {
    resetInitializeAttempts();
    control.reset({
      handshakeDelayMs: 150,
      toolsListDelayMs: 0,
      tools: TOOLS,
      hookDecision: { orientation: ORIENTATION },
    });

    first = await createHarness(await loadFactory(1), options());
    await first.sessionStart();
    await first.turn();
    injected1 = await first.context();

    // /reload: the module is re-imported and the new instance exists before
    // its own session_start fires.
    second = await createHarness(await loadFactory(2), options());

    released = false;
    const turn = second.turn().then(() => {
      released = true;
    });

    // Nothing has emitted session_start on the second instance yet, so the
    // turn parks regardless of the handshake latency.
    await delay(100);
    parkedBeforeSessionStart = !released;

    const started = second.sessionStart("reload");
    await turn;
    await started;

    injected2 = await second.context();
  });

  it("injected the orientation for session 1", () => {
    assert.equal(injected1.length, 1);
  });

  it("parks the turn in the gap before session_start", () => {
    assert.ok(parkedBeforeSessionStart, "the turn proceeded before session_start fired");
  });

  it("resumes the turn once session_start lands", () => {
    assert.ok(released);
  });

  it("gives session 2 its own tools", () => {
    assert.equal(second.tools().length, 3);
  });

  it("re-injects the orientation for session 2", () => {
    assert.equal(injected2.length, 1);
    assert.ok(injected2[0]!.content.includes(ORIENTATION));
  });
});

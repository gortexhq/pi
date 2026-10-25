// The readiness barrier: a turn that arrives before session_start has run, or
// before Pi has registered the gortex tools, is held until then, and the
// orientation is injected once, and again only after a compaction drops it.
//
// Why this suite exists: Pi accepts a prompt before session_start has run, so
// without the barrier the first turn of a session finds no graph tools and
// falls back to Pi's own reads, which is the one failure this extension exists to
// prevent. The hold leaves no trace in the output, so only a suite driving the
// real lifecycle can show it happening.
//
// Driven through Pi's own ExtensionRunner, so `emit()`'s sequential-await
// semantics, the property the barrier rests on, are the real ones.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { loadFactory } from "./support/subject.ts";
import type { Factory } from "./support/subject.ts";
import { assertNoRunnerErrors, createHarness } from "./support/runner.ts";
import type { ContextMessage, Harness } from "./support/runner.ts";
import { control } from "./support/hook-mock.ts";
import { ORIENTATION, delay, options, stubTool, withConnectedTools, withMcpConnector } from "./support/fixtures.ts";

after(assertNoRunnerErrors);

/** A session whose gortex tools are already registered, so no turn waits on them. */
async function connected(generation: number, harnessOptions = {}): Promise<Harness> {
  return createHarness(withMcpConnector(withConnectedTools(await loadFactory(generation))), options(), harnessOptions);
}

describe("a turn arriving before Pi registers the gortex tools", () => {
  let harness: Harness;
  let parkedUntilTools: boolean;
  let turn1: ContextMessage[];
  let turn2: ContextMessage[];
  let seenLater: ContextMessage[];

  before(async () => {
    control.reset({ hookDecision: { orientation: ORIENTATION } });
    let api!: ExtensionAPI;
    const capture: Factory = (pi, opts) => {
      api = pi;
      return withMcpConnector(gortex)(pi, opts);
    };
    const gortex = await loadFactory(0);
    harness = await createHarness(capture, options({ toolsReadyWaitMs: 60_000 }));
    await harness.sessionStart();

    let released = false;
    const turn = harness.turn().then(() => {
      released = true;
    });
    // Only the tool appearing can release it: the wait is a minute long.
    await delay(200);
    parkedUntilTools = !released;
    api.registerTool(stubTool("search"));
    await turn;

    turn1 = await harness.context();
    await harness.turn();
    turn2 = await harness.context();
    seenLater = harness.modelContext();
  });

  it("is held until the tools appear", () => {
    assert.ok(parkedUntilTools, "the turn was released before the tools registered");
  });

  it("carries the orientation alone on the first context push", () => {
    assert.deepEqual(turn1, [{ role: "user", content: ORIENTATION }]);
  });

  it("injects nothing on a second before_agent_start", () => {
    assert.equal(turn2.length, 0);
  });

  it("keeps it in front of the model on later LLM calls", () => {
    assert.equal(seenLater.length, 1);
    assert.ok(seenLater[0]!.content.includes(ORIENTATION));
  });

  it("raises no extension errors", () => {
    // Pi's emit() swallows a handler throw into onError, so a broken handler
    // would otherwise leave every assertion above passing.
    assert.deepEqual(harness.errors, []);
  });
});

describe("a session_start that never comes", () => {
  let harness: Harness;
  let turn1: ContextMessage[];
  let turn2: ContextMessage[];

  before(async () => {
    control.reset({ hookDecision: { orientation: ORIENTATION } });
    harness = await createHarness(withMcpConnector(await loadFactory(1)), options({ readyWaitMs: 20 }));
    await harness.turn();
    turn1 = await harness.context();
    await harness.turn();
    turn2 = await harness.context();
  });

  it("releases the turn at the cap and says the tools may not be callable", () => {
    assert.equal(turn1.length, 1);
    assert.match(turn1[0]!.content, /still registering/);
    assert.ok(turn1[0]!.content.includes(ORIENTATION));
  });

  it("says so only once", () => {
    assert.equal(turn2.length, 0);
  });

  // Why: a registration that lands after the turn gave up waiting may never
  // connect, and read discipline would then block Pi's tools with nothing to
  // use instead.
  it("lets Pi's own tools through when session_start lands late and no tools connect", async () => {
    await harness.sessionStart();
    assert.equal(harness.mcpServers().length, 1);
    control.hookDecision = { block: true, reason: "use graph tools" };
    const calls = control.hookCalls.length;
    assert.equal(await harness.toolCall("read", { path: "a.go" }), undefined);
    assert.equal(control.hookCalls.length, calls);
  });

  it("raises no extension errors", () => {
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
    control.reset({ hookDecision: { orientation: ORIENTATION } });

    first = await connected(2);
    await first.sessionStart();
    await first.turn();
    injected1 = await first.context();

    // /reload: the module is re-imported and the new instance exists before
    // its own session_start fires.
    second = await connected(3);

    released = false;
    const turn = second.turn().then(() => {
      released = true;
    });

    // Nothing has emitted session_start on the second instance yet, so the
    // turn parks however long this waits.
    await delay(100);
    parkedBeforeSessionStart = !released;

    await second.sessionStart("reload");
    await turn;

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

  it("registers the server for session 2", () => {
    assert.equal(second.mcpServers().length, 1);
  });

  it("re-injects the orientation for session 2", () => {
    assert.deepEqual(injected2, [{ role: "user", content: ORIENTATION }]);
  });

  it("raises no extension errors", () => {
    assert.deepEqual(first.errors, []);
    assert.deepEqual(second.errors, []);
  });
});

// The hook carries a session_start event, so it must be shelled once per
// session.
describe("a healthy session whose hook returns nothing to inject", () => {
  let harness: Harness;
  let injected: ContextMessage[];

  before(async () => {
    control.reset({ hookDecision: {} });

    harness = await connected(4);
    await harness.sessionStart();
    await harness.turn();
    injected = await harness.context();
    await harness.turn();
    await harness.turn();
  });

  it("injects nothing", () => {
    assert.equal(injected.length, 0);
  });

  it("still shells the hook only once across three turns", () => {
    const calls = control.hookCalls.filter((c) =>
      String(c.input ?? "").includes('"event":"session_start"'),
    );
    assert.equal(calls.length, 1, `shelled ${calls.length}x`);
  });
});

describe("a compaction that summarises the briefing away", () => {
  let harness: Harness;
  let resent: ContextMessage[];
  let afterThat: ContextMessage[];

  before(async () => {
    control.reset({ hookDecision: { orientation: ORIENTATION } });

    harness = await connected(5);
    await harness.sessionStart();
    await harness.turn();
    await harness.context();

    await harness.compact();
    await harness.turn();
    resent = await harness.context();
    await harness.turn();
    afterThat = await harness.context();
  });

  it("sends it again on the next turn", () => {
    assert.equal(resent.length, 1);
    assert.ok(resent[0]!.content.includes(ORIENTATION));
    assert.equal(harness.modelContext().length, 1);
  });

  it("sends it only once", () => {
    assert.equal(afterThat.length, 0);
  });

  it("does not shell the hook again", () => {
    const calls = control.hookCalls.filter((c) => String(c.input ?? "").includes('"event":"session_start"'));
    assert.equal(calls.length, 1);
  });
});

describe("a compaction that keeps the briefing", () => {
  let harness: Harness;
  let injected: ContextMessage[];

  before(async () => {
    control.reset({ hookDecision: { orientation: ORIENTATION } });

    harness = await connected(6);
    await harness.sessionStart();
    await harness.turn();
    await harness.context();
    const briefingEntry = harness.session.getLeafId();

    await harness.compact(briefingEntry);
    await harness.turn();
    injected = await harness.context();
  });

  it("does not send a second copy", () => {
    assert.equal(injected.length, 0);
    assert.equal(harness.modelContext().length, 1);
  });
});

describe("a reloaded session that already holds the briefing", () => {
  let reloaded: Harness;
  let injected: ContextMessage[];

  before(async () => {
    control.reset({ hookDecision: { orientation: ORIENTATION } });

    const first = await connected(7);
    await first.sessionStart();
    await first.turn();
    await first.sessionShutdown("reload");

    reloaded = await connected(8, { session: first.session });
    await reloaded.sessionStart("reload");
    await reloaded.turn();
    injected = await reloaded.context();
  });

  it("does not send a second copy", () => {
    assert.equal(injected.length, 0);
    assert.equal(reloaded.modelContext().length, 1);
  });
});

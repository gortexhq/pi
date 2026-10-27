// Prompt hints: each prompt typed while idle goes to `gortex hook` as the line
// the user typed, and the symbols Gortex finds relevant ride the turn as a
// hidden message.
//
// Why this suite exists: the hints only help if they reach the model once per
// prompt and never disturb what came before. A hint that rewrote or dropped an
// earlier one would invalidate the provider's prompt cache on every turn, and
// expanded skill text would turn Gortex's slash-command skip into a noisy
// search. Neither shows in the TUI, since the message is hidden.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { loadFactory } from "./support/subject.ts";
import { assertNoRunnerErrors } from "./support/runner.ts";
import type { ContextMessage, Harness } from "./support/runner.ts";
import { control } from "./support/hook-mock.ts";
import { CONFIG, ORIENTATION, gortexSession, withConnectedTools } from "./support/fixtures.ts";

after(assertNoRunnerErrors);

const HINTS_A = "## Gortex relevant symbols\n- `login` (function) src/auth.ts:10";
const HINTS_B = "## Gortex relevant symbols\n- `signup` (function) src/auth.ts:40";

function promptEnvelopes(): Record<string, unknown>[] {
  return control.hookCalls
    .map((call) => JSON.parse(call.input ?? "{}") as Record<string, unknown>)
    .filter((envelope) => envelope.event === "prompt");
}

async function connectedSession(): Promise<Harness> {
  const harness = await gortexSession(withConnectedTools(await loadFactory(0)));
  control.hookDecisions = { prompt: { additional_context: HINTS_A } };
  return harness;
}

describe("the first prompt of a session", () => {
  let turn1: ContextMessage[];

  before(async () => {
    const harness = await connectedSession();
    await harness.prompt("where is login handled?");
    turn1 = await harness.context();
  });

  it("carries the briefing and the hints in one message, briefing first", () => {
    assert.deepEqual(turn1, [{ role: "user", content: `${ORIENTATION}\n\n${HINTS_A}` }]);
  });
});

describe("later prompts", () => {
  let harness: Harness;
  let turn2: ContextMessage[];
  let turn3: ContextMessage[];

  before(async () => {
    harness = await connectedSession();
    await harness.prompt("where is login handled?");
    await harness.context();
    await harness.prompt("fix the login redirect");
    turn2 = await harness.context();
    control.hookDecisions = { prompt: { additional_context: HINTS_B } };
    await harness.prompt("and the signup one");
    turn3 = await harness.context();
  });

  it("carry their own hints", () => {
    assert.deepEqual(turn2, [{ role: "user", content: HINTS_A }]);
    assert.deepEqual(turn3, [{ role: "user", content: HINTS_B }]);
  });

  it("only append, leaving every earlier message as it was", () => {
    assert.deepEqual(
      harness.modelContext().map((m) => m.content),
      [`${ORIENTATION}\n\n${HINTS_A}`, HINTS_A, HINTS_B],
    );
  });

  it("send the session id and cwd with the prompt", () => {
    const envelope = promptEnvelopes().at(-1)!;
    assert.equal(envelope.prompt, "and the signup one");
    assert.equal(envelope.cwd, harness.cwd);
    assert.equal(envelope.session_id, harness.session.getSessionId());
  });
});

describe("a skill invocation", () => {
  before(async () => {
    const harness = await connectedSession();
    control.hookCalls = [];
    await harness.prompt("/skill:debug login fails", '<skill name="debug">...</skill>\n\nlogin fails');
  });

  // Gortex skips a prompt starting with `/`, as Claude Code's hook gets it.
  it("goes to Gortex as typed, before expansion", () => {
    assert.deepEqual(promptEnvelopes().map((e) => e.prompt), ["/skill:debug login fails"]);
  });
});

describe("a message typed mid-run", () => {
  let turn: ContextMessage[];

  before(async () => {
    const harness = await connectedSession();
    await harness.prompt("first");
    await harness.context();
    control.hookCalls = [];
    await harness.input("actually, look at signup", "steer");
    await harness.input("then tidy up", "followUp");
    await harness.turn("next");
    turn = await harness.context();
  });

  it("is not sent to Gortex", () => {
    assert.equal(promptEnvelopes().length, 0);
  });

  it("leaves no hints for the next turn to pick up", () => {
    assert.equal(turn.length, 0);
  });
});

describe("a prompt Gortex has nothing for", () => {
  let empty: ContextMessage[];
  let broken: ContextMessage[];

  before(async () => {
    const harness = await connectedSession();
    await harness.prompt("first");
    await harness.context();
    control.hookDecisions = { prompt: {} };
    await harness.prompt("ok");
    empty = await harness.context();
    control.hookOutput = "not json";
    await harness.prompt("where is login handled?");
    broken = await harness.context();
  });

  it("adds no message", () => {
    assert.equal(empty.length, 0);
  });

  it("adds no message when the hook fails", () => {
    assert.equal(broken.length, 0);
  });
});

describe("a session without graph tools", () => {
  let turn2: ContextMessage[];

  before(async () => {
    const harness = await gortexSession(await loadFactory(0), CONFIG, ORIENTATION, false);
    control.hookDecisions = { prompt: { additional_context: HINTS_A } };
    await harness.prompt("first");
    await harness.context();
    control.hookCalls = [];
    await harness.prompt("where is login handled?");
    turn2 = await harness.context();
  });

  // The hints name graph symbols for tools the model cannot call.
  it("asks Gortex for no hints", () => {
    assert.equal(promptEnvelopes().length, 0);
    assert.equal(turn2.length, 0);
  });
});

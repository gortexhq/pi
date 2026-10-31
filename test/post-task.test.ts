// Post-task diagnostics: when a run completes, `gortex hook` gets a stop with
// the agent's last reply, and whatever it finds goes back to the model for one
// more request, shown in the transcript too.
//
// Why this suite exists: Pi has no loop guard for a continuation, so the
// extension is the only thing between a stop that always answers and a run
// that never ends. The diagnostics are also scoped to the files this session
// wrote, which Gortex only learns from forwarded tool calls, so a session with
// enforcement off still has to forward them, and a stop must not outrun them.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { STOP_HOOK_TIMEOUT_MS } from "../src/hook.ts";
import { loadFactory } from "./support/subject.ts";
import { assertNoRunnerErrors } from "./support/runner.ts";
import type { Harness } from "./support/runner.ts";
import { control, gate } from "./support/hook-mock.ts";
import type { HookCall } from "./support/hook-mock.ts";
import { drawMessage } from "./support/draw.ts";
import { CONFIG, gortexSession, withConnectedTools } from "./support/fixtures.ts";

after(assertNoRunnerErrors);

const DIAGNOSTICS = "## Gortex Post-Task Diagnostics\nYour edits this session: 2 symbol(s) across 1 file(s)";
const CLAIM = "[Gortex claim_check] the answer names src/auth.ts:10 without evidence.";
const REPLY = "Fixed the redirect in src/auth.ts.";
const DIAGNOSTICS_MARKDOWN = [
  "## Gortex Post-Task Diagnostics",
  "",
  "**Your edits this session:** 2 symbol(s) across 1 file(s) in `/repo` — risk `HIGH`.",
  "",
  "_Run the tests above and resolve any flagged item in your own changes before handoff._",
].join("\n");

function envelopes(event: string, calls: HookCall[] = control.hookCalls): Record<string, unknown>[] {
  return calls
    .map((call) => JSON.parse(call.input ?? "{}") as Record<string, unknown>)
    .filter((envelope) => envelope.event === event);
}

function postTaskEntries(harness: Harness): { content: unknown; display: boolean; details: unknown }[] {
  return harness.session
    .buildContextEntries()
    .filter((entry) => entry.type === "custom_message" && entry.customType === "gortex-post-task")
    .map((entry) => {
      const { content, display, details } = entry as unknown as { content: unknown; display: boolean; details: unknown };
      return { content, display, details };
    });
}

async function connectedSession(config = CONFIG): Promise<Harness> {
  const harness = await gortexSession(withConnectedTools(await loadFactory(0)), config);
  control.hookDecisions = { stop: { additional_context: DIAGNOSTICS } };
  return harness;
}

/** A prompt the agent answered, ready to settle. */
async function answered(harness: Harness, reply = REPLY): Promise<void> {
  await harness.prompt("fix the login redirect");
  harness.reply(reply);
}

describe("a completed run", () => {
  let harness: Harness;
  let first: { continued: boolean };
  let second: { continued: boolean };

  before(async () => {
    harness = await connectedSession();
    await answered(harness);
    first = await harness.settle();
    harness.reply("Checked the diagnostics, nothing else to change.");
    second = await harness.settle();
  });

  it("sends Gortex a stop with the session, the cwd and the last reply", () => {
    const [stop] = envelopes("stop");
    assert.equal(stop?.last_assistant_message, REPLY);
    assert.equal(stop?.cwd, harness.cwd);
    assert.equal(stop?.session_id, harness.session.getSessionId());
    assert.equal(stop?.stop_hook_active, false);
  });

  it("gives the stop the longer post-task budget", () => {
    const call = control.hookCalls.find((c) => JSON.parse(c.input ?? "{}").event === "stop");
    assert.equal(call?.opts?.timeout, STOP_HOOK_TIMEOUT_MS);
  });

  it("continues with the diagnostics, shown to the user and kept for the model", () => {
    assert.equal(first.continued, true);
    assert.deepEqual(postTaskEntries(harness), [{ content: DIAGNOSTICS, display: true, details: { blocked: false } }]);
    const sent = harness.session.buildSessionContext().messages.at(-2) as { customType?: string };
    assert.equal(sent.customType, "gortex-post-task");
  });

  it("marks the next stop as following its own continuation, and settles there", () => {
    assert.equal(envelopes("stop")[1]?.stop_hook_active, true);
    assert.equal(second.continued, false);
    assert.equal(postTaskEntries(harness).length, 1);
  });
});

describe("a stop Gortex blocks", () => {
  let harness: Harness;
  let settled: { continued: boolean };

  before(async () => {
    harness = await connectedSession();
    control.hookDecisions = { stop: { block: true, reason: CLAIM } };
    await answered(harness, "The handler is at src/auth.ts:10.");
    settled = await harness.settle();
  });

  it("continues with the reason", () => {
    assert.equal(settled.continued, true);
    assert.deepEqual(postTaskEntries(harness), [{ content: CLAIM, display: true, details: { blocked: true } }]);
  });
});

describe("a stop with nothing to report", () => {
  it("settles without a message", async () => {
    const harness = await connectedSession();
    control.hookDecisions = { stop: {} };
    await answered(harness);
    assert.equal((await harness.settle()).continued, false);
    assert.equal(envelopes("stop").length, 1);
    assert.deepEqual(postTaskEntries(harness), []);
  });
});

describe("a run that did not complete", () => {
  for (const outcome of ["aborted", "error"] as const) {
    it(`skips the stop when ${outcome}`, async () => {
      const harness = await connectedSession();
      await answered(harness);
      assert.equal((await harness.settle(outcome)).continued, false);
      assert.deepEqual(envelopes("stop"), []);
    });
  }
});

describe("a prompt after a continuation that never settled", () => {
  it("sends its stop as a fresh one", async () => {
    const harness = await connectedSession();
    await answered(harness);
    await harness.settle();
    // The continuation was aborted, so no settle saw it end.
    await answered(harness);
    await harness.settle();
    assert.deepEqual(envelopes("stop").map((e) => e.stop_hook_active), [false, false]);
  });
});

describe("a session without graph tools", () => {
  it("sends no stop", async () => {
    const harness = await gortexSession(undefined, CONFIG, undefined, false);
    await answered(harness);
    assert.equal((await harness.settle()).continued, false);
    assert.deepEqual(envelopes("stop"), []);
  });
});

describe("tool calls the diagnostics are scoped by", () => {
  it("are forwarded with the session id while enforcing", async () => {
    const harness = await connectedSession();
    await harness.toolCall("edit", { path: "src/auth.ts" });
    const [call] = envelopes("tool_call");
    assert.equal(call?.session_id, harness.session.getSessionId());
    assert.equal(call?.record_only, undefined);
  });

  it("are still forwarded with enforcement off, only to be recorded", async () => {
    const harness = await connectedSession({ ...CONFIG, enforce: false });
    control.hookDecisions = { ...control.hookDecisions, tool_call: { block: true, reason: "would block" } };
    const result = await harness.toolCall("edit", { path: "src/auth.ts" });
    assert.equal(result, undefined);
    const [call] = envelopes("tool_call");
    assert.equal(call?.record_only, true);
    assert.equal(call?.tool_name, "Edit");
    assert.equal((call?.tool_input as { file_path?: string })?.file_path, "src/auth.ts");
  });

  it("are recorded before the stop goes out", async () => {
    const harness = await connectedSession({ ...CONFIG, enforce: false });
    await answered(harness);
    const held = gate();
    control.hookGate = held.promise;
    await harness.toolCall("write", { path: "src/new.ts", content: "x" });
    const settling = harness.settle();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(envelopes("stop"), []);
    held.open();
    await settling;
    assert.equal(envelopes("stop").length, 1);
  });
});

describe("the diagnostics in the transcript", () => {
  let harness: Harness;
  const lines = Array.from({ length: 10 }, (_, i) => `- finding ${i + 1}`);
  const message = (content: string) => ({
    role: "custom" as const,
    customType: "gortex-post-task",
    content,
    display: true,
    details: { blocked: false },
    timestamp: 0,
  });
  const draw = (content: string, expanded = false) =>
    drawMessage(message(content), harness.runner.getMessageRenderer("gortex-post-task"), expanded);

  before(async () => {
    harness = await connectedSession();
  });

  it("shows the first lines under a label until expanded", () => {
    const text = draw(lines.join("\n"));
    assert.match(text, /^Gortex\n\n\S+ finding 1\n/);
    assert.match(text, /finding 6\n+\.\.\. \(4 more lines, 10 total,/);
    assert.doesNotMatch(text, /finding 7/);
  });

  it("renders Gortex's Markdown instead of showing its syntax", () => {
    const text = draw(DIAGNOSTICS_MARKDOWN, true);
    assert.match(text, /Gortex Post-Task Diagnostics/);
    assert.match(text, /Your edits this session: 2 symbol\(s\)/);
    assert.match(text, /Run the tests above/);
    assert.doesNotMatch(text, /##|\*\*|_Run/);
  });

  it("shows everything once expanded", () => {
    const text = draw(lines.join("\n"), true);
    assert.match(text, /- finding 10$/);
    assert.doesNotMatch(text, /more lines/);
  });

  it("strips terminal controls the daemon text carries", () => {
    const text = draw("ok\x1b]0;PWNED\x07 then\x1b[2J done");
    assert.match(text, /ok then done/);
    assert.doesNotMatch(text, /PWNED/);
  });
});

// Version skew: the daemon is older than this extension targets, or answers
// the handshake with a protocol we don't speak.
//
// Why this suite exists: the skew is read off the `initialize` reply, which
// every other suite lets pass unexamined. It is also the one warning aimed at
// the user rather than the model, so it travels through ctx.ui.notify and must
// stay out of the context messages entirely. Nothing else asserts on that
// split.

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

import { loadFactory } from "./support/subject.ts";
import { createHarness } from "./support/runner.ts";
import type { ContextMessage, Harness } from "./support/runner.ts";
import { control, resetInitializeAttempts } from "./support/child-process-mock.ts";
import { MIN_GORTEX_VERSION } from "../src/mcp-client.ts";
import { ORIENTATION, TOOLS, options } from "./support/fixtures.ts";

async function session(overrides: Partial<typeof control>): Promise<Harness> {
  resetInitializeAttempts();
  control.reset({ tools: TOOLS, hookDecision: { orientation: ORIENTATION }, ...overrides });
  const harness = await createHarness(await loadFactory(0), options());
  await harness.sessionStart();
  return harness;
}

describe("a daemon older than the floor", () => {
  let harness: Harness;
  let turn1: ContextMessage[];

  before(async () => {
    harness = await session({ serverVersion: "0.60.0" });
    await harness.turn();
    turn1 = await harness.context();
  });

  it("warns the user through Pi's warning channel", () => {
    assert.equal(harness.notifications.length, 1);
    assert.equal(harness.notifications[0]!.type, "warning");
  });

  it("names the installed version and the floor", () => {
    const { message } = harness.notifications[0]!;
    assert.match(message, /0\.60\.0/);
    assert.ok(message.includes(MIN_GORTEX_VERSION));
  });

  it("names the remedy", () => {
    assert.match(harness.notifications[0]!.message, /gortex upgrade/);
  });

  it("still registers every tool, since the warning is advisory", () => {
    assert.equal(harness.tools().length, TOOLS.length);
  });

  it("tells the model too, without leaking Pi's user-facing copy", () => {
    const combined = turn1.map((m) => m.content).join("\n");
    assert.match(combined, /0\.60\.0/);
    assert.match(combined, /\[Gortex\]/);
  });

  it("reports the skew once, not on every turn", async () => {
    await harness.turn();
    const later = await harness.context();
    assert.equal(later.length, 0);
  });
});

describe("a daemon at or above the floor", () => {
  let harness: Harness;

  before(async () => {
    harness = await session({ serverVersion: "0.64.4" });
    await harness.turn();
  });

  it("says nothing to the user", () => {
    assert.deepEqual(harness.notifications, []);
  });

  it("registers tools as usual", () => {
    assert.equal(harness.tools().length, TOOLS.length);
  });
});

describe("a daemon that withholds serverInfo", () => {
  let harness: Harness;

  before(async () => {
    // Pre-0.61.2 daemons predate the field. An absent version reads as
    // unknown, and the bridge fails open rather than guessing it is stale.
    harness = await session({ serverVersion: null });
    await harness.turn();
  });

  it("does not warn on a version it cannot read", () => {
    assert.deepEqual(harness.notifications, []);
  });
});

describe("a daemon negotiating a different MCP protocol", () => {
  let harness: Harness;
  let turn1: ContextMessage[];

  before(async () => {
    harness = await session({ serverVersion: "0.64.4", protocolVersion: "2024-11-05" });
    await harness.turn();
    turn1 = await harness.context();
  });

  it("warns the user even though the version is current", () => {
    assert.equal(harness.notifications.length, 1);
    assert.equal(harness.notifications[0]!.type, "warning");
    assert.match(harness.notifications[0]!.message, /2024-11-05/);
  });

  it("tells the model a tool call may fail", () => {
    assert.match(turn1.map((m) => m.content).join("\n"), /2024-11-05/);
  });
});

describe("the exact floor version", () => {
  let harness: Harness;

  before(async () => {
    harness = await session({ serverVersion: MIN_GORTEX_VERSION });
    await harness.turn();
  });

  it("is not treated as stale", () => {
    assert.deepEqual(harness.notifications, []);
  });
});

// Tool registration, read back out of Pi's own registry: names that collide
// with Pi's builtins are registered under a `gortex_` alias, and each aliased
// tool explains its own rename in its description: the model never sees the
// bare name it was told to call.
//
// Why this suite exists: Pi lets an extension silently replace a built-in by
// reusing its name, so a missing alias breaks Pi's own rendering and anything
// hooked to that built-in, with no error raised anywhere. The rename also has
// to reach the model, since Gortex's guidance and denial messages name the bare
// tool. Reading the registration back out of Pi's real registry is what shows
// both.

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

import { loadFactory } from "./support/subject.ts";
import { createHarness } from "./support/runner.ts";
import type { Harness } from "./support/runner.ts";
import { control, resetInitializeAttempts } from "./support/child-process-mock.ts";
import { ORIENTATION, TOOLS, options } from "./support/fixtures.ts";

describe("a tool whose name collides with a Pi builtin", () => {
  let harness: Harness;

  before(async () => {
    resetInitializeAttempts();
    control.reset({ tools: TOOLS, hookDecision: { orientation: ORIENTATION } });

    harness = await createHarness(await loadFactory(0), options());
    await harness.sessionStart();
  });

  it("is registered under the alias", () => {
    assert.ok(harness.tool("gortex_read"));
    assert.ok(harness.tool("gortex_edit"));
  });

  it("does not register the bare colliding name", () => {
    assert.equal(harness.tool("read"), undefined);
  });

  it("names both the bare and the aliased name in its description", () => {
    const d = harness.tool("gortex_read")!.description;
    assert.ok(d.includes("`read`"), d);
    assert.ok(d.includes("`gortex_read`"), d);
  });

  it("preserves the original description", () => {
    assert.ok(harness.tool("gortex_read")!.description.includes("Read indexed source."));
  });

  it("calls through the bridge when Pi executes it", async () => {
    const tool = harness.tool("search")!;
    const result = (await tool.execute(
      "call-1",
      {},
      undefined,
      undefined,
      harness.runner.createContext(),
    )) as { content: { type: string; text: string }[] };
    assert.equal(result.content[0]!.text, "ok");
  });
});

describe("a tool whose name does not collide", () => {
  let harness: Harness;

  before(async () => {
    resetInitializeAttempts();
    control.reset({ tools: TOOLS, hookDecision: { orientation: ORIENTATION } });

    harness = await createHarness(await loadFactory(1), options());
    await harness.sessionStart();
  });

  it("keeps its bare name", () => {
    assert.ok(harness.tool("search"));
  });

  it("keeps its description untouched", () => {
    assert.equal(harness.tool("search")!.description, "Search the graph.");
  });
});

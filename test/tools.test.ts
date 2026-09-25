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

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

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

  it("collapses its result until the user expands it", () => {
    const render = harness.tool("search")!.renderResult as unknown as (
      result: unknown,
      options: { expanded: boolean },
    ) => { render(width: number): string[] };
    const result = { content: [{ type: "text", text: "ok" }] };
    assert.equal(render(result, { expanded: false }).render(80).join("").trim(), "");
    assert.equal(render(result, { expanded: true }).render(80).join("").trim(), "ok");
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

// Call rendering: a file read renders like Pi's native read, every other call
// as `<tool> <operation> <subject>` followed by its options. The arguments are
// shaped like the live daemon's. The theme is a stand-in that drops colour, so
// the assertions read the plain text a user would see.

const RENDER_TOOLS = [
  ...TOOLS,
  { name: "trace", description: "Trace paths.", inputSchema: { type: "object", properties: {} } },
  { name: "analyze", description: "Analyze the graph.", inputSchema: { type: "object", properties: {} } },
];

const plainTheme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

describe("a tool call as Pi renders it", () => {
  let harness: Harness;

  before(async () => {
    resetInitializeAttempts();
    control.reset({ tools: RENDER_TOOLS, hookDecision: { orientation: ORIENTATION } });

    harness = await createHarness(await loadFactory(2), options());
    await harness.sessionStart();
  });

  after(() => assert.deepEqual(harness.errors, []));

  function renderCall(tool: string, args: Record<string, unknown>, opts: { expanded?: boolean; width?: number } = {}) {
    const render = harness.tool(tool)!.renderCall as unknown as (
      args: unknown,
      theme: unknown,
      context: unknown,
    ) => { render(width: number): string[] };
    const context = { args, cwd: harness.cwd, expanded: opts.expanded ?? false, lastComponent: undefined };
    return stripTerminalSequences(render(args, plainTheme, context).render(opts.width ?? 200).join("\n")).trim();
  }

  const readFile = (file: string, options?: Record<string, unknown>) => ({
    operation: "file",
    target: { file },
    output: { format: "gcx" },
    ...(options ? { options } : {}),
  });

  it("shows the file a read targets", () => {
    assert.equal(renderCall("gortex_read", readFile("/abs/src/tools.ts")), "gortex read /abs/src/tools.ts");
  });

  it("shows the line range of a windowed read", () => {
    assert.equal(
      renderCall("gortex_read", readFile("/abs/a.ts", { offset: 10, limit: 5 })),
      "gortex read /abs/a.ts:10-14",
    );
  });

  it("shows no range for offsets that are not numbers", () => {
    assert.equal(
      renderCall("gortex_read", readFile("/abs/a.ts", { offset: "10", limit: Infinity })),
      "gortex read /abs/a.ts",
    );
  });

  it("labels a read of a skill definition as a skill", () => {
    const line = renderCall("gortex_read", readFile(join(harness.cwd, "skills", "deploy", "SKILL.md")));
    assert.match(line, /^gortex \[skill\] deploy/);
  });

  it("labels a read of Pi's docs as docs", () => {
    const piRoot = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
    const line = renderCall("gortex_read", readFile(join(piRoot, "docs", "extensions.md")));
    assert.match(line, /^gortex read docs docs\/extensions\.md/);
  });

  it("shows a read of a symbol by its operation and symbol", () => {
    assert.equal(
      renderCall("gortex_read", { operation: "source", target: { symbol: "src/a.ts::f" }, options: { new_user_task: true } }),
      "gortex_read source src/a.ts::f",
    );
  });

  it("shows a search by its operation and query, without its output format", () => {
    assert.equal(
      renderCall("search", { operation: "symbols", query: "callRenderer", output: { format: "gcx" } }),
      "search symbols callRenderer",
    );
  });

  it("puts a search's scope before its other options", () => {
    assert.equal(
      renderCall("search", { operation: "text", query: "x", options: { limit: 5, path: "src/" } }),
      "search text x path=src/ limit=5",
    );
  });

  it("keeps an argument whose value matches the subject", () => {
    assert.equal(
      renderCall("search", { operation: "task", task: "src", path: "src" }),
      "search task src path=src",
    );
  });

  it("shows kind as an argument when an operation is also set", () => {
    assert.equal(renderCall("analyze", { operation: "run", kind: "dead_code" }), "analyze run kind=dead_code");
  });

  it("shows both ends of a trace", () => {
    assert.equal(
      renderCall("trace", { operation: "path", target: { symbol: "a" }, to: { symbol: "b" } }),
      "trace path a to b",
    );
  });

  it("shows an analysis by its kind", () => {
    assert.equal(renderCall("analyze", { kind: "dead_code" }), "analyze dead_code");
  });

  it("keeps a collapsed call on one line cut to the width", () => {
    const line = renderCall("search", { operation: "text", query: "q".repeat(300) }, { width: 40 });
    assert.equal(line.split("\n").length, 1);
    assert.ok(visibleWidth(line) <= 40, line);
  });

  it("shows every value in full once expanded", () => {
    const query = "q".repeat(300);
    const text = renderCall("search", { operation: "text", query }, { expanded: true, width: 80 });
    assert.equal(text.replace(/\s/g, ""), "searchtext" + query);
  });
});

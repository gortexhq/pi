// Result rendering: what a user sees of a Gortex call, drawn through Pi's own
// ToolExecutionComponent. A failed call shows its error without expanding, a
// created file's preview is capped, and daemon text reaches the terminal with
// no control sequences left in it.
//
// Why this suite exists: the component decides what it passes a renderer
// (isError, expanded, lastComponent), so a renderer called by hand with a
// hand-built context passes on assumptions the component does not share. The
// result itself is drawn by Pi's MCP renderer, which Pi does not export; a
// stand-in that echoes the text it receives takes its place, so the suite
// covers what the extension hands it and no more.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { Text } from "@earendil-works/pi-tui";

import { MCP_TOOL_PREFIX } from "../src/mcp.ts";
import { loadFactory } from "./support/subject.ts";
import { assertNoRunnerErrors, createHarness } from "./support/runner.ts";
import type { Harness } from "./support/runner.ts";
import { control } from "./support/hook-mock.ts";
import { draw } from "./support/draw.ts";
import { ORIENTATION, options, withMcpConnector } from "./support/fixtures.ts";

after(assertNoRunnerErrors);

const ESC = "\x1b";
const HOSTILE = `ok${ESC}]0;PWNED-TITLE\x07 then${ESC}[2J${ESC}[H clear\rnext\x9b31m${ESC}P1$r${ESC}\\ bell\x9d0;PWNED\x9c\x07 end`;
const CONTROLS = /\x1b\]|\x1b\[[0-9;]*[JHK]|\x1bP|\x07|\r|[\x90-\x9f]/;

/** The text blocks of a tool result, joined. */
function textOf(result: unknown): string {
  const content = (result as { content?: { type?: string; text?: string }[] })?.content ?? [];
  return content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
}

const numbered = (n: number, line: (i: number) => string) => Array.from({ length: n }, (_, i) => line(i + 1)).join("\n");

describe("a Gortex call on Pi's built-in MCP as Pi draws it", () => {
  const EDIT = `${MCP_TOOL_PREFIX}edit`;
  const SEARCH = `${MCP_TOOL_PREFIX}search`;
  // Stands in for Pi's MCP renderer, echoing the text it is handed.
  const base = { renderResult: (result: unknown) => new Text(textOf(result), 0, 0) };
  let harness: Harness;

  before(async () => {
    control.reset({ hookDecision: { orientation: ORIENTATION } });
    harness = await createHarness(withMcpConnector(await loadFactory(0)), options());
    await harness.sessionStart();
    assert.equal(harness.mcpServers().length, 1, "the session must run on Pi's MCP");
  });

  after(() => assert.deepEqual(harness.errors, []));

  const renderers = (tool: string) => harness.runner.resolveToolRenderers(tool, () => base);

  it("previews a created file until expanded, above Pi's result", () => {
    const diff = numbered(1400, (i) => `+${i} line ${i}`);
    const drawing = draw(EDIT, renderers(EDIT), {}, harness.cwd).result({
      content: [{ type: "text", text: "status: applied" }],
      details: { diffs: [{ path: "src/big.ts", diff, patch: "" }] },
    });
    const collapsed = drawing.text(120);
    assert.match(collapsed, /\.\.\. \(1390 more lines, 1400 total, .*to expand\)$/);
    assert.doesNotMatch(collapsed, /status: applied/);
    const expanded = drawing.expand().text(120);
    assert.match(expanded, /\+\s*1400 line 1400$/m);
    assert.match(expanded, /status: applied$/);
  });

  it("builds a result's diff once and reuses it on every redraw", () => {
    const details = { diffs: [{ path: "src/once.ts", diff: "-1 one\n+1 ONE", patch: "" }] };
    const drawing = draw(EDIT, renderers(EDIT), {}, harness.cwd).result({
      content: [{ type: "text", text: "status: applied" }],
      details,
    });
    assert.match(drawing.text(), /\+\s*1 ONE/);
    details.diffs[0]!.diff = "+1 CHANGED";
    drawing.component.invalidate();
    assert.match(drawing.text(), /\+\s*1 ONE/);
    assert.match(drawing.expand().text(), /\+\s*1 ONE/);
  });

  it("shows an error without expanding", () => {
    const drawing = draw(SEARCH, renderers(SEARCH), {}, harness.cwd).result({
      content: [{ type: "text", text: "symbol not found: Foo" }],
      isError: true,
    });
    assert.match(drawing.text(), /symbol not found: Foo$/);
  });

  it("hands Pi's renderer text stripped of terminal controls", () => {
    const drawing = draw(SEARCH, renderers(SEARCH), {}, harness.cwd).result({ content: [{ type: "text", text: HOSTILE }] });
    assert.doesNotMatch(drawing.expand().rows().join("\n"), CONTROLS);
    assert.match(drawing.text(), /ok then clear\nnext bell end$/);
  });
});

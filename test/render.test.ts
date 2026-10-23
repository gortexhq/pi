// Result rendering: what a user sees of a Gortex call, drawn through Pi's own
// ToolExecutionComponent on both tool channels. A failed call shows its error
// without expanding, every block is capped, and daemon text reaches the
// terminal with no control sequences left in it.
//
// Why this suite exists: the component decides what it passes a renderer
// (isError, expanded, lastComponent), so a renderer called by hand with a
// hand-built context passes on assumptions the component does not share. On
// Pi's built-in MCP the result itself is drawn by Pi's MCP renderer, which Pi
// does not export; a stand-in that echoes the text it receives takes its
// place, so the suite covers what the extension hands it and no more.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Text, visibleWidth } from "@earendil-works/pi-tui";

import { textFromResult } from "../src/mcp-client.ts";
import { MCP_TOOL_PREFIX } from "../src/native.ts";
import { loadFactory } from "./support/subject.ts";
import { createHarness } from "./support/runner.ts";
import type { Harness } from "./support/runner.ts";
import { control, resetInitializeAttempts } from "./support/child-process-mock.ts";
import { draw } from "./support/draw.ts";
import type { ToolResult } from "./support/draw.ts";
import { NATIVE_CONFIG, ORIENTATION, TOOLS, options, withMcpConnector } from "./support/fixtures.ts";

const ESC = "\x1b";
const HOSTILE = `ok${ESC}]0;PWNED-TITLE\x07 then${ESC}[2J${ESC}[H clear\rnext\x9b31m${ESC}P1$r${ESC}\\ bell\x9d0;PWNED\x9c\x07 end`;
const CONTROLS = /\x1b\]|\x1b\[[0-9;]*[JHK]|\x1bP|\x07|\r|[\x90-\x9f]/;

const numbered = (n: number, line: (i: number) => string) => Array.from({ length: n }, (_, i) => line(i + 1)).join("\n");
const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("a bridged Gortex call as Pi draws it", () => {
  let harness: Harness;
  let reply: () => unknown = () => undefined;
  let writes: Record<string, string> = {};

  before(async () => {
    resetInitializeAttempts();
    control.reset({
      tools: TOOLS,
      hookDecision: { orientation: ORIENTATION },
      onToolCall: () => {
        for (const [file, text] of Object.entries(writes)) writeFileSync(join(harness.cwd, file), text);
        return reply();
      },
    });
    harness = await createHarness(await loadFactory(0), options());
    await harness.sessionStart();
    mkdirSync(join(harness.cwd, "src"), { recursive: true });
  });

  after(() => assert.deepEqual(harness.errors, []));

  /** call runs the tool and turns a throw into the error result Pi's agent loop builds. */
  async function call(tool: string, args: Record<string, unknown>, answer: () => unknown = () => undefined, files = {}) {
    reply = answer;
    writes = files;
    try {
      return (await harness.tool(tool)!.execute(
        "call",
        args,
        undefined,
        undefined,
        // Pi 1.0 widens this to ExtensionToolContext; the bridge reads none of it.
        harness.runner.createContext() as never,
      )) as ToolResult;
    } catch (err) {
      return { content: [{ type: "text", text: (err as Error).message }], isError: true };
    } finally {
      reply = () => undefined;
      writes = {};
    }
  }

  async function drawn(tool: string, args: Record<string, unknown>, answer?: () => unknown, files?: Record<string, string>) {
    const result = await call(tool, args, answer, files);
    return { result, drawing: draw(tool, harness.tool(tool), args, harness.cwd).result(result) };
  }

  it("shows a failed call's error without expanding", async () => {
    const { result, drawing } = await drawn("search", { operation: "symbols", query: "Foo" }, () => ({
      isError: true,
      content: [{ type: "text", text: "symbol not found: Foo" }],
    }));
    assert.equal(result.isError, true);
    assert.equal(drawing.text(), "search symbols Foo\nsymbol not found: Foo");
  });

  it("caps a long error until expanded", async () => {
    const { drawing } = await drawn("search", { operation: "symbols", query: "Foo" }, () => ({
      isError: true,
      content: [{ type: "text", text: numbered(50, (i) => `error ${i}`) }],
    }));
    const collapsed = drawing.text();
    assert.match(collapsed, /error 10$/m);
    assert.doesNotMatch(collapsed, /error 11$/m);
    assert.match(collapsed, /\.\.\. \(40 more lines, .*to expand\)$/);
    assert.match(drawing.expand().text(), /error 50$/);
  });

  it("hides a successful reply until expanded", async () => {
    const { drawing } = await drawn("search", { operation: "symbols", query: "x" }, () => ({
      content: [{ type: "text", text: "rows" }],
    }));
    assert.equal(drawing.text(), "search symbols x");
    assert.equal(drawing.expand().text(), "search symbols x\nrows");
  });

  it("previews a created file's first lines until expanded, like Pi's write", async () => {
    const content = numbered(1400, (i) => `line ${i}`) + "\n";
    const args = { operation: "batch", changes: [{ op: "write_file", path: "src/big.ts", content }] };
    const { drawing } = await drawn("gortex_edit", args, undefined, { "src/big.ts": content });
    const collapsed = drawing.text(120);
    assert.match(collapsed, /\+\s*10 line 10$/m);
    assert.doesNotMatch(collapsed, /\+\s*11 line 11$/m);
    assert.match(collapsed, /\.\.\. \(1390 more lines, 1400 total, .*to expand\)$/);
    assert.match(drawing.expand().text(120), /\+\s*1400 line 1400$/m);
  });

  it("shows a changed file's whole diff without expanding, like Pi's edit", async () => {
    const before = numbered(400, (i) => `line ${i}`) + "\n";
    const after = numbered(400, (i) => (i % 2 ? `LINE ${i}` : `line ${i}`)) + "\n";
    writeFileSync(join(harness.cwd, "src/wide.ts"), before);
    const args = { operation: "file", target: { file: "src/wide.ts" } };
    const { drawing } = await drawn("gortex_edit", args, undefined, { "src/wide.ts": after });
    const collapsed = drawing.text(120);
    assert.match(collapsed, /\+\s*399 LINE 399$/m);
    assert.doesNotMatch(collapsed, /more lines/);
  });


  it("builds a result's diff once and reuses it on every redraw", async () => {
    const args = { operation: "file", target: { file: "src/once.ts" } };
    writeFileSync(join(harness.cwd, "src/once.ts"), "one\n");
    const { result, drawing } = await drawn("gortex_edit", args, undefined, { "src/once.ts": "ONE\n" });
    assert.match(drawing.text(), /\+\s*1 ONE/);
    (result.details as { diffs: { diff: string }[] }).diffs[0]!.diff = "+1 CHANGED";
    drawing.component.invalidate();
    assert.match(drawing.text(), /\+\s*1 ONE/);
    assert.match(drawing.expand().text(), /\+\s*1 ONE/);
  });

  it("strips terminal controls from a reply", async () => {
    const { drawing } = await drawn("search", { operation: "symbols", query: "x" }, () => ({
      content: [{ type: "text", text: HOSTILE }],
    }));
    const rows = drawing.expand().rows().join("\n");
    assert.doesNotMatch(rows, CONTROLS);
    assert.match(drawing.text(), /^ok then clear\nnext bell end$/m);
  });

  it("strips terminal controls from an error", async () => {
    const { drawing } = await drawn("search", { operation: "symbols", query: "x" }, () => ({
      isError: true,
      content: [{ type: "text", text: HOSTILE }],
    }));
    assert.doesNotMatch(drawing.rows().join("\n"), CONTROLS);
  });

  it("bounds a huge structured reply once expanded", async () => {
    const rows = Array.from({ length: 20000 }, (_, i) => ({ id: `pkg/f${i}.go::Sym${i}`, kind: "function" }));
    const { drawing } = await drawn("search", { operation: "symbols", query: "Sym" }, () => ({
      content: [],
      structuredContent: { rows },
    }));
    const expanded = drawing.expand().text(120).split("\n");
    assert.ok(expanded.length <= 1003, `${expanded.length} rows`);
    assert.match(expanded.at(-1)!, /^\.\.\. \(\d+ more lines not shown\)$/);
  });

  it("cuts a call-line value on a grapheme boundary", () => {
    const query = "a".repeat(58) + "😀" + "tail";
    const line = draw("search", harness.tool("search"), { operation: "symbols", query }, harness.cwd).text(200);
    assert.doesNotMatch(line, lone);
    assert.ok(line.endsWith("…"), line);
  });

  it("cuts a call-line value to columns, keeping the scope option of a wide subject", () => {
    const args = { operation: "symbols", query: "検索".repeat(40), options: { repo: "gortex" } };
    const line = draw("search", harness.tool("search"), args, harness.cwd).text(100);
    assert.match(line, /… repo=gortex$/);
    assert.ok(visibleWidth(line) <= 98, line);
  });

  it("strips terminal controls from a call-line value", () => {
    const args = { operation: "symbols", query: `x${ESC}]0;PWNED\x07y` };
    const rows = draw("search", harness.tool("search"), args, harness.cwd).rows().join("\n");
    assert.doesNotMatch(rows, CONTROLS);
  });
});

describe("a Gortex call on Pi's built-in MCP as Pi draws it", () => {
  const EDIT = `${MCP_TOOL_PREFIX}edit`;
  const SEARCH = `${MCP_TOOL_PREFIX}search`;
  // Stands in for Pi's MCP renderer, echoing the text it is handed.
  const base = { renderResult: (result: unknown) => new Text(textFromResult(result), 0, 0) };
  let harness: Harness;

  before(async () => {
    control.reset({ hookDecision: { orientation: ORIENTATION } });
    harness = await createHarness(withMcpConnector(await loadFactory(0)), options({ config: NATIVE_CONFIG }));
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

// Edit diffs: a Gortex call that writes files stores a diff of every file it
// changed in the result's details, in Pi's own edit format, and the result
// renders it the way Pi's own edit does. Pi's built-in MCP runs the call, and
// the extension reads the files around it from the tool_call and tool_result
// events.
//
// Why this suite exists: the daemon reports an applied edit without its
// content, so the diff rests on the extension naming the right files from the
// call's arguments before the call runs. The suite writes to disk between the
// two events the way the daemon would, so the assertions read what a user
// would see.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { initTheme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import type { EditDetails } from "../src/diff.ts";
import { MCP_TOOL_PREFIX } from "../src/mcp.ts";
import { loadFactory } from "./support/subject.ts";
import { assertNoRunnerErrors, createHarness } from "./support/runner.ts";
import type { Harness } from "./support/runner.ts";
import { control } from "./support/hook-mock.ts";
import { draw } from "./support/draw.ts";
import { ORIENTATION, options, withMcpConnector } from "./support/fixtures.ts";

after(assertNoRunnerErrors);

/** The note of a result's only file. */
function noteOf(details: EditDetails | undefined): string | undefined {
  assert.equal(details?.diffs?.length, 1, JSON.stringify(details));
  return details!.diffs![0]!.note;
}

describe("a Gortex call that writes files", () => {
  const EDIT = `${MCP_TOOL_PREFIX}edit`;
  let harness: Harness;
  let calls = 0;

  before(async () => {
    initTheme("dark");
    control.reset({ hookDecision: { orientation: ORIENTATION } });
    harness = await createHarness(withMcpConnector(await loadFactory(0)), options());
    await harness.sessionStart();
    assert.equal(harness.mcpServers().length, 1, "the session must run on Pi's MCP");
    mkdirSync(join(harness.cwd, "src"), { recursive: true });
  });

  after(() => assert.deepEqual(harness.errors, []));

  function file(name: string, text: string | Buffer): void {
    writeFileSync(join(harness.cwd, name), text);
  }

  // Pi's MCP runs the call between the two events; the suite writes to disk
  // there the way the daemon would.
  async function start(toolName: string, input: Record<string, unknown>): Promise<string> {
    const toolCallId = `call-${calls++}`;
    await harness.runner.emitToolCall({ type: "tool_call", toolCallId, toolName, input });
    return toolCallId;
  }

  async function result(toolCallId: string, toolName: string, input: Record<string, unknown>, isError = false) {
    return harness.runner.emitToolResult({
      type: "tool_result",
      toolCallId,
      toolName,
      input,
      content: [{ type: "text", text: "status: applied" }],
      details: { server: "gortex", tool: "edit" },
      isError,
    });
  }

  async function finish(toolCallId: string, toolName: string, input: Record<string, unknown>, isError = false) {
    return (await result(toolCallId, toolName, input, isError))?.details as (EditDetails & { server?: string }) | undefined;
  }

  /** Runs `tool` with `input`, applying `changes` to disk as the daemon would. */
  async function run(tool: string, input: Record<string, unknown>, changes: Record<string, string | Buffer>) {
    const id = await start(tool, input);
    for (const [name, text] of Object.entries(changes)) file(name, text);
    return finish(id, tool, input);
  }

  async function edit(path: string, text: string, isError = false) {
    const input = { operation: "file", target: { file: path } };
    const id = await start(EDIT, input);
    file(path, text);
    return finish(id, EDIT, input, isError);
  }

  it("stores the diff in the result's details, beside Pi's own", async () => {
    file("src/a.ts", "one\ntwo\nthree\n");
    const details = await edit("src/a.ts", "one\nTWO\nthree\n");
    assert.equal(details?.server, "gortex");
    const [diff] = details!.diffs!;
    assert.equal(diff!.path, join("src", "a.ts"));
    assert.match(diff!.diff, /^-2 two$/m);
    assert.match(diff!.diff, /^\+2 TWO$/m);
    assert.equal(details!.diff, diff!.diff);
    assert.equal(details?.firstChangedLine, 2);
    assert.match(details!.patch!, /^-two$/m);
    assert.match(details!.patch!, /^\+TWO$/m);
  });

  it("leaves the text the model reads alone", async () => {
    file("src/a.ts", "x\n");
    const input = { operation: "file", target: { file: "src/a.ts" } };
    const id = await start(EDIT, input);
    file("src/a.ts", "y\n");
    const returned = await result(id, EDIT, input);
    assert.ok(returned?.details);
    assert.deepEqual(returned.content, [{ type: "text", text: "status: applied" }]);
  });

  it("leaves a failed call's result alone", async () => {
    file("src/b.ts", "b\n");
    assert.equal(await edit("src/b.ts", "B\n", true), undefined);
  });

  it("leaves a read-only tool's result alone", async () => {
    file("src/f.ts", "f\n");
    assert.equal(await run(`${MCP_TOOL_PREFIX}search`, { path: "src/f.ts" }, { "src/f.ts": "F\n" }), undefined);
  });

  it("finds a symbol's file behind a repo-prefixed id", async () => {
    file("src/b2.ts", "function f() {}\n");
    const details = await run(
      `${MCP_TOOL_PREFIX}edit_symbol`,
      { id: "myrepo/src/b2.ts::f", new_source: "function f() { return 1; }" },
      { "src/b2.ts": "function f() { return 1; }\n" },
    );
    assert.equal(details!.diffs!.length, 1);
    assert.equal(details!.diffs![0]!.path, join("src", "b2.ts"));
  });

  it("diffs every file a batch changes, a new one included", async () => {
    file("src/c2.ts", "c\n");
    const changes = [
      { path: "src/c2.ts", old_string: "c", new_string: "C" },
      { op: "write_file", path: "src/new.ts", content: "fresh\n" },
    ];
    const details = await run(EDIT, { operation: "batch", changes }, { "src/c2.ts": "C\n", "src/new.ts": "fresh\n" });
    const paths = details!.diffs!.map((d) => d.path);
    assert.deepEqual(paths, [join("src", "c2.ts"), join("src", "new.ts")]);
    assert.match(details!.diffs![1]!.diff, /^\+1 fresh$/m);
    assert.equal(details!.diff, undefined, "Pi's diff field holds one file");
    assert.match(details!.patch!, /^\+C$/m);
    assert.match(details!.patch!, /^\+fresh$/m);
  });

  it("reads a legacy batch's edits sent as a JSON string", async () => {
    file("src/g.ts", "g\n");
    const edits = JSON.stringify([{ path: "src/g.ts", old_string: "g", new_string: "G" }]);
    const details = await run(`${MCP_TOOL_PREFIX}batch_edit`, { edits }, { "src/g.ts": "G\n" });
    assert.equal(details!.diffs![0]!.path, join("src", "g.ts"));
  });

  it("ignores line-ending differences", async () => {
    file("src/d2.ts", "a\r\nb\r\n");
    const details = await edit("src/d2.ts", "a\nB\n");
    assert.doesNotMatch(details!.diffs![0]!.diff, /^-1 a$/m);
  });

  it("notes a change of line endings alone", async () => {
    file("src/eol.ts", "a\nb\n");
    const details = await edit("src/eol.ts", "a\r\nb\r\n");
    assert.equal(noteOf(details), "line endings LF -> CRLF");
    assert.equal(details!.diff, undefined);
  });

  it("notes a byte order mark added", async () => {
    file("src/bom.ts", "a\n");
    assert.equal(noteOf(await edit("src/bom.ts", "\ufeffa\n")), "byte order mark added");
  });

  it("notes a file it will not diff, instead of dropping it", async () => {
    file("src/big.txt", "x\n");
    file("src/bin.dat", "a\0b");
    file("src/latin1.txt", Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    assert.equal(noteOf(await edit("src/big.txt", "y\n".repeat(600_000))), "not diffed: over 1 MiB");
    assert.equal(noteOf(await edit("src/bin.dat", "a\0c")), "not diffed: binary file");
    const latin = await run(
      EDIT,
      { operation: "file", target: { file: "src/latin1.txt" } },
      { "src/latin1.txt": Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x21, 0x0a]) },
    );
    assert.equal(noteOf(latin), "not diffed: not UTF-8 text");
  });

  it("notes a change too large to diff without stalling Pi", async () => {
    const lines = (tag: string) => Array.from({ length: 4000 }, (_, i) => `${tag} ${i}`).join("\n");
    file("src/gen.ts", lines("old"));
    assert.equal(noteOf(await edit("src/gen.ts", lines("new"))), "not diffed: change too large to diff quickly");
  });

  it("reads a path written with Windows separators", async () => {
    file("src/win.ts", "w\n");
    const details = await run(EDIT, { operation: "file", target: { file: "src\\win.ts" } }, { "src/win.ts": "W\n" });
    assert.equal(details!.diffs![0]!.path, join("src", "win.ts"));
  });

  it("does not diff a dry run", async () => {
    file("src/e2.ts", "e\n");
    const input = { operation: "file", target: { file: "src/e2.ts" }, options: { dry_run: true } };
    assert.equal(await run(EDIT, input, { "src/e2.ts": "E\n" }), undefined);
  });

  it("does not diff a file two calls in flight both write", async () => {
    file("src/c.ts", "c\n");
    const gortexInput = { operation: "file", target: { file: "src/c.ts" } };
    const piInput = { path: "src/c.ts", edits: [] };
    const gortexId = await start(EDIT, gortexInput);
    const piId = await start("edit", piInput);
    file("src/c.ts", "C\n");
    await finish(piId, "edit", piInput);
    assert.equal(await finish(gortexId, EDIT, gortexInput), undefined);
  });

  it("still diffs a file whose other writer was blocked before it ran", async () => {
    file("src/d.ts", "d\n");
    const input = { operation: "file", target: { file: "src/d.ts" } };
    const blocked = await start(EDIT, input);
    const id = await start(EDIT, input);
    // Pi ends a blocked call without a tool_result.
    await harness.runner.emit({ type: "tool_execution_end", toolCallId: blocked, toolName: EDIT, result: {}, isError: true } as never);
    file("src/d.ts", "D\n");
    const details = await finish(id, EDIT, input);
    assert.match(details!.diff!, /^\+1 D$/m);
  });

  it("notes a diff a concurrent shell command could have touched", async () => {
    file("src/e.ts", "e\n");
    const input = { operation: "file", target: { file: "src/e.ts" } };
    const id = await start(EDIT, input);
    const shell = await start("bash", { command: "echo" });
    file("src/e.ts", "E\n");
    assert.equal(noteOf(await finish(id, EDIT, input)), "not diffed: a shell command ran at the same time");
    await harness.runner.emit({ type: "tool_execution_end", toolCallId: shell, toolName: "bash", result: {}, isError: false } as never);
  });

  it("draws a note in place of a diff", () => {
    const renderers = harness.runner.resolveToolRenderers(EDIT, () => ({ renderResult: () => new Text("", 0, 0) }));
    const drawing = draw(EDIT, renderers, {}, harness.cwd).result({
      content: [{ type: "text", text: "status: applied" }],
      details: { diffs: [{ path: "src/a.ts", diff: "", patch: "", note: "line endings LF -> CRLF" }] },
    });
    assert.match(drawing.text(), /src\/a\.ts line endings LF -> CRLF/);
  });

  it("draws the diff above Pi's result, which shows once expanded", () => {
    const base = {
      renderResult: () => new Text("PI-MCP-OUTPUT", 0, 0),
    };
    const drawing = draw(EDIT, harness.runner.resolveToolRenderers(EDIT, () => base), {}, harness.cwd).result({
      content: [{ type: "text", text: "status: applied" }],
      details: { diffs: [{ path: "src/a.ts", diff: "-2 two\n+2 TWO", patch: "" }] },
    });
    assert.match(drawing.text(), /\+2 TWO/);
    assert.doesNotMatch(drawing.text(), /PI-MCP-OUTPUT/);
    assert.match(drawing.expand().text(), /PI-MCP-OUTPUT/);
    assert.equal(harness.runner.resolveToolRenderers("bash", () => base), base);
    assert.equal(harness.runner.resolveToolRenderers(EDIT, () => undefined), undefined, "Pi's MCP fallback must stay reachable");
  });

  it("hides Pi's result preview until expanded, except for an error", () => {
    const base = {
      renderResult: () => new Text("PI-MCP-OUTPUT", 0, 0),
    };
    const renderers = harness.runner.resolveToolRenderers(`${MCP_TOOL_PREFIX}search`, () => base);
    const view = (expanded: boolean, isError = false) =>
      draw(`${MCP_TOOL_PREFIX}search`, renderers, {}, harness.cwd)
        .result({ content: [{ type: "text", text: "rows" }], isError })
        .expand(expanded)
        .text();
    assert.doesNotMatch(view(false), /PI-MCP-OUTPUT/);
    assert.match(view(true), /PI-MCP-OUTPUT/);
    assert.match(view(false, true), /PI-MCP-OUTPUT/);
  });
});

// Gortex names files from the repo root, and Pi may run from anywhere under it.
describe("a Gortex edit while Pi runs in a subdirectory of the repo", () => {
  const input = { operation: "file", target: { file: "repo/app/src/a.ts" } };
  let harness: Harness;

  before(async () => {
    control.reset({ hookDecision: { orientation: ORIENTATION } });
    harness = await createHarness(withMcpConnector(await loadFactory(1)), options(), { repoSubdir: "app" });
    await harness.sessionStart();
    mkdirSync(join(harness.cwd, "src"), { recursive: true });
    writeFileSync(join(harness.cwd, "src", "a.ts"), "one\ntwo\n");
  });

  it("diffs the file", async () => {
    const EDIT = `${MCP_TOOL_PREFIX}edit`;
    await harness.runner.emitToolCall({ type: "tool_call", toolCallId: "sub-1", toolName: EDIT, input });
    writeFileSync(join(harness.cwd, "src", "a.ts"), "one\nTWO\n");
    const result = await harness.runner.emitToolResult({
      type: "tool_result",
      toolCallId: "sub-1",
      toolName: EDIT,
      input,
      content: [{ type: "text", text: "status: applied" }],
      details: {},
      isError: false,
    });
    const details = result?.details as EditDetails | undefined;
    assert.equal(details?.diffs![0]!.path, join("src", "a.ts"));
    assert.match(details!.diff!, /^\+2 TWO$/m);
  });
});

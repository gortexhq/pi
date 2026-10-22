// Edit diffs: a Gortex call that writes files stores a diff of every file it
// changed in the result's details, in Pi's own edit format, and the result
// renders it the way Pi's own edit does. Covered on both tool channels: the
// extension's own client, and Pi's built-in MCP, where Pi runs the call and the
// extension reads the files around it from the tool_call and tool_result events.
//
// Why this suite exists: the daemon reports an applied edit without its
// content, so the diff rests on the bridge naming the right files from the
// call's arguments before the call runs. The double writes to disk the way the
// daemon would, so the assertions read what a user would see.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { initTheme } from "@earendil-works/pi-coding-agent";
import { Text, stripTerminalSequences } from "@earendil-works/pi-tui";

import type { EditDetails } from "../src/diff.ts";
import { MCP_TOOL_PREFIX } from "../src/native.ts";
import type { Factory } from "./support/subject.ts";
import { loadFactory } from "./support/subject.ts";
import { createHarness } from "./support/runner.ts";
import type { Harness } from "./support/runner.ts";
import { control, resetInitializeAttempts } from "./support/child-process-mock.ts";
import { NATIVE_CONFIG, ORIENTATION, options, withMcpConnector } from "./support/fixtures.ts";

const schema = { type: "object", properties: {} };
const TOOLS = [
  { name: "edit", description: "Apply guarded edits.", inputSchema: schema },
  { name: "edit_symbol", description: "Edit a symbol.", inputSchema: schema },
  { name: "batch_edit", description: "Apply a batch.", inputSchema: schema },
  { name: "search", description: "Search the graph.", inputSchema: schema },
];

const plainTheme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

/** The note of a result's only file. */
function noteOf(details: EditDetails | undefined): string | undefined {
  assert.equal(details?.diffs?.length, 1, JSON.stringify(details));
  return details!.diffs![0]!.note;
}

interface Result {
  content: { type: string; text: string }[];
  details: EditDetails;
}

describe("a Gortex call that writes files", () => {
  let harness: Harness;
  let writes: Record<string, string | Buffer>;

  before(async () => {
    initTheme("dark");
    resetInitializeAttempts();
    control.reset({
      tools: TOOLS,
      hookDecision: { orientation: ORIENTATION },
      onToolCall: (name) => {
        if (name === "search") return undefined;
        for (const [file, text] of Object.entries(writes)) writeFileSync(join(harness.cwd, file), text);
        return undefined;
      },
    });
    harness = await createHarness(await loadFactory(0), options());
    await harness.sessionStart();
    mkdirSync(join(harness.cwd, "src"), { recursive: true });
  });

  after(() => assert.deepEqual(harness.errors, []));

  async function run(tool: string, args: Record<string, unknown>, changes: Record<string, string | Buffer>) {
    writes = changes;
    return (await harness.tool(tool)!.execute(
      "call",
      args as never,
      undefined,
      undefined,
      harness.runner.createContext() as never,
    )) as Result;
  }

  function file(name: string, text: string): void {
    writeFileSync(join(harness.cwd, name), text);
  }

  it("diffs the file an edit targets", async () => {
    file("src/a.ts", "one\ntwo\nthree\n");
    const result = await run(
      "gortex_edit",
      { operation: "file", target: { file: "src/a.ts" }, arguments: { match: "two", replacement: "TWO" } },
      { "src/a.ts": "one\nTWO\nthree\n" },
    );
    const [diff] = result.details.diffs!;
    assert.equal(diff!.path, join("src", "a.ts"));
    assert.match(diff!.diff, /^-2 two$/m);
    assert.match(diff!.diff, /^\+2 TWO$/m);
    assert.equal(diff!.firstChangedLine, 2);
  });

  it("fills Pi's edit details for a single file", async () => {
    file("src/a.ts", "one\n");
    const result = await run("gortex_edit", { operation: "file", target: { file: "src/a.ts" } }, { "src/a.ts": "ONE\n" });
    const { diffs, diff, patch, firstChangedLine } = result.details;
    assert.equal(diff, diffs![0]!.diff);
    assert.equal(firstChangedLine, 1);
    assert.match(patch!, /^-one$/m);
    assert.match(patch!, /^\+ONE$/m);
  });

  it("keeps Gortex's reply as the text the model reads", async () => {
    file("src/a.ts", "x\n");
    const result = await run("gortex_edit", { operation: "file", target: { file: "src/a.ts" } }, { "src/a.ts": "y\n" });
    assert.equal(result.content[0]!.text, "ok");
  });

  it("finds a symbol's file behind a repo-prefixed id", async () => {
    file("src/b.ts", "function f() {}\n");
    const result = await run(
      "edit_symbol",
      { id: "myrepo/src/b.ts::f", new_source: "function f() { return 1; }" },
      { "src/b.ts": "function f() { return 1; }\n" },
    );
    assert.equal(result.details.diffs!.length, 1);
    assert.equal(result.details.diffs![0]!.path, join("src", "b.ts"));
  });

  it("diffs every file a batch changes, a new one included", async () => {
    file("src/c.ts", "c\n");
    const changes = [
      { path: "src/c.ts", old_string: "c", new_string: "C" },
      { op: "write_file", path: "src/new.ts", content: "fresh\n" },
    ];
    const result = await run(
      "gortex_edit",
      { operation: "batch", changes },
      { "src/c.ts": "C\n", "src/new.ts": "fresh\n" },
    );
    const paths = result.details.diffs!.map((d) => d.path);
    assert.deepEqual(paths, [join("src", "c.ts"), join("src", "new.ts")]);
    assert.match(result.details.diffs![1]!.diff, /^\+1 fresh$/m);
    assert.equal(result.details.diff, undefined, "Pi's diff field holds one file");
    assert.match(result.details.patch!, /^\+C$/m);
    assert.match(result.details.patch!, /^\+fresh$/m);
  });

  it("reads a legacy batch's edits sent as a JSON string", async () => {
    file("src/g.ts", "g\n");
    const edits = JSON.stringify([{ path: "src/g.ts", old_string: "g", new_string: "G" }]);
    const result = await run("batch_edit", { edits }, { "src/g.ts": "G\n" });
    assert.equal(result.details.diffs![0]!.path, join("src", "g.ts"));
  });

  it("ignores line-ending differences", async () => {
    file("src/d.ts", "a\r\nb\r\n");
    const result = await run(
      "gortex_edit",
      { operation: "file", target: { file: "src/d.ts" } },
      { "src/d.ts": "a\nB\n" },
    );
    assert.doesNotMatch(result.details.diffs![0]!.diff, /^-1 a$/m);
  });

  it("notes a change of line endings alone", async () => {
    file("src/eol.ts", "a\nb\n");
    const result = await run("gortex_edit", { operation: "file", target: { file: "src/eol.ts" } }, { "src/eol.ts": "a\r\nb\r\n" });
    assert.deepEqual(noteOf(result.details), "line endings LF -> CRLF");
    assert.equal(result.details.diff, undefined);
  });

  it("notes a byte order mark added", async () => {
    file("src/bom.ts", "a\n");
    const result = await run("gortex_edit", { operation: "file", target: { file: "src/bom.ts" } }, { "src/bom.ts": "﻿a\n" });
    assert.equal(noteOf(result.details), "byte order mark added");
  });

  it("notes a file it will not diff, instead of dropping it", async () => {
    file("src/big.txt", "x\n");
    file("src/bin.dat", "a\0b");
    writeFileSync(join(harness.cwd, "src/latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    const big = await run("gortex_edit", { operation: "file", target: { file: "src/big.txt" } }, { "src/big.txt": "y\n".repeat(600_000) });
    assert.equal(noteOf(big.details), "not diffed: over 1 MiB");
    const bin = await run("gortex_edit", { operation: "file", target: { file: "src/bin.dat" } }, { "src/bin.dat": "a\0c" });
    assert.equal(noteOf(bin.details), "not diffed: binary file");
    const latin = await run(
      "gortex_edit",
      { operation: "file", target: { file: "src/latin1.txt" } },
      { "src/latin1.txt": Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x21, 0x0a]) },
    );
    assert.equal(noteOf(latin.details), "not diffed: not UTF-8 text");
  });

  it("notes a change too large to diff without stalling Pi", async () => {
    const lines = (tag: string) => Array.from({ length: 4000 }, (_, i) => `${tag} ${i}`).join("\n");
    file("src/gen.ts", lines("old"));
    const result = await run("gortex_edit", { operation: "file", target: { file: "src/gen.ts" } }, { "src/gen.ts": lines("new") });
    assert.equal(noteOf(result.details), "not diffed: change too large to diff quickly");
  });

  it("reads a path written with Windows separators", async () => {
    file("src/win.ts", "w\n");
    const result = await run("gortex_edit", { operation: "file", target: { file: "src\\win.ts" } }, { "src/win.ts": "W\n" });
    assert.equal(result.details.diffs![0]!.path, join("src", "win.ts"));
  });

  it("notes a diff a concurrent shell command could have touched", async () => {
    file("src/sh.ts", "s\n");
    await harness.runner.emitToolCall({ type: "tool_call", toolCallId: "bash-1", toolName: "bash", input: { command: "echo" } });
    const during = await run("gortex_edit", { operation: "file", target: { file: "src/sh.ts" } }, { "src/sh.ts": "S\n" });
    assert.equal(noteOf(during.details), "not diffed: a shell command ran at the same time");
    await harness.runner.emit({ type: "tool_execution_end", toolCallId: "bash-1", toolName: "bash", result: {}, isError: false } as never);
    const after = await run("gortex_edit", { operation: "file", target: { file: "src/sh.ts" } }, { "src/sh.ts": "s2\n" });
    assert.match(after.details.diff!, /^\+1 s2$/m);
  });

  it("does not diff a dry run", async () => {
    file("src/e.ts", "e\n");
    const result = await run(
      "gortex_edit",
      { operation: "file", target: { file: "src/e.ts" }, options: { dry_run: true } },
      { "src/e.ts": "E\n" },
    );
    assert.deepEqual(result.details, {});
  });

  it("does not diff a read-only tool", async () => {
    file("src/f.ts", "f\n");
    const result = await run("search", { path: "src/f.ts" }, {});
    assert.deepEqual(result.details, {});
    assert.equal(readFileSync(join(harness.cwd, "src/f.ts"), "utf8"), "f\n");
  });

  it("renders the diff without expanding, and the reply once expanded", () => {
    const render = harness.tool("gortex_edit")!.renderResult as unknown as (
      result: unknown,
      options: { expanded: boolean },
      theme: unknown,
      context: unknown,
    ) => { render(width: number): string[] };
    const result = {
      content: [{ type: "text", text: "status: applied" }],
      details: { diffs: [{ path: "src/a.ts", diff: "-2 two\n+2 TWO", patch: "" }] },
    };
    const context = { cwd: harness.cwd, isError: false };
    const view = (expanded: boolean) =>
      stripTerminalSequences(render(result, { expanded }, plainTheme, context).render(80).join("\n"));
    assert.match(view(false), /-2 two/);
    assert.match(view(false), /\+2 TWO/);
    assert.doesNotMatch(view(false), /status: applied/);
    assert.match(view(true), /status: applied/);
  });
});

describe("a Gortex call that writes files on Pi's built-in MCP", () => {
  const EDIT = `${MCP_TOOL_PREFIX}edit`;
  let harness: Harness;
  let calls = 0;

  before(async () => {
    initTheme("dark");
    control.reset({ hookDecision: { orientation: ORIENTATION } });
    harness = await createHarness(withMcpConnector(await loadFactory(0)), options({ config: NATIVE_CONFIG }));
    await harness.sessionStart();
    assert.equal(harness.mcpServers().length, 1, "the session must run on Pi's MCP");
    mkdirSync(join(harness.cwd, "src"), { recursive: true });
  });

  after(() => assert.deepEqual(harness.errors, []));

  function file(name: string, text: string): void {
    writeFileSync(join(harness.cwd, name), text);
  }

  // Pi's MCP runs the call between the two events; the suite writes to disk
  // there the way the daemon would.
  async function start(toolName: string, input: Record<string, unknown>): Promise<string> {
    const toolCallId = `call-${calls++}`;
    await harness.runner.emitToolCall({ type: "tool_call", toolCallId, toolName, input });
    return toolCallId;
  }

  async function finish(toolCallId: string, toolName: string, input: Record<string, unknown>, isError = false) {
    const result = await harness.runner.emitToolResult({
      type: "tool_result",
      toolCallId,
      toolName,
      input,
      content: [{ type: "text", text: "status: applied" }],
      details: { server: "gortex", tool: "edit" },
      isError,
    });
    return result?.details as (EditDetails & { server?: string }) | undefined;
  }

  async function edit(path: string, text: string, isError = false) {
    const input = { operation: "file", target: { file: path } };
    const id = await start(EDIT, input);
    file(path, text);
    return finish(id, EDIT, input, isError);
  }

  it("stores the diff in the result's details, beside Pi's own", async () => {
    file("src/a.ts", "one\ntwo\n");
    const details = await edit("src/a.ts", "one\nTWO\n");
    assert.equal(details?.server, "gortex");
    assert.equal(details?.diffs![0]!.path, join("src", "a.ts"));
    assert.match(details!.diff!, /^\+2 TWO$/m);
    assert.equal(details?.firstChangedLine, 2);
    assert.match(details!.patch!, /^\+TWO$/m);
  });

  it("leaves a failed call's result alone", async () => {
    file("src/b.ts", "b\n");
    assert.equal(await edit("src/b.ts", "B\n", true), undefined);
  });

  it("leaves a read-only tool's result alone", async () => {
    const input = { query: "x" };
    const id = await start(`${MCP_TOOL_PREFIX}search`, input);
    assert.equal(await finish(id, `${MCP_TOOL_PREFIX}search`, input), undefined);
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
    const renderers = harness.runner.resolveToolRenderers(EDIT, () => ({ renderResult: () => new Text("", 0, 0) }) as never)!;
    const result = {
      content: [{ type: "text", text: "status: applied" }],
      details: { diffs: [{ path: "src/a.ts", diff: "", patch: "", note: "line endings LF -> CRLF" }] },
    };
    const view = stripTerminalSequences(
      renderers.renderResult!(result as never, { expanded: false, isPartial: false }, plainTheme as never, { cwd: harness.cwd, isError: false } as never)
        .render(80)
        .join("\n"),
    );
    assert.match(view, /src\/a\.ts line endings LF -> CRLF/);
  });

  it("draws the diff above Pi's result, which shows once expanded", () => {
    const base = {
      renderResult: () => new Text("PI-MCP-OUTPUT", 0, 0),
    };
    const renderers = harness.runner.resolveToolRenderers(EDIT, () => base as never)!;
    const result = {
      content: [{ type: "text", text: "status: applied" }],
      details: { diffs: [{ path: "src/a.ts", diff: "-2 two\n+2 TWO", patch: "" }] },
    };
    const view = (expanded: boolean) =>
      stripTerminalSequences(
        renderers.renderResult!(result as never, { expanded, isPartial: false }, plainTheme as never, { cwd: harness.cwd, isError: false } as never)
          .render(80)
          .join("\n"),
      );
    assert.match(view(false), /\+2 TWO/);
    assert.doesNotMatch(view(false), /PI-MCP-OUTPUT/);
    assert.match(view(true), /PI-MCP-OUTPUT/);
    assert.equal(harness.runner.resolveToolRenderers("bash", () => base as never), base);
    assert.equal(harness.runner.resolveToolRenderers(EDIT, () => undefined), undefined, "Pi's MCP fallback must stay reachable");
  });

  it("hides Pi's result preview until expanded, except for an error", () => {
    const base = {
      renderResult: () => new Text("PI-MCP-OUTPUT", 0, 0),
    };
    const renderers = harness.runner.resolveToolRenderers(`${MCP_TOOL_PREFIX}search`, () => base as never)!;
    const result = { content: [{ type: "text", text: "rows" }] };
    const view = (expanded: boolean, isError = false) =>
      stripTerminalSequences(
        renderers.renderResult!(result as never, { expanded, isPartial: false }, plainTheme as never, { cwd: harness.cwd, isError } as never)
          .render(80)
          .join("\n"),
      );
    assert.equal(view(false).trim(), "");
    assert.match(view(true), /PI-MCP-OUTPUT/);
    assert.match(view(false, true), /PI-MCP-OUTPUT/);
  });
});

// Gortex names files from the repo root, and Pi may run from anywhere under it.
describe("a Gortex edit while Pi runs in a subdirectory of the repo", () => {
  const input = { operation: "file", target: { file: "repo/app/src/a.ts" } };
  let bridged: Harness;
  let native: Harness;

  before(async () => {
    initTheme("dark");
    resetInitializeAttempts();
    control.reset({
      tools: TOOLS,
      hookDecision: { orientation: ORIENTATION },
      onToolCall: () => {
        writeFileSync(join(bridged.cwd, "src", "a.ts"), "one\nTWO\n");
        return undefined;
      },
    });
    bridged = await createHarness(await loadFactory(0), options(), { repoSubdir: "app" });
    await bridged.sessionStart();
    native = await createHarness(withMcpConnector(await loadFactory(1)), options({ config: NATIVE_CONFIG }), {
      repoSubdir: "app",
    });
    await native.sessionStart();
    for (const h of [bridged, native]) {
      mkdirSync(join(h.cwd, "src"), { recursive: true });
      writeFileSync(join(h.cwd, "src", "a.ts"), "one\ntwo\n");
    }
  });

  it("diffs the file on the extension's own client", async () => {
    const result = (await bridged.tool("gortex_edit")!.execute(
      "call",
      input as never,
      undefined,
      undefined,
      bridged.runner.createContext() as never,
    )) as Result;
    assert.equal(result.details.diffs![0]!.path, join("src", "a.ts"));
    assert.match(result.details.diff!, /^\+2 TWO$/m);
  });

  it("diffs the file on Pi's built-in MCP", async () => {
    const EDIT = `${MCP_TOOL_PREFIX}edit`;
    await native.runner.emitToolCall({ type: "tool_call", toolCallId: "sub-1", toolName: EDIT, input });
    writeFileSync(join(native.cwd, "src", "a.ts"), "one\nTWO\n");
    const result = await native.runner.emitToolResult({
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
  });
});

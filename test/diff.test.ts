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
import { NATIVE_CONFIG, ORIENTATION, options } from "./support/fixtures.ts";

const schema = { type: "object", properties: {} };
const TOOLS = [
  { name: "edit", description: "Apply guarded edits.", inputSchema: schema },
  { name: "edit_symbol", description: "Edit a symbol.", inputSchema: schema },
  { name: "batch_edit", description: "Apply a batch.", inputSchema: schema },
  { name: "search", description: "Search the graph.", inputSchema: schema },
];

const plainTheme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

interface Result {
  content: { type: string; text: string }[];
  details: EditDetails;
}

describe("a Gortex call that writes files", () => {
  let harness: Harness;
  let writes: Record<string, string>;

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

  async function run(tool: string, args: Record<string, unknown>, changes: Record<string, string>) {
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

/** Stands in for the extension Pi uses to connect MCP servers. */
function withMcpConnector(gortex: Factory): Factory {
  return (pi, opts) => {
    pi.registerCommand("mcp", { description: "Manage MCP servers", handler: async () => {} });
    gortex(pi, opts);
  };
}

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
});

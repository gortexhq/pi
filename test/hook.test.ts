// The hook bridge: how a tool call reaches `gortex hook` and how its decision
// comes back.
//
// Why this suite exists: the hook runs once per tool call, inside Pi's TUI.
// A synchronous call froze the TUI and Esc for as long as the hook took, the
// child's stderr was painted into the editor, a `null` reply blocked the call
// it should have let through, and soft guidance reached the model as a
// separate steer, one model request per advised call. The real seam is run
// against `node` children here, so no gortex binary is needed.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assertNoRunnerErrors } from "./support/runner.ts";
import type { Harness } from "./support/runner.ts";
import { control, gate } from "./support/hook-mock.ts";
import { delay, exits, gortexSession, pidFrom } from "./support/fixtures.ts";

import { callHook, normalizeToolCall, toolNameMap } from "../src/hook.ts";
import { nodeProcessDeps } from "../src/runtime.ts";
import type { ProcessDeps } from "../src/runtime.ts";

after(assertNoRunnerErrors);

const ROOT = mkdtempSync(path.join(tmpdir(), "pi-gortex-hook-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const RUNTIME_TS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "runtime.ts");
const ENVELOPE = { event: "tool_call", tool_name: "Bash" };

/** argv for a hook that runs `script` under this node. */
const nodeHook = (script: string): string[] => [process.execPath, "-e", script];

function lastEnvelope(): Record<string, unknown> {
  const call = control.hookCalls.at(-1);
  assert.ok(call, "no hook call recorded");
  return JSON.parse(call.input ?? "{}") as Record<string, unknown>;
}

describe("tool-call normalization", () => {
  it("maps every Pi built-in to the canonical name", () => {
    for (const [pi, canonical] of Object.entries(toolNameMap)) {
      assert.equal(normalizeToolCall(pi, {}).tool_name, canonical, pi);
    }
  });

  it("sends Pi's powershell to the shell classifier", () => {
    assert.deepEqual(normalizeToolCall("powershell", { command: "cat a.go" }), {
      tool_name: "Bash",
      tool_input: { command: "cat a.go" },
    });
  });

  it("keeps a tool it does not know under its own name", () => {
    assert.equal(normalizeToolCall("mcp__docs__read", {}).tool_name, "mcp__docs__read");
  });

  const keys: [string, Record<string, unknown>, Record<string, unknown>][] = [
    ["read", { path: "a.go" }, { file_path: "a.go" }],
    ["read", { absolute_path: "/r/a.go" }, { file_path: "/r/a.go" }],
    ["grep", { regex: "x" }, { pattern: "x" }],
    ["find", { glob: "*.go" }, { pattern: "*.go" }],
    ["ls", { path: "src" }, { file_path: "src", pattern: "src" }],
    ["bash", { cmd: "ls" }, { command: "ls" }],
    ["bash", { command: "", script: "ls" }, { command: "ls" }],
  ];
  for (const [tool, input, added] of keys) {
    it(`reads ${tool} ${JSON.stringify(input)} under the canonical keys`, () => {
      assert.deepEqual(normalizeToolCall(tool, input).tool_input, { ...input, ...added });
    });
  }
});

describe("a hook reply that is not a decision", () => {
  const replies: [string, () => Promise<string>][] = [
    ["null", async () => "null"],
    ["an array", async () => "[]"],
    ["a number", async () => "42"],
    ["a string", async () => '"block"'],
    ["empty output", async () => "\n"],
    ["output that is not JSON", async () => "Error: unknown flag --agent"],
    ["a rejection", async () => Promise.reject(new Error("exit 1"))],
  ];
  for (const [name, execFile] of replies) {
    it(`fails open on ${name}`, async () => {
      assert.deepEqual(await callHook(["gortex", "hook"], { execFile }, ENVELOPE), {});
    });
  }

  it("passes a decision object through", async () => {
    const deps: ProcessDeps = { execFile: async () => '{"block":true,"reason":"r"}\n' };
    assert.deepEqual(await callHook(["gortex", "hook"], deps, ENVELOPE), { block: true, reason: "r" });
  });
});

describe("the hook through the real process seam", () => {
  it("writes the envelope to the hook's stdin", async () => {
    const echo = nodeHook("process.stdin.pipe(process.stdout)");
    assert.deepEqual(await callHook(echo, nodeProcessDeps, ENVELOPE), ENVELOPE);
  });

  it("fails open on a hook that exits non-zero", async () => {
    assert.deepEqual(await callHook(nodeHook("process.stdout.write('{\"block\":true}');process.exit(1)"), nodeProcessDeps, ENVELOPE), {});
  });

  it("fails open on a binary that is not there", async () => {
    assert.deepEqual(await callHook([path.join(ROOT, "missing-gortex"), "hook"], nodeProcessDeps, ENVELOPE), {});
  });

  it("rejects a hook that outlives its timeout", async () => {
    const [bin, ...args] = nodeHook("setTimeout(() => {}, 60000)");
    await assert.rejects(nodeProcessDeps.execFile(bin!, args, { timeout: 50 }));
  });

  // Run in a child, since whatever reaches this process's stderr would be the TUI's.
  it("keeps the hook's stderr off the host's", () => {
    const script =
      `import { nodeProcessDeps } from ${JSON.stringify(pathToFileURL(RUNTIME_TS).href)};` +
      `const out = await nodeProcessDeps.execFile(process.execPath, ["-e", "console.error('HOOK-NOISE'); process.stdout.write('{}')"]);` +
      `process.stdout.write(out);`;
    const host = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
    assert.equal(host.status, 0, host.stderr);
    assert.equal(host.stdout, "{}");
    assert.equal(host.stderr, "");
  });

  it("kills the hook when the signal aborts", async () => {
    const pidFile = path.join(ROOT, "hook.pid");
    const [bin, ...args] = nodeHook(
      `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60000)`,
    );
    const controller = new AbortController();
    const running = nodeProcessDeps.execFile(bin!, args, { signal: controller.signal });
    const pid = await pidFrom(pidFile);
    controller.abort();
    await assert.rejects(running);
    assert.equal(await exits(pid), true);
  });
});

describe("a tool call while the hook is still running", () => {
  let harness: Harness;

  before(async () => {
    harness = await gortexSession();
  });

  it("leaves Pi's event loop running", async () => {
    const hook = gate();
    control.reset({ hookGate: hook.promise, hookDecision: { block: true, reason: "r" } });
    let settled = false;
    const call = harness.toolCall("bash", { command: "echo hi" }).finally(() => {
      settled = true;
    });
    await delay(0);
    assert.equal(control.hookCalls.length, 1);
    assert.equal(settled, false);
    hook.open();
    assert.deepEqual(await call, { block: true, reason: "r" });
  });

  it("lets the call through and stops the hook when the turn is aborted", async () => {
    control.reset({ hookGate: gate().promise, hookDecision: { block: true, reason: "r" } });
    const call = harness.toolCall("bash", { command: "echo hi" });
    await delay(0);
    harness.abort();
    assert.equal(await call, undefined);
    assert.equal(control.hookCalls[0]!.opts?.signal?.aborted, true);
  });
});

describe("a hook that answers null", () => {
  let harness: Harness;

  before(async () => {
    harness = await gortexSession();
    control.reset({ hookOutput: "null" });
  });

  it("lets the tool call through", async () => {
    assert.equal(await harness.toolCall("bash", { command: "echo ran" }), undefined);
  });

  it("starts the turn with no briefing", async () => {
    await harness.turn();
    assert.equal((await harness.context()).some((m) => m.content.includes("Orientation")), false);
  });

  it("raises no extension errors", () => {
    assert.deepEqual(harness.errors, []);
  });
});

describe("soft guidance", () => {
  let harness: Harness;
  let calls = 0;

  before(async () => {
    harness = await gortexSession();
  });

  const start = (toolCallId: string, toolName: string, input: Record<string, unknown>, parentToolCallId?: string) =>
    harness.runner.emitToolCall({ type: "tool_call", toolCallId, toolName, input, ...(parentToolCallId && { parentToolCallId }) });

  const finish = (toolCallId: string, toolName: string, extra: Record<string, unknown> = {}) =>
    harness.runner.emitToolResult({
      type: "tool_result",
      toolCallId,
      toolName,
      input: {},
      content: [{ type: "text", text: "package main" }],
      details: undefined,
      isError: false,
      ...extra,
    } as Parameters<Harness["runner"]["emitToolResult"]>[0]);

  const end = (toolCallId: string, toolName: string) =>
    harness.runner.emit({ type: "tool_execution_end", toolCallId, toolName, result: {}, isError: true } as never);

  async function call(toolName: string, input: Record<string, unknown>) {
    const toolCallId = `call-${calls++}`;
    const decision = await start(toolCallId, toolName, input);
    return { decision, result: await finish(toolCallId, toolName) };
  }

  it("travels inside its own call's result", async () => {
    control.reset({ hookDecision: { additional_context: "[Gortex] prefer read" } });
    const { decision, result } = await call("read", { path: "a.go" });
    assert.equal(decision, undefined);
    assert.deepEqual(result?.content, [
      { type: "text", text: "package main" },
      { type: "text", text: "[Gortex] prefer read" },
    ]);
  });

  it("is not sent as a message of its own", () => {
    assert.deepEqual(harness.sent, []);
  });

  it("leaves a call without guidance untouched", async () => {
    control.reset({ hookDecision: {} });
    assert.equal((await call("read", { path: "a.go" })).result, undefined);
  });

  it("stays with the call it was given for while another runs alongside", async () => {
    control.reset({ hookDecision: { additional_context: "for a" } });
    await start("a", "read", { path: "a.go" });
    control.reset({ hookDecision: {} });
    await start("b", "read", { path: "b.go" });
    assert.equal(await finish("b", "read"), undefined);
    assert.deepEqual((await finish("a", "read"))?.content?.at(-1), { type: "text", text: "for a" });
  });

  it("is dropped with a call that ends without a result", async () => {
    control.reset({ hookDecision: { additional_context: "stale" } });
    await start("blocked", "read", { path: "a.go" });
    await end("blocked", "read");
    assert.equal(await finish("blocked", "read"), undefined);
  });

  it("keeps the structured content of the result it joins", async () => {
    control.reset({ hookDecision: { additional_context: "advice" } });
    await start("mcp", "mcp__gortex__read", {});
    const result = await finish("mcp", "mcp__gortex__read", { structuredContent: { ok: true } });
    assert.deepEqual(result?.structuredContent, { ok: true });
  });

  it("joins a result that has no content", async () => {
    control.reset({ hookDecision: { additional_context: "advice" } });
    await start("bare", "custom", {});
    const result = await finish("bare", "custom", { content: undefined });
    assert.deepEqual(result?.content, [{ type: "text", text: "advice" }]);
  });

  // A nested call's result is what the script reads, so guidance there would corrupt it.
  it("waits for the top-level call when a script makes the call", async () => {
    control.reset({ hookDecision: {} });
    await start("script", "code", {});
    control.reset({ hookDecision: { additional_context: "nested one" } });
    await start("script/0", "read", { path: "a.go" }, "script");
    control.reset({ hookDecision: { additional_context: "nested two" } });
    await start("script/0/0", "read", { path: "b.go" }, "script/0");
    assert.equal(await finish("script/0/0", "read"), undefined);
    await end("script/0/0", "read");
    assert.equal(await finish("script/0", "read"), undefined);
    await end("script/0", "read");
    assert.deepEqual((await finish("script", "code"))?.content?.slice(1), [{ type: "text", text: "nested one\n\nnested two" }]);
  });

  it("sends the call under its canonical name", () => {
    assert.equal(lastEnvelope().tool_name, "Read");
  });
});

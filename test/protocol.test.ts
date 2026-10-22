// JSON-RPC conformance of the extension's own client: cancellation, framing,
// server requests and error frames, each driven through a tool Pi executes.
//
// Why this suite exists: every case here fails silently. A dropped abort
// signal leaves the turn blocked until the call timeout, a character split
// across stdout chunks reaches the model as U+FFFD, a frame cap counted in
// UTF-16 units lets a frame three times its size through, a server ping
// reusing a call's id settles that call with an empty result, and an error
// frame without an id leaves its call waiting for the timeout. None of it
// raises an error anywhere.
//
// The double writes the frames by hand through child.write(), so chunk
// boundaries are the suite's to choose.

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

import { loadFactory } from "./support/subject.ts";
import { createHarness } from "./support/runner.ts";
import type { Harness } from "./support/runner.ts";
import { control, resetInitializeAttempts } from "./support/child-process-mock.ts";
import type { FakeChild } from "./support/child-process-mock.ts";
import { TOOLS, options } from "./support/fixtures.ts";
import type { GortexExtensionOptions } from "../src/index.ts";

interface ToolResult {
  content: { type: string; text: string }[];
}

const harnesses: Harness[] = [];

async function session(overrides: Partial<GortexExtensionOptions> = {}): Promise<Harness> {
  resetInitializeAttempts();
  control.reset({ tools: TOOLS });
  const harness = await createHarness(await loadFactory(0), options(overrides));
  await harness.sessionStart();
  harnesses.push(harness);
  return harness;
}

function call(
  harness: Harness,
  signal?: AbortSignal,
  tool = "search",
  params: Record<string, unknown> = {},
): Promise<ToolResult> {
  return harness.tool(tool)!.execute(
    "call-1",
    params,
    signal,
    undefined,
    harness.runner.createContext() as never,
  ) as Promise<ToolResult>;
}

function bridge(): FakeChild {
  return control.children[control.children.length - 1]!;
}

function frame(obj: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", ...(obj as object) }) + "\n";
}

function textResult(id: number, text: string): string {
  return frame({ id, result: { content: [{ type: "text", text }] } });
}

function sent(method: string): Record<string, unknown>[] {
  return bridge().received.filter((m) => m.method === method);
}

after(() => {
  for (const harness of harnesses) assert.deepEqual(harness.errors, []);
});

describe("aborting a running tool", () => {
  it("rejects the call and tells the server to stop", async () => {
    const harness = await session();
    let callId = -1;
    control.onToolCallFrame = (_child, id) => {
      callId = id;
    };
    const ac = new AbortController();
    const pending = call(harness, ac.signal);
    // FENCE: the abort must land on a call already sent, or this tests the
    // pre-send path below instead.
    assert.equal(sent("tools/call").length, 1, "tools/call was not sent before the abort");

    ac.abort();

    await assert.rejects(pending, /aborted/);
    assert.deepEqual(sent("notifications/cancelled").map((m) => (m.params as { requestId: unknown }).requestId), [callId]);
  });

  it("ignores the late reply and keeps serving calls", async () => {
    const harness = await session();
    let callId = -1;
    control.onToolCallFrame = (_child, id) => {
      callId = id;
    };
    const ac = new AbortController();
    const pending = call(harness, ac.signal);
    ac.abort();
    await assert.rejects(pending, /aborted/);

    bridge().write(textResult(callId, "late"));
    control.onToolCallFrame = undefined;

    assert.equal((await call(harness)).content[0]!.text, "ok");
  });

  it("cancels an edit tool, whose call runs inside the diff snapshot", async () => {
    const harness = await session();
    let callId = -1;
    let sentCall!: () => void;
    const callSent = new Promise<void>((resolve) => (sentCall = resolve));
    control.onToolCallFrame = (_child, id) => {
      callId = id;
      sentCall();
    };
    const ac = new AbortController();
    const pending = call(harness, ac.signal, "gortex_edit", { operation: "file", target: { file: "a.ts" } });
    // The edit path snapshots files before it calls, so wait for the call.
    await callSent;

    ac.abort();

    await assert.rejects(pending, /aborted/);
    assert.deepEqual(sent("notifications/cancelled").map((m) => (m.params as { requestId: unknown }).requestId), [callId]);
  });

  it("sends nothing when the signal aborts after the call finished", async () => {
    const harness = await session();
    const ac = new AbortController();
    assert.equal((await call(harness, ac.signal)).content[0]!.text, "ok");

    ac.abort();

    assert.equal(sent("notifications/cancelled").length, 0);
  });

  it("never sends a call whose signal is already aborted", async () => {
    const harness = await session();
    await assert.rejects(call(harness, AbortSignal.abort()), /aborted/);
    assert.equal(sent("tools/call").length, 0);
  });
});

describe("a tool call that times out", () => {
  it("tells the server to stop", async () => {
    const harness = await session({ callTimeoutMs: 20 });
    let callId = -1;
    control.onToolCallFrame = (_child, id) => {
      callId = id;
    };

    await assert.rejects(call(harness), /timed out after 20ms/);

    assert.deepEqual(sent("notifications/cancelled").map((m) => (m.params as { requestId: unknown }).requestId), [callId]);
  });
});

describe("a result split inside multi-byte characters", () => {
  it("arrives byte-exact", async () => {
    const harness = await session();
    const text = "café 🚀 naïve";
    control.onToolCallFrame = (child, id) => {
      const bytes = Buffer.from(textResult(id, text), "utf8");
      const inE = bytes.indexOf(Buffer.from("é", "utf8")) + 1;
      const inRocket = bytes.indexOf(Buffer.from("🚀", "utf8")) + 2;
      queueMicrotask(() => {
        child.write(bytes.subarray(0, inE));
        child.write(bytes.subarray(inE, inRocket));
        child.write(bytes.subarray(inRocket));
      });
    };

    assert.equal((await call(harness)).content[0]!.text, text);
  });
});

describe("a frame over the cap in UTF-8 bytes but not in UTF-16 units", () => {
  // Above the handshake and tools/list frames, which pass through it too.
  const CAP = 1024;
  const big = (id: number) => textResult(id, "日".repeat(400));

  function overCap(id: number): string {
    const line = big(id);
    // FENCE: the frame has to sit between the two measures, or the suite stops
    // telling a byte count from a string length.
    assert.ok(line.length <= CAP && Buffer.byteLength(line) > CAP, "fixture no longer straddles the cap");
    return line;
  }

  it("kills the child when it arrives in one chunk", async () => {
    const harness = await session({ maxFrameBytes: CAP });
    control.onToolCallFrame = (child, id) => queueMicrotask(() => child.write(overCap(id)));

    await assert.rejects(call(harness), new RegExp(`exceeded ${CAP} bytes`));
    assert.equal(bridge().killed, true);
  });

  it("kills the child while it is still arriving", async () => {
    const harness = await session({ maxFrameBytes: CAP });
    control.onToolCallFrame = (child, id) => queueMicrotask(() => child.write(overCap(id).trimEnd()));

    await assert.rejects(call(harness), new RegExp(`exceeded ${CAP} bytes`));
    assert.equal(bridge().killed, true);
  });
});

describe("a server request reusing an in-flight call id", () => {
  it("leaves the call to its real result", async () => {
    const harness = await session();
    control.onToolCallFrame = (child, id) =>
      queueMicrotask(() => {
        child.write(frame({ id, method: "ping" }));
        child.write(textResult(id, "REAL RESULT"));
      });

    assert.equal((await call(harness)).content[0]!.text, "REAL RESULT");
  });

  it("answers ping with an empty result", async () => {
    const harness = await session();
    let callId = -1;
    control.onToolCallFrame = (child, id) => {
      callId = id;
      queueMicrotask(() => {
        child.write(frame({ id, method: "ping" }));
        child.write(textResult(id, "ok"));
      });
    };
    await call(harness);

    assert.deepEqual(
      bridge().received.filter((m) => m.id === callId && !("method" in m)),
      [{ jsonrpc: "2.0", id: callId, result: {} }],
    );
  });

  it("answers an unknown method with -32601", async () => {
    const harness = await session();
    control.onToolCallFrame = (child, id) =>
      queueMicrotask(() => {
        child.write(frame({ id: "srv-1", method: "roots/list" }));
        child.write(textResult(id, "ok"));
      });
    await call(harness);

    const reply = bridge().received.find((m) => m.id === "srv-1");
    assert.equal((reply?.error as { code?: unknown })?.code, -32601);
  });
});

describe("an error frame", () => {
  it("keeps the code and data", async () => {
    const harness = await session();
    control.onToolCallFrame = (child, id) =>
      queueMicrotask(() =>
        child.write(frame({ id, error: { code: -32602, message: "Invalid params", data: { field: "query" } } })),
      );

    await assert.rejects(call(harness), (err: Error) => {
      assert.ok(err.message.includes('Invalid params (-32602): {"field":"query"}'), err.message);
      return true;
    });
  });

  it("with a null id rejects the pending call", async () => {
    const harness = await session();
    control.onToolCallFrame = (child) =>
      queueMicrotask(() => child.write(frame({ id: null, error: { code: -32700, message: "Parse error" } })));

    await assert.rejects(call(harness), /Parse error \(-32700\)/);
  });
});

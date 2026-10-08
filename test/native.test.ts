// The tool channel on Pi's built-in MCP: the extension registers `gortex mcp`
// and keeps only read discipline and the orientation.
//
// Pi's MCP extension is not loaded here, so the gortex tools never connect on
// their own. A suite that needs them connected registers a stand-in tool under
// the name Pi would give it.

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

import { loadFactory } from "./support/subject.ts";
import type { Factory } from "./support/subject.ts";
import { createHarness } from "./support/runner.ts";
import type { ContextMessage, Harness } from "./support/runner.ts";
import { control } from "./support/child-process-mock.ts";
import { CONFIG, NATIVE_CONFIG, ORIENTATION, TOOLS, options } from "./support/fixtures.ts";
import path from "node:path";

import {
  MCP_TOOL_PREFIX,
  binaryResolves,
  daemonVersionFromBriefing,
  nativeServerConfig,
} from "../src/native.ts";

function withConnectedTools(gortex: Factory): Factory {
  return (pi, opts) => {
    pi.registerTool({
      name: `${MCP_TOOL_PREFIX}search`,
      label: "search",
      description: "Search the graph.",
      parameters: { type: "object", properties: {} } as never,
      execute: async () => ({ content: [], details: {} }),
    });
    gortex(pi, opts);
  };
}

/** Hands the extension a `pi` whose registerMcpServer is replaced, or absent like on Pi < 0.99. */
function withRegisterMcpServer(gortex: Factory, replacement: unknown): Factory {
  return (pi, opts) => {
    const patched = new Proxy(pi, {
      get: (target, key) => (key === "registerMcpServer" ? replacement : Reflect.get(target, key)),
    });
    gortex(patched, opts);
  };
}

async function nativeSession(
  factory?: Factory,
  config = NATIVE_CONFIG,
  orientation = ORIENTATION,
): Promise<Harness> {
  control.reset({ tools: TOOLS, hookDecision: { orientation } });
  const harness = await createHarness(
    factory ?? (await loadFactory(0)),
    options({ config, nativeReadyWaitMs: 50 }),
  );
  await harness.sessionStart();
  return harness;
}

function lastEnvelope(): Record<string, unknown> {
  const call = control.hookCalls.at(-1);
  assert.ok(call, "no hook call recorded");
  return JSON.parse(call.input ?? "{}") as Record<string, unknown>;
}

describe("on a Pi with built-in MCP", () => {
  let harness: Harness;

  before(async () => {
    harness = await nativeSession();
  });

  it("registers the gortex server with Pi", () => {
    const servers = harness.mcpServers();
    assert.equal(servers.length, 1);
    assert.equal(servers[0]!.name, "gortex");
    assert.deepEqual(
      { ...servers[0]!.config, env: undefined },
      { ...nativeServerConfig(NATIVE_CONFIG), env: undefined },
    );
  });

  it("declares the tools directly with the long call timeout", () => {
    const config = harness.mcpServers()[0]!.config;
    assert.equal(config.exposure, "direct");
    assert.equal(config.timeout, 600);
  });

  it("spawns neither a bridge nor the daemon itself", () => {
    assert.deepEqual(control.spawns, []);
  });

  it("registers no tools of its own", () => {
    assert.deepEqual(harness.tools(), []);
  });

  it("reports no extension errors", () => {
    assert.deepEqual(harness.errors, []);
  });
});

describe("read discipline on built-in MCP", () => {
  let harness: Harness;

  before(async () => {
    harness = await nativeSession();
  });

  it("marks a gortex MCP tool as a graph call under its bare name", async () => {
    await harness.toolCall(`${MCP_TOOL_PREFIX}read`, { path: "a.go" });
    const envelope = lastEnvelope();
    assert.equal(envelope.is_gortex_tool, true);
    assert.equal(envelope.tool_name, "read");
  });

  it("still maps Pi's own read to the canonical name", async () => {
    await harness.toolCall("read", { path: "a.go" });
    const envelope = lastEnvelope();
    assert.equal(envelope.is_gortex_tool, false);
    assert.equal(envelope.tool_name, "Read");
    assert.equal((envelope.tool_input as Record<string, unknown>).file_path, "a.go");
  });

  it("treats another server's tool as a non-graph call", async () => {
    await harness.toolCall("mcp__docs__read", {});
    assert.equal(lastEnvelope().is_gortex_tool, false);
  });

  it("blocks what the hook denies", async () => {
    control.hookDecision = { block: true, reason: "use graph tools" };
    const result = await harness.toolCall("grep", { pattern: "x" });
    assert.deepEqual(result, { block: true, reason: "use graph tools" });
  });
});

describe("the first turn before the gortex tools connect", () => {
  let turn1: ContextMessage[];

  before(async () => {
    const harness = await nativeSession();
    await harness.turn();
    turn1 = await harness.context();
  });

  it("tells the model the tools may not be callable yet", () => {
    assert.equal(turn1.length, 1);
    assert.match(turn1[0]!.content, /still registering/);
  });

  it("still delivers the orientation", () => {
    assert.ok(turn1[0]!.content.includes(ORIENTATION));
  });
});

describe("the first turn after the gortex tools connect", () => {
  let turn1: ContextMessage[];

  before(async () => {
    const harness = await nativeSession(withConnectedTools(await loadFactory(0)));
    await harness.turn();
    turn1 = await harness.context();
  });

  it("delivers the orientation alone", () => {
    assert.deepEqual(turn1, [{ role: "user", content: ORIENTATION }]);
  });
});

describe("native_mcp turned off on a Pi with built-in MCP", () => {
  let harness: Harness;

  before(async () => {
    control.reset({ tools: TOOLS });
    harness = await createHarness(await loadFactory(0), options({ config: CONFIG }));
    await harness.sessionStart();
  });

  it("registers no MCP server", () => {
    assert.deepEqual(harness.mcpServers(), []);
  });

  it("runs its own bridge", () => {
    assert.ok(control.spawns.some((s) => s.args[0] === "mcp"));
    assert.ok(harness.tools().includes("search"));
  });
});

function assertOwnBridge(harness: Harness): void {
  assert.deepEqual(harness.mcpServers(), []);
  assert.ok(control.spawns.some((s) => s.args[0] === "mcp"), "the extension's own bridge did not spawn");
  assert.ok(harness.tools().includes("search"));
}

describe("a Pi without built-in MCP", () => {
  it("runs the extension's own bridge with the default config", async () => {
    const harness = await nativeSession(withRegisterMcpServer(await loadFactory(0), undefined));
    assertOwnBridge(harness);
  });
});

describe("a gortex binary that does not resolve", () => {
  it("keeps the extension's own bridge, which reports the failure", async () => {
    const harness = await nativeSession(undefined, { ...NATIVE_CONFIG, bin: "/nonexistent/gortex" });
    assertOwnBridge(harness);
  });
});

describe("a registration Pi refuses", () => {
  let harness: Harness;

  before(async () => {
    const refuse = () => {
      throw new Error('MCP server "gortex" is already registered by another extension');
    };
    harness = await nativeSession(withRegisterMcpServer(await loadFactory(0), refuse));
  });

  it("falls back to the extension's own bridge", () => {
    assertOwnBridge(harness);
  });

  it("tells the user why", () => {
    assert.equal(harness.notifications.length, 1);
    assert.equal(harness.notifications[0]!.type, "warning");
    assert.match(harness.notifications[0]!.message, /already registered by another extension/);
  });
});

describe("a daemon older than the floor on built-in MCP", () => {
  let harness: Harness;
  let turn1: ContextMessage[];

  before(async () => {
    const briefing = `✓ Gortex daemon ready (v0.60.0, uptime 5s). 1 tracked repo(s).\n\n${ORIENTATION}`;
    harness = await nativeSession(withConnectedTools(await loadFactory(0)), NATIVE_CONFIG, briefing);
    await harness.turn();
    turn1 = await harness.context();
  });

  it("warns the user with the version the briefing reports", () => {
    assert.equal(harness.notifications.length, 1);
    assert.match(harness.notifications[0]!.message, /0\.60\.0/);
  });

  it("tells the model a tool may misbehave", () => {
    assert.match(turn1[0]!.content, /older than/);
  });
});

describe("a current daemon on built-in MCP", () => {
  it("warns nobody", async () => {
    const briefing = `✓ Gortex daemon ready (v99.0.0, uptime 5s).\n\n${ORIENTATION}`;
    const harness = await nativeSession(withConnectedTools(await loadFactory(0)), NATIVE_CONFIG, briefing);
    await harness.turn();
    assert.deepEqual(harness.notifications, []);
    assert.deepEqual(await harness.context(), [{ role: "user", content: briefing }]);
  });
});

describe("the daemon version in a briefing", () => {
  it("is read from every readiness line", () => {
    assert.equal(daemonVersionFromBriefing("✓ Gortex daemon ready (v0.64.5+33107203, uptime 1m)."), "0.64.5+33107203");
    assert.equal(
      daemonVersionFromBriefing("✓ Gortex daemon ready — references queryable (v0.64.5, uptime 1m); semantic"),
      "0.64.5",
    );
    assert.equal(daemonVersionFromBriefing("⏳ Gortex daemon warming up (v0.62.0, 3s elapsed)."), "0.62.0");
  });

  it("is empty when the briefing names none", () => {
    assert.equal(daemonVersionFromBriefing("✓ Gortex daemon ready (vunknown, uptime 1m)."), "");
    assert.equal(daemonVersionFromBriefing(ORIENTATION), "");
  });
});

describe("binary resolution", () => {
  it("finds an executable by path and through PATH", () => {
    assert.equal(binaryResolves(process.execPath), true);
    assert.equal(binaryResolves(path.basename(process.execPath), { PATH: path.dirname(process.execPath) }), true);
  });

  it("rejects a missing binary and a directory", () => {
    assert.equal(binaryResolves("/nonexistent/gortex"), false);
    assert.equal(binaryResolves("gortex", { PATH: "" }), false);
    assert.equal(binaryResolves(path.dirname(process.execPath)), false);
  });
});

describe("the server config", () => {
  it("forwards a narrowing preset to `gortex mcp`", () => {
    const config = nativeServerConfig({ ...NATIVE_CONFIG, toolsPreset: "nav" }, {});
    assert.deepEqual((config as { env?: unknown }).env, { GORTEX_TOOLS: "nav", GORTEX_TOOLS_MODE: "defer" });
  });

  it("leaves the daemon's default surface alone", () => {
    const config = nativeServerConfig(NATIVE_CONFIG, {});
    assert.deepEqual((config as { env?: unknown }).env, {});
  });

  it("does not override a GORTEX_TOOLS the user already exported", () => {
    const config = nativeServerConfig({ ...NATIVE_CONFIG, toolsPreset: "nav" }, { GORTEX_TOOLS: "full" });
    assert.deepEqual((config as { env?: unknown }).env, { GORTEX_TOOLS_MODE: "defer" });
  });
});

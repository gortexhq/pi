// The tool channel: the extension registers `gortex mcp` with Pi's built-in MCP
// and keeps read discipline and the orientation, failing open without it.
//
// Pi's MCP extension is not loaded here, so the gortex tools never connect on
// their own. Every session here registers the `/mcp` command that extension
// would, and a suite that needs the tools connected registers a stand-in tool
// under the name Pi would give it.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { loadFactory } from "./support/subject.ts";
import type { Factory } from "./support/subject.ts";
import { assertNoRunnerErrors, createHarness } from "./support/runner.ts";
import type { ContextMessage, Harness } from "./support/runner.ts";
import { control } from "./support/hook-mock.ts";
import {
  CONFIG,
  ORIENTATION,
  delay,
  gortexSession,
  options,
  stubTool,
  withConnectedTools,
  withMcpConnector,
  withRegisterMcpServer,
} from "./support/fixtures.ts";

import { resolveConfig } from "../src/config.ts";
import {
  MCP_TOOL_PREFIX,
  MIN_GORTEX_VERSION,
  binaryResolves,
  daemonVersionFromBriefing,
  isBelowVersion,
  serverConfig,
} from "../src/mcp.ts";

after(assertNoRunnerErrors);

function lastEnvelope(): Record<string, unknown> {
  const call = control.hookCalls.at(-1);
  assert.ok(call, "no hook call recorded");
  return JSON.parse(call.input ?? "{}") as Record<string, unknown>;
}

describe("on a Pi with built-in MCP", () => {
  let harness: Harness;

  before(async () => {
    harness = await gortexSession();
  });

  it("registers the gortex server with Pi", () => {
    const servers = harness.mcpServers();
    assert.equal(servers.length, 1);
    assert.equal(servers[0]!.name, "gortex");
    assert.deepEqual(
      { ...servers[0]!.config, env: undefined },
      { ...serverConfig(CONFIG), env: undefined },
    );
  });

  it("declares the tools directly with the long call timeout", () => {
    const config = harness.mcpServers()[0]!.config;
    assert.equal(config.exposure, "direct");
    assert.equal(config.timeout, 600);
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
    harness = await gortexSession();
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
    const harness = await gortexSession();
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
    const harness = await gortexSession(withConnectedTools(await loadFactory(0)));
    await harness.turn();
    turn1 = await harness.context();
  });

  it("delivers the orientation alone", () => {
    assert.deepEqual(turn1, [{ role: "user", content: ORIENTATION }]);
  });
});

/** A first turn whose model message names why graph tools are unavailable. */
async function unavailableTurn(harness: Harness): Promise<string> {
  await harness.turn();
  const turn1 = await harness.context();
  assert.equal(turn1.length, 1);
  const message = turn1[0]!.content;
  assert.match(message, /graph tools are unavailable this session/);
  assert.doesNotMatch(message, /still registering/);
  assert.ok(message.includes(ORIENTATION), "the orientation was not delivered");
  return message;
}

function assertNothingRegistered(harness: Harness): void {
  assert.deepEqual(harness.mcpServers(), []);
  assert.deepEqual(harness.tools(), []);
  // The harness runs Pi's check for registered servers nothing connects.
  assert.deepEqual(harness.errors, []);
}

describe("a Pi without built-in MCP", () => {
  let harness: Harness;
  let message: string;

  before(async () => {
    harness = await gortexSession(withRegisterMcpServer(await loadFactory(0), undefined));
    message = await unavailableTurn(harness);
  });

  it("registers nothing", () => {
    assertNothingRegistered(harness);
  });

  it("tells the model it needs Pi 1.0", () => {
    assert.match(message, /Pi 1\.0/);
  });
});

describe("a Pi with MCP turned off", () => {
  let harness: Harness;
  let message: string;

  before(async () => {
    harness = await gortexSession(undefined, CONFIG, ORIENTATION, false);
    message = await unavailableTurn(harness);
  });

  it("registers nothing, so Pi reports no unconnected server", () => {
    assertNothingRegistered(harness);
  });

  it("tells the model MCP is not loaded, without suggesting /reload", () => {
    assert.match(message, /MCP support is not loaded/);
    assert.doesNotMatch(message, /\/reload/);
  });

  it("leaves the user alone, who chose it", () => {
    assert.deepEqual(harness.notifications, []);
  });
});

describe("a gortex binary that does not resolve", () => {
  let harness: Harness;
  let message: string;

  before(async () => {
    harness = await gortexSession(undefined, { ...CONFIG, bin: "/nonexistent/gortex" });
    message = await unavailableTurn(harness);
  });

  it("registers nothing", () => {
    assertNothingRegistered(harness);
  });

  it("names the binary and the remedy", () => {
    assert.match(message, /nonexistent.gortex/);
    assert.match(message, /GORTEX_BIN/);
    assert.match(message, /\/reload/);
  });
});

const refuse = () => {
  throw new Error('MCP server "gortex" is already registered by another extension');
};

describe("a registration Pi refuses", () => {
  let harness: Harness;
  let message: string;

  before(async () => {
    harness = await gortexSession(withRegisterMcpServer(await loadFactory(0), refuse));
    message = await unavailableTurn(harness);
  });

  it("registers nothing", () => {
    assertNothingRegistered(harness);
  });

  it("tells the user why", () => {
    assert.equal(harness.notifications.length, 1);
    assert.equal(harness.notifications[0]!.type, "warning");
    assert.match(harness.notifications[0]!.message, /already registered by another extension/);
  });

  it("tells the model why", () => {
    assert.match(message, /already registered by another extension/);
  });
});

describe("a refused registration whose gortex tools come from elsewhere", () => {
  it("tells nobody the tools are unavailable", async () => {
    const harness = await gortexSession(withRegisterMcpServer(withConnectedTools(await loadFactory(0)), refuse));
    await harness.turn();
    assert.deepEqual(await harness.context(), [{ role: "user", content: ORIENTATION }]);
    assert.deepEqual(harness.notifications, []);
  });

  // Why: the other source's tools can connect after the turn starts, and the
  // model was told they were unavailable while read discipline blocked Pi's tools.
  it("waits for tools that connect during the first turn", async () => {
    control.reset({ hookDecision: { orientation: ORIENTATION } });
    let api!: ExtensionAPI;
    const gortex = withRegisterMcpServer(await loadFactory(0), refuse);
    const capture: Factory = (pi, opts) => {
      api = pi;
      return withMcpConnector(gortex)(pi, opts);
    };
    const harness = await createHarness(capture, options({ toolsReadyWaitMs: 60_000 }));
    await harness.sessionStart();
    let released = false;
    const turn = harness.turn().then(() => {
      released = true;
    });
    await delay(100);
    assert.equal(released, false, "the turn did not wait for the tools");
    api.registerTool(stubTool("search"));
    await turn;
    assert.deepEqual(await harness.context(), [{ role: "user", content: ORIENTATION }]);
    assert.deepEqual(harness.notifications, []);
  });
});

// Why: a registered server can still fail to connect (a disabled mcp.json
// entry, or a daemon that is down), and read discipline would then block Pi's
// tools with nothing to use instead.
describe("read discipline once the first turn found no gortex tools", () => {
  it("lets Pi's own tools through", async () => {
    const harness = await gortexSession();
    const before = control.hookCalls.length;
    control.hookDecision = { block: true, reason: "use graph tools" };
    assert.deepEqual(await harness.toolCall("read", { path: "a.go" }), { block: true, reason: "use graph tools" });
    await harness.turn();
    const calls = control.hookCalls.length;
    assert.equal(await harness.toolCall("read", { path: "a.go" }), undefined);
    assert.equal(control.hookCalls.length, calls);
    assert.ok(calls > before);
  });
});

// Why: a session with no graph tools would otherwise have the hook block Pi's
// reads with nothing to use instead.
describe("read discipline without graph tools", () => {
  let harness: Harness;

  before(async () => {
    harness = await gortexSession(undefined, CONFIG, ORIENTATION, false);
    await harness.turn();
    control.hookDecision = { block: true, reason: "use graph tools" };
  });

  it("lets Pi's own tools through without asking the hook", async () => {
    const calls = control.hookCalls.length;
    assert.equal(await harness.toolCall("read", { path: "a.go" }), undefined);
    assert.equal(control.hookCalls.length, calls);
  });

  it("still asks the hook once gortex tools come from elsewhere", async () => {
    const harness = await gortexSession(withConnectedTools(await loadFactory(0)), CONFIG, ORIENTATION, false);
    control.hookDecision = { block: true, reason: "use graph tools" };
    assert.deepEqual(await harness.toolCall("read", { path: "a.go" }), { block: true, reason: "use graph tools" });
  });
});

describe("a daemon older than the floor on built-in MCP", () => {
  let harness: Harness;
  let turn1: ContextMessage[];

  before(async () => {
    const briefing = `✓ Gortex daemon ready (v0.60.0, uptime 5s). 1 tracked repo(s).\n\n${ORIENTATION}`;
    harness = await gortexSession(withConnectedTools(await loadFactory(0)), CONFIG, briefing);
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

describe("a daemon older than the floor across turns", () => {
  it("is reported on the first turn only", async () => {
    const briefing = `✓ Gortex daemon ready (v0.60.0, uptime 5s).\n\n${ORIENTATION}`;
    const harness = await gortexSession(withConnectedTools(await loadFactory(0)), CONFIG, briefing);
    await harness.turn();
    await harness.context();
    await harness.turn();
    assert.deepEqual(await harness.context(), []);
    assert.equal(harness.notifications.length, 1);
    assert.ok(harness.notifications[0]!.message.includes(MIN_GORTEX_VERSION));
    assert.match(harness.notifications[0]!.message, /gortex upgrade/);
  });
});

describe("a daemon at exactly the floor", () => {
  it("warns nobody", async () => {
    const briefing = `✓ Gortex daemon ready (v${MIN_GORTEX_VERSION}, uptime 5s).\n\n${ORIENTATION}`;
    const harness = await gortexSession(withConnectedTools(await loadFactory(0)), CONFIG, briefing);
    await harness.turn();
    assert.deepEqual(harness.notifications, []);
  });
});

describe("a briefing that names no version", () => {
  it("warns nobody", async () => {
    const harness = await gortexSession(withConnectedTools(await loadFactory(0)));
    await harness.turn();
    assert.deepEqual(harness.notifications, []);
    assert.deepEqual(await harness.context(), [{ role: "user", content: ORIENTATION }]);
  });
});

describe("the version floor check", () => {
  it("reads what the daemon and its CLI print", () => {
    assert.equal(isBelowVersion("0.60.0", "0.61.2"), true);
    assert.equal(isBelowVersion("v0.61.1+2b5480bf", "0.61.2"), true);
    assert.equal(isBelowVersion("0.61.2-rc1", "0.61.2"), false);
    assert.equal(isBelowVersion("0.61.2", "0.61.2"), false);
    assert.equal(isBelowVersion("0.62", "0.61.2"), false);
  });

  it("never trips on a version it cannot read", () => {
    assert.equal(isBelowVersion("unknown", "0.0.0"), false);
  });
});

describe("a current daemon on built-in MCP", () => {
  it("warns nobody", async () => {
    const briefing = `✓ Gortex daemon ready (v99.0.0, uptime 5s).\n\n${ORIENTATION}`;
    const harness = await gortexSession(withConnectedTools(await loadFactory(0)), CONFIG, briefing);
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
  const env = (config: ReturnType<typeof serverConfig>) => (config as { env?: unknown }).env;

  it("forwards a preset to `gortex mcp`", () => {
    const config = serverConfig({ ...CONFIG, toolsPreset: "nav" }, {});
    assert.deepEqual(env(config), { GORTEX_TOOLS: "nav", GORTEX_TOOLS_MODE: "defer" });
  });

  it("clears both variables for the daemon's default surface", () => {
    const config = serverConfig(CONFIG, { GORTEX_TOOLS: "edti", GORTEX_TOOLS_MODE: "defer" });
    assert.deepEqual(env(config), { GORTEX_TOOLS: "", GORTEX_TOOLS_MODE: "" });
  });

  it("keeps a GORTEX_TOOLS_MODE the user exported", () => {
    const config = serverConfig({ ...CONFIG, toolsPreset: "nav" }, { GORTEX_TOOLS_MODE: "hide" });
    assert.deepEqual(env(config), { GORTEX_TOOLS: "nav", GORTEX_TOOLS_MODE: "hide" });
  });
});

// Why: an exported GORTEX_TOOLS skipped validation and outranked the resolved
// preset, so a typo stranded the session and `core`/`full` behaved differently
// from env and sidecar.
describe("preset parity across layers", () => {
  const AGENT_DIR = "/agent";
  const SIDECAR = path.join(AGENT_DIR, "extensions", "gortex.json");

  function childEnv(env: Record<string, string>, sidecar: Record<string, unknown> | null) {
    const config = resolveConfig({
      env,
      cwd: "/repo",
      agentDir: AGENT_DIR,
      readFile: (p) => {
        if (sidecar && p === SIDECAR) return JSON.stringify(sidecar);
        throw new Error("ENOENT");
      },
    });
    const merged = { ...env, ...(serverConfig(config, env) as { env: Record<string, string> }).env };
    return { GORTEX_TOOLS: merged.GORTEX_TOOLS, GORTEX_TOOLS_MODE: merged.GORTEX_TOOLS_MODE };
  }

  for (const preset of ["core", "full", "nav"]) {
    it(`serves the same \`${preset}\` surface from env and sidecar`, () => {
      const expected = { GORTEX_TOOLS: preset, GORTEX_TOOLS_MODE: "defer" };
      assert.deepEqual(childEnv({ GORTEX_TOOLS: preset }, null), expected);
      assert.deepEqual(childEnv({}, { tools_preset: preset }), expected);
    });
  }

  it("keeps a mistyped GORTEX_TOOLS and its mode away from the child", () => {
    assert.deepEqual(childEnv({ GORTEX_TOOLS: "edti", GORTEX_TOOLS_MODE: "defer" }, null), {
      GORTEX_TOOLS: "",
      GORTEX_TOOLS_MODE: "",
    });
  });
});

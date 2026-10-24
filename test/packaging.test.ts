// Packaging: the extension loads the way a user's Pi loads it.
//
// Why this suite exists: every other suite hands Pi a factory it imported
// itself, which says nothing about whether package.json's `pi.extensions`
// manifest points anywhere real, or whether jiti can load the src/*.ts import
// graph. Node's type stripping is a different loader, so this is the only suite
// that would catch "the published package does not load at all".
//
// No MCP connector is loaded and no gortex binary exists here, so the
// extension fails open, which makes this the failure path's test too.
//
// A second load copies the package to a directory with no node_modules above
// it. The extension imports Pi's packages at runtime, and only Pi's loader
// resolving them to the running Pi lets that copy load at all.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertNoRunnerErrors, createPackagedHarness } from "./support/runner.ts";
import type { ContextMessage, Harness } from "./support/runner.ts";

after(assertNoRunnerErrors);

const PACKAGE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("loaded through Pi's own discovery", () => {
  let harness: Harness;
  let turn1: ContextMessage[];

  before(async () => {
    // Resolved by the extension at factory time, which is during the load
    // below. Running the hook fails, and failing open is the behaviour under test.
    process.env.GORTEX_BIN = path.join(PACKAGE_ROOT, "does-not-exist-gortex");
    delete process.env.GORTEX_HOOK_MODE;
    delete process.env.GORTEX_ENFORCE;

    harness = await createPackagedHarness(PACKAGE_ROOT);
    await harness.sessionStart();
    await harness.turn();
    turn1 = await harness.context();
  });

  it("loads the entry the package manifest declares", () => {
    // Pi falls back to discovering files in the directory when the manifest
    // resolves to nothing, so loading at all proves little; this pins the
    // loaded file to what `pi.extensions` actually points at.
    const manifest = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")) as {
      pi?: { extensions?: string[] };
    };
    const declared = (manifest.pi?.extensions ?? []).map((entry) => path.resolve(PACKAGE_ROOT, entry));
    assert.deepEqual(harness.extensionPaths(), declared);
  });

  it("registers every lifecycle handler", () => {
    for (const event of ["session_start", "before_agent_start", "session_compact", "tool_call"]) {
      assert.ok(harness.runner.hasHandlers(event), `no handler for ${event}`);
    }
  });

  // Pi's MCP extension is not loaded here, which is checked before the binary.
  it("tells the model graph tools are unavailable, and why", () => {
    assert.equal(turn1.length, 1);
    assert.match(turn1[0]!.content, /graph tools are unavailable/i);
    assert.match(turn1[0]!.content, /MCP support is not loaded/);
  });

  it("registers no server and no tools", () => {
    assert.deepEqual(harness.mcpServers(), []);
    assert.deepEqual(harness.tools(), []);
  });

  it("lets tool calls through when graph tools are unavailable", async () => {
    assert.equal(await harness.toolCall("read", { path: "src/a.ts" }), undefined);
    assert.deepEqual(harness.errors, []);
  });
});

describe("loaded as a bare directory with no node_modules", () => {
  let harness: Harness;
  let bareRoot: string;

  before(async () => {
    process.env.GORTEX_BIN = path.join(PACKAGE_ROOT, "does-not-exist-gortex");
    bareRoot = mkdtempSync(path.join(tmpdir(), "pi-gortex-bare-"));
    for (const entry of ["package.json", "index.ts", "src"]) {
      cpSync(path.join(PACKAGE_ROOT, entry), path.join(bareRoot, entry), { recursive: true });
    }
    // DRIFT FENCE: a node_modules above the copy would resolve Pi's packages
    // without Pi's loader, and this suite would pass while proving nothing.
    for (let dir = bareRoot; dir !== path.dirname(dir); dir = path.dirname(dir)) {
      if (existsSync(path.join(dir, "node_modules"))) {
        throw new Error(`${dir} has a node_modules, so this load does not isolate Pi's loader; move the copy`);
      }
    }

    harness = await createPackagedHarness(bareRoot);
    await harness.sessionStart();
  });

  it("resolves Pi's packages through Pi's loader", () => {
    assert.deepEqual(harness.extensionPaths(), [path.join(bareRoot, "index.ts")]);
    assert.deepEqual(harness.errors, []);
  });
});

// Packaging: the extension loads the way a user's Pi loads it.
//
// Why this suite exists: every other suite hands Pi a factory it imported
// itself, which says nothing about whether package.json's `pi.extensions`
// manifest points anywhere real, or whether jiti can load the src/*.ts import
// graph. Node's type stripping is a different loader, so this is the only suite
// that would catch "the published package does not load at all".
//
// No gortex binary exists here, so the bridge fails open, which makes this
// the failure path's test too.

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createPackagedHarness } from "./support/runner.ts";
import type { ContextMessage, Harness } from "./support/runner.ts";

const PACKAGE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("loaded through Pi's own discovery", () => {
  let harness: Harness;
  let turn1: ContextMessage[];

  before(async () => {
    // Resolved by the extension at factory time, which is during the load
    // below. Spawning it fails, and failing open is the behaviour under test.
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
    for (const event of ["session_start", "before_agent_start", "context", "tool_call"]) {
      assert.ok(harness.runner.hasHandlers(event), `no handler for ${event}`);
    }
  });

  it("reports the unreachable bridge to the model", () => {
    assert.equal(turn1.length, 1);
    assert.match(turn1[0]!.content, /graph tools are unavailable/i);
  });

  it("names /reload as the recovery", () => {
    assert.ok(turn1[0]!.content.includes("/reload"));
  });

  it("registers no tools when the bridge is down", () => {
    assert.deepEqual(harness.tools(), []);
  });

  it("lets tool calls through rather than blocking on a dead hook", () => {
    assert.deepEqual(harness.errors, []);
  });
});

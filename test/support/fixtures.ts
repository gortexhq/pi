// Shared fixtures. The per-suite choreography stays in the test files: for the
// barrier, when each event fires relative to the others IS the thing under test.

import type { GortexConfig } from "../../src/config.ts";
import type { GortexExtensionOptions } from "../../src/index.ts";
import { control, mockDeps } from "./child-process-mock.ts";
import type { Harness } from "./runner.ts";

export const ORIENTATION = "GORTEX-ORIENTATION: prefer graph tools over native reads.";

const BIN = "/nonexistent/gortex";

/**
 * A fully resolved config, passed explicitly so no suite depends on the
 * machine's environment or on a `gortex.json` the developer happens to have.
 */
export const CONFIG: GortexConfig = {
  bin: BIN,
  hookArgv: [BIN, "hook", "--agent=pi"],
  enforce: true,
  toolsPreset: "core",
};

export function options(overrides: Partial<GortexExtensionOptions> = {}): GortexExtensionOptions {
  return { config: CONFIG, deps: mockDeps, ...overrides };
}

// `read` and `edit` collide with Pi's builtins; `search` does not.
export const TOOLS = [
  { name: "read", description: "Read indexed source.", inputSchema: { type: "object", properties: {} } },
  { name: "edit", description: "Apply guarded edits.", inputSchema: { type: "object", properties: {} } },
  { name: "search", description: "Search the graph.", inputSchema: { type: "object", properties: {} } },
];

export const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Emits session_start without awaiting it, and returns the child that
 * invocation spawned with its replies withheld. The suite decides when
 * registration completes by calling `child.releaseReplies()`, so nothing has
 * to assert on how long the handshake took.
 *
 * DRIFT FENCE: this targets the new child by capturing it on the line after
 * the emit, which holds only while two things stay true: index.ts spawns
 * before its first await inside the session_start handler, and Pi's emit()
 * calls the handler synchronously before suspending. Break either and this
 * throws instead of silently gating nothing.
 */
export function startGatedSession(harness: Harness, reason = "startup") {
  const before = control.children.length;
  control.holdNextChild = true;
  try {
    const settled = harness.sessionStart(reason);
    if (control.children.length === before) {
      throw new Error(
        "session_start spawned no child synchronously: either index.ts now awaits before spawning or Pi's emit() no longer calls handlers synchronously; this gate targets nothing, rework startGatedSession",
      );
    }
    return { settled, child: control.children[control.children.length - 1]! };
  } finally {
    control.holdNextChild = false;
  }
}

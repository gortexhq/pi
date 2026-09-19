// Configuration resolution: the contract `gortex init` writes against once it
// starts emitting a `gortex.json` sidecar.
//
// Why this suite exists: resolution order and the fallbacks around it are the
// whole configuration surface, and a layer resolved wrong runs the session
// against the wrong binary or posture without complaining. Pi plays no part
// here, so this stays a pure unit test.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { DEFAULT_BIN, defaultAgentDir, normalizeMode, resolveConfig, sidecarPaths } from "../src/config.ts";

const CWD = "/repo";
const AGENT_DIR = "/home/user/.pi/agent";

const [PROJECT_SIDECAR, GLOBAL_SIDECAR] = sidecarPaths(CWD, AGENT_DIR) as [string, string];

/** A readFile stub over an in-memory {path: contents} map. */
function files(map: Record<string, string>) {
  return (p: string) => {
    const hit = map[p];
    if (hit === undefined) {
      const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    }
    return hit;
  };
}

function resolve(env: Record<string, string | undefined>, map: Record<string, string> = {}) {
  return resolveConfig({ env, cwd: CWD, agentDir: AGENT_DIR, readFile: files(map) });
}

describe("with nothing configured", () => {
  const config = resolve({});

  it("leaves the binary to PATH", () => {
    assert.equal(config.bin, DEFAULT_BIN);
  });

  it("omits --mode, so the hook applies its own default posture", () => {
    assert.deepEqual(config.hookArgv, [DEFAULT_BIN, "hook", "--agent=pi"]);
  });

  it("enforces read discipline", () => {
    assert.equal(config.enforce, true);
  });

  it("asks for no preset, so the daemon's own surface applies", () => {
    assert.equal(config.toolsPreset, "core");
  });
});

describe("the global sidecar", () => {
  const config = resolve(
    {},
    {
      [GLOBAL_SIDECAR]: JSON.stringify({
        bin: "/opt/gortex/bin/gortex",
        hook_mode: "enrich",
        enforce: false,
        tools_preset: "nav",
      }),
    },
  );

  it("supplies the binary", () => {
    assert.equal(config.bin, "/opt/gortex/bin/gortex");
  });

  it("supplies the posture", () => {
    assert.deepEqual(config.hookArgv, ["/opt/gortex/bin/gortex", "hook", "--agent=pi", "--mode=enrich"]);
  });

  it("can turn enforcement off, the way --no-hooks did", () => {
    assert.equal(config.enforce, false);
  });

  it("supplies the preset", () => {
    assert.equal(config.toolsPreset, "nav");
  });
});

describe("a project sidecar beside a global one", () => {
  const config = resolve(
    {},
    {
      [GLOBAL_SIDECAR]: JSON.stringify({ bin: "/global/gortex", hook_mode: "enrich", enforce: false }),
      [PROJECT_SIDECAR]: JSON.stringify({ bin: "/project/gortex", hook_mode: "nudge" }),
    },
  );

  it("wins where it speaks", () => {
    assert.equal(config.bin, "/project/gortex");
    assert.deepEqual(config.hookArgv, ["/project/gortex", "hook", "--agent=pi", "--mode=nudge"]);
  });

  it("falls through to the global file where it is silent", () => {
    assert.equal(config.enforce, false);
  });
});

describe("the environment", () => {
  const config = resolve(
    { GORTEX_BIN: "/env/gortex", GORTEX_HOOK_MODE: "consult-unlock", GORTEX_ENFORCE: "0", GORTEX_TOOLS: "edit" },
    { [PROJECT_SIDECAR]: JSON.stringify({ bin: "/project/gortex", hook_mode: "enrich", enforce: true }) },
  );

  it("overrides every sidecar", () => {
    assert.equal(config.bin, "/env/gortex");
    assert.deepEqual(config.hookArgv, ["/env/gortex", "hook", "--agent=pi", "--mode=consult-unlock"]);
    assert.equal(config.enforce, false);
    assert.equal(config.toolsPreset, "edit");
  });
});

describe("a malformed sidecar", () => {
  const config = resolve({}, { [PROJECT_SIDECAR]: "{ not json" });

  it("falls back to defaults rather than taking the extension down", () => {
    assert.equal(config.bin, DEFAULT_BIN);
    assert.equal(config.enforce, true);
  });
});

describe("hook postures", () => {
  it("passes the ones the Go side names", () => {
    assert.equal(normalizeMode("enrich"), "enrich");
    assert.equal(normalizeMode("consult-unlock"), "consult-unlock");
    assert.equal(normalizeMode("nudge"), "nudge");
    assert.equal(normalizeMode("adaptive-nudge"), "nudge");
  });

  it("collapses anything else onto deny, the hook's own default", () => {
    assert.equal(normalizeMode("deny"), "deny");
    assert.equal(normalizeMode(""), "deny");
    assert.equal(normalizeMode(undefined), "deny");
    assert.equal(normalizeMode("ENRICH-ish"), "deny");
  });

  it("leaves deny off the argv entirely", () => {
    const config = resolve({ GORTEX_HOOK_MODE: "deny" });
    assert.deepEqual(config.hookArgv, [DEFAULT_BIN, "hook", "--agent=pi"]);
  });
});

describe("sidecar locations", () => {
  it("reads the project file first, then the agent directory", () => {
    assert.deepEqual(sidecarPaths(CWD, AGENT_DIR), [
      path.join(CWD, ".pi", "gortex.json"),
      path.join(AGENT_DIR, "extensions", "gortex.json"),
    ]);
  });

  it("honours Pi's own agent-dir override", () => {
    assert.equal(defaultAgentDir({ PI_CODING_AGENT_DIR: "/custom/agent" }), "/custom/agent");
  });
});

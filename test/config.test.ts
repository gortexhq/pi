// Configuration resolution: the contract `gortex init` writes against once it
// starts emitting a `gortex.json` sidecar.
//
// Why this suite exists: resolution order and the fallbacks around it are the
// whole configuration surface, and a layer resolved wrong runs the session
// against the wrong binary or posture without complaining. Pi plays no part
// here, so this stays a pure unit test.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import path from "node:path";

import {
  DEFAULT_BIN,
  defaultAgentDir,
  expandHome,
  normalizeMode,
  resolveConfig,
  sidecarPaths,
  toolsSpec,
} from "../src/config.ts";

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
    assert.equal(config.toolsPreset, "");
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
    assert.deepEqual(config.hookArgv, ["/global/gortex", "hook", "--agent=pi", "--mode=nudge"]);
  });

  it("falls through to the global file where it is silent", () => {
    assert.equal(config.enforce, false);
  });

  it("cannot choose the binary", () => {
    assert.equal(config.bin, "/global/gortex");
  });
});

describe("a project sidecar alone", () => {
  const config = resolve({}, { [PROJECT_SIDECAR]: JSON.stringify({ bin: "./tools/gortex" }) });

  it("leaves the binary on PATH", () => {
    assert.equal(config.bin, DEFAULT_BIN);
    assert.deepEqual(config.hookArgv, [DEFAULT_BIN, "hook", "--agent=pi"]);
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

  it("expands every home form in the agent-dir override", () => {
    assert.equal(defaultAgentDir({ PI_CODING_AGENT_DIR: "~" }), homedir());
    assert.equal(defaultAgentDir({ PI_CODING_AGENT_DIR: "~/agent" }), path.join(homedir(), "agent"));
    assert.equal(defaultAgentDir({ PI_CODING_AGENT_DIR: "~\\agent" }), path.join(homedir(), "agent"));
  });
});

describe("home expansion", () => {
  it("expands ~, ~/ and ~\\ only", () => {
    assert.equal(expandHome("~", "/h"), "/h");
    assert.equal(expandHome("~/bin/gortex", "/h"), path.join("/h", "bin/gortex"));
    assert.equal(expandHome("~\\bin\\gortex.exe", "/h"), path.join("/h", "bin\\gortex.exe"));
    assert.equal(expandHome("~other/gortex", "/h"), "~other/gortex");
    assert.equal(expandHome("/abs/~/gortex", "/h"), "/abs/~/gortex");
  });
});

// Why: a relative or ~ `bin` resolved against wherever Pi was launched, so it
// worked only from one directory, and `~` never resolved at all.
describe("bin resolution", () => {
  const bin = (env: Record<string, string | undefined>, map: Record<string, string> = {}) => resolve(env, map).bin;

  it("anchors a relative global-sidecar bin at the sidecar's directory", () => {
    const config = resolve({}, { [GLOBAL_SIDECAR]: JSON.stringify({ bin: "./gortex-shim" }) });
    const expected = path.resolve(AGENT_DIR, "extensions", "gortex-shim");
    assert.equal(config.bin, expected);
    assert.equal(config.hookArgv[0], expected);
    assert.equal(bin({}, { [GLOBAL_SIDECAR]: JSON.stringify({ bin: "../bin/gortex" }) }), path.resolve(AGENT_DIR, "bin", "gortex"));
  });

  it("expands ~ in the global sidecar and the environment", () => {
    assert.equal(bin({}, { [GLOBAL_SIDECAR]: JSON.stringify({ bin: "~/.local/bin/gortex" }) }), path.join(homedir(), ".local/bin/gortex"));
    assert.equal(bin({ GORTEX_BIN: "~/.local/bin/gortex" }), path.join(homedir(), ".local/bin/gortex"));
    assert.equal(bin({ GORTEX_BIN: "~\\gortex.exe" }), path.join(homedir(), "gortex.exe"));
  });

  it("anchors a relative GORTEX_BIN at the process cwd", () => {
    assert.equal(bin({ GORTEX_BIN: "./tools/gortex" }), path.resolve("tools/gortex"));
  });

  it("leaves a bare name and an absolute path alone", () => {
    assert.equal(bin({}, { [GLOBAL_SIDECAR]: JSON.stringify({ bin: "gortex-dev" }) }), "gortex-dev");
    assert.equal(bin({ GORTEX_BIN: "/opt/gortex" }), "/opt/gortex");
  });
});

// Why: GORTEX_TOOLS skipped the check the sidecar value got, so a typo reached
// Gortex as a one-tool allow-list, and `core`/`full` meant different surfaces
// depending on which layer named them.
describe("tool presets", () => {
  it("drops a lone unrecognised word from either layer", () => {
    assert.equal(toolsSpec("edti"), undefined);
    assert.equal(resolve({ GORTEX_TOOLS: "edti" }).toolsPreset, "");
    assert.equal(resolve({}, { [PROJECT_SIDECAR]: JSON.stringify({ tools_preset: "Edti" }) }).toolsPreset, "");
  });

  it("lets a rejected environment value fall through to the sidecars", () => {
    const config = resolve({ GORTEX_TOOLS: "edti" }, { [GLOBAL_SIDECAR]: JSON.stringify({ tools_preset: "nav" }) });
    assert.equal(config.toolsPreset, "nav");
  });

  it("gives every preset the same meaning from either layer", () => {
    for (const preset of ["core", "full", "edit", "nav", "readonly", "agent", "localization"]) {
      const fromEnv = resolve({ GORTEX_TOOLS: preset }).toolsPreset;
      const fromSidecar = resolve({}, { [PROJECT_SIDECAR]: JSON.stringify({ tools_preset: preset }) }).toolsPreset;
      assert.equal(fromEnv, preset);
      assert.equal(fromSidecar, preset);
    }
  });

  it("normalises case and whitespace the way Gortex does", () => {
    assert.equal(toolsSpec(" Core "), "core");
    assert.equal(toolsSpec("Read-Only"), "read-only");
    assert.equal(toolsSpec("facade-v1"), "facade-v1");
  });

  it("passes a spec that opens with a preset", () => {
    assert.equal(toolsSpec("nav,+edit_file"), "nav,+edit_file");
    assert.equal(toolsSpec(" Core , -analyze ,find_files"), "core,-analyze,find_files");
  });

  it("drops a spec Gortex would read as a bare allow-list", () => {
    assert.equal(toolsSpec("+edit_file"), undefined);
    assert.equal(toolsSpec("-analyze"), undefined);
    assert.equal(toolsSpec("edti,+edit_file"), undefined);
    assert.equal(toolsSpec("search_symbols,edit_file"), undefined);
    assert.equal(toolsSpec(","), undefined);
  });

  it("ignores a non-string sidecar value", () => {
    assert.equal(resolve({}, { [PROJECT_SIDECAR]: JSON.stringify({ tools_preset: 3 }) }).toolsPreset, "");
  });
});

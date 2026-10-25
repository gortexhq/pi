// The process seam on Windows: a `gortex` installed as a `.cmd` or `.bat` shim,
// as npm installs it, has to reach the hook as it reaches Pi's MCP, which
// spawns it through cross-spawn.
//
// Why this suite exists: Node refuses to spawn batch files directly, and the
// hook bridge swallows the error, so a shim install would lose the briefing
// and read discipline with nothing reporting it. Resolution and escaping are
// pure and run everywhere. Spawning a real batch file, and killing the tree
// under it, runs on Windows only, which CI covers.

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { batchCommand, nodeProcessDeps, resolveExecutable } from "../src/runtime.ts";

import { exits, pidFrom } from "./support/fixtures.ts";

const ROOT = mkdtempSync(path.join(tmpdir(), "pi-gortex-runtime-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

function dirWith(name: string, files: Record<string, string>): string {
  const dir = path.join(ROOT, name);
  mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) writeFileSync(path.join(dir, file), content);
  return dir;
}

describe("executable resolution on Windows", () => {
  // npm's global install: a sh script and a cmd shim side by side.
  const npm = dirWith("npm", { gortex: "#!/bin/sh\n", "gortex.cmd": "@echo off\r\n" });

  it("finds the cmd shim through PATHEXT, past the sh script npm puts beside it", () => {
    const env = { PATH: `${ROOT};${npm}`, PATHEXT: ".com;.exe;.bat;.cmd" };
    assert.equal(resolveExecutable("gortex", env, "win32"), path.join(npm, "gortex.cmd"));
  });

  it("prefers an exe listed earlier in PATHEXT", () => {
    const both = dirWith("both", { "gortex.exe": "", "gortex.cmd": "" });
    assert.equal(resolveExecutable("gortex", { PATH: both, PATHEXT: ".exe;.cmd" }, "win32"), path.join(both, "gortex.exe"));
  });

  it("takes a name that already carries an extension as written", () => {
    assert.equal(resolveExecutable("gortex.cmd", { PATH: npm, PATHEXT: ".exe" }, "win32"), path.join(npm, "gortex.cmd"));
    assert.equal(resolveExecutable(path.join(npm, "gortex.cmd"), {}, "win32"), path.join(npm, "gortex.cmd"));
  });

  it("finds nothing when only the sh script is there", () => {
    const sh = dirWith("sh-only", { gortex: "#!/bin/sh\n" });
    assert.equal(resolveExecutable("gortex", { PATH: sh }, "win32"), undefined);
  });
});

describe("batch file invocation", () => {
  it("runs the command through cmd.exe with cross-spawn's escaping", () => {
    assert.deepEqual(batchCommand("gortex", ["hook", "--agent=pi"]), {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", '"gortex ^"hook^" ^"--agent=pi^""'],
    });
  });

  it("escapes cmd.exe metacharacters in the path and quotes in arguments", () => {
    const { command, args } = batchCommand("C:\\Program Files (x86)\\gortex.cmd", ['a"b', "c\\"], "C:\\cmd.exe");
    assert.equal(command, "C:\\cmd.exe");
    assert.equal(args[3], '"C:\\Program^ Files^ ^(x86^)\\gortex.cmd ^"a\\^"b^" ^"c\\\\^""');
  });
});

describe("spawning a batch file", { skip: process.platform !== "win32" && "Windows only" }, () => {
  const shim = "@echo off\r\necho args %*\r\nset /p input=\r\necho input %input%\r\n";

  it("runs a cmd shim found through PATH", async () => {
    const dir = dirWith("on-path", { "gortex.cmd": shim });
    const saved = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${saved ?? ""}`;
    try {
      const out = await nodeProcessDeps.execFile("gortex", ["hook", "--agent=pi"], { input: '{"event":"x"}\n' });
      assert.match(out, /args "hook" "--agent=pi"/);
      assert.match(out, /input \{"event":"x"\}/);
    } finally {
      process.env.PATH = saved;
    }
  });

  it("runs a bat file by a path with spaces and parentheses", async () => {
    const dir = dirWith("Program Files (x86)", { "gortex.bat": shim });
    const out = await nodeProcessDeps.execFile(path.join(dir, "gortex.bat"), ["hook"], { input: "{}" });
    assert.match(out, /args "hook"/);
  });

  // Node would kill cmd.exe alone and leave the gortex under it running.
  function hangingShim(name: string): { shim: string; pidFile: string } {
    const dir = dirWith(name, {
      "hang.js": 'require("node:fs").writeFileSync(process.argv[2], String(process.pid)); setTimeout(() => {}, 60000);',
    });
    const pidFile = path.join(dir, "gortex.pid");
    const shim = path.join(dir, "gortex.cmd");
    writeFileSync(shim, `@"${process.execPath}" "${path.join(dir, "hang.js")}" "${pidFile}"\r\n`);
    return { shim, pidFile };
  }

  it("kills the gortex under cmd.exe when the signal aborts", async () => {
    const { shim, pidFile } = hangingShim("abort-tree");
    const controller = new AbortController();
    const running = nodeProcessDeps.execFile(shim, ["hook"], { signal: controller.signal });
    const pid = await pidFrom(pidFile);
    controller.abort();
    await assert.rejects(running);
    assert.equal(await exits(pid), true);
  });

  it("kills the gortex under cmd.exe when it outlives its timeout", async () => {
    const { shim, pidFile } = hangingShim("timeout-tree");
    const running = nodeProcessDeps.execFile(shim, ["hook"], { timeout: 3_000 });
    const pid = await pidFrom(pidFile);
    await assert.rejects(running);
    assert.equal(await exits(pid), true);
  });
});

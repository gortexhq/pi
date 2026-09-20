// Configuration resolution: environment, then a project sidecar, then a global
// one, then defaults; first hit wins. The README documents the keys.
//
// A missing or malformed file is never fatal and falls through to the next
// layer, because losing the graph tools over a stray comma would be a worse
// failure than running with defaults.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The sidecar file's on-disk shape. `gortex init` is its writer. */
export interface SidecarConfig {
  /** Absolute path to the gortex binary. Default: resolved from PATH. */
  bin?: string;
  /** Hook posture: deny | enrich | consult-unlock | nudge. */
  hook_mode?: string;
  /** false mirrors `gortex init --no-hooks`: orientation only, no enforcement. */
  enforce?: boolean;
  /** Eager MCP tool preset: core | full | edit | nav | readonly. */
  tools_preset?: string;
}

/** Everything the extension needs to run, fully resolved. */
export interface GortexConfig {
  /** Binary used for `daemon start`, `mcp` and `hook`. */
  bin: string;
  /** Full argv for the hook bridge, e.g. [bin, "hook", "--agent=pi", "--mode=enrich"]. */
  hookArgv: string[];
  /** Whether to wire read-discipline enforcement onto tool_call. */
  enforce: boolean;
  /** Eager tool preset; the daemon's default applies when this is core/full. */
  toolsPreset: string;
}

/** Seams for tests; every one defaults to the real environment. */
export interface ResolveConfigOptions {
  env?: Record<string, string | undefined>;
  cwd?: string;
  /** Pi's agent directory. Default: $PI_CODING_AGENT_DIR, else ~/.pi/agent. */
  agentDir?: string;
  readFile?: (path: string) => string;
}

export const DEFAULT_BIN = "gortex";
export const DEFAULT_TOOLS_PRESET = "core";

/**
 * Pi's agent directory, resolved the way Pi itself resolves it
 * (config.ts::getAgentDir in @earendil-works/pi-coding-agent).
 *
 * Re-derived here because the extension keeps zero runtime dependencies, so it
 * also loads as a bare directory extension with no node_modules beside it.
 * Pi's types are imported as types only, and erased.
 */
export function defaultAgentDir(env: Record<string, string | undefined> = process.env): string {
  const override = env.PI_CODING_AGENT_DIR;
  if (override && override.trim() !== "") {
    const path = override.trim();
    if (path === "~") return homedir();
    if (path.startsWith("~/")) return join(homedir(), path.slice(2));
    return path;
  }
  return join(homedir(), ".pi", "agent");
}

/** Sidecar paths, nearest first. A project file wins over the global one. */
export function sidecarPaths(cwd: string, agentDir: string): string[] {
  return [join(cwd, ".pi", "gortex.json"), join(agentDir, "extensions", "gortex.json")];
}

function readSidecar(path: string, readFile: (p: string) => string): SidecarConfig {
  let raw: string;
  try {
    raw = readFile(path);
  } catch {
    return {}; // absent is the common case
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" ? (parsed as SidecarConfig) : {};
  } catch {
    // Malformed JSON falls through to the next layer. Nothing here can log
    // without corrupting Pi's TUI.
    return {};
  }
}

/**
 * Hook postures the Go side accepts. Anything unrecognised (including empty)
 * collapses to "deny", which is also the hook's own default.
 */
export function normalizeMode(mode: string | undefined): string {
  switch ((mode ?? "").trim().toLowerCase()) {
    case "enrich":
      return "enrich";
    case "consult-unlock":
      return "consult-unlock";
    case "nudge":
    case "adaptive-nudge":
      return "nudge";
    default:
      return "deny";
  }
}

/** Accepts the spellings a shell user reaches for; anything else is undefined. */
export function parseBoolean(value: string | undefined): boolean | undefined {
  switch ((value ?? "").trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      return undefined;
  }
}

function firstString(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

export function resolveConfig(opts: ResolveConfigOptions = {}): GortexConfig {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const agentDir = opts.agentDir ?? defaultAgentDir(env);
  const readFile = opts.readFile ?? ((path: string) => readFileSync(path, "utf8"));

  const [project, global] = sidecarPaths(cwd, agentDir).map((path) => readSidecar(path, readFile));

  // `gortex` unqualified is resolved by spawn against PATH.
  const bin = firstString(env.GORTEX_BIN, project?.bin, global?.bin) ?? DEFAULT_BIN;

  const mode = normalizeMode(firstString(env.GORTEX_HOOK_MODE, project?.hook_mode, global?.hook_mode));
  const hookArgv = [bin, "hook", "--agent=pi"];
  // "deny" is the hook's own default, so it rides as an absent flag.
  if (mode !== "deny") hookArgv.push(`--mode=${mode}`);

  const enforce =
    parseBoolean(env.GORTEX_ENFORCE) ??
    (typeof project?.enforce === "boolean" ? project.enforce : undefined) ??
    (typeof global?.enforce === "boolean" ? global.enforce : undefined) ??
    true;

  const toolsPreset =
    firstString(env.GORTEX_TOOLS, project?.tools_preset, global?.tools_preset) ?? DEFAULT_TOOLS_PRESET;

  return { bin, hookArgv, enforce, toolsPreset };
}

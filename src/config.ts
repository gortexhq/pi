// Configuration resolution: environment, then a project sidecar, then a global
// one, then defaults; first hit wins. The README documents the keys.
//
// A missing or malformed file is never fatal and falls through to the next
// layer, because losing the graph tools over a stray comma would be a worse
// failure than running with defaults.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** The sidecar file's on-disk shape. `gortex init` is its writer. */
export interface SidecarConfig {
  /** The gortex binary. Global sidecar only; relative to the sidecar's directory. Default: resolved from PATH. */
  bin?: string;
  /** Hook posture: deny | enrich | consult-unlock | nudge. */
  hook_mode?: string;
  /** false mirrors `gortex init --no-hooks`: orientation only, no enforcement. */
  enforce?: boolean;
  /** Eager MCP tool preset (core | full | agent | edit | nav | readonly | localization) or a tool spec. */
  tools_preset?: string;
}

/** Everything the extension needs to run, fully resolved. */
export interface GortexConfig {
  /** Binary Pi runs as the `gortex mcp` server, and the hook bridge runs as `hook`. */
  bin: string;
  /** Full argv for the hook bridge, e.g. [bin, "hook", "--agent=pi", "--mode=enrich"]. */
  hookArgv: string[];
  /** Whether to wire read-discipline enforcement onto tool_call. */
  enforce: boolean;
  /** GORTEX_TOOLS for `gortex mcp`; empty leaves the daemon's default surface. */
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
/** No preset: `gortex mcp` serves the daemon's default surface. */
export const DEFAULT_TOOLS_PRESET = "";

/** Expands a leading `~`, `~/` or `~\` to the home directory. */
export function expandHome(path: string, home: string = homedir()): string {
  if (path === "~") return home;
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(home, path.slice(2));
  return path;
}

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
  if (override && override.trim() !== "") return expandHome(override.trim());
  return join(homedir(), ".pi", "agent");
}

/**
 * A `bin` setting as spawn needs it: `~` expanded, a relative path anchored at
 * `baseDir`, a bare name left for PATH lookup.
 */
export function resolveBin(bin: string, baseDir: string): string {
  const expanded = expandHome(bin);
  if (!/[\\/]/.test(expanded) || isAbsolute(expanded)) return expanded;
  return resolve(baseDir, expanded);
}

// Preset names and aliases Gortex accepts (internal/mcp/tool_presets.go).
const KNOWN_PRESETS = new Set([
  "full", "all",
  "core", "default", "classic",
  "agent", "coding-agent",
  "facade-v1", "agent-v2", "compact", "facade",
  "readonly", "read-only", "read_only",
  "edit", "editor", "edit-harness",
  "nav", "navigate", "explore",
  "localization", "locate", "find",
]);

/**
 * A tools_preset / GORTEX_TOOLS value Gortex should see, or undefined. Gortex
 * reads a spec that does not open with a preset as a bare allow-list, so a
 * typo (or `+tool` alone) would strip the session down to a tool or two. Only
 * a spec opening with a known preset passes, optionally followed by
 * comma-separated tool names and `+tool`/`-tool` changes.
 */
export function toolsSpec(value: string | undefined): string | undefined {
  const tokens = (value ?? "").split(",").map((token) => token.trim()).filter(Boolean);
  const preset = tokens[0]?.toLowerCase();
  if (preset === undefined || !KNOWN_PRESETS.has(preset)) return undefined;
  return [preset, ...tokens.slice(1)].join(",");
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

  const [projectPath, globalPath] = sidecarPaths(cwd, agentDir) as [string, string];
  const project = readSidecar(projectPath, readFile);
  const global = readSidecar(globalPath, readFile);

  // A checked-out repository must never pick the executable, so the project
  // sidecar has no say in `bin`. `gortex` unqualified is resolved against PATH.
  const envBin = firstString(env.GORTEX_BIN);
  const globalBin = firstString(global.bin);
  const bin = envBin
    ? resolveBin(envBin, process.cwd())
    : globalBin
      ? resolveBin(globalBin, dirname(globalPath))
      : DEFAULT_BIN;

  const mode = normalizeMode(firstString(env.GORTEX_HOOK_MODE, project.hook_mode, global.hook_mode));
  const hookArgv = [bin, "hook", "--agent=pi"];
  // "deny" is the hook's own default, so it rides as an absent flag.
  if (mode !== "deny") hookArgv.push(`--mode=${mode}`);

  const enforce =
    parseBoolean(env.GORTEX_ENFORCE) ??
    (typeof project.enforce === "boolean" ? project.enforce : undefined) ??
    (typeof global.enforce === "boolean" ? global.enforce : undefined) ??
    true;

  const toolsPreset =
    toolsSpec(env.GORTEX_TOOLS) ??
    toolsSpec(firstString(project.tools_preset)) ??
    toolsSpec(firstString(global.tools_preset)) ??
    DEFAULT_TOOLS_PRESET;

  return { bin, hookArgv, enforce, toolsPreset };
}

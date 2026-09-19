// The hook bridge: `gortex hook --agent=pi`. Pi has no hook configuration, so
// each event is shelled out with an envelope on stdin and the decision read
// back is applied.

import type { ExecFileSyncOpts, ProcessDeps } from "./runtime.ts";

/** The decision shape Go writes back (hooks.BridgeDecision). */
export interface PiDecision {
  block?: boolean;
  reason?: string;
  additional_context?: string;
  orientation?: string;
}

/** The envelope the extension writes to the hook's stdin (hooks.BridgeEvent). */
export interface PiEnvelope {
  event: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
  session_id?: string;
  is_gortex_tool?: boolean;
}

const HOOK_EXEC_OPTS: ExecFileSyncOpts = {
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
  timeout: 5_000,
};

/**
 * callHook sends a normalized event envelope to `gortex hook --agent=pi` and
 * parses the PiDecision it writes back. Fail-open: any error returns an empty
 * decision so the extension never blocks Pi's flow on a hook hiccup (daemon
 * down, parse error, timeout).
 */
export function callHook(argv: string[], deps: ProcessDeps, envelope: PiEnvelope): PiDecision {
  const [bin, ...args] = argv;
  if (!bin) return {};
  try {
    const out = deps
      .execFileSync(bin, args, { ...HOOK_EXEC_OPTS, input: JSON.stringify(envelope) })
      .trim();
    if (!out) return {};
    return JSON.parse(out) as PiDecision;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Tool-call normalization (Pi vocabulary -> canonical Claude-Code vocabulary)
// ---------------------------------------------------------------------------
//
// The Go classifier switches on Claude-Code tool names and canonical input
// keys ("file_path"/"pattern"/"command"), so the translation lives here.
//
// NOTE: Pi is pre-1.0. The built-in tool names mapped here are pinned to Pi's
// documented API (packages/coding-agent/docs/extensions.md); if an upgrade
// renames one, adjust this small map; the Go wire contract stays unchanged.
export const toolNameMap: Record<string, string> = {
  read: "Read",
  grep: "Grep",
  find: "Glob",
  ls: "Glob",
  bash: "Bash",
  edit: "Edit",
  write: "Write",
};

function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v !== "") return v;
  }
  return undefined;
}

export function normalizeToolCall(
  piName: string,
  piInput: Record<string, unknown>,
): { tool_name: string; tool_input: Record<string, unknown> } {
  const canonical = toolNameMap[piName.toLowerCase()] ?? piName;
  const out: Record<string, unknown> = { ...piInput };

  const path = firstString(piInput, ["file_path", "path", "file", "filepath", "absolute_path"]);
  if (path !== undefined) out.file_path = path;

  let pattern = firstString(piInput, ["pattern", "glob", "query", "regex", "name"]);
  if (pattern === undefined && canonical === "Glob") pattern = path;
  if (pattern !== undefined) out.pattern = pattern;

  const command = firstString(piInput, ["command", "cmd", "script"]);
  if (command !== undefined) out.command = command;

  return { tool_name: canonical, tool_input: out };
}

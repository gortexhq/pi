// Diffs for Gortex's file-writing tools. The daemon reports an applied edit
// without its content, so the bridge snapshots the files a call names, runs
// the call, and diffs what changed in Pi's own edit format.

import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { generateDiffString, generateUnifiedPatch, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { bareToolName, isNativeGortexTool } from "./native.ts";

export interface FileDiff {
  /** Relative to the session's cwd. */
  path: string;
  /** Empty when `note` explains why the change is not drawn as a diff. */
  diff: string;
  patch: string;
  firstChangedLine?: number;
  note?: string;
}

/**
 * A result's details: every changed file under `diffs`, plus Pi's EditToolDetails
 * fields at the top level. `patch` covers every file; `diff` and
 * `firstChangedLine` are set when exactly one file changed.
 */
export interface EditDetails {
  diffs?: FileDiff[];
  diff?: string;
  patch?: string;
  firstChangedLine?: number;
}

const MAX_FILE_BYTES = 1024 * 1024;
// Pi's line diff costs about (lines old + new) x (changed lines) and runs on
// the event loop; this budget keeps one diff to roughly a tenth of a second.
const MAX_DIFF_WORK = 2_000_000;

const LEGACY_EDIT_TOOLS = new Set(["edit_file", "write_file", "edit_symbol", "batch_edit"]);
const EDIT_OPERATIONS = new Set(["file", "symbol", "write", "batch"]);
// Argument containers the `edit` facade flattens before dispatch.
const CONTAINERS = ["arguments", "options", "source", "context", "guard", "output"];
const PATH_KEYS = ["path", "file", "file_path", "source", "destination"];
const SYMBOL_KEYS = ["id", "symbol", "symbol_id"];
// Pi's own tools that write the file named by their `path`.
const PI_WRITE_TOOLS = new Set(["edit", "write"]);

type Snapshot =
  | { kind: "missing" }
  | { kind: "text"; raw: Buffer; text: string }
  /** Not diffable. `reason` is empty when the change should pass silently. */
  | { kind: "skipped"; reason: string; size: number; mtimeMs: number };

const utf8 = new TextDecoder("utf-8", { fatal: true });

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** isFileEdit reports whether a call writes files the bridge can name up front. */
export function isFileEdit(tool: string, params: Record<string, unknown>): boolean {
  if (LEGACY_EDIT_TOOLS.has(tool)) return !isDryRun(params);
  return tool === "edit" && EDIT_OPERATIONS.has(String(params.operation)) && !isDryRun(params);
}

function isDryRun(params: Record<string, unknown>): boolean {
  return flatten(params).dry_run === true;
}

function flatten(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of CONTAINERS) Object.assign(out, asRecord(params[key]));
  for (const [key, value] of Object.entries(params)) {
    if (key === "target" || (CONTAINERS.includes(key) && typeof value === "object")) continue;
    out[key] = value;
  }
  const target = asRecord(params.target);
  if (typeof target.file === "string") out.path = target.file;
  if (typeof target.symbol === "string") out.id = target.symbol;
  return out;
}

function batchItems(value: unknown): Record<string, unknown>[] {
  let items = value;
  if (typeof items === "string") {
    try {
      items = JSON.parse(items);
    } catch {
      return [];
    }
  }
  return Array.isArray(items) ? items.map(asRecord) : [];
}

function namedPaths(entry: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of PATH_KEYS) {
    if (typeof entry[key] === "string") out.push(entry[key]);
  }
  for (const key of SYMBOL_KEYS) {
    const id = entry[key];
    if (typeof id === "string" && id.includes("::")) out.push(id.slice(0, id.indexOf("::")));
  }
  return out;
}

const repoRoots = new Map<string, string>();

/** The nearest directory at or above cwd holding `.git`, else cwd itself. */
function repoRoot(cwd: string): string {
  let root = repoRoots.get(cwd);
  if (root !== undefined) return root;
  root = cwd;
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) {
      root = dir;
      break;
    }
    if (dirname(dir) === dir) break;
  }
  repoRoots.set(cwd, root);
  return root;
}

/**
 * candidatePaths lists the disk paths a call may write. Gortex paths are
 * relative to the repo root and may carry the repo name as a first segment, so
 * both forms are tried against cwd and the repo root; a candidate that does
 * not exist simply never changes.
 */
export function candidatePaths(params: Record<string, unknown>, cwd: string): string[] {
  const args = flatten(params);
  const raw = [...namedPaths(args), ...batchItems(args.changes ?? args.edits).flatMap(namedPaths)];
  const bases = [...new Set([cwd, repoRoot(cwd)])];
  const out = new Set<string>();
  for (const name of raw) {
    if (!name) continue;
    if (isAbsolute(name)) {
      out.add(resolve(name));
      continue;
    }
    const path = name.replace(/\\/g, "/");
    const slash = path.indexOf("/");
    for (const base of bases) {
      out.add(resolve(base, path));
      if (slash > 0) out.add(resolve(base, path.slice(slash + 1)));
    }
  }
  return [...out].sort();
}

async function snapshot(path: string): Promise<Snapshot> {
  try {
    const info = await stat(path);
    const skipped = (reason: string): Snapshot => ({ kind: "skipped", reason, size: info.size, mtimeMs: info.mtimeMs });
    if (!info.isFile()) return skipped("");
    if (info.size > MAX_FILE_BYTES) return skipped("over 1 MiB");
    const raw = await readFile(path);
    if (raw.includes(0)) return skipped("binary file");
    let text: string;
    try {
      text = utf8.decode(raw);
    } catch {
      return skipped("not UTF-8 text");
    }
    return { kind: "text", raw, text: text.replace(/^﻿/, "").replace(/\r\n/g, "\n") };
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return { kind: "missing" };
    return { kind: "skipped", reason: "", size: -1, mtimeMs: -1 };
  }
}

function snapshotAll(paths: string[]): Promise<Snapshot[]> {
  return Promise.all(paths.map(snapshot));
}

function lineEnding(raw: Buffer): string {
  return raw.includes("\r\n") ? "CRLF" : "LF";
}

function hasBom(raw: Buffer): boolean {
  return raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
}

/** What changed between two texts that are equal once normalized, or "" for nothing. */
function invisibleChange(old: Buffer, now: Buffer): string {
  if (old.equals(now)) return "";
  const notes: string[] = [];
  if (lineEnding(old) !== lineEnding(now)) notes.push(`line endings ${lineEnding(old)} -> ${lineEnding(now)}`);
  if (hasBom(old) !== hasBom(now)) notes.push(hasBom(now) ? "byte order mark added" : "byte order mark removed");
  return notes.length > 0 ? notes.join(", ") : "line endings changed";
}

/** A lower bound on the work Pi's line diff does: total lines times lines not shared. */
function diffWork(old: string, now: string): number {
  const a = old.split("\n");
  const b = now.split("\n");
  const counts = new Map<string, number>();
  for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1);
  let shared = 0;
  for (const line of b) {
    const n = counts.get(line);
    if (n) {
      counts.set(line, n - 1);
      shared++;
    }
  }
  return (a.length + b.length) * (a.length + b.length - 2 * shared);
}

function textOf(s: Snapshot): string | undefined {
  if (s.kind === "missing") return "";
  return s.kind === "text" ? s.text : undefined;
}

function diffOne(path: string, old: Snapshot, now: Snapshot): FileDiff | undefined {
  const note = (text: string): FileDiff => ({ path, diff: "", patch: "", note: text });
  if (old.kind === "skipped" || now.kind === "skipped") {
    const reason = (now.kind === "skipped" ? now.reason : "") || (old.kind === "skipped" ? old.reason : "");
    const unchanged =
      old.kind === "skipped" && now.kind === "skipped" && old.size === now.size && old.mtimeMs === now.mtimeMs;
    return reason && !unchanged ? note(`not diffed: ${reason}`) : undefined;
  }
  const before = textOf(old)!;
  const after = textOf(now)!;
  if (before === after) {
    if (old.kind !== "text" || now.kind !== "text") return undefined;
    const change = invisibleChange(old.raw, now.raw);
    return change ? note(change) : undefined;
  }
  if (diffWork(before, after) > MAX_DIFF_WORK) return note("not diffed: change too large to diff quickly");
  const { diff, firstChangedLine } = generateDiffString(before, after);
  if (!diff) return undefined;
  return { path, diff, patch: generateUnifiedPatch(path, before, after), firstChangedLine };
}

function diffSnapshots(paths: string[], before: Snapshot[], after: Snapshot[], cwd: string): FileDiff[] {
  const diffs: FileDiff[] = [];
  paths.forEach((abs, i) => {
    const diff = diffOne(relative(cwd, abs) || abs, before[i]!, after[i]!);
    if (diff) diffs.push(diff);
  });
  return diffs;
}

/** editDetails shapes diffs as a result's details; no diffs give no fields. */
export function editDetails(diffs: FileDiff[]): EditDetails {
  if (diffs.length === 0) return {};
  const details: EditDetails = { diffs };
  const patch = diffs.map((d) => d.patch).join("");
  if (patch) details.patch = patch;
  if (diffs.length === 1 && diffs[0]!.diff) {
    details.diff = diffs[0]!.diff;
    if (diffs[0]!.firstChangedLine !== undefined) details.firstChangedLine = diffs[0]!.firstChangedLine;
  }
  return details;
}

// A shell command can write any file, so a diff taken while one runs may
// include its writes. Tracked on both channels through Pi's events.
const SHELL_TOOLS = new Set(["bash", "powershell"]);
const shellCallsRunning = new Set<string>();
let shellCallsSeen = 0;

/** Starts watching for shell calls; the result reports whether one overlapped. */
function shellWindow(): () => boolean {
  const busy = shellCallsRunning.size > 0;
  const seen = shellCallsSeen;
  return () => busy || shellCallsRunning.size > 0 || shellCallsSeen !== seen;
}

const SHELL_NOTE = "not diffed: a shell command ran at the same time";

function shellNotes(diffs: FileDiff[]): FileDiff[] {
  return diffs.map(({ path }) => ({ path, diff: "", patch: "", note: SHELL_NOTE }));
}

function withLocks<T>(paths: string[], fn: () => Promise<T>): Promise<T> {
  return paths.reduceRight<() => Promise<T>>((next, path) => () => withFileMutationQueue(path, next), fn)();
}

/**
 * withFileDiffs runs call while holding Pi's per-file mutation lock on every
 * candidate path, and returns its result with a diff for each file it changed.
 * A failed call is not diffed.
 */
export async function withFileDiffs<T>(
  paths: string[],
  cwd: string,
  call: () => Promise<T>,
  succeeded: (result: T) => boolean,
): Promise<{ result: T; diffs: FileDiff[] }> {
  return withLocks(paths, async () => {
    const overlapped = shellWindow();
    const before = await snapshotAll(paths);
    const result = await call();
    if (!succeeded(result)) return { result, diffs: [] };
    const diffs = diffSnapshots(paths, before, await snapshotAll(paths), cwd);
    return { result, diffs: overlapped() ? shellNotes(diffs) : diffs };
  });
}

interface PendingEdit {
  cwd: string;
  paths: string[];
  before?: Snapshot[];
  /** Per path, the other calls in flight that also write it, so a diff could mix both. */
  contested: Map<string, Set<string>>;
  overlapped?: () => boolean;
}

function contest(entry: PendingEdit, path: string, by: string): void {
  const ids = entry.contested.get(path) ?? new Set<string>();
  ids.add(by);
  entry.contested.set(path, ids);
}

/**
 * watchNativeEdits diffs the gortex tools Pi's built-in MCP runs. Pi executes
 * those, so the files are read on `tool_call` and again on `tool_result`, which
 * stores the diffs in the result's details. Pi prepares a whole parallel batch
 * before running any of it, so no lock can span the call; a path two calls in
 * flight write gets no diff instead. Register it after every handler that may
 * block, since a blocked call never reaches `tool_result`.
 */
export function watchNativeEdits(pi: ExtensionAPI, active: () => boolean): void {
  const pending = new Map<string, PendingEdit>();

  function claim(id: string, entry: PendingEdit): void {
    for (const [otherId, other] of pending) {
      for (const path of entry.paths) {
        if (!other.paths.includes(path)) continue;
        contest(other, path, id);
        contest(entry, path, otherId);
      }
    }
    pending.set(id, entry);
  }

  /** A call that ended without a result never ran, so it contests nothing. */
  function release(id: string): void {
    if (!pending.delete(id)) return;
    for (const other of pending.values()) {
      for (const ids of other.contested.values()) ids.delete(id);
    }
  }

  pi.on("tool_call", async (event, ctx: ExtensionContext) => {
    if (SHELL_TOOLS.has(event.toolName)) {
      shellCallsRunning.add(event.toolCallId);
      shellCallsSeen++;
    }
    try {
      if (!active() || event.parentToolCallId) return;
      const input = (event.input ?? {}) as Record<string, unknown>;
      const cwd = ctx.cwd;
      if (PI_WRITE_TOOLS.has(event.toolName) && typeof input.path === "string") {
        claim(event.toolCallId, { cwd, paths: [resolve(cwd, input.path)], contested: new Map() });
        return;
      }
      if (!isNativeGortexTool(event.toolName) || !isFileEdit(bareToolName(event.toolName), input)) return;
      const paths = candidatePaths(input, cwd);
      if (paths.length === 0) return;
      const overlapped = shellWindow();
      claim(event.toolCallId, { cwd, paths, before: await snapshotAll(paths), contested: new Map(), overlapped });
    } catch {
      // A throwing tool_call handler blocks the call.
    }
  });

  pi.on("tool_result", async (event) => {
    const entry = pending.get(event.toolCallId);
    if (!entry) return;
    pending.delete(event.toolCallId);
    if (!entry.before || event.isError) return;
    try {
      const paths = entry.paths.filter((p) => !entry.contested.get(p)?.size);
      const keep = entry.paths.map((p) => paths.includes(p));
      const before = entry.before.filter((_, i) => keep[i]);
      let diffs = diffSnapshots(paths, before, await snapshotAll(paths), entry.cwd);
      if (diffs.length === 0) return;
      if (entry.overlapped?.()) diffs = shellNotes(diffs);
      return { details: { ...asRecord(event.details), ...editDetails(diffs) } };
    } catch {
      return;
    }
  });

  // Pi emits this after tool_result, and also for a call another handler blocked.
  pi.on("tool_execution_end", (event) => {
    release(event.toolCallId);
    shellCallsRunning.delete(event.toolCallId);
  });
  pi.on("turn_end", () => {
    pending.clear();
    shellCallsRunning.clear();
  });
  pi.on("session_shutdown", () => {
    pending.clear();
    shellCallsRunning.clear();
  });
}

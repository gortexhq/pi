// Diffs for Gortex's file-writing tools. The daemon reports an applied edit
// without its content, so the bridge snapshots the files a call names, runs
// the call, and diffs what changed in Pi's own edit format.

import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { generateDiffString, generateUnifiedPatch, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { bareToolName, isNativeGortexTool } from "./native.ts";

export interface FileDiff {
  /** Relative to the session's cwd. */
  path: string;
  diff: string;
  patch: string;
  firstChangedLine?: number;
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

const LEGACY_EDIT_TOOLS = new Set(["edit_file", "write_file", "edit_symbol", "batch_edit"]);
const EDIT_OPERATIONS = new Set(["file", "symbol", "write", "batch"]);
// Argument containers the `edit` facade flattens before dispatch.
const CONTAINERS = ["arguments", "options", "source", "context", "guard", "output"];
const PATH_KEYS = ["path", "file", "file_path", "source", "destination"];
const SYMBOL_KEYS = ["id", "symbol", "symbol_id"];
// Pi's own tools that write the file named by their `path`.
const PI_WRITE_TOOLS = new Set(["edit", "write"]);

type Snapshot = string | null | typeof UNREADABLE;
const UNREADABLE = Symbol("unreadable");

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

/**
 * candidatePaths lists the disk paths a call may write. Gortex paths are
 * repo-relative and may carry the repo name as a first segment, so both forms
 * are tried against cwd; the one that does not exist simply never changes.
 */
export function candidatePaths(params: Record<string, unknown>, cwd: string): string[] {
  const args = flatten(params);
  const raw = [...namedPaths(args), ...batchItems(args.changes ?? args.edits).flatMap(namedPaths)];
  const out = new Set<string>();
  for (const path of raw) {
    if (!path) continue;
    if (isAbsolute(path)) {
      out.add(path);
      continue;
    }
    out.add(resolve(cwd, path));
    const slash = path.indexOf("/");
    if (slash > 0) out.add(resolve(cwd, path.slice(slash + 1)));
  }
  return [...out].sort();
}

async function snapshot(path: string): Promise<Snapshot> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return UNREADABLE;
    const text = await readFile(path, "utf8");
    if (text.includes("\0")) return UNREADABLE;
    return text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  } catch (err) {
    return (err as { code?: string }).code === "ENOENT" ? null : UNREADABLE;
  }
}

function snapshotAll(paths: string[]): Promise<Snapshot[]> {
  return Promise.all(paths.map(snapshot));
}

function diffSnapshots(paths: string[], before: Snapshot[], after: Snapshot[], cwd: string): FileDiff[] {
  const diffs: FileDiff[] = [];
  paths.forEach((abs, i) => {
    const old = before[i]!;
    const now = after[i]!;
    if (old === UNREADABLE || now === UNREADABLE || old === now) return;
    const path = relative(cwd, abs) || abs;
    const { diff, firstChangedLine } = generateDiffString(old ?? "", now ?? "");
    if (diff) diffs.push({ path, diff, patch: generateUnifiedPatch(path, old ?? "", now ?? ""), firstChangedLine });
  });
  return diffs;
}

/** editDetails shapes diffs as a result's details; no diffs give no fields. */
export function editDetails(diffs: FileDiff[]): EditDetails {
  if (diffs.length === 0) return {};
  const details: EditDetails = { diffs, patch: diffs.map((d) => d.patch).join("") };
  if (diffs.length === 1) {
    details.diff = diffs[0]!.diff;
    if (diffs[0]!.firstChangedLine !== undefined) details.firstChangedLine = diffs[0]!.firstChangedLine;
  }
  return details;
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
    const before = await snapshotAll(paths);
    const result = await call();
    if (!succeeded(result)) return { result, diffs: [] };
    return { result, diffs: diffSnapshots(paths, before, await snapshotAll(paths), cwd) };
  });
}

interface PendingEdit {
  cwd: string;
  paths: string[];
  before?: Snapshot[];
  /** Paths another call in flight also writes, so a diff could mix both. */
  contested: Set<string>;
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
    for (const other of pending.values()) {
      for (const path of entry.paths) {
        if (!other.paths.includes(path)) continue;
        other.contested.add(path);
        entry.contested.add(path);
      }
    }
    pending.set(id, entry);
  }

  pi.on("tool_call", async (event, ctx: ExtensionContext) => {
    try {
      if (!active() || event.parentToolCallId) return;
      const input = (event.input ?? {}) as Record<string, unknown>;
      const cwd = ctx.cwd;
      if (PI_WRITE_TOOLS.has(event.toolName) && typeof input.path === "string") {
        claim(event.toolCallId, { cwd, paths: [resolve(cwd, input.path)], contested: new Set() });
        return;
      }
      if (!isNativeGortexTool(event.toolName) || !isFileEdit(bareToolName(event.toolName), input)) return;
      const paths = candidatePaths(input, cwd);
      if (paths.length === 0) return;
      claim(event.toolCallId, { cwd, paths, before: await snapshotAll(paths), contested: new Set() });
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
      const paths = entry.paths.filter((p) => !entry.contested.has(p));
      const keep = entry.paths.map((p) => paths.includes(p));
      const before = entry.before.filter((_, i) => keep[i]);
      const diffs = diffSnapshots(paths, before, await snapshotAll(paths), entry.cwd);
      if (diffs.length === 0) return;
      return { details: { ...asRecord(event.details), ...editDetails(diffs) } };
    } catch {
      return;
    }
  });

  // Aborted and blocked calls never reach tool_result.
  pi.on("turn_end", () => {
    pending.clear();
  });
  pi.on("session_shutdown", () => {
    pending.clear();
  });
}

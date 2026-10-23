// TUI rendering for bridged tools: a call line read off Gortex's argument
// shape (operation, target, options), Pi's own read renderer for a file read,
// an edit's diff, and a result collapsed until the user expands it. Every
// string from the daemon is stripped of terminal controls before it is drawn,
// and every block is capped.

import { createReadToolDefinition, keyHint, renderDiff } from "@earendil-works/pi-coding-agent";
import type { Theme, ToolDefinition, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";

import type { EditDetails } from "./diff.ts";
import { textFromResult } from "./mcp-client.ts";
import { isNativeGortexTool } from "./native.ts";

type ToolRenderContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];

export type RenderCall = (args: Record<string, unknown>, theme: Theme, context: ToolRenderContext) => Component;
export type RenderResult = (
  result: unknown,
  options: { expanded?: boolean },
  theme: Theme,
  context: ToolRenderContext,
) => Component;

const OPERATION_ARGS = ["operation", "kind"];
const SUBJECT_ARGS = ["target", "query", "question", "task", "path"];
const HIDDEN_ARGS = new Set(["output", "view", "context", "to"]);
const NESTED_ARGS = new Set(["options", "arguments"]);
const HIDDEN_OPTIONS = new Set(["new_user_task"]);
const SCOPE_OPTIONS = ["repo", "project", "path", "scope", "kind", "lang"];
const MAX_VALUE_WIDTH = 60;
const PREVIEW_LINES = 10;
const NEW_FILE_PREVIEW_LINES = 10;
const MAX_EXPANDED_LINES = 1000;
const MAX_EXPANDED_CHARS = 100_000;

// CSI, OSC and DCS/SOS/PM/APC sequences in their 7-bit and 8-bit forms
// (terminated or not), other escapes, then the C0 and C1 controls except tab
// and newline.
const TERMINAL_CONTROLS =
  /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]?|(?:\x1b\]|\x9d)[^\x07\x1b\x9c]*(?:\x07|\x9c|\x1b\\)?|(?:\x1b[PX^_]|[\x90\x98\x9e\x9f])[^\x1b\x9c]*(?:\x9c|\x1b\\)?|\x1b[ -~]?|[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/** sanitize keeps a daemon string from driving the terminal: carriage returns become newlines, controls go. */
export function sanitize(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(TERMINAL_CONTROLS, "");
}

/** CallLine renders on one row cut to the terminal width, unlike Text which wraps. */
class CallLine implements Component {
  text = "";
  setText(text: string): void {
    this.text = text;
  }
  invalidate(): void {}
  render(width: number): string[] {
    return [truncateToWidth(this.text, width)];
  }
}

function isSet(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return false;
  if (typeof value === "object" && !Array.isArray(value)) return Object.keys(value).length > 0;
  return true;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** selector unwraps a target-shaped object ({file}, {symbol}, ...) to the value it selects. */
function selector(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const entry = Object.values(value).find(isSet);
  return entry ?? value;
}

/** lineNumber keeps a positive finite number; Gortex reads 0 as unset. */
function lineNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function formatValue(value: unknown, full: boolean): string {
  let s: string;
  if (typeof value === "string") s = value;
  else if (Array.isArray(value) && value.every((v) => typeof v !== "object")) s = value.join(",");
  else if (typeof value === "object") s = JSON.stringify(value);
  else s = String(value);
  s = sanitize(s).replace(/\s+/g, " ").trim();
  return full ? s : truncateToWidth(s, MAX_VALUE_WIDTH, "…");
}

/**
 * callRenderer renders `<tool> <operation> <subject> to <other> key=value...`.
 * Scope options come first so they survive the cut to the terminal width;
 * expanded, the line wraps with every value in full.
 */
export function callRenderer(name: string): RenderCall {
  return (rawArgs, theme, context) => {
    const args = asRecord(rawArgs);
    const full = context.expanded;
    const parts = [theme.fg("toolTitle", theme.bold(name))];
    const operationKey = OPERATION_ARGS.find((k) => isSet(args[k]));
    if (operationKey) parts.push(theme.fg("toolTitle", formatValue(args[operationKey], full)));
    const subjectKey = SUBJECT_ARGS.find((k) => isSet(args[k]));
    if (subjectKey) parts.push(theme.fg("accent", formatValue(selector(args[subjectKey]), full)));
    if (isSet(args.to)) parts.push(theme.fg("dim", "to"), theme.fg("accent", formatValue(selector(args.to), full)));

    const pairs: [string, unknown][] = [];
    for (const [k, v] of Object.entries(args)) {
      if (HIDDEN_ARGS.has(k) || k === operationKey || k === subjectKey) continue;
      if (NESTED_ARGS.has(k)) {
        const nested = Object.entries(asRecord(v)).filter(([nk]) => !HIDDEN_OPTIONS.has(nk));
        const rank = ([nk]: [string, unknown]) => (SCOPE_OPTIONS.includes(nk) ? 0 : 1);
        pairs.push(...nested.sort((a, b) => rank(a) - rank(b)));
      } else {
        pairs.push([k, v]);
      }
    }
    for (const [k, v] of pairs) {
      if (isSet(v)) parts.push(theme.fg("dim", `${k}=`) + theme.fg("muted", formatValue(v, full)));
    }

    const line = full ? new Text("", 0, 0) : new CallLine();
    line.setText(parts.join(" "));
    return line;
  };
}

/** GortexText marks a line rendered by Pi's own renderer as Gortex's. */
class GortexText extends Text {
  theme: Theme | undefined;
  override setText(text: string): void {
    super.setText(this.theme ? this.theme.fg("dim", "gortex ") + text : text);
  }
}

let piRead: ReturnType<typeof createReadToolDefinition> | undefined;

/**
 * readCallRenderer hands a file read to Pi's read renderer, so it shows the
 * same path, line range and skill / docs / resource labels as Pi's own read.
 * Any other read operation falls through to the generic call line.
 */
export function readCallRenderer(name: string): RenderCall {
  const generic = callRenderer(name);
  return (rawArgs, theme, context) => {
    const args = asRecord(rawArgs);
    const file = asRecord(args.target).file;
    if (typeof file !== "string" || (args.operation !== undefined && args.operation !== "file")) {
      return generic(rawArgs, theme, context);
    }
    piRead ??= createReadToolDefinition(context.cwd);
    const text = context.lastComponent instanceof GortexText ? context.lastComponent : new GortexText("", 0, 0);
    text.theme = theme;
    const options = asRecord(args.options);
    const readArgs = {
      path: file,
      offset: lineNumber(options.offset),
      limit: lineNumber(options.limit),
    };
    return piRead.renderCall!(readArgs, theme, { ...context, args: readArgs, lastComponent: text });
  };
}

export function resultText(result: unknown): string {
  const structured = (result as { structuredContent?: unknown })?.structuredContent;
  return textFromResult(result) || JSON.stringify(structured ?? result ?? {});
}

/**
 * Preview draws at most maxLines rows of its lines, then a footer naming the
 * rows it hides. Only lines that can show are wrapped, so a huge block costs
 * no more to draw than its preview.
 */
class Preview implements Component {
  readonly #lines: string[];
  readonly #cut: number;
  readonly #paddingX: number;
  readonly #maxLines: number;
  readonly #footer: (hidden: number) => string;
  #rows: { width: number; rows: string[] } | undefined;

  constructor(lines: string[], cut: number, paddingX: number, maxLines: number, footer: (hidden: number) => string) {
    this.#lines = lines.slice(0, maxLines);
    this.#cut = cut + lines.length - this.#lines.length;
    this.#paddingX = paddingX;
    this.#maxLines = maxLines;
    this.#footer = footer;
  }

  invalidate(): void {
    this.#rows = undefined;
  }

  render(width: number): string[] {
    if (this.#rows?.width === width) return this.#rows.rows;
    const all = new Text(this.#lines.join("\n"), this.#paddingX, 0).render(width);
    const rows = all.slice(0, this.#maxLines);
    const hidden = all.length - rows.length + this.#cut;
    if (hidden > 0) rows.push(truncateToWidth(" ".repeat(this.#paddingX) + this.#footer(hidden), width));
    this.#rows = { width, rows };
    return rows;
  }
}

const expandHint = (theme: Theme) => (hidden: number) =>
  `${theme.fg("muted", `... (${hidden} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
const cutHint = (theme: Theme) => (hidden: number) => theme.fg("muted", `... (${hidden} more lines not shown)`);

interface Drawn {
  stamp: string;
  parts?: DiffPart[];
  diff?: { collapsed?: Text; expanded?: Text };
  reply?: { lines: string[]; cut: number };
  sanitized?: unknown[];
}

const drawn = new WeakMap<object, Drawn>();

/** themeStamp tells themes apart: Pi passes one proxy for every theme. */
function themeStamp(theme: Theme): string {
  return theme.fg("toolDiffAdded", "+") + theme.fg("toolDiffRemoved", "-") + theme.fg("accent", "a");
}

/**
 * cache holds what part of a result renders to, built once and reused on every
 * redraw until the theme changes. Pi wraps the result in a new object on each
 * redraw, so the key is the part itself: its details or its content.
 */
function cache(part: unknown, theme: Theme): Drawn {
  const stamp = themeStamp(theme);
  if (!part || typeof part !== "object") return { stamp };
  let entry = drawn.get(part);
  if (entry?.stamp !== stamp) drawn.set(part, (entry = { stamp }));
  return entry;
}

/** DiffPart is one changed file as Pi's diff renderer draws it, below its header rows. */
interface DiffPart {
  head: string[];
  body: string[];
  created: boolean;
}

/** diffParts draws each file an edit changed with Pi's diff renderer, or nothing when the result has none. */
function diffParts(details: EditDetails, theme: Theme): DiffPart[] {
  const diffs = details.diffs ?? [];
  return diffs.map(({ path, diff, note }) => {
    if (note) return { head: ["", `${theme.fg("accent", sanitize(path))} ${theme.fg("muted", note)}`], body: [], created: false };
    const head = diffs.length > 1 ? ["", theme.fg("accent", sanitize(path))] : [""];
    const body = renderDiff(sanitize(diff), { filePath: path }).split("\n");
    return { head, body, created: diff.split("\n").every((line) => line.startsWith("+")) };
  });
}

const writeHint = (theme: Theme, hidden: number, total: number) =>
  `${theme.fg("muted", `... (${hidden} more lines, ${total} total,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;

/**
 * diffPreview draws an edit's diffs the way Pi draws its own tools: a changed
 * file's diff in full, like Pi's edit, and a created file's first lines until
 * expanded, like Pi's write.
 */
function diffPreview(result: unknown, expanded: boolean, theme: Theme): Component | undefined {
  const details = (result as { details?: EditDetails })?.details;
  if (!details?.diffs?.length) return undefined;
  const entry = cache(details, theme);
  const key = expanded ? "expanded" : "collapsed";
  if (entry.diff?.[key]) return entry.diff[key];
  const lines: string[] = [];
  entry.parts ??= diffParts(details, theme);
  for (const { head, body, created } of entry.parts) {
    const shown = expanded || !created ? body : body.slice(0, NEW_FILE_PREVIEW_LINES);
    lines.push(...head, ...shown);
    if (shown.length < body.length) lines.push(writeHint(theme, body.length - shown.length, body.length));
  }
  entry.diff ??= {};
  return (entry.diff[key] = new Text(lines.join("\n"), 1, 0));
}

/** replyLines is Gortex's text reply, sanitized and cut to MAX_EXPANDED_CHARS. */
function replyLines(result: unknown, isError: boolean, theme: Theme): { lines: string[]; cut: number } {
  const entry = cache((result as { content?: unknown })?.content, theme);
  if (entry.reply) return entry.reply;
  const text = textFromResult(result).trim();
  const kept = text.slice(0, MAX_EXPANDED_CHARS);
  const cut = kept.length < text.length ? text.slice(kept.length).split("\n").length : 0;
  const color = isError ? "error" : "toolOutput";
  const lines = text ? sanitize(kept).split("\n").map((line) => theme.fg(color, line)) : [];
  return (entry.reply = { lines, cut });
}

/**
 * preview is the result view of a bridged tool: an edit's diff, capped until
 * expanded, then Gortex's reply. A successful reply shows once expanded, an
 * error's at once, each capped.
 */
function preview(result: unknown, { expanded, isError }: { expanded: boolean; isError: boolean }, theme: Theme): Component {
  const view = new Container();
  const diff = isError ? undefined : diffPreview(result, expanded, theme);
  if (diff) view.addChild(diff);
  if (!expanded && !isError) return view;
  const { lines, cut } = replyLines(result, isError, theme);
  const max = expanded ? MAX_EXPANDED_LINES : PREVIEW_LINES;
  if (lines.length) view.addChild(new Preview(lines, cut, 0, max, expanded ? cutHint(theme) : expandHint(theme)));
  return view;
}

/**
 * renderResult shows the diff of every file an edit changed, the way Pi's own
 * edit does. Gortex's text reply stays collapsed until the user expands it
 * with ctrl+o, unless the call failed.
 */
export const renderResult: RenderResult = (result, options, theme, context) =>
  preview(result, { expanded: options.expanded === true, isError: context.isError === true }, theme);

/** sanitizedResult hands Pi's MCP renderer the result with its text stripped of terminal controls. */
function sanitizedResult<T>(result: T, theme: Theme): T {
  const content = (result as { content?: unknown })?.content;
  if (!Array.isArray(content)) return result;
  const entry = cache(content, theme);
  entry.sanitized ??= content.map((c) =>
    c?.type === "text" && typeof c.text === "string" ? { ...c, text: sanitize(c.text) } : c,
  );
  return { ...result, content: entry.sanitized };
}

/**
 * nativeRenderers draws the diffs watchNativeEdits stores above Pi's own MCP
 * result, which shows once expanded or on an error. Every other tool keeps its
 * renderers.
 */
export function nativeRenderers(toolName: string, next: () => ToolRenderers | undefined): ToolRenderers | undefined {
  const base = next();
  // Without a base, Pi's MCP extension fills in its own renderers.
  if (!base || !isNativeGortexTool(toolName)) return base;
  const baseResult = base.renderResult;
  return {
    ...base,
    renderResult(result, options, theme, context) {
      const view = new Container();
      const diff = context.isError ? undefined : diffPreview(result, options.expanded, theme);
      if (diff) view.addChild(diff);
      if (options.expanded || context.isError) {
        // Pi's renderer reuses lastComponent as its own and clears it.
        const own = baseResult?.(sanitizedResult(result, theme), options, theme, { ...context, lastComponent: undefined });
        if (own) view.addChild(own);
      }
      return view;
    },
  };
}

// How a gortex tool's result renders in Pi's TUI, layered over Pi's own MCP
// renderer: an edit's diff drawn the way Pi draws its own edits, and the reply
// stripped of terminal controls before it is drawn. Also how the post-task
// diagnostics message is drawn in the transcript.

import { getMarkdownTheme, keyHint, renderDiff } from "@earendil-works/pi-coding-agent";
import type { MessageRenderer, Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";

import type { EditDetails } from "./diff.ts";
import { isGortexTool } from "./mcp.ts";

const NEW_FILE_PREVIEW_LINES = 10;
const POST_TASK_PREVIEW_LINES = 6;

// CSI, OSC and DCS/SOS/PM/APC sequences in their 7-bit and 8-bit forms
// (terminated or not), other escapes, then the C0 and C1 controls except tab
// and newline.
const TERMINAL_CONTROLS =
  /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]?|(?:\x1b\]|\x9d)[^\x07\x1b\x9c]*(?:\x07|\x9c|\x1b\\)?|(?:\x1b[PX^_]|[\x90\x98\x9e\x9f])[^\x1b\x9c]*(?:\x9c|\x1b\\)?|\x1b[ -~]?|[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/** sanitize keeps a daemon string from driving the terminal: carriage returns become newlines, controls go. */
export function sanitize(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(TERMINAL_CONTROLS, "");
}

/** contentText joins the text parts of a message's content. */
export function contentText(content: string | readonly { type: string; text?: string }[]): string {
  if (typeof content === "string") return content;
  return content.map((c) => (c.type === "text" ? c.text : "")).filter(Boolean).join("\n");
}

interface Drawn {
  stamp: string;
  parts?: DiffPart[];
  diff?: { collapsed?: Text; expanded?: Text };
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
 * gortexRenderers draws the diffs watchEdits stores above Pi's own MCP
 * result, which shows once expanded or on an error. Every other tool keeps its
 * renderers.
 */
export function gortexRenderers(toolName: string, next: () => ToolRenderers | undefined): ToolRenderers | undefined {
  const base = next();
  // Without a base, Pi's MCP extension fills in its own renderers.
  if (!base || !isGortexTool(toolName)) return base;
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

/**
 * renderPostTask draws the post-task diagnostics as Markdown in Pi's custom
 * message box, the way Pi draws a custom message itself, their first lines
 * until expanded.
 */
export const renderPostTask: MessageRenderer = (message, { expanded }, theme) => {
  const body = sanitize(contentText(message.content)).trim().split("\n");
  const shown = expanded ? body : body.slice(0, POST_TASK_PREVIEW_LINES);
  const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
  box.addChild(new Text(theme.fg("customMessageLabel", theme.bold("Gortex")), 0, 0));
  box.addChild(new Spacer(1));
  box.addChild(new Markdown(shown.join("\n"), 0, 0, getMarkdownTheme(), { color: (t) => theme.fg("customMessageText", t) }));
  if (shown.length < body.length) box.addChild(new Text(writeHint(theme, body.length - shown.length, body.length), 0, 0));
  return box;
};

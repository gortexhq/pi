// TUI rendering for bridged tools: a call line read off Gortex's argument
// shape (operation, target, options), Pi's own read renderer for a file read,
// an edit's diff, and a result collapsed until the user expands it.

import { createReadToolDefinition, renderDiff } from "@earendil-works/pi-coding-agent";
import type { Theme, ToolDefinition, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";

import type { EditDetails } from "./diff.ts";
import { textFromResult } from "./mcp-client.ts";
import { isNativeGortexTool } from "./native.ts";

type ToolRenderContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];

export type RenderCall = (args: Record<string, unknown>, theme: Theme, context: ToolRenderContext) => Component;
export type RenderResult = (
  result: unknown,
  options: { expanded?: boolean },
  theme?: Theme,
  context?: ToolRenderContext,
) => Component;

const OPERATION_ARGS = ["operation", "kind"];
const SUBJECT_ARGS = ["target", "query", "question", "task", "path"];
const HIDDEN_ARGS = new Set(["output", "view", "context", "to"]);
const NESTED_ARGS = new Set(["options", "arguments"]);
const HIDDEN_OPTIONS = new Set(["new_user_task"]);
const SCOPE_OPTIONS = ["repo", "project", "path", "scope", "kind", "lang"];
const MAX_VALUE_CHARS = 60;

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
  s = s.replace(/\s+/g, " ").trim();
  return !full && s.length > MAX_VALUE_CHARS ? s.slice(0, MAX_VALUE_CHARS - 1) + "…" : s;
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

/** diffView draws each file an edit changed with Pi's diff renderer, or nothing when the result has none. */
function diffView(result: unknown, theme: Theme | undefined, context: ToolRenderContext | undefined): Container | undefined {
  const diffs = (result as { details?: EditDetails })?.details?.diffs;
  if (!diffs?.length || !theme || context?.isError) return undefined;
  const view = new Container();
  for (const { path, diff } of diffs) {
    view.addChild(new Spacer(1));
    if (diffs.length > 1) view.addChild(new Text(theme.fg("accent", path), 1, 0));
    view.addChild(new Text(renderDiff(diff, { filePath: path }), 1, 0));
  }
  return view;
}

/**
 * renderResult shows the diff of every file an edit changed, the way Pi's own
 * edit does. Gortex's text reply stays collapsed until the user expands it
 * with ctrl+o.
 */
export const renderResult: RenderResult = (result, options, theme, context) => {
  const text = new Text(options?.expanded ? resultText(result) : "", 0, 0);
  const view = diffView(result, theme, context);
  if (!view) return text;
  if (options?.expanded) view.addChild(text);
  return view;
};

/**
 * nativeRenderers draws the diffs watchNativeEdits stores above Pi's own MCP
 * result, which shows once expanded. Every other tool keeps its renderers.
 */
export function nativeRenderers(toolName: string, next: () => ToolRenderers | undefined): ToolRenderers | undefined {
  const base = next();
  // Without a base, Pi's MCP extension fills in its own renderers.
  if (!base || !isNativeGortexTool(toolName)) return base;
  const baseResult = base.renderResult;
  return {
    ...base,
    renderResult(result, options, theme, context) {
      // Pi's renderer reuses lastComponent as its own and clears it.
      const own = () => baseResult?.(result, options, theme, { ...context, lastComponent: undefined });
      const view = diffView(result, theme, context);
      if (!view) return own() ?? new Text("", 0, 0);
      const rest = options.expanded ? own() : undefined;
      if (rest) view.addChild(rest);
      return view;
    },
  };
}

// Draws a tool call and its result through Pi's own ToolExecutionComponent,
// the component Pi's interactive mode builds for every tool call, so a suite
// reads the rows a user would see instead of calling a renderer by hand.

import { CustomMessageComponent, ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";
import type { MessageRenderer, ToolDefinition, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";

// The component only asks its TUI for a redraw.
const ui = { requestRender() {} } as unknown as TUI;

let themed = false;

function theme(): void {
  if (themed) return;
  initTheme("dark");
  themed = true;
}

/** visible strips a component's rows down to the text a user reads, without the box's padding. */
function visible(rows: string[]): string {
  return rows
    .map((row) => stripTerminalSequences(row).trim())
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
}

interface ToolResult {
  content: { type: string; text?: string }[];
  details?: unknown;
  isError?: boolean;
}

export class Drawing {
  readonly component: ToolExecutionComponent;

  constructor(component: ToolExecutionComponent) {
    this.component = component;
  }

  /** result hands the component a finished result, the way Pi's agent loop does. */
  result(result: ToolResult): this {
    this.component.updateResult({ details: {}, isError: false, ...result }, false);
    return this;
  }

  expand(expanded = true): this {
    this.component.setExpanded(expanded);
    return this;
  }

  /** rows are the raw terminal rows, escapes included. */
  rows(width = 80): string[] {
    return this.component.render(width);
  }

  /** text is the visible text without the box's padding around it. */
  text(width = 80): string {
    return this.rows(width)
      .map((row) => stripTerminalSequences(row).trimEnd().replace(/^ /, ""))
      .join("\n")
      .replace(/^\n+|\n+$/g, "");
  }
}

/** draw builds the component Pi would for a call to `name` with these renderers. */
export function draw(
  name: string,
  renderers: ToolDefinition | ToolRenderers | undefined,
  args: Record<string, unknown>,
  cwd: string,
): Drawing {
  theme();
  const component = new ToolExecutionComponent(name, "call", args, {}, renderers, ui, cwd);
  component.setArgsComplete();
  component.markExecutionStarted();
  return new Drawing(component);
}

/** drawMessage is the visible text of a custom message drawn the way Pi's transcript draws it. */
export function drawMessage(message: Parameters<MessageRenderer>[0], renderer: MessageRenderer | undefined, expanded = false, width = 80): string {
  theme();
  const component = new CustomMessageComponent(message, renderer);
  component.setExpanded(expanded);
  return visible(component.render(width));
}

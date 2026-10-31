# Architecture

How the extension is built, and why each piece is shaped the way it is. Only
the decisions that shape it belong here; details live in the code.

## The problem

Gortex speaks MCP and owns a hook protocol that every agent it integrates with
shares. Pi 1.0 ships built-in MCP support. This extension is the adapter
between the two, and it does two separate jobs over two separate channels.

## Channel 1: Pi's built-in MCP

The extension registers `gortex mcp` with `pi.registerMcpServer()` as a stdio
server named `gortex` and leaves the tool channel to Pi. Pi spawns and connects
the server in the session's directory, which is what the proxy scopes the graph
to. It registers the tools as `mcp__gortex__<tool>`, follows
`tools/list_changed`, renders the calls and stops the child on reload and quit.
`gortex mcp` starts the shared daemon itself, so the extension starts nothing.

- **Exposure.** The server is registered with `direct` exposure, so its tools
  are declared to the model like built-in tools and Pi holds the first prompt
  until the server connects. Pi's default, codemode, would hand scripts the
  compact text results to parse.
- **Timeout.** The per-request timeout is ten minutes, generous enough for
  analyzers that legitimately run for minutes. Pi's default is a minute.
- **Wire format.** Pi's client identifies itself as `pi` and declares no
  capabilities the extension can extend. The daemon picks the compact format
  from that client name.
- **Readiness.** Pi reports neither a connection nor a failure to extensions.
  Pi loads its MCP extension after this one, so its own wait for the server
  comes later; the first turn waits for an `mcp__gortex__` tool to appear, under
  a cap that covers that wait. A binary that does not resolve is caught before
  registering, because it would otherwise read as a server still connecting.
- **Version skew.** Pi keeps the handshake to itself, so the daemon version is
  read from the readiness line of the session briefing and checked against a
  floor. Advisory only: the user is warned and the model told a tool may
  misbehave.
- **Precedence.** A `gortex` entry in Pi's own `mcp.json` replaces the
  extension's registration, exposure included.

### No tool channel

When no loaded extension connects MCP servers (as with `--no-mcp`) or the binary
does not resolve, the extension registers nothing and the first turn tells the
model graph tools are unavailable and why. When Pi refuses the registration,
another source may already supply a `gortex` server, so the first turn waits for
its tools as usual and reports the refusal only if none appear. Pi's MCP
extension and the extensions that replace it register the `/mcp` command, which
is what the connector check looks for. It runs before registering, so Pi never
reports a server nothing connects.

### Edit diffs

The daemon reports an applied edit without its content, so the extension reads
the files a write names on `tool_call` and again on `tool_result`, and stores
their diffs in the result's `details`, shaped like Pi's own edit details (see
`src/diff.ts`). The model still reads only Gortex's reply.

Pi prepares a whole parallel batch before running it, so no lock can span a
call; a file two calls in flight write gets no diff instead. A wrong diff is
worse than none, so where one could mislead or stall Pi (a shell command
running alongside, or a change a line diff cannot show cheaply) a one-line note
stands in for it.

## Channel 2: read discipline over the hook bridge

Every tool call Pi is about to run is forwarded to Gortex's hook with a
normalized event envelope, and the decision that comes back is applied: block
the call with a reason, attach non-blocking soft guidance, or do nothing.

The hook runs as a child process off Pi's event loop, so the TUI stays live
while it decides, and aborting the turn kills it. Soft guidance is appended to
the result of the call it concerns, so the model reads the two together.

Pi names its tools in its own lowercase vocabulary and shapes their inputs its
own way, while Gortex's classifier switches on canonical tool names and input
keys. That translation lives on this side of the bridge, so the Go side keeps
one vocabulary for every agent it serves.

A call to a Gortex tool is flagged as a graph call and sent under the daemon's
own tool name, with the `mcp__gortex__` prefix stripped, which is what the
postures key off. It skips the translation, so Gortex's `read` never passes for
Pi's. The same hook also sees each tool a codemode script calls.

Postures are resolved by Gortex. Keeping that decision there is what keeps the
behaviour identical across hosts. Once the first turn has waited for graph tools
and found none, tool calls are not forwarded until some appear, since blocking
Pi's reads there would leave nothing to use instead.

With enforcement off, tool calls are still forwarded, marked record-only, so
Gortex knows which files the session wrote. Their decisions are ignored.

## Post-task diagnostics

When a run completes, Gortex gets a stop with the agent's last reply, and its
findings or its block reason go back as a displayed message from
`agent_before_settle`, Pi's last boundary that can ask for one more model
request. This matches Claude Code, where a Stop hook's context also continues
the turn. Pi has no loop guard of its own, so the extension carries one: the
stop after its own continuation is flagged to Gortex and never continues
again. Aborted and failed runs skip the stop, and the stop waits for tool calls
still being recorded, since the diagnostics are scoped by them.

## Orientation injection

The session briefing is stored once in the session history as a hidden message,
so every LLM call carries it. It stays out of the system prompt, because a
change there invalidates prefix prompt caching.

Prompt hints follow the same rule. Each prompt's hints are appended after it
and never edited or removed later, since changing an earlier message would
invalidate the cache from that point on every turn. The prompt goes to Gortex
as typed, before skill expansion, which is the text Claude Code's hook gets.

## The readiness barrier

Pi arms the prompt's submit handler well before the session hook that registers
the server has run: at startup, and again on the reload and new-session paths,
which do their own work first. A fast prompt can therefore reach the agent loop
before registration has begun.

The turn waits, under a cap, for the session hook to have run on its own
instance, then for the server's tools to appear. The hold works at all because
Pi awaits each lifecycle handler in turn before moving on, a property its
documentation leaves unstated for this event and the suites verify against the
real host. The wait is armed when the extension instance is constructed,
because every session builds a fresh instance before its session hook fires. The
session hook does no async work, so overlapping sessions cannot interleave
inside it.

If a cap expires first, that turn is told the tools may not be callable yet and
pointed at a reload. Exactly one turn reports it.

## Failure posture

Fail open, everywhere. A missing binary, a daemon that is down, MCP turned off,
a refused registration, a malformed configuration file, a hook that errors:
each costs the session some capability and never takes the session down. When
graph tools are unavailable the first turn says so and names the remedy; a hook
that errors, is aborted or answers with anything but a decision yields an
empty decision, so a hiccup never blocks a tool call the user asked for.

## Configuration

Every value resolves at runtime, layered from the environment down through a
project file and a global one to defaults. See the table in the
[README](../README.md#configure). Runtime resolution is what lets one artifact
serve both the npm package and a directory install.

Resolution runs on every `session_start`, against the session's own directory.
A resumed session runs where it was created, which need not be where Pi was
launched. So the server is registered on `session_start` rather than when Pi
loads the extension. Every session, reload included, builds a fresh extension
instance, so each registers once. Pi reads a registration made before its own
`session_start` handler and connects one made after it.

A tool preset reaches `gortex mcp` only when it opens with a preset Gortex
knows. Gortex reads anything else as a bare allow-list, so a typo would strand
the session; it falls through to the next layer instead. The resolved value
always overrides an inherited `GORTEX_TOOLS`.

The project file sits in whatever repository the session runs in, so it cannot
set `bin`. Otherwise a cloned repository could choose the executable Pi spawns.
The binary comes from `GORTEX_BIN`, the global file or `PATH`.

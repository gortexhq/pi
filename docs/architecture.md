# Architecture

How the bridge is built, and why each piece is shaped the way it is. 

## The problem

Gortex speaks MCP and owns a hook protocol that every agent it integrates with
shares. Pi 0.99 added built-in MCP support; earlier Pi has none. This extension
is the adapter between the two, and it does two separate jobs over two separate
channels.

## Channel 1 on Pi 0.99+: Pi's built-in MCP

On a Pi that offers `pi.registerMcpServer()`, the extension registers
`gortex mcp` as a stdio server named `gortex` and leaves the tool channel to Pi.
Pi spawns and connects the server, registers its tools as `mcp__gortex__<tool>`,
follows `tools/list_changed`, renders the calls and stops the child on reload
and quit. `gortex mcp` starts the shared daemon itself, so the extension starts
nothing.

- **Exposure.** The server is registered with `direct` exposure, so its tools
  are declared to the model like built-in tools and Pi holds the first prompt
  until the server connects. Pi's default, codemode, would hand scripts the
  compact text results to parse.
- **Timeout.** The per-request timeout matches the tool-call cap of the
  extension's own client. Pi's default is a minute, short for some analyzers.
- **Wire format.** Pi's client identifies itself as `pi` and declares no
  capabilities the extension can extend. The daemon picks the compact format
  from that client name.
- **Readiness.** Pi reports neither a connection nor a failure to extensions. The
  first turn waits briefly beyond Pi's own wait for an `mcp__gortex__` tool to
  appear, and a binary that does not resolve is caught before registering,
  because it would otherwise read as a server still connecting.
- **Version skew.** Pi keeps the handshake to itself, so the daemon version is
  read from the readiness line of the session briefing and checked against the
  same floor.
- **Precedence.** A `gortex` entry in Pi's own `mcp.json` replaces the
  extension's registration, exposure included.

The extension keeps its own client below when Pi lacks `registerMcpServer`, when
the binary does not resolve (its spawn failure is what reaches the model), when
Pi refuses the registration (the user is warned with Pi's reason), and when
`native_mcp` is off. It also switches to it on session start when no loaded
extension connects MCP servers, as with `--no-mcp`: it withdraws the
registration then. Pi's MCP extension and the extensions that replace it
register the `/mcp` command, which is what the check looks for.

## Channel 1 on older Pi: the extension's own MCP client

One Gortex MCP child process per session, spoken to over newline-delimited
JSON-RPC on stdio. Every tool the daemon offers becomes a native Pi tool whose
implementation forwards the call down that channel.

- **Handshake.** The client identifies itself as Pi, which is the name the
  daemon picks the compact wire format from. One retry after a short backoff
  absorbs a daemon that is still warming up.
- **Version skew.** The handshake reply carries `serverInfo.version` and the
  protocol the daemon settled on. A daemon below the supported floor, or one
  answering a protocol this client does not speak, warns the user through Pi's
  warning channel and tells the model a tool may misbehave. Advisory only: the
  session keeps every tool it registered.
- **Registration.** The daemon's eager tool surface is registered up front, each
  MCP input schema passed through verbatim as the Pi tool's parameters, so the
  model reads the daemon's own parameter documentation.
- **Promotion.** The rest of the catalogue stays deferred, and the model reaches
  it through the daemon's own search tool. The daemon announces each promotion
  and the extension re-syncs the tool list into Pi's registry. Announcements
  arrive in bursts, so the re-sync is debounced; a search call awaits its own
  re-sync directly, so every tool its reply names is callable by the time the
  model reads it.
- **Framing.** Reads are incremental. The scan for a frame boundary resumes
  where the previous chunk ended, so one large frame split across many chunks
  does not re-scan a growing buffer each time. A frame past a generous size cap
  kills the child, because a stream cannot be resynced mid-frame, and the next
  call respawns it.
- **Timeouts.** Every request is bounded: a short cap for ordinary requests, a
  longer one for the handshake, the longest for tool calls. The last is generous
  enough for analyzers that legitimately run for minutes, and finite so a wedged
  daemon cannot hang an agent turn forever.

### Tool-name aliasing

Some Gortex tools share a name with a Pi built-in. Pi lets an extension silently
replace a built-in by reusing its name, which would break Pi's own rendering and
anything hooked to that built-in, so a colliding tool registers under a prefixed
alias. Every name in Pi's built-in vocabulary is guarded this way, which covers
built-ins Pi may grow later as well as today's collisions. Each aliased tool
front-loads the rename into its own description, because Gortex's guidance and
denial messages name the bare tool and the model has to map it.

### Edit diffs

The daemon reports an applied edit without its content, so the bridge reads the
files a write names before and after the call and stores their diffs in the
result's `details`, shaped like Pi's own edit details (see `src/diff.ts`). The
model still reads only Gortex's reply.

On Pi's built-in MCP the reads ride the `tool_call` and `tool_result` events.
Pi prepares a whole parallel batch before running it, so no lock can span a
call; a file two calls in flight write gets no diff instead.

## Channel 2: read discipline over the hook bridge

Every tool call Pi is about to run is forwarded to Gortex's hook with a
normalized event envelope, and the decision that comes back is applied: block
the call with a reason, attach non-blocking soft guidance, or do nothing.

Pi names its tools in its own lowercase vocabulary and shapes their inputs its
own way, while Gortex's classifier switches on canonical tool names and input
keys. That translation lives on this side of the bridge, so the Go side keeps
one vocabulary for every agent it serves.

A call to a Gortex tool is flagged as a graph call and sent under the daemon's
own tool name, which is what the postures key off. It skips the translation, so
Gortex's `read` never passes for Pi's. On Pi's built-in MCP the same hook also
sees each tool a codemode script calls.

Postures are resolved by Gortex. Keeping that decision there is what keeps the
behaviour identical across hosts.

## Orientation injection

The session briefing rides a tail user message appended during context assembly.
Carrying it in the system prompt would place it at the head of the conversation,
where a change invalidates prefix prompt caching on every turn. The text is
computed once per session and cleared only once it has been appended, so a
context shape the extension cannot append to does not silently drop it.

## The readiness barrier

Pi arms the prompt's submit handler well before the session hook that registers
tools has run: at startup, and again on the reload and new-session paths, which
do their own work first. A fast prompt can therefore reach the agent loop while
tool registration is still pending, or before it has begun at all.

The turn waits on a promise that settles when the current session hook
finishes, under a cap. The hold works at all because Pi awaits each lifecycle
handler in turn before moving on, a property its documentation leaves unstated
for this event and the suites verify against the real host. Two details
matter:

- The promise is armed when the extension instance is constructed, because every
  session builds a fresh instance before its session hook fires. An instance can
  be asked for a turn before its own hook has run.
- Each session hook invocation captures its own resolver. Overlapping
  invocations (a rapid reload, or an embedder sharing one resource loader) would
  otherwise let a stale invocation release a turn parked on a newer one.

If the cap expires first, that turn is told the tools may not be callable yet
and pointed at a reload. Exactly one turn reports it.

On Pi's built-in MCP the session hook registers nothing, and the turn waits for
the server's tools instead (see Channel 1 on Pi 0.99+).

## Session state

This applies to the extension's own client; on Pi's built-in MCP, Pi owns the
child. The live bridge, the last bridge error and the registered tool names live at
module scope, and that is load bearing. A reload re-imports the module, so the
state resets with it. A new session, a resume and a fork re-invoke the extension
factory against the cached module, and the new invocation stops the previous
invocation's child, which works only while both invocations see the same bridge.
Each invocation claims the shared slot before its first suspension point, so an
invocation that overlaps it stops that bridge instead of leaving the child
behind. State held per instance would leak a Gortex child on every new
session.

Process exit has no next invocation, so the extension also stops the bridge
from Pi's `session_shutdown` event, which fires on quit and on every
replacement path. The child is spawned unref'd, pipes included: they must
never be what holds the host's event loop open, or a print or JSON run that
finished its work hangs at exit instead of draining.

## Failure posture

Fail open, everywhere. A missing binary, a daemon that is down, a handshake that
times out, a malformed configuration file, a hook that errors: each costs the
session some capability and never takes the session down. When the bridge is
down the first turn says so and names the reload command; a hook error yields an
empty decision, so a hiccup never blocks a tool call the user asked for.

## Configuration

Every value resolves at runtime, layered from the environment down through a
project file and a global one to defaults. See the table in the
[README](../README.md#configure). Runtime resolution is what lets one artifact
serve both the npm package and a directory install.

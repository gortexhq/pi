# Architecture

How the bridge is built, and why each piece is shaped the way it is. 

## The problem

Pi has no MCP support, by design; its extension API covers the ground MCP would.
Gortex speaks MCP and owns a hook protocol that every agent it integrates with
shares. This extension is the adapter between the two, and it does two separate
jobs over two separate channels.

## Channel 1: graph tools over an MCP stdio bridge

One Gortex MCP child process per session, spoken to over newline-delimited
JSON-RPC on stdio. Every tool the daemon offers becomes a native Pi tool whose
implementation forwards the call down that channel.

- **Handshake.** The client identifies itself as Pi and advertises which compact
  wire formats it can decode, so list-shaped results arrive compact without the
  daemon needing a per-client allowlist entry. One retry after a short backoff
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

## Channel 2: read discipline over the hook bridge

Every tool call Pi is about to run is forwarded to Gortex's hook with a
normalized event envelope, and the decision that comes back is applied: block
the call with a reason, attach non-blocking soft guidance, or do nothing.

Pi names its tools in its own lowercase vocabulary and shapes their inputs its
own way, while Gortex's classifier switches on canonical tool names and input
keys. That translation lives on this side of the bridge, so the Go side keeps
one vocabulary for every agent it serves.

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

## Session state

The live bridge, the last bridge error and the registered tool names live at
module scope, and that is load bearing. A reload re-imports the module, so the
state resets with it. A new session, a resume and a fork re-invoke the extension
factory against the cached module, and the new invocation stops the previous
invocation's child, which works only while both invocations see the same bridge.
Each invocation claims the shared slot before its first suspension point, so an
invocation that overlaps it stops that bridge instead of leaving the child
behind. State held per instance would leak a Gortex child on every new
session.

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

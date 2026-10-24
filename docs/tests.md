# Tests

```sh
npm test         # node --test
npm run typecheck
npm run check    # both
```

Node 24+. The suites import the TypeScript sources directly under type
stripping, so there is no build step.

This file holds the rules a suite here follows. What a suite covers, and why it
earns its place, is stated in that suite's own header.

## Pi is real, Gortex is doubled

Pi runs for real. Every behavioural suite drives the extension through Pi's own
extension runner, loaded through Pi's own resource loader. Gortex is doubled: a
stand-in for the process seam answers `gortex hook`, so no binary is run and no
daemon is required.

Pi's MCP extension is not loaded, so nothing connects the registered server.
A suite stands in for it where it matters: a `/mcp` command and an
`mcp_servers_change` handler mark a connector as loaded, and a stand-in tool
registered under its `mcp__gortex__` name marks the server as connected. Edit
diffs are driven through the `tool_call` and `tool_result` events Pi would emit
around the call. The harness runs Pi's check for registered servers nothing
connects after every `session_start`, as Pi does.

The split follows from what each side is. Pi is the contract this extension must
not get wrong, and its lifecycle ordering is the property the readiness barrier
rests on (see [the architecture](architecture.md#the-readiness-barrier)). A
hand-written stub of that ordering would assert our own belief about Pi back to
ourselves, and would keep passing on the day Pi changed. Gortex is our own
dependency, and when its tools appear has to be controllable for a barrier to
be testable at all.

So: make Pi the oracle, and keep the daemon out of the run.

## The factory seam

Pi calls an extension factory with one argument, which would normally cost the
suite every injection point. The way through is the inline-factory closure Pi's
loader accepts:

```ts
new DefaultResourceLoader({
  cwd, agentDir,
  extensionFactories: [{ name: "gortex", factory: (pi) => gortexExtension(pi, options) }],
  noExtensions: true, /* ...and the other no* flags */
});
```

The config and the hook double ride that closure, while Pi owns the lifecycle,
the tool registry and the event payload shapes.

## Hermetic by construction

Each harness gets a temp `cwd`, a temp `agentDir` and an in-memory session
manager. The loader's `no*` flags keep the developer's own installed extensions
out. A run touches no network, no real `~/.pi`, and writes no session files.
Never resolve the real agent directory from a test, which would load whatever
the developer happens to have installed.

## Assert structure, never wall-clock

A suite that needs the tools to still be missing withholds `session_start` or
registers the stand-in tool when it decides, so the state under test holds for
as long as the machine takes, rather than flaking on a loaded CI runner. Where a
bound is asserted, it is a bound the extension itself sets, driven by a cap the
suite passes in.

## Fence what cannot be asserted

Some setups rest on a property no assertion reaches, such as no `node_modules`
sitting above a copy that must load through Pi's loader alone. A suite that
relies on one checks it and throws when it stops holding. A gate that silently
targets nothing leaves the suite green while testing nothing.

## Two properties of the real runner

- The runner swallows a handler throw into its error listener rather than
  rejecting, so a broken handler would leave the assertions around it passing.
  Every suite asserts the errors the runner collected are empty.
- The runner accepts partial action objects, so only the members this extension
  touches need implementing, which is what pi-mono's own runner tests do.

## Cover the published path once

A suite that imports the factory itself says nothing about whether the package
manifest points anywhere real, or whether Pi's loader can load the import graph.
One suite has to come in through Pi's own discovery instead, and assert the file
it loaded against the manifest, because Pi falls back to discovering an entry
point in the directory when the manifest resolves to nothing.

## Where the double stops

The double models what the suites need and no more. Behaviour past that edge,
such as Pi's MCP extension connecting a real `gortex mcp`, promotion through
`tools/list_changed`, a real model turn or a live daemon, is unverified here. A
change in that territory is verified by hand against a running Pi and Gortex,
and the suite says as much rather than implying coverage it does not have.

## Pinning

The Pi devDependency is pinned tight on purpose. Pi's runner's method surface
has been renamed without a changelog entry before, so a tight pin
turns that into a red build rather than a silently skipped suite. The runtime
peer dependency is a floor, Pi 1.0, the first Pi this extension supports.

## Layout

Shared machinery (the harness, the subject loader, the hook double, the
shared fixtures) lives in `test/support`. Per-suite choreography stays in the
suite: for the barrier, when each event fires relative to the others is the
thing under test.

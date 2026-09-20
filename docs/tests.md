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
stand-in for the process seam answers the handshake, the tool list and the tool
calls, so no binary is spawned and no daemon is required.

The split follows from what each side is. Pi is the contract this extension must
not get wrong, and its lifecycle ordering is the property the readiness barrier
rests on (see [the architecture](architecture.md#the-readiness-barrier)). A
hand-written stub of that ordering would assert our own belief about Pi back to
ourselves, and would keep passing on the day Pi changed. Gortex is our own
dependency, whose timing has to be controllable to the millisecond for a barrier
to be testable at all.

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

The config and the process double ride that closure, while Pi owns the
lifecycle, the tool registry and the event payload shapes.

## Hermetic by construction

Each harness gets a temp `cwd`, a temp `agentDir` and an in-memory session
manager. The loader's `no*` flags keep the developer's own installed extensions
out. A run touches no network, no real `~/.pi`, and writes no session files.
Never resolve the real agent directory from a test, which would load whatever
the developer happens to have installed.

## Assert structure, never wall-clock

A suite that needs registration to still be in flight gates the double and
releases it deliberately, so the state under test holds for as long as the
machine takes, rather than flaking on a loaded CI runner. Where a bound is
asserted, it is a bound the extension itself sets, driven by a cap the suite
passes in.

## Fence what cannot be asserted

Some setups rest on a property no assertion reaches, such as a child being
spawned before the handler's first suspension point. A suite that relies on one
checks it and throws when it stops holding. A gate that silently targets nothing
leaves the suite green while testing nothing.

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
such as promotion re-sync under real notification traffic, frame splitting, the
frame size cap, a real model turn or a live daemon, is unverified here. A change
in that territory is verified by hand against a running Gortex, and the suite
says as much rather than implying coverage it does not have.

## Pinning

The Pi devDependency is pinned tight on purpose. Pi is pre-1.0 and its runner's
method surface has been renamed without a changelog entry before, so a tight pin
turns that into a red build rather than a silently skipped suite. The runtime
peer dependency stays wide.

## Layout

Shared machinery (the harness, the subject loader, the process double, the
shared fixtures) lives in `test/support`. Per-suite choreography stays in the
suite: for the barrier, when each event fires relative to the others is the
thing under test.

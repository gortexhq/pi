# pi-gortex

A [Pi](https://github.com/earendil-works/pi) extension that gives the agent
[Gortex](https://github.com/zzet/gortex)'s code-graph tools, and applies
Gortex's read-discipline decisions to Pi's own tools.

### What is Gortex?

A code-intelligence engine that indexes your repositories into a queryable
knowledge graph of functions, classes, call chains, routes and cross-service
contracts, and serves it over MCP. Agents look up exactly the symbol they
need instead of reading whole files around it, which is where the token
savings come from. It is a single static binary with no dependency chain,
and it covers 257 languages through tree-sitter.

Pi has no MCP support by design, so this extension is the bridge.

## What it does

- **Registers Gortex's graph tools as native Pi tools**, over a persistent
  `gortex mcp` child per session. The deferred catalogue is reached through the
  daemon's own `tools_search`, and promoted tools appear in Pi's registry.
- **Applies read discipline.** Pi's tool calls are forwarded to
  `gortex hook --agent=pi`, which answers block / soft guidance / nothing
  according to the posture you configured. Gortex owns that logic, so the
  behaviour matches every other agent it integrates with.
- **Briefs the model once per session** with Gortex's orientation for the
  current repository.

See [docs/architecture.md](docs/architecture.md) for how it works.

## Requirements

- **Node 24+**, **Pi 0.85+**
- **The `gortex` binary** on `PATH`. See
  [Gortex installation](https://github.com/zzet/gortex/blob/main/docs/installation.md).
  The extension starts the shared daemon itself and never blocks Pi's startup
  on it.

## Install

Add it to Pi's settings, `~/.pi/agent/settings.json` for every project or
`<project>/.pi/settings.json` for one:

```json
{
  "packages": ["npm:pi-gortex"]
}
```

Leave the spec unpinned: Pi skips pinned specs during `pi update`.

For local development, point Pi at a checkout instead: a `packages` entry with
the absolute path, or a single run with `pi -e /path/to/pi-gortex`.

## Configure

Zero configuration required. Every value resolves at runtime, first hit wins:
environment -> `<cwd>/.pi/gortex.json` -> `<agent dir>/extensions/gortex.json`
(agent dir is `$PI_CODING_AGENT_DIR`, else `~/.pi/agent`) -> defaults.

| Sidecar key    | Environment        | Default            | Meaning |
|----------------|--------------------|--------------------|---------|
| `bin`          | `GORTEX_BIN`       | `gortex` on `PATH` | Binary used for `daemon start`, `mcp` and `hook`. |
| `hook_mode`    | `GORTEX_HOOK_MODE` | `deny`             | Posture: `deny`, `enrich`, `consult-unlock`, `nudge`. |
| `enforce`      | `GORTEX_ENFORCE`   | `true`             | `false` keeps the graph tools and the briefing, and wires no enforcement. |
| `tools_preset` | `GORTEX_TOOLS`     | `core`             | Eager MCP surface. `core`/`full` use the daemon's default; `edit`/`nav`/`readonly` narrow it. |

```json
{
  "bin": "/usr/local/bin/gortex",
  "hook_mode": "enrich",
  "enforce": true
}
```

**If the graph tools go missing**, the first turn of the session says so and
names `/reload` as the retry. The bridge fails open, always: an absent binary or
a daemon that is down costs the session its graph tools, never the session.

## Develop

```sh
npm install
npm test         # node --test
npm run typecheck
npm run check    # both
```

Zero runtime dependencies. Pi's types are imported as types only and erased, so
the package also loads as a bare directory extension with no `node_modules`
beside it.

The suites drive the extension through Pi's own `ExtensionRunner`;
[docs/tests.md](docs/tests.md) explains the approach and the rules a suite
follows.

## License

Apache License 2.0, the same license as
[gortex](https://github.com/zzet/gortex) itself.

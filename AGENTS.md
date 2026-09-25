# pi-gortex

A Pi extension that bridges Gortex's MCP graph tools into Pi and forwards Pi's
tool calls to `gortex hook` for read discipline. Pi has no MCP support, so this
package is the adapter.

## Commands

```sh
npm install
npm run check   # typecheck + tests; the gate CI and release run
```

Node 24+. There is no build step: Pi loads `index.ts` directly and `node --test`
runs the suites under type stripping.

## Layout

| Path | Holds |
|---|---|
| `index.ts` | Package entry Pi loads |
| `src/index.ts` | Extension factory and Pi event wiring |
| `src/mcp-client.ts` | JSON-RPC client over the `gortex mcp` child |
| `src/tools.ts` | MCP tools to Pi tool registration and promotion |
| `src/render.ts` | How a bridged tool's call and result render in Pi's TUI |
| `src/hook.ts` | Bridge to `gortex hook --agent=pi` |
| `src/config.ts` | Environment and sidecar resolution |
| `src/runtime.ts` | Injectable process seam (`spawn`, `execFileSync`) |
| `test/support/` | Harness running the extension under Pi's real runner |
| `docs/architecture.md` | How the bridge works and why |
| `docs/tests.md` | Rules every test suite follows |

## Rules

- `dependencies` stays empty. Pi packages go in `devDependencies` only; import
  them freely, since Pi's extension loader resolves them to the running Pi.
- Erasable TypeScript only, and relative imports keep their `.ts` extension.
- Never write to stdout or stderr from the extension; it corrupts Pi's TUI.
- Fail open: a missing binary or dead daemon must never break the Pi session.
- Hook decisions belong to Gortex. Do not reimplement policy in the bridge.
- Tests drive the extension through Pi's `ExtensionRunner` and double Gortex at
  the process seam. Read `docs/tests.md` before adding a suite.
- CI runs on Linux, macOS and Windows. Use `node:path` for paths and keep
  process spawning behind `src/runtime.ts`.
- Update the README configuration table and `docs/architecture.md` when
  behaviour or config changes.
- Commit subjects use Conventional Commits (`feat:`, `fix:`, `docs:`, ...).

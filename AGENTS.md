# pi-gortex

A Pi extension that brings Gortex's MCP graph tools into Pi through Pi's
built-in MCP, and forwards Pi's tool calls to `gortex hook` for read
discipline.

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
| `src/mcp.ts` | Registration with Pi's built-in MCP, readiness and version checks |
| `src/render.ts` | How a gortex tool's result renders in Pi's TUI |
| `src/diff.ts` | Diffs of the files a Gortex edit writes |
| `src/hook.ts` | Bridge to `gortex hook --agent=pi` |
| `src/config.ts` | Environment and sidecar resolution |
| `src/runtime.ts` | Injectable process seam (`execFileSync`) |
| `test/support/` | Harness running the extension under Pi's real runner |
| `docs/architecture.md` | How the extension works and why |
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
- Update the README configuration table when config changes.
- `docs/architecture.md` holds only the important design decisions, briefly:
  ones that shape how the extension works, such as its channels, the readiness
  barrier or the failure posture. A bug fix, a feature or a visual change
  (rendering, caps, wording) does not go there. Leave the file untouched
  unless such a decision changes, and leave the details to the code.
- Commit subjects use Conventional Commits (`feat:`, `fix:`, `docs:`, ...).

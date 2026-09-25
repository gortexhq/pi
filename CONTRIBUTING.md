# Contributing to pi-gortex

Thanks for helping out. This guide covers how to get a change from an idea to a
merged pull request.

## Come say hello

Day-to-day discussion for the whole Gortex project happens on Discord:

**[discord.gg/39MFHu3J5d](https://discord.gg/39MFHu3J5d)**

It's the fastest way to find out whether someone is already on the thing you
want to build, or to sanity-check a design before writing it. Issues and pull
requests remain the source of truth for anything that ships.

Please read the [Code of Conduct](CODE_OF_CONDUCT.md). Security issues go
through [SECURITY.md](SECURITY.md), never a public issue.

## Is it a bridge bug or a Gortex bug?

This repository holds only the Pi extension. The engine, the MCP tools and the
hook's decisions live in [zzet/gortex](https://github.com/zzet/gortex).

| Symptom | Where it belongs |
|---|---|
| Graph tools missing, not registered, or not promoted in Pi | here |
| Pi startup, `/reload`, session lifecycle, TUI rendering of tool results | here |
| Sidecar config (`.pi/gortex.json`) or environment variables ignored | here |
| A tool returns wrong or missing data | gortex |
| The hook blocks or allows a call it should not | gortex |
| Indexing, daemon crashes, language support | gortex |

A quick check: if the same problem shows up with `gortex call <tool>` from a
shell, or in another agent such as Claude Code, it is a Gortex issue.

## Licensing of contributions

pi-gortex is released under the [Apache License, Version 2.0](LICENSE). By
submitting a contribution you agree that it is licensed to the project under the
same terms, as described in section 5 of the License. You keep the copyright in
your contribution.

## Getting started

### Prerequisites

- Node 24+ (the suite imports TypeScript sources directly under type stripping)
- Git
- Pi and the `gortex` binary, only for trying a change by hand

### Setup

```sh
git clone https://github.com/gortexhq/pi.git pi-gortex
cd pi-gortex
npm install
```

### Checks

```sh
npm test          # node --test
npm run typecheck # tsc --noEmit
npm run check     # both, the same gate CI and the release run
```

### Trying a change in Pi

Point Pi at your checkout for a single run:

```sh
pi -e /path/to/pi-gortex
```

or put the absolute path in the `packages` list of `~/.pi/agent/settings.json`.
Use `/reload` inside Pi to pick up edits.

### What CI checks

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs `npm run typecheck`
and `npm test` on Linux, macOS and Windows. The extension spawns child
processes and resolves paths, both of which behave differently on Windows, so a
green Linux run alone is not enough.

## Ground rules

- **Zero runtime dependencies.** The package also loads as a bare directory
  extension with no `node_modules`, so `dependencies` stays empty. Pi's
  packages are imported freely and kept in `devDependencies`: Pi's extension
  loader resolves them to the running Pi. A Pi bump that breaks an import
  fails CI on the bump's own PR.
- **Erasable TypeScript only.** No enums, namespaces or parameter properties,
  and relative imports carry their real `.ts` extension. `tsconfig.json`
  enforces this.
- **Fail open.** A missing binary or a dead daemon may cost the session its
  graph tools, never the session itself.
- **Gortex owns the policy.** Read-discipline decisions come from
  `gortex hook`. The bridge forwards and renders them; it does not reimplement
  them.

## Tests

Read [docs/tests.md](docs/tests.md) before writing a suite. In short: Pi runs
for real through its own `ExtensionRunner`, and Gortex is doubled at the
process seam. New behaviour comes with a suite that drives it through Pi, and
each suite states in its header what it covers and why.

## Submitting a change

1. Fork the repository and create a branch (`feat/...`, `fix/...`).
2. Make the change, with tests.
3. Run `npm run check`.
4. Update the README configuration table and
   [docs/architecture.md](docs/architecture.md) if behaviour or config changed.
5. Open a pull request and fill in the template.

Small, focused PRs get reviewed fastest. For larger changes, open an issue or
ask on Discord first.

Commit subjects follow [Conventional Commits](https://www.conventionalcommits.org/)
(`feat:`, `fix:`, `ci:`, `docs:`, `test:`, `chore:`).

## Releases

Maintainers bump `version` in `package.json` and push a matching `v*` tag.
[`release.yml`](.github/workflows/release.yml) verifies the tag, runs the
checks, publishes to npm with provenance and creates the GitHub release. It
publishes through npm trusted publishing from the `pi-gortex-release`
environment, so no npm token is stored in the repository. Release
notes are generated from merged PR labels, grouped per
[`.github/release.yml`](.github/release.yml). Both steps skip what already
exists, so a failed run can be re-run from the tag.

## Questions?

Ask on [Discord](https://discord.gg/39MFHu3J5d) or open an issue.

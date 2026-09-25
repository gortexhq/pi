# Security Policy

## Reporting a vulnerability

1. **Do not** open a public issue.
2. Use GitHub's
   [private vulnerability reporting](https://github.com/gortexhq/pi/security/advisories/new).
3. Include a description, the affected version or commit, and steps to
   reproduce.

We aim to acknowledge reports within 48 hours and will share a timeline for a
fix.

A vulnerability in the Gortex engine, daemon or MCP tools belongs to
[zzet/gortex](https://github.com/zzet/gortex/security/advisories/new).

## Supported versions

Only the latest published `pi-gortex` release receives fixes.

## Scope

pi-gortex runs inside Pi with the user's privileges. It:

- runs the configured `gortex` binary (`daemon start`, `mcp`, `hook`),
- reads its configuration from environment variables and the sidecar files
  described in the README,
- forwards Pi tool calls to `gortex hook` and graph tool calls to the daemon.

It opens no network connections of its own. The trust model for the daemon, its
socket and the files an agent may touch is Gortex's, documented in the
[Gortex security policy](https://github.com/zzet/gortex/blob/main/SECURITY.md).

Examples of issues in scope here: running a binary other than the one the user
configured, leaking data through the bridge, or a tool call that bypasses the
read-discipline hook when enforcement is on.

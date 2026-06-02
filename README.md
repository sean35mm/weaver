# Weaver

> **Your agents, finally in sync.**
> Shared situational awareness for multiple coding agents working in the same repo.

[![CI](https://github.com/sean35mm/weaver/actions/workflows/ci.yml/badge.svg)](https://github.com/sean35mm/weaver/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/sean35mm/weaver)](./LICENSE)

**📖 Docs → <https://sean35mm.github.io/weaver/>** · 🤖 agents: [`llms.txt`](https://sean35mm.github.io/weaver/llms.txt)

Run several coding agents on one repo — Claude Code, Codex, OpenCode, Pi — and they're blind
to each other: different tools, sessions, and memories. They edit the same files, redo each
other's work, and share no picture of what's in flight. **Weaver** is a fast, local, CLI-first
coordination layer any agent can call to see who's active, what they're doing, what's claimed,
and what's been learned.

```console
$ weaver status
3 other active sessions
  claude-code   refactor the auth module       12s ago
  codex         add a Google OAuth provider     just now
  opencode      backfill auth unit tests        2m ago
⚠ src/auth/** claimed by claude-code — coordinate or work elsewhere
```

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/sean35mm/weaver/main/install.sh | sh
```

A single self-contained binary — no Node, npm, or other runtime needed. Update with
`weaver upgrade`; remove with `weaver uninstall`.

## How it works

1. **Install** — one curl line drops in a standalone binary.
2. **`weaver init`** — adds a short instruction block to `CLAUDE.md` / `AGENTS.md`.
3. **Just work** — your agents read it and coordinate on their own: announce intent, claim
   areas, check for conflicts, and leave notes.

Watch it happen with `weaver status` (snapshot), `weaver dashboard` (live web), or
`weaver watch` (live terminal).

## What you get

- **Presence & intent** — every session, across harnesses and windows, shows up with what
  it's working on.
- **Advisory claims** — agents stake out areas and get a clear conflict signal *before*
  editing, instead of silently overwriting each other.
- **Shared notes** — durable learnings that survive context compaction and new sessions.
- **Live views** — a real-time web `dashboard` and a terminal `watch`.

It's a CLI, not an MCP server, on purpose: the one interface every harness can call with no
setup. It's serverless (a local SQLite store), and git stays the source of truth for your code.
[Why CLI, not MCP →](https://sean35mm.github.io/weaver/concepts/why-cli-not-mcp/)

## Learn more

Concepts, the full command reference, the agent protocol, architecture, and configuration all
live in the docs:

### **→ <https://sean35mm.github.io/weaver/>**

Contributing: [`CONTRIBUTING.md`](./CONTRIBUTING.md) · Releases: [`RELEASING.md`](./RELEASING.md)

## License

MIT. *context* — from Latin *con-* ("together") + *texere* ("to weave"): Weaver weaves your
agents' separate contexts into one.

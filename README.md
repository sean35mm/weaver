# Weaver

> **Your agents, finally in sync.**
> Shared situational awareness for multiple coding agents working in the same repo.

**📖 Documentation → <https://sean35mm.github.io/weaver/>** · 🤖 agents: [`llms.txt`](https://sean35mm.github.io/weaver/llms.txt)

When you run several coding agents on one codebase — Claude Code, Codex, OpenCode, Pi — they're
blind to each other: different tools, sessions, and memories. They edit the same files, redo
each other's work, and share no picture of what's in flight. **Weaver** is a fast, local,
CLI-first coordination layer any agent can call to see who's active, what they're doing, what's
claimed, and what's been learned.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/sean35mm/weaver/main/install.sh | sh
```

A single self-contained binary — no Node, npm, or other runtime needed. Update with
`weaver upgrade`; remove with `weaver uninstall`.

## Use it

```sh
cd your-project
weaver init          # enable in this repo (injects CLAUDE.md / AGENTS.md)
weaver status        # who's active, what's claimed, recent activity, notes
weaver dashboard     # watch your agents coordinate, live
```

After `weaver init`, your agents coordinate on their own — announcing intent, claiming areas,
checking for conflicts, and leaving notes — because the instruction block tells them how.

## What it does

- **Presence & intent** — every session, across harnesses, shows up with what it's working on.
- **Advisory claims** — agents stake out areas and get a clear conflict signal before editing,
  instead of silently overwriting each other.
- **Shared notes** — durable learnings that survive context compaction and new sessions.
- **Live views** — a real-time web `dashboard` and a terminal `watch`.

It's a CLI, not an MCP server, on purpose: the one interface every harness can call with no
setup. It's serverless (a local SQLite store), and git stays the source of truth for your code.

## Learn more

Everything — concepts, the full command reference, the agent protocol, architecture, and
configuration — lives in the docs:

### **→ <https://sean35mm.github.io/weaver/>**

Contributing: [`CONTRIBUTING.md`](./CONTRIBUTING.md) · Releases: [`RELEASING.md`](./RELEASING.md)

## License

MIT. *context* — from Latin *con-* ("together") + *texere* ("to weave"): Weaver weaves your
agents' separate contexts into one.

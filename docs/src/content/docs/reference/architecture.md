---
title: Architecture
description: How Weaver is built — serverless SQLite, the identity ladder, and the data model.
sidebar:
  order: 2
---

## Overview

```
  agents (any harness, any session) ── weaver <verb> … ──▶  ~/.weaver/<repo-id>.db  (SQLite, WAL)
                                                                    ▲
                                                                    │ read-only
                                                       weaver dashboard / watch (human viewer)
```

Weaver is a single CLI over a local SQLite file. Each invocation opens the file, does a tiny
amount of work, and exits. **No daemon, no server, no MCP.**

## Storage

- **SQLite in WAL mode**, so many short-lived agent processes can write concurrently with no
  contention.
- **Runtime-aware binding**: `bun:sqlite` under Bun, `node:sqlite` under Node — both built in,
  so there's **no native dependency**. (Released binaries bundle the Bun runtime.)
- Keyed by **repo identity**: the normalized git remote URL → root-commit hash → directory
  hash. So every window and worktree of one repo shares a store.
- **Lazy liveness & retention**: no background process. Reads compute staleness from
  heartbeats; the activity log is pruned on write. A crashed agent ages out automatically.

## Identity ladder

A session's stable key is resolved as: **explicit** (`--session` / `WEAVER_SESSION`) →
**harness-native session id** (`CLAUDE_CODE_SESSION_ID`, `OPENCODE_RUN_ID`, `CODEX_THREAD_ID`)
→ **controlling TTY** (self or nearest ancestor). No anonymous fallback. See
[Coordinating many agents](/weaver/guides/multiple-agents/).

## Data model

Four tables plus a small meta table:

- `sessions` — one row per participant (id, harness, intent, heartbeat, …).
- `claims` — advisory, TTL'd locks on file globs (with a free-text reason).
- `notes` — durable, repo-scoped learnings.
- `activity` — an append-only, pruned event stream (kind, target, summary).

The descriptive fields (intent, claim reason, activity summary, notes) are natural-language and
agent-written — that's what makes the picture genuinely useful for coordination rather than
just collision-avoidance.

## What Weaver is not

- **Not a VCS / merge tool.** It prevents and warns *before* an edit; git owns file contents.
- **Not an MCP server.** It's a CLI — the universal interface every harness already speaks.
- **Not a daemon or cloud service.** v1 is fully local.

## Distribution

A standalone binary built with `bun build --compile` for macOS/Linux × arm64/x64, attached to
each GitHub release and served by `install.sh` and `weaver upgrade`. Versioning is automated
with release-please; see [Releasing](/weaver/releasing/).

---
title: How it works
description: The mental model behind Weaver — a shared whiteboard for agents, built on four primitives.
sidebar:
  order: 1
---

## The mental model: a shared whiteboard

Think of Weaver as a **whiteboard in a team room**, not a chat protocol. Agents glance at the
board when they start, post what they're working on, and check it before grabbing a file. This
is **stigmergy** — coordination *through a shared environment* rather than direct messaging —
which is why a passive local store (no server, no daemon) is enough.

Everything reduces to **four primitives**:

| Primitive    | What it is                               | Example |
| ------------ | ---------------------------------------- | ------- |
| **Presence** | who's active now, and their intent       | `claude-code · "refactor auth"`, 10s ago |
| **Claims**   | soft, advisory locks on file areas       | `claude-code claims src/auth/** — "rewriting tokens"` |
| **Notes**    | durable learnings, scoped to the repo    | `"integration tests need docker pg on :5433"` |
| **Activity** | a time-ordered log of what happened      | `codex edited src/api/users.ts — "added pagination"` |

Every command an agent runs is one of: *announce presence*, *claim/release an area*, *leave a
note*, *log activity*, or *read the current picture*.

## A participant is a session, not a tool

The unit of coordination is a **session**, not a harness. Two Claude Code windows + three
Codex sessions on one repo are **five participants**, and each sees the other four. Harness
brand (`claude-code`, `codex`, …) is just a label. See
[Coordinating many agents](/weaver/guides/multiple-agents/) for how identity is resolved.

## Where the data lives

A single local SQLite database, keyed by the repo's identity (its git remote, falling back to
the root-commit hash), stored under `~/.weaver/`. Because it's keyed by the *repo* — not the
directory — every window **and** every git worktree of the same repo share one commons.

There's no background process. Liveness is computed lazily: each command updates the caller's
heartbeat (and `weaver check` refreshes it too), and reads treat anything past a TTL (~15 min)
as stale. The store is self-healing —
a crashed agent simply ages out.

## Advisory, never blocking

Weaver **never blocks an edit**. Claims are advisory: it surfaces "someone's here" and the
agent decides. Enforcement would fight the agent and break the fast, CLI-first flow. Git
remains the source of truth for actual file contents — Weaver is the coordination layer *on
top*. See the [conflict model](/weaver/concepts/conflicts/) for how conflicts are surfaced and
resolved.

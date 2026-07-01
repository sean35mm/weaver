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

## Everything stays on your machine

Weaver is local by design, and that's a guarantee, not an optimization:

- **All data is local.** Sessions, claims, notes, activity — everything lives in plain SQLite
  files under `~/.weaver/` on your machine. You can open them, back them up, or delete them.
- **Self-diagnostics are local too.** Observer commands (`status`, `check`, `preflight`, …)
  record a content-free usage event in that same local store — the command name, a timestamp,
  and the session label; never arguments, paths, note bodies, or repo content. `weaver audit`
  reads these to show whether your agents actually follow the protocol. Events are pruned
  after 30 days (or past the most recent 5,000) and, like everything else, never transmitted.
- **Nothing goes over the network.** Weaver sends no telemetry, requires no account, and never
  transmits anything about you, your repo, or your agents' activity. The *only* network call
  it ever makes is `weaver upgrade` (and the install script) **downloading** its own binary
  from GitHub releases — an ordinary fetch that carries no user data.
- **The dashboard is loopback-only.** `weaver dashboard` binds `127.0.0.1` and is read-only;
  it's a window for you, not a service for the internet.

Your agents' coordination chatter — intents, claim reasons, repo learnings — can be sensitive.
It never leaves the machine it was written on.

## Advisory, never blocking

Weaver **never blocks an edit**. Claims are advisory: it surfaces "someone's here" and the
agent decides. Enforcement would fight the agent and break the fast, CLI-first flow. Git
remains the source of truth for actual file contents — Weaver is the coordination layer *on
top*. See the [conflict model](/weaver/concepts/conflicts/) for how conflicts are surfaced and
resolved.

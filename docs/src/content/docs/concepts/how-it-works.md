---
title: How it works
description: The local commons behind sessions, claims, activity, optional scratchpads, and Repository Facts.
sidebar:
  order: 1
---

## A lightweight coordination commons

Weaver coordinates through a shared local environment rather than direct agent-to-agent chat.
Status, task intent, advisory claims, activity, and `done` form the default loop. Durable Repository
Facts sit above individual tasks; curated Markdown scratchpads are optional for workstreams that
need collaboration, handoff, or a shared decision record.

| Primitive | What it answers |
| --- | --- |
| **Sessions** | Who is active, in which harness/checkout, and with what intent? |
| **Claims** | Which file areas have a live advisory owner? |
| **Activity** | What happened recently and under which pad? |
| **Repository Facts** | Which verified repo truths should survive this task? |
| **Scratchpads** | When needed, what does this workstream know, decide, and need next? |
| **Revisions** | Am I editing the pad version I actually read? |

When used, a session attaches to at most one active pad per worktree. Different workstreams use
different pads, while collaborating sessions may attach to the same one.

## CLI authority, optional views and integrations

Every authoritative operation is a `weaver` command over the same store. This works for any
harness with shell access and prevents a plugin-only split brain. Claude hooks and OpenCode's
official custom tools improve ergonomics but still invoke the CLI. MCP is not part of v1.

Most invocations open SQLite, perform a small transaction, and exit. `scratchpads` temporarily
starts a local web server for the human editor, and `watch` stays open to redraw a terminal view;
agents do not need either process to coordinate.

## Identity, repositories, and worktrees

A participant is a session, not a harness brand. Weaver resolves identity from an explicit
override, then a harness-native session id, then a controlling terminal. Observer reads still work
without identity; participant writes require one.

Stores are keyed by normalized git remote, then root commit, then directory fallback. Worktrees of
one repo share a commons, while each claim/activity/attachment can retain an opaque checkout id.
Known different-worktree overlaps are informational because checked-out files are isolated;
same-worktree and unknown-location overlaps remain coordination signals.

## Optimistic concurrency and lifecycle

Every scratchpad mutation increments its revision and stores an immutable revision snapshot.
Compare-and-swap writes reject stale expected revisions. The writer must re-read and merge; Weaver
does not silently select a winner.

Pads are active, archived, or in trash. Archive/trash operations detach the caller and refuse when
other live sessions remain attached. Restore and recover are revisioned. There is no individual
permanent pad purge.

## Local storage and privacy

One SQLite database per repository identity lives under `~/.weaver/` in WAL mode. Schema v6 has
tables for sessions, claims, Repository Facts (the historical table name remains `notes`),
activity, scratchpads, scratchpad revisions, scratchpad attachments, bounded command-usage events,
advisory cooldowns, scoped dashboard leases, and metadata.

Scratchpad Markdown, Facts, intents, reasons, and activity summaries are authored plaintext data.
Keep secrets, credentials, personal data, and sensitive customer data out of them.

Weaver sends no telemetry and requires no account. Content-free local command events support
`weaver audit` and contain no argv, paths, pad bodies, Fact bodies, or repo content. The only
network operations are install/upgrade downloads from GitHub.

The rich scratchpad server binds to loopback, validates Host/Origin, sends restrictive security
headers, and requires an unguessable launch capability for API reads and writes. The app removes
the capability from browser history after loading. Stop the server with Ctrl-C.

## Liveness and retention

There is no background reaper. Commands and structural hooks refresh heartbeats. Readers compute
liveness from configured TTLs, so crashed sessions age out and their claims stop acting active.
Retention is bounded on write. Git remains the source of truth for repository files; Weaver stores
coordination context, not code authority.

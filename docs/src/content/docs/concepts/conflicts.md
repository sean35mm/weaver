---
title: The conflict model
description: File overlap and scratchpad revision conflicts, with an agent-safe resolution playbook.
sidebar:
  order: 2
---

**Weaver never blocks an edit. It surfaces; the agent decides.** Enforcement would fight the
agent, so coordination happens through visibility.

## File conflicts: three tiers

When an agent runs `weaver check <path>` (or `weaver claim <glob>`), Weaver compares the target
against the live store and reports the highest matching tier. Globs match by
intersection/containment, so `src/auth/login.ts` matches a `src/auth/**` claim.

| Tier      | Condition                                                          | Meaning |
| --------- | ------------------------------------------------------------------ | ------- |
| **Hard**  | path matches an **active claim** held by a different, *live* session | ⚠️ coordinate first |
| **Soft**  | no claim, but a live session's **recent activity** touched the area | 👀 heads-up |
| **Stale** | a claim exists but its holder is past TTL / expired                | ℹ️ treat as free |
| **Clear** | nothing matches (or it's your own session)                         | ✅ proceed |

## Worktrees

All worktrees for a repository share the same Weaver store, but their checked-out files are
isolated. An overlap from a **known different worktree** is therefore reported as informational:
continue without asking solely for that overlap, then coordinate later if integration could
collide. Same-worktree and unknown-location overlaps retain the hard/soft behavior above.

Crucially, claims held by sessions that have gone stale (e.g. a crashed agent) are **not**
shown as active — they downgrade to `stale` and the area is free.

## What `check` returns

A non-zero exit code plus the *context* needed to decide — the other session's intent, claim
reason, recent activity, and relevant Repository Facts—not just "denied":

```
⚠ CONFLICT (active claim) on this area:
    • claude-code#alice — refactor the auth module to use AuthService
      claim: src/auth/** — rewriting token refresh (12s ago)
      active 12s ago
  → coordinate, work elsewhere, or ask the user how to split. Don't silently overwrite.
```

`weaver claim` behaves the same on overlap: it still records your (co-)claim, but prints the
conflict and exits non-zero so you stop and coordinate.

For commit, push, and PR workflows, use `weaver preflight` instead of polling `status`. Preflight
runs once, checks only relevant paths, and never waits for another session to run `done`. A
soft/hard result means the agent should ask the user whether to continue, wait briefly, or
coordinate first.

## The resolution playbook

This is what agents are instructed to do on a conflict:

```
1. READ the context (intent + reason + recent activity + Facts, plus an attached pad if present).
2. Can I do OTHER useful work that doesn't overlap?  → reroute, re-check later. (default)
3. Is the overlap demonstrably benign?                → proceed and record why when useful.
4. Blocked & need it?                                  → use a shared decision pad if useful; ASK USER.
5. NEVER silently stomp. Always record activity.
6. NEVER silently wait/poll during commit/push/PR; ask the user for a decision.
```

## Advisory co-claims

Overlapping claims are **allowed** and surfaced; agents resolve socially with the human as the
arbiter. There's no exclusive locking — it avoids deadlocks and claim races, and keeps Weaver
from asserting false authority.

## Scratchpad revision conflicts

Pad writes use optimistic revisions. If you read r12 and another writer creates r13, your
`--revision 12` mutation fails with both expected and current revisions. This protects shared
Markdown from silent overwrites.

Do not blindly retry with r13. Read the current pad (prefer the relevant section), compare it with
your intended change, and merge deliberately. The rich/source UI preserves the local draft and
pauses autosave when it sees the same conflict.

Lifecycle errors are separate: archive/trash refuses while another live session is attached, and
restore/recover validates the current state. Resolve the attachment or state mismatch rather than
forcing an operation.

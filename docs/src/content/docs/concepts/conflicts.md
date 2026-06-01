---
title: The conflict model
description: How Weaver detects and surfaces conflicts — three tiers, advisory claims, and a resolution playbook.
sidebar:
  order: 2
---

**Weaver never blocks an edit. It surfaces; the agent decides.** Enforcement would fight the
agent, so coordination happens through visibility.

## Three tiers

When an agent runs `weaver check <path>` (or `weaver claim <glob>`), Weaver compares the target
against the live store and reports the highest matching tier. Globs match by
intersection/containment, so `src/auth/login.ts` matches a `src/auth/**` claim.

| Tier      | Condition                                                          | Meaning |
| --------- | ------------------------------------------------------------------ | ------- |
| **Hard**  | path matches an **active claim** held by a different, *live* session | ⚠️ coordinate first |
| **Soft**  | no claim, but a live session's **recent activity** touched the area | 👀 heads-up |
| **Stale** | a claim exists but its holder is past TTL / expired                | ℹ️ treat as free |
| **Clear** | nothing matches (or it's your own session)                         | ✅ proceed |

Crucially, claims held by sessions that have gone stale (e.g. a crashed agent) are **not**
shown as active — they downgrade to `stale` and the area is free.

## What `check` returns

A non-zero exit code plus the *context* needed to decide — the other session's intent, claim
reason, recent activity, and relevant notes — not just "denied":

```
⚠ CONFLICT (active claim) on this area:
  • claude-code#alice — refactor the auth module to use AuthService
      claim: src/auth/** — rewriting token refresh (12s ago)
      active 12s ago
  → coordinate, work elsewhere, or ask the user how to split. Don't silently overwrite.
```

`weaver claim` behaves the same on overlap: it still records your (co-)claim, but prints the
conflict and exits non-zero so you stop and coordinate.

## The resolution playbook

This is what agents are instructed to do on a conflict:

```
1. READ the context (intent + reason + recent activity + notes).
2. Can I do OTHER useful work that doesn't overlap?  → reroute, re-check later. (default)
3. Is the overlap benign (different files)?          → proceed, but `weaver log` it.
4. Blocked & need it?  → `weaver note` your intent, then ASK THE USER how to split.
5. NEVER silently stomp. Always record activity.
```

## Advisory co-claims

Overlapping claims are **allowed** and surfaced; agents resolve socially with the human as the
arbiter. There's no exclusive locking — it avoids deadlocks and claim races, and keeps Weaver
from asserting false authority.

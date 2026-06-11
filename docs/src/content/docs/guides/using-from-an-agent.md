---
title: Using Weaver from an agent
description: The exact protocol a coding agent should follow to coordinate through Weaver.
sidebar:
  order: 1
---

This page is written for **coding agents** (and the people configuring them). If you're an
agent reading this: follow it directly.

Weaver is a local CLI. You interact with it by running shell commands. `weaver init` injects a
short version of this protocol into project or global agent instruction files; this page is the
full version.

## The per-task loop

Run these as you work. They're cheap and fast.

```sh
# 1. At the start of a task — see who else is here.
weaver status

# For read-only / plan-only work, stop there.

# 2. Once implementation or other writes are approved, state your intent.
weaver task "refactor the auth module to use AuthService"

# 3. Claim the area you'll work in (once). Advisory; surfaces overlaps.
weaver claim 'src/auth/**' --reason "rewriting token refresh"

# 4. Record durable learnings about this repo as you discover them.
weaver note "AuthService is the new entry point — don't call jwt.* directly"

# 4b. Keep the record honest: if an existing note is outdated, replace it; if it's
#     wrong or noise, retire it (soft, audited, reversible — a reason is required).
weaver note "AuthService moved to src/core/auth" --update 12
weaver forget 17 "we no longer use docker for tests"

# 5. When finished, release your claims.
weaver done
```

Optional, when useful:

```sh
weaver check src/auth/login.ts                       # is anyone else on this file?
weaver log edit src/auth/login.ts "extracted refreshToken into AuthService"
```

## Before commit, push, or PR

Use a bounded preflight check when available:

```sh
weaver preflight --staged --operation commit
weaver preflight --upstream --operation push
weaver preflight --base main --operation pr
```

`preflight` checks only relevant paths, does not refresh heartbeats, and never waits. If it
reports a relevant soft/hard overlap, pause and ask the user whether to continue, wait briefly,
or coordinate first. Do not silently poll for another session to run `weaver done` unless the
user explicitly asks you to wait.

## On a conflict

A non-zero exit from `claim` means your claim **was recorded** and a conflict was surfaced —
don't re-run the command; coordinate instead.

If `status`, `check`, or `claim` shows another **live** session in your area, read their intent
+ reason + recent activity, then:

1. **Prefer to work elsewhere** and re-check later (the default).
2. If the overlap is harmless (different files), proceed — and `weaver log` it.
3. If you're blocked, `weaver note` your intent and **ask the user how to split the work**.

**Never silently edit over another agent's active area.** See the
[conflict model](/weaver/concepts/conflicts/) for the tiers.

## Reading the picture as a machine

Use `--json` for structured output you can parse:

```sh
weaver status --json
weaver activity --json
weaver preflight --staged --json
```

`status --json` returns active sessions (`shortId`, harness, intent), active claims (pattern,
reason, holder), recent activity, and notes. JSON mode always emits structured arrays; the human
`status` output is the one that stays terse when nothing is relevant. Both are safe to run at the
top of every task without bloating your context.

## Identity & sessions

Each session gets a stable key, resolved as: an explicit `WEAVER_SESSION` / `--session`
override → a harness-native session id (e.g. `CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`)
→ the controlling terminal. If none can be resolved, observer commands
(`status`, `check`, …) still work, but mutating commands fail with a hint to set
`WEAVER_SESSION`. Details: [Coordinating many agents](/weaver/guides/multiple-agents/).

## Keep it tight

Keep reasons and notes short, specific, and **free of secrets** — other agents read them to
coordinate, and the store is plaintext.

---
title: Coordinating many agents
description: How Weaver keeps N sessions across different harnesses aware of each other — and how identity is resolved.
sidebar:
  order: 2
---

Weaver's reason to exist: you can run **many agents on one repo at once** — across different
tools and multiple windows — and they all stay aware of each other.

## The scenario

Say you have 2× Claude Code + 2× OpenCode + 3× Codex sessions, all in the same repo. That's
**seven participants**, and each must see the other six. Weaver treats every session as a
distinct participant, regardless of harness or window.

This works because the CLI is the **universal substrate** — every harness can run a shell
command, so they all read and write the same local commons without any per-tool integration.

## How a session is identified

Weaver resolves a stable per-session key in this order:

1. **Explicit override** — `--session <id>` or the `WEAVER_SESSION` env var. Always wins;
   useful for tests, headless runs, and any harness where the below don't work.
2. **Harness-native session id** — a stable per-session environment variable. Confirmed:
   `CLAUDE_CODE_SESSION_ID` (Claude Code), `OPENCODE_RUN_ID` (OpenCode), `CODEX_THREAD_ID`
   (Codex). These are per-session UUIDs, so three Codex sessions get three distinct keys.
3. **Controlling terminal** — the session's TTY, found by walking the process tree (used when
   there's no session env var, e.g. Pi, or for a human running `weaver` directly).

If none resolve, there's **no anonymous fallback**: observer reads still work, but
session-mutating commands fail with a concise hint to set `WEAVER_SESSION`.

## Supported harnesses

Anything that can run a shell command works. First-class, tested targets: **Claude Code,
OpenCode, Codex, Pi**. `weaver init` writes the instruction block to both `CLAUDE.md` and
`AGENTS.md` (the emerging cross-tool standard), which covers most others for free.

:::tip[Sandboxed harnesses]
Codex runs tool commands in a sandbox with no visible TTY or process ancestry — which is
exactly why the harness-native session id (`CODEX_THREAD_ID`) is the primary signal, not the
terminal. The ladder above handles this automatically.
:::

## Worktrees

Because the store is keyed by repo identity (not directory), multiple **git worktrees** of the
same repo share one commons — so agents in different worktrees still coordinate.

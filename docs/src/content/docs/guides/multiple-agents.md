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

Participants coordinate around **workstreams**, not harness brands. Two agents collaborating on
OAuth attach to the same pad; three agents handling unrelated migrations, docs, and tests use three
different pads. `weaver scratchpads` shows each pad with its attached sessions, claims, and recent
activity instead of flattening every conversation into one shared document.

This works because the CLI is the **universal substrate** — every harness can run a shell command,
so they all read and write the same local commons. OpenCode tools and Claude hooks are optional
ergonomic integrations, not separate authorities.

## How a session is identified

Weaver resolves a stable per-session key in this order:

1. **Explicit override** — `--session <id>` or the `WEAVER_SESSION` env var. Always wins;
   useful for tests, headless runs, and any harness where the below don't work.
2. **Harness-native session id** — a stable per-session environment variable. Known:
   `CLAUDE_CODE_SESSION_ID` (Claude Code), `CODEX_THREAD_ID` (Codex), and for OpenCode
   `OPENCODE_SESSION_ID` (injected by [Weaver's OpenCode plugin](/weaver/guides/opencode-plugin/) —
   OpenCode ≥1.17 sets nothing itself) or `OPENCODE_RUN_ID` (built into OpenCode ≤1.16.x).
   These are per-session UUIDs, so three Codex sessions get three distinct keys.
3. **Controlling terminal** — the session's TTY, found by walking the process tree (used when
   there's no session env var, e.g. Pi, or for a human running `weaver` directly).

The *displayed* harness name resolves separately: environment signals first, then known
harness executables found while walking the process ancestry — so a harness that exposes no
env vars to subprocesses (e.g. OpenCode ≥1.17 without the plugin) is still labeled correctly.

If none resolve, there's **no anonymous fallback**: observer reads still work, but
session-mutating commands fail with a concise hint to set `WEAVER_SESSION`.

## Supported harnesses

Anything that can run a shell command works. First-class, tested targets: **Claude Code,
OpenCode, Codex, Pi**. `weaver init` can write the instruction block to project files
(`CLAUDE.md`, `AGENTS.md`) or global files for Claude Code, OpenCode, and Codex.

:::tip[Sandboxed harnesses]
Codex runs tool commands in a sandbox with no visible TTY or process ancestry — which is
exactly why the harness-native session id (`CODEX_THREAD_ID`) is the primary signal, not the
terminal. The ladder above handles this automatically.
:::

## Worktrees

Because the store is keyed by repo identity (not directory), multiple **git worktrees** of the
same repo share one commons — so agents in different worktrees still coordinate. Weaver records
an opaque checkout identity for new activity and claims. Known different-worktree overlaps are
informational because their files are isolated; continue without asking solely for that overlap
and coordinate later when integration might collide. Same-worktree or unknown-location overlaps
remain blocking advisories.

If the same live session identity appears in two known worktrees, Weaver marks the session's
location as ambiguous instead of assuming it moved. Its existing claims stay conservative until
they are released from their own worktree or age out, and `done` in one checkout cannot end the
ambiguous session or release claims held in the other.

Scratchpad attachments are keyed by session and worktree, so one identity appearing in multiple
checkouts does not silently move its attachment. `done` affects only the current checkout when the
location is ambiguous.

## A safe parallel pattern

1. Every session runs `status`, lists pads, and reads the relevant pad before investigation.
2. Read-only sessions stay unattached.
3. Writing sessions announce a task, attach to one pad, and claim exact edit scopes.
4. Collaborators update different stable sections where practical and always pass the revision
   they read.
5. Separate workstreams use separate pads and claims.
6. Each delivery runs a path-bounded `preflight`; completed pads are archived; each session runs
   `done`.

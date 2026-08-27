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
                                      OpenCode tools ── CLI ─────────┤
                                                                    │ read/write
                                              scratchpads UI / watch
```

Weaver is a single CLI over a local SQLite file. Its default coordination loop is
`status → task → claim → done`; scratchpads and Facts are additive context. Each ordinary invocation opens the file, does a
small amount of work, and exits. There is no coordination daemon or MCP server. `scratchpads`
temporarily serves the human editor on loopback, and `watch` stays open to redraw a terminal view;
agents do not require either process.

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
**harness-native session id** (`CLAUDE_CODE_SESSION_ID`, `OPENCODE_SESSION_ID` /
`OPENCODE_RUN_ID`, `CODEX_THREAD_ID`)
→ **controlling TTY** (self or nearest ancestor). No anonymous fallback. See
[Coordinating many agents](/weaver/guides/multiple-agents/).

## Schema v6 data model

- `sessions` — participants, harness/source, intent, worktree, heartbeat, and end state.
- `claims` — advisory TTL-bound file globs, optionally attributed to a scratchpad.
- `notes` — durable **Repository Facts**. The historical table name is retained for compatibility.
- `activity` — bounded events, optionally attributed to a worktree and scratchpad.
- `scratchpads` — current title, Markdown, lifecycle state, and optimistic revision.
- `scratchpad_revisions` — immutable title/body/state snapshots with actor and provenance.
- `scratchpad_attachments` — live session/worktree-to-pad associations.
- `command_events` — bounded content-free observer-command usage for local `audit` guidance.
- `advisories` — conflict-warning cooldown fingerprints; no prompt or file content.
- `dashboard_leases` — scoped foreground dashboard ownership, heartbeat, and expiry.
- `weaver_meta` — schema version, enablement, and per-repo settings.

Authored fields—pad Markdown, Facts, intent, claim reasons, and activity summaries—are plaintext
local data. Do not store secrets, credentials, personal data, or sensitive customer data in them.

## Project-wide UI ownership

`scratchpads` elects one foreground owner per effective store/user scope: canonical
`WEAVER_HOME` + repo id + OS user id. Worktrees sharing those values reuse one server containing all
of that store's pads. Different homes or users have independent scopes. The first owner chooses the
port and may create at most one Weaver-managed cmux surface; followers discover its URL and either
print it, ask the OS browser to open it, or request focus of that exact surface.

Ownership is a short SQLite lease with an owner id, PID, expiry, and heartbeat—never the browser
capability. The capability remains only in server memory, the owner control response, and the launch
URL. Control uses an immutable owner-specific Unix socket (`0600`) under a user-owned private runtime
directory (`0700`). UI mutations use a neutral `human`/`dashboard` actor with no follower session or
worktree attribution.

Dashboard takeover requires an expired exact lease and failed owner-specific control, then uses an
atomic lease compare-and-swap. The PID is diagnostic and PID reuse does not block availability;
Weaver never signals the recorded PID. Expiry immediately fences the stale owner's HTTP API and
event stream, expired leases cannot be renewed, and a resumed stale owner's heartbeat shuts it down.
This differs from destructive maintenance and store-holder cleanup, which remain conservative when
process identity or liveness cannot be proved. Weaver has no daemon and never searches for or kills
generic cmux, browser, or WebKit processes.

Ctrl-C, TERM, and HUP drive the same owner shutdown sequence: close HTTP, close only the exact
tracked cmux surface if one exists, close/unlink the owner socket, and release the lease. Ordinary
browser tabs are outside Weaver's lifecycle and cannot be enforceably deduplicated.

## Scratchpad transactions

Scratchpads are optional; ordinary sessions need not attach to one. When used, every mutation
compares the expected revision and writes the current row plus an immutable
revision snapshot in one transaction. A stale compare fails instead of overwriting a concurrent
writer. Attachments key a session and worktree to at most one active pad; claims, activity, and
scratchpad mutations by that session inherit the attachment when one exists. Repository Facts stay
repo-wide and may use `--path`/`--tag` for relevance instead of belonging to one pad.

## Migration

Opening an older store migrates it to the current schema v6 in order. Coordination-lite changes no
schema and does not detach existing sessions. The v4 → v5 step creates
scratchpad, revision, and attachment tables and adds nullable scratchpad attribution to
claims/activity. Existing rows in `notes` are not renamed or rewritten; the CLI simply presents
them as Repository Facts. The v5 → v6 step adds scoped dashboard leases. Freshness of installed
instruction blocks and OpenCode plugins is separate from the SQLite schema, so after upgrading
rerun `weaver init` at the scope previously used and include `--hooks` when applicable.

`weaver deinit` preserves the store. `weaver deinit --purge` deletes the whole current-repo store.
`weaver uninstall` without `--keep-data` cleans the effective `WEAVER_HOME` (`$WEAVER_HOME` when set,
otherwise `~/.weaver`). The default `~/.weaver` may be removed recursively after validation, but an
explicit home is never removed recursively: only validated Weaver database and `-wal`, `-shm`, or
`-journal` sidecar files are selectively deleted, leaving unrelated files and the directory intact.
Both destructive commands remove authored pads, revision history, and Facts. Destructive maintenance
first publishes a private per-scope fence that blocks new owners, asks the exact owner to shut down
over its authenticated socket, and proves its lease and endpoint are gone. Uninstall acquires fences
for all discovered stores before quiescing any. Unsafe metadata, ownership changes, timeouts, or
unprovable process liveness cause refusal rather than best-effort deletion.

## What Weaver is not

- **Not a VCS / merge tool.** It prevents and warns *before* an edit; git owns file contents.
- **Not an MCP server.** It's a CLI — the universal interface every harness already speaks.
- **Not a coordination daemon or cloud service.** v1 is fully local; the optional editor server is
  loopback-only and exists only while `weaver scratchpads` runs.

## Distribution

A standalone binary built with `bun build --compile` for macOS/Linux × arm64/x64, attached to
each GitHub release and served by `install.sh` and `weaver upgrade`. Versioning is automated
with release-please; see [Releasing](/weaver/releasing/).

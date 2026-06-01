---
title: CLI reference
description: Every Weaver command, its flags, and examples.
sidebar:
  order: 1
---

Run `weaver --help` for a summary, or `weaver <command> --help` where available. Commands fall
into three groups: **agent** commands (register your presence), **observer** commands (read
only — they never make you appear as a participant), and **lifecycle/maintenance**.

## Agent commands

### `weaver task "<intent>"`
Announce what you're working on. Sets your session's intent.
```sh
weaver task "refactor the auth module to use AuthService"
```

### `weaver claim '<glob>' [--reason "<why>"] [--ttl <dur>]`
Stake out an area you'll work in. Advisory and TTL'd. If it overlaps another live session's
claim, it still records your claim but prints the conflict and exits non-zero.
```sh
weaver claim 'src/auth/**' --reason "rewriting token refresh" --ttl 2h
```

### `weaver release '<glob>'`
Free an area you previously claimed.

### `weaver note "<text>" [--pin] [--path <p>] [--tag <t>]`
Record a durable, repo-scoped learning. `--pin` surfaces it prominently in `status`.
```sh
weaver note "integration tests need docker pg on :5433" --tag testing
```

### `weaver log <kind> <path> "<summary>"`
Record an activity event. `kind` is one of `edit`, `create`, `delete`, `run`, etc. (an unknown
kind is recorded as `run` with a warning).
```sh
weaver log edit src/auth/login.ts "extracted refreshToken into AuthService"
```

### `weaver done`
End your session and release its claims.

## Observer commands

### `weaver status [--json] [--full]`
The current picture: other live sessions, active claims, recent activity, and notes. **Silent
when nothing is relevant.** `--json` for machine consumption; `--full` removes the caps.

### `weaver check <path>`
Is anyone else working on this path/area? Exits `0` if clear, `1` on a conflict, and prints the
conflicting session's context. Observer-safe — works even without a resolved session.

### `weaver notes [--full]`
List durable notes (pinned first, newest first).

### `weaver activity [--json] [--full]`
The recent activity feed across sessions.

### `weaver doctor`
Diagnostics: resolved session key + source, repo id, store path, runtime/binding, enabled
state, active session count.

## Lifecycle & maintenance

### `weaver init`
Enable Weaver in the current repo: create the store and inject the instruction block into
`CLAUDE.md` and `AGENTS.md`. Idempotent.

### `weaver disable` / `weaver enable`
Pause / resume agent writes for this repo. While disabled, mutating commands no-op quietly
(reads and `done` still work).

### `weaver deinit [--purge]`
Remove the instruction block from `CLAUDE.md` / `AGENTS.md`. `--purge` also deletes the store.

### `weaver config [<key> [<seconds>]]`
View or set tunable TTLs. See [Configuration](/weaver/guides/configuration/).

### `weaver upgrade [--check]`
Update the installed binary to the latest release (`--check` only checks). See
[Install](/weaver/getting-started/install/).

## Common flags

| Flag | Applies to | Meaning |
| --- | --- | --- |
| `--json` | `status`, `activity` | machine-readable output |
| `--full` | `status`, `notes`, `activity` | remove output caps |
| `--reason` | `claim` | why you're claiming the area |
| `--ttl` | `claim` | claim lifetime (`90s`, `30m`, `2h`, `1d`) |
| `--pin` | `note` | surface the note prominently |
| `--session` | any | explicit session id (overrides auto-detection) |

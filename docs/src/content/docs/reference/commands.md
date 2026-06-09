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

Run automatically *by your agents* — the `weaver init` block tells them how. You'll rarely type
these yourself, except to simulate an agent.

### `weaver task "<intent>"`
Announce what you're working on. Sets your session's intent.
```sh
weaver task "refactor the auth module to use AuthService"
```

### `weaver claim '<glob>' [--reason "<why>"] [--ttl <dur>]`
Stake out an area you'll work in. Advisory and TTL'd. Exits `0` when the area is clear. Exit `1`
means the claim **was still recorded** but it overlaps another live session — the conflict is
printed so the agent stops and coordinates. Don't re-run the claim on exit `1`; it succeeded.
```sh
weaver claim 'src/auth/**' --reason "rewriting token refresh" --ttl 2h
```

### `weaver release '<glob>'`
Free an area you previously claimed.

### `weaver note "<text>" [--pin] [--path <p>] [--tag <t>] [--update <id>]`
Record a durable, repo-scoped learning. `--pin` surfaces it prominently in `status`.
`--update <id>` replaces an existing note: the old note disappears from all listings and the
new one takes its place (ids are shown by `weaver notes`). A pinned note stays pinned across
updates unless you say otherwise.
```sh
weaver note "integration tests need docker pg on :5433" --tag testing
weaver note "integration tests need docker pg on :5434 since #42" --update 17
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

The commands **you** run as a human. Read-only — they never register you as a participant.

### `weaver status [--json] [--full]`
The current picture: other live sessions, active claims, recent activity, and notes. **Silent
when nothing is relevant.** `--json` for machine consumption; `--full` removes the caps.

### `weaver check <path>`
Is anyone else working on this path/area? Exits `0` if clear, `1` on a conflict, and prints the
conflicting session's context. Observer-safe — works even without a resolved session. By default
it refreshes the caller's heartbeat if the caller already has a live session; use `--no-touch`
for strict read-only checks.

### `weaver preflight [paths…|--staged|--upstream|--base <ref>]`
A bounded commit/push/PR risk check. It checks only the supplied or inferred paths, never polls,
never waits for another session to run `done`, and never refreshes heartbeats. Relevant soft/hard
overlaps are a pause signal for the agent to ask the user what to do.
```sh
weaver preflight --staged --operation commit
weaver preflight --upstream --operation push
weaver preflight --base main --operation pr --json
```

Exit policy defaults to `--fail-on soft`: exit `1` for relevant soft or hard overlaps, `0` for
clear/stale/unrelated sessions, and `2` for tooling/input errors. Use `--fail-on hard` to pause
only on active claims, or `--fail-on never` for report-only automation.

Human and JSON output are capped by default; `--json` includes `counts` and `truncated` metadata.
Use `--full` to include every checked path and overlap.

### `weaver notes [--full]`
List durable notes with their ids (pinned first, newest first). Superseded notes are hidden —
only the current version of each learning appears.

### `weaver activity [--json] [--full]`
The recent activity feed across sessions.

### `weaver doctor`
Diagnostics: resolved session key + source, repo id, store path, runtime/binding, enabled
state, active session count.

## Lifecycle & maintenance

### `weaver init [--project|--global] [--hooks|--no-hooks]`
Install the agent instruction block into either project files (`./CLAUDE.md`, `./AGENTS.md`) or
global files (`~/.claude/CLAUDE.md`, `~/.config/opencode/AGENTS.md`, `~/.codex/AGENTS.md`). On a
TTY, `init` prompts with project files as the first/default choice. Non-interactive runs default
to project files. `--project` and `--global` are mutually exclusive.

`init` can also install [Claude Code hooks](/weaver/guides/claude-code-hooks/) into the repo's
`.claude/settings.json` (always project-scoped). On a TTY it asks (default yes); non-interactive
runs install them only with an explicit `--hooks`.

Project scope covers the current checkout only — run `init` in each repo you want covered. Global
scope is a one-time setup that covers every repo where your agents read their global instruction
files — no per-repo `init` is needed afterwards. In both cases there is no per-repo database
setup: a repo's store is created automatically the first time an agent runs a weaver command
there.

### `weaver disable` / `weaver enable`
Pause / resume agent writes for this repo. While disabled, mutating commands no-op quietly
(reads and `done` still work).

### `weaver deinit [--project|--global] [--purge]`
Remove the instruction block from project files by default, or from global files with `--global`.
Project-scope deinit also removes Weaver's Claude Code hook entries from `.claude/settings.json`.
`--purge` also deletes the current repo's store.

### `weaver hook <pre-edit|post-edit>`
The Claude Code hook endpoint — registered by `weaver init`, not meant to be run by hand. Reads
the hook payload JSON on stdin. `pre-edit` emits an advisory warning (never a block) when the
target file overlaps another live session; `post-edit` records the edit and refreshes the
session's heartbeat. Always exits `0`; problems are silently ignored so a hook can never break
an agent. See [Claude Code hooks](/weaver/guides/claude-code-hooks/).

### `weaver config [<key> [<seconds>]]`
View or set tunable TTLs. See [Configuration](/weaver/guides/configuration/).

### `weaver upgrade [--check]`
Update the installed binary to the latest release (`--check` only checks). See
[Install](/weaver/getting-started/install/).

## Common flags

| Flag | Applies to | Meaning |
| --- | --- | --- |
| `--json` | `status`, `activity`, `preflight` | machine-readable output |
| `--full` | `status`, `notes`, `activity`, `preflight` | remove output caps |
| `--color` | supported human output | force ANSI colors (`--color=always`, `auto`, or `never`) |
| `--no-color` | supported human output | disable ANSI colors |
| `--staged` | `preflight` | check staged paths |
| `--upstream` | `preflight` | check `@{upstream}...HEAD` paths |
| `--base` | `preflight` | check `<ref>...HEAD` paths |
| `--fail-on` | `preflight` | exit threshold: `soft`, `hard`, or `never` |
| `--project` | `init`, `deinit` | use project instruction files |
| `--global` | `init`, `deinit` | use global instruction files |
| `--hooks` / `--no-hooks` | `init` | install / skip Claude Code hooks |
| `--update` | `note` | supersede an existing note by id |
| `--no-touch` | `check` | do not refresh heartbeat |
| `--reason` | `claim` | why you're claiming the area |
| `--ttl` | `claim` | claim lifetime (`90s`, `30m`, `2h`, `1d`) |
| `--pin` | `note` | surface the note prominently |
| `--session` | any | explicit session id (overrides auto-detection) |

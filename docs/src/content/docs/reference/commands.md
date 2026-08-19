---
title: CLI reference
description: Exact shipped commands for scratchpads, coordination, Repository Facts, views, and lifecycle.
sidebar:
  order: 1
---

Run `weaver --help` and `weaver scratchpad help` for the authoritative summaries. Relative paths
resolve against the current repository/worktree. `--session <id>` or `WEAVER_SESSION=<id>` provides
an explicit identity when harness/TTY discovery is unavailable.

## Scratchpad commands

### `weaver scratchpad list`

```text
weaver scratchpad list [--state active|archived|trash|all] [--limit N] [--json]
```

Lists active pads by default, with id, title, state, revision, and live attachment count.

### `weaver scratchpad create`

```text
weaver scratchpad create <title> [--from FILE|-] [--json]
```

Reads UTF-8 Markdown from a file or stdin. Bodies are limited to 1,000,000 bytes; titles to 200
characters. With piped stdin, `--from -` may be omitted, but explicit stdin is clearest.

### `weaver scratchpad read`

```text
weaver scratchpad read <id> [--headings|--section HEADING|--tail N|--full] [--json]
```

Small pads render fully. Large default reads return a bounded heading outline with guidance.
`--section` returns one ATX heading through the next peer/parent; `--tail` accepts 1–500 lines;
`--full` deliberately removes the normal content bound.

### `weaver scratchpad find`

```text
weaver scratchpad find <query…> [--state active|archived|trash|all] [--limit N] [--json]
```

Searches pad titles and Markdown.

### `weaver scratchpad use`

```text
weaver scratchpad use <id>
```

Attaches the current identified session/worktree to one active pad, replacing its prior attachment.
Claims and activity then inherit pad attribution. Repository Facts remain repo-wide. `done` detaches.

### Content mutations

```text
weaver scratchpad replace <id> [--from FILE|-] [--revision N]
weaver scratchpad append <id> [--from FILE|-] [--revision N]
weaver scratchpad edit-section <id> <heading> [--from FILE|-] [--revision N]
weaver scratchpad rename <id> <title…> [--revision N]
```

All accept `--json`. `--revision` (also accepted internally as `--expected-revision` or
`--expected`) is optimistic compare-and-swap. Prefer `edit-section`; use `replace` only for a
deliberate whole-document rewrite. Content edits require an active pad.

### `$EDITOR`

```text
weaver scratchpad edit <id> [--revision N]
```

Uses `$VISUAL`, then `$EDITOR`. The private temporary draft is preserved if the editor, validation,
or revision check fails.

### History

```text
weaver scratchpad history <id> [--limit N] [--full] [--json]
```

Shows immutable revision metadata newest-first. `--full` includes each revision body.

### Lifecycle

```text
weaver scratchpad archive <id> [--revision N] [--json]
weaver scratchpad restore <id> [--revision N] [--json]
weaver scratchpad trash <id> --reason WHY --revision N [--json]
weaver scratchpad recover <id> [--revision N] [--json]
```

Archive moves active → archived; restore moves archived → active. Trash remembers the previous
state; recover returns there. Agent trash requires both reason and revision. Archive/trash refuses
other live attachments. There is no individual permanent pad purge.

## Coordination commands

### `weaver status [--json] [--full]`

Observer snapshot of active/recent sessions, intents, claims, activity, and Repository Facts.
Human output stays silent when nothing is relevant; JSON always emits structure. `--full` increases
normal caps.

### `weaver task <intent…>`

Registers/refreshes the current session and sets its intent.

### `weaver claim <glob>`

```text
weaver claim <glob> [--reason TEXT] [--ttl 30m]
```

Records an advisory, TTL-bound claim. Exit `0` is clear. Exit `1` means the claim **was recorded**
but overlaps another live session; do not rerun it. `--ttl` accepts durations such as `90s`, `30m`,
`2h`, and `1d` within configured bounds.

### `weaver release <glob>`

Releases the current session's matching claim in this checkout.

### `weaver check <path> [--no-touch]`

Observer-safe path conflict check. Exit `0` clear, `1` conflict. It normally refreshes a recognized
live caller; `--no-touch` prevents that heartbeat.

### `weaver preflight`

```text
weaver preflight [paths…|--staged|--upstream|--base REF]
  [--operation commit|push|pr] [--fail-on soft|hard|never] [--json] [--full]
```

Checks only supplied/inferred delivery paths, once, without heartbeat refresh or polling.
`--staged` uses the index; `--upstream` uses `@{upstream}...HEAD`; `--base` uses `<ref>...HEAD`.
Default `--fail-on soft` returns `1` for relevant soft/hard overlap and `2` for input/tooling errors.
`hard` fails only active claims; `never` reports without overlap failure.

### `weaver done`

Ends presence for the current checkout, releases its claims, and detaches its scratchpad. Ambiguous
same-identity/multiple-worktree presence remains conservative.

## Repository Facts and activity

### `weaver fact`

```text
weaver fact <text…> [--pin] [--path PATH] [--tag TOPIC] [--update ID]
```

Records verified lasting repo knowledge. `--path` scopes relevance; `--tag` adds a filterable topic;
`--pin` is for rare repo-wide facts; `--update` creates a replacement and supersedes the prior row.
`weaver note` is a compatibility alias.

### `weaver facts`

```text
weaver facts [query…] [--full] [--all] [--path PATH] [--tag TOPIC] [--json]
```

Lists current Facts (pinned then newest) or filters by all free-text terms, overlapping path, and
exact topic token. `--all` includes retired/superseded history. `weaver notes` is a compatibility
alias. The underlying schema retains the historical `notes` table name.

### `weaver forget`

```text
weaver forget <id> <reason…>
weaver forget --undo <id>
```

Soft-retires a wrong/obsolete Fact with an audit reason, or restores it. No row is deleted.

### `weaver log <kind> <path> <summary…>`

Records notable activity. Unknown kinds are normalized to `run` with a warning.

### `weaver activity`

```text
weaver activity [query…] [--kind K] [--path P] [--since 2h] [--full] [--json]
```

Searches retained summaries/targets; filters compose and scan retained history before output caps.

## Human views

### `weaver scratchpads`

```text
weaver scratchpads [--port N] [--no-open] [--open=auto|browser|cmux]
```

Starts the authenticated loopback rich/source editor until Ctrl-C. `dashboard`, `view`, and `ui`
are aliases. `auto` optionally uses a valid cmux browser pane and otherwise uses `open` (macOS) or
`xdg-open` (Linux). `--no-open` supports headless use.

The first command owns one foreground server and at most one Weaver-managed cmux surface for the
effective repo store/`WEAVER_HOME`/OS user scope. Worktrees in that scope follow it, reuse its URL,
and cannot replace its port. Different homes or users may run separate owners. A follower with
`--no-open` only prints the URL; `browser` may open another ordinary browser tab; `auto`/`cmux`
request focus of the owner's exact managed cmux surface and otherwise leave the URL for manual use.
Ordinary browser tabs cannot be reliably deduplicated.

Ctrl-C, TERM, or HUP stops an owner cleanly and closes only its exact managed cmux surface. UI edits
are attributed to a neutral human/dashboard actor across all followers.

### `weaver watch`

Live terminal coordination view until Ctrl-C.

## Setup, diagnostics, and lifecycle

### `weaver init [--project|--global] [--hooks|--no-hooks]`

Installs/refreshes the versioned managed block. Project targets are `./CLAUDE.md` and `./AGENTS.md`;
global targets are `~/.claude/CLAUDE.md`, `~/.config/opencode/AGENTS.md`, and
`$CODEX_HOME/AGENTS.md` (default `~/.codex/AGENTS.md`).

`--hooks` also merges Claude Code hooks and installs the OpenCode plugin at the same scope. User
content and foreign files are preserved. Interactive runs prompt; noninteractive runs default to
project and skip integrations unless `--hooks` is explicit.

### `weaver hook <pre-edit|post-edit>`

Best-effort Claude/OpenCode structural endpoint reading JSON on stdin. Not intended for humans.

### `weaver disable` / `weaver enable`

Pause/resume mutating agent writes for this repo. Reads and lifecycle cleanup still work.

### `weaver deinit [--project|--global] [--purge]`

Removes only Weaver-owned managed blocks and harness integrations at the selected scope (project by
default). Data is preserved unless `--purge` is passed. Purge deletes this repo's entire authored
store: pads/revisions, Facts, sessions, claims, activity, and metadata. Before deletion, a private
maintenance fence blocks new UI owners and requests authenticated shutdown of the exact current
owner. If Weaver cannot prove safe quiescence—including lease/control races—it refuses the purge.

### `weaver config [<key> [<seconds>]]`

Views/sets per-repo `session_ttl_seconds`, `claim_ttl_seconds`, and
`recent_activity_seconds`.

### `weaver audit [--json]`

Summarizes bounded retained usage, pad/Fact state, identity quality, stale sessions/claims, and
project/global setup freshness, then recommends scope-correct refreshes.

### `weaver doctor`

Shows identity quality, repo/root, SQLite binding, enabled state, sessions/claims/pads, instruction
freshness, hooks, and OpenCode plugin status.

### `weaver upgrade [--check]`

Standalone binary only. Checks/downloads the latest checksum-verified release. Store migration is
automatic; rerun `init` at the previously installed scope (and `--hooks` if used), then restart
OpenCode.

### `weaver uninstall [--yes] [--keep-data]`

Standalone binary only. After confirmation, the default behavior removes the binary and cleans the
effective `WEAVER_HOME` (`$WEAVER_HOME` when set, otherwise `~/.weaver`). The default `~/.weaver`
may be removed recursively after fencing and validation. An explicit `WEAVER_HOME` is never removed
recursively: only validated Weaver database and `-wal`, `-shm`, or `-journal` sidecar files are
deleted, leaving unrelated files and the directory intact. `--keep-data` removes only the binary;
`--yes` is required noninteractively.

Uninstall refuses on unsafe, missing, or changed required targets; unrecognized discovered stores;
or any failure to fence the home, quiesce its exact UI owners, and drain active store users. It
does not delete around live or uncertain access.

## Global output flags

`--color=always|auto|never` and `--no-color` control supported human output. JSON output is never
colorized.

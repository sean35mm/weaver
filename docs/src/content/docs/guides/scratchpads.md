---
title: Scratchpads
description: Coordinate each workstream through curated Markdown, attached sessions, optimistic revisions, and an explicit lifecycle.
sidebar:
  order: 1
---

Scratchpads are Weaver's primary shared context. Use **one pad per workstream**, not one giant pad
for the repository and not one disposable pad per agent. Sessions collaborating on OAuth can share
one pad while a parallel test-isolation effort uses another.

## Start a workstream

```sh
weaver status
weaver scratchpad list
weaver scratchpad read 7 --headings
```

Reuse the matching active pad. If none exists, create one by piping Markdown:

```sh
weaver scratchpad create "OAuth rollout" --from - <<'MARKDOWN'
# Goal

Ship the callback and token flow safely.

# Constraints

# Decisions

# Findings

# Next steps
MARKDOWN
```

For read-only investigation or planning, read the relevant pad but do not attach or mutate it.
After repository writes are authorized:

```sh
weaver task "implement OAuth callback validation"
weaver scratchpad use 7
weaver claim 'src/auth/**' --reason "callback and token validation"
```

`use` attaches this session **and checkout** to the pad. Future claims, activity, and scratchpad
mutations by that session are attributed to the attached pad. Repository Facts remain
repo-wide; the rich UI shows them beside the workstream context. `done` detaches the session and
releases its claims.

## Read narrowly

Agent output is bounded by default. Start with structure, then request only what matters:

```sh
weaver scratchpad read 7 --headings
weaver scratchpad read 7 --section Decisions
weaver scratchpad read 7 --tail 40
weaver scratchpad read 7 --full        # deliberate complete read
weaver scratchpad read 7 --json
```

Search titles and Markdown across lifecycle states:

```sh
weaver scratchpad find "PKCE callback" --state active --json
weaver scratchpad list --state all --limit 100
```

## Curate Markdown, do not dump logs

Good pads contain decisions, constraints, verified findings, links to relevant paths, and next
steps under stable headings. Summarize a useful command result; do not paste routine command output,
entire conversations, or every intermediate thought. Keep secrets, credentials, personal data,
and sensitive customer data out of the local plaintext store.

Task progress belongs in the pad. A lasting repo invariant belongs in a
**[Repository Fact](#repository-facts-versus-pad-content)**.

## Revisions and concurrent edits

Every create, content change, rename, or lifecycle action creates an immutable revision snapshot.
Read output includes the current revision (`r12` or `"revision": 12`). Pass that revision back to
mutations:

```sh
printf '%s\n' 'Use PKCE for every browser flow.' |
  weaver scratchpad edit-section 7 Decisions --from - --revision 12
```

If another writer already created r13, Weaver rejects the stale write instead of overwriting it.
Re-read, understand both changes, and merge deliberately. This is optimistic compare-and-swap
concurrency—not a CRDT and not last-write-wins.

Prefer targeted operations:

```sh
weaver scratchpad edit-section 7 Findings --from findings.md --revision 13
weaver scratchpad append 7 --from - --revision 14
weaver scratchpad rename 7 "OAuth callback rollout" --revision 15
```

`replace` changes the whole body and should be reserved for deliberate full-document rewrites.
`history` shows who changed what state and when; `--full` includes historical Markdown:

```sh
weaver scratchpad history 7 --limit 30 --json
weaver scratchpad history 7 --full
```

For a human terminal workflow, `weaver scratchpad edit 7 --revision 15` writes a private temporary
Markdown draft and opens `$VISUAL` or `$EDITOR`. On editor failure or a stale revision, Weaver keeps
the draft path so the work is not lost.

## Lifecycle

Scratchpads have three visible states:

- **active** — writable and attachable;
- **archived** — completed/paused record, restorable to active; and
- **trash** — an accidental, duplicate, empty, or obsolete pad, recoverable to its prior state.

```sh
weaver scratchpad archive 7 --revision 16
weaver scratchpad restore 7 --revision 17
weaver scratchpad trash 9 --reason "duplicate of #7" --revision 2
weaver scratchpad recover 9 --revision 3
```

Archive completed work rather than trashing it. Agents may trash only empty, duplicate, or
demonstrably obsolete pads; a reason and current revision are mandatory. Archive/trash refuses
when another live session is attached. There is no command to permanently purge one pad. The
separate, destructive `weaver deinit --purge` deletes the entire repository store, including all
pads, revisions, Facts, sessions, claims, and activity.

## Rich/source UI

```sh
weaver scratchpads
```

The loopback web app offers WYSIWYG and Markdown source modes, autosave, search, revision history,
archive/restore/trash/recover controls, and a side panel for attached sessions, claims, recent pad
activity, and Repository Facts. A revision conflict pauses autosave and preserves the local draft
until you copy it or reload the remote version.

One foreground UI owner serves all pads in the effective project store. Worktrees sharing the same
repo id, `WEAVER_HOME`, and OS user follow that owner; a different home or user has a separate
instance. The first owner's port wins. All writes through the shared browser UI receive neutral
human/dashboard attribution rather than a follower's session identity.

Launch choices:

```sh
weaver scratchpads --open=auto      # optional cmux pane when detected, otherwise browser
weaver scratchpads --open=browser   # normal macOS/Linux browser launcher
weaver scratchpads --open=cmux      # prefer cmux, with browser fallback
weaver scratchpads --no-open        # SSH/container/headless; copy the printed URL
weaver scratchpads --port 8080
```

`dashboard`, `view`, and `ui` are aliases. The temporary server binds to loopback, validates Host
and Origin, and protects its API with an unguessable launch capability. The capability is kept only
in owner memory, its private control exchange, and launch URLs—not persisted. Agents coordinate
through the CLI/store, not through the web server.

## Repository Facts versus pad content

Promote only durable, verified repo knowledge:

```sh
weaver fact "AuthService owns OAuth callback validation" --path 'src/auth/**'
weaver facts oauth --json
weaver fact "Callback validation moved to OAuthService" --update 12
weaver forget 17 "the old provider was removed"
```

Facts outlive the current pad and appear across the repo. `note`/`notes` remain compatibility
aliases, but Fact terminology is preferred.

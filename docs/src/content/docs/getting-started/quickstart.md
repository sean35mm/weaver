---
title: Quickstart
description: Install the coordination-lite protocol and watch two agent sessions coordinate.
sidebar:
  order: 2
---

## 1. Install the managed protocol

From a Git repository:

```sh
weaver init
```

Choose **project** for this checkout (`CLAUDE.md`, `AGENTS.md`) or **global** for every repo read by
Claude Code, OpenCode, and Codex. Interactive init also offers harness integrations: Claude Code
edit hooks and the OpenCode plugin/tools. For a scripted install:

```sh
weaver init --project --hooks
# or once globally:
weaver init --global --hooks
```

Restart OpenCode after plugin installation. Re-running init refreshes outdated Weaver-owned blocks
in place without changing your surrounding instructions. A repository store is created lazily on
first use; no daemon or database setup is required.

## 2. Start a task

Agents learn this sequence from the managed block:

```sh
weaver status
```

Read-only/plan-only sessions stop there unless status or the user identifies a relevant existing
pad; they may read it but must not create, attach, claim, or call `done`. Once repository writes are
authorized, the concise no-pad flow is:

```sh
weaver task "implement OAuth callback validation"
weaver claim 'src/auth/**' --reason "callback validation"
```

## 3. Coordinate concurrent changes

Scratchpads are optional. Use one for a matching active pad, collaborating sessions, planned
handoff/resumption, a conflict/shared decision record, or an explicit user request—not merely
because work is complex or long. When a trigger applies, find and attach the pad after `task` but
before `claim`, because the claim snapshots the current attachment:

```sh
weaver task "implement OAuth callback validation"
weaver scratchpad list
weaver scratchpad read 7 --headings
weaver scratchpad use 7
weaver claim 'src/auth/**' --reason "callback validation"
printf '%s\n' 'Use PKCE for browser clients.' |
  weaver scratchpad edit-section 7 Decisions --from - --revision 3
```

A stale pad revision fails clearly; re-read and merge instead of retrying blindly. Claims are
advisory: claim exit `1` means your claim was recorded but overlaps another live session. Read the
other workstream context and coordinate rather than repeating the command.

Promote verified, lasting knowledge separately:

```sh
weaver fact "OAuth callbacks are validated by AuthService" --path 'src/auth/**'
```

`note`/`notes` are compatibility aliases; prefer `fact`/`facts`.

## 4. Watch and finish

```sh
weaver scratchpads   # rich/source editor and workstream context
weaver watch         # terminal-only live view
weaver status        # one snapshot
```

When complete:

```sh
weaver preflight --staged
weaver done
```

`done` ends the write session, detaches any pad, and releases its claims. Archive a pad only when
the whole workstream is complete. See the full
[Scratchpads guide](/weaver/guides/scratchpads/) and [agent protocol](/weaver/guides/using-from-an-agent/).

## Try two sessions by hand

```sh
# terminal 1
WEAVER_SESSION=alice weaver task "refactor auth"
WEAVER_SESSION=alice weaver claim 'src/auth/**' --reason "token flow"

# terminal 2
WEAVER_SESSION=bob weaver status
WEAVER_SESSION=bob weaver check src/auth/login.ts
```

## Turning it off

```sh
weaver disable              # pause agent writes; reads/done still work
weaver enable
weaver deinit               # remove project managed files/integrations; preserve data
weaver deinit --global      # remove global managed files/integrations
weaver deinit --purge       # destructive: also delete this repo's entire authored store
```

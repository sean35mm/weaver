---
title: Quickstart
description: Install the scratchpads-first protocol and watch two agent workstreams coordinate.
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

## 2. Start or join a workstream

Agents learn this sequence from the managed block:

```sh
weaver status
weaver scratchpad list
weaver scratchpad read 7 --headings
```

Reuse the active pad matching the workstream. Create one only when the work is genuinely distinct:

```sh
printf '# Goal\n\nAdd OAuth safely.\n\n# Decisions\n\n# Next steps\n' |
  weaver scratchpad create "OAuth rollout" --from -
```

Read-only/plan-only sessions stop after reading. Once code or other repository writes are
authorized:

```sh
weaver task "implement OAuth callback validation"
weaver scratchpad use 7
weaver claim 'src/auth/**' --reason "callback validation"
```

## 3. Coordinate concurrent changes

The pad read shows its revision. Use it for targeted edits:

```sh
printf '%s\n' 'Use PKCE for browser clients.' |
  weaver scratchpad edit-section 7 Decisions --from - --revision 3
```

A stale revision fails clearly; re-read and merge instead of retrying blindly. Claims are also
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
weaver scratchpad archive 7 --revision 4
weaver done
```

`done` detaches the session and releases its claims. See the full
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

---
title: OpenCode plugin
description: Official custom tools plus best-effort structural hooks for OpenCode sessions.
sidebar:
  order: 4
---

Weaver's generated OpenCode plugin combines two layers while keeping the CLI authoritative:

1. **Best-effort structural hooks** export session identity, log edit paths, append advisory
   conflict context, refresh presence, and clean up deleted sessions.
2. **Strict custom tools** expose a fixed set of scratchpad and Repository Facts operations through
   OpenCode's official `tool` hook.

The generated ESM begins with:

```js
import { tool } from "@opencode-ai/plugin";
```

`@opencode-ai/plugin` is supplied by OpenCode. The generated file does not import or depend on a
Weaver npm package; it invokes the installed `weaver` binary.

## Install and refresh

```sh
weaver init --project --hooks   # .opencode/plugins/weaver.js in this checkout
weaver init --global --hooks    # ~/.config/opencode/plugins/weaver.js for every repo
```

`--hooks` installs both the OpenCode plugin and Claude Code hooks at the chosen scope. Interactive
init asks; non-interactive init requires the flag explicitly.

The plugin has a managed marker and template protocol version. `weaver init` detects current,
outdated, missing, and foreign plugin files. An outdated Weaver-owned file is replaced in place; a
marker-less user-owned `weaver.js` is reported as foreign and never overwritten or removed.

OpenCode loads plugins at application startup. **Fully restart OpenCode** after install or refresh.
After `weaver upgrade`, rerun `weaver init` at your previous scope, include `--hooks`, then restart.
`weaver doctor` and `weaver audit` report stale integrations with scope-correct commands.

## Dedicated tools

| Tool | Operation |
| --- | --- |
| `weaver_scratchpad_list` | list/search pads by lifecycle state |
| `weaver_scratchpad_read` | bounded default/headings/section/tail read |
| `weaver_scratchpad_create` | create a workstream pad with Markdown on stdin |
| `weaver_scratchpad_use` | attach the execute-context session/worktree |
| `weaver_scratchpad_edit_section` | targeted heading-body replacement at an expected revision |
| `weaver_scratchpad_rename` | rename at an expected revision |
| `weaver_scratchpad_archive` | archive at an expected revision |
| `weaver_scratchpad_restore` | restore at an expected revision |
| `weaver_scratchpad_trash` | trash with mandatory reason and expected revision |
| `weaver_scratchpad_recover` | recover at an expected revision |
| `weaver_facts_list` | list/search current or historical Repository Facts |
| `weaver_fact_record` | create or supersede a Repository Fact |
| `weaver_fact_forget` | retire a Fact with a reason |

There is no generic shell/argv tool. Every tool constructs an allowlisted argv shape; scratchpad
bodies travel over stdin; reads request JSON and stay bounded. The strict runner captures exit code,
stdout, and bounded stderr. Non-zero exits become clear errors, with special wording for stale
revisions, lifecycle/attachment mistakes, and coordination conflicts.

The tool execute context's `sessionID` becomes `OPENCODE_SESSION_ID`. Its directory is preferred as
the command cwd, with plugin directory/worktree fallbacks. This keeps tool writes attributed to the
same session and checkout as shell commands.

## Structural hooks

- **`shell.env`** injects the current `OPENCODE_SESSION_ID` into shell and PTY commands.
- **`tool.execute.after`** observes successful `edit`/`write` calls. It sends only the opaque
  session id and edited path to `weaver hook`: post-edit logs/refreshes presence; pre-edit returns a
  rate-limited advisory appended to the model-visible tool output.
- **`session.deleted`** invokes `weaver done` for that session. Idle is deliberately not treated as
  done.

These structural subprocess calls remain best-effort: a missing/failing Weaver binary never breaks
an OpenCode edit. Explicit custom tools are intentionally strict because the agent requested a
Weaver operation and needs to know whether it committed.

## Security and compatibility

- OpenCode ≥1.17 is required for `shell.env`; PTY propagation is available from 1.17.7.
  `OPENCODE_RUN_ID` remains recognized for older OpenCode releases.
- No prompts or file contents flow through structural hooks. Explicit scratchpad/Fact tool content
  is written only to the same local Weaver SQLite store requested by the agent.
- Never put secrets or sensitive personal/customer data in local coordination content.
- `weaver deinit` removes only a project plugin carrying Weaver's marker;
  `weaver deinit --global` does the same for global scope.

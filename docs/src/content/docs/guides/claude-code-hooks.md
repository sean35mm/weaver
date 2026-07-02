---
title: Claude Code hooks
description: Make coordination structural — warn agents before they edit a claimed area, and keep busy agents visibly live, without anyone remembering to run a command.
sidebar:
  order: 3
---

The instruction block asks agents to run `weaver status` and `weaver check` at the right
moments — and they usually do. Hooks remove the "usually": Claude Code itself calls Weaver
around every file edit, so conflict detection and presence no longer depend on the agent
remembering anything.

Two hooks are installed, both **advisory** — Weaver never blocks an edit:

- **PreToolUse → `weaver hook pre-edit`** — before Edit/Write/MultiEdit/NotebookEdit runs,
  Weaver checks the target path against other live sessions' claims and recent activity. On
  an overlap it *allows* the edit but injects a warning the model sees, with the other
  session's intent and claim reason — the same picture `weaver check` prints. Warnings are
  rate-limited: an agent deliberately working in a contested area is warned once, not on
  every edit — the same picture repeats at most every ~5 minutes, but a *changed* picture
  (a new agent, a new claim, a soft overlap turning into an active claim) warns immediately.
- **PostToolUse → `weaver hook post-edit`** — after the edit, Weaver records an `edit`
  activity event and refreshes the session's heartbeat. This fixes the classic gap where an
  agent edits heads-down for 20 minutes without running a weaver command and goes "stale"
  while it's the most active session in the repo.

## Install

```sh
weaver init                     # interactive: prompts to install integrations (default yes)
weaver init --hooks             # non-interactive: this repo's .claude/settings.json
weaver init --global --hooks    # non-interactive: ~/.claude/settings.json — every repo, once
weaver init --no-hooks          # skip them
```

Hooks follow the chosen scope: **project** merges into the repo's `.claude/settings.json`,
**global** into `~/.claude/settings.json`, where they fire in every repo — safe, because the
hook command no-ops in repos that haven't opted into Weaver (no store is ever created). The
merge is idempotent and preserves everything else in the file — your own hooks, permissions,
and any unknown keys. If the file isn't valid JSON, Weaver refuses to touch it and tells you.

The registered command is guarded:

```sh
command -v weaver >/dev/null 2>&1 && weaver hook pre-edit || true
```

so the settings file is safe to commit — collaborators without Weaver installed get a silent
no-op, never an error.

## Remove

```sh
weaver deinit          # removes the instruction block AND the hook entries
```

Only Weaver's own entries are removed; the rest of `.claude/settings.json` is untouched.

## How it stays safe

- **Never blocks**: the PreToolUse response is always `permissionDecision: "allow"`; the
  warning rides along as context for the model to act on.
- **Never breaks the agent**: any problem — unparseable payload, missing store, path outside
  the repo — exits `0` silently. A hook must not be the reason an edit fails.
- **Never tracks repos that didn't opt in**: `weaver hook` opens an existing store but will
  not create one, and it goes quiet when the project is `weaver disable`d.
- **One identity**: the hook derives the same session identity (from the payload's
  `session_id`) that the agent's own `weaver task`/`claim` commands resolve, so hook events
  and CLI events belong to one session — no phantom twins.

## Other harnesses

Codex, OpenCode, and friends have different (or no) hook systems, so they coordinate through
the instruction block alone for now. The CLI stays the universal engine; hooks are a
Claude-Code-native accelerator on top.

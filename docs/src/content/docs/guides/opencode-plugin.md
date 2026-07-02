---
title: OpenCode plugin
description: Structural coordination for OpenCode — session identity, edit logging, conflict advisories, and automatic cleanup via OpenCode's plugin hooks.
sidebar:
  order: 4
---

OpenCode ≥1.17 exposes no session identifier to the shell commands it runs, and has no
built-in way for an outside tool to observe its edits. Its plugin system provides both.
Weaver ships a single small plugin (`weaver.js`) that makes coordination structural for
OpenCode, the same way [hooks do for Claude Code](/weaver/guides/claude-code-hooks/):

- **Session identity** — the `shell.env` hook injects `OPENCODE_SESSION_ID` into every
  shell and PTY command, so each OpenCode session is a first-class, distinct participant
  (instead of a weak terminal-based identity).
- **Edit logging & presence** — after every `edit`/`write` tool call, the plugin feeds
  `weaver hook post-edit` the edited path: the edit lands in the activity feed and the
  session's heartbeat refreshes, keeping a busy agent visibly live.
- **Conflict advisories** — after the edit, `weaver hook pre-edit` checks the path against
  other live sessions' claims and recent activity. On an overlap, the warning is appended
  to the tool output the model reads (`[weaver advisory] …`), so the agent sees the other
  session's intent and coordinates. Advisories are rate-limited: the same conflict picture
  warns once per cooldown, and a *changed* picture re-warns immediately.
- **Session cleanup** — when OpenCode deletes a session, the plugin runs `weaver done` for
  it, releasing claims instead of waiting for TTL aging. (Idle sessions are deliberately
  left alone — idle just means "between turns".)

Everything is best-effort by construction: every weaver call is wrapped so a missing or
failing binary can never break OpenCode, and in repos that haven't opted into Weaver the
hook command exits silently without creating a store.

## Install

```sh
weaver init --project --hooks   # this repo: .opencode/plugins/weaver.js
weaver init --global --hooks    # every repo, once: ~/.config/opencode/plugins/weaver.js
```

The `--hooks` switch installs both harness integrations for the chosen scope: the
[Claude Code hooks](/weaver/guides/claude-code-hooks/) and this plugin. Global is a natural
fit here — the plugin is repo-agnostic, so one global file covers every repo on the
machine. Interactive `init` asks; scripted runs install only with an explicit `--hooks`.

OpenCode loads plugins at app startup — fully restart the OpenCode app after installing
(a new session alone won't pick it up). After upgrading Weaver, re-run
`weaver init --hooks` once to refresh the installed plugin to the latest template.

`weaver doctor` reports both scopes: `plugin : project missing · global installed`.

## Good to know

- **Requires OpenCode ≥1.17** (the `shell.env` hook; PTY commands are covered from
  v1.17.7). On ≤1.16.x you don't need it — `OPENCODE_RUN_ID` is built in and Weaver still
  recognizes it.
- **Advisories arrive after the first conflicting edit**, in that edit's tool output —
  OpenCode's plugin API has no non-blocking pre-edit channel. Weaver never blocks; the
  model reads the warning and coordinates before going further.
- **Content-free.** Only the opaque session id and edited file *paths* ever reach weaver —
  no prompts, file contents, or repo content — consistent with Weaver's
  [local-only guarantee](/weaver/concepts/how-it-works/#everything-stays-on-your-machine).
- **Your files are safe.** The installed file carries a Weaver marker. If a
  `.opencode/plugins/weaver.js` already exists without it, Weaver reports it as *foreign*
  and never writes over or removes it.
- **Uninstall** with `weaver deinit` / `weaver deinit --global` (each scope removes its own
  plugin along with the instruction block and Claude Code hooks), or just delete the file.

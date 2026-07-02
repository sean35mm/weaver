---
title: OpenCode plugin
description: Give OpenCode sessions first-class identity — a tiny plugin exports each session's id to shell commands via OpenCode's shell.env hook.
sidebar:
  order: 4
---

OpenCode ≥1.17 exposes no session identifier to the shell commands it runs (≤1.16.x set
`OPENCODE_RUN_ID`; v1.17.0 removed it). Without one, Weaver falls back to identifying an
OpenCode session by its controlling terminal — which works, but is *weak*: terminals get
reused across session lifetimes, and `weaver doctor`/`weaver audit` will tell you so.

OpenCode's plugin system closes the gap. Its `shell.env` hook hands plugins the session id
and lets them add environment variables to every shell (and PTY) command. Weaver ships a
plugin that does exactly one thing:

```js
export const WeaverPlugin = async () => ({
  "shell.env": async (input, output) => {
    if (input.sessionID) output.env.OPENCODE_SESSION_ID = input.sessionID;
  },
});
```

With it installed, every `weaver` command an OpenCode agent runs sees
`OPENCODE_SESSION_ID` — a harness-native session id, the same strength of signal Claude
Code and Codex provide out of the box. Three OpenCode panes become three distinct
participants, no matter how their terminals are arranged.

## Install

```sh
weaver init --project --hooks   # this repo: .opencode/plugins/weaver.js
weaver init --global --hooks    # every repo, once: ~/.config/opencode/plugins/weaver.js
```

The `--hooks` switch installs both harness integrations for the chosen scope: the
[Claude Code hooks](/weaver/guides/claude-code-hooks/) and this plugin. Global is a natural
fit here — the plugin is repo-agnostic and dependency-free (it exports one env var whether or
not a repo uses Weaver), so one global file covers every repo on the machine. Interactive
`init` asks; scripted runs install only with an explicit `--hooks`.

OpenCode loads plugins at app startup — fully restart the OpenCode app after installing
(a new session alone won't pick it up).

`weaver doctor` reports both scopes: `plugin : project missing · global installed`.

## Good to know

- **Requires OpenCode ≥1.17** (the `shell.env` hook; PTY commands are covered from
  v1.17.7). On ≤1.16.x you don't need it — `OPENCODE_RUN_ID` is built in and Weaver still
  recognizes it.
- **Content-free.** The plugin exports one opaque UUID. No prompts, paths, or repo content
  are read or transmitted — consistent with Weaver's
  [local-only guarantee](/weaver/concepts/how-it-works/#everything-stays-on-your-machine).
- **Your files are safe.** The installed file carries a Weaver marker. If a
  `.opencode/plugins/weaver.js` already exists without it, Weaver reports it as *foreign*
  and never writes over or removes it.
- **Uninstall** with `weaver deinit` / `weaver deinit --global` (each scope removes its own
  plugin along with the instruction block and Claude Code hooks), or just delete the file.

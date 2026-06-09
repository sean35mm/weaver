---
title: Quickstart
description: Enable Weaver in a repo and watch two agents coordinate in about five minutes.
sidebar:
  order: 2
---

This gets you from zero to "two agents coordinating" in a few minutes.

## 1. Install the agent instructions

From the root of any git repo:

```sh
weaver init
```

`init` asks where to append a short instruction block:

- **Project files** (`./CLAUDE.md`, `./AGENTS.md`) — covers this repo only. Run `weaver init`
  again in each repo you want covered. This is the first/default choice.
- **Global files** (`~/.claude/CLAUDE.md`, `~/.config/opencode/AGENTS.md`, `~/.codex/AGENTS.md`)
  — one-time setup that covers every repo on this machine. You never run `init` again.

If you use Claude Code, `init` also offers to install
[hooks](/weaver/guides/claude-code-hooks/) (default yes): Claude is then warned automatically —
never blocked — before editing an area another agent is working in, and its presence refreshes
on every edit.

For scripts, use `weaver init --project` or `weaver init --global`, plus `--hooks` or
`--no-hooks` to decide about Claude Code hooks non-interactively.

There is no per-repo database setup either way: each repo's store is created automatically the
first time an agent runs a weaver command there. That's the whole setup — **you don't run
anything else by hand.**

## 2. Use your agents normally

Open your agents (Claude Code, Codex, OpenCode, Pi, …) in the repo as you always do. Because
their instruction files now describe Weaver, they'll run the commands themselves as they work:
announce their task, claim the areas they touch, and leave notes.

:::note[Try it yourself]
You can play any agent by hand. In two terminals:

```sh
# terminal 1 — "alice"
WEAVER_SESSION=alice weaver task "refactor the auth module"
WEAVER_SESSION=alice weaver claim 'src/auth/**' --reason "rewriting token refresh"

# terminal 2 — "bob"
WEAVER_SESSION=bob weaver status          # sees alice + her claim
WEAVER_SESSION=bob weaver check src/auth/login.ts   # ⚠ conflict, exit 1
```
:::

:::tip[Who types what]
`weaver init` (step 1) is the only thing you run by hand. Your agents run `task`, `claim`,
`note`, and `check` themselves. Day to day, you just run `status`, `watch`, or `dashboard` to
see what they're doing.
:::

## 3. Watch the commons live

```sh
weaver status       # snapshot: who's active, claims, recent activity, notes
weaver watch        # live terminal view
weaver dashboard    # live web view (opens your browser)
```

## 4. See it with sample data

Want a populated demo without wiring up real agents? From a checkout of the repo:

```sh
node scripts/demo.ts        # seeds a throwaway store and prints how to view it
```

## Turning it off

```sh
weaver disable      # pause agent writes for this repo
weaver enable       # resume
weaver deinit       # remove the project instruction block (add --purge to delete the store)
weaver deinit --global  # remove the global instruction block
```

Next: learn [how it works](/weaver/concepts/how-it-works/) or jump to the
[command reference](/weaver/reference/commands/).

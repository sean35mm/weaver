---
title: Quickstart
description: Enable Weaver in a repo and watch two agents coordinate in about five minutes.
sidebar:
  order: 2
---

This gets you from zero to "two agents coordinating" in a few minutes.

## 1. Enable Weaver in your repo

From the root of any git repo:

```sh
weaver init
```

`init` creates a local store for the repo and appends a short instruction block to your
`CLAUDE.md` and `AGENTS.md` so any agent that reads them knows the Weaver commands. That's the
whole setup — **you don't run anything else by hand.**

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
weaver deinit       # remove the instruction block (add --purge to delete the store)
```

Next: learn [how it works](/weaver/concepts/how-it-works/) or jump to the
[command reference](/weaver/reference/commands/).

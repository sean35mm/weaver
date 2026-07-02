---
title: Dashboard & watch
description: Watch the commons live — a local web dashboard or a terminal view.
sidebar:
  order: 5
---

Two ways to watch what your agents are doing in real time.

## `weaver dashboard` — live web view

```sh
weaver dashboard            # opens your browser; Ctrl-C to stop
weaver dashboard --port 8080
weaver dashboard --no-open  # don't auto-open the browser
```

It spins up a tiny local server on `127.0.0.1`, opens your browser, and renders a live view:
a card per active session (harness, intent, heartbeat), the claim map, a streaming activity
timeline, and the notes panel. It updates ~once a second.

:::note[It's read-only and loopback-only]
The dashboard server is purely a **human viewer** — agents never talk to it; they only touch
the local SQLite file. It binds to `127.0.0.1` only, and it never writes. The coordination
layer stays serverless.
:::

## `weaver watch` — live terminal view

For the no-browser crowd, the same picture, redrawn in your terminal:

```sh
weaver watch                # Ctrl-C to stop
```

```text
🧵 weaver watch — 9b649acdba00f6dd   (Ctrl-C to stop)

3 other active sessions
  claude-code#alice      refactor the auth module to use AuthService   3s ago
  codex#bob              add a Google OAuth provider                    3s ago
  opencode#cleo          backfill auth unit tests                       2m ago
claims:
  src/auth/**              claude-code#alice — rewriting token refresh
  tests/auth/**            opencode#cleo — coverage only, won't touch src
```

## Snapshots

For a one-off (and for agents), `weaver status` prints the same picture once and exits;
`weaver status --json` gives structured output.

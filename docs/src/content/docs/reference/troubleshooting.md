---
title: Troubleshooting & FAQ
description: Common issues and how to diagnose them with weaver doctor.
sidebar:
  order: 3
---

## Start with `weaver doctor`

```sh
weaver doctor
```

It prints the resolved session key + source, repo id, store path, runtime/binding, and enabled
state — the fastest way to see what Weaver thinks is going on.

## Common issues

### "no session identity" when running an agent command
The mutating commands (`task`, `claim`, …) need a stable session identity. If your harness
doesn't expose one and there's no TTY, set it explicitly:
```sh
export WEAVER_SESSION=my-session
```
Observer commands (`status`, `check`) work without identity.

### Agents aren't coordinating
- Did you run `weaver init` in the repo? Check that the block exists in `CLAUDE.md`/`AGENTS.md`.
- Is it disabled? `weaver doctor` shows `enabled`. Re-enable with `weaver enable`.
- Are the agents actually in the **same repo**? `weaver doctor` shows the `repo` id — it should
  match across sessions.

### A crashed agent's claim seems stuck
It isn't — claims from stale sessions are treated as free (they show as `stale`, not active) and
expire on their TTL. See the [conflict model](/weaver/concepts/conflicts/).

### Preflight paused a commit or push
`weaver preflight` should only pause on relevant soft/hard overlaps with the paths being committed
or pushed. Unrelated active sessions are informational. If preflight reports a relevant overlap,
ask the user whether to continue, wait briefly, or coordinate first; do not silently poll for the
other session to run `weaver done` unless the user explicitly asked to wait.

If preflight reports your own work as another session, the hook or agent likely lost its session
identity. Set `WEAVER_SESSION` consistently, or run `weaver doctor` to inspect identity resolution.

### `weaver upgrade` says it's not applicable
`upgrade` only works on the standalone (curl-installed) binary. If you're running from source or
a dev link, that's expected — re-install via `install.sh` to get an upgradeable binary.

### Two sessions of the same harness show as one
They shouldn't — each session has a distinct harness session id. If they collapse, you may have
set the same `WEAVER_SESSION` in both; unset it and let auto-detection run, or give each a
unique value.

## FAQ

**Does Weaver send my code anywhere?** No. Everything is local under `~/.weaver/`. Nothing is
transmitted.

**Does it work offline?** Yes — except `weaver upgrade`, which fetches the latest release.

**Can I use just one agent?** Sure, but Weaver shines with several at once. With one it's mostly
a durable notebook (notes survive across sessions).

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

It prints the resolved session key/source, repo identity and root, runtime binding, enabled state,
session/claim/pad counts, and project/global integration freshness—the fastest way to see what
Weaver thinks is going on. `weaver audit` adds retained usage and recommendations.

## Common issues

### "no session identity" when running an agent command
The mutating commands (`task`, `claim`, …) need a stable session identity. If your harness
doesn't expose one and there's no TTY, set it explicitly:
```sh
export WEAVER_SESSION=my-session
```
Observer commands (`status`, `check`) work without identity.

### Agents aren't coordinating
- Did you run `weaver init` in the repo? Check that the block exists in the project or global
  instruction files you selected.
- Is it disabled? `weaver doctor` shows `enabled`. Re-enable with `weaver enable`.
- Are the agents actually in the **same repo**? `weaver doctor` shows the `repo` id — it should
  match across sessions.
- Did every agent run `status`, and did writing agents run `task` then claim exact scopes before
  editing? If a scratchpad trigger applies, the order is `task` → find/read/use the pad → `claim`.
- For Claude Code, install [hooks](/weaver/guides/claude-code-hooks/) (`weaver init --hooks`) for
  best-effort edit presence and advisories. Agents still use tasks and claims; pads remain optional.

### `scratchpad` is an unknown command after upgrading docs/instructions
The binary on `PATH` predates scratchpads, which were added in schema v5. Run `weaver --version`,
locate any duplicate binaries with your shell's command lookup, then upgrade or reinstall the
standalone binary. Do not purge the store: current Weaver migrates v4 → v5 → v6 automatically and
preserves existing Repository Facts.

### OpenCode does not show Weaver tools
Run `weaver doctor`. If the plugin is missing or outdated, refresh the scope where it was installed:

```sh
weaver init --project --hooks
# or
weaver init --global --hooks
```

Then fully restart OpenCode. A marker-less `.opencode/plugins/weaver.js` is foreign and Weaver will
not overwrite it; move or merge that user-owned file yourself. OpenCode ≥1.17 is required for
`shell.env`, with PTY propagation available from 1.17.7.

### Instructions or the OpenCode plugin are outdated
Managed blocks and plugins are versioned installed artifacts; replacing the binary does not rewrite
them. `doctor`/`audit` report current, outdated, missing, or foreign state and print scope-correct
refresh commands. Re-run `init --project` or `init --global`; include `--hooks` for harness
integrations. Text outside Weaver's managed block is preserved.

### A scratchpad write reports a stale revision
Another writer committed first. Re-read the relevant section and current revision, merge both
changes deliberately, then submit once with the new expected revision. Do not mechanically retry or
replace the whole document. The rich editor pauses autosave and preserves its local draft.

### Archive or trash reports a live attachment
Archive/trash will not close a pad another live session is using. Ask that session to switch pads or
run `weaver done`; do not force the lifecycle change. Archive completed work. Trash is for empty,
duplicate, accidental, or demonstrably obsolete pads and remains recoverable.

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

### The scratchpad UI does not open
The launch URL is always printed. Use `--open=browser` to bypass cmux detection, or `--no-open` for
SSH, containers, Linux without `xdg-open`, and other headless environments. The server is
loopback-only, so copy the URL only to a browser that can reach the same loopback namespace. Use
`weaver scratchpad edit <id> --revision <n>` with `$VISUAL`/`$EDITOR` when no browser is available.

### A different port was ignored or another browser tab opened
The first foreground owner chooses the port for its effective repo store, `WEAVER_HOME`, and OS
user. Worktrees in that scope are followers. `--no-open` only prints its URL; `--open=browser` asks
the OS browser to open it and cannot enforce tab deduplication; `auto`/`cmux` can focus only the
exact cmux surface Weaver created for the owner. A different home or user is a separate scope.

### The UI lease is stale but takeover has not happened yet
Dashboard recovery waits for the exact lease to expire and for its owner-specific private control
socket to fail, then atomically replaces the expired lease. The recorded PID is diagnostic only:
a live or reused PID does not block takeover and Weaver never signals it. An unexpired lease or a
responsive control endpoint still prevents takeover.

If the real owner is still running, stop the positively identified foreground command with Ctrl-C;
TERM and HUP use the same orderly path. Do not signal a process based only on the recorded PID.
If the old process resumes after takeover, it cannot serve API or event requests, renew its expired
lease, or release the successor's lease; its next heartbeat shuts it down. Do not accelerate
recovery by signaling a possibly reused PID, deleting SQLite rows/runtime locks, or killing generic
`weaver`, cmux, browser, or WebKit processes. If takeover still times out after the lease TTL, report
the lease and owner-specific control diagnostics.

### Purge or uninstall says the dashboard cannot be quiesced
Destructive maintenance fences the affected store(s), asks the exact owner to shut down through its
private control socket, and waits to prove the lease and endpoint are gone. A timeout, PID-reuse
ambiguity, unsafe endpoint, or ownership race causes refusal. Stop the actual foreground owner as
described above and retry. Do not delete locks or kill generic processes; refusal means Weaver could
not prove deletion safe.

### Two sessions of the same harness show as one
They shouldn't — each session has a distinct harness session id. If they collapse, you may have
set the same `WEAVER_SESSION` in both; unset it and let auto-detection run, or give each a
unique value.

## FAQ

**Does Weaver send my code anywhere?** No. Coordination content stays in plaintext local stores
under `~/.weaver/`; there is no telemetry or content upload. Install/upgrade download Weaver release
artifacts from GitHub.

**Does it work offline?** Yes — except `weaver upgrade`, which fetches the latest release.

**Can I use just one agent?** Sure, but Weaver shines with several at once. With one it provides a
coordination snapshot and durable Repository Facts, plus an optional workstream notebook.

**What deletes authored data?** Ordinary `deinit` only removes managed instructions/integrations.
`deinit --purge` deletes the current repo's entire store. Uninstall without `--keep-data` cleans the
effective `WEAVER_HOME`: the default `~/.weaver` may be recursively removed after validation, but an
explicit home loses only validated Weaver DB/sidecar files and keeps unrelated files and the
directory. `--keep-data` removes only the binary. Unsafe targets, unrecognized stores, or access
that cannot be safely fenced and quiesced cause refusal. Deleted authored history cannot be undone
by Weaver.

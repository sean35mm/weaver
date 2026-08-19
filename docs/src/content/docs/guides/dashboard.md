---
title: Scratchpad UI & watch
description: Edit workstream Markdown in a secure local rich/source UI or watch coordination in a terminal.
sidebar:
  order: 5
---

## `weaver scratchpads`: rich/source editor

```sh
weaver scratchpads
weaver scratchpads --port 8080
weaver scratchpads --open=browser
weaver scratchpads --open=cmux
weaver scratchpads --no-open
```

`dashboard`, `view`, and `ui` are aliases. The app includes:

- active/archived/trash libraries and Markdown search;
- WYSIWYG editing with a Markdown source mode;
- debounced autosave using expected revisions;
- conflict handling that pauses autosave and preserves the local draft;
- rename, archive, restore, trash, and recover controls;
- immutable revision history; and
- attached sessions, pad-attributed claims/activity, and Repository Facts beside the document.

The browser editor writes scratchpads; it is not merely a monitor. Agents still coordinate through
the CLI/store, so the UI is optional.

## One project UI, many scratchpads

The first invocation becomes the foreground owner of one server for the effective project store
and OS user. That server contains every scratchpad in the store. It may also own one cmux browser
surface that Weaver created and identified exactly. Later invocations are short-lived followers;
they reuse the owner's capability URL instead of starting another server. The owner's port wins, so
a follower's different `--port` is ignored with a notice.

The scope combines repository identity, the canonical effective `WEAVER_HOME`, and user id. Git
worktrees that resolve to the same repo id and home therefore reuse the UI. Different
`WEAVER_HOME` values or OS users can have separate instances.

## Browser, Linux, headless, and cmux launchers

`--open=auto` is the default. Inside a valid cmux workspace, Weaver tries an optional browser pane;
otherwise it uses the platform launcher (`open` on macOS, `xdg-open` on Linux). `--open=cmux`
requests the same cmux-first path; if cmux cannot be validated before pane creation, it falls back
to the normal browser. `--open=browser` skips cmux detection.

For a follower, launch behavior is narrower:

- `--no-open` prints the existing URL and exits;
- `--open=browser` asks the OS browser to open that URL, which may create another tab;
- `--open=auto` and `--open=cmux` ask the owner to focus its exact Weaver-managed cmux surface;
  if no such surface is available, Weaver leaves the printed URL for manual use.

Ordinary browsers offer no portable, enforceable way to deduplicate tabs. Weaver never searches
for or kills generic browser/WebKit processes to simulate that behavior.

For SSH, containers, CI, or a browser on another local surface, use `--no-open` and copy the printed
capability URL. The server itself remains loopback-only; do not proxy or expose it publicly.

If port 7777 is busy, Weaver selects an available loopback port. `--port 0` explicitly requests an
ephemeral port.

## Local security

The temporary HTTP server:

- binds only to `127.0.0.1`;
- rejects unexpected Host and Origin values;
- requires a random bearer capability for every API request;
- puts that capability in the URL fragment so it is not sent as an HTTP request target, then
  removes it from browser history;
- applies a restrictive Content Security Policy and other browser security headers;
- sanitizes rendered Markdown and allows only safe link schemes; and
- bounds request bodies and read time.

The owner uses an owner-specific Unix control socket inside a user-owned `0700` runtime directory;
the socket is `0600`. The random capability stays in owner memory, authenticated control replies,
and launch URLs. It is never persisted to SQLite or a lock file. Edits through the shared UI use
neutral human/dashboard attribution, not the identity of whichever follower opened or focused it.

Stop the foreground owner with Ctrl-C; TERM and HUP follow the same orderly path. Weaver closes the
HTTP and control servers, releases the lease, and closes only the exact cmux surface that owner
created. It does not close ordinary browser tabs or unrelated cmux/browser processes. Scratchpad
Markdown and context remain plaintext in SQLite, so do not write secrets or sensitive
personal/customer data.

The lease is renewed by a heartbeat. Crash takeover requires both an expired lease and failed
owner-specific control, followed by an atomic lease replacement. The recorded PID is diagnostic:
PID reuse cannot wedge dashboard recovery, and Weaver never signals that PID. A stale owner's HTTP
API is fenced as soon as its lease expires; if the process resumes, its next heartbeat is rejected
and shuts it down. See [Troubleshooting](/weaver/reference/troubleshooting/) for recovery details.

## `$EDITOR` instead of a browser

```sh
EDITOR=vim weaver scratchpad edit 7 --revision 12
# $VISUAL takes precedence over $EDITOR
```

Weaver creates a private temporary draft. A successful, changed edit commits at the expected
revision. Editor failures, invalid/oversized Markdown, and stale revisions preserve the draft and
print its path.

## `weaver watch`: terminal-only coordination view

```sh
weaver watch
```

`watch` redraws active sessions, claims, activity, and Repository Facts until Ctrl-C. It does not
edit pads. For a one-time machine-readable snapshot, use `weaver status --json`; for pad structure,
use `weaver scratchpad list/read --json`.

---
title: Configuration
description: Tune Weaver's TTLs and inspect settings with the config command.
sidebar:
  order: 6
---

Weaver works with sensible defaults; a few timing knobs are tunable per repo.

## Tunable settings

| Key                       | Default | What it controls |
| ------------------------- | ------- | ---------------- |
| `session_ttl_seconds`     | `900` (15 min) | How long after its last command (or `weaver check`) a session is considered live. |
| `claim_ttl_seconds`       | `1800` (30 min) | Default lifetime of a claim (refreshed on activity; override per claim with `--ttl`). |
| `recent_activity_seconds` | `1200` (20 min) | The window for "recent activity" used by `status` and soft-conflict detection. |

## View and set

```sh
weaver config                                # list all settings
weaver config session_ttl_seconds            # show one
weaver config session_ttl_seconds 120        # set it (in seconds)
```

Settings are stored per repo in the local store, so different projects can have different
TTLs.

## Per-claim TTL

Override the claim lifetime for a single claim without changing the default:

```sh
weaver claim 'src/auth/**' --reason "big refactor" --ttl 2h
```

`--ttl` accepts values like `90s`, `30m`, `2h`, `1d` (bounded between 1 minute and 24 hours).

## Diagnostics

`weaver doctor` prints identity quality, repo/root, runtime binding, enabled state, pad/session/claim
counts, and project/global integration freshness—the first thing to check when something looks off. See
[Troubleshooting](/weaver/reference/troubleshooting/).

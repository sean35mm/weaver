# Weaver

> **Your agents, finally in sync.**
> Shared situational awareness for multiple coding agents working in the same repo.

[![CI](https://github.com/sean35mm/weaver/actions/workflows/ci.yml/badge.svg)](https://github.com/sean35mm/weaver/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/sean35mm/weaver)](./LICENSE)

**Docs:** <https://sean35mm.github.io/weaver/> · **For agents:** [`llms.txt`](https://sean35mm.github.io/weaver/llms.txt)

Run Claude Code in one terminal, Codex in another, OpenCode in a third, and maybe Pi somewhere
else. They can all edit the same repo, but they do not naturally share context. They can collide
on files, duplicate work, miss fresh discoveries, and leave you to reconstruct what happened.

**Weaver is a local coordination layer for coding agents.** It gives every session in a repo the
same lightweight whiteboard: who is active, what they are doing, which areas are claimed, what
changed recently, and what the repo has taught them.

```console
$ weaver status
3 other active sessions
  claude-code   refactor the auth module       12s ago
  codex         add a Google OAuth provider     just now
  opencode      backfill auth unit tests        2m ago
⚠ src/auth/** claimed by claude-code — coordinate or work elsewhere
```

Weaver is not another editor, merge tool, daemon, or MCP server. It is a small CLI over a local
SQLite store. Agents call it with shell commands, humans watch the shared picture, and git remains
the source of truth for code.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/sean35mm/weaver/main/install.sh | sh
```

A single self-contained binary is installed into `~/.local/bin/weaver`. No Node, npm, server, or
cloud account is required. Supported platforms: macOS and Linux (arm64/x64); on Windows, use WSL2.

```sh
weaver --version
weaver init
```

`weaver init` asks where to install the agent protocol:

- **Project** (`--project`, the default): appends the instruction block to this repo's `CLAUDE.md`
  and `AGENTS.md`. Covers this checkout only — run `weaver init` again in each repo you want
  covered.
- **Global** (`--global`): appends the block to your global instruction files (`~/.claude/CLAUDE.md`,
  `~/.config/opencode/AGENTS.md`, `~/.codex/AGENTS.md`). One-time setup that covers every repo on
  the machine — you never run `init` again.

Either way, there is no per-repo database setup: each repo's store is created automatically the
first time an agent runs a weaver command there. After init, your agents coordinate on their own.

For Claude Code, `init` can also install **hooks** (`--hooks`) that make coordination structural
instead of voluntary: before every file edit Claude is warned — advisorily, never blocked — when
the target overlaps another live session, and after every edit the session's presence is
refreshed automatically. See the
[Claude Code hooks guide](https://sean35mm.github.io/weaver/guides/claude-code-hooks/).

Update with `weaver upgrade`; remove with `weaver uninstall`.

## Try it by hand

You normally run `weaver init` once and let your agents drive the workflow. To see the behavior
without real agents, simulate two sessions:

```sh
# terminal 1: alice
WEAVER_SESSION=alice weaver task "refactor the auth module"
WEAVER_SESSION=alice weaver claim 'src/auth/**' --reason "rewriting token refresh"

# terminal 2: bob
WEAVER_SESSION=bob weaver status
WEAVER_SESSION=bob weaver check src/auth/login.ts
```

Bob sees Alice's intent and claim before editing:

```text
⚠ CONFLICT (active claim) on this area:
  • alice — refactor the auth module
      claim: src/auth/** — rewriting token refresh
  → coordinate, work elsewhere, or ask the user how to split.
```

Claims are advisory. Weaver surfaces the risk; it never blocks an edit.

## How it works

Weaver is a shared whiteboard for agents in the same repo.

| Primitive | Commands | What it answers |
| --- | --- | --- |
| Presence | `task`, `status`, `done` | Who is active, and what are they trying to do? |
| Claims | `claim`, `release`, `check`, `preflight` | Is someone already working in this area? |
| Notes | `note`, `notes` | What durable repo learnings should future sessions know? |
| Activity | `log`, `activity` | What changed recently, and where? |

Every command opens the local store, reads or writes a small amount of state, and exits. There is
no background process. Liveness is based on heartbeats and TTLs, so crashed agents age out instead
of leaving permanent locks.

The store is keyed by repo identity, not by directory. Multiple terminals and git worktrees for
the same repo share one commons under `~/.weaver/`.

## Who runs what

After setup, Weaver is built to be called mostly by agents.

| Role | Commands | Purpose |
| --- | --- | --- |
| Human setup | `weaver init`, `weaver disable`, `weaver enable`, `weaver deinit` | Turn coordination on, pause it, or remove it from a repo. |
| Agents | `task`, `claim`, `check`, `note`, `log`, `preflight`, `done` | Announce intent, avoid collisions, record learnings, and check risk before commit/push/PR. |
| Humans | `status`, `watch`, `dashboard`, `notes`, `activity`, `doctor` | Watch the shared picture and diagnose setup when something looks wrong. |

Day to day, humans usually run one of these:

```sh
weaver status       # snapshot: active sessions, claims, activity, notes
weaver watch        # live terminal view
weaver dashboard    # live local web view
```

Agents follow this loop after `weaver init` teaches them the protocol:

```sh
weaver status
weaver task "refactor the auth module"
weaver claim 'src/auth/**' --reason "rewriting token refresh"
weaver check src/auth/login.ts
weaver note "AuthService owns token refresh; do not call jwt.* directly"
weaver preflight --staged
weaver done
```

## What you get

- **Cross-agent presence**: every live session can see the others, even across harnesses and
  windows.
- **Advisory file claims**: agents get a clear conflict signal before silently overwriting each
  other.
- **Bounded preflight checks**: commits, pushes, and PRs can be checked only against the paths
  being shipped.
- **Durable notes**: repo-specific gotchas and conventions survive context compaction and new
  sessions.
- **Recent activity**: agents and humans can see what changed without reading every terminal.
- **Live views**: `weaver dashboard` and `weaver watch` show the commons as it changes.

## Safety model

- **Local only**: coordination data lives under `~/.weaver/`. Weaver does not send your code or
  notes anywhere.
- **Serverless**: there is no daemon or coordination server to start, expose, authenticate, or keep
  alive.
- **Advisory, not blocking**: claims surface risk. They do not replace git, file locks, review, or
  merge conflict handling.
- **Self-healing liveness**: stale sessions and crashed agents age out by TTL.
- **Universal interface**: any agent that can run shell commands can participate. First-class
  targets include Claude Code, Codex, OpenCode, and Pi.

## Command map

```text
Agent commands:
  weaver task "<intent>"                 announce what this session is doing
  weaver claim '<glob>' --reason "..."   claim an area, surfacing overlaps
  weaver check <path>                    check whether another live session is there
  weaver note "<text>"                   record durable repo knowledge
  weaver log <kind> <path> "<summary>"   record activity
  weaver preflight --staged              check staged paths before commit
  weaver preflight --upstream            check branch diff before push
  weaver preflight --base main           check PR-sized diff
  weaver done                            end the session and release claims

Human commands:
  weaver status                          print the current picture
  weaver watch                           live terminal view
  weaver dashboard                       live local web view
  weaver notes                           list repo notes
  weaver activity                        list recent activity
  weaver doctor                          show identity, repo, store, and runtime diagnostics

Lifecycle commands:
  weaver init [--project|--global]       enable Weaver in this repo
  weaver disable / enable                pause or resume agent writes
  weaver deinit [--project|--global] [--purge]  remove instructions, optionally delete the store
  weaver config                          view or tune TTLs
  weaver upgrade                         update the standalone binary
  weaver uninstall                       remove the binary
```

For exact flags and examples, see the [CLI reference](https://sean35mm.github.io/weaver/reference/commands/).

## Learn more

- [Quickstart](https://sean35mm.github.io/weaver/getting-started/quickstart/)
- [Using Weaver from an agent](https://sean35mm.github.io/weaver/guides/using-from-an-agent/)
- [Conflict model](https://sean35mm.github.io/weaver/concepts/conflicts/)
- [Why CLI, not MCP?](https://sean35mm.github.io/weaver/concepts/why-cli-not-mcp/)
- [Architecture](https://sean35mm.github.io/weaver/reference/architecture/)
- [Machine-readable docs for agents](https://sean35mm.github.io/weaver/for-llms/)

Contributing: [`CONTRIBUTING.md`](./CONTRIBUTING.md) · Releases: [`RELEASING.md`](./RELEASING.md)

## License

MIT.

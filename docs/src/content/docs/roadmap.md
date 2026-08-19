---
title: Roadmap
description: Where Weaver is headed — what's in flight now, what's coming next, and the directional bets for later.
---

This is a living view of where Weaver is going, grouped by **horizon** rather than dates.
Items move up a tier as they progress. It's a direction, not a contract — priorities shift as
the project (and the way people run agents) evolves.

<div class="wv-eyebrow">▸ Recently shipped</div>

- **Workstream scratchpads** — curated Markdown, optimistic revisions, immutable history,
  session/worktree attachments, and active/archive/trash lifecycle through one scriptable CLI.
- **Rich scratchpad UI** — WYSIWYG/source editing, search, autosave conflict handling, lifecycle
  actions, pad context, browser/cmux launchers, and a headless URL.
- **Official OpenCode tools** — fixed scratchpad and Repository Facts operations through the
  official `tool` hook, plus first-class session identity, best-effort edit logging/advisories, and
  session cleanup. See the
  [plugin guide](/weaver/guides/opencode-plugin/).
- **Repository Facts terminology** — `fact`/`facts` are the preferred commands while
  `note`/`notes` remain compatible aliases and existing data stays unchanged.
- **Facts & activity search** — free-text and path/topic/kind/time filters over retained knowledge
  and coordination history.
- **Usage audit & local metrics** — `weaver audit` summarizes retained usage, setup coverage,
  and concrete recommendations; observer commands record content-free usage events, locally
  only, so the audit can tell whether agents actually follow the protocol.
- **Ancestry harness labels** — sessions from harnesses that expose no env signal are now
  labeled by walking the process tree.
- **Claude Code hooks** — coordination is now structural for Claude Code: an advisory warning
  before any edit that overlaps another live session, and automatic presence after every edit.
  See the [hooks guide](/weaver/guides/claude-code-hooks/).
- **Fact lifecycle** — Facts have ids; `fact --update` supersedes, and `forget` retires/restores with
  audit history.

<div class="wv-eyebrow">▸ Now — in flight</div>

What's actively being worked on.

- **Real-world dogfooding** — running scratchpads-first coordination on Weaver itself across Claude
  Code, OpenCode, Codex, and ordinary terminals, then tightening the protocol from observed gaps.

<div class="wv-eyebrow">▸ Next — committed, soon</div>

Lined up and likely to land in the near term.

- **More harness coverage** — Cursor, Gemini CLI, and Aider recognized out of the box.
- **Richer workstream views** — deeper filtering and navigation across pads, agents, and areas.

<div class="wv-eyebrow">▸ Later — directional</div>

Bets we're interested in but haven't committed to. Feedback shapes what makes the cut.

- **Optional shared / remote commons** — opt-in sync so agents on *different machines* can share context. The core stays local-first and serverless; this would be strictly additive.
- **Harness-native packaging** — ship Weaver as a Claude Code plugin / skill (and equivalents) for one-step setup.
- **Smarter conflict advisories** — suggest *how* to split overlapping work, not just flag the collision.
- **Richer query layer** — revisit a graph-style query over the commons, if demand warrants.
- **Native Windows support** — today Windows runs via WSL2; native binaries if demand shows up.

<div class="wv-eyebrow">▸ Shape the roadmap</div>

Weaver is open source and the roadmap is meant to be influenced.

- **Have an idea or a pain point?** [Open an issue](https://github.com/sean35mm/weaver/issues).
- **Want something prioritized?** 👍 the issue — reactions are a real signal.
- **Want to build it?** See [Contributing](/weaver/contributing/). Changes land through pull requests.

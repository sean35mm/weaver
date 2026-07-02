---
title: Roadmap
description: Where Weaver is headed — what's in flight now, what's coming next, and the directional bets for later.
---

This is a living view of where Weaver is going, grouped by **horizon** rather than dates.
Items move up a tier as they progress. It's a direction, not a contract — priorities shift as
the project (and the way people run agents) evolves.

<div class="wv-eyebrow">▸ Recently shipped</div>

- **Usage audit & local metrics** — `weaver audit` summarizes retained usage, setup coverage,
  and concrete recommendations; observer commands record content-free usage events, locally
  only, so the audit can tell whether agents actually follow the protocol.
- **Ancestry harness labels** — sessions from harnesses that expose no env signal are now
  labeled by walking the process tree.
- **Claude Code hooks** — coordination is now structural for Claude Code: an advisory warning
  before any edit that overlaps another live session, and automatic presence after every edit.
  See the [hooks guide](/weaver/guides/claude-code-hooks/).
- **Note lifecycle** — notes have ids and `weaver note --update <id>` supersedes stale learnings.

<div class="wv-eyebrow">▸ Now — in flight</div>

What's actively being worked on.

- **OpenCode plugin** — first-class session identity for OpenCode ≥1.17 via its `shell.env`
  plugin hook, installed by `weaver init --hooks`. See the
  [plugin guide](/weaver/guides/opencode-plugin/).
- **Real-world dogfooding** — running Weaver on its own repo across Claude Code and OpenCode, folding the findings back in.

<div class="wv-eyebrow">▸ Next — committed, soon</div>

Lined up and likely to land in the near term.

- **OpenCode structural coordination** — pre/post-edit advisories and automatic session
  cleanup through OpenCode's plugin events (`tool.execute.*`, `session.idle`/`deleted`),
  matching what the Claude Code hooks provide today.
- **More harness coverage** — Cursor, Gemini CLI, and Aider recognized out of the box.
- **Notes & activity search** — query and filter notes and history instead of scanning the whole log.
- **Dashboard & watch upgrades** — a richer live view, with filtering by area or agent.

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

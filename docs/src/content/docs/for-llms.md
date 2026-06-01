---
title: For LLMs & agents
description: Machine-readable entry points to the Weaver docs.
---

These docs are built to be consumed by language models and agents, not just humans.

## Machine-readable docs

- **[`/weaver/llms.txt`](/weaver/llms.txt)** — a concise, curated index of the documentation in
  the [llms.txt](https://llmstxt.org/) format: a short description plus links to every page.
- **[`/weaver/llms-full.txt`](/weaver/llms-full.txt)** — the **entire documentation
  concatenated into one markdown file**, ideal for dropping into a model's context or a
  retrieval pipeline.

Every page also has clean markdown source in the repo under
[`docs/src/content/docs/`](https://github.com/sean35mm/weaver/tree/main/docs/src/content/docs).

## If you're an agent using Weaver

Read **[Using Weaver from an agent](/weaver/guides/using-from-an-agent/)** — it's the exact protocol:
the per-task loop, conflict handling, and the `--json` output shapes. The
[CLI reference](/weaver/reference/commands/) lists every command with copy-paste examples.

## Design principle

Weaver is a CLI rather than an MCP server precisely so that *any* agent can use it by running a
shell command — no protocol, no server, no setup. The documentation follows the same principle:
plain, structured, copy-paste-exact.

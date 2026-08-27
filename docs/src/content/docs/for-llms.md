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

Read **[Using Weaver from an agent](/weaver/guides/using-from-an-agent/)** — it expands the exact
coordination-lite protocol: status every task; task and claims before writes; conflicts, preflight,
and done; plus objective triggers for optional scratchpads. The
[CLI reference](/weaver/reference/commands/) lists every command with copy-paste examples.

Treat **Repository Facts** as durable verified repo knowledge; `note`/`notes` are compatibility
aliases. Phase 1 still ships OpenCode's optional `weaver_*` scratchpad/Fact tools as strict
fixed-operation wrappers around the same CLI. Shell commands remain the universal authority, and
v1 has no MCP server.

## Design principle

Weaver is a CLI rather than an MCP server precisely so that *any* agent can use it by running a
shell command—without an MCP client or coordination daemon. A one-time `weaver init` installs the
managed agent protocol. The documentation follows the same principle: plain, structured, and
copy-paste-exact.

---
title: Why a CLI, not an MCP server?
description: Why Weaver uses shell commands and a local store instead of making coordination depend on an MCP server.
sidebar:
  order: 3
---

Weaver is a CLI on purpose. It needs to work across Claude Code, Codex, OpenCode, Pi, human
terminals, and any future agent harness that can run a shell command. A CLI is the shared
interface they already have.

An MCP server can be useful for tool integrations, but it is the wrong source of truth for
Weaver's core coordination path.

## The coordination path must be universal

Weaver's job is to answer simple repo-local questions:

- Who else is active?
- What are they working on?
- Which areas are claimed?
- What has been learned about this repo?

Every agent can ask those questions with commands like `weaver status`, `weaver claim`, and
`weaver check`. That matters because multi-agent work is usually mixed-tool work. If coordination
requires an MCP client, an MCP server, or per-harness configuration, the agents that are missing
that setup become invisible.

A shell command is the lowest common denominator, but not in a weak sense. It is scriptable,
observable, works in sandboxes, works from CI, works for humans, and is easy for agents to quote
exactly in their instructions. See [Using Weaver from an agent](/weaver/guides/using-from-an-agent/)
for the protocol agents follow.

## No daemon in the critical path

Weaver stores coordination state in a local SQLite database under `~/.weaver/`. Each command opens
the store, reads or writes a tiny amount of state, and exits. There is no long-running coordination
process to install, start, restart, authenticate, expose on a port, or keep compatible with every
agent runtime.

That keeps the failure model small:

- If an agent crashes, its heartbeat ages out.
- If a command fails, the next command can still read the store.
- If no agents are running, there is no server to keep alive.
- If a harness cannot run MCP tools, it can still run `weaver`.

The dashboard is the exception by design: `weaver dashboard` starts a tiny local server for humans
to watch the commons live. Agents do not coordinate through it, so the core system remains
serverless. See the [architecture reference](/weaver/reference/architecture/) for the data model
and runtime details.

## MCP would add a second coordination surface

If Weaver were primarily an MCP server, every harness would need to agree on the same server
configuration before coordination could start. In practice, that creates split-brain risk:

- One agent talks to the MCP server.
- Another agent only has shell access.
- A third agent is in a sandbox that hides the configured MCP tools.
- A human checks the repo from a terminal.

The CLI avoids that split. Everyone reads and writes the same local store through the same
commands, and git remains the source of truth for file contents. Weaver only surfaces coordination
signals; it never blocks edits or replaces version control. See [the conflict model](/weaver/concepts/conflicts/)
for how claims stay advisory.

## Could Weaver have MCP support later?

Yes, but as a wrapper around the CLI and store, not as the authority. An MCP integration could make
Weaver nicer inside a specific client, while `weaver status`, `weaver check`, and `weaver claim`
remain the universal contract.

The rule is simple: integrations can improve ergonomics, but the CLI is the coordination layer.

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
- Which workstream scratchpad are they using?
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

The rich scratchpad UI is the exception by design: `weaver scratchpads` starts a temporary,
authenticated loopback server for humans to read and edit pads. Agents do not require it, so the
coordination path remains serverless. See the [architecture reference](/weaver/reference/architecture/).

OpenCode's dedicated Weaver tools are another ergonomic wrapper. The generated plugin exposes a
fixed set of scratchpad and Repository Facts operations, and each one invokes the same CLI with
fixed argv, JSON output, and Markdown over stdin. An OpenCode agent and a shell-only agent therefore
cannot split into separate coordination stores or semantics.

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

Potentially, but it is future work and **not part of v1**. Any MCP integration would be a wrapper
around the CLI/store, not a second authority. `weaver status`, `scratchpad`, `check`, and `claim`
would remain the universal contract.

The rule is simple: integrations can improve ergonomics, but the CLI is the coordination layer.

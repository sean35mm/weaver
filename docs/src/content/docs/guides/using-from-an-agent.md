---
title: Using Weaver from an agent
description: The exact coordination-lite protocol a coding agent should follow.
sidebar:
  order: 2
---

This is the expanded form of the versioned block installed by `weaver init`.

## Start every task

```sh
weaver status
```

**Read-only and plan-only work stops there** unless status or the user identifies a relevant existing
pad. You may read that pad, but do not create or attach one, register a task, claim files, or call
`done`.

Once repository writes are authorized, use this concise flow when no scratchpad trigger applies:

```sh
weaver task "<specific goal>"
weaver claim '<glob>' --reason "<why this area is needed>"
```

Claim every path you expect to edit, each scope once, before the first edit.

## Use a scratchpad only when it helps coordination

A pad is optional. Use one only for a matching active pad, multiple collaborating sessions,
planned handoff/resumption, a conflict/shared decision record, or an explicit user request.
Complexity or duration alone does not require one.

```sh
weaver task "<specific goal>"
weaver scratchpad list
weaver scratchpad read <id> --headings
weaver scratchpad create "<workstream title>" --from - # only if no matching pad exists
weaver scratchpad use <id>
weaver claim '<glob>' --reason "<why this area is needed>"
```

When a trigger applies, find/read/use the pad after `task` and before `claim`; claims snapshot the
current attachment. In either flow, claim each scope once before the first repository edit.

## Maintain curated shared Markdown

Use stable headings for decisions, constraints, findings, and next steps. Do not dump transcripts,
routine command output, or unverified speculation.

Read the current revision before changing the pad. Prefer a targeted section write:

```sh
weaver scratchpad read 7 --section Findings --json
printf '%s\n' '<replacement body below the heading>' |
  weaver scratchpad edit-section 7 Findings --from - --revision 12
```

A stale revision means another writer changed the pad. Re-read and merge deliberately; never
overwrite or mechanically retry at the newer revision. A small `append --revision <n>` is suitable
when no existing section should be replaced. Avoid whole-body `replace` unless the rewrite is
intentional.

## Promote Repository Facts

When a pad is used, task state belongs there. Verified, lasting repo knowledge belongs in
Repository Facts whether or not the task has a pad:

```sh
weaver fact "AuthService owns token refresh" --path 'src/auth/**'
weaver facts auth --json
weaver fact "AuthService moved to src/core/auth" --update 12
weaver forget 17 "the old Docker setup was removed"
```

Use `--pin` only for rare repo-wide facts. `note` and `notes` remain compatibility aliases, but new
work should use `fact` and `facts`. Never store secrets, credentials, personal data, or sensitive
customer data in pads, Facts, intents, reasons, or summaries.

## Conflict playbook

Claim exit `1` means the claim **was recorded** and a conflict was surfaced. Do not rerun it.

1. Read the other live session's intent, claims, activity, and attached pad when one exists.
2. Prefer useful non-overlapping work.
3. Proceed only when the overlap is demonstrably harmless.
4. Otherwise coordinate in a shared pad when useful and ask the user how to split the work.
5. Never silently edit over another live session.

Known different-worktree overlaps are informational because checked-out files are isolated. Still
coordinate before merge/rebase/integration can collide. See [The conflict model](/weaver/concepts/conflicts/).

## Finish and deliver

Before commit, push, or PR, run one bounded check:

```sh
weaver preflight --staged
weaver preflight --upstream
weaver preflight --base main
```

If relevant soft/hard overlap appears, pause and ask the user. Do not silently poll or wait unless
the user explicitly requests waiting.

If a pad was used, update final decisions and next steps. Archive it only when the whole workstream
is complete; leave a paused/shared workstream active when other sessions still need it.

```sh
# optional, only when the whole workstream is complete:
weaver scratchpad archive 7 --revision 14
weaver done
```

Agents may trash only pads that are empty, duplicates, or demonstrably obsolete, always with a
reason and current revision, and never while another live session is attached. Recover mistakes;
there is no permanent per-pad purge. The separate `weaver deinit --purge` command removes the
repository's entire local Weaver store, including every scratchpad and its history.

## Machine-readable reads

Use JSON for structured CLI output:

```sh
weaver status --json
weaver scratchpad list --json
weaver scratchpad read 7 --section Decisions --json
weaver facts --json
weaver activity --json
weaver preflight --staged --json
```

OpenCode users with the generated plugin can still use its optional dedicated scratchpad/Fact
`weaver_*` tools in Phase 1; those tools are strict wrappers around these same commands. Shell
commands remain the universal authority.

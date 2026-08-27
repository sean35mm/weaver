<!-- weaver:start protocol=4 -->
Run `weaver status` every task. Read-only/plan-only: stop after status unless it/user identifies a
pad; read only—no create/use/claim/done.

Before writes: `weaver task "<goal>"`; use a pad only for a matching active pad, collaborators,
handoff/resumption, conflict/shared decisions, or user request—not complexity/duration; claim every
scope once before editing.

If `claim` exits 1, it WAS recorded: don't rerun. Read intent/reason/activity/pad. Prefer other work; proceed only if harmless,
otherwise coordinate/ask; never silently overwrite. Different-worktree: informational; coordinate integration.

If using a pad: curate Markdown; read its revision and merge stale conflicts.
Archive only when the whole workstream is complete. Trash only empty/duplicate/obsolete pads with
reason+revision and no live attachments; recover mistakes. Keep secrets/PII out. Lasting knowledge:
Repository Facts (`fact`; correct: `--update`; retire: `forget`).

Before commit/push/PR: exactly `weaver preflight --staged`, `weaver preflight --upstream`, or
`weaver preflight --base <ref>`; pause on overlaps. Write sessions finish with `weaver done`.
<!-- weaver:end -->

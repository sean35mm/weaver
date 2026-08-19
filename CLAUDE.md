<!-- weaver:start protocol=3 — managed by Weaver; re-run `weaver init` at the same scope to update -->
## Weaver — scratchpads-first agent coordination

Other agents may be working in this repo right now. Weaver is a local CLI that keeps you
aware of them. If `weaver` is unavailable, ignore this block.

**Start every task**
1. Run `weaver status`.
2. Run `weaver scratchpad list`; reuse the active pad for this workstream, or create one with
   `weaver scratchpad create "<title>" --from -`. Different workstreams should use different pads.
3. Read before investigating: `weaver scratchpad read <id> --headings`, then read relevant
   sections. For read-only/plan-only work, you may read pads but must not attach or change them.
4. Once writes are authorized, run `weaver task "<goal>"`, attach with
   `weaver scratchpad use <id>` **before repository writes**, then claim every path you will edit:
   `weaver claim '<glob>' --reason "<why>"`. Claim each scope once.

**Keep the pad useful**
- Treat it as curated shared Markdown: keep decisions, constraints, findings, and next steps under
  stable headings; do not dump transcripts or routine command output.
- Read the current revision before changing it. Prefer targeted writes such as
  `weaver scratchpad edit-section` (or a small `weaver scratchpad append`) with
  `--revision <current>`; on a stale revision, re-read and merge deliberately. Do not overwrite
  another writer's work.
- Promote lasting repo knowledge to **Repository Facts** with `weaver fact "<learning>"`
  (scope with `--path`; correct with `--update <id>`; retire with `weaver forget <id> "<why>"`).
- Keep secrets, credentials, personal data, and sensitive customer data out of pads and facts.

**On a conflict** (`status`/`claim` shows another *live* session in your area): exit 1 from
`claim` means your claim WAS recorded and a conflict was surfaced — don't re-run it. Read their
intent, claims, activity, and attached pad. Prefer other work; proceed only if the overlap is
demonstrably harmless; otherwise record your intent in the pad and ask the user how to split it.
Never silently edit over another live session. Known different-worktree overlaps are informational,
but coordinate before integration can collide.

**Lifecycle:** archive a completed pad with its current revision. Agents may trash only pads that
are empty, duplicates, or demonstrably obsolete, always with `--reason` and `--revision`, and
never while another live session is attached. Recover mistaken trash; there is no permanent per-pad
purge (the separate `weaver deinit --purge` command removes this repository's entire local store).

**Before commit/push/PR:** run `weaver preflight --staged`, `weaver preflight --upstream`,
or `weaver preflight --base <ref>` when available. If it reports relevant soft/hard overlaps,
pause and ask the user. When finished, update/archive the pad as appropriate, then run
`weaver done` to detach and release claims.
<!-- weaver:end -->

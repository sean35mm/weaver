<!-- weaver:start — managed by Weaver; re-run `weaver init` to update, `weaver deinit` to remove -->
## Weaver — shared agent context

Other agents may be working in this repo right now. Weaver is a local CLI that keeps you
aware of them. If the `weaver` command isn't found, ignore this section.

**Do these every task (high value, low effort):**
- **At the start:** run `weaver status` to see who's active, their intent, claimed areas,
  and notes. For read-only/plan-only work, stop there.
- **When implementation or other writes are approved:** run `weaver task "<your goal>"`.
- **Claim the area you'll work in, once:** `weaver claim '<glob>' --reason "<why>"`
  (e.g. `weaver claim 'src/auth/**' --reason "refactoring token flow"`).
- **Record durable learnings** about this repo (gotchas, conventions, "X breaks Y"):
  `weaver note "<learning>"`.
- **When finished:** `weaver done`.

**On a conflict** (`status`/`claim` shows another *live* session in your area): read their
intent + reason + recent activity, then — (1) prefer to work elsewhere and re-check later;
(2) if the overlap is harmless, proceed; (3) if you're blocked, `weaver note` your intent
and **ask the user how to split the work**. Never silently edit over another agent's active
area.

**Before commit/push/PR:** run `weaver preflight --staged`, `weaver preflight --upstream`,
or `weaver preflight --base <ref>` when available. If it reports relevant soft/hard overlaps,
pause and ask the user whether to continue, wait briefly, or coordinate. Do not silently poll or
wait for another session to run `weaver done` unless the user explicitly asks you to wait.

**Optional (when useful):** `weaver check <path>` before touching a file you're unsure
about; `weaver log <kind> <path> "<summary>"` after a notable change so others see it.

Keep reasons/notes short, specific, and free of secrets — other agents read them to coordinate.
<!-- weaver:end -->

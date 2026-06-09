# AGENTS.md — for agents (and humans) working on the Weaver repo

Weaver is a CLI-first, serverless coordination layer that gives multiple coding agents shared
situational awareness in the same repo. This file orients you; the public docs are linked below.

## Project docs

- **[README.md](./README.md)** — what Weaver is, the data model, commands, conflict model.
- **[CONTRIBUTING.md](./CONTRIBUTING.md)** — setup, where things live, the bar for changes.
- **[RELEASING.md](./RELEASING.md)** — how to cut/publish a release. **Always follow this for
  releases.**

## Commands

```bash
node src/cli.ts --help     # or: bun src/cli.ts --help   (runs TS directly, no build needed)
npm test                   # node --test  (must pass)
npm run test:bun           # bun test     (must also pass — CI runs both)
npm run typecheck          # tsc --noEmit
npm run build              # tsc → dist/
node scripts/demo.ts       # seed a throwaway store, then `weaver watch` / `dashboard`
```

## Conventions (important)

- **Conventional Commits** (`feat:`/`fix:`/`chore:`/`docs:`/`refactor:`/`test:`) — they drive
  versioning and the changelog via release-please. This is mandatory.
- Tests use `node:test` + `node:assert/strict` and must pass on **both Node and Bun**.
- Relative imports use explicit **`.ts` extensions** (required by Node type-stripping + Bun).
- Keep pure logic **clock-injectable** (pass `now` in); no `Date.now()` inside testable units.
- Keep the core **zero-runtime-dependency** where practical (`picomatch` is the only one).
- Validation is **lenient at the CLI boundary**: never throw a stack trace at an agent, and
  `check` must never crash a tool call.
- The CLI is the **universal engine** — never add a hard dependency on one harness.

## Releasing — short version

Don't hand-create releases. Land `feat:`/`fix:` commits on `main`, then **merge the
"chore: release vX.Y.Z" PR** that release-please opens. That tags the release, builds + attaches
the standalone binaries. Full details and the
pre-flight checklist are in **[RELEASING.md](./RELEASING.md)**.

<!-- weaver:start — managed by Weaver; re-run `weaver init` to update; use `weaver deinit` for project files or `weaver deinit --global` for global files -->
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

**On a conflict** (`status`/`claim` shows another *live* session in your area): exit 1 from
`claim` means your claim WAS recorded and a conflict was surfaced — don't re-run it. Read their
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

# Contributing to Weaver

Thanks for your interest! Weaver is a CLI-first, serverless coordination layer for multiple
coding agents working in the same repo. The guiding constraints are in
[`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) — please skim them before a substantial
change.

## Setup

```bash
git clone <repo>
cd weaver
npm install            # only dev deps + picomatch; SQLite is built into Node/Bun
```

No build is needed for development — both runtimes run the TypeScript directly.

## Running

```bash
node src/cli.ts --help          # or: bun src/cli.ts --help
node scripts/demo.ts            # seed a throwaway store, then `weaver watch` / `dashboard`
```

## Tests

The suite must pass under **both Node and Bun** (CI runs both):

```bash
npm test            # node --test
npm run test:bun    # bun test
npm run typecheck   # tsc --noEmit
```

- Tests use `node:test` + `node:assert/strict` so they run identically on both runtimes.
- Keep pure logic clock-injectable (pass `now` in) — no `Date.now()` inside testable units.
- Relative imports use explicit `.ts` extensions (required by Node type-stripping + Bun).

## Conventions

- **Conventional Commits** (`feat:`, `fix:`, `chore:`, `docs:`, …) — they drive the changelog
  and version bumps via `release-please`. Releases follow **[RELEASING.md](./RELEASING.md)**.
- **SemVer**, currently `0.x` (minor versions may break until `1.0`).
- Keep the core **zero-runtime-dependency** where possible (picomatch is the only runtime dep).
- Validation stays lenient at the CLI boundary; never throw a stack trace at an agent, and
  `check` must never crash a tool call.
- The CLI is the universal engine — don't add a hard dependency on any single harness.

## Where things live

- `src/store/` — SQLite binding adapter, schema, the `Store` interface + impl, reaping
- `src/identity/`, `src/repo/` — session identity ladder, repo identity, path normalization
- `src/commands/` — one file per verb; each exports a `run(ctx)` 
- `src/conflict.ts`, `src/glob.ts`, `src/render.ts`, `src/validate.ts`, `src/args.ts`
- `src/dashboard/` — the read-only web viewer
- `test/` — unit + integration (run on both runtimes)

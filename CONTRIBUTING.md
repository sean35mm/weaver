# Contributing to Weaver

Thanks for your interest! Weaver is a CLI-first, serverless coordination layer for multiple
coding agents working in the same repo. Please skim the README and docs before a substantial
change.

## Setup

```bash
git clone <repo>
cd weaver
npm install            # tooling plus bundled dashboard editor/sanitizer; SQLite is built into Node/Bun
```

Development needs **Node >= 22.18.0** (the first 22.x that runs TypeScript and `node:sqlite`
without flags) or Bun. Users of the installed binary need neither — it's self-contained.

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
npm run lint        # biome check (lint + format); `npm run lint:fix` to auto-fix
npm run build       # non-mutating dashboard/typecheck/standalone production verification
```

- Tests use `node:test` + `node:assert/strict` so they run identically on both runtimes.
- Keep pure logic clock-injectable (pass `now` in) — no `Date.now()` inside testable units.
- Relative imports use explicit `.ts` extensions (required by Node type-stripping + Bun).

## Conventions

- **Conventional Commits** (`feat:`, `fix:`, `chore:`, `docs:`, …) — they drive the changelog
  and version bumps via `release-please`. Releases follow **[RELEASING.md](./RELEASING.md)**.
- **SemVer**, currently `0.x` (minor versions may break until `1.0`).
- Keep the CLI core **zero-runtime-dependency** where possible (`picomatch` is its only runtime
  dependency). `@toast-ui/editor` and `dompurify` are bundled into the generated dashboard asset;
  they are not loaded on ordinary CLI or hook invocations.
- Validation stays lenient at the CLI boundary; never throw a stack trace at an agent, and
  `check` must never crash a tool call.
- The CLI is the universal engine — don't add a hard dependency on any single harness.

## Where things live

- `src/store/` — SQLite binding adapter, schema, the `Store` interface + impl, reaping
- `src/identity/`, `src/repo/` — session identity ladder, repo identity, path normalization
- `src/commands/` — one file per verb; each exports a `run(ctx)`
- `src/instructions/` — the injected instruction block + Claude Code hooks settings merge
- `src/conflict.ts`, `src/glob.ts`, `src/render.ts`, `src/validate.ts`, `src/args.ts`
- `web/dashboard/`, `src/dashboard/` — the bundled rich editor and authenticated loopback server.
  The UI can write scratchpads; preserve bearer authentication, revision CAS, sanitization, and
  `npm run build:dashboard` / `npm run check:dashboard` determinism when changing it. Also preserve
  the per-store/user singleton, private owner socket, in-memory capability, neutral human
  attribution, exact cmux-surface cleanup, and fail-closed maintenance fence. Dashboard takeover
  requires an expired lease plus a failed owner-specific control CAS; destructive maintenance and
  store-holder cleanup remain process-identity conservative. Never replace exact ownership with
  generic process/browser/WebKit discovery or killing.
- `test/` — unit + integration (run on both runtimes)

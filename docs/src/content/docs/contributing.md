---
title: Contributing
description: How to set up, test, and contribute to Weaver.
---

Weaver is open source (MIT) and contributions are welcome. The full guide lives in the repo:
[`CONTRIBUTING.md`](https://github.com/sean35mm/weaver/blob/main/CONTRIBUTING.md).

## Quick start

```sh
git clone https://github.com/sean35mm/weaver
cd weaver
npm install            # tooling + bundled dashboard editor; SQLite is built into Node/Bun
node src/cli.ts --help # run directly — no build needed
```

## The bar

- Tests must pass on **both Node and Bun**: `npm test` and `npm run test:bun`.
- `npm run typecheck` must be clean.
- `npm run build` verifies generated dashboard assets, TypeScript, and a temporary standalone binary.
- Use **Conventional Commits** (`feat:`, `fix:`, `chore:`, …) — they drive versioning and the
  changelog.
- Keep the CLI core **zero-runtime-dependency** where practical (`picomatch` is its only runtime
  dependency). Toast UI Editor and DOMPurify are intentionally bundled into the dashboard asset
  and lazily loaded only by dashboard commands.
- Validation stays lenient at the CLI boundary — never throw a stack trace at an agent, and
  `check` must never crash a tool call.
- The CLI is the **universal engine** — don't add a hard dependency on any single harness.
- The scratchpad dashboard is a writable, bearer-authenticated loopback UI. Changes must preserve
  revision CAS, draft/conflict safety, sanitization, and deterministic generated assets.

See [`AGENTS.md`](https://github.com/sean35mm/weaver/blob/main/AGENTS.md) for an orientation
aimed at agents working on the repo, and [Releasing](/weaver/releasing/) for how releases are cut.

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
npm install            # dev deps + picomatch; SQLite is built into Node/Bun
node src/cli.ts --help # run directly — no build needed
```

## The bar

- Tests must pass on **both Node and Bun**: `npm test` and `npm run test:bun`.
- `npm run typecheck` must be clean.
- Use **Conventional Commits** (`feat:`, `fix:`, `chore:`, …) — they drive versioning and the
  changelog.
- Keep the core **zero-runtime-dependency** where practical (`picomatch` is the only one).
- Validation stays lenient at the CLI boundary — never throw a stack trace at an agent, and
  `check` must never crash a tool call.
- The CLI is the **universal engine** — don't add a hard dependency on any single harness.

See [`AGENTS.md`](https://github.com/sean35mm/weaver/blob/main/AGENTS.md) for an orientation
aimed at agents working on the repo, and [Releasing](/weaver/releasing/) for how releases are cut.

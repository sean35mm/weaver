<!-- Title must be a Conventional Commit (feat:, fix:, docs:, chore:, build:, ci:) —
     it drives the changelog and the version bump via release-please. -->

## What & why

<!-- What changes, and what problem it solves. Link the issue if one exists. -->

## Checklist

- [ ] `npm test` and `npm run test:bun` pass (the suite must work on both runtimes)
- [ ] `npm run typecheck` and `npm run lint` pass
- [ ] No new runtime dependencies (picomatch stays the only one) — or the tradeoff is explained
- [ ] Docs updated if behavior or commands changed (`docs/src/content/docs/`)
- [ ] Breaking changes are called out explicitly in the description

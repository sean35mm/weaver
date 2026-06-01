# Releasing Weaver

How to cut and publish a release. **Read this fully before releasing — the normal path is
"merge a PR," not running release commands by hand.**

Weaver uses **[release-please](https://github.com/googleapis/release-please) +
[Conventional Commits](https://www.conventionalcommits.org/)**. You do not hand-pick version
numbers or write the changelog — they're derived from commit messages.

## Mental model

```
conventional commits on main  →  release-please opens a "release vX.Y.Z" PR
        →  you merge that PR  →  tag + GitHub Release created
              →  binaries built & attached (always)  +  npm publish (only if NPM_TOKEN set)
```

## Version bumps come from commit types

| Commit prefix | Release effect |
| --- | --- |
| `fix: …` | patch (0.1.0 → 0.1.1) |
| `feat: …` | minor (0.1.0 → 0.2.0) |
| `feat!: …` or a `BREAKING CHANGE:` footer | major (while pre-1.0, treated as minor) |
| `chore:` `docs:` `refactor:` `test:` `ci:` | no release (still recorded) |

So: to ship anything, land at least one `fix:` or `feat:` commit on `main`.

## The normal release flow

1. Merge your work to `main` with conventional commit messages. CI (tests on Node + Bun) runs
   on every push/PR — keep it green.
2. **release-please** automatically opens or updates a PR titled **"chore: release vX.Y.Z"**
   with the computed version bump and `CHANGELOG.md` entries. Leave it open until you're ready.
3. When ready to release, **merge that PR.** Merging triggers, automatically:
   - version bump in `package.json` + `CHANGELOG.md` update,
   - git tag `vX.Y.Z` + a published **GitHub Release**,
   - `.github/workflows/release-binaries.yml` cross-compiles standalone binaries
     (`weaver-darwin-arm64`, `weaver-darwin-x64`, `weaver-linux-x64`, `weaver-linux-arm64`),
     each **stamped with this release's version**, and attaches them to the release. These
     binaries (served via `curl | sh` and `weaver upgrade`) are Weaver's primary distribution,
   - `npm publish` of `@narulabs/weaver` **only if** the `NPM_TOKEN` secret is set (otherwise
     it logs "skipping" and the release still succeeds).
4. Nothing else to do. `curl … install.sh` serves the new version (it reads
   `releases/latest`), and `npm i -g @narulabs/weaver` works if npm publishing is enabled.

## Enabling npm publishing (one-time, optional)

npm publishing is intentionally optional. To turn it on:

1. Create an **Automation** token at npmjs.com → Access Tokens (must have publish rights to
   the `@narulabs` scope).
2. Add it as a repo secret:
   ```bash
   gh secret set NPM_TOKEN   # paste the token when prompted
   ```

That's it — the next merged release PR will also publish to npm. No workflow changes needed.

## Manual release (fallback — avoid if possible)

Only if you must release without the PR flow (this is how `v0.1.0` was bootstrapped):

```bash
gh release create vX.Y.Z --generate-notes
```

This still triggers the binary builds. **Do not mix manual releases with release-please PRs
casually** — if a release-please PR for the same version is open, close it first to avoid
conflicting tags.

## Verifying a release

```bash
gh release view vX.Y.Z          # confirm the 4 binaries are attached
gh run list --limit 5           # confirm CI + release-binaries succeeded
curl -fsSL https://github.com/sean35mm/weaver/releases/latest/download/weaver-darwin-arm64 \
  -o /tmp/weaver && chmod +x /tmp/weaver && /tmp/weaver --version
```

## Pre-flight checklist (before merging a release PR)

- [ ] `npm run typecheck` is clean
- [ ] `npm test` **and** `npm run test:bun` pass
- [ ] `npm run build` succeeds
- [ ] The release PR's CHANGELOG looks right for what's shipping
- [ ] Breaking changes are marked with `!` / `BREAKING CHANGE:` so the version reflects them

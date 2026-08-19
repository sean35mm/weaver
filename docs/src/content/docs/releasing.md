---
title: Releasing
description: How Weaver releases are cut and distributed.
---

Releases are automated with **release-please + Conventional Commits**. The full playbook is in
the repo: [`RELEASING.md`](https://github.com/sean35mm/weaver/blob/main/RELEASING.md).

## In short

1. Land `feat:` / `fix:` commits on `main`. (`fix:` → patch, `feat:` → minor.)
2. release-please opens a **"chore: release vX.Y.Z"** PR with the version bump + changelog.
3. **Merge that PR.** That tags the release, builds the standalone binaries for every platform
   (each stamped with the version) and attaches them.
4. `install.sh` and `weaver upgrade` serve the new binaries automatically.

You don't hand-pick versions or write the changelog — they come from the commit messages.

For the exceptional manual fallback, create the release and then explicitly dispatch
`release-binaries.yml` with its tag (`gh workflow run release-binaries.yml -f tag=vX.Y.Z`). A
release created by a token does not automatically start that binary workflow.

## Distribution

Weaver is distributed as a **standalone binary** via `curl | sh` and `weaver upgrade`. See
[Install](/weaver/getting-started/install/) and [Architecture](/weaver/reference/architecture/).

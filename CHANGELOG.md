# Changelog

All notable changes to this project are documented here. This project adheres to
[Semantic Versioning](https://semver.org/) and the format is based on
[Keep a Changelog](https://keepachangelog.com/). During `0.x`, minor versions may include
breaking changes.

## [0.2.0](https://github.com/sean35mm/weaver/compare/v0.1.0...v0.2.0) (2026-06-01)


### Features

* add 'weaver upgrade' (self-updating binary) and make curl the primary install ([8b6d37d](https://github.com/sean35mm/weaver/commit/8b6d37d8cf6935bad27d310448b7778a990fc21c))

## [Unreleased]

### Added
- Project foundations: MIT license, SemVer, conventional commits, CI (Node + Bun), and
  `release-please` automated releases.
- Storage core: runtime-aware SQLite binding (`bun:sqlite` / `node:sqlite`), schema +
  migrations, the `Store` interface and its SQLite implementation, lazy staleness/retention.
- Repo identity resolver and repo-root-relative path normalization.
- Session identity resolver (`explicit` → harness env id → controlling TTY).
- Core agent verbs: `status`, `task`, `claim`/`release`, `check`, `note`/`notes`, `log`,
  `activity`, `done`, `doctor`, with a help screen.
- Glob matching (`picomatch`) and three-tier conflict detection (hard / soft / stale).
- Presence registration limited to agent/mutating commands (observers never appear as a
  participant); advisory co-claims that surface overlaps and exit non-zero.
- Lenient CLI-boundary validation (`parseTtl`, `normalizeKind`, `clamp`, `requireArg`).
- Lifecycle commands: `init` (inject the instruction block into `CLAUDE.md` + `AGENTS.md`),
  `disable`/`enable` (pause/resume agent writes for a repo), `deinit` (remove the block;
  `--purge` also deletes the store).
- Real-time visualization: `dashboard` (loopback-only HTTP + SSE web viewer, read-only) and
  `watch` (live terminal view). Both poll the store ~1s and stop on Ctrl-C.
- Tunable TTLs via `weaver_meta` and a `config` command (session / claim / recent-activity).
- `scripts/demo.ts` seeded multi-agent demo, `CONTRIBUTING.md`, and npm publish prep
  (`publishConfig`, build-on-publish, keywords).
- `weaver upgrade [--check]` — self-update the standalone binary from the latest release.
- Distribution is the standalone binary via `curl | sh` (+ `weaver upgrade`); npm publishing
  is optional and off by default. Released binaries are version-stamped at build time.

# Changelog

All notable changes to this project are documented here. This project adheres to
[Semantic Versioning](https://semver.org/) and the format is based on
[Keep a Changelog](https://keepachangelog.com/). During `0.x`, minor versions may include
breaking changes.

## [Unreleased]

### Added
- Project foundations: MIT license, SemVer, conventional commits, CI (Node + Bun), and
  `release-please` automated releases.
- Storage core: runtime-aware SQLite binding (`bun:sqlite` / `node:sqlite`), schema +
  migrations, the `Store` interface and its SQLite implementation, lazy staleness/retention.
- Repo identity resolver and repo-root-relative path normalization.
- Session identity resolver (`explicit` → harness env id → controlling TTY).

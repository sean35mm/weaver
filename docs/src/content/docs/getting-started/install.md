---
title: Install
description: Install the Weaver CLI — a single standalone binary, no Node or npm required.
sidebar:
  order: 1
---

Weaver ships as a **single self-contained binary**. No Node, npm, or other runtime is needed
to run it.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/sean35mm/weaver/main/install.sh | sh
```

This downloads the right binary for your OS/arch (macOS and Linux, arm64 and x64) into
`~/.local/bin/weaver`. If that directory isn't on your `PATH`, the installer tells you the
line to add.

## Supported platforms

- **macOS** — arm64 (Apple Silicon) and x64
- **Linux** — arm64 and x64 (glibc)
- **Windows** — via **WSL2**: install inside your WSL distro and the linux binary works as-is.
  Native Windows isn't supported today; it may come later if there's demand.

Verify it:

```sh
weaver --version
weaver --help
```

## Upgrade

Weaver updates itself — no reinstall:

```sh
weaver upgrade          # download + replace with the latest release
weaver upgrade --check  # just check whether a newer version exists
```

The binary is checksum-verified and replaced atomically. Stores migrate automatically to the
current schema v6 the next time they are opened. The v4 → v5 step preserves existing notes (now
presented as Repository Facts) unchanged while adding scratchpad tables and attribution columns;
the v5 → v6 step adds scoped dashboard leases.

Managed instructions and harness integrations are installed files, so refresh them after an
upgrade:

```sh
# rerun the scope you used before
weaver init --project          # or: weaver init --global

# if you installed Claude/OpenCode integrations, include --hooks
weaver init --project --hooks # or: weaver init --global --hooks
```

Then fully restart OpenCode so it loads the refreshed plugin and tool definitions. cmux is
optional; Weaver also supports a normal browser, a headless launch URL, terminal commands, and
`$VISUAL`/`$EDITOR`.

## Uninstall

```sh
weaver uninstall              # remove the binary and clean effective WEAVER_HOME (prompts)
weaver uninstall --keep-data  # remove only the binary
weaver uninstall --yes        # skip the confirmation prompt
```

Without `--keep-data`, uninstall cleans the effective `WEAVER_HOME` (`$WEAVER_HOME` when set,
otherwise `~/.weaver`). The default `~/.weaver` directory may be removed recursively after Weaver
fences active access and validates its targets. An explicit `WEAVER_HOME` is never removed
recursively: Weaver selectively deletes only validated Weaver `.db`, `.db-wal`, `.db-shm`, and
`.db-journal` files, leaving unrelated files and the directory intact. `--keep-data` removes only
the binary.

Uninstall refuses rather than deleting if the standalone binary or home is missing when required,
unsafe, or changes during inspection; if a discovered database is not a recognized Weaver store;
or if Weaver cannot safely fence, quiesce, and drain active access. Run `weaver deinit` and/or
`weaver deinit --global` first to remove managed instruction blocks and integrations. Any blocks
left behind are self-disabling once the command is absent.

## Running from source (contributors)

If you're hacking on Weaver itself, you can run it without installing — see
[Contributing](/weaver/contributing/):

```sh
node src/cli.ts --help   # or: bun src/cli.ts --help
```

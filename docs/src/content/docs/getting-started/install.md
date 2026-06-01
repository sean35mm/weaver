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

## Uninstall

```sh
rm "$(command -v weaver)"
```

## Running from source (contributors)

If you're hacking on Weaver itself, you can run it without installing — see
[Contributing](/weaver/contributing/):

```sh
node src/cli.ts --help   # or: bun src/cli.ts --help
```

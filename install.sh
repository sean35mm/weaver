#!/bin/sh
# Weaver installer — downloads the standalone binary for your OS/arch from the latest
# GitHub release. No Node or npm required.
#
#   curl -fsSL https://raw.githubusercontent.com/sean35mm/weaver/main/install.sh | sh
#
# Override the install directory with WEAVER_BIN_DIR (default: ~/.local/bin).
set -eu

REPO="sean35mm/weaver"
BIN_DIR="${WEAVER_BIN_DIR:-$HOME/.local/bin}"

os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
  Darwin) os="darwin" ;;
  Linux) os="linux" ;;
  *) echo "weaver: unsupported OS '$os' (use npm or build from source)" >&2; exit 1 ;;
esac

case "$arch" in
  x86_64 | amd64) arch="x64" ;;
  arm64 | aarch64) arch="arm64" ;;
  *) echo "weaver: unsupported arch '$arch'" >&2; exit 1 ;;
esac

asset="weaver-${os}-${arch}"
url="https://github.com/${REPO}/releases/latest/download/${asset}"

echo "weaver: downloading ${asset}…"
mkdir -p "$BIN_DIR"
if ! curl -fsSL "$url" -o "$BIN_DIR/weaver"; then
  echo "weaver: download failed — is there a published release with binaries yet?" >&2
  echo "  $url" >&2
  exit 1
fi
chmod +x "$BIN_DIR/weaver"

echo "weaver: installed to $BIN_DIR/weaver"
case ":$PATH:" in
  *":$BIN_DIR:"*) echo "weaver: run 'weaver --help' to get started" ;;
  *) echo "weaver: add it to your PATH:  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

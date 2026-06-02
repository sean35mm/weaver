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
checksum_url="${url}.sha256"

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    echo "weaver: need sha256sum or shasum to verify the download" >&2
    exit 1
  fi
}

echo "weaver: downloading ${asset}…"
mkdir -p "$BIN_DIR"
tmp_bin="$(mktemp "$BIN_DIR/.weaver.XXXXXX")"
tmp_sum="$(mktemp "$BIN_DIR/.weaver.XXXXXX.sha256")"
trap 'rm -f "$tmp_bin" "$tmp_sum"' EXIT INT TERM

if ! curl -fsSL "$url" -o "$tmp_bin"; then
  echo "weaver: download failed — is there a published release with binaries yet?" >&2
  echo "  $url" >&2
  exit 1
fi
if ! curl -fsSL "$checksum_url" -o "$tmp_sum"; then
  echo "weaver: checksum download failed" >&2
  echo "  $checksum_url" >&2
  exit 1
fi

expected="$(awk '{print tolower($1)}' "$tmp_sum")"
actual="$(sha256_file "$tmp_bin")"
if [ "${#expected}" -ne 64 ] || printf '%s' "$expected" | grep '[^0-9a-f]' >/dev/null 2>&1; then
  echo "weaver: invalid checksum file" >&2
  exit 1
fi
if [ "$actual" != "$expected" ]; then
  echo "weaver: checksum mismatch" >&2
  exit 1
fi

chmod +x "$tmp_bin"
mv "$tmp_bin" "$BIN_DIR/weaver"

echo "weaver: installed to $BIN_DIR/weaver"
case ":$PATH:" in
  *":$BIN_DIR:"*) echo "weaver: run 'weaver --help' to get started" ;;
  *) echo "weaver: add it to your PATH:  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

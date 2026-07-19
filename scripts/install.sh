#!/bin/sh
# Installs a released levare binary (NOTES DIST6 — "step 3" of distribution, promised in DIST2).
# POSIX sh, no bashisms: this runs via `curl ... | sh`, so it must work under whatever /bin/sh a
# user's machine has, not just bash.
#
# Overrides:
#   LEVARE_VERSION=vX.Y.Z   pin to a specific release instead of the latest one
#   LEVARE_BIN_DIR=/some/dir  install elsewhere instead of ~/.local/bin
#   LEVARE_RELEASE_BASE_URL  internal test seam only (points at a fixture instead of GitHub) — not
#                            a supported end-user override, and deliberately undocumented in the README.
set -eu

release_base_url="${LEVARE_RELEASE_BASE_URL:-https://github.com/go4cas/levare/releases}"
bin_dir="${LEVARE_BIN_DIR:-$HOME/.local/bin}"
version="${LEVARE_VERSION:-}"
dest="$bin_dir/levare"

os_raw=$(uname -s)
arch_raw=$(uname -m)

case "$os_raw" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) os="" ;;
esac

case "$arch_raw" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) arch="" ;;
esac

if [ -z "$os" ] || [ -z "$arch" ]; then
  echo "levare-install: unsupported platform: $os_raw $arch_raw (levare ships darwin-arm64, darwin-x64, linux-x64, linux-arm64 only)" >&2
  exit 1
fi

asset="levare-$os-$arch"

if [ -n "$version" ]; then
  asset_url_prefix="$release_base_url/download/$version"
else
  asset_url_prefix="$release_base_url/latest/download"
fi

download() {
  url=$1
  out=$2
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$out"
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$url" -O "$out"
  else
    echo "levare-install: need curl or wget to download levare" >&2
    exit 1
  fi
}

verify_checksum() {
  line=$1
  dir=$2
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s\n' "$line" | (cd "$dir" && sha256sum -c -) >/dev/null 2>&1
    return $?
  fi
  if command -v shasum >/dev/null 2>&1; then
    printf '%s\n' "$line" | (cd "$dir" && shasum -a 256 -c -) >/dev/null 2>&1
    return $?
  fi
  echo "levare-install: need sha256sum or shasum to verify the download" >&2
  exit 1
}

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/levare-install.XXXXXX")
trap 'rm -rf "$tmp_dir"' EXIT INT TERM

if ! download "$asset_url_prefix/$asset" "$tmp_dir/$asset"; then
  echo "levare-install: failed to download $asset from $asset_url_prefix" >&2
  exit 1
fi

if ! download "$asset_url_prefix/SHA256SUMS" "$tmp_dir/SHA256SUMS"; then
  echo "levare-install: failed to download SHA256SUMS from $asset_url_prefix" >&2
  exit 1
fi

if ! checksum_line=$(awk -v want="$asset" '$2 == want { print; f=1 } END { exit(f ? 0 : 1) }' "$tmp_dir/SHA256SUMS"); then
  echo "levare-install: SHA256SUMS does not list $asset" >&2
  exit 1
fi

if ! verify_checksum "$checksum_line" "$tmp_dir"; then
  echo "levare-install: checksum verification failed for $asset — refusing to install" >&2
  exit 1
fi

mkdir -p "$bin_dir"
chmod +x "$tmp_dir/$asset"
mv "$tmp_dir/$asset" "$dest"

printf 'levare-install: installed %s\n' "$dest"
if ! "$dest" --version; then
  echo "levare-install: installed binary at $dest failed to run --version" >&2
  exit 1
fi

case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) echo "levare-install: warning: $bin_dir is not on PATH — add it to your shell profile to run 'levare'" >&2 ;;
esac

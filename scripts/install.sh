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
#
# NOTES DIST8: release assets ship gzip-compressed (`<asset>.gz`) to cut a ~300MB binary down to
# roughly a fifth of that. gzip, not xz/zstd, because this script must run under whatever `sh` a
# user has with no package manager assumed — gzip/gunzip ships in base macOS and every mainstream
# Linux distro; xz and zstd do not. `LEVARE_VERSION` can pin to a release older than DIST8, which
# has no `.gz` asset at all — `curl | sh` always fetches this script fresh from `main`, so it is a
# *current* script that must know how to fall back to a *pinned old* release's raw (uncompressed)
# asset, not the other way around.
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

# Decompresses a gzip-compressed download ($1) to $2, inside scratch dir $3. Kept separate from
# checksum verification so a corrupt/truncated download (e.g. "gzip: unexpected end of file") is
# diagnosed as a decompression failure, not misreported as a checksum failure — the two indicate
# different problems (a broken transfer vs. an asset that doesn't match what SHA256SUMS expects).
decompress_gzip() {
  gz_src=$1
  gz_dest=$2
  gz_scratch_dir=$3
  if ! command -v gzip >/dev/null 2>&1; then
    echo "levare-install: downloaded a compressed asset but 'gzip' is not on PATH to decompress it — gzip ships with macOS and virtually every Linux distribution; install it and re-run" >&2
    exit 1
  fi
  if ! gzip -dc "$gz_src" >"$gz_dest" 2>"$gz_scratch_dir/gzip-stderr"; then
    echo "levare-install: failed to decompress the downloaded asset — the download is likely corrupt or truncated" >&2
    if [ -s "$gz_scratch_dir/gzip-stderr" ]; then
      cat "$gz_scratch_dir/gzip-stderr" >&2
    fi
    echo "levare-install: re-run the installer to retry the download" >&2
    exit 1
  fi
}

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/levare-install.XXXXXX")
trap 'rm -rf "$tmp_dir"' EXIT INT TERM

# Try this release's compressed asset first; fall back to the raw (uncompressed) asset name for a
# release pinned via LEVARE_VERSION that predates DIST8 and never published a `.gz` at all. A 404 (or
# any other download failure) on the compressed name is expected and silent here — only failure of
# BOTH attempts is fatal.
compressed=0
if download "$asset_url_prefix/$asset.gz" "$tmp_dir/$asset.gz"; then
  compressed=1
elif ! download "$asset_url_prefix/$asset" "$tmp_dir/$asset"; then
  echo "levare-install: failed to download $asset — tried $asset.gz and $asset at $asset_url_prefix" >&2
  exit 1
fi

if ! download "$asset_url_prefix/SHA256SUMS" "$tmp_dir/SHA256SUMS"; then
  echo "levare-install: failed to download SHA256SUMS from $asset_url_prefix" >&2
  exit 1
fi

if [ "$compressed" -eq 1 ]; then
  decompress_gzip "$tmp_dir/$asset.gz" "$tmp_dir/$asset" "$tmp_dir"
fi

# SHA256SUMS always lists the DEcompressed binary's hash under its raw (uncompressed) asset name —
# checksummed here, after decompression, so this verifies exactly the bytes about to be chmod'd and
# executed below, not merely that the download arrived intact (NOTES DIST8).
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

# NOTES DOCS-WALKTHROUGH-2: a cold-start walkthrough found nothing after this script names the next
# command — `levare init` was found only by reading --help. `levare init`'s own closing line already
# names what comes after IT (validate, serve); this closes the same gap one command earlier.
printf 'levare-install: next, run '"'"'levare init'"'"' to scaffold a studio\n'

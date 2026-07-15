#!/usr/bin/env bash
# Builds the single self-contained `levare` binary via `bun build --compile` (NOTES DIST1). Stamps
# __LEVARE_BUILD_COMMIT__ with the current git commit so a compiled binary can honestly answer
# `levare --version` (see src/version.ts). `bun build` is a dev-time tool only — this introduces no
# runtime dependency, so `deps:check` is unaffected.
#
# Usage: scripts/build.sh [outfile] [bun-compile-target]
#   scripts/build.sh                                              → dist/levare, host platform (dev build)
#   scripts/build.sh dist/levare-darwin-arm64 bun-darwin-arm64     → cross-compiled release binary
# The release workflow (.github/workflows/release.yml, NOTES DIST2) calls this same script once per
# platform in its matrix — the build path is not reinvented there, only parameterized.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
commit="$(git -C "$repo_root" rev-parse --short HEAD 2>/dev/null || echo unknown)"

outfile="${1:-dist/levare}"
[[ "$outfile" = /* ]] || outfile="$repo_root/$outfile"
target="${2:-}"

mkdir -p "$(dirname "$outfile")"

target_args=()
[[ -n "$target" ]] && target_args=(--target="$target")

# Compile with cwd pointed at a scratch directory, not the repo root. Entry and output paths below
# are absolute, so on a normal filesystem this has no effect either way — it exists to route around
# a container-specific bug (seen in this repo's own devcontainer under Docker Desktop's virtiofs
# bind mount): `bun build --compile`'s atomic rename of its build tempfile resolves against a
# host-side path that doesn't exist from inside the container whenever cwd sits on that mount,
# failing with "failed to rename ... ENOENT" even though every other bun/git command there works
# fine. Building from a scratch dir elsewhere sidesteps it everywhere.
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
(cd "$scratch" && bun build "$repo_root/src/cli.ts" --compile ${target_args[@]+"${target_args[@]}"} --outfile "$outfile" --define __LEVARE_BUILD_COMMIT__="\"$commit\"")

echo "built $outfile @ $commit${target:+ (target $target)}"

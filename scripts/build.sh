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

# ---------------------------------------------------------------------------
# Embed this build's platform-specific Claude Agent SDK native binary (NOTES DIST7)
# ---------------------------------------------------------------------------
#
# `require.resolve`-based lookup (sdk-transport.ts's source-tree path) cannot work inside a compiled
# binary — it needs a real node_modules tree, and `bun build --compile`'s output has none. The SDK's
# own documented fix (its README's "Compiled binaries (`bun build --compile`)" section) is to embed
# the platform's native binary as a Bun file asset via a source-level `with { type: "file" }` import —
# that import specifier must be a literal at bundle time, so which platform gets embedded is a
# build-time choice, made here, once per invocation, not a runtime one.
#
# native-binary.generated.ts is the one static import site: this script rewrites it to import this
# build's target platform's binary, then restores it to its checked-in stub (`export default null`)
# via `git checkout --` in the EXIT trap below — success or failure, the working tree is never left
# modified. Skipped entirely (stub stays as `null`) for a target this repo doesn't ship as a release
# asset (only darwin-arm64/darwin-x64/linux-x64/linux-arm64 are supported, NOTES DIST2) — the resulting
# binary still builds and runs, it just honestly reports no embedded SDK binary (sdk-transport.ts's
# `resolveEmbeddedNativeBinary`).
native_binary_stub="$repo_root/src/native-binary.generated.ts"
scratch=""

cleanup() {
  local rc=$?
  git -C "$repo_root" checkout -- "$native_binary_stub" 2>/dev/null || true
  [[ -n "$scratch" ]] && rm -rf "$scratch"
  exit "$rc"
}
trap cleanup EXIT

if [[ -n "$target" ]]; then
  platform_arch="${target#bun-}"
else
  platform_arch="$(bun -e "console.log(process.platform + '-' + process.arch)")"
fi

sdk_platform_pkg=""
case "$platform_arch" in
  darwin-arm64|darwin-x64|linux-x64|linux-arm64)
    sdk_platform_pkg="@anthropic-ai/claude-agent-sdk-$platform_arch"
    ;;
  *)
    echo "build.sh: target '$platform_arch' is not a supported release platform — building with no embedded SDK native binary" >&2
    ;;
esac

if [[ -n "$sdk_platform_pkg" ]]; then
  os_name="${platform_arch%-*}"
  cpu_name="${platform_arch#*-}"
  # Fetches this target's optional platform package into node_modules without touching package.json
  # or bun.lock (both already declare it, as one of the SDK's own optionalDependencies) — `--os`/
  # `--cpu` override which platform variant bun install pulls in, independent of the host running this
  # script. A no-op (fast) when the package the host would install anyway already matches.
  (cd "$repo_root" && bun install --os="$os_name" --cpu="$cpu_name" --frozen-lockfile)

  cat > "$native_binary_stub" <<EOF
// AUTO-GENERATED for this build only by scripts/build.sh — target $platform_arch. Restored to the
// checked-in stub via 'git checkout --' when the build script exits (NOTES DIST7). Do not hand-edit;
// do not commit this content.
import bin from "$sdk_platform_pkg/claude" with { type: "file" };
export default bin;
EOF
fi

# Compile with cwd pointed at a scratch directory, not the repo root. Entry and output paths below
# are absolute, so on a normal filesystem this has no effect either way — it exists to route around
# a container-specific bug (seen in this repo's own devcontainer under Docker Desktop's virtiofs
# bind mount): `bun build --compile`'s atomic rename of its build tempfile resolves against a
# host-side path that doesn't exist from inside the container whenever cwd sits on that mount,
# failing with "failed to rename ... ENOENT" even though every other bun/git command there works
# fine. Building from a scratch dir elsewhere sidesteps it everywhere.
scratch="$(mktemp -d)"
(cd "$scratch" && bun build "$repo_root/src/cli.ts" --compile ${target_args[@]+"${target_args[@]}"} --outfile "$outfile" --define __LEVARE_BUILD_COMMIT__="\"$commit\"")

echo "built $outfile @ $commit${target:+ (target $target)}"

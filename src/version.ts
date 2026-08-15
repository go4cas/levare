// levare's own version (NOTES DIST1). Two entirely different runtimes read this:
//
//  - Running from source (the `./levare` shim, or `bun run src/cli.ts` directly) — there is no
//    build step and therefore no commit to report. Say so plainly ("source/dev"); never fabricate
//    a hash.
//  - Running as a `bun build --compile` binary (`bun run build`, see package.json + scripts/build.sh)
//    — the build script stamps the git commit it was built from via `--define`, replacing the
//    `__LEVARE_BUILD_COMMIT__` identifier below with a string literal at bundle time.
//
// `typeof __LEVARE_BUILD_COMMIT__ !== "undefined"` is the standard esbuild/bun `--define` fallback
// idiom: `typeof` never throws on an identifier that was never declared (unlike referencing it
// directly), so this line behaves correctly whether or not `--define` ran.
declare const __LEVARE_BUILD_COMMIT__: string;

// The package version is read via a static JSON import, not `readFileSync` against a resolved repo
// path — a resolved-path read (as `board/render.ts` used to do via `LEVARE_ROOT`) breaks under
// `--compile`, because `import.meta.url` inside a standalone binary points into Bun's virtual
// `$bunfs`, not the real filesystem. A static import is inlined by the bundler at build time, so it
// carries the right value in both source and compiled runs.
import pkg from "../package.json" with { type: "json" };

export interface VersionInfo {
  version: string;
  /** The commit `bun run build` stamped in, or `null` when running from source (no build step). */
  build: { commit: string } | null;
}

export function getVersionInfo(): VersionInfo {
  const stamped = typeof __LEVARE_BUILD_COMMIT__ !== "undefined" ? __LEVARE_BUILD_COMMIT__ : undefined;
  return { version: pkg.version, build: stamped ? { commit: stamped } : null };
}

// NOTES "tree build version" (Conductor ruling): `package.json`'s version on `main` is permanently
// this placeholder — release.yml stamps the REAL version (from the pushed tag) into an EPHEMERAL
// checkout right before building, and never commits it back (NOTES DIST2's own comment there says so
// explicitly: "nothing is committed back"). So a tree build — `bun run build` off `main`, not a
// release — always carries a real, correctly `--define`-stamped commit alongside this fake, never-
// bumped number, and reported it as if "0.0.1" were a real, chosen version. Only a genuinely tagged
// release ever overwrites this value before building, so seeing it at runtime IS the signal that this
// binary was never that: no second flag or build-time marker needed. `git describe` was considered
// and rejected — it would produce an equally version-SHAPED string (`0.0.1-14-gabc1234`) for something
// that still isn't a release, inviting the identical confusion in subtler, harder-to-notice form.
const UNSTAMPED_PLACEHOLDER_VERSION = "0.0.1";

/** True when `info.version` is the value every tree build carries — never overwritten outside
 * release.yml's own ephemeral, uncommitted stamp. A source run (no build stamp at all) also carries
 * this same placeholder, but is already unambiguous on its own ("(source/dev)", no version-shaped
 * build identifier attached) — this only changes what a COMPILED, un-released build reports. */
function isUnstampedTreeBuild(info: VersionInfo): boolean {
  return info.build !== null && info.version === UNSTAMPED_PLACEHOLDER_VERSION;
}

export function formatVersion(info: VersionInfo): string {
  if (!info.build) return `levare ${info.version} (source/dev)`;
  const version = isUnstampedTreeBuild(info) ? "dev" : info.version;
  return `levare ${version} (build ${info.build.commit})`;
}

/** The board header's compact version chip — "v1.2.3" for a real release, "dev (build <hash>)" for a
 * tree build, same decision `formatVersion` makes for `--version`'s own fuller sentence, one place so
 * the two surfaces can never independently drift on what counts as "a real release" (NOTES "tree build
 * version"). A source run (no build stamp) keeps the bare "vX.Y.Z" shape unchanged — out of this
 * ruling's scope, which named only `bun run build`'s own output. */
export function versionChip(info: VersionInfo): string {
  return isUnstampedTreeBuild(info) ? `dev (build ${info.build!.commit})` : `v${info.version}`;
}

/** `true` when this process is a compiled `--define`-stamped binary; `false` for a source run. */
export function isCompiledBuild(info: VersionInfo = getVersionInfo()): boolean {
  return info.build !== null;
}

// The release workflow (.github/workflows/release.yml, NOTES DIST2) derives the published package
// version from the pushed git tag (`v0.1.0` -> `0.1.0`) before stamping it into package.json. A
// leading "v" is only a semver prefix when the whole tag is semver-shaped (`v` + dotted
// major.minor.patch, optionally with a `-prerelease` and/or `+build` suffix) — stripping it
// whenever the tag merely starts with the letter "v" mangles ordinary tag names (`vendor-cli-gh` ->
// `endor-cli-gh`, a real incident: that tag matched the release trigger and shipped a binary whose
// `--version` read "levare endor-cli-gh"). Note `v11-conv` isn't dotted major.minor.patch either, so
// it's a word too, not a truncated semver tag. Kept here, not inlined in YAML, so it's unit-testable.
const SEMVER_TAG = /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export function versionFromTag(tag: string): string {
  return SEMVER_TAG.test(tag) ? tag.slice(1) : tag;
}

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

export function formatVersion(info: VersionInfo): string {
  return info.build ? `levare ${info.version} (build ${info.build.commit})` : `levare ${info.version} (source/dev)`;
}

/** `true` when this process is a compiled `--define`-stamped binary; `false` for a source run. */
export function isCompiledBuild(info: VersionInfo = getVersionInfo()): boolean {
  return info.build !== null;
}

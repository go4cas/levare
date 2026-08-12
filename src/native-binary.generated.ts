// AUTO-GENERATED, transiently, by scripts/build.sh — do not hand-edit and do not rely on this
// checked-in content persisting after a build (NOTES DIST6). This is the seam `bun build --compile`
// needs to embed the SDK's platform-specific native `claude` binary as a Bun file asset: a `with {
// type: "file" }` import specifier must be a source-level string literal for Bun's bundler to resolve
// and embed it, so it cannot be computed at runtime — one target, one literal import.
//
// scripts/build.sh overwrites this file's content with a target-specific literal import (naming the
// exact `@anthropic-ai/claude-agent-sdk-<platform>-<arch>` optional-dependency package matching the
// build's target) immediately before invoking `bun build --compile`, then restores this exact stub
// via `git checkout --` afterward (success or failure) so the working tree is never left dirty.
//
// This stub (`null`) is what every OTHER run sees: `bun test`, `bunx tsc --noEmit`, and a `bun build
// --compile` invoked directly without going through scripts/build.sh (unsupported — see NOTES DIST1).
// `sdk-transport.ts#resolveEmbeddedNativeBinary` treats `null` as "no binary was embedded in this
// build" and reports that honestly rather than crashing.
export default null as string | null;

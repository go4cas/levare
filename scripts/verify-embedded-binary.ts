#!/usr/bin/env bun
// Guard: does a compiled levare binary actually carry ITS OWN target platform's Claude Agent SDK
// native binary, byte-for-byte, embedded inside it (NOTES DIST7)? scripts/build.sh's own generated
// `native-binary.generated.ts` import specifier proves the SOURCE said the right package name; this
// proves the BUILD OUTPUT actually contains that package's exact bytes — the only claim that matters,
// since a bundler misresolution or a stale/wrong node_modules package could make the specifier honest
// and the embed wrong. Works without executing the compiled binary (`Buffer.includes` on its raw
// bytes), so it verifies a genuinely foreign-platform cross-compiled asset exactly as well as the
// host's own — see NOTES DIST7 for why that matters here.
//
// Usage: bun scripts/verify-embedded-binary.ts <compiled-binary-path> <platform-arch>
//   bun scripts/verify-embedded-binary.ts dist/levare-darwin-arm64 darwin-arm64

import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const SCRIPT_DIR = dirname(Bun.fileURLToPath(import.meta.url));

const [binaryPath, platformArch] = process.argv.slice(2);

if (!binaryPath || !platformArch) {
  console.error("usage: bun scripts/verify-embedded-binary.ts <compiled-binary-path> <platform-arch>");
  process.exit(2);
}

const SUPPORTED = new Set(["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"]);
if (!SUPPORTED.has(platformArch)) {
  console.error(`verify-embedded-binary: '${platformArch}' is not a supported release platform (${[...SUPPORTED].join(", ")})`);
  process.exit(2);
}

const nativeBinaryPath = join(SCRIPT_DIR, "..", "node_modules", "@anthropic-ai", `claude-agent-sdk-${platformArch}`, "claude");

let nativeBinary: Buffer;
try {
  nativeBinary = readFileSync(nativeBinaryPath);
} catch (e) {
  console.error(
    `verify-embedded-binary: can't read the expected source binary at ${nativeBinaryPath} (${e instanceof Error ? e.message : String(e)}) — ` +
      `run 'bun install --os=${platformArch.split("-")[0]} --cpu=${platformArch.split("-")[1]}' first`,
  );
  process.exit(2);
}

let compiled: Buffer;
try {
  compiled = readFileSync(binaryPath);
} catch (e) {
  console.error(`verify-embedded-binary: can't read compiled binary at ${binaryPath} (${e instanceof Error ? e.message : String(e)})`);
  process.exit(2);
}

const compiledSize = statSync(binaryPath).size;
if (compiledSize < nativeBinary.length) {
  console.error(
    `verify-embedded-binary: FAIL — ${binaryPath} (${compiledSize} bytes) is smaller than the ${platformArch} native binary alone (${nativeBinary.length} bytes); it cannot contain it`,
  );
  process.exit(1);
}

const offset = compiled.indexOf(nativeBinary);
if (offset === -1) {
  console.error(
    `verify-embedded-binary: FAIL — ${binaryPath} does not contain the exact bytes of ${nativeBinaryPath} (${nativeBinary.length} bytes) anywhere in its ${compiled.length}-byte body. ` +
      `This build did not embed the ${platformArch} native binary, or embedded a different one.`,
  );
  process.exit(1);
}

console.log(`verify-embedded-binary: OK — ${binaryPath} embeds the exact ${platformArch} native binary (${nativeBinary.length} bytes, at offset ${offset})`);

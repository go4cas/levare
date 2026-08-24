// Finding 75 (part 2, 2026-08-24): pure, always-run coverage of
// `scripts/repro-r4-sandbox-native-worker.ts`'s own construction-level parity claim — the ONE part of
// that script that runs meaningfully in this container (no working sandbox primitive here at all, so
// the script's own live-spawn step always no-ops; see its header). Mirrors
// tests/repro-r4-sandbox-fix10-hang.test.ts's own precedent of unit-testing a repro script's exported,
// pure helpers directly rather than only ever running the script by hand.

import { describe, expect, test } from "bun:test";
import { nativeInheritsCliAcquittedGrants, nativeBunfsGrantIsCanonicalized, CLI_ACQUITTED_LINES } from "../scripts/repro-r4-sandbox-native-worker.ts";

describe("nativeInheritsCliAcquittedGrants — the native worker's profile carries every one of cli's six already-acquitted grants", () => {
  test("passes — every acquitted line is present, byte-identical, in both the cli-shaped and native-shaped generated profiles", () => {
    // Captures console output only to keep the test's own output quiet — the assertion is on the
    // return value, not the printed narration (that's for a human running the script by hand).
    const originalLog = console.log;
    console.log = () => {};
    try {
      expect(nativeInheritsCliAcquittedGrants()).toBe(true);
    } finally {
      console.log = originalLog;
    }
  });

  test("CLI_ACQUITTED_LINES names all six rounds this unit's own goal referenced — never silently narrowed", () => {
    expect(CLI_ACQUITTED_LINES).toEqual([
      "(allow sysctl-read)",
      '(allow mach-lookup (global-name "com.apple.bsd.dirhelper"))',
      '(allow file-read* (subpath "/"))',
      '(allow mach-lookup (global-name "com.apple.trustd.agent"))',
      '(allow mach-lookup (global-name "com.apple.SecurityServer"))',
      "(allow network*)",
    ]);
  });
});

// Finding 75 (part 3): always-run coverage of STEP A2 — proves `ensureNativeBunfsExtractionBase`'s
// pre-creation actually closes `sandbox.ts#canon`'s ENOENT fallback gap for this specific grant, against
// a scratch `CLAUDE_CODE_TMPDIR` never the real host temp dir. Construction-only, like STEP A's own
// always-run test — real darwin symlink enforcement still needs the live host STEP C exercises.
describe("nativeBunfsGrantIsCanonicalized — the pre-created bunfs extraction base is realpath-resolved before it's granted", () => {
  test("passes — the generated profile names the realpath'd form, not the pre-resolution literal", () => {
    const originalLog = console.log;
    console.log = () => {};
    try {
      expect(nativeBunfsGrantIsCanonicalized()).toBe(true);
    } finally {
      console.log = originalLog;
    }
  });
});

// NOTES R4-SANDBOX-TLS: this file's own exec-based test must be guarded by `process.platform`, not
// hardcoded to the non-darwin skip branch — a prior version of this test asserted the Linux-only
// "darwin-only, skipping" message unconditionally, which is exactly wrong on the one platform this
// script actually exists to run on: a live macOS host running THIS test suite hit the real
// `sandbox-exec`/`security` path and correctly failed the hardcoded assertion. `scripts/repro-r4-
// sandbox-securityserver.ts`'s own real question (does `security list-keychains` fail without the
// SecurityServer grant and pass with it?) can only be answered on a live macOS host — what's asserted
// on darwin below is narrower: that the script actually REACHES its real probe rather than degrading,
// mirroring `tests/repro-r4-sandbox-tls-handshake.test.ts`'s own "pin what's pure, defer what needs a
// live host" split (that file never spawns its own script at all, for the identical reason).

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

const IS_DARWIN = process.platform === "darwin";
// Generous: on darwin this spawns TWO real `sandbox-exec`-wrapped `security list-keychains` calls (up
// to 15s each, per the script's own internal timeout) plus a best-effort `log show` capture (up to 8s)
// — comfortably inside this budget even if every step runs to its own worst case.
const DARWIN_SPAWN_TIMEOUT_MS = 60000;

describe("scripts/repro-r4-sandbox-securityserver.ts", () => {
  test("imports and typechecks cleanly (pulled into the program via this import, mirroring every other scripts/*.ts sibling)", async () => {
    const mod = await import("../scripts/repro-r4-sandbox-securityserver.ts");
    expect(mod).toBeDefined();
  });

  test(
    IS_DARWIN
      ? "on a real darwin host, actually attempts the sandbox-exec A/B probe rather than degrading"
      : "degrades honestly on this non-darwin host: exits 0, names the platform, attempts no real sandbox-exec spawn",
    () => {
      const r = spawnSync("bun", ["run", "scripts/repro-r4-sandbox-securityserver.ts"], { encoding: "utf8", timeout: IS_DARWIN ? DARWIN_SPAWN_TIMEOUT_MS : 15000 });
      expect(r.status).toBe(0);
      if (!IS_DARWIN) {
        expect(r.stdout).toContain("darwin-only");
        expect(r.stdout).toContain(process.platform);
      } else {
        // Deliberately NOT asserting PASS/INCONCLUSIVE/UNEXPECTED here — that's this grant's own live
        // finding, read by a Conductor from this run's own output, not a fixed expectation a test can
        // pin without independently re-deriving whether `security list-keychains` genuinely round-trips
        // through securityd on THIS host's macOS version. What's safe to assert unconditionally: the
        // script reached the real probe at all (sandbox-exec/security both found, the darwin guard
        // never fired) and exited cleanly either way.
        expect(r.stdout).not.toContain("darwin-only");
        expect(r.stdout).toContain("sandbox-exec:");
        expect(r.stdout).toContain("=== Summary ===");
      }
    },
    IS_DARWIN ? DARWIN_SPAWN_TIMEOUT_MS + 5000 : 5000,
  );
});

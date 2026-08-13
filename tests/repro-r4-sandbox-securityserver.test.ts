// NOTES R4-SANDBOX-TLS: this container is Linux — `scripts/repro-r4-sandbox-securityserver.ts`'s own
// real question (does `security list-keychains` fail without the SecurityServer grant and pass with
// it?) can only be answered on a live macOS host, the same honest limitation every darwin-only harness
// in this saga carries. What IS testable here, with no live host required: the script degrades
// honestly on a non-darwin platform (mirrors `tests/repro-r4-sandbox-tls-handshake.test.ts`'s own
// "pin what's pure, defer what needs a live host" split) rather than throwing, hanging, or silently
// no-op-passing.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

describe("scripts/repro-r4-sandbox-securityserver.ts", () => {
  test("imports and typechecks cleanly (pulled into the program via this import, mirroring every other scripts/*.ts sibling)", async () => {
    const mod = await import("../scripts/repro-r4-sandbox-securityserver.ts");
    expect(mod).toBeDefined();
  });

  test("degrades honestly on this non-darwin host: exits 0, names the platform, attempts no real sandbox-exec spawn", () => {
    const r = spawnSync("bun", ["run", "scripts/repro-r4-sandbox-securityserver.ts"], { encoding: "utf8", timeout: 15000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("darwin-only");
    expect(r.stdout).toContain(process.platform);
  });
});

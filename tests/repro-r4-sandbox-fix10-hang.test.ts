// NOTES R4-SANDBOX-FIX-14 (round 4, live host): the parity ladder's `LEVARE_SANDBOX_DEBUG` capture used
// to select the FIRST "darwin sandbox-exec profile text:" line in the captured output — but
// `sandbox.ts#detectSandbox`'s own PROBE (`probeSandboxExec`) prints the identical debug line shapes a
// real dispatch's own wrap does, and on a live host where the probe genuinely runs, its block is emitted
// FIRST. A position-based `.find()` silently picked the probe's profile instead of the dispatch's,
// producing every false structural "REGRESSION" in this saga's earlier rounds. This test pins the fix —
// selection by IDENTITY (the dispatch's own `levare-sandbox-profile-*` scratch-dir prefix, never the
// probe's `levare-sandbox-probe-*`), never by ORDER — with a synthetic captured-line stream containing
// both a probe block and a dispatch block, in that order, exactly as a live host produces them. Pure
// string-level: runs identically in this container and on a live darwin host.

import { describe, expect, test } from "bun:test";
import { profileSkeleton, selectDispatchProfileText } from "../scripts/repro-r4-sandbox-fix10-hang.ts";

function probeBlock(): string[] {
  return [
    "[levare:sandbox-debug] darwin sandbox-exec profile written to: /tmp/levare-sandbox-probe-abc123/probe.sb",
    '[levare:sandbox-debug] darwin sandbox-exec profile text:\n(version 1)\n(allow process-fork)\n"PROBE-ONLY-MARKER"',
    "[levare:sandbox-debug] cwd: /tmp/levare-sandbox-probe-abc123",
    "[levare:sandbox-debug] level: full (primitive: sandbox-exec)",
    "[levare:sandbox-debug] composed argv:",
    '[levare:sandbox-debug]   [0] "/usr/bin/sandbox-exec"',
  ];
}

function dispatchBlock(): string[] {
  return [
    "[levare:sandbox-debug] darwin sandbox-exec profile written to: /tmp/levare-sandbox-profile-xyz789/profile.sb",
    '[levare:sandbox-debug] darwin sandbox-exec profile text:\n(version 1)\n(allow process-fork)\n"DISPATCH-MARKER"',
    "[levare:sandbox-debug] level: full (primitive: sandbox-exec)",
    "[levare:sandbox-debug] cwd: /tmp/levare-dispatchwt-def456",
    "[levare:sandbox-debug] composed argv:",
    '[levare:sandbox-debug]   [0] "/usr/bin/sandbox-exec"',
  ];
}

describe("selectDispatchProfileText — identity-based selection, never order-based", () => {
  test("selects the dispatch's own profile text, never the probe's, when the probe block comes first (the live-host shape)", () => {
    const lines = [...probeBlock(), ...dispatchBlock()];
    const selected = selectDispatchProfileText(lines);
    expect(selected).not.toBeNull();
    expect(selected).toContain("DISPATCH-MARKER");
    expect(selected).not.toContain("PROBE-ONLY-MARKER");
  });

  test("still selects the dispatch's own profile text when the dispatch block happens to come first", () => {
    const lines = [...dispatchBlock(), ...probeBlock()];
    const selected = selectDispatchProfileText(lines);
    expect(selected).not.toBeNull();
    expect(selected).toContain("DISPATCH-MARKER");
    expect(selected).not.toContain("PROBE-ONLY-MARKER");
  });

  test("returns null when only a probe block was captured (no dispatch ever reached the real spawn boundary)", () => {
    expect(selectDispatchProfileText(probeBlock())).toBeNull();
  });

  test("returns null when neither a probe nor a dispatch profile-text block was captured", () => {
    expect(selectDispatchProfileText(["[levare:sandbox-debug] level: none (primitive: none)"])).toBeNull();
  });

  test("a naive first-match .find() over the same stream would have picked the probe's block — the regression this fix closes", () => {
    const lines = [...probeBlock(), ...dispatchBlock()];
    const naive = lines.find((l) => l.startsWith("[levare:sandbox-debug] darwin sandbox-exec profile text:"));
    expect(naive).toContain("PROBE-ONLY-MARKER"); // proves the OLD bug's own selection, not the fix's
    expect(selectDispatchProfileText(lines)).toContain("DISPATCH-MARKER"); // the fix picks correctly
  });
});

describe("profileSkeleton", () => {
  test("collapses path literals to a placeholder, leaving rule structure intact", () => {
    const text = '(allow file-write* (subpath "/tmp/some/real/path"))\n(allow file-read* (regex #"^/tmp/xcrun_db-.*$"))';
    expect(profileSkeleton(text)).toBe('(allow file-write* (subpath <PATH>))\n(allow file-read* (regex #<PATH>))');
  });
});

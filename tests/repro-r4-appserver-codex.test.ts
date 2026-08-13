// NOTES R4-SANDBOX-APPSERVER: pins `classifyCodexAppServerFailure`
// (scripts/repro-r4-appserver-codex.ts) — pure string matching, no live host required — the same
// "closes the container-pass gap for good, for this class of bug" posture NOTES R4-SANDBOX-FIX-14's own
// `selectDispatchProfileText` regression test, and NOTES R4-VENDOR-CLI's own `classifyGhFailure` tests,
// already established.
//
// Two orderings matter, both pinned below:
// 1. app-server-init is checked FIRST and most specifically — the EXACT reported failure this round's
//    own evidence names ("failed to initialize in-process app-server client"). It also happens to
//    contain "operation not permitted" as a substring, so it must never fall through to the generic
//    filesystem-permission bucket, which would hide a recurrence of the ORIGINAL bug behind a shrug.
// 2. shim-not-found (Volta's own "Could not find executable" error, or a bare "command not found") is
//    checked BEFORE the generic not-found/filesystem-permission buckets — this round's own elimination
//    table showed this is a DIFFERENT failure than the app-server one, fixed separately
//    (SUBSCRIPTION_HOME_SHIM_GAP), and a recurrence must never be misread as the app-server issue this
//    script primarily investigates.

import { describe, expect, test } from "bun:test";
import { classifyCodexAppServerFailure } from "../scripts/repro-r4-appserver-codex.ts";

describe("classifyCodexAppServerFailure", () => {
  test("the exact reported failure classifies as app-server-init", () => {
    expect(classifyCodexAppServerFailure("cli member 'corvid' exited 1: Error: failed to initialize in-process app-server client: Operation not permitted (os error 1)")).toBe("app-server-init");
  });

  test("app-server-init wins over the generic filesystem-permission bucket even though it contains 'operation not permitted'", () => {
    const msg = "failed to initialize in-process app-server client: Operation not permitted (os error 1)";
    expect(classifyCodexAppServerFailure(msg)).not.toBe("filesystem-permission");
    expect(classifyCodexAppServerFailure(msg)).toBe("app-server-init");
  });

  test("a nested sandbox_init denial classifies as nested-sandbox", () => {
    expect(classifyCodexAppServerFailure("sandbox_init() failed: already sandboxed")).toBe("nested-sandbox");
    expect(classifyCodexAppServerFailure("Operation not permitted while inside a sandbox")).toBe("nested-sandbox");
  });

  test("Volta's own error classifies as shim-not-found, never app-server-init", () => {
    expect(classifyCodexAppServerFailure('Volta error: Could not find executable "codex"')).toBe("shim-not-found");
  });

  test("shim-not-found is checked before the generic not-found bucket", () => {
    expect(classifyCodexAppServerFailure("command not found: codex")).toBe("shim-not-found");
  });

  test("a plain PATH resolution failure (levare's own preflight, not a shim) classifies as not-found", () => {
    expect(classifyCodexAppServerFailure("agent 'corvid': command 'codex' not found on PATH")).toBe("not-found");
  });

  test("a generic EPERM/permission-denied string with no app-server/shim signal classifies as filesystem-permission", () => {
    expect(classifyCodexAppServerFailure("cat: /Users/cas/.ssh/id_rsa: Permission denied")).toBe("filesystem-permission");
  });

  test("anything else classifies as other", () => {
    expect(classifyCodexAppServerFailure("some unrelated error")).toBe("other");
  });
});

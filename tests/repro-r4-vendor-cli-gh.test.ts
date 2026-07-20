// NOTES R4-VENDOR-CLI: pins `classifyGhFailure` (scripts/repro-r4-vendor-cli-gh.ts) — pure string
// matching, no live host required — the same "closes the container-pass gap for good, for this class of
// bug" posture NOTES R4-SANDBOX-FIX-14's own `selectDispatchProfileText` regression test established.
// The critical case (ordering) is the network-vs-filesystem-permission ambiguity: a sandboxed network
// deny surfacing through gh's own Go HTTP client typically reads as "dial tcp ... operation not
// permitted" — an EPERM-flavored string that a naive "permission"/"eperm" check would misclassify as a
// bare filesystem issue if checked before the network-specific patterns.

import { describe, expect, test } from "bun:test";
import { classifyGhFailure } from "../scripts/repro-r4-vendor-cli-gh.ts";

describe("classifyGhFailure", () => {
  test("a Go-style network deny reading as an EPERM string classifies as network, not filesystem-permission", () => {
    expect(classifyGhFailure("cli member 'gh-api-no-net' exited 1: dial tcp 140.82.113.6:443: connect: operation not permitted")).toBe("network");
  });

  test("a DNS resolution failure classifies as network", () => {
    expect(classifyGhFailure("Get \"https://api.github.com/zen\": lookup api.github.com: Temporary failure in name resolution")).toBe("network");
  });

  test("a plain connection-refused error classifies as network", () => {
    expect(classifyGhFailure("connection refused")).toBe("network");
  });

  test("a bare filesystem EPERM with no network signal classifies as filesystem-permission", () => {
    expect(classifyGhFailure("open /Users/cas/.config/gh/hosts.yml: operation not permitted")).toBe("filesystem-permission");
  });

  test("a plain 'permission denied' classifies as filesystem-permission", () => {
    expect(classifyGhFailure("cat: /Users/cas/.levare-vendor-cli-gh-decoy-marker: Permission denied")).toBe("filesystem-permission");
  });

  test("a missing-binary AdapterError classifies as not-found", () => {
    expect(classifyGhFailure("agent 'gh-version-no-net': command 'gh' not found on PATH")).toBe("not-found");
  });

  test("an unrecognized message classifies as other", () => {
    expect(classifyGhFailure("gh: unknown flag --bogus")).toBe("other");
  });

  test("is case-insensitive", () => {
    expect(classifyGhFailure("DIAL TCP: OPERATION NOT PERMITTED")).toBe("network");
  });
});

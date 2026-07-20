// NOTES R4-VENDOR-CLI: pins `classifyGhFailure` (scripts/repro-r4-vendor-cli-gh.ts) — pure string
// matching, no live host required — the same "closes the container-pass gap for good, for this class of
// bug" posture NOTES R4-SANDBOX-FIX-14's own `selectDispatchProfileText` regression test established.
//
// Three orderings matter, all pinned below:
// 1. network-vs-permission — a sandboxed network deny surfacing through gh's own Go HTTP client typically
//    reads as "dial tcp ... operation not permitted" — an EPERM-flavored string that a naive
//    "permission"/"eperm" check would misclassify as a filesystem issue if checked before the
//    network-specific patterns.
// 2. gh-vendor-dir-permission-vs-filesystem-permission — round 1's own live finding: gh died reading its
//    OWN denied config directory (`~/.config/gh/config.yml`, kernel-confirmed `deny(1) file-read-data`).
//    A permission-shaped message that ALSO names one of gh's own config/state/data/cache paths (per
//    `cli/go-gh`'s own `pkg/config/config.go`: `config.yml`/`hosts.yml` under `GH_CONFIG_DIR`,
//    `state.yml` under `XDG_STATE_HOME`, `XDG_DATA_HOME`, `gh-cli-cache` under `XDG_CACHE_HOME`'s own
//    fallback) must classify as the MORE SPECIFIC `gh-vendor-dir-permission`, never the generic
//    `filesystem-permission` bucket a step's own verdict logic would otherwise misread as an unrelated
//    seal (e.g. the operator-home decoy) holding correctly.
// 3. gh-auth-required — round 2's own live finding: `gh api` refuses to issue ANY request, even to a
//    genuinely public/unauthenticated endpoint, without a resolved token — entirely in userspace, never
//    touching the network. gh's own auth-login prompt shares no substring with the network-signal list,
//    so this bucket is checked independently, before the generic permission-shaped checks (the auth
//    message itself is not permission-shaped at all, so ordering relative to those specifically doesn't
//    matter, but it must never fall through to "other" — a step's own verdict logic depends on it being
//    named).
// 4. gh-tls-trust-vs-network — round 3's own live finding: a network-GRANTED real gh request completed its
//    TCP connection and started a TLS handshake (kernel-confirmed `deny(1) mach-lookup
//    com.apple.trustd.agent`) — the OPPOSITE signal from a connection-level network deny, since a
//    certificate to fail verifying only exists after a real connection succeeded. Checked BEFORE the
//    network-signal list: an x509/certificate-verify failure is a strictly more specific signal, and
//    folding it into `network` would make a step's own verdict logic read a WORKING grant as a REGRESSION
//    — backwards.

import { describe, expect, test } from "bun:test";
import { classifyGhFailure } from "../scripts/repro-r4-vendor-cli-gh.ts";

describe("classifyGhFailure", () => {
  test("a Go-style network deny reading as an EPERM string classifies as network, not a permission bucket", () => {
    expect(classifyGhFailure("cli member 'gh-api-no-net' exited 1: dial tcp 140.82.113.6:443: connect: operation not permitted")).toBe("network");
  });

  test("a DNS resolution failure classifies as network", () => {
    expect(classifyGhFailure("Get \"https://api.github.com/zen\": lookup api.github.com: Temporary failure in name resolution")).toBe("network");
  });

  test("a plain connection-refused error classifies as network", () => {
    expect(classifyGhFailure("connection refused")).toBe("network");
  });

  // The exact shape of round 3's own live finding: TCP connected, TLS started, cert verification failed.
  test("gh's own x509 certificate-verify failure classifies as gh-tls-trust, never network (round 3's own live finding)", () => {
    expect(classifyGhFailure("cli member 'gh-api-with-net' exited 1: tls: failed to verify certificate: x509: OSStatus -26276")).toBe("gh-tls-trust");
  });

  test("a certificate-signed-by-unknown-authority message also classifies as gh-tls-trust", () => {
    expect(classifyGhFailure("x509: certificate signed by unknown authority")).toBe("gh-tls-trust");
  });

  test("gh-tls-trust is checked before the network bucket — never misread as a blocked connection", () => {
    const cls = classifyGhFailure("Get \"https://api.github.com/zen\": tls: failed to verify certificate: x509: certificate is not trusted");
    expect(cls).toBe("gh-tls-trust");
    expect(cls).not.toBe("network");
  });

  // The exact shape of round 1's own live finding: gh's own config.yml, denied.
  test("gh's own config.yml, EPERM, classifies as gh-vendor-dir-permission (round 1's own live finding)", () => {
    expect(
      classifyGhFailure("cli member 'gh-auth-status-no-net' exited 1: failed to read configuration:  open /Users/cas/.config/gh/config.yml: permission denied (argv: [...])"),
    ).toBe("gh-vendor-dir-permission");
  });

  test("gh's own hosts.yml, EPERM, classifies as gh-vendor-dir-permission — the file that would leak the operator's real auth token if ever read", () => {
    expect(classifyGhFailure("open /Users/cas/.config/gh/hosts.yml: operation not permitted")).toBe("gh-vendor-dir-permission");
  });

  test("gh's own state.yml under XDG_STATE_HOME, EPERM, classifies as gh-vendor-dir-permission", () => {
    expect(classifyGhFailure("open /Users/cas/.local/state/gh/state.yml: operation not permitted")).toBe("gh-vendor-dir-permission");
  });

  test("gh's own cache fallback under $TMPDIR/gh-cli-cache, EPERM, classifies as gh-vendor-dir-permission", () => {
    expect(classifyGhFailure("open /private/var/folders/xy/T/gh-cli-cache/somefile: permission denied")).toBe("gh-vendor-dir-permission");
  });

  // A DIFFERENT permission-shaped failure that names no gh-config-shaped path (the FIX-3/FIX-4 operator-
  // home decoy — `cat` reading a marker file, never gh at all) must NOT be swept into the new bucket.
  test("a decoy-marker EPERM with no gh-config-shaped path stays the generic filesystem-permission bucket", () => {
    expect(classifyGhFailure("cat: /Users/cas/.levare-vendor-cli-gh-decoy-marker: Permission denied")).toBe("filesystem-permission");
  });

  test("a missing-binary AdapterError classifies as not-found", () => {
    expect(classifyGhFailure("agent 'gh-version-no-net': command 'gh' not found on PATH")).toBe("not-found");
  });

  // Round 2's own live finding: gh's own auth-login prompt (exit 4), no resolved token, before ever
  // attempting a socket. The exact shape reported live.
  test("gh's own auth-login prompt classifies as gh-auth-required (round 2's own live finding)", () => {
    expect(
      classifyGhFailure(
        "cli member 'gh-api-no-net' exited 4: To get started with GitHub CLI, please run:  gh auth login. Alternatively, populate the GH_TOKEN environment variable.",
      ),
    ).toBe("gh-auth-required");
  });

  test("a shorter/paraphrased auth-required message still classifies correctly via either signal independently", () => {
    expect(classifyGhFailure("gh auth login required to continue")).toBe("gh-auth-required");
    expect(classifyGhFailure("please populate the GH_TOKEN environment variable")).toBe("gh-auth-required");
  });

  test("gh-auth-required is checked independently of the network/permission buckets — never conflated with either", () => {
    const authMsg = classifyGhFailure("To get started with GitHub CLI, please run:  gh auth login.");
    expect(authMsg).not.toBe("network");
    expect(authMsg).not.toBe("filesystem-permission");
    expect(authMsg).not.toBe("gh-vendor-dir-permission");
  });

  test("an unrecognized message classifies as other", () => {
    expect(classifyGhFailure("gh: unknown flag --bogus")).toBe("other");
  });

  test("is case-insensitive for the network, gh-vendor-dir, gh-auth-required, and gh-tls-trust orderings", () => {
    expect(classifyGhFailure("DIAL TCP: OPERATION NOT PERMITTED")).toBe("network");
    expect(classifyGhFailure("OPEN /USERS/CAS/.CONFIG/GH/CONFIG.YML: PERMISSION DENIED")).toBe("gh-vendor-dir-permission");
    expect(classifyGhFailure("PLEASE RUN: GH AUTH LOGIN")).toBe("gh-auth-required");
    expect(classifyGhFailure("X509: FAILED TO VERIFY CERTIFICATE")).toBe("gh-tls-trust");
  });
});

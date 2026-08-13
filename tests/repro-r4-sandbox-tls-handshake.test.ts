// NOTES R4-SANDBOX-TLS: pins `classifyTlsHandshakeFailure`
// (scripts/repro-r4-sandbox-tls-handshake.ts) — pure string matching, no live host required, mirroring
// `classifyGhFailure`/`classifyCodexAppServerFailure`'s own established shape.
//
// Two orderings matter, both pinned below:
// 1. `tls-trust` is checked FIRST — a certificate/chain-building failure is the exact class this round
//    exists to isolate, and must never fall through to the generic `network-deny` bucket.
// 2. Both LibreSSL's own message shape (exit 60/77) AND SecureTransport's coarser signal (exit 35 "ssl
//    connect error") classify as `tls-trust` — this file's own header names the live evidence that a
//    cert failure reads differently depending on which SSL backend a given host's curl links against,
//    and neither backend's own wording may hide a real finding behind the generic bucket.

import { describe, expect, test } from "bun:test";
import { classifyTlsHandshakeFailure } from "../scripts/repro-r4-sandbox-tls-handshake.ts";

describe("classifyTlsHandshakeFailure", () => {
  test("LibreSSL's own 'unable to get local issuer certificate' classifies as tls-trust", () => {
    expect(classifyTlsHandshakeFailure("curl: (60) SSL certificate problem: unable to get local issuer certificate")).toBe("tls-trust");
  });

  test("SecureTransport's coarser 'SSL connect error' (exit 35) also classifies as tls-trust", () => {
    expect(classifyTlsHandshakeFailure("curl: (35) SSL connect error")).toBe("tls-trust");
  });

  test("the exact reported codex symptom, UnknownIssuer, classifies as tls-trust", () => {
    expect(classifyTlsHandshakeFailure("IO error: invalid peer certificate: UnknownIssuer")).toBe("tls-trust");
  });

  test("tls-trust wins over the generic network-deny bucket even though 'ssl connect error' could read as connection-shaped", () => {
    const msg = "cli member 'tls-probe-with-net' exited 35: curl: (35) SSL connect error";
    expect(classifyTlsHandshakeFailure(msg)).not.toBe("network-deny");
    expect(classifyTlsHandshakeFailure(msg)).toBe("tls-trust");
  });

  test("a couldn't-connect failure classifies as network-deny", () => {
    expect(classifyTlsHandshakeFailure("curl: (7) Failed to connect to example.com port 443: Operation not permitted")).toBe("network-deny");
  });

  test("a couldn't-resolve-host failure classifies as network-deny", () => {
    expect(classifyTlsHandshakeFailure("curl: (6) Could not resolve host: example.com")).toBe("network-deny");
  });

  test("curl missing on PATH classifies as not-found", () => {
    expect(classifyTlsHandshakeFailure("agent 'tls-probe-with-net': command 'curl' not found on PATH")).toBe("not-found");
  });

  test("anything else classifies as other", () => {
    expect(classifyTlsHandshakeFailure("some unrelated error")).toBe("other");
  });
});

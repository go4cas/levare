// NOTES R4-SANDBOX-TLS — a sibling to scripts/repro-r4-sandbox-tls-handshake.ts, isolating the
// `com.apple.SecurityServer` mach-lookup grant (src/sandbox.ts) specifically, rather than a TLS
// handshake end to end.
//
// Why a sibling, not an extension of the TLS-handshake probe itself: that probe's own PASS (a bare
// `curl` handshake completing under the generated profile) does NOT exercise this grant — this
// host's system `curl` links LibreSSL, which carries its own CA bundle and never calls into
// Security.framework/securityd at all (the exact caveat that probe's own header names: a PASS there
// says nothing about a TLS stack that DOES defer to the platform trust store). `SecurityServer` was
// named by a `log stream` capture of a live, failing codex dispatch, diffed against that same probe's
// passing curl capture — never guessed, never bundled with the five services that same PASS already
// acquitted by evidence (see src/sandbox.ts's own comment on the grant, and docs/current-gaps.md).
// Granting exactly that one line, installed and re-dispatched live, is what confirmed it: the
// handshake completed, the member called its API, and produced a real artifact.
//
// What this script builds instead: `/usr/bin/security`, Apple's own keychain/Security.framework CLI —
// a system binary that genuinely round-trips through `securityd` (the process `com.apple.SecurityServer`
// names) for even a read-only query, unlike curl on this host. It runs `security list-keychains` under
// TWO sandbox-exec profiles built from the SAME `buildSandboxExecProfile` this project's real dispatch
// path uses (never a hand-rolled profile string): the real, current profile (SecurityServer granted,
// `allowNetwork: true`), and a synthetic variant with ONLY that one line stripped back out — a targeted
// A/B on the exact grant this round added, not a guess at some other profile shape. A PASS/FAIL
// difference between the two is the direct, host-only confirmation this round's live finding predicts;
// this script has not been run on a live macOS host from within this session — the same honest
// degradation every prior live-host harness in this saga takes when run outside its required platform.
//
// This container is Linux — `sandbox-exec` has never once run here, in this project's history. Run on
// a real macOS host: `bun run scripts/repro-r4-sandbox-securityserver.ts`. Requires `sandbox-exec` and
// `/usr/bin/security` (both present on every stock macOS) — no vendor CLI, no credential, no login.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSandboxExecProfile } from "../src/sandbox.ts";

const SECURITY_BIN = "/usr/bin/security";
const SECURITYSERVER_LINE = '(allow mach-lookup (global-name "com.apple.SecurityServer"))';

interface ProbeResult {
  label: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runUnderProfile(sbx: string, label: string, profile: string): ProbeResult {
  const scratchDir = mkdtempSync(join(tmpdir(), "levare-securityserver-probe-"));
  const profilePath = join(scratchDir, "profile.sb");
  writeFileSync(profilePath, profile);
  try {
    const r = Bun.spawnSync([sbx, "-f", profilePath, "--", SECURITY_BIN, "list-keychains"], { stdout: "pipe", stderr: "pipe", timeout: 15000 });
    return {
      label,
      exitCode: r.exitCode,
      stdout: r.stdout ? new TextDecoder().decode(r.stdout).trim() : "",
      stderr: r.stderr ? new TextDecoder().decode(r.stderr).trim() : "",
    };
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

function captureKernelDenials(windowSeconds: number): void {
  console.log("");
  console.log("=== Best-effort kernel-denial capture (macOS unified log) ===");
  try {
    const r = Bun.spawnSync(["log", "show", "--last", `${windowSeconds}s`, "--style", "syslog", "--predicate", 'eventMessage contains "deny"'], { stdout: "pipe", stderr: "pipe", timeout: 8000 });
    const out = r.stdout ? new TextDecoder().decode(r.stdout) : "";
    const relevant = out
      .split("\n")
      .filter((l) => /SecurityServer|securityd|sandbox-exec/i.test(l))
      .slice(-40);
    if (relevant.length) {
      console.log(`${relevant.length} matching line(s) (last 40 shown):`);
      for (const l of relevant) console.log(`  ${l}`);
    } else {
      console.log("no SecurityServer/securityd denial lines found in the captured window.");
    }
  } catch (e) {
    console.log(`(log show unavailable/failed: ${e instanceof Error ? e.message : String(e)})`);
  }
}

async function main() {
  if (process.platform !== "darwin") {
    console.log(`This harness investigates a macOS sandbox-exec grant (darwin-only) — running on '${process.platform}' would only prove what this container already knows (no working sandbox-exec here). Degrading honestly: exiting.`);
    return;
  }
  const sbx = Bun.which("sandbox-exec") ?? (existsSync("/usr/bin/sandbox-exec") ? "/usr/bin/sandbox-exec" : null);
  if (!sbx) {
    console.log("sandbox-exec not found — cannot investigate anything real here. Degrading honestly: exiting rather than passing vacuously.");
    return;
  }
  if (!existsSync(SECURITY_BIN)) {
    console.log(`${SECURITY_BIN} not found — not a stock macOS host, or the binary moved. Degrading honestly: exiting.`);
    return;
  }
  console.log(`sandbox-exec: ${sbx}`);
  console.log(`security: ${SECURITY_BIN}`);

  const withGrant = buildSandboxExecProfile({ cwd: process.cwd(), allowNetwork: true });
  if (!withGrant.includes(SECURITYSERVER_LINE)) {
    console.log(">>> HARNESS ERROR: the generated profile does not contain the expected SecurityServer grant line at all — src/sandbox.ts's own text has drifted from what this script expects. Fix the constant above before trusting anything below. <<<");
    return;
  }
  // The synthetic "without" variant: the SAME real profile, with ONLY the one line this round added
  // removed — a targeted A/B on this grant specifically, not a hand-authored guess at some other shape.
  const withoutGrant = withGrant.replace(`${SECURITYSERVER_LINE}\n`, "");

  console.log("");
  console.log("=== 1. WITHOUT the SecurityServer grant (synthetic — the real profile, minus that one line) ===");
  const without = runUnderProfile(sbx, "without", withoutGrant);
  console.log(`[exit ${without.exitCode}] stdout=${JSON.stringify(without.stdout.slice(0, 300))} stderr=${JSON.stringify(without.stderr.slice(0, 300))}`);

  console.log("");
  console.log("=== 2. WITH the SecurityServer grant (the real, current generated profile) ===");
  const withResult = runUnderProfile(sbx, "with", withGrant);
  console.log(`[exit ${withResult.exitCode}] stdout=${JSON.stringify(withResult.stdout.slice(0, 300))} stderr=${JSON.stringify(withResult.stderr.slice(0, 300))}`);

  captureKernelDenials(30);

  console.log("");
  console.log("=== Summary ===");
  if (without.exitCode !== 0 && withResult.exitCode === 0) {
    console.log(">>> PASS: `security list-keychains` fails WITHOUT the SecurityServer grant and succeeds WITH it — this grant is confirmed load-bearing for a real securityd round-trip under this exact profile, host-only, independent of codex entirely. <<<");
  } else if (without.exitCode === 0 && withResult.exitCode === 0) {
    console.log(">>> INCONCLUSIVE: `security list-keychains` succeeded even WITHOUT the grant — either this specific query doesn't round-trip through securityd on this host/macOS version the way this script assumed, or something else in the profile already covers it. Re-read the kernel-log capture above before concluding the grant is unnecessary; try a query that mutates the keychain (out of scope for this read-only probe) if this keeps happening. <<<");
  } else {
    console.log(">>> UNEXPECTED: both runs failed, or WITH failed while WITHOUT passed. Read the raw stdout/stderr above and the kernel-log capture before drawing any conclusion — this is not the predicted shape either way. <<<");
  }
}

if (import.meta.main) {
  await main();
}

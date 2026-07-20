// NOTES R4-VENDOR-CLI — the first live validation of R4's sandbox against a REAL vendor CLI (`gh`),
// not the member stub. Every prior live-host round in this saga (NOTES R4-SANDBOX-FIX through FIX-14)
// proved the sandbox against `bun` itself (the interpreter running a member stub script) — never a
// third-party binary with its own startup sequence, its own config-directory reads, and its own network
// client. FIX-5's own residual named this explicitly ("a real wrapped vendor CLI — Codex, Gemini — may
// read further sysctls or touch further kernel interfaces this round's own evidence never surfaced").
// This script closes that gap for `gh` specifically, following the SAME method this whole saga has used
// throughout: drive the real, unmodified production entry point (`AdapterRunner.produceAsync`, never a
// hand-rolled spawn), capture `LEVARE_SANDBOX_DEBUG=1`'s own existing debug plumbing (profile text,
// composed argv, cwd, raw spawn result — printed directly by production code, never re-derived or
// re-captured here — see this file's own step runner), and diagnose any failure from that evidence
// before proposing any fix. THIS IS A VALIDATION, NOT A BUILD: the default posture is that R4 already
// holds and `gh` runs clean under it — prove that first; only a genuine live failure earns a fix, and
// any fix must be the narrowest grant the evidence justifies, never a convenience widening (NOTES
// R4-SANDBOX-FIX-8/FIX-12's own standing lesson: a new grant must be re-checked against every existing
// seal in the SAME round, never assumed independent of them — step 5 below is exactly that recheck).
//
// Five steps, each a REAL `AdapterRunner.produceAsync` dispatch of a synthetic `kind: cli` member whose
// `command` invokes the real `gh` binary — never a bespoke, weaker probe (FIX-5's own "weak canary"
// lesson: `gh --version` alone would prove nothing about `gh`'s real startup path, exactly the trap a
// fast-exit flag sets — so step 1 leads with `gh auth status`, which genuinely resolves gh's own config
// directory and network-auth-check logic, and keeps `--version` only as a secondary, weaker signal):
//
//   1a. `gh auth status`  (member holds NO connector — network denied by construction) — gh's own
//       startup/config-load path, unauthenticated. Expected to complete without ever reaching the
//       network (gh reports "not logged in" from local state alone) — proves gh survives the sandbox's
//       filesystem confinement specifically, the step this whole script exists to add that no prior
//       round ever exercised.
//   1b. `gh --version`  (member holds NO connector) — the fast-exit secondary signal, kept for extra
//       coverage; on its own it would NOT prove step 1a's claim (see the weak-canary note above).
//   2.  `gh api /zen`  (member holds NO connector — memberNetworkAllowed(repo, member) === false, i.e.
//       "no connector declaring a remote endpoint") — a real, unauthenticated GET to a real GitHub
//       endpoint (the documented public "zen" quote, chosen specifically because it needs no token —
//       an auth failure here would read as a DIFFERENT, misleading signal than a network denial, which
//       is exactly what this step exists to distinguish). MUST fail — the network deny must bite a real
//       network client, not just a synthetic `(deny network*)` unit test.
//   3.  `gh api /zen`  (member holds the golden fixture's own pre-existing `github` connector —
//       `memberNetworkAllowed` is true) — the SAME command as step 2, varying only the grant. Expected
//       to succeed IF this host has real internet reachability at all; see this step's own printed note
//       on why a failure here is not automatically proof the sandbox is at fault (host-level
//       connectivity and sandbox network denial can look identical from gh's own error text alone —
//       step 2's own result is the differential signal a Conductor should read this step against).
//   4.  `cat <decoy file under the operator's real $HOME>`  (member holds the SAME `github` connector as
//       step 3 — network-granted) — NOTES R4-SANDBOX-FIX-8/FIX-12's own standing instruction: a new
//       reach (network, here) must be re-checked against every EXISTING seal in the same round, never
//       assumed independent of it. This is the FIX-3/FIX-4 operator-home decoy test, run specifically
//       against a network-granted gh-shaped dispatch — MUST fail exactly as it does for every other
//       member, proving network reach and filesystem confinement are orthogonal grants that don't leak
//       into one another.
//
// A best-effort kernel-denial capture (macOS `log show`, step 6) runs after the above — the same class
// of evidence FIX-3 through FIX-12 used, gathered automatically here rather than by a Conductor's own
// manual `log show` call, but never treated as authoritative on its own (a live host may deny `log
// show` the relevant entries without a working primitive being at fault; failure to capture is reported
// honestly, never silently swallowed as "nothing was denied").
//
// Every failure this script observes is passed through `classifyGhFailure` (module scope, exported —
// pinned by `tests/repro-r4-vendor-cli-gh.test.ts`, pure string logic, no live host required) — a
// HEURISTIC aid distinguishing a network-shaped failure from a filesystem-permission-shaped one from
// gh simply not being found, printed alongside the raw message (never in place of it) so a Conductor
// reads the classifier's guess and the ground truth together.
//
// Run on the live macOS host: `bun run scripts/repro-r4-vendor-cli-gh.ts`. Requires `sandbox-exec` (the
// same darwin-only guard `scripts/repro-r4-sandbox-fix10-hang.ts` already uses) AND a real `gh` on
// PATH — absent either, this script says so and exits cleanly rather than faking a pass (the goal's own
// "degrade honestly" instruction). This container has neither (Linux, no `gh` installed) — sanity-
// checked here only insofar as the guards themselves fire correctly and the file typechecks/imports
// cleanly; the actual PASS/FAIL/finding verdicts for every step below require the live host.

import { existsSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AdapterRunner, type NativeBoundary, type RemoteBoundary } from "../src/adapters.ts";
import { loadRepo } from "../src/repo.ts";
import { loadPricing } from "../src/pricing.ts";
import type { Repo } from "../src/repo.ts";
import type { Pricing } from "../src/pricing.ts";
import type { Agent } from "../src/types.ts";

const STEP_TIMEOUT_S = 30;

// A heuristic read on a `gh`/AdapterError failure message — module-scope and exported so
// `tests/repro-r4-vendor-cli-gh.test.ts` can pin it without a live host (pure string matching, the same
// "closes the container-pass gap for good, for this class of bug" posture NOTES R4-SANDBOX-FIX-14's own
// `selectDispatchProfileText` regression test established). Ordered so network-shaped signals are
// checked FIRST: a sandboxed network deny surfacing through Go's own HTTP client (gh is written in Go)
// typically reads as "dial tcp ... operation not permitted" — an EPERM-flavored string that would
// otherwise misclassify as a bare filesystem permission issue if "permission"/"eperm" were checked
// first. Never authoritative on its own — every caller prints the raw message alongside this label.
export function classifyGhFailure(message: string): "network" | "filesystem-permission" | "not-found" | "other" {
  const m = message.toLowerCase();
  const networkSignals = [
    "dial tcp",
    "lookup ",
    "could not resolve host",
    "network is unreachable",
    "no route to host",
    "connection refused",
    "connection reset",
    "tls handshake",
    "ssl_connect",
    "ssl connect error",
    "i/o timeout",
    "temporary failure in name resolution",
    "https://api.github.com",
  ];
  if (networkSignals.some((s) => m.includes(s))) return "network";
  if (m.includes("not found on path") || m.includes("command 'gh'")) return "not-found";
  if (m.includes("permission denied") || m.includes("eperm") || m.includes("operation not permitted")) return "filesystem-permission";
  return "other";
}

// Builds a synthetic `kind: cli` agent invoking real `gh` — never checked into `fixtures/golden` (this
// is a validation script, not a studio fixture; per the goal's own "ideal outcome is ZERO production
// code change" framing, nothing here touches a tracked file). Mirrors `fixtures/golden/agents/finch.md`'s
// own shape (`produces: [review]`, `style.avatar`) closely enough that `AdapterRunner`'s real code path
// never has to special-case it.
function mkGhAgent(name: string, command: string[], connectors: string[] | undefined): Agent {
  return {
    name,
    kind: "cli",
    produces: ["review"],
    command,
    timeout: STEP_TIMEOUT_S,
    connectors,
    style: { avatar: "G" },
    body: "",
  };
}

type StepExpectation = "must-succeed" | "must-fail" | "informational";

// Drives ONE real `AdapterRunner.produceAsync` dispatch — the identical production call chain FIX-13's
// own parity check drives (`prepare`, `withDispatchWorktreeAsync`, `sandboxWrap`, `wrapForSandbox`,
// `buildSandboxExecProfile`/`bubblewrapArgv`, the real spawn boundary) — never a partial simulation or a
// hand-rolled sandbox-exec invocation. `LEVARE_SANDBOX_DEBUG=1` is left SET for the duration (never
// captured/re-selected here — this script only ever needs to DISPLAY the debug plumbing to a Conductor,
// never programmatically compare two captures the way the FIX-13/14 parity check does, so none of that
// investigation's own position-vs-identity selection machinery is needed or duplicated here); production
// code's own `console.error` calls print the profile text, composed argv, cwd, and post-spawn raw result
// (exitCode/signalCode/stdout+stderr byte counts, stderr text) directly to this process's real stderr,
// interleaved in true chronological order with this function's own `console.log` step framing.
async function runGhDispatch(repo: Repo, pricing: Pricing, label: string, agent: Agent, expect: StepExpectation, note: string): Promise<void> {
  console.log("");
  console.log(`=== ${label} ===`);
  console.log(note);
  repo.agents.set(agent.name, agent);
  const nativeMock: NativeBoundary = { invoke: () => ({ doc: "unused" }) };
  const remoteMock: RemoteBoundary = { call: () => ({ doc: "unused" }) };
  const runner = new AdapterRunner(repo, {
    pricing,
    capabilities: [{ member: agent.name, kind: "review" }],
    native: nativeMock,
    remote: remoteMock,
  });
  const start = Date.now();
  let outcome: "succeeded" | "failed";
  let detail: string;
  try {
    const { doc } = await runner.produceAsync(agent.name, "review", "repro", "storefront");
    outcome = "succeeded";
    const sandboxLine = /^sandbox: .+$/m.exec(doc)?.[0] ?? "sandbox: (not reported — non-cli path or sandbox level unknown)";
    const bodyStart = doc.indexOf("\n---\n\n");
    const bodyPreview = bodyStart === -1 ? "" : doc.slice(bodyStart + 6).trim().slice(0, 300);
    detail = `${sandboxLine}${bodyPreview ? ` — output preview: ${JSON.stringify(bodyPreview)}` : ""}`;
  } catch (e) {
    outcome = "failed";
    const msg = e instanceof Error ? e.message : String(e);
    const cls = classifyGhFailure(msg);
    detail = `(heuristic classification: ${cls}) ${msg}`;
  }
  const elapsed = Date.now() - start;
  console.log(`[${outcome.toUpperCase()}] in ${elapsed}ms — ${detail}`);
  if (expect === "must-succeed") {
    console.log(outcome === "succeeded" ? "        >>> PASS: succeeded as expected <<<" : "        >>> FINDING: this was expected to succeed but did not — diagnose from the evidence printed above, never guess <<<");
  } else if (expect === "must-fail") {
    console.log(outcome === "failed" ? "        >>> PASS: denied/failed as expected <<<" : "        >>> REGRESSION: this MUST fail (network denied / operator-home denied) but it SUCCEEDED <<<");
  } else {
    console.log("        (informational — read together with the paired step's own result; see this step's own note above)");
  }
}

// Best-effort macOS kernel-denial capture (mirrors the manual `log show` evidence every FIX-3 through
// FIX-12 round in this saga was handed by a Conductor directly — gathered automatically here instead).
// Never authoritative on its own: an empty result here means either "nothing was denied" or "this host's
// own `log show` needs elevated privileges for the relevant subsystem" — both are named explicitly,
// never conflated. Silent on any invocation failure beyond that one printed line — this is diagnostic
// sugar, not a step whose own failure should be read as a finding about the sandbox itself.
function captureKernelDenials(windowSeconds: number): void {
  console.log("");
  console.log("=== Best-effort kernel-denial capture (macOS unified log) ===");
  if (process.platform !== "darwin") {
    console.log("(skipped — darwin-only, mirroring every other kernel-log capture in this saga)");
    return;
  }
  try {
    const r = Bun.spawnSync(["log", "show", "--last", `${windowSeconds}s`, "--style", "syslog", "--predicate", 'eventMessage contains "deny"'], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 8000,
    });
    const out = r.stdout ? new TextDecoder().decode(r.stdout) : "";
    const relevant = out
      .split("\n")
      .filter((l) => /\bgh\b|Sandbox:/i.test(l))
      .slice(-40);
    if (relevant.length) {
      console.log(`${relevant.length} matching line(s) (last 40 shown):`);
      for (const l of relevant) console.log(`  ${l}`);
    } else {
      console.log("no lines mentioning 'gh'/'Sandbox:' found in the captured window — either nothing was denied, or this host's `log show` needs elevated privileges for the relevant subsystem (not distinguishable from here).");
    }
  } catch (e) {
    console.log(`(log show unavailable/failed: ${e instanceof Error ? e.message : String(e)} — not a finding about the sandbox itself, just about this capture)`);
  }
}

async function main() {
  if (process.platform !== "darwin") {
    console.log(
      `This harness validates the R4 sandbox against a real gh CLI under sandbox-exec (darwin-only) — running on '${process.platform}' would only prove what this container already knows (no working sandbox-exec here, mirroring scripts/repro-r4-sandbox-fix10-hang.ts's own platform guard). Degrading honestly: skipping every sandboxed assertion below rather than passing vacuously. Exiting.`,
    );
    return;
  }
  const sbx = Bun.which("sandbox-exec") ?? (existsSync("/usr/bin/sandbox-exec") ? "/usr/bin/sandbox-exec" : null);
  if (!sbx) {
    console.log("sandbox-exec not found on PATH or at /usr/bin/sandbox-exec — cannot validate anything real here. Degrading honestly: exiting rather than passing vacuously.");
    return;
  }
  const gh = Bun.which("gh");
  if (!gh) {
    console.log("gh not found on PATH — cannot validate a real gh dispatch on this host (install via `brew install gh` and re-run). Degrading honestly: this is a named residual, not a pass. Exiting.");
    return;
  }
  console.log(`sandbox-exec: ${sbx}`);
  console.log(`gh: ${gh}`);

  const repo = loadRepo("fixtures/golden");
  const pricing = loadPricing("fixtures/golden");

  const priorDebug = process.env.LEVARE_SANDBOX_DEBUG;
  process.env.LEVARE_SANDBOX_DEBUG = "1";

  const decoyPath = join(homedir(), ".levare-vendor-cli-gh-decoy-marker");
  writeFileSync(decoyPath, "MARKER — must never be readable through a network-granted gh dispatch\n");

  try {
    await runGhDispatch(
      repo,
      pricing,
      "1a. gh auth status — NO connector (network denied), gh's own real startup/config-load path",
      mkGhAgent("gh-auth-status-no-net", ["gh", "auth", "status"], undefined),
      "informational",
      "gh itself exits NONZERO for 'not logged in' (confirmed against the real gh CLI's own documented behavior), so [FAILED] here is the EXPECTED, GOOD outcome — read the printed message and its heuristic classification, not the bare [SUCCEEDED]/[FAILED] label: a clean gh-authored message ('You are not logged into any GitHub hosts', classified 'other') is gh's own startup surviving the sandbox's filesystem confinement WITHOUT ever reaching the network; a 'filesystem-permission'-classified message instead would point at gh's own config-directory read hitting the operator-home deny — the same EPERM-vs-ENOENT class NOTES R4-SANDBOX-FIX-9 found for git's .gitconfig — named here as the ranked-first suspicion for any confusing failure, never assumed in advance. A HANG (this agent's own 30s timeout firing) would be the genuinely alarming outcome.",
    );

    await runGhDispatch(
      repo,
      pricing,
      "1b. gh --version — NO connector (secondary, weaker signal — see this script's own header on why 1a is the real proof)",
      mkGhAgent("gh-version-no-net", ["gh", "--version"], undefined),
      "informational",
      "A fast-exit flag — completing here does NOT independently prove gh's real startup path survives the sandbox (NOTES R4-SANDBOX-FIX-5's own weak-canary lesson); read alongside step 1a, never in place of it.",
    );

    await runGhDispatch(
      repo,
      pricing,
      "2. gh api /zen — NO connector (memberNetworkAllowed === false)",
      mkGhAgent("gh-api-no-net", ["gh", "api", "/zen"], undefined),
      "must-fail",
      "A real, unauthenticated GET to a real GitHub endpoint that needs no token (the public 'zen' quote) — the network deny must bite a genuine network client, not just a unit test's synthetic (deny network*) assertion.",
    );

    await runGhDispatch(
      repo,
      pricing,
      "3. gh api /zen — WITH the golden fixture's own 'github' connector (memberNetworkAllowed === true)",
      mkGhAgent("gh-api-with-net", ["gh", "api", "/zen"], ["github"]),
      "informational",
      "The SAME command as step 2, varying only the grant. Expected to SUCCEED if this host has real internet reachability. A failure here is NOT automatically proof the sandbox is at fault — host-level connectivity and a sandbox network deny can read identically from gh's own error text. Read this step's own result against step 2's: (2 denied, 3 succeeded) is the differential evidence that confirms the boundary is real; (2 denied, 3 also denied) points at host connectivity, not the sandbox; (2 succeeded) is itself the step-2 regression, independent of this step entirely.",
    );

    await runGhDispatch(
      repo,
      pricing,
      `4. cat ${decoyPath} — WITH the 'github' connector (network-granted, same shape as step 3)`,
      mkGhAgent("gh-decoy-home-read", ["cat", decoyPath], ["github"]),
      "must-fail",
      "NOTES R4-SANDBOX-FIX-8/FIX-12's own standing instruction: a new reach (network, granted via 'github' here) must be re-checked against every EXISTING seal in the same round. This is the FIX-3/FIX-4 operator-home decoy test, run against a network-granted gh-shaped dispatch specifically — must fail exactly as it does for every other member, proving network and filesystem grants are orthogonal and neither leaks into the other.",
    );
  } finally {
    rmSync(decoyPath, { force: true });
    if (priorDebug === undefined) delete process.env.LEVARE_SANDBOX_DEBUG;
    else process.env.LEVARE_SANDBOX_DEBUG = priorDebug;
  }

  captureKernelDenials(120);

  console.log("");
  console.log("=== Summary ===");
  console.log("Every PASS/REGRESSION/FINDING verdict above is this run's own — read them in order, and read");
  console.log("step 3 against step 2 as described in step 3's own note before concluding anything about the");
  console.log("network boundary specifically. Record this run's outcome in NOTES R4-VENDOR-CLI, naming any");
  console.log("code change ONLY if a REGRESSION or FINDING above demands one, with the narrowest grant the");
  console.log("printed evidence (profile text / kernel denial / raw spawn result, all above) actually justifies.");
}

// Guarded so a future test file can import `classifyGhFailure` without triggering a full run — the same
// pattern `scripts/repro-r4-sandbox-fix10-hang.ts` already established (itself following
// `scripts/generate-cheatsheets.ts`'s own precedent).
if (import.meta.main) {
  await main();
}

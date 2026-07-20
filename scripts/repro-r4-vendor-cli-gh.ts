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
// seal in the SAME round, never assumed independent of them — step 4 below is exactly that recheck).
//
// ROUND 1 (live macOS run) found exactly that kind of genuine failure — not in R4 itself, but in `gh`'s
// own startup: every step died identically at `~/.config/gh/config.yml`, kernel-confirmed `deny(1)
// file-read-data`, the EPERM-vs-ENOENT class NOTES R4-SANDBOX-FIX-9 already named for git's own
// `.gitconfig`, recurring for a tool whose own config/state/data/cache resolution is FOUR directories,
// not one file `/dev/null` could stand in for. Fixed in `src/adapters.ts` (`cliVendorScratchEnv`/
// `createCliVendorScratch`/`fullSandboxEnvRedirect`, applied generically to every `"full"`-tier `kind:
// cli` dispatch — mirrors `gitConfigRedirectEnv`'s own precedent exactly, see that function's own doc for
// the evidence and the full account).
//
// ROUND 2 (live macOS run, re-run against the fix) confirmed the config fix WORKED — every step got past
// config-load clean, kernel log showed no more `config.yml` denial — but surfaced a SECOND, independent
// finding: `gh api` refuses to issue ANY request, even to the genuinely public/unauthenticated `/zen`
// endpoint, without a resolved token — entirely in userspace, before ever attempting a socket. Steps 2 and
// 3 both failed identically with gh's own auth-login prompt, zero differential, proving nothing about the
// network boundary either way. This is a HARNESS gap (the original design assumed `/zen` was reachable
// unauthenticated; it isn't, from `gh`'s own CLI, regardless of the target endpoint), never a product
// finding — see `classifyGhFailure`'s own `gh-auth-required` bucket and `ghApiWithRawTcpProbe`'s own doc
// for the fix: a raw, gh-auth-INDEPENDENT socket-connect probe appended to the same dispatch, plus a
// `diagnoseMemberEnv` printout showing directly whether `GITHUB_TOKEN` reached each step's own env. This
// is ROUND 3 of the SAME script (never a new file — the goal's own "the established method — the
// Conductor runs it once" instruction). Steps 1a/1b/4 are UNCHANGED from round 1; steps 2/3 changed their
// OWN command (adding the raw TCP probe) and verdict logic (now keyed on the probe, not gh's own exit
// code) — everything else about them (which member, which connector grant) is unchanged.
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
//   2.  `gh api /zen` + a raw TCP probe (member holds NO connector — memberNetworkAllowed(repo, member)
//       === false, i.e. "no connector declaring a remote endpoint", and therefore no token either —
//       structurally coupled under this codebase's real production model, see `ghApiWithRawTcpProbe`'s
//       own doc for why that's not routed around). gh itself will refuse locally (`gh-auth-required`,
//       expected); the step's own verdict comes from the RAW_TCP_CONNECT marker instead — MUST read
//       DENIED, proving the sandbox's own network boundary bites a real socket attempt regardless of what
//       gh's own business logic decides to do first.
//   3.  `gh api /zen` + the SAME raw TCP probe (member holds the golden fixture's own pre-existing
//       `github` connector — `memberNetworkAllowed` is true, and `GITHUB_TOKEN` should reach gh through
//       it — REQUIRES `export GITHUB_TOKEN=<a real PAT>` in the Conductor's own shell before running, see
//       this step's own header note for exactly why that name and not `GH_TOKEN`). Expected RAW_TCP_
//       CONNECT=OK and a real gh success, IF this host has real internet reachability at all; read this
//       step's own RAW_TCP_CONNECT against step 2's — see this step's own printed note for the full
//       differential logic.
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
// HEURISTIC aid distinguishing a network-shaped failure from a `gh`-own-config/state/data/cache-directory
// -shaped one (round 1's own finding, `gh-vendor-dir-permission`) from gh's own local auth-gate refusal
// (round 2's own finding, `gh-auth-required`) from a generic filesystem-permission one (e.g. step 4's own
// decoy) from gh simply not being found — each checked BEFORE a step's own verdict, since any of the first
// two means the step never reached what it meant to test at all — printed alongside the raw message
// (never in place of it) so a Conductor reads the classifier's guess and the ground truth together.
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
import { buildMemberEnv } from "../src/env.ts";
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
//
// NOTES R4-VENDOR-CLI (live macOS run, round 1): the FIRST live run of this harness surfaced a REAL
// finding — every step died identically at `~/.config/gh/config.yml`, `deny(1) file-read-data` (kernel
// evidence), because gh treats a DENIED (present-but-forbidden) config read as FATAL, before ever
// reaching the network — the same EPERM-vs-ENOENT class NOTES R4-SANDBOX-FIX-9 found for git's own
// `.gitconfig`. That failure is EPERM-shaped and mentions no network keyword at all, so round 1's
// classifier correctly bucketed it as `filesystem-permission` — but round 1's own VERDICT logic still
// printed a bare PASS/REGRESSION against the `must-fail`/informational network expectation, which was
// WRONG: gh never reached the network layer at all, so nothing about the network boundary was actually
// exercised that run. `gh-vendor-dir-permission` is a NEW, more specific bucket — a permission-shaped
// failure whose message ALSO names one of gh's own config/state/data/cache paths (confirmed against
// `cli/go-gh`'s own `pkg/config/config.go`: `GH_CONFIG_DIR`'s `config.yml`/`hosts.yml`,
// `XDG_STATE_HOME`'s `state.yml`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`'s own `$TMPDIR/gh-cli-cache`
// fallback) — checked BEFORE the generic `filesystem-permission` bucket so this exact class of finding is
// never silently folded into a generic label a verdict could misread as "the intended seal held." Every
// caller must check for this bucket FIRST, before applying a step's own must-fail/must-succeed
// expectation — see `runGhDispatch`'s own verdict logic below.
export function classifyGhFailure(message: string): "network" | "gh-vendor-dir-permission" | "gh-auth-required" | "filesystem-permission" | "not-found" | "other" {
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
  // NOTES R4-VENDOR-CLI (round 2 live finding): `gh api` refuses to issue ANY request — even to a
  // genuinely public, unauthenticated endpoint like `/zen` — without a resolved token, entirely in
  // userspace, before ever attempting a socket. This is gh's OWN business logic, unrelated to the
  // sandbox's network boundary, and it produces a message shape (gh's own auth-login prompt) that shares
  // no substring with the network-signal list above — checked here, before the generic buckets, so it is
  // never conflated with either a real network deny OR a real success/failure of the network layer.
  if (m.includes("gh auth login") || (m.includes("populate") && m.includes("token"))) return "gh-auth-required";
  const permissionShaped = m.includes("permission denied") || m.includes("eperm") || m.includes("operation not permitted");
  if (permissionShaped) {
    const ghVendorDirSignals = ["/.config/gh/", "config.yml", "hosts.yml", "state.yml", "/.local/state/gh", "/.local/share/gh", "/.cache/gh", "gh-cli-cache"];
    if (ghVendorDirSignals.some((s) => m.includes(s))) return "gh-vendor-dir-permission";
    return "filesystem-permission";
  }
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

// NOTES R4-VENDOR-CLI (round 2 live finding): `gh api /zen` alone cannot isolate "the sandbox denied the
// network" from "gh refused locally, before ever attempting a socket, because no token was present" — gh
// requires resolved auth for EVERY `gh api` call, even to a genuinely public/unauthenticated endpoint,
// entirely in userspace. Appends a RAW TCP connect attempt (bash's own `/dev/tcp/HOST/PORT`, no `gh`
// involved at all) to the SAME dispatch, so the sandbox's own network boundary gets an independent,
// gh-auth-independent signal alongside gh's own result — `RAW_TCP_CONNECT=OK`/`DENIED`, echoed to BOTH
// stdout (visible in a successful dispatch's own doc body) and stderr (visible in a failed dispatch's own
// `diagnoseCliFailure` tail, and unconditionally in the `LEVARE_SANDBOX_DEBUG` raw spawn-result dump
// either way). `bash`, not `sh`: `/dev/tcp` is a bash-specific feature, absent from a POSIX-strict `sh`/
// `dash`; macOS ships `/bin/bash` (old 3.2, but `/dev/tcp` has been present since bash 2.04). No `timeout`
// wrapper — GNU `timeout` is not guaranteed present on a fresh macOS install (the same reason
// `scripts/repro-r4-sandbox-fix10-hang.ts` never uses it); the agent's own `STEP_TIMEOUT_S`-second
// dispatch-level kill (enforced by production's own `asyncBunSpawn`, the same mechanism every other
// timeout in this codebase relies on) is the real safety net against a hang.
function ghApiWithRawTcpProbe(): string[] {
  const script = ["gh api /zen", "gh_exit=$?", "if (exec 3<>/dev/tcp/api.github.com/443) 2>/dev/null; then tcp=OK; else tcp=DENIED; fi", 'echo "RAW_TCP_CONNECT=$tcp"', 'echo "RAW_TCP_CONNECT=$tcp" >&2', "exit $gh_exit"].join("; ");
  return ["bash", "-c", script];
}

// NOTES R4-VENDOR-CLI (round 2, requirement 1): prints WHETHER `GH_TOKEN`/`GITHUB_TOKEN` reach this
// member's own resolved env — NEVER the value — via the real, exported `buildMemberEnv` (env.ts), the
// identical function `AdapterRunner#prepare` calls internally. This is what lets a live run show directly
// whether the golden fixture's own `github` connector (`env: [GITHUB_TOKEN]` — NOT `GH_TOKEN`, named
// explicitly since gh itself checks `GH_TOKEN` with HIGHER precedence than `GITHUB_TOKEN`, so exporting
// the wrong name in the Conductor's own shell would silently fail this differently than expected) actually
// resolved a real credential this run, before gh ever runs — never guessed at after the fact from gh's own
// possibly-ambiguous error text.
function diagnoseMemberEnv(repo: Repo, member: string): void {
  const env = buildMemberEnv(repo, member);
  console.log(`        member env diagnostic for '${member}': GH_TOKEN present=${"GH_TOKEN" in env} GITHUB_TOKEN present=${"GITHUB_TOKEN" in env} (values never printed, presence only)`);
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
// NOTES R4-VENDOR-CLI (round 2): `tcpExpect`, when set, means this step was built via
// `ghApiWithRawTcpProbe()` and the FINAL verdict comes from the `RAW_TCP_CONNECT` marker specifically —
// gh's own exit code/classification (including a fully-expected `gh-auth-required` on the no-connector
// step) is printed as secondary context, never the primary verdict, for exactly these two steps. Every
// other step (1a, 1b, 4) keeps the original `expect`-driven verdict, since gh's own outcome IS what those
// steps mean to test.
type TcpExpectation = "must-deny" | "informational";

async function runGhDispatch(repo: Repo, pricing: Pricing, label: string, agent: Agent, expect: StepExpectation, note: string, tcpExpect?: TcpExpectation): Promise<void> {
  console.log("");
  console.log(`=== ${label} ===`);
  console.log(note);
  repo.agents.set(agent.name, agent);
  diagnoseMemberEnv(repo, agent.name);
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
  let classification: ReturnType<typeof classifyGhFailure> | null = null;
  let rawText = ""; // doc (success) or error message (failure) — searched below for the RAW_TCP_CONNECT marker.
  try {
    const { doc } = await runner.produceAsync(agent.name, "review", "repro", "storefront");
    outcome = "succeeded";
    rawText = doc;
    const sandboxLine = /^sandbox: .+$/m.exec(doc)?.[0] ?? "sandbox: (not reported — non-cli path or sandbox level unknown)";
    const bodyStart = doc.indexOf("\n---\n\n");
    const bodyPreview = bodyStart === -1 ? "" : doc.slice(bodyStart + 6).trim().slice(0, 300);
    detail = `${sandboxLine}${bodyPreview ? ` — output preview: ${JSON.stringify(bodyPreview)}` : ""}`;
  } catch (e) {
    outcome = "failed";
    const msg = e instanceof Error ? e.message : String(e);
    rawText = msg;
    classification = classifyGhFailure(msg);
    detail = `(heuristic classification: ${classification}) ${msg}`;
  }
  const elapsed = Date.now() - start;
  console.log(`[${outcome.toUpperCase()}] in ${elapsed}ms — ${detail}`);
  // NOTES R4-VENDOR-CLI (round 2): only present on steps built via `ghApiWithRawTcpProbe` — a raw,
  // gh-auth-independent socket-connect attempt to api.github.com:443, echoed by the dispatch's own shell
  // script. Surfaced as its OWN line, distinct from whatever gh itself reported, since this is the signal
  // that actually answers "did the SANDBOX's network boundary bite," independent of gh's own auth gate.
  const tcpMatch = /RAW_TCP_CONNECT=(OK|DENIED)/.exec(rawText);
  if (tcpMatch) console.log(`        raw TCP connect to api.github.com:443 (bypassing gh's own auth gate entirely): ${tcpMatch[1]}`);

  // A `gh-vendor-dir-permission` failure means gh died at its own config/state/data/cache load — ALWAYS a
  // finding, on EVERY step, regardless of `tcpExpect` — checked first, unconditionally.
  if (outcome === "failed" && classification === "gh-vendor-dir-permission") {
    console.log(
      "        >>> FINDING: gh died at its own config/state/data/cache directory load (EPERM), before reaching whatever this step meant to test. This step's own verdict is INVALID this run — see NOTES R4-VENDOR-CLI's gh-vendor-scratch-dir redirect fix (src/adapters.ts#cliVendorScratchEnv). <<<",
    );
    return;
  }

  if (tcpExpect) {
    // The TCP marker is the PRIMARY verdict for these steps — gh's own auth outcome is secondary context.
    if (!tcpMatch) {
      console.log("        >>> HARNESS ERROR: no RAW_TCP_CONNECT marker found in this step's own output — the probe script itself may not have run (check for a HANG/timeout above). Cannot verdict the network boundary from this run. <<<");
    } else if (tcpExpect === "must-deny") {
      console.log(
        tcpMatch[1] === "DENIED"
          ? "        >>> PASS: raw TCP connect denied as expected — the sandbox's own network boundary bites a real socket attempt, independent of gh's own auth state <<<"
          : "        >>> REGRESSION: raw TCP connect MUST be denied (no connector granted) but it SUCCEEDED <<<",
      );
    } else {
      console.log(`        (informational — raw TCP connect: ${tcpMatch[1]}; read together with the paired step's own note above before concluding anything)`);
    }
    // Secondary context: gh's own auth outcome. A connector-holding step (a real token was expected) that
    // still reports `gh-auth-required` is its OWN, separate finding (the token never reached gh) — but for
    // a connector-less step (no token was ever expected), the identical classification is normal, not
    // remarkable.
    const tokenWasExpected = !!(agent.connectors && agent.connectors.length > 0);
    if (outcome === "failed" && classification === "gh-auth-required") {
      console.log(
        tokenWasExpected
          ? "        >>> FINDING: this step HOLDS a connector grant (GITHUB_TOKEN should have reached gh) but gh still reports no resolved token — check the 'member env diagnostic' line above; if GITHUB_TOKEN present=false, the export never reached this process (see this step pair's own header note for the exact var name required). <<<"
          : "        (gh itself refused locally — auth-required, expected for a no-connector step, not a finding; the raw TCP verdict above is what this step actually asserts)",
      );
    }
    return;
  }

  if (outcome === "failed" && classification === "gh-auth-required") {
    console.log(
      "        >>> FINDING: gh refused LOCALLY (no resolved token), before ever attempting a socket — this step's own verdict about the NETWORK boundary is INVALID from gh's own exit code/message alone. Check the 'member env diagnostic' line above: if GITHUB_TOKEN present=false for a step expected to hold one, the token never reached this dispatch. <<<",
    );
  } else if (expect === "must-succeed") {
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
      "gh itself exits NONZERO for 'not logged in' (confirmed against the real gh CLI's own documented behavior), so [FAILED] here is the EXPECTED, GOOD outcome — read the printed message and its heuristic classification, not the bare [SUCCEEDED]/[FAILED] label: a clean gh-authored message ('You are not logged into any GitHub hosts', classified 'other') is gh's own startup surviving the sandbox's filesystem confinement WITHOUT ever reaching the network. ROUND 1's own live run confirmed the ranked-first suspicion this note originally named: gh died reading its own DENIED config directory (kernel-confirmed `deny(1) file-read-data` on `~/.config/gh/config.yml`), classified 'gh-vendor-dir-permission' — the same EPERM-vs-ENOENT class NOTES R4-SANDBOX-FIX-9 found for git's .gitconfig. Fixed in src/adapters.ts (see cliVendorScratchEnv's own doc); this round re-runs the IDENTICAL step to confirm the fix. A recurrence of 'gh-vendor-dir-permission' this round means the fix is INCOMPLETE — gh probed a path this round's own evidence didn't cover — never assume it's fully closed just because it was diagnosed once. A HANG (this agent's own 30s timeout firing) would be the genuinely alarming outcome.",
    );

    await runGhDispatch(
      repo,
      pricing,
      "1b. gh --version — NO connector (secondary, weaker signal — see this script's own header on why 1a is the real proof)",
      mkGhAgent("gh-version-no-net", ["gh", "--version"], undefined),
      "informational",
      "A fast-exit flag — completing here does NOT independently prove gh's real startup path survives the sandbox (NOTES R4-SANDBOX-FIX-5's own weak-canary lesson); read alongside step 1a, never in place of it.",
    );

    // NOTES R4-VENDOR-CLI (round 2 live finding): `gh api /zen` alone cannot isolate a sandbox network
    // deny from gh's own local auth-gate refusal (gh requires a resolved token for EVERY `gh api` call,
    // even to this genuinely public/unauthenticated endpoint, entirely in userspace, before ever
    // attempting a socket) — round 2's own live run showed BOTH steps 2 and 3 failing identically with
    // gh's own auth-login prompt, zero differential, because no token reached EITHER dispatch.
    //
    // Checked and REJECTED: giving step 2 (the no-connector case) a token too, so auth is constant and
    // only the network grant varies. Structurally impossible under this codebase's real production model
    // — `env.ts#memberNetworkAllowed` and `buildMemberEnv`'s own connector-gated allowlist are the SAME
    // `grantedConnectors(repo, member).length > 0` condition, so there is no way for a member to hold a
    // connector's own secret while being network-denied. This is not an accident to route around: it is
    // exactly the goal's own "no connector declaring a remote endpoint" ↔ "network denied" coupling, by
    // design (env.ts's own doc: "there is no connector shape that names a purely-local capability").
    //
    // Fix, instead: `ghApiWithRawTcpProbe()` appends a raw, gh-auth-INDEPENDENT socket-connect attempt
    // (`RAW_TCP_CONNECT=OK`/`DENIED`, printed by `runGhDispatch` as its own line) to the SAME dispatch —
    // this is what actually answers "did the sandbox's own network boundary bite," regardless of whatever
    // gh's own business logic decides to do first. Step 2 stays connector-less (no token, network denied,
    // exactly the goal's own condition (a)) and is proven via RAW_TCP_CONNECT, never via gh's own exit
    // code (which will legitimately be `gh-auth-required`, an EXPECTED, orthogonal outcome now that gh's
    // own auth gate is understood, not a finding).
    //
    // REQUIRES a real credential exported in the Conductor's own shell before running this script, for
    // STEP 3 specifically (step 2 deliberately has none — see above):
    //   export GITHUB_TOKEN=<a real, minimally-scoped, read-only PAT>
    // Exactly `GITHUB_TOKEN` — the golden fixture's own `github` connector (`fixtures/golden/connectors/
    // github.md`) declares `env: [GITHUB_TOKEN]` only; `GH_TOKEN` (which gh itself checks with HIGHER
    // precedence) is NOT in that list and will NOT be forwarded even if set — this is a pre-existing
    // fixture detail, not something this goal's own scope changes speculatively. `diagnoseMemberEnv`
    // (printed by `runGhDispatch`, above each step's own result) shows directly whether `GITHUB_TOKEN`
    // reached each dispatch's own resolved env, so a missing-export mistake is visible immediately rather
    // than inferred from gh's own possibly-ambiguous error text.
    await runGhDispatch(
      repo,
      pricing,
      "2. gh api /zen + raw TCP probe — NO connector (memberNetworkAllowed === false, no token either — see this step's own note on why that's unavoidable and fine)",
      mkGhAgent("gh-api-no-net", ghApiWithRawTcpProbe(), undefined),
      "must-fail",
      "member env diagnostic above should show GITHUB_TOKEN present=false (no connector granted here at all, by design) — gh itself WILL refuse locally (classified 'gh-auth-required', EXPECTED and fine, not a finding) since it has no token; what this step actually asserts is the RAW_TCP_CONNECT line: MUST read DENIED, proving the sandbox's own network boundary bites a real socket attempt regardless of gh's own auth state. If RAW_TCP_CONNECT reads OK, THAT is the real regression to chase — never gh's own exit code alone.",
      "must-deny",
    );

    await runGhDispatch(
      repo,
      pricing,
      "3. gh api /zen + raw TCP probe — WITH the golden fixture's own 'github' connector (memberNetworkAllowed === true, and GITHUB_TOKEN should reach gh)",
      mkGhAgent("gh-api-with-net", ghApiWithRawTcpProbe(), ["github"]),
      "informational",
      "member env diagnostic above should show GITHUB_TOKEN present=true — if false, the export above didn't reach this process/shell, or was named GH_TOKEN instead (see this pair's own header note); a config/token mismatch here is a HARNESS setup issue, not a sandbox finding. With a real token AND real host connectivity, expect RAW_TCP_CONNECT=OK and a real gh success (the /zen quote itself). Read RAW_TCP_CONNECT specifically (never gh's own exit code alone) against step 2's own RAW_TCP_CONNECT: (2 DENIED, 3 OK) is the differential evidence that confirms the sandbox's own network boundary is real; (2 DENIED, 3 also DENIED) points at this host's own connectivity, not the sandbox; (2 OK) is itself the step-2 regression, independent of this step.",
      "informational",
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
  console.log("Every PASS/REGRESSION/FINDING verdict above is this run's own — read them in order. A");
  console.log("'gh-vendor-dir-permission' classification on ANY step means gh died at its own config/state/");
  console.log("data/cache load (round 1's own finding) — if it recurs after the shipped fix");
  console.log("(src/adapters.ts#cliVendorScratchEnv), that is a NEW finding, the fix is incomplete for some");
  console.log("path this round's evidence didn't cover. For steps 2/3 specifically, the verdict comes from the");
  console.log("'raw TCP connect' line, never gh's own exit code alone (round 2's own finding: gh's own auth");
  console.log("gate refuses any request without a token, unrelated to the sandbox) — read step 3's own TCP");
  console.log("result against step 2's as described in step 3's own note. Record this run's outcome in NOTES");
  console.log("R4-VENDOR-CLI, naming any FURTHER code change ONLY if a REGRESSION or NEW finding above demands");
  console.log("one, with the narrowest grant the printed evidence actually justifies.");
}

// Guarded so a future test file can import `classifyGhFailure` without triggering a full run — the same
// pattern `scripts/repro-r4-sandbox-fix10-hang.ts` already established (itself following
// `scripts/generate-cheatsheets.ts`'s own precedent).
if (import.meta.main) {
  await main();
}

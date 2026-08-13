// NOTES R4-SANDBOX-APPSERVER — a live macOS diagnostic for the "app-server architecture" vendor CLI
// failure: a `kind: cli` member wrapping `codex` (OpenAI's Codex CLI) died at spawn under a generated
// sandbox-exec profile with:
//
//   Error: failed to initialize in-process app-server client: Operation not permitted (os error 1)
//   (argv: ["/usr/bin/sandbox-exec", "-f", ".../profile.sb", "codex", "exec", "-", "-m", "gpt-5.5",
//           "--ignore-user-config", "--ignore-rules", "--ephemeral", "--skip-git-repo-check"])
//
// The Conductor's own elimination table (run by hand, before this script existed) already ruled out
// three things: (a) a bare `home: [".codex"]` connector fails EARLIER, at Volta's own shim resolution
// ("Volta error: Could not find executable \"codex\"") — a DIFFERENT failure, fixed separately in this
// same round (env.ts/validate.ts's own SUBSCRIPTION_HOME_SHIM_GAP, host-independent, already verified
// in this container); (b) dropping codex's own `--sandbox read-only` flag makes no difference — this is
// not nested vendor sandboxing triggered by that flag specifically; (c) removing `sandbox-exec` entirely
// (an unsandboxed scratch-HOME run) WORKS — codex returns a real completion. The generated profile is
// the one remaining variable.
//
// This container is Linux — it has NEVER been able to run `sandbox-exec` for real (every prior round in
// the R4-SANDBOX-FIX/R4-VENDOR-CLI sagas says so, and it remains true here). This script cannot produce
// a verdict by itself. What it CAN do, and what every live-host round in this project's history has
// always needed BEFORE proposing a profile change (see NOTES R4-SANDBOX-FIX-3 through -14's own
// "guessing at macOS sandbox behaviour wasted rounds" discipline): drive the real, unmodified production
// entry point, print `LEVARE_SANDBOX_DEBUG=1`'s own profile/argv/spawn-result dump, and run two DECISIVE,
// codex-INDEPENDENT probes that isolate which of this round's two ranked hypotheses (if either) is the
// actual cause — so a Conductor pastes back ONE run's output and this gets a real, named verdict instead
// of a third round of guessing.
//
// RANKED HYPOTHESES this script exists to distinguish (both are code-grounded, neither is confirmed):
//
//   H1 — grantedHomeTargets write-reallow asymmetry (src/sandbox.ts, FIXED this round, proactively).
//        Before this round, `buildSandboxExecProfile` re-allowed a granted `auth: subscription`
//        connector's OWN real home targets (e.g. `/Users/cas/.codex`) for READ only — never WRITE. A
//        member's scratch HOME (env.ts#scopeHomeForConnector) contains a SYMLINK at `.codex` pointing to
//        that real target; Seatbelt resolves a write THROUGH a symlink against the TARGET's own
//        kernel-resolved path, so any write beneath `~/.codex` (a session/rollout file, a lock, a local
//        IPC socket file — an ordinary thing for an "app-server" architecture to create at startup) was
//        silently denied despite `home:` declaring that exact path granted. STEP 2 below tests this
//        hypothesis DIRECTLY, without codex: it writes through the identical symlink shape a real
//        dispatch produces, under the identical generator, and reports pass/fail unconfounded by
//        anything codex-specific.
//   H2 — nested Seatbelt self-sandboxing. Some vendor CLIs implement their OWN command-execution
//        sandboxing on macOS by calling `sandbox_init()` (or spawning a nested `sandbox-exec`) on
//        themselves at startup — and Seatbelt has historically restricted a process already inside one
//        profile from applying a second. If codex's "app-server" does this as part of ITS OWN
//        initialization (not lazily, only when it first executes a shell command), a nested-sandboxing
//        denial would surface exactly as an early, generic EPERM. STEP 1 below tests this DIRECTLY,
//        without codex: a bare nested `sandbox-exec` invocation, decisive on any macOS host with
//        `sandbox-exec` at all.
//
// If STEP 2 fails (write still denied) → H1 is confirmed regardless of what STEP 1 shows, and this
// round's own sandbox.ts fix is incomplete (a live evidence gap to close, not a guess to make blind).
// If STEP 1 shows nested sandboxing is flatly refused by this macOS version → H2 is a live, structural
// wall no profile rule can fix — the answer becomes the declared escape hatch (NOTES R4-SANDBOX-APPSERVER
// also ships `sandbox: unsandboxed` this round — STEP 4 proves it works end to end regardless of which
// hypothesis holds). If NEITHER reproduces the failure characteristics, STEP 3's own real codex dispatch
// plus the kernel-log capture (STEP 5) is what names whatever THIRD thing this round's evidence didn't
// anticipate — evidence-first, exactly this project's own standing discipline for every round before
// this one.
//
// Run on the live macOS host: `bun run scripts/repro-r4-appserver-codex.ts`. Requires `sandbox-exec`
// (present on every stock macOS) for steps 1/2/5; step 3 additionally requires a real `codex` on PATH,
// logged in (`codex login`) — absent either, that one step says so and is skipped, never faked. This
// container has neither working `sandbox-exec` at all — sanity-checked here only insofar as the guards
// fire correctly and the file typechecks/imports cleanly; every real verdict below requires the live host.

import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { AdapterRunner, type NativeBoundary, type RemoteBoundary } from "../src/adapters.ts";
import { loadRepo } from "../src/repo.ts";
import { loadPricing } from "../src/pricing.ts";
import type { Repo } from "../src/repo.ts";
import type { Pricing } from "../src/pricing.ts";
import type { Agent, Connector } from "../src/types.ts";

const STEP_TIMEOUT_S = 30;

// A heuristic read on a codex/AdapterError failure message — module-scope, exported, pure string
// matching (no live host required), pinned by tests/repro-r4-appserver-codex.test.ts, mirroring
// scripts/repro-r4-vendor-cli-gh.ts#classifyGhFailure's own established shape and ordering discipline.
export function classifyCodexAppServerFailure(message: string): "app-server-init" | "nested-sandbox" | "shim-not-found" | "filesystem-permission" | "not-found" | "other" {
  const m = message.toLowerCase();
  // The EXACT reported failure this round's own evidence names — checked first and most specifically,
  // never folded into the generic "app server" bucket below, since a recurrence of this EXACT string
  // after a fix ships is itself the thing a Conductor needs to see named, not diagnosed from scratch.
  if (m.includes("failed to initialize in-process app-server client")) return "app-server-init";
  // A nested sandbox_init()/sandbox-exec denial from Seatbelt itself reads distinctly — Apple's own
  // wording for this class of refusal.
  const nestedSignals = ["sandbox_init", "already sandboxed", "operation not permitted while inside a sandbox", "cannot re-enter"];
  if (nestedSignals.some((s) => m.includes(s))) return "nested-sandbox";
  // The Volta/shim failure this round's own elimination table already isolated and fixed separately
  // (SUBSCRIPTION_HOME_SHIM_GAP) — named here too so a recurrence (e.g. the operator forgot to add
  // `.volta` to home:) is never misread as the app-server issue this script primarily investigates.
  const shimSignals = ["could not find executable", "volta error", "command not found"];
  if (shimSignals.some((s) => m.includes(s))) return "shim-not-found";
  if (m.includes("not found on path") || m.includes("command 'codex'")) return "not-found";
  if (m.includes("permission denied") || m.includes("eperm") || m.includes("operation not permitted")) return "filesystem-permission";
  return "other";
}

function mkCliAgent(name: string, command: string[], connectors: string[] | undefined, extra: Partial<Agent> = {}): Agent {
  return {
    name,
    kind: "cli",
    produces: ["review"],
    command,
    timeout: STEP_TIMEOUT_S,
    connectors,
    context_via: "stdin",
    context_artifacts: "inline",
    result: "Emits review prose on stdout, ending with a verdict line.",
    style: { avatar: "C" },
    body: "You are a critic. Say APPROVED or CHANGES REQUESTED.",
    ...extra,
  };
}

function mkCodexConnector(home: string[]): Connector {
  return { name: "codex-repro", kind: "cli", command: "codex", env: [], auth: "subscription", role: "model", effects: "read", gate: "proposal", plan: "ChatGPT subscription", home };
}

async function runDispatch(repo: Repo, pricing: Pricing, label: string, agent: Agent, note: string): Promise<{ outcome: "succeeded" | "failed"; classification?: ReturnType<typeof classifyCodexAppServerFailure>; detail: string }> {
  console.log("");
  console.log(`=== ${label} ===`);
  console.log(note);
  repo.agents.set(agent.name, agent);
  const nativeMock: NativeBoundary = { invoke: () => ({ doc: "unused" }) };
  const remoteMock: RemoteBoundary = { call: () => ({ doc: "unused" }) };
  const runner = new AdapterRunner(repo, { pricing, capabilities: [{ member: agent.name, kind: "review" }], native: nativeMock, remote: remoteMock });
  const start = Date.now();
  let outcome: "succeeded" | "failed";
  let classification: ReturnType<typeof classifyCodexAppServerFailure> | undefined;
  let detail: string;
  try {
    const { doc } = await runner.produceAsync(agent.name, "review", "repro", "storefront");
    outcome = "succeeded";
    const sandboxLine = /^sandbox: .+$/m.exec(doc)?.[0] ?? "sandbox: (not reported)";
    const reasonLine = /^sandbox_reason: .+$/m.exec(doc)?.[0];
    const bodyStart = doc.indexOf("\n---\n\n");
    const bodyPreview = bodyStart === -1 ? "" : doc.slice(bodyStart + 6).trim().slice(0, 300);
    detail = `${sandboxLine}${reasonLine ? ` · ${reasonLine}` : ""}${bodyPreview ? ` — output preview: ${JSON.stringify(bodyPreview)}` : ""}`;
  } catch (e) {
    outcome = "failed";
    const msg = e instanceof Error ? e.message : String(e);
    classification = classifyCodexAppServerFailure(msg);
    detail = `(heuristic classification: ${classification}) ${msg}`;
  }
  console.log(`[${outcome.toUpperCase()}] in ${Date.now() - start}ms — ${detail}`);
  return { outcome, classification, detail };
}

// STEP 1 — H2 (nested Seatbelt self-sandboxing), codex-INDEPENDENT and decisive on its own. A bare,
// maximally-permissive OUTER profile wrapping a bare, maximally-permissive INNER sandbox-exec call — if
// this fails, macOS's own kernel refuses nested sandboxing outright, full stop, regardless of what any
// profile this project generates says; no profile rule can fix that. If it SUCCEEDS, H2 is ruled out
// entirely as a general Seatbelt restriction (a MORE SPECIFIC nested-sandboxing shape codex's own
// architecture might use could still differ — named as a residual below — but the blanket "nesting is
// refused" theory is dead either way).
function probeNestedSandboxExec(sbx: string): { ok: boolean; detail: string } {
  const permissive = "(version 1)(allow default)";
  const outerProfile = mkdtempSync(join(tmpdir(), "levare-nested-sbx-outer-"));
  const innerProfile = mkdtempSync(join(tmpdir(), "levare-nested-sbx-inner-"));
  try {
    const outerPath = join(outerProfile, "outer.sb");
    const innerPath = join(innerProfile, "inner.sb");
    writeFileSync(outerPath, permissive);
    writeFileSync(innerPath, permissive);
    const argv = [sbx, "-f", outerPath, sbx, "-f", innerPath, "true"];
    console.log(`composed argv: ${JSON.stringify(argv)}`);
    const r = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
    const stderr = r.stderr ? new TextDecoder().decode(r.stderr) : "";
    const ok = r.exitCode === 0;
    return { ok, detail: `exitCode=${r.exitCode} signalCode=${r.signalCode ?? "null"}${stderr ? ` stderr=${JSON.stringify(stderr.trim())}` : ""}` };
  } finally {
    rmSync(outerProfile, { recursive: true, force: true });
    rmSync(innerProfile, { recursive: true, force: true });
  }
}

// STEP 2 — H1 (grantedHomeTargets write-reallow asymmetry), codex-INDEPENDENT and decisive on its own.
// Builds a REAL dispatch exercising the EXACT shape a subscription connector's `home:` produces: a
// synthetic "fake home" directory standing in for the operator's real HOME, a `.codex`-alike target
// directory inside it (standing in for `~/.codex`), a connector declaring `home: [".fake-vendor"]`, and
// a member whose command WRITES a file through its own scratch-HOME symlink into that granted target —
// exactly what an app-server writing a session/rollout/lock file at startup would do. Never invokes
// codex itself; this isolates the profile-generator asymmetry this round's own sandbox.ts fix targets.
async function probeGrantedHomeTargetWrite(repo: Repo, pricing: Pricing): Promise<{ outcome: "succeeded" | "failed"; detail: string }> {
  const fakeHome = mkdtempSync(join(tmpdir(), "levare-fake-home-"));
  const vendorDir = join(fakeHome, ".fake-vendor");
  mkdirSync(vendorDir, { recursive: true });
  writeFileSync(join(vendorDir, "session.json"), '{"token":"pre-existing"}\n');
  const priorHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    const connector = mkCodexConnector([".fake-vendor"]);
    repo.connectors.set(connector.name, connector);
    const agent = mkCliAgent("home-write-probe", ["sh", "-c", 'echo refreshed > "$HOME/.fake-vendor/session.json" && cat "$HOME/.fake-vendor/session.json"'], [connector.name]);
    const result = await runDispatch(
      repo,
      pricing,
      "2. Write-through-scratch-HOME-symlink probe (H1 — codex-independent)",
      agent,
      "Writes into a granted home: target through the scratch-HOME symlink, the same shape a vendor app-server refreshing its own session file would need. MUST succeed under this round's own sandbox.ts fix; a 'filesystem-permission' failure here — on a host with a genuinely working sandbox-exec — is DIRECT, codex-independent confirmation that H1 was the (or a) real cause, and that this round's fix is either not reaching this code path or incomplete.",
    );
    return { outcome: result.outcome, detail: result.detail };
  } finally {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    rmSync(fakeHome, { recursive: true, force: true });
  }
}

// STEP 3 — the real thing, if codex is actually on this host and logged in. Mirrors the Conductor's own
// elimination table exactly: `home: [".codex", ".volta"]` (the configuration that got PAST the Volta
// shim error to the app-server EPERM), the same flags named in the goal's own evidence.
async function probeRealCodexDispatch(repo: Repo, pricing: Pricing): Promise<void> {
  const codex = Bun.which("codex");
  if (!codex) {
    console.log("");
    console.log("=== 3. Real codex dispatch — SKIPPED ===");
    console.log("codex not found on PATH. Install/login (`codex login`) and re-run for the real reproduction. Steps 1/2/4/5 still ran above/below and stand on their own.");
    return;
  }
  console.log(`codex resolved to: ${codex}`);
  const connector = mkCodexConnector([".codex", ".volta"]);
  repo.connectors.set(connector.name, connector);
  const agent = mkCliAgent(
    "corvid-repro",
    ["codex", "exec", "-", "-m", "gpt-5.5", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--skip-git-repo-check"],
    [connector.name],
  );
  await runDispatch(
    repo,
    pricing,
    "3. Real codex dispatch — home: [\".codex\", \".volta\"] (the Conductor's own elimination-table configuration)",
    agent,
    "The exact reproduction named in this round's own evidence. A 'app-server-init' classification confirms the ORIGINAL bug still reproduces on this host — read STEP 2's own result above FIRST: if step 2 passed (write-through now works) but this step STILL fails identically, H1 is RULED OUT and the kernel-log capture below (step 5) is the only remaining source of evidence — do not guess a third hypothesis without it.",
  );
}

// STEP 4 — the declared escape hatch (this round's own fallback path), proven end to end: even if H1/H2
// are both wrong and a THIRD, unnamed cause is what's actually happening, `sandbox: unsandboxed` on the
// member definition must still produce a real, working artifact — the honest alternative this round
// ships regardless of whether the sandboxing question itself gets fully resolved this round.
async function probeDeclaredEscapeHatch(repo: Repo, pricing: Pricing): Promise<void> {
  const codex = Bun.which("codex");
  const command = codex ? ["codex", "exec", "-", "-m", "gpt-5.5", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--skip-git-repo-check"] : ["sh", "-c", "echo APPROVED"];
  const connector = mkCodexConnector([".codex", ".volta"]);
  repo.connectors.set(connector.name, connector);
  const agent = mkCliAgent("corvid-unsandboxed", command, [connector.name], {
    sandbox: "unsandboxed",
    sandbox_reason: "NOTES R4-SANDBOX-APPSERVER: codex's in-process app-server failed to initialize under the generated sandbox-exec profile (Operation not permitted) — declared unsandboxed pending a confirmed root cause from a live kernel-log capture.",
  });
  await runDispatch(
    repo,
    pricing,
    `4. Declared escape hatch (sandbox: unsandboxed)${codex ? "" : " — codex not on PATH, using a stand-in command"}`,
    agent,
    "Proves the fallback path works regardless of the sandbox investigation's own outcome: MUST succeed, and its own artifact must read 'sandbox: none' + a 'sandbox_reason:' line naming why, never silently.",
  );
}

// Best-effort macOS kernel-denial capture — mirrors scripts/repro-r4-vendor-cli-gh.ts#captureKernelDenials
// exactly, widened for this round's own two hypotheses: a nested-sandbox denial names 'Sandbox:'/'deny'
// alongside a `codex`/`sandbox-exec` process; an H1 write denial names 'file-write' alongside a
// `.codex`/`.fake-vendor` path. Never authoritative alone — an empty result may mean nothing was denied,
// or that `log show` needs elevated privileges for this subsystem on this host.
function captureKernelDenials(windowSeconds: number): void {
  console.log("");
  console.log("=== 5. Best-effort kernel-denial capture (macOS unified log) ===");
  if (process.platform !== "darwin") {
    console.log("(skipped — darwin-only, mirroring every other kernel-log capture in this saga)");
    return;
  }
  try {
    const r = Bun.spawnSync(["log", "show", "--last", `${windowSeconds}s`, "--style", "syslog", "--predicate", 'eventMessage contains "deny"'], { stdout: "pipe", stderr: "pipe", timeout: 8000 });
    const out = r.stdout ? new TextDecoder().decode(r.stdout) : "";
    const relevant = out
      .split("\n")
      .filter((l) => /codex|sandbox-exec|\.codex|\.fake-vendor|\.volta|app.?server/i.test(l))
      .slice(-60);
    if (relevant.length) {
      console.log(`${relevant.length} matching line(s) (last 60 shown) — READ THESE FIRST, before any hypothesis above:`);
      for (const l of relevant) console.log(`  ${l}`);
    } else {
      console.log("no lines mentioning codex/sandbox-exec/.codex/.volta/app-server found in the captured window — either nothing was denied (consistent with the WRITE probe passing and H1 being fixed), or this host's `log show` needs elevated privileges for the relevant subsystem (not distinguishable from here).");
    }
  } catch (e) {
    console.log(`(log show unavailable/failed: ${e instanceof Error ? e.message : String(e)} — not a finding about the sandbox itself, just about this capture)`);
  }
}

async function main() {
  if (process.platform !== "darwin") {
    console.log(
      `This harness investigates a macOS sandbox-exec failure (darwin-only) — running on '${process.platform}' would only prove what this container already knows (no working sandbox-exec here, mirroring every other script in this saga). Degrading honestly: skipping every sandboxed step below. Exiting.`,
    );
    return;
  }
  const sbx = Bun.which("sandbox-exec") ?? (existsSync("/usr/bin/sandbox-exec") ? "/usr/bin/sandbox-exec" : null);
  if (!sbx) {
    console.log("sandbox-exec not found — cannot investigate anything real here. Degrading honestly: exiting rather than passing vacuously.");
    return;
  }
  console.log(`sandbox-exec: ${sbx}`);
  console.log(`operator HOME: ${homedir()}`);

  const repo = loadRepo("fixtures/golden");
  const pricing = loadPricing("fixtures/golden");
  const priorDebug = process.env.LEVARE_SANDBOX_DEBUG;
  process.env.LEVARE_SANDBOX_DEBUG = "1";

  try {
    console.log("");
    console.log("=== 1. Nested sandbox-exec probe (H2 — codex-independent) ===");
    const nested = probeNestedSandboxExec(sbx);
    console.log(`[${nested.ok ? "SUCCEEDED" : "FAILED"}] ${nested.detail}`);
    console.log(
      nested.ok
        ? "        >>> H2 (blanket nested-sandboxing refusal) is RULED OUT on this host — Seatbelt permits a nested profile in general. A codex-specific nested-sandboxing shape could still differ (named as a residual in NOTES); not ruled out by this alone. <<<"
        : "        >>> H2 IS LIVE on this host: nesting a sandbox-exec profile inside another is refused outright. If codex's own app-server calls sandbox_init()/sandbox-exec as part of ITS startup, this is a structural wall — no profile rule in this project can fix it. The declared escape hatch (step 4) is the answer, not a further profile change. <<<",
    );

    const writeProbe = await probeGrantedHomeTargetWrite(repo, pricing);
    console.log(
      writeProbe.outcome === "succeeded"
        ? "        >>> H1 (write-reallow asymmetry) is CLOSED by this round's own sandbox.ts fix, confirmed live. <<<"
        : "        >>> H1 IS LIVE on this host even after this round's own fix — the fix is not reaching this code path, or is incomplete. Re-check LEVARE_SANDBOX_DEBUG's own profile dump above for a missing '(allow file-write* (subpath \".fake-vendor\"))' line before proposing a further change. <<<",
    );

    await probeRealCodexDispatch(repo, pricing);
    await probeDeclaredEscapeHatch(repo, pricing);
  } finally {
    if (priorDebug === undefined) delete process.env.LEVARE_SANDBOX_DEBUG;
    else process.env.LEVARE_SANDBOX_DEBUG = priorDebug;
  }

  captureKernelDenials(120);

  console.log("");
  console.log("=== Summary ===");
  console.log("Read the verdicts above in order: step 1 (H2) and step 2 (H1) are independently decisive and");
  console.log("need no codex install; step 3 is the real reproduction, read against steps 1/2's own verdicts;");
  console.log("step 4 proves the fallback works regardless; step 5's kernel log is the tie-breaker if steps");
  console.log("1-3 leave the cause ambiguous. Record this run's FULL output in NOTES R4-SANDBOX-APPSERVER —");
  console.log("naming which hypothesis the evidence confirms (or a third one the kernel log names) — before");
  console.log("proposing any further src/sandbox.ts change. Never guess a fix from this summary alone.");
}

if (import.meta.main) {
  await main();
}

// NOTES R4-SANDBOX-TLS — isolating which mach service a REAL TLS handshake needs under the generated
// sandbox-exec profile, codex-INDEPENDENT, per the Conductor's own live evidence:
//
//   codex_api::endpoint::responses_websocket: failed to connect to websocket:
//   IO error: invalid peer certificate: UnknownIssuer, url: wss://chatgpt.com/backend-api/codex/responses
//   warning: Falling back from WebSockets to HTTPS transport.
//   stream disconnected before completion: invalid peer certificate: UnknownIssuer
//
// captured with the write-reallow fix from NOTES R4-SANDBOX-APPSERVER installed (macOS 26.5.2 arm64,
// `sandbox: full`) — codex's app-server now initializes and reaches the network (the fault this earlier
// round investigated is closed), but certificate validation itself fails identically over BOTH
// transports. The SAME live run's kernel log showed five denied mach-lookups/ioctls alongside the
// failure:
//
//   Sandbox: codex(92712) deny(1) mach-lookup com.apple.SystemConfiguration.configd
//   Sandbox: codex(92712) deny(1) mach-lookup com.apple.system.opendirectoryd.libinfo
//   Sandbox: codex(92712) deny(1) mach-lookup com.apple.system.notification_center
//   Sandbox: codex(92712) deny(1) mach-lookup com.apple.logd
//   Sandbox: codex(92712) deny(1) mach-lookup com.apple.diagnosticd
//   Sandbox: codex(92712) deny(1) file-ioctl path:/dev/dtracehelper
//
// These were previously catalogued as benign, ambient denials every sandboxed macOS process tolerates
// (NOTES R4-SANDBOX-FIX-9/-FIX-10's own `sysctl-read`/`dtracehelper`/opendirectoryd findings — the
// LATTER two were explicitly hand-ACQUITTED there, but for a DIFFERENT consumer: a `git add`/`git
// commit` chain, never a TLS trust evaluation). `com.apple.trustd.agent` (NOTES R4-VENDOR-CLI's own
// fix, already shipped, network-gated) is NOT in this list — it is already granted whenever
// `policy.allowNetwork` is true, and that grant is what let `gh` (Go) complete a real HTTPS request in
// round 4 of that investigation. codex still fails with a DIFFERENT symptom (`UnknownIssuer` — a chain-
// building failure, not `gh`'s reported `x509: failed to verify certificate` from an OSStatus code) even
// with that same grant in place. Per this saga's own standing discipline ("guessing at macOS sandbox
// behaviour wasted rounds" — R4-SANDBOX-FIX-3's own 14-profile bisection is the canonical cost of
// guessing), NONE of the five denials above is granted by this round on the strength of merely
// co-occurring with the failure — they were observed in the SAME kernel-log window as codex's own
// failure, not independently shown to be its CAUSE, and two of them (opendirectoryd's own services) were
// already acquitted once for a different consumer in this exact profile.
//
// What this script builds instead: a bare, codex-INDEPENDENT TLS handshake — `curl` against a public
// HTTPS host, under the REAL generated profile (`AdapterRunner.produceAsync`, never a hand-rolled spawn
// — the same "drive the real, unmodified production entry point" discipline every prior live-host round
// in this saga has used), decisive on its own, exactly the shape NOTES R4-SANDBOX-APPSERVER's own H1
// (step 2, the write-through probe)/H2 (step 1, the nested-sandbox probe) established: no vendor CLI,
// no `codex` install required, a real Conductor can run this even on a host without `codex` on PATH.
//
// ANY public HTTPS host with an ordinary, publicly-trusted certificate chain is equivalent for this
// question — `UnknownIssuer` is a chain-BUILDING failure (the verifier cannot find a trusted root/
// intermediate), not something specific to `chatgpt.com`'s own certificate, so this script does not
// dispatch against that domain at all: `example.com` (IANA-reserved, stable, no auth, no rate limit) is
// the target, mirroring this saga's own precedent of picking a boring, always-available endpoint over
// the domain actually named in a bug report (NOTES R4-VENDOR-CLI's own `/zen` choice for `gh`).
//
// HONEST CAVEAT, named rather than assumed: whether `curl` on the live host actually exercises the SAME
// platform-trust-store code path codex's own Rust TLS stack does is NOT assumed here — `curl -V`'s own
// "SSL backend" line is captured and printed by every step below (stderr, so it survives a failed
// dispatch too), because Apple's own system `curl` has changed SSL backends across macOS releases
// (SecureTransport historically, LibreSSL more recently) and this script has no way to know which one a
// given live host reports without asking it directly. A PASS here is only informative about the
// platform-trust-store hypothesis if that line names a backend that itself defers to Security.framework
// — read it before concluding anything from a bare curl success. `RAW_TCP_CONNECT` (mirroring
// `scripts/repro-r4-vendor-cli-gh.ts#ghApiWithRawTcpProbe`'s own established marker) is what actually
// disambiguates "the raw socket was denied" from "the socket connected and the SSL/cert layer is what
// failed" — needed because curl's own exit code for a certificate failure is backend-dependent (LibreSSL
// reports exit 60 with a specific "unable to get local issuer certificate" message; SecureTransport has
// historically reported the coarser exit 35 "SSL connect error" for the identical class of failure) and
// is never, by itself, read as the primary verdict here.
//
// Never grants a new mach service on the strength of this script's own live run alone: a FAILURE here
// (TCP connected, TLS/cert layer denied) is what NAMES the next candidate — via the kernel-log capture
// (step 3) — never a preemptive addition of any of the five services listed above.
//
// This container is Linux — it has never once run `sandbox-exec` for real (every prior round in this
// saga says the identical thing, and this dev container's own `bwrap`/`unshare` remain non-functional
// too, sanity-checked directly: both refuse to create a namespace here). Run on the live macOS host:
// `bun run scripts/repro-r4-sandbox-tls-handshake.ts`. Requires `sandbox-exec` (present on every stock
// macOS) and `curl` (a system binary, always present) — no vendor CLI, no credential, no login required.

import { existsSync } from "node:fs";
import { AdapterRunner, type NativeBoundary, type RemoteBoundary } from "../src/adapters.ts";
import { loadRepo } from "../src/repo.ts";
import { loadPricing } from "../src/pricing.ts";
import type { Repo } from "../src/repo.ts";
import type { Pricing } from "../src/pricing.ts";
import type { Agent, Connector } from "../src/types.ts";

const STEP_TIMEOUT_S = 30;
const TLS_PROBE_HOST = "example.com";

// A heuristic read on a failed TLS-probe dispatch's own message — pure string matching, module-scope,
// exported so `tests/repro-r4-sandbox-tls-handshake.test.ts` can pin it with no live host required,
// mirroring `classifyGhFailure`/`classifyCodexAppServerFailure`'s own established shape. NEVER the
// primary verdict on its own for the network-granted step below — see `RAW_TCP_CONNECT`'s own doc in
// this file's header for why a raw, backend-independent marker is what actually disambiguates a network
// deny from a certificate/trust failure; this classifier is diagnostic color for a human reader, the
// same demoted role `classifyGhFailure`'s own tls-trust bucket plays alongside `gh`'s real outcome.
export function classifyTlsHandshakeFailure(message: string): "tls-trust" | "network-deny" | "not-found" | "other" {
  const m = message.toLowerCase();
  // Checked first and most specifically — a chain-building/trust failure is the exact class this round
  // exists to isolate, and must never fall through to the generic network bucket below. Includes both
  // LibreSSL's own message shape (exit 60/77, "unable to get local issuer certificate") AND
  // SecureTransport's coarser signal (exit 35, "ssl connect error" — historically the SAME failure class
  // on that backend, per this file's own header caveat) so neither backend's own wording hides a real
  // finding behind the generic bucket.
  const tlsTrustSignals = [
    "unable to get local issuer certificate",
    "ssl certificate problem",
    "certificate is not trusted",
    "certificate signed by unknown authority",
    "unknownissuer",
    "peer certificate",
    "sec_error",
    "osstatus",
    "sectrustevaluate",
    "curl: (60)",
    "curl: (77)",
    "curl: (35)",
    "ssl connect error",
  ];
  if (tlsTrustSignals.some((s) => m.includes(s))) return "tls-trust";
  const networkSignals = ["curl: (6)", "curl: (7)", "could not resolve host", "couldn't connect to server", "network is unreachable", "no route to host", "connection refused", "connection reset", "operation not permitted"];
  if (networkSignals.some((s) => m.includes(s))) return "network-deny";
  if (m.includes("command not found") || m.includes("not found on path") || m.includes("command 'curl'")) return "not-found";
  return "other";
}

function mkTlsProbeConnector(): Connector {
  // NOTES R4-SANDBOX (Ruling 2)/env.ts#memberNetworkAllowed: "holds at least one granted connector" IS
  // "network allowed" — there is no separate field for a purely-local capability, so this connector
  // exists ONLY to make that true, deliberately declaring no real credential (`auth: subscription` with
  // no `env:`, the one auth mode that requires none) and no `home:` — keeping this probe orthogonal to
  // NOTES R4-SANDBOX-APPSERVER's own `grantedHomeTargets` write-reallow investigation, never conflating
  // the two.
  return {
    name: "tls-probe-net",
    kind: "cli",
    command: "curl",
    env: [],
    auth: "subscription",
    role: "tool",
    effects: "read",
    gate: "proposal",
    plan: "no real credential — declared solely to grant network reach for NOTES R4-SANDBOX-TLS's probe (memberNetworkAllowed checks connector presence only)",
  };
}

function mkTlsProbeAgent(name: string, connectors: string[] | undefined): Agent {
  return {
    name,
    kind: "cli",
    produces: ["review"],
    command: ["sh", "-c", tlsProbeScript()],
    timeout: STEP_TIMEOUT_S,
    connectors,
    context_via: "stdin",
    context_artifacts: "inline",
    result: "Emits the curl SSL backend, the raw TCP probe marker, and the HTTP status on success.",
    style: { avatar: "T" },
    body: "You are a critic. Say APPROVED or CHANGES REQUESTED.",
  };
}

// Prints the curl SSL backend to STDERR (survives a failed dispatch — `diagnoseCliFailure` reads stderr
// first, see adapters.ts) BEFORE attempting the handshake, then runs a raw, curl-INDEPENDENT TCP connect
// probe (mirroring `scripts/repro-r4-vendor-cli-gh.ts#ghApiWithRawTcpProbe` exactly — same marker name,
// same bash `/dev/tcp` mechanism, same "echoed to both stdout and stderr" discipline), then the real
// curl request itself — `-sS` so an error is still reported despite `-s` silencing the progress meter.
function tlsProbeScript(): string {
  const host = TLS_PROBE_HOST;
  return [
    'printf "CURL_BACKEND: %s\\n" "$(curl -V | head -1)" >&2',
    `if (exec 3<>/dev/tcp/${host}/443) 2>/dev/null; then tcp=OK; else tcp=DENIED; fi`,
    'echo "RAW_TCP_CONNECT=$tcp"',
    'echo "RAW_TCP_CONNECT=$tcp" >&2',
    `curl -sS -o /dev/null -w 'HTTP_STATUS=%{http_code}\\n' https://${host}/`,
  ].join("; ");
}

// NOTES DOCS-WALKTHROUGH-1 (Finding 4): the EXACT harness bug this dispatch shape avoids — a synthetic
// unit/team that don't exist on disk makes `context.ts#assembleContext` throw, and
// `adapters.ts#AdapterRunner#assemble` silently swallows that into an EMPTY context string, so a script
// built the wrong way pipes zero bytes to stdin and calls whatever the vendor complains about a "sandbox
// finding" it never was. `checkout-flow`/`storefront` is a REAL unit under `fixtures/golden/work/`;
// `kestrel` is the one real team whose `flow:` names a `review` label at all — grafted onto its
// `members:` in memory only, mirroring `scripts/repro-r4-appserver-codex.ts#runDispatch` exactly (this
// script's own `sh`-based probe never itself reads stdin, but a broken context assembly is a signal this
// investigation must not let slip past unnoticed a second time).
const REPRO_PROJECT = "storefront";
const REPRO_UNIT = "checkout-flow";
const CONTEXT_TEAM = "kestrel";

interface DispatchResult {
  outcome: "succeeded" | "failed";
  classification?: ReturnType<typeof classifyTlsHandshakeFailure>;
  detail: string;
  rawText: string;
}

async function runDispatch(repo: Repo, pricing: Pricing, label: string, agent: Agent, note: string): Promise<DispatchResult> {
  console.log("");
  console.log(`=== ${label} ===`);
  console.log(note);
  repo.agents.set(agent.name, agent);
  const team = repo.teams.get(CONTEXT_TEAM);
  if (team && !team.members.includes(agent.name)) team.members.push(agent.name);
  const nativeMock: NativeBoundary = { invoke: () => ({ doc: "unused" }) };
  const remoteMock: RemoteBoundary = { call: () => ({ doc: "unused" }) };
  const runner = new AdapterRunner(repo, { pricing, capabilities: [{ member: agent.name, kind: "review" }], native: nativeMock, remote: remoteMock });
  const start = Date.now();
  let outcome: "succeeded" | "failed";
  let classification: ReturnType<typeof classifyTlsHandshakeFailure> | undefined;
  let detail: string;
  let rawText: string;
  try {
    const { doc } = await runner.produceAsync(agent.name, "review", REPRO_UNIT, REPRO_PROJECT);
    outcome = "succeeded";
    rawText = doc;
    const sandboxLine = /^sandbox: .+$/m.exec(doc)?.[0] ?? "sandbox: (not reported)";
    const bodyStart = doc.indexOf("\n---\n\n");
    const bodyPreview = bodyStart === -1 ? "" : doc.slice(bodyStart + 6).trim().slice(0, 500);
    detail = `${sandboxLine}${bodyPreview ? ` — output preview: ${JSON.stringify(bodyPreview)}` : ""}`;
  } catch (e) {
    outcome = "failed";
    const msg = e instanceof Error ? e.message : String(e);
    rawText = msg;
    classification = classifyTlsHandshakeFailure(msg);
    detail = `(heuristic classification: ${classification}) ${msg}`;
  }
  console.log(`[${outcome.toUpperCase()}] in ${Date.now() - start}ms — ${detail}`);
  const tcpMatch = /RAW_TCP_CONNECT=(OK|DENIED)/.exec(rawText);
  if (tcpMatch) console.log(`        raw TCP connect to ${TLS_PROBE_HOST}:443 (bypassing curl's own SSL layer entirely): ${tcpMatch[1]}`);
  return { outcome, classification, detail, rawText };
}

// STEP 1 — deny-direction sanity check (no connector). This is a harness self-test, not this round's own
// primary question (that question is the GRANT direction, below): if the raw TCP probe doesn't read
// DENIED here, something about this script's OWN dispatch shape is broken (mirrors
// `scripts/repro-r4-vendor-cli-gh.ts`'s own step 2/4 "recheck an existing seal" discipline) and step 2's
// own result cannot be trusted either.
async function stepDenyDirection(repo: Repo, pricing: Pricing): Promise<DispatchResult> {
  const agent = mkTlsProbeAgent("tls-probe-no-net", undefined);
  const result = await runDispatch(repo, pricing, "1. Deny-direction sanity check — NO connector (harness self-test)", agent, "memberNetworkAllowed(repo, member) === false — RAW_TCP_CONNECT MUST read DENIED. If it doesn't, this script's own dispatch shape is broken and step 2's result below cannot be trusted; diagnose THIS step first.");
  const tcpMatch = /RAW_TCP_CONNECT=(OK|DENIED)/.exec(result.rawText);
  if (!tcpMatch) {
    console.log("        >>> HARNESS ERROR: no RAW_TCP_CONNECT marker found — the probe script itself may not have run. Cannot verdict anything from this run. <<<");
  } else if (tcpMatch[1] === "DENIED") {
    console.log("        >>> PASS: raw TCP connect denied as expected — this harness's own dispatch shape is sound. <<<");
  } else {
    console.log("        >>> HARNESS ERROR: raw TCP connect SUCCEEDED with no connector granted — this is a REGRESSION in the network deny direction, unrelated to this round's own TLS question, but it means step 2 below cannot be read as a clean grant-direction test either. <<<");
  }
  return result;
}

// STEP 2 — the decisive, codex-INDEPENDENT probe (this round's own primary question). Network-granted via
// `tls-probe-net` (no home target, no vendor auth — orthogonal to NOTES R4-SANDBOX-APPSERVER's own H1).
// `com.apple.trustd.agent` is already granted here (network-gated, shipped in NOTES R4-VENDOR-CLI) —
// this step answers whether that grant alone is sufficient for a REAL chain-building TLS handshake, with
// no codex involved at all.
async function stepGrantDirection(repo: Repo, pricing: Pricing): Promise<DispatchResult> {
  const connector = mkTlsProbeConnector();
  repo.connectors.set(connector.name, connector);
  const agent = mkTlsProbeAgent("tls-probe-with-net", [connector.name]);
  const result = await runDispatch(
    repo,
    pricing,
    `2. Network-granted TLS handshake to https://${TLS_PROBE_HOST}/ — WITH 'tls-probe-net' (the decisive, codex-independent probe)`,
    agent,
    "memberNetworkAllowed(repo, member) === true, so com.apple.trustd.agent + (allow network*) are both already in the generated profile (NOTES R4-VENDOR-CLI). Read CURL_BACKEND (printed above, stderr) FIRST — a PASS is only informative about codex's own platform-trust-store hypothesis if that line names a Security.framework-backed backend (see this file's own header caveat). curl's own outcome is the PRIMARY verdict here (mirrors scripts/repro-r4-vendor-cli-gh.ts's own 'grant-via-gh' step); RAW_TCP_CONNECT is corroboration distinguishing a certificate/trust-layer failure (TCP=OK, curl still fails) from a raw network deny (TCP=DENIED) — curl's own exit code for a cert failure is backend-dependent and must never be read alone.",
  );
  const tcpMatch = /RAW_TCP_CONNECT=(OK|DENIED)/.exec(result.rawText);
  if (result.outcome === "succeeded") {
    console.log(
      "        >>> PASS: a bare, codex-independent TLS client completed a real handshake and HTTP request under this exact generated profile. The sandbox's own network+trustd.agent grant is sufficient for AT LEAST this backend/host. If codex still fails identically on this same host, read the CURL_BACKEND line above first — if curl is NOT Security.framework-backed here, this PASS says nothing about codex's own platform-trust-store path; if it IS, the cause is something about codex's own TLS stack specifically (a further, codex-specific mach-lookup, an OCSP/CRL fetch its own library performs that curl's doesn't, or something outside this profile's own scope entirely) — NOT a general sandbox gap this script's own evidence would have caught. <<<",
    );
  } else if (tcpMatch?.[1] === "OK") {
    console.log(
      "        >>> SANDBOX-TLS-IMPLICATED: raw TCP connected cleanly but the SSL/certificate layer still failed under this profile — a general sandbox gap, reproduced with NO codex involved at all. Read the kernel-log capture below (step 3) to NAME the exact mach-lookup denial at the moment of this failure — do not guess which of the five ambient denials this file's own header lists is responsible; only the live kernel log answers that. <<<",
    );
  } else if (tcpMatch?.[1] === "DENIED") {
    console.log("        >>> REGRESSION: this step HOLDS a network-granting connector but the raw TCP connect was DENIED — the network grant itself is not reaching, unrelated to certificate validation. Check LEVARE_SANDBOX_DEBUG's own profile dump above for '(allow network*)' before looking any further at TLS. <<<");
  } else {
    console.log("        >>> HARNESS ERROR: no RAW_TCP_CONNECT marker found in this step's own output — cannot verdict the TLS layer specifically from this run. <<<");
  }
  return result;
}

// Best-effort macOS kernel-denial capture — mirrors `scripts/repro-r4-appserver-codex.ts#
// captureKernelDenials`/`scripts/repro-r4-vendor-cli-gh.ts#captureKernelDenials` exactly, widened for
// this round's own five named candidates (never assumed guilty — only reported if this run's OWN kernel
// log actually shows one denied in this window) plus curl/trustd/mach-lookup generally, so a FURTHER,
// unnamed service surfaces too rather than only the ones this file's header already lists.
function captureKernelDenials(windowSeconds: number): void {
  console.log("");
  console.log("=== 3. Best-effort kernel-denial capture (macOS unified log) ===");
  if (process.platform !== "darwin") {
    console.log("(skipped — darwin-only, mirroring every other kernel-log capture in this saga)");
    return;
  }
  try {
    const r = Bun.spawnSync(["log", "show", "--last", `${windowSeconds}s`, "--style", "syslog", "--predicate", 'eventMessage contains "deny"'], { stdout: "pipe", stderr: "pipe", timeout: 8000 });
    const out = r.stdout ? new TextDecoder().decode(r.stdout) : "";
    const relevant = out
      .split("\n")
      .filter((l) => /curl|trustd|mach-lookup|configd|opendirectoryd|notification_center|\blogd\b|diagnosticd|dtracehelper|sandbox-exec/i.test(l))
      .slice(-80);
    if (relevant.length) {
      console.log(`${relevant.length} matching line(s) (last 80 shown) — READ THESE FIRST, before naming any candidate:`);
      for (const l of relevant) console.log(`  ${l}`);
    } else {
      console.log("no matching lines found in the captured window — either nothing was denied (consistent with step 2 PASSing), or this host's `log show` needs elevated privileges for the relevant subsystem (not distinguishable from here).");
    }
  } catch (e) {
    console.log(`(log show unavailable/failed: ${e instanceof Error ? e.message : String(e)} — not a finding about the sandbox itself, just about this capture)`);
  }
}

async function main() {
  if (process.platform !== "darwin") {
    console.log(`This harness investigates a macOS sandbox-exec TLS-handshake failure (darwin-only) — running on '${process.platform}' would only prove what this container already knows (no working sandbox-exec here, mirroring every other script in this saga). Degrading honestly: skipping every sandboxed step below. Exiting.`);
    return;
  }
  const sbx = Bun.which("sandbox-exec") ?? (existsSync("/usr/bin/sandbox-exec") ? "/usr/bin/sandbox-exec" : null);
  if (!sbx) {
    console.log("sandbox-exec not found — cannot investigate anything real here. Degrading honestly: exiting rather than passing vacuously.");
    return;
  }
  const curl = Bun.which("curl") ?? (existsSync("/usr/bin/curl") ? "/usr/bin/curl" : null);
  if (!curl) {
    console.log("curl not found — cannot run this round's own probe on this host. Degrading honestly: this is a named residual, not a pass. Exiting.");
    return;
  }
  console.log(`sandbox-exec: ${sbx}`);
  console.log(`curl: ${curl}`);
  console.log(`probe target: https://${TLS_PROBE_HOST}/`);

  const repo = loadRepo("fixtures/golden");
  const pricing = loadPricing("fixtures/golden");
  const priorDebug = process.env.LEVARE_SANDBOX_DEBUG;
  process.env.LEVARE_SANDBOX_DEBUG = "1";

  try {
    await stepDenyDirection(repo, pricing);
    await stepGrantDirection(repo, pricing);
  } finally {
    if (priorDebug === undefined) delete process.env.LEVARE_SANDBOX_DEBUG;
    else process.env.LEVARE_SANDBOX_DEBUG = priorDebug;
  }

  captureKernelDenials(120);

  console.log("");
  console.log("=== Summary ===");
  console.log("Step 1 is a harness self-test, never this round's own verdict. Step 2's own PASS/SANDBOX-TLS-");
  console.log("IMPLICATED/REGRESSION line is the real answer — read it alongside CURL_BACKEND (does this host's");
  console.log("curl actually exercise the platform trust store at all?) and, on SANDBOX-TLS-IMPLICATED, the");
  console.log("kernel-log capture above for the EXACT mach-lookup denied at the moment of failure. Record this");
  console.log("run's FULL output in NOTES R4-SANDBOX-TLS — naming the exact service the kernel log shows, if");
  console.log("any — before adding ANY new grant to src/sandbox.ts. A PASS here with codex still failing");
  console.log("identically on the SAME host is itself a real, useful finding: it says the gap is NOT a general");
  console.log("sandbox/TLS problem, and points back at codex's own TLS stack instead.");
}

if (import.meta.main) {
  await main();
}

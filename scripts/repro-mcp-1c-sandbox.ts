// NOTES MCP-1C — the live-host validation harness for PRD Amendment 3 ruling R3: the spawned stdio MCP
// server process now goes through the SAME R4 sandbox wrap a `kind: cli` member's spawn does
// (adapters.ts#createAsyncStdioRemoteBoundary, sandbox.ts#wrapForSandbox/buildRemoteSandboxPolicy — no
// second, looser profile). This script follows the SAME method NOTES R4-VENDOR-CLI established for `gh`
// (scripts/repro-r4-vendor-cli-gh.ts): drive the real, unmodified production entry point
// (`AdapterRunner.produceAsync`, never a hand-rolled spawn), capture `LEVARE_SANDBOX_DEBUG=1`'s own
// existing debug plumbing (profile text, composed argv, cwd, raw result — printed directly by
// production code, never re-derived here), and diagnose any failure from that evidence before proposing
// a fix — the narrowest grant the evidence justifies, never a convenience widening, never guessed ahead
// of evidence.
//
// FOUR steps:
//   1. vendor-echo — a REAL bunx/npx-spawned `@modelcontextprotocol/server-everything` (the same
//      reference server tests/mcp-handshake.test.ts and tests/mcp-remote-e2e.test.ts already prove a
//      real handshake/dispatch against), tool `echo`, no `home:` declared. This is the step that would
//      surface a real Node/npm vendor finding (the config-EPERM/trustd class NOTES R4-VENDOR-CLI found
//      for `gh`) — a bunx-spawned Node MCP server does more at startup than the member stub ever did (npm
//      cache, Node's own config dirs, its own state dirs). Informational: gated on bunx/npx + registry
//      access being reachable at all (mirrors tests/mcp-remote-e2e.test.ts's own `tryLiveMcp` gate); a
//      HANG or crash here is exactly the class of finding this step exists to surface, diagnosed from the
//      printed profile/argv/raw-result evidence, never guessed.
//   2. decoy-deny — the fake, deterministic MCP server fixture (fixtures/stubs/fake-mcp-server.ts,
//      extended for MCP-1C with a `read-home-file` tool: `readFileSync(join(process.env.HOME, dotpath))`
//      run INSIDE the spawned process). An MCP tool call has no shell, so unlike the gh harness's own
//      bare `cat <decoy>` step, this is the MCP-shaped equivalent: a connector declaring NO `home:`,
//      asked to read a decoy file planted directly under the operator's own real $HOME. MUST fail on a
//      working sandbox (full/fs-only) — the FIX-3/FIX-4 operator-home decoy proof, reached through JSON-RPC
//      instead of a shell command.
//   3. home:-grant — the SAME decoy file, the SAME tool, but the connector NOW declares
//      `home: [<the decoy's own parent dotpath>]` — ruling R3's own centerpiece: the connector's existing
//      `home:` mechanism (env.ts#scopeHomeForConnector, generalized from the subscription-cli-only
//      mechanism CAP-B built) is the one, auditable, per-connector way to declare a specific real-HOME
//      path a server legitimately needs, never a blanket exception. MUST succeed on a working sandbox.
//   4. studio-root-read — the fake server's `read-abs-file` tool, given an absolute path under the
//      studio root (`repo.root`). Mirrors cli's own "excluding the studio root broke most of this repo's
//      own real-spawn fixtures" finding (NOTES R4-SANDBOX-FIX) — proves the read-only grant applies to a
//      spawned MCP server exactly as it already does to a `kind: cli` member.
//
// A best-effort kernel-denial capture (macOS `log show`, mirroring scripts/repro-r4-vendor-cli-gh.ts's
// own step 6) runs after the above.
//
// Degrades HONESTLY in-container: this dev container has no working `bwrap`/`unshare`/`sandbox-exec`
// (confirmed directly by sandbox.test.ts's own "this actual host, right now" test) — `detectSandbox()`
// reports `none` here, so steps 2/3's own must-fail/must-succeed assertions are reported as SKIPPED
// (never a vacuous pass) while the dispatches themselves still run end-to-end, proving the WIRING (the
// scratch cwd, the connector env, the argv passthrough) works even where nothing actually confines it.
// Step 1 and step 4 still run for real in-container (network/registry permitting) since neither depends
// on a working OS primitive to be meaningful. Hand-runnable on macOS: `bun run scripts/repro-mcp-1c-sandbox.ts`.
//
// The live-host leg (a REAL macOS run: real MCP server sandboxed, decoy denies, any vendor findings
// diagnosed evidence-first) is the Conductor's OWN manual gate after hand-back — this script is the
// repeatable harness that run drives, not a claim that this container's own run already proves it.

import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AdapterRunner, type NativeBoundary, type RemoteBoundary, createAsyncStdioRemoteBoundary } from "../src/adapters.ts";
import { loadRepo } from "../src/repo.ts";
import { loadPricing } from "../src/pricing.ts";
import { detectSandbox } from "../src/sandbox.ts";
import type { Repo } from "../src/repo.ts";
import type { Pricing } from "../src/pricing.ts";
import type { Agent, Connector } from "../src/types.ts";

const STEP_TIMEOUT_S = 30;
const FAKE_MCP_SERVER = join(import.meta.dir, "..", "fixtures", "stubs", "fake-mcp-server.ts");

function mkRemoteAgent(name: string, tool: string, params: Record<string, string>): Agent {
  return {
    name,
    kind: "remote",
    produces: ["review"],
    server: "mcp1c",
    tool,
    params,
    connectors: ["mcp1c"],
    timeout: STEP_TIMEOUT_S,
    style: { avatar: "M" },
    body: "",
  } as Agent;
}

function fakeServerConnector(overrides: Partial<Connector> = {}): Connector {
  return {
    name: "mcp1c",
    kind: "mcp",
    argv: ["bun", FAKE_MCP_SERVER, "normal"],
    env: [],
    auth: "env",
    role: "tool",
    effects: "read",
    gate: "proposal",
    ...overrides,
  };
}

type StepExpectation = "must-succeed" | "must-fail" | "informational";

// Drives ONE real `AdapterRunner.produceAsync` dispatch — the identical production call chain the R4
// sandbox saga's own harnesses drive (`prepare`, `withDispatchWorktreeAsync`, the real `asyncRemote`
// boundary, `createAsyncStdioRemoteBoundary`'s own sandbox wrap). `LEVARE_SANDBOX_DEBUG=1` is left SET
// for the duration; production code's own `console.error` calls print the profile text, composed argv,
// cwd, scratch/home-scoping decision, and (for the darwin probe) raw spawn result directly to this
// process's real stderr, interleaved in chronological order with this function's own `console.log` step
// framing — this script never re-captures or re-derives any of that, only reads it.
async function runRemoteDispatch(repo: Repo, pricing: Pricing, label: string, agent: Agent, connector: Connector, expect: StepExpectation, note: string): Promise<void> {
  console.log("");
  console.log(`=== ${label} ===`);
  console.log(note);
  repo.agents.set(agent.name, agent);
  repo.connectors.set(connector.name, connector);
  const nativeMock: NativeBoundary = { invoke: () => ({ doc: "unused" }) };
  const remoteMock: RemoteBoundary = { call: () => ({ doc: "unused" }) };
  const runner = new AdapterRunner(repo, {
    pricing,
    capabilities: [{ member: agent.name, kind: "review" }],
    native: nativeMock,
    remote: remoteMock,
    asyncRemote: createAsyncStdioRemoteBoundary(repo),
  });
  const start = Date.now();
  let outcome: "succeeded" | "failed";
  let detail: string;
  let rawText = "";
  try {
    const { doc } = await runner.produceAsync(agent.name, "review", "repro", "storefront");
    outcome = "succeeded";
    rawText = doc;
    const sandboxLine = /^sandbox: .+$/m.exec(doc)?.[0] ?? "sandbox: (not reported)";
    const bodyStart = doc.indexOf("\n---\n\n");
    const bodyPreview = bodyStart === -1 ? "" : doc.slice(bodyStart + 6).trim().slice(0, 300);
    detail = `${sandboxLine}${bodyPreview ? ` — output preview: ${JSON.stringify(bodyPreview)}` : ""}`;
  } catch (e) {
    outcome = "failed";
    const msg = e instanceof Error ? e.message : String(e);
    rawText = msg;
    detail = msg;
  }
  const elapsed = Date.now() - start;
  console.log(`[${outcome.toUpperCase()}] in ${elapsed}ms — ${detail}`);

  const sandboxLevel = /^sandbox: (\S+)/m.exec(rawText)?.[1];
  const primitiveWorking = sandboxLevel === "full" || sandboxLevel === "fs-only";

  if (expect === "informational") {
    console.log("        (informational — read the sandbox: line and output preview above; a HANG or crash here is a real finding, diagnose from the printed profile/argv/raw-result evidence, never guessed)");
    return;
  }
  if (!primitiveWorking) {
    console.log(
      `        (SKIPPED, not a pass or fail — this host's own sandbox level is '${sandboxLevel ?? "unknown"}', not full/fs-only, so this step's own ${expect} assertion has nothing confining it to prove or disprove. Never read a SUCCEEDED outcome here as a regression, or a FAILED one as a pass — only a working primitive can verdict this step; see the live-host leg.)`,
    );
    return;
  }
  if (expect === "must-succeed") {
    console.log(outcome === "succeeded" ? "        >>> PASS: succeeded as expected under a working sandbox <<<" : "        >>> FINDING: this was expected to succeed under a working sandbox but did not — diagnose from the evidence above <<<");
  } else {
    console.log(outcome === "failed" ? "        >>> PASS: denied/failed as expected under a working sandbox <<<" : "        >>> REGRESSION: this MUST fail under a working sandbox (operator-home decoy, no home: grant) but it SUCCEEDED <<<");
  }
}

function captureKernelDenials(windowSeconds: number): void {
  console.log("");
  console.log("=== Best-effort kernel-denial capture (macOS unified log) ===");
  if (process.platform !== "darwin") {
    console.log("(skipped — darwin-only, mirroring every other kernel-log capture in the R4 sandbox saga)");
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
      .filter((l) => /\bbun\b|\bnode\b|\bnpm\b|\bnpx\b|Sandbox:/i.test(l))
      .slice(-40);
    if (relevant.length) {
      console.log(`${relevant.length} matching line(s) (last 40 shown):`);
      for (const l of relevant) console.log(`  ${l}`);
    } else {
      console.log("no lines mentioning 'bun'/'node'/'npm'/'npx'/'Sandbox:' found in the captured window — either nothing was denied, or this host's `log show` needs elevated privileges for the relevant subsystem (not distinguishable from here).");
    }
  } catch (e) {
    console.log(`(log show unavailable/failed: ${e instanceof Error ? e.message : String(e)} — not a finding about the sandbox itself, just about this capture)`);
  }
}

async function main() {
  const hostSandbox = detectSandbox();
  console.log(`detectSandbox(): platform=${hostSandbox.platform} primitive=${hostSandbox.primitive} level=${hostSandbox.level}`);
  if (hostSandbox.level === "none") {
    console.log(
      "No working OS-level sandbox primitive on this host — degrading honestly: steps 1 and 4 below still run for real (proving the wiring), steps 2/3's own must-fail/must-succeed assertions report SKIPPED rather than a vacuous pass. Run this on a live macOS host (sandbox-exec) or a Linux host with working bubblewrap for the real verdict.",
    );
  }

  const repo = loadRepo("fixtures/golden");
  const pricing = loadPricing("fixtures/golden");

  const priorDebug = process.env.LEVARE_SANDBOX_DEBUG;
  process.env.LEVARE_SANDBOX_DEBUG = "1";

  const decoyDir = mkdtempSync(join(homedir(), ".levare-mcp-1c-decoy-"));
  writeFileSync(join(decoyDir, "marker.txt"), "MARKER — must never be readable without a matching home: grant\n");
  const decoyDotpathDir = decoyDir.slice(homedir().length + 1); // relative to $HOME
  const decoyDotpath = join(decoyDotpathDir, "marker.txt");

  try {
    const runner = Bun.which("npx") ?? Bun.which("bunx");
    if (runner) {
      await runRemoteDispatch(
        repo,
        pricing,
        "1. vendor-echo — a REAL bunx/npx-spawned Node MCP server (@modelcontextprotocol/server-everything), no home: grant",
        mkRemoteAgent("mcp1c-vendor-echo", "echo", { message: "MCP-1C {task}" }),
        fakeServerConnector({ argv: [runner, "-y", "@modelcontextprotocol/server-everything", "stdio"] }),
        "informational",
        "This is the step that would surface a REAL Node/npm vendor finding (the config-EPERM/trustd class NOTES R4-VENDOR-CLI found for gh) — a bunx-spawned Node process does more at startup than the fake fixture server ever does. A clean [SUCCEEDED] with 'Echo: MCP-1C-...' in the preview means the vendor server survived the sandbox's filesystem confinement cleanly; diagnose anything else from the printed profile/argv/raw-result evidence above, never guessed ahead of it.",
      );
    } else {
      console.log("");
      console.log("=== 1. vendor-echo — SKIPPED (neither npx nor bunx found on PATH) ===");
    }

    await runRemoteDispatch(
      repo,
      pricing,
      "2. decoy-deny — fake MCP server's own 'read-home-file' tool, NO home: grant, reading a decoy under the operator's real $HOME",
      mkRemoteAgent("mcp1c-decoy-deny", "read-home-file", { dotpath: decoyDotpath }),
      fakeServerConnector(),
      "must-fail",
      `Decoy planted at ${join(decoyDir, "marker.txt")} — the FIX-3/FIX-4 operator-home decoy proof, reached through an MCP tools/call instead of a shell 'cat'. No connector home: declared, so this dotpath is NOT reallowed anywhere in the generated profile.`,
    );

    await runRemoteDispatch(
      repo,
      pricing,
      "3. home:-grant proof — the SAME decoy, the SAME tool, but the connector NOW declares home: [<decoy's own parent dotpath>]",
      mkRemoteAgent("mcp1c-home-grant", "read-home-file", { dotpath: decoyDotpath }),
      fakeServerConnector({ home: [decoyDotpathDir] }),
      "must-succeed",
      "Ruling R3's own centerpiece: the connector's existing home: mechanism (env.ts#scopeHomeForConnector, generalized from the subscription-cli-only mechanism) is the one, auditable, per-connector way to declare a specific real-HOME path a server legitimately needs — never a blanket exception.",
    );

    const studioFile = join(realpathSync("fixtures/golden"), "teams", "kestrel.md");
    await runRemoteDispatch(
      repo,
      pricing,
      "4. studio-root-read — fake MCP server's own 'read-abs-file' tool, reading a real file under the studio root",
      mkRemoteAgent("mcp1c-studio-root", "read-abs-file", { path: studioFile }),
      fakeServerConnector(),
      "must-succeed",
      `Reading ${studioFile} — mirrors cli's own "excluding the studio root broke most of this repo's own real-spawn fixtures" finding (NOTES R4-SANDBOX-FIX): buildRemoteSandboxPolicy's own readOnlyPaths always includes repo.root.`,
    );
  } finally {
    rmSync(decoyDir, { recursive: true, force: true });
    if (priorDebug === undefined) delete process.env.LEVARE_SANDBOX_DEBUG;
    else process.env.LEVARE_SANDBOX_DEBUG = priorDebug;
  }

  captureKernelDenials(120);

  console.log("");
  console.log("=== Summary ===");
  console.log("Read every [SUCCEEDED]/[FAILED] + PASS/FINDING/REGRESSION/SKIPPED verdict above in order.");
  console.log("Step 1 is where a REAL vendor (Node/npm) finding would surface, the config-EPERM/trustd class");
  console.log("NOTES R4-VENDOR-CLI found for gh — diagnose any HANG/crash there from the printed profile/argv/");
  console.log("raw-result evidence, fix with the NARROWEST grant that evidence justifies, and re-run the");
  console.log("decoy-must-still-deny check (step 2) after any such grant is added. Steps 2/3 are the actual");
  console.log("R3 proof — the SAME operator-home deny and the SAME home:-declared re-allow a cli member's own");
  console.log("dispatch already gets, reached through an MCP tools/call — SKIPPED (not a pass) on any host");
  console.log("without a working primitive. Record this run's outcome in NOTES MCP-1C.");
}

if (import.meta.main) {
  await main();
}

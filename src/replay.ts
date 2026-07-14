// levare replay — drive a work unit end-to-end against stub members (PRD §11 phase-2 condition).
//
// `levare replay fixtures/golden --stubs` reconstructs the checkout-flow story from a clean slate
// using the deterministic stub members, printing a transcript in which the walk halts at every
// declared gate, resumes on a scripted Conductor decision, the review loop terminates by its `until`
// condition in round 2, and a second scripted case exhausts the loop's max_rounds and escalates via
// `on_exhaust: gate`. The golden scenario's final artifact statuses are the permanent replay oracle
// in fixtures/golden/expected.json — this run reproduces them and asserts a byte-for-byte match.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CAPABILITIES, render, cannedReceipt } from "../fixtures/stubs/member-stub.ts";
import { loadRepo } from "./repo.ts";
import { Runner, type Decision, type DecisionSource, type Gate, type MemberRunner, type RunEvent, type RunResult, type Verb } from "./runner.ts";
import {
  AdapterRunner,
  bunSpawn,
  asyncBunSpawn,
  createSdkNativeBoundary,
  createAsyncSdkNativeBoundary,
  type InvokeRequest,
  type NativeBoundary,
  type AsyncNativeBoundary,
  type RemoteBoundary,
} from "./adapters.ts";
import type { AsyncMemberRunner } from "./dagwalk.ts";
import { loadPricing } from "./pricing.ts";
import { formatReceipt } from "./receipts.ts";
import type { Repo } from "./repo.ts";

// ---------------------------------------------------------------------------
// Injected collaborators for replay
// ---------------------------------------------------------------------------

// A minimal MemberRunner that renders the stub artifacts directly (phase-2 shape). Retained for
// unit tests that drive the engine without the adapter layer.
export class StubRunner implements MemberRunner {
  capabilities() {
    return CAPABILITIES;
  }
  produce(member: string, kind: string, unit: string, project: string): { doc: string } {
    return { doc: render(member, kind, unit, project) };
  }
}

// Absolute path to the stub member CLI, so the CLI adapter can spawn it regardless of cwd.
const STUB_CLI = Bun.fileURLToPath(new URL("../fixtures/stubs/member-stub.ts", import.meta.url));

// Native/remote members are mocked at their boundary by rendering the same canned stub artifact —
// deliberately, for `--stubs` reproducibility (§11 phase 3), not because either boundary lacks a real
// backing: native has one (adapters.ts#createSdkNativeBoundary, wired into production since NOTES F8);
// remote's real MCP backing remains a documented, separate deferral (K5).
const stubNative: NativeBoundary = {
  invoke: (r: InvokeRequest) => ({ doc: render(r.member, r.kind, r.unit, r.project), receipt: cannedReceipt(r.member, r.kind) }),
};
const stubRemote: RemoteBoundary = { call: (r: InvokeRequest) => ({ doc: render(r.member, r.kind, r.unit, r.project) }) };

/**
 * NOTES F4 — the `--stubs`-ONLY replay MemberRunner. Every real invocation goes through the real
 * AdapterRunner; native/remote members go through mocked boundaries here (deliberately, so replay
 * stays reproducible without a real API key or MCP install — see the stubs' own comment above); the
 * one CLI member (finch/Codex) is deliberately redirected — via the `cliCommand` override below — to
 * spawn the fixture stub CLI instead of its own declared command, so replay is reproducible without a
 * real Codex install.
 *
 * That redirect is exactly the thing that must NEVER reach a live studio (F4: it did, for three
 * phases — `daemon.ts`/`board/gateops.ts` defaulted their production `memberRunner` to THIS function,
 * so `levare serve` never spawned a real CLI member's command, only ever this stub). This function is
 * now reachable from exactly two places: `levare replay --stubs` (below) and a test that imports it
 * explicitly. Production wiring (`daemon.ts`, `board/gateops.ts`) must use `productionAdapterRunner`
 * instead, which has no `cliCommand` override at all — see its own doc comment.
 */
// The capability map is NOT injected here (NOTES F1): the AdapterRunner derives it from the repo's
// own agent definitions (`produces:`), exactly as it does for a real studio. What the stubs still
// mock is the member INVOCATION (the native/remote boundaries and the CLI subprocess) — never the
// studio's own declarations. The golden fixture's agents declare the same (member, kind) pairs the
// stub can render, so replay reproduces the oracle byte-for-byte off repo-derived capabilities.
export function stubAdapterRunner(repo: Repo): AdapterRunner {
  return new AdapterRunner(repo, {
    pricing: loadPricing(repo.root),
    native: stubNative,
    remote: stubRemote,
    spawn: bunSpawn,
    // --stubs mode: spawn the stub CLI in place of the member's real command template. Use the
    // absolute interpreter path so resolution never depends on the allowlisted env's PATH.
    cliCommand: (r: InvokeRequest) => [process.execPath, STUB_CLI, r.member, r.kind, "--unit", r.unit, "--project", r.project],
  });
}

/**
 * NOTES F4/F8 — the real production MemberRunner: what `levare serve` (via `daemon.ts`) and the
 * board's own gate resolution (`board/gateops.ts`) actually drive by default. As of F8, a `kind:
 * native` member is invoked through the real Claude Agent SDK (`createSdkNativeBoundary`/
 * `createAsyncSdkNativeBoundary`, adapters.ts) — its declared model, tool allowlist, and assembled §6
 * context, with its artifact body and usage receipt coming from the real call — closing the last
 * "mocked this phase" deferral for member invocation (NOTES K5). `remote` (MCP) stays behind the
 * mocked boundary `stubAdapterRunner` also uses — a separate, still-documented deferral, untouched by
 * this fix. The CLI adapter gets NO `cliCommand` override here: left unset, `AdapterRunner` falls back
 * to its own `defaultCliCommand`, which substitutes the agent's own declared `command` template into
 * argv. A CLI member invoked through this function spawns its REAL command — never the fixture stub —
 * which is the entire point: before F4, `stubAdapterRunner` (above) was the only constructor in this
 * codebase and doubled as the silent production default, so every live CLI member was actually
 * invoking the phase-2 replay stub. Before F8, the same silent-stub defect held for `kind: native`:
 * this function passed `stubNative`, so a native member's artifact body and usage were always the
 * fixture's canned content, misattributed and priced at $0 real spend, regardless of which agent or
 * unit actually "ran".
 *
 * NOTES F5/F8: returns an `AsyncMemberRunner`, not a bare `AdapterRunner` — `produce()` here routes to
 * `AdapterRunner.produceAsync`, whose `kind: cli` path spawns non-blockingly (`asyncBunSpawn`, real
 * `Bun.spawn` + await) and whose `kind: native` path calls the non-blocking `asyncNative` boundary
 * (`asyncSdkTransport`, real `Bun.spawn` + await) — so the live daemon/gateops path this function feeds
 * never freezes `levare serve`'s event loop for the duration of a member's run (the CLI defect a real
 * 10-minute Gemini call exposed; the identical class of defect a native SDK call would otherwise
 * reintroduce). `stubAdapterRunner` above stays the phase-2 batch Runner's synchronous, mocked
 * boundary, untouched.
 */
export interface ProductionAdapterOverrides {
  /**
   * Test-only: substitute the native boundary so a hermetic test can dispatch a `kind: native` loop
   * member (e.g. the author half of an author/critic pair) without a real SDK call, while still
   * exercising the actual `productionAdapterRunner` wiring — not a hand-rolled stand-in — since ruling
   * F15's defect (a dropped `extraConsumes` argument) lived in THIS function's own return value, not
   * in dagwalk.ts or AdapterRunner, both of which already threaded it correctly. Every real call site
   * (daemon.ts, board/gateops.ts) leaves this unset.
   */
  native?: NativeBoundary;
  asyncNative?: AsyncNativeBoundary;
}

export function productionAdapterRunner(repo: Repo, overrides: ProductionAdapterOverrides = {}): AsyncMemberRunner {
  const runner = new AdapterRunner(repo, {
    pricing: loadPricing(repo.root),
    native: overrides.native ?? createSdkNativeBoundary(),
    asyncNative: overrides.asyncNative ?? createAsyncSdkNativeBoundary(),
    remote: stubRemote,
    spawn: bunSpawn,
    asyncSpawn: asyncBunSpawn,
  });
  return {
    capabilities: () => runner.capabilities(),
    // NOTES F15: `extraConsumes` (ruling C14 — a loop critic's own consumed-artifact seam) MUST reach
    // `AdapterRunner.produceAsync` unchanged; a wrapper that drops the trailing argument silently
    // strands every live loop critic with an empty consumed set, regardless of how carefully
    // dagwalk.ts/adapters.ts thread it — this was the actual live defect (a contract-valid review
    // whose entire content was "no product brief was provided to review").
    produce: (member, kind, unit, project, extraConsumes) => runner.produceAsync(member, kind, unit, project, extraConsumes),
  };
}

interface ScriptEntry {
  /** Assert the raised gate's label — keeps the script and engine in lockstep; drift fails loudly. */
  expect: string;
  verb: Verb;
  /** Conductor identity ("name + ISO date") recorded on any approval this decision triggers (C5). */
  by?: string;
  note?: string;
}

export class ScriptedDecisions implements DecisionSource {
  private i = 0;
  constructor(private readonly script: ScriptEntry[]) {}
  decide(gate: Gate): Decision {
    if (this.i >= this.script.length) {
      throw new Error(`scripted decisions exhausted at gate '${gate.label}' (${gate.type})`);
    }
    const s = this.script[this.i++];
    if (s.expect !== gate.label) {
      throw new Error(`scripted decision #${this.i} expected gate '${s.expect}' but the Runner raised '${gate.label}'`);
    }
    return { verb: s.verb, by: s.by, note: s.note };
  }
  get consumed(): number {
    return this.i;
  }
}

// ---------------------------------------------------------------------------
// Scenarios — the two scripted Conductor decision streams
// ---------------------------------------------------------------------------

const CAS = "cas 2026-07-11";

// The golden replay: checkout-flow's own start gate (ruling C8 — every unit's first flow step
// raises one, `after:` or not) is answered first, then brief approved, design approved, then the
// spec/review loop requests changes in round 1 and approves in round 2 → terminates by
// `until: spec.approved`. This is the oracle.
// A second fixture unit, loyalty-flow (E5), has a satisfied `after:` and so raises its own start
// gate during a full-repo walk, after checkout-flow's (walk order is by "project/unit"; "loyalty-
// flow" sorts after "checkout-flow"). Replay's job is to reproduce the checkout-flow oracle, so this
// scenario declines to start it ("notyet") rather than exercising a second unit's flow here.
const GOLDEN_SCRIPT: ScriptEntry[] = [
  { expect: "start", verb: "start", by: CAS },
  { expect: "brief", verb: "approve", by: CAS },
  { expect: "design", verb: "approve", by: CAS },
  { expect: "spec review", verb: "request", by: CAS, note: "name the idempotency key column" },
  { expect: "spec review", verb: "approve", by: CAS },
  { expect: "start", verb: "notyet", by: CAS },
];

// The exhaustion case: the spec is never approved, so the loop runs all three rounds and escalates
// through the `on_exhaust: gate`, where the Conductor rejects (unit paused).
const EXHAUST_SCRIPT: ScriptEntry[] = [
  { expect: "start", verb: "start", by: CAS },
  { expect: "brief", verb: "approve", by: CAS },
  { expect: "design", verb: "approve", by: CAS },
  { expect: "spec review", verb: "request", by: CAS, note: "round 1: more detail on payments" },
  { expect: "spec review", verb: "request", by: CAS, note: "round 2: idempotency still unclear" },
  { expect: "spec review", verb: "request", by: CAS, note: "round 3: still not build-ready" },
  { expect: "spec exhausted", verb: "reject", by: CAS, note: "cannot converge; pausing for a re-scope" },
  { expect: "start", verb: "notyet", by: CAS },
];

export interface ScenarioReport {
  name: string;
  title: string;
  events: RunEvent[];
  statuses: Statuses;
}

export interface Statuses {
  unit: { id: string; project: string; status: string };
  artifacts: Record<string, string>;
}

export interface ReplayReport {
  scenarios: ScenarioReport[];
  /** The golden scenario's statuses = the oracle payload. */
  oracle: Statuses;
  expected: Statuses | null;
  match: boolean;
}

const UNIT_KEY = "storefront/checkout-flow";

export function runReplay(root: string): ReplayReport {
  const golden = runScenario(root, "golden", "Golden replay — review loop terminates by condition in round 2", GOLDEN_SCRIPT);
  const exhaust = runScenario(root, "exhaust", "Exhaustion — 3 rounds, escalates via on_exhaust: gate", EXHAUST_SCRIPT);

  const expectedPath = join(root, "expected.json");
  const expected: Statuses | null = existsSync(expectedPath)
    ? (JSON.parse(readFileSync(expectedPath, "utf8")) as Statuses)
    : null;
  const match = expected !== null && serialize(golden.statuses) === serialize(expected);

  return { scenarios: [golden, exhaust], oracle: golden.statuses, expected, match };
}

function runScenario(root: string, name: string, title: string, script: ScriptEntry[]): ScenarioReport {
  // Fresh load per scenario; replay reconstructs from a clean slate (no seeded artifacts).
  const repo = loadRepo(root);
  const runner = new Runner(repo, { members: stubAdapterRunner(repo), decisions: new ScriptedDecisions(script) });
  const result = runner.run();
  return { name, title, events: result.events, statuses: extractStatuses(result) };
}

function extractStatuses(result: RunResult): Statuses {
  const unitStatus = result.unitStatus.get(UNIT_KEY) ?? "active";
  const map = result.artifacts.get(UNIT_KEY) ?? new Map();
  const artifacts: Record<string, string> = {};
  for (const id of [...map.keys()].sort()) artifacts[id] = map.get(id)!.status;
  return { unit: { id: "checkout-flow", project: "storefront", status: unitStatus }, artifacts };
}

/** Canonical serialization used for both expected.json and the byte-for-byte oracle comparison. */
export function serialize(s: Statuses): string {
  const sortedArtifacts: Record<string, string> = {};
  for (const id of Object.keys(s.artifacts).sort()) sortedArtifacts[id] = s.artifacts[id];
  return JSON.stringify({ unit: s.unit, artifacts: sortedArtifacts }, null, 2) + "\n";
}

// ---------------------------------------------------------------------------
// Transcript formatting
// ---------------------------------------------------------------------------

export function formatReport(report: ReplayReport): string {
  const out: string[] = [];
  for (const sc of report.scenarios) {
    out.push(`━━━ ${sc.name}: ${sc.title} ━━━`);
    for (const line of formatEvents(sc.events)) out.push(line);
    out.push(...formatStatuses(sc.statuses));
    out.push("");
  }
  out.push("━━━ oracle ━━━");
  if (report.expected === null) {
    out.push("fixtures/golden/expected.json not present — printing golden statuses only");
  } else if (report.match) {
    out.push("final artifact statuses match fixtures/golden/expected.json (byte-for-byte)");
  } else {
    out.push("MISMATCH: golden statuses differ from fixtures/golden/expected.json");
    out.push("--- expected ---");
    out.push(serialize(report.expected).trimEnd());
    out.push("--- actual ---");
    out.push(serialize(report.oracle).trimEnd());
  }
  return out.join("\n");
}

function formatEvents(events: RunEvent[]): string[] {
  const lines: string[] = [];
  for (const e of events) {
    switch (e.t) {
      case "walk":
        lines.push(`walk · ${e.project}/${e.unit} · ${e.note}`);
        break;
      case "produce": {
        const sup = e.supersedes ? ` (supersedes ${e.supersedes})` : "";
        lines.push(`  ${e.member} produced ${e.kind} → ${e.id} [${e.status}]${sup}`);
        // §10 receipt, one per invocation — quiet mono figures, `unreported` recorded honestly.
        if (e.receipt) lines.push(`         ${formatReceipt(e.receipt)}`);
        break;
      }
      case "gate-raised":
        lines.push(`  GATE ▸ ${e.gate.label}${e.gate.artifactId ? ` on ${e.gate.artifactId}` : ""} — HALT, awaiting Conductor [${e.gate.type}${e.gate.type === "exhaust" ? ", on_exhaust: gate" : ""}]`);
        if (e.gate.note) lines.push(`         ${e.gate.note}`);
        break;
      case "gate-resolved":
        lines.push(`         └ Conductor: ${e.verb}${e.note ? ` — "${e.note}"` : ""} → resume`);
        break;
      case "supersede":
        lines.push(`  ${e.id} superseded by ${e.by}`);
        break;
      case "loop-round":
        lines.push(`  ↻ loop round ${e.round}/${e.of}`);
        break;
      case "loop-end":
        if (e.reason === "exhausted") lines.push(`  ↻ loop ended: exhausted after ${e.round} rounds → on_exhaust: gate`);
        else if (e.reason === "condition") lines.push(`  ↻ loop ended: terminated by condition in round ${e.round}`);
        else lines.push(`  ↻ loop ended: ${e.reason} in round ${e.round}`);
        break;
      case "budget":
        lines.push(`  ⚠ budget: spend $${e.spent.toFixed(2)} crossed $${e.budget.toFixed(2)}`);
        break;
      case "timebox":
        lines.push(`  ⚠ timebox: ${e.spent_s}s crossed ${e.limit_s}s`);
        break;
      case "pace":
        lines.push(`  ⏸ pace: step — nod before '${e.step}'`);
        break;
      case "unit-status":
        lines.push(`  unit ${e.unit} → ${e.status}`);
        break;
      case "note":
        lines.push(`  · ${e.message}`);
        break;
    }
  }
  return lines;
}

function formatStatuses(s: Statuses): string[] {
  const out = [`  final: unit ${s.unit.project}/${s.unit.id} [${s.unit.status}]`];
  for (const id of Object.keys(s.artifacts).sort()) out.push(`         ${id}: ${s.artifacts[id]}`);
  return out;
}

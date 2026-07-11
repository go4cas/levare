// levare Runner core (PRD §6). Deterministic: no model, no judgment, no clock. It walks the
// dependency graph recomputed from frontmatter (invariant 5), executes each responsible team's
// declarative flow, raises a gate at every consequential transition, drives loops to their `until`
// condition or `max_rounds` → `on_exhaust`, and enforces declared limits (budget, timebox, pace).
//
// Everything the Runner needs from the outside is injected: member invocation (MemberRunner) and
// Conductor decisions (DecisionSource). That keeps the engine pure and lets phase 3 swap the stub
// MemberRunner for real native/CLI/remote adapters without touching this file. A single approval
// invariant governs the whole thing: no member runs without a Conductor approval in its causal
// chain (invariant 1) — here every gate decision is sourced from the DecisionSource, never faked.

import { validateArtifactSource } from "./validate.ts";
import { parseArtifactDoc } from "./repo.ts";
import type { Repo } from "./repo.ts";
import type {
  Artifact,
  FlowLoop,
  FlowNode,
  Project,
  Team,
  TypeTemplate,
  Usage,
  WorkUnit,
} from "./types.ts";

export class RunnerError extends Error {}

// ---------------------------------------------------------------------------
// Injected collaborators
// ---------------------------------------------------------------------------

/** Produces artifacts. The stub implementation drives phase-2 replay; phase-3 adds real adapters. */
export interface MemberRunner {
  capabilities(): Array<{ member: string; kind: string }>;
  /** Return the raw artifact markdown; the Runner validates it at the boundary before trusting it. */
  produce(member: string, kind: string, unit: string, project: string): { doc: string };
}

export type Verb =
  | "approve"
  | "request"
  | "reject"
  | "start"
  | "notyet"
  | "rescope"
  | "continue"
  | "raise"
  | "stop";

export interface Decision {
  verb: Verb;
  /** The Conductor's identity — "name + ISO date" — recorded as approved_by on any approval (C5). */
  by?: string;
  /** Optional human reason (e.g. a change-request note); never a substitute for `by`. */
  note?: string;
}

/** The Conductor's decisions, sourced deterministically in replay/tests. */
export interface DecisionSource {
  decide(gate: Gate): Decision;
}

// ---------------------------------------------------------------------------
// Gates and events
// ---------------------------------------------------------------------------

export type GateType = "start" | "flow" | "loop" | "exhaust" | "budget" | "timebox" | "blocked";

export interface Gate {
  type: GateType;
  unit: string;
  project: string;
  /** Human label, e.g. "brief", "spec review", "start", "budget". */
  label: string;
  /** The artifact sitting at in-review, when the gate has one. */
  artifactId?: string;
  /** Allowed verbs for this gate (§9 route table + §10 budget verbs). */
  verbs: Verb[];
  note?: string;
}

export type RunEvent =
  | { t: "walk"; unit: string; project: string; note: string }
  | {
      t: "produce";
      unit: string;
      member: string;
      kind: string;
      id: string;
      status: string;
      supersedes?: string;
      usage?: Usage | null;
    }
  | { t: "gate-raised"; gate: Gate }
  | { t: "gate-resolved"; gate: Gate; verb: Verb; note?: string }
  | { t: "supersede"; id: string; by: string }
  | { t: "loop-round"; unit: string; round: number; of: number }
  | { t: "loop-end"; unit: string; reason: "condition" | "rejected" | "exhausted"; round: number }
  | { t: "budget"; unit: string; spent: number; budget: number }
  | { t: "timebox"; unit: string; spent_s: number; limit_s: number }
  | { t: "pace"; unit: string; step: string }
  | { t: "blocked"; unit: string; id: string }
  | { t: "unit-status"; unit: string; status: string }
  | { t: "note"; message: string };

export interface RunResult {
  events: RunEvent[];
  /** Final in-memory artifact set, keyed by `${project}/${unit}` → id → artifact. */
  artifacts: Map<string, Map<string, Artifact>>;
  /** Final work-unit statuses, keyed by `${project}/${unit}`. */
  unitStatus: Map<string, string>;
}

// A control signal bubbled up from flow execution to pause a unit's walk at a gate.
type FlowOutcome = "complete" | "paused";

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface RunnerOptions {
  members: MemberRunner;
  decisions: DecisionSource;
  /** Seed the in-memory artifact state (default: empty — replay reconstructs the story from scratch). */
  seed?: Map<string, Map<string, Artifact>>;
}

export class Runner {
  private readonly repo: Repo;
  private readonly members: MemberRunner;
  private readonly decisions: DecisionSource;
  private readonly events: RunEvent[] = [];
  private readonly artifacts = new Map<string, Map<string, Artifact>>();
  private readonly unitStatus = new Map<string, string>();
  // Budget acknowledgment memory (C3), keyed by `${project}/${unit}`: the spend a `continue`
  // acknowledged, and a `raise`-lifted effective budget. Budget gates inform, they never spam.
  private readonly budgetAck = new Map<string, number>();
  private readonly effBudget = new Map<string, number>();

  constructor(repo: Repo, opts: RunnerOptions) {
    this.repo = repo;
    this.members = opts.members;
    this.decisions = opts.decisions;
    if (opts.seed) {
      for (const [k, m] of opts.seed) this.artifacts.set(k, new Map(m));
    }
  }

  run(): RunResult {
    // Deterministic order: units sorted by project then unit id.
    const units = [...this.repo.units].sort((a, b) =>
      `${a.project}/${a.unit}`.localeCompare(`${b.project}/${b.unit}`),
    );
    for (const unit of units) this.walkUnit(unit);
    return { events: this.events, artifacts: this.artifacts, unitStatus: this.unitStatus };
  }

  // -------------------------------------------------------------------------
  // DAG walk (§6)
  // -------------------------------------------------------------------------

  private walkUnit(unit: WorkUnit): void {
    const key = `${unit.project}/${unit.unit}`;
    if (!this.artifacts.has(key)) this.artifacts.set(key, new Map());
    this.unitStatus.set(key, unit.status);

    if (unit.status !== "active") {
      this.emit({ t: "walk", unit: unit.unit, project: unit.project, note: `status ${unit.status}; skipped` });
      return;
    }

    // Start gate (§6): a unit with `after:` is invisible until every dependency has shipped; when
    // satisfied, the walk raises a start gate at flow position zero rather than autostarting.
    if (unit.after && unit.after.length > 0) {
      const unmet = unit.after.filter((id) => !this.unitShipped(unit.project, id));
      if (unmet.length > 0) {
        this.emit({ t: "walk", unit: unit.unit, project: unit.project, note: `after: unmet [${unmet.join(", ")}]; invisible` });
        return;
      }
      const d = this.raiseGate({
        type: "start",
        unit: unit.unit,
        project: unit.project,
        label: "start",
        verbs: ["start", "notyet", "rescope"],
        note: `after: [${unit.after.join(", ")}] satisfied`,
      });
      if (d.verb !== "start") {
        this.setUnitStatus(key, d.verb === "rescope" ? "blocked" : "active", "start gate: not started");
        return;
      }
    }

    const team = this.responsibleTeam(unit);
    if (!team) {
      this.emit({ t: "walk", unit: unit.unit, project: unit.project, note: "no team produces this unit's kinds; nothing to do" });
      return;
    }
    this.emit({ t: "walk", unit: unit.unit, project: unit.project, note: `team ${team.name} responsible → executing flow` });
    const outcome = this.executeFlow(unit, team);
    if (outcome === "paused" && this.unitStatus.get(key) === "active") {
      this.setUnitStatus(key, "paused", "flow paused at a gate");
    }
  }

  private responsibleTeam(unit: WorkUnit): Team | null {
    const type = this.repo.types.get(unit.type);
    const expects = type?.expects ?? [];
    let best: Team | null = null;
    let bestScore = 0;
    for (const team of [...this.repo.teams.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      const score = team.produces.filter((k) => expects.includes(k)).length;
      if (score > bestScore) {
        best = team;
        bestScore = score;
      }
    }
    return best;
  }

  private unitShipped(project: string, unitId: string): boolean {
    const status = this.unitStatus.get(`${project}/${unitId}`);
    if (status) return status === "shipped";
    const u = this.repo.units.find((x) => x.project === project && x.unit === unitId);
    return u?.status === "shipped";
  }

  // -------------------------------------------------------------------------
  // Flow execution (§6)
  // -------------------------------------------------------------------------

  private executeFlow(unit: WorkUnit, team: Team): FlowOutcome {
    const project = this.repo.projects.get(unit.project);
    let last: Produced | null = null;
    for (const node of team.flow) {
      switch (node.kind) {
        case "step": {
          const produced = this.runStep(unit, team, project, node.step, 1);
          if (produced === "budget-stop") return "paused";
          if (produced === "timebox-stop") return "paused";
          last = produced;
          break;
        }
        case "gate": {
          if (!last) {
            this.emit({ t: "note", message: `gate with no preceding artifact in ${unit.unit}; skipped` });
            break;
          }
          const outcome = this.runFlowGate(unit, team, project, last);
          if (outcome === "paused") return "paused";
          break;
        }
        case "loop": {
          const outcome = this.runLoop(unit, team, project, node);
          if (outcome === "paused") return "paused";
          break;
        }
      }
    }
    return "complete";
  }

  // Run one flow step: resolve the member, invoke it, validate at the boundary, record the artifact.
  private runStep(
    unit: WorkUnit,
    team: Team,
    project: Project | undefined,
    stepLabel: string,
    round: number,
    supersedesId?: string,
  ): Produced | "budget-stop" | "timebox-stop" {
    this.pace(unit, project, stepLabel);
    const { member, kind } = this.resolveStep(team, stepLabel);
    const { doc } = this.members.produce(member, kind, unit.unit, unit.project);

    // Boundary contract enforcement (§6) with the same validator used on disk.
    const errs = validateArtifactSource(doc, `${member}:${kind}`);
    if (errs.length > 0) {
      throw new RunnerError(`member '${member}' produced off-contract '${kind}': ${errs[0].code} — ${errs[0].message}`);
    }

    const art = parseArtifactDoc(doc);
    if (round > 1) art.id = bumpVersion(art.id, round);
    if (supersedesId) {
      art.supersedes = supersedesId;
      this.markSuperseded(unit, supersedesId, art.id);
    }
    this.putArtifact(unit, art);
    this.emit({
      t: "produce",
      unit: unit.unit,
      member: `${team.name}/${member}`,
      kind,
      id: art.id,
      status: art.status,
      supersedes: art.supersedes ?? undefined,
      usage: art.usage,
    });

    // Enforce declared limits after each production.
    if (this.overBudget(unit)) return "budget-stop";
    if (this.overTimebox(unit)) return "timebox-stop";
    return { member, kind, id: art.id, stepLabel };
  }

  private runFlowGate(unit: WorkUnit, team: Team, project: Project | undefined, last: Produced): FlowOutcome {
    const key = `${unit.project}/${unit.unit}`;
    let current = last;
    // request-changes on a plain gate re-invokes the producer; the successor supersedes and the same
    // gate re-raises (§4). A safety cap prevents an unbounded re-invoke if a script never converges.
    for (let attempt = 0; attempt < 10; attempt++) {
      const art = this.getArtifact(unit, current.id)!;
      const d = this.raiseGate({
        type: "flow",
        unit: unit.unit,
        project: unit.project,
        label: current.stepLabel,
        artifactId: current.id,
        verbs: ["approve", "request", "reject"],
      });
      if (d.verb === "approve") {
        this.approve(unit, art, d.by);
        return "complete";
      }
      if (d.verb === "reject") {
        art.status = "rejected";
        this.setUnitStatus(key, "paused", `gate '${current.stepLabel}' rejected`);
        return "paused";
      }
      // request: re-invoke producer, supersede, loop.
      const round = attempt + 2;
      const produced = this.runStep(unit, team, project, current.stepLabel, round, current.id);
      if (produced === "budget-stop" || produced === "timebox-stop") return "paused";
      current = produced;
    }
    this.setUnitStatus(key, "paused", `gate '${current.stepLabel}' did not converge`);
    return "paused";
  }

  // -------------------------------------------------------------------------
  // Loops (§6): alternate two members until `until`, else max_rounds → on_exhaust
  // -------------------------------------------------------------------------

  private runLoop(unit: WorkUnit, team: Team, project: Project | undefined, loop: FlowLoop): FlowOutcome {
    const key = `${unit.project}/${unit.unit}`;
    const [firstLabel, secondLabel] = loop.between;
    let prevFirstId: string | undefined;
    let prevSecondId: string | undefined;

    for (let round = 1; round <= loop.maxRounds; round++) {
      this.emit({ t: "loop-round", unit: unit.unit, round, of: loop.maxRounds });

      const first = this.runStep(unit, team, project, firstLabel, round, prevFirstId);
      if (first === "budget-stop" || first === "timebox-stop") return "paused";
      const second = this.runStep(unit, team, project, secondLabel, round, prevSecondId);
      if (second === "budget-stop" || second === "timebox-stop") return "paused";
      prevFirstId = first.id;
      prevSecondId = second.id;

      // The `until` condition (e.g. spec.approved) can only become true via a Conductor gate
      // (invariant 4). Each round therefore raises a gate on the first member's artifact.
      const art = this.getArtifact(unit, first.id)!;
      const d = this.raiseGate({
        type: "loop",
        unit: unit.unit,
        project: unit.project,
        label: `${firstLabel} review`,
        artifactId: first.id,
        verbs: ["approve", "request", "reject"],
        note: `round ${round}/${loop.maxRounds}; until ${loop.until}`,
      });
      // C2: on any loop-gate resolution the round's companion review resolves to approved — the
      // Conductor accepted it as read. (A later round's review supersedes it; the last stays approved.)
      this.approve(unit, this.getArtifact(unit, second.id)!, d.by);
      if (d.verb === "approve") {
        this.approve(unit, art, d.by);
        if (this.untilSatisfied(unit, loop.until)) {
          this.emit({ t: "loop-end", unit: unit.unit, reason: "condition", round });
          return "complete";
        }
      } else if (d.verb === "reject") {
        art.status = "rejected";
        this.emit({ t: "loop-end", unit: unit.unit, reason: "rejected", round });
        this.setUnitStatus(key, "paused", "loop rejected");
        return "paused";
      }
      // request → next round supersedes both artifacts.
    }

    // Exhausted: max_rounds reached without `until`.
    this.emit({ t: "loop-end", unit: unit.unit, reason: "exhausted", round: loop.maxRounds });
    if (loop.onExhaust === "gate") {
      // Verbs are approve|reject only, so the escalation always resolves the spec (C2): it never
      // leaves the artifact at in-review. The companion review of the final round is already
      // approved by that round's gate resolution.
      const d = this.raiseGate({
        type: "exhaust",
        unit: unit.unit,
        project: unit.project,
        label: `${firstLabel} exhausted`,
        artifactId: prevFirstId,
        verbs: ["approve", "reject"],
        note: `loop hit max_rounds ${loop.maxRounds} without ${loop.until}`,
      });
      const spec = prevFirstId ? this.getArtifact(unit, prevFirstId) : undefined;
      if (d.verb === "approve" && spec) {
        this.approve(unit, spec, d.by);
        return "complete";
      }
      if (spec) spec.status = "rejected";
      this.setUnitStatus(key, "paused", "loop exhausted → escalation gate");
      return "paused";
    }
    this.setUnitStatus(key, "paused", "loop exhausted");
    return "paused";
  }

  private untilSatisfied(unit: WorkUnit, until: string): boolean {
    // `kind.status` — e.g. spec.approved. True when a live (non-superseded) artifact of that kind
    // holds that status.
    const [kind, wantStatus] = until.split(".");
    const map = this.artifacts.get(`${unit.project}/${unit.unit}`);
    if (!map) return false;
    for (const a of map.values()) {
      if (a.kind === kind && a.status === wantStatus) return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Gate lifecycle (§4)
  // -------------------------------------------------------------------------

  private raiseGate(gate: Gate): Decision {
    this.emit({ t: "gate-raised", gate });
    const d = this.decisions.decide(gate);
    if (!gate.verbs.includes(d.verb)) {
      throw new RunnerError(`decision '${d.verb}' is not valid for gate '${gate.label}' (allowed: ${gate.verbs.join(", ")})`);
    }
    this.emit({ t: "gate-resolved", gate, verb: d.verb, note: d.note });
    return d;
  }

  private approve(unit: WorkUnit, art: Artifact, by?: string): void {
    // Only the Conductor sets approved_by (invariant 4), and it always carries the Conductor's
    // "name + ISO date" (C5): no defaults, no placeholders, provenance never fabricated.
    if (!by || !/\d{4}-\d{2}-\d{2}/.test(by)) {
      throw new RunnerError(`approved_by must carry the Conductor's name + ISO date; got '${by ?? ""}'`);
    }
    art.status = "approved";
    art.approved_by = by;
  }

  // -------------------------------------------------------------------------
  // Declared limits (§6, §10)
  // -------------------------------------------------------------------------

  private overBudget(unit: WorkUnit): boolean {
    const key = `${unit.project}/${unit.unit}`;
    const budget = this.effBudget.get(key) ?? unit.budget;
    if (budget === undefined || budget === null) return false;
    const spent = this.spentUsd(unit);
    if (spent <= budget) return false;
    // C3: a prior `continue` acknowledged this spend level — don't re-raise until spend crosses
    // a new threshold beyond the acknowledged amount.
    const ack = this.budgetAck.get(key);
    if (ack !== undefined && spent <= ack) return false;

    this.emit({ t: "budget", unit: unit.unit, spent, budget });
    const d = this.raiseGate({
      type: "budget",
      unit: unit.unit,
      project: unit.project,
      label: "budget",
      verbs: ["continue", "raise", "stop"],
      note: `spend $${spent.toFixed(2)} crossed budget $${budget.toFixed(2)}`,
    });
    if (d.verb === "stop") return true;
    // raise lifts the effective budget to the current spend for the rest of the run; both verbs
    // acknowledge the current level so the gate re-raises only on a further crossing.
    if (d.verb === "raise") this.effBudget.set(key, spent);
    this.budgetAck.set(key, spent);
    return false;
  }

  private overTimebox(unit: WorkUnit): boolean {
    const limit = timeboxSeconds(unit.timebox ?? this.repo.types.get(unit.type)?.timebox ?? null);
    if (limit === null) return false;
    const spent = this.spentWallS(unit);
    if (spent <= limit) return false;
    this.emit({ t: "timebox", unit: unit.unit, spent_s: spent, limit_s: limit });
    const d = this.raiseGate({
      type: "timebox",
      unit: unit.unit,
      project: unit.project,
      label: "timebox",
      verbs: ["continue", "stop"],
      note: `${spent}s elapsed crossed timebox ${limit}s`,
    });
    return d.verb === "stop";
  }

  private pace(unit: WorkUnit, project: Project | undefined, step: string): void {
    if (this.effectivePace(project) !== "step") return;
    this.emit({ t: "pace", unit: unit.unit, step });
    this.raiseGate({
      type: "flow",
      unit: unit.unit,
      project: unit.project,
      label: `pace: ${step}`,
      verbs: ["approve", "reject"],
      note: "pace: step — nod before the next team invocation",
    });
  }

  private effectivePace(project: Project | undefined): "auto" | "step" {
    if (!project) return "auto";
    const override = project.overrides?.pace;
    if (override === "auto" || override === "step") return override;
    return project.pace;
  }

  private spentUsd(unit: WorkUnit): number {
    let sum = 0;
    for (const a of this.unitArtifacts(unit).values()) {
      const usd = a.usage?.usd;
      if (typeof usd === "number") sum += usd;
    }
    return round2(sum);
  }

  private spentWallS(unit: WorkUnit): number {
    let sum = 0;
    for (const a of this.unitArtifacts(unit).values()) {
      const w = a.usage?.wall_clock_s;
      if (typeof w === "number") sum += w;
    }
    return sum;
  }

  // -------------------------------------------------------------------------
  // Step resolution + artifact bookkeeping
  // -------------------------------------------------------------------------

  // Resolve a flow step label to the (member, kind) that satisfies it: a team member who can produce
  // a kind matching the label, exactly or by suffix (step `brief` → kind `product-brief`). Ambiguity
  // or absence is a hard error — a misconfigured flow fails loudly, never silently guesses.
  private resolveStep(team: Team, stepLabel: string): { member: string; kind: string } {
    const caps = this.members.capabilities().filter((c) => team.members.includes(c.member) && kindMatches(c.kind, stepLabel));
    if (caps.length === 0) {
      throw new RunnerError(`no member of team '${team.name}' can produce a kind for flow step '${stepLabel}'`);
    }
    if (caps.length > 1) {
      const opts = caps.map((c) => `${c.member}:${c.kind}`).join(", ");
      throw new RunnerError(`flow step '${stepLabel}' is ambiguous in team '${team.name}' (${opts})`);
    }
    return caps[0];
  }

  private unitArtifacts(unit: WorkUnit): Map<string, Artifact> {
    return this.artifacts.get(`${unit.project}/${unit.unit}`)!;
  }
  private getArtifact(unit: WorkUnit, id: string): Artifact | undefined {
    return this.unitArtifacts(unit).get(id);
  }
  private putArtifact(unit: WorkUnit, art: Artifact): void {
    this.unitArtifacts(unit).set(art.id, art);
  }
  private markSuperseded(unit: WorkUnit, oldId: string, byId: string): void {
    const prev = this.getArtifact(unit, oldId);
    if (prev) {
      prev.status = "superseded";
      this.emit({ t: "supersede", id: oldId, by: byId });
    }
  }

  private setUnitStatus(key: string, status: string, why: string): void {
    this.unitStatus.set(key, status);
    this.emit({ t: "unit-status", unit: key, status });
    if (why) this.emit({ t: "note", message: why });
  }

  private emit(e: RunEvent): void {
    this.events.push(e);
  }
}

// A produced artifact's coordinates, threaded through flow execution.
interface Produced {
  member: string;
  kind: string;
  id: string;
  stepLabel: string;
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

function kindMatches(kind: string, stepLabel: string): boolean {
  return kind === stepLabel || kind.endsWith(`-${stepLabel}`);
}

// Bump the trailing -vN of an id to the given round (spec-...-v1 → spec-...-v2). Ids without a
// version suffix get one appended.
function bumpVersion(id: string, round: number): string {
  return /-v\d+$/.test(id) ? id.replace(/-v\d+$/, `-v${round}`) : `${id}-v${round}`;
}

// Parse a timebox string (e.g. "1d", "6h", "30m", "90s", "3600") into seconds; null when absent.
export function timeboxSeconds(tb: string | null | undefined): number | null {
  if (tb === null || tb === undefined) return null;
  const m = /^(\d+)\s*(d|h|m|s)?$/.exec(String(tb).trim());
  if (!m) return null;
  const n = Number(m[1]);
  switch (m[2]) {
    case "d":
      return n * 86400;
    case "h":
      return n * 3600;
    case "m":
      return n * 60;
    default:
      return n; // "s" or bare number
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

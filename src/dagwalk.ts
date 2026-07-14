// Phase 8: the single-step DAG advance. This is the one piece of logic both the board's `start`
// verb (board/gateops.ts) and the daemon (daemon.ts) drive — "reuse, don't reimplement" applied to
// the walk itself, not just to member invocation. It does NOT re-implement the phase-2 Runner's
// in-memory simulated walk (runner.ts's Runner.run/executeFlow/runLoop) — that engine drives a full
// script of Conductor decisions to completion in one pass (replay.ts). This module instead answers a
// narrower, repeatedly-askable question, purely from on-disk state (files are the truth, invariant
// 2): "given what's actually approved on disk right now, what is the SINGLE next thing this unit's
// responsible team could produce, if anything?" Each call produces at most one artifact and returns —
// writing that artifact is itself a repo change, so the next call (the next daemon tick, or the next
// walk of the same unit) picks up right where this one left off. This is what makes the daemon's
// "walk between gates, halt at every gate" property fall out of simple repeated application rather
// than needing its own multi-step simulation: an artifact landing at in-review IS the halt (ruling
// C2/E10 — an artifact at in-review always means an open gate), so there is never a point where this
// module produces past one.
//
// Ruling C14 (NOTES.md): a loop must actually loop on the live path, not just in the phase-2 batch
// Runner's simulated walk. The walk dispatches BOTH members of a `loop` node, in order, every round:
//   1. The FIRST member (e.g. `spec`) is produced exactly like a plain step — nothing new there.
//   2. The instant the first artifact reaches `in-review`, THIS module also dispatches the SECOND
//      (companion/critic) member (e.g. `review`) for the same round, handing it the first artifact in
//      its own context/`consumes:` even though that artifact is not yet approved (`extraConsumes` —
//      see runner.ts's `MemberRunner.produce` doc). Producing both members is what makes a round a
//      round; the golden fixture's own once-standing spec-with-no-review gate (E3/NOTES) is exactly
//      the defect this closes, not a state this module still has to tolerate.
//   3. Once both members of a round sit in-review, the walk HALTS — this is the loop's outcome gate.
//      The Conductor's decision (approve/reject/request) on the FIRST artifact is what the Conductor
//      actually consented to at the loop's start gate; nothing inside a round raises a second, separate
//      human gate (`board/gateops.ts#applyLoopCompanionApproval` already resolves the companion
//      alongside the first, mirroring runner.ts's own `runLoop` — ruling C2, unchanged by C14).
//   4. A round AFTER the first (a Conductor's request-changes) re-invokes the first member via
//      `board/gateops.ts#doRequest`, superseding its previous artifact — unchanged by C14. This module
//      then sees the new round's first artifact in-review with no round-matched companion yet, and
//      produces the companion for THAT round on its next walk, superseding the prior round's companion
//      — the SAME code path as round 1, not a second one. `max_rounds`/`on_exhaust: gate` are enforced
//      in `doRequest` (the one place a new round is ever requested), not here — this module never
//      bumps a round on its own initiative, only ever completes the round the Conductor already
//      authorized by producing the first artifact.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateArtifactSource, formatValidationErrors } from "./validate.ts";
import { parseArtifactDoc } from "./repo.ts";
import type { Repo } from "./repo.ts";
import { RunnerError, timeboxSeconds, bumpVersion, roundOf } from "./runner.ts";
import { responsibleTeamsFor, resolveStep, unmetAfter, patchFrontmatter, upsertFrontmatterField } from "./gates.ts";
import { runnerCommit } from "./git.ts";
import { locateArtifactFile } from "./board/locate.ts";
import type { Artifact, FlowLoop, Receipt, Team, WorkUnit } from "./types.ts";

// ---------------------------------------------------------------------------
// NOTES F5: the live path's member boundary — genuinely async-capable, so a `kind: cli` member's real
// spawn (asyncBunSpawn, adapters.ts) never blocks `levare serve`'s event loop for the duration of its
// run. `produce()`'s return type is a union (a plain result OR a promise of one) rather than a strict
// `Promise<...>` so every existing SYNCHRONOUS `MemberRunner` (runner.ts) — the phase-2 stubs, test
// doubles, `stubAdapterRunner` — satisfies this interface unchanged (a sync return is a valid member of
// the union); only the real, live `AdapterRunner.produceAsync` (replay.ts#productionAdapterRunner)
// actually returns a genuine, non-blocking Promise. `advanceUnit`/`produceOne` below `await` either
// shape uniformly. This is the one seam that's async (mirroring sdk-transport.ts's SdkTransport vs
// AsyncSdkTransport split) — the Runner's own phase-2 batch walk (runner.ts) is untouched and stays
// fully synchronous.
export interface AsyncMemberRunner {
  capabilities(): Array<{ member: string; kind: string }>;
  /** `extraConsumes` (ruling C14) — see runner.ts's `MemberRunner.produce` doc; the same optional seam. */
  produce(
    member: string,
    kind: string,
    unit: string,
    project: string,
    extraConsumes?: string[],
  ): { doc: string; receipt?: Receipt } | Promise<{ doc: string; receipt?: Receipt }>;
}

// ---------------------------------------------------------------------------
// Pure flow-position derivation (no I/O) — the piece under direct unit test.
// ---------------------------------------------------------------------------

export type NextAction =
  | {
      type: "produce";
      member: string;
      kind: string;
      stepLabel: string;
      /**
       * Ruling C14 — set only for a loop member: `round` is the round number this production belongs
       * to (the id gets `bumpVersion(kind-unit, round)`, matching the first/second members' own
       * lockstep convention); `supersedes` is the PRIOR round's live artifact of this same kind, when
       * one exists (round > 1); `extraConsumes` is handed to the memberRunner so the companion's
       * context/consumes includes the round's own author artifact even though it is still in-review.
       */
      loop?: { round: number; supersedes?: string; extraConsumes?: string[] };
    }
  | { type: "halt"; reason: string }
  // NOTES F1: the flow step cannot be resolved to a member at all (none produces a matching kind, or
  // two do). This is NOT an ordinary halt — a halt means "something is legitimately in the way right
  // now, look again later", and a resolution failure never resolves itself: the studio is
  // misconfigured, and every later tick would re-derive the same failure and do nothing, forever.
  // Kept distinct so `advanceUnit` can block the unit LOUDLY and put the reason where a human sees it.
  | { type: "unbindable"; reason: string; stepLabel: string }
  | { type: "nothing" };

/** The latest non-superseded artifact of `kind` for this unit, if any (§6: the DAG is recomputed
 * from frontmatter on every walk — this always reads the current in-memory `repo.artifacts`, which
 * the caller re-loads from disk before every call). */
export function latestLiveArtifact(repo: Repo, unit: WorkUnit, kind: string): Artifact | undefined {
  const m = repo.artifacts.get(`${unit.project}/${unit.unit}`);
  if (!m) return undefined;
  const live = [...m.values()].filter((a) => a.kind === kind && a.status !== "superseded");
  return live.sort((a, b) => a.created.localeCompare(b.created)).pop();
}

/** `kind.status` (e.g. `spec.approved`) — true when SOME artifact of that kind (live or not; a
 * terminal approval is never superseded away) holds that status. Mirrors runner.ts's own private
 * `untilSatisfied` exactly (kept as a small independent copy rather than exported cross-module,
 * matching gates.ts's own precedent for `responsibleTeamFor`/`resolveStep`: a circular import
 * between runner.ts and dagwalk.ts would result otherwise, for a ~5-line pure lookup). */
export function untilSatisfied(repo: Repo, unit: WorkUnit, until: string): boolean {
  const [kind, wantStatus] = until.split(".");
  const m = repo.artifacts.get(`${unit.project}/${unit.unit}`);
  if (!m) return false;
  for (const a of m.values()) {
    if (a.kind === kind && a.status === wantStatus) return true;
  }
  return false;
}

/**
 * Walk `team.flow` in order against the unit's current on-disk artifacts and return the single next
 * action: produce one specific (member, kind), halt (an open gate, or a rejected/blocked step, is in
 * the way), or nothing (the flow is fully satisfied — every step this team owns is approved).
 */
export function nextAction(repo: Repo, unit: WorkUnit, team: Team, capabilities: Array<{ member: string; kind: string }>): NextAction {
  for (const node of team.flow) {
    if (node.kind === "gate") continue; // a structural marker only; the preceding step's own status already governs whether we may proceed past it.
    if (node.kind === "step") {
      let member: string, kind: string;
      try {
        ({ member, kind } = resolveStep(team, node.step, capabilities));
      } catch (e) {
        return { type: "unbindable", reason: e instanceof RunnerError ? e.message : String(e), stepLabel: node.step };
      }
      const current = latestLiveArtifact(repo, unit, kind);
      if (!current) return { type: "produce", member, kind, stepLabel: node.step };
      if (current.status === "in-review") return { type: "halt", reason: `gate open on ${current.id}` };
      // NOTES F19: a Conductor's "skip" verb on a blocked artifact marks it `skipped` precisely so the
      // walk continues past this kind — treated like `approved` here, the one other status that lets
      // a plain step's flow proceed.
      if (current.status === "approved" || current.status === "skipped") continue;
      return { type: "halt", reason: `${current.id} is ${current.status}; awaiting Conductor` };
    }
    if (node.kind === "loop") {
      // Ruling C14 (see this file's header note): the walk dispatches BOTH members of a loop, in
      // order, every round — never just the first.
      const loop = node as FlowLoop;
      if (untilSatisfied(repo, unit, loop.until)) continue;
      const [firstLabel, secondLabel] = loop.between;
      let first: { member: string; kind: string };
      try {
        first = resolveStep(team, firstLabel, capabilities);
      } catch (e) {
        return { type: "unbindable", reason: e instanceof RunnerError ? e.message : String(e), stepLabel: firstLabel };
      }
      const firstArt = latestLiveArtifact(repo, unit, first.kind);
      if (!firstArt) return { type: "produce", member: first.member, kind: first.kind, stepLabel: firstLabel, loop: { round: 1 } };
      if (firstArt.status === "in-review") {
        let second: { member: string; kind: string };
        try {
          second = resolveStep(team, secondLabel, capabilities);
        } catch (e) {
          return { type: "unbindable", reason: e instanceof RunnerError ? e.message : String(e), stepLabel: secondLabel };
        }
        const round = roundOf(firstArt.id);
        const expectedCompanionId = bumpVersion(`${second.kind}-${unit.unit}`, round);
        const companion = repo.artifacts.get(`${unit.project}/${unit.unit}`)?.get(expectedCompanionId);
        if (!companion) {
          // This round's companion doesn't exist yet — produce it, superseding whatever the PRIOR
          // round's live companion was (round 1 has none), with the author's own (still in-review)
          // artifact in its context/consumes (extraConsumes) — that pairing IS the round.
          const prevCompanion = latestLiveArtifact(repo, unit, second.kind);
          return {
            type: "produce",
            member: second.member,
            kind: second.kind,
            stepLabel: secondLabel,
            loop: { round, supersedes: prevCompanion?.id, extraConsumes: [firstArt.id] },
          };
        }
        // Both members of this round already sit in-review — the round's outcome gate. The walk
        // halts here; the Conductor's decision on the first artifact resolves BOTH (ruling C2,
        // board/gateops.ts#applyLoopCompanionApproval), and this module never raises a second gate.
        return { type: "halt", reason: `gate open on ${firstArt.id}` };
      }
      if (firstArt.status === "approved") continue; // until would already have been true above unless loop.until names a different kind.
      return { type: "halt", reason: `${firstArt.id} is ${firstArt.status}; awaiting Conductor` };
    }
  }
  return { type: "nothing" };
}

// ---------------------------------------------------------------------------
// The write path: resolve a unit's next action, produce it through the MemberRunner boundary, and
// commit. Invariant 1 lives here structurally, not by convention: `advanceUnit` NEVER runs for a unit
// whose start gate (`after:`) is unmet or (when the unit has never produced anything at all) not yet
// explicitly authorized — see `startAuthorized` below.
// ---------------------------------------------------------------------------

export type AdvanceResult =
  | { outcome: "produced"; member: string; kind: string; artifactId: string; file: string; commit: string }
  | { outcome: "blocked"; member: string; kind: string; artifactId: string; file: string; commit: string; error: string }
  | { outcome: "halted"; reason: string }
  // Ruling C3 (extended, PRD v1.1 §5): the unit's ledger crossed its (effective) budget and no prior
  // `continue`/`raise` has acknowledged this spend level. A distinct outcome — not a plain `halt` — so
  // the daemon knows a *budget gate* was raised, halts this unit's walk, and can un-halt it on a
  // Conductor `continue`/`raise`/`stop`. `spent`/`budget` carry the crossing so the gate can be shown.
  | { outcome: "budget-gate"; spent: number; budget: number; reason: string }
  // NOTES F1: a flow step could not be bound to any member. The unit is BLOCKED on disk (status
  // `blocked` + `blocked_reason`, committed) and surfaced as a gate on the board — never a silent
  // no-op. Distinct from `blocked` (an artifact-slot failure: a member ran and failed) because
  // nothing ran and there is no kind to write an artifact for — the studio itself is misconfigured.
  | { outcome: "unbindable"; reason: string; stepLabel: string; file: string; commit: string }
  | { outcome: "nothing" };

export interface AdvanceOptions {
  /**
   * Only ever true for the ONE call board/gateops.ts#doStart makes, at the exact moment the
   * Conductor resolves a unit's start gate with the `start` verb — that HTTP call IS the Conductor
   * approval this production's causal chain rests on (invariant 1). The daemon's own autonomous
   * background walk (daemon.ts) NEVER sets this: EVERY unit — `after:` or not — is a standing open
   * start gate the daemon must render inert to, forever, until a Conductor clicks it (ruling C8; a
   * unit's own existence, hand-written or injected, is not consent). There is no persisted
   * "queued"/"started" status to distinguish "not yet decided" from "decided" any other way (NOTES
   * A6), so the boolean itself, passed only from that one call site, IS the entire mechanism
   * preventing an autostart.
   */
  startAuthorized?: boolean;
  /**
   * Ruling C3 (extended): per-unit budget-gate resolution state, owned by the daemon in memory across
   * ticks (the runner keeps the mirror-image `effBudget`/`budgetAck` maps). `eff` is a `raise`-lifted
   * effective budget for the run; `ack` is the spend level a `continue`/`raise` acknowledged, below
   * which the budget gate does not re-raise. Absent for a unit whose gate has never been touched.
   */
  budget?: { eff?: number | null; ack?: number };
  today?: string;
  /**
   * Commit identity + verb label for the write this call may make. Defaults to the daemon's own
   * autonomous identity (`runnerCommit`, verb "advance") — no human clicked anything for THIS
   * specific commit's causal chain, only for the earlier gate resolution that unblocked it. The one
   * exception is board/gateops.ts#doStart, which overrides both: THAT call is itself the direct
   * result of a Conductor clicking "start", so its commit is attributed to the Conductor exactly like
   * every other gate resolution, preserving the pre-existing "start <unit> → ..." message shape.
   */
  commit?: (root: string, files: string[], message: string) => string;
  verb?: string;
  /** daemon.ts's hook to mark an invocation "running" for the board's live projection (deliverable c)
   * — called synchronously right before `memberRunner.produce()`, so it brackets exactly the window
   * production is actually in flight. */
  onBeforeProduce?: (member: string, kind: string) => void;
}

/**
 * Advance one unit by exactly one flow step, if it can be advanced at all right now. Returns what
 * happened; never throws for an ordinary member failure (deliverable f — surfaced as a `blocked`
 * artifact instead, itself committed so it is visible in the repo, not a silent stall) or an
 * unauthorized start gate (returned as `halted`, not an error).
 */
export async function advanceUnit(root: string, repo: Repo, unit: WorkUnit, memberRunner: AsyncMemberRunner, opts: AdvanceOptions = {}): Promise<AdvanceResult> {
  if (unit.status !== "active") return { outcome: "nothing" };

  const unmet = unmetAfter(repo, unit);
  if (unmet.length > 0) return { outcome: "nothing" }; // invisible to the walk (§6) until satisfied.

  const hasAnyArtifact = (repo.artifacts.get(`${unit.project}/${unit.unit}`)?.size ?? 0) > 0;
  if (!hasAnyArtifact && !opts.startAuthorized) {
    // Ruling C8: EVERY unit's first flow step raises a start gate, regardless of `after:` — a plain
    // unit with no `after:` is not exempt. `after:` is only ever a precondition on when the gate may
    // be RAISED (unmetAfter above already returned "nothing" — invisible — until it's satisfied); it
    // is never a licence to skip the gate once satisfied or absent. The daemon must never cross this
    // line on its own (invariant 1) — only a Conductor's explicit `start` click
    // (board/gateops.ts#doStart) sets startAuthorized.
    return { outcome: "halted", reason: "start gate open; awaiting Conductor" };
  }

  // Declared limits (§6, §10), checked before producing anything — never after. Budget is ruling C3
  // (extended, PRD v1.1): crossing the (effective) budget RAISES a budget gate and halts THIS unit's
  // walk until the Conductor resolves it — never a global stop, never a silent overspend (deliverable
  // f). The daemon carries the C3 resolution memory in `opts.budget`: an effective budget lifted by a
  // prior `raise`, and the spend level a prior `continue`/`raise` acknowledged (below which the gate
  // does not re-raise — it informs, it never spams). This mirrors runner.ts#overBudget exactly; the
  // difference is only where the resolution comes from (the daemon's out-of-band `resolveBudget`
  // rather than an interactive DecisionSource).
  const effBudget = opts.budget?.eff ?? unit.budget;
  if (typeof effBudget === "number") {
    const spent = spentUsd(repo, unit);
    const ack = opts.budget?.ack;
    if (spent > effBudget && (ack === undefined || spent > ack)) {
      return {
        outcome: "budget-gate",
        spent,
        budget: effBudget,
        reason: `budget $${effBudget.toFixed(2)} crossed (spent $${spent.toFixed(2)}); awaiting Conductor`,
      };
    }
  }
  const limitS = timeboxSeconds(unit.timebox ?? repo.types.get(unit.type)?.timebox ?? null);
  if (limitS !== null) {
    const spentS = spentWallS(repo, unit);
    if (spentS > limitS) return { outcome: "halted", reason: `timebox ${limitS}s exceeded (spent ${spentS}s); awaiting Conductor` };
  }

  // Ruling C4 (per-KIND walk): advance the responsible teams in dependency order. A team whose flow is
  // already satisfied yields `nothing` and we move to the next (this is the shaping-team → build-team
  // handoff §6 describes); the first team with a producible action produces it; an open gate in any
  // team halts the whole walk (a later team's inputs depend on an earlier team's approved output).
  const teams = responsibleTeamsFor(repo, unit);
  if (teams.length === 0) {
    // NOTES F18: distinct from a step that binds to no member WITHIN a responsible team
    // (`unbindable`, above) — here no team in the whole studio produces anything this unit's type
    // needs at all, so `responsibleTeamsFor` never finds a team to even try. The pre-fix behaviour
    // was the defect: silently returning `nothing` forever, indistinguishable on the board and in the
    // Orchestrator's briefing from "this unit is simply not due for anything right now". Block it
    // LOUDLY instead, naming the specific missing kind, exactly like the `unbindable` case does for a
    // narrower binding failure — a Conductor reading the board must never have to guess why a unit
    // never moves.
    const type = repo.types.get(unit.type);
    const expects = type?.expects ?? [];
    if (expects.length > 0) {
      const producedAnywhere = new Set<string>();
      for (const t of repo.teams.values()) for (const k of t.produces) producedAnywhere.add(k);
      const missing = expects.find((k) => !producedAnywhere.has(k)) ?? expects[0];
      return blockUnit(root, unit, null, `${unit.type} needs \`${missing}\`; no team in this studio produces it`, missing, opts);
    }
    return { outcome: "nothing" };
  }

  const caps = memberRunner.capabilities();
  for (const team of teams) {
    const action = nextAction(repo, unit, team, caps);
    if (action.type === "halt") return { outcome: "halted", reason: action.reason };
    // NOTES F1: a step that binds to no member is a permanent, self-repeating failure — every later
    // tick would re-derive it and do nothing. Block the unit on disk with the reason attached, so it
    // is impossible for the walk to keep quietly skipping a unit no one is told about.
    if (action.type === "unbindable") return blockUnit(root, unit, team, action.reason, action.stepLabel, opts);
    if (action.type === "produce") {
      opts.onBeforeProduce?.(action.member, action.kind);
      return await produceOne(root, unit, team, action.member, action.kind, memberRunner, opts, action.loop);
    }
    // action.type === "nothing": this team's flow is fully satisfied — hand off to the next team.
  }
  return { outcome: "nothing" };
}

/**
 * NOTES F1: block a unit whose flow step binds to no member, LOUDLY. The unit's own `unit.md` gets
 * `status: blocked` and a `blocked_reason` carrying the resolution error verbatim, committed like any
 * other walk-driven write (files are the truth, invariant 2) — so the block survives a restart, the
 * board renders it as a gate the Conductor can see (board/derive.ts#openGates), and the daemon's
 * disk-truth re-derivation stops walking the unit instead of re-failing silently on every tick.
 *
 * The pre-F1 behaviour was the whole defect: the RunnerError was caught, converted to a `halt`, and
 * the daemon logged it to an in-memory ring buffer nobody reads. The unit sat "active" forever with
 * nothing happening and nothing to see. A failure that a human is never shown is a failure the system
 * pretends it doesn't have.
 */
function blockUnit(
  root: string,
  unit: WorkUnit,
  team: Team | null,
  reason: string,
  stepLabel: string,
  opts: AdvanceOptions,
): AdvanceResult {
  const commitFn = opts.commit ?? runnerCommit;
  const file = join(unit.dir, "unit.md");
  const src = readFileSync(file, "utf8");
  let patched = patchFrontmatter(src, { status: "blocked" });
  patched = upsertFrontmatterField(patched, "blocked_reason", reason);
  writeFileSync(file, patched);
  // NOTES F18: `team` is null when no team in the studio is even responsible for this unit at all
  // (the walk never got as far as trying to bind a step within one) — the commit message says so
  // rather than naming a team that was never in play.
  const cause = team ? `team ${team.name} cannot bind flow step '${stepLabel}'` : `no team produces '${stepLabel}'`;
  const commit = commitFn(root, [file], `block ${unit.unit}: ${cause}: ${reason.slice(0, 120)}`);
  return { outcome: "unbindable", reason, stepLabel, file, commit };
}

function spentUsd(repo: Repo, unit: WorkUnit): number {
  const m = repo.artifacts.get(`${unit.project}/${unit.unit}`);
  let sum = 0;
  if (m) for (const a of m.values()) if (typeof a.usage?.usd === "number") sum += a.usage.usd;
  return Math.round(sum * 100) / 100;
}

function spentWallS(repo: Repo, unit: WorkUnit): number {
  const m = repo.artifacts.get(`${unit.project}/${unit.unit}`);
  let sum = 0;
  if (m) for (const a of m.values()) if (typeof a.usage?.wall_clock_s === "number") sum += a.usage.wall_clock_s;
  return sum;
}

async function produceOne(
  root: string,
  unit: WorkUnit,
  team: Team,
  member: string,
  kind: string,
  memberRunner: AsyncMemberRunner,
  opts: AdvanceOptions,
  loop?: { round: number; supersedes?: string; extraConsumes?: string[] },
): Promise<AdvanceResult> {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const commitFn = opts.commit ?? runnerCommit;
  const verb = opts.verb ?? "advance";
  // Every daemon-produced artifact gets the deterministic kind-unit-vN slot id (matching the
  // convention board/gateops.ts's doStart established for E5) rather than trusting whatever id the
  // member boundary happens to emit — a mocked/stub member (invariant 10) renders the same fixed id
  // regardless of which unit asked, which would collide under the validator's project-scoped
  // DUPLICATE_ID check the moment a second unit produces the same kind. Round is always 1 for a plain
  // step (a later round of a PLAIN step is produced by board/gateops.ts#doRequest's own versioning);
  // for a loop member, round comes from `nextAction`'s own round-pairing (ruling C14, this file's
  // header note) — 1 for the first member's opening round, or the round-matched value for a companion.
  // The `-vN` convention has one home — runner.ts#bumpVersion — rather than a literal string here.
  const round = loop?.round ?? 1;
  const newId = bumpVersion(`${kind}-${unit.unit}`, round);

  let baseDoc: string;
  try {
    // NOTES F5: awaits either a plain result (every sync test double/stub) or a genuine, non-blocking
    // Promise (the real live AdapterRunner.produceAsync's CLI path) — see AsyncMemberRunner's own doc.
    // Ruling C14: `loop?.extraConsumes` hands a loop's companion (critic) member the round's own
    // author artifact, even though it is still in-review — see runner.ts's `MemberRunner.produce` doc.
    ({ doc: baseDoc } = await memberRunner.produce(member, kind, unit.unit, unit.project, loop?.extraConsumes));
  } catch (e) {
    return writeBlocked(root, unit, team, member, kind, newId, e, today, commitFn, verb);
  }

  let doc: string;
  try {
    const patches: Record<string, string | null> = { id: newId };
    if (loop?.supersedes) patches.supersedes = loop.supersedes;
    doc = patchFrontmatter(baseDoc, patches);
  } catch (e) {
    return writeBlocked(root, unit, team, member, kind, newId, e, today, commitFn, verb);
  }

  const errs = validateArtifactSource(doc, `${member}:${kind}`, unit.dir);
  if (errs.length > 0) {
    // NOTES F22: every accumulated error, not just the first — a Conductor fixing a produced
    // artifact's off-contract shape must see every problem in one blocked_reason, not one per retry.
    return writeBlocked(root, unit, team, member, kind, newId, new Error(formatValidationErrors(errs)), today, commitFn, verb);
  }

  const art = parseArtifactDoc(doc);
  const file = join(unit.dir, `${art.id}.md`);
  const files = [file];

  // Ruling C14: a loop companion produced for round > 1 supersedes the PRIOR round's live companion —
  // the same supersession board/gateops.ts#doRequest already does for the loop's first member, applied
  // here to the second so both halves of a round stay in lockstep. Round 1 has nothing to supersede.
  if (loop?.supersedes) {
    const located = locateArtifactFile(unit.dir, loop.supersedes);
    if (located) {
      const oldSrc = readFileSync(located.file, "utf8");
      // The prior round's companion may already be `approved` (ruling C2: any resolution of a loop's
      // first-member gate approves the round's companion, regardless of verb) — an approved artifact
      // superseded without clearing `approved_by` fails the validator's own invariant ("only an
      // approved artifact may name an approver"). Superseding always clears it, matching how a
      // never-approved (in-review) companion already carries `approved_by: null`.
      writeFileSync(located.file, patchFrontmatter(oldSrc, { status: "superseded", approved_by: null }));
      files.unshift(located.file);
    }
  }

  writeFileSync(file, doc);
  const roundNote = loop ? ` (loop round ${round})` : "";
  const commit = commitFn(root, files, `${verb} ${unit.unit} → ${team.name}/${member} produced ${art.kind} ${art.id}${roundNote}`);
  return { outcome: "produced", member, kind, artifactId: art.id, file, commit };
}

// Deliverable (f): a member error, a timeout (AdapterError), a guardrail violation, or an off-contract
// doc never crashes the daemon or stalls it silently — it becomes a `blocked` artifact IN the unit's
// own directory, occupying that kind's slot. This is what makes the failure genuinely visible (files
// are the truth) AND self-limiting: the next walk's `nextAction` sees a live artifact at status
// `blocked` for that kind and halts (the same rule already governing a rejected step), so a
// persistently-failing member is never retried in a tight loop.
function writeBlocked(
  root: string,
  unit: WorkUnit,
  team: Team,
  member: string,
  kind: string,
  id: string,
  error: unknown,
  today: string,
  commitFn: (root: string, files: string[], message: string) => string,
  verb: string,
): AdvanceResult {
  const msg = error instanceof Error ? error.message : String(error);
  const doc = [
    "---",
    `kind: ${kind}`,
    `id: ${id}`,
    `unit: ${unit.unit}`,
    `project: ${unit.project}`,
    "status: blocked",
    `produced_by: ${team.name}/${member}`,
    "consumes: []",
    "supersedes: null",
    "approved_by: null",
    `created: ${today}`,
    "files: []",
    "---",
    "",
    `# ${kind} — blocked`,
    "",
    `The daemon could not produce this artifact: ${msg}`,
    "",
  ].join("\n");
  const file = join(unit.dir, `${id}.md`);
  writeFileSync(file, doc);
  const commit = commitFn(root, [file], `${verb} ${unit.unit} → ${team.name}/${member} FAILED producing ${kind}: ${msg.slice(0, 120)}`);
  return { outcome: "blocked", member, kind, artifactId: id, file, commit, error: msg };
}

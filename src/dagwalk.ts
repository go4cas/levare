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
// Scope boundary (documented, not silently handled), two parts:
//   1. Within a loop, only the FIRST member (e.g. `spec`) is auto-advanced — never the companion
//      SECOND member (e.g. `review`). Auto-producing a companion the instant a first-member artifact
//      is merely observed in-review would retroactively "fill in" a companion for an artifact that may
//      predate the daemon entirely (the golden fixture's own standing spec gate has no review file and
//      never has — E3/NOTES), which on-disk state alone gives no way to distinguish from a companion
//      that was genuinely never meant to be auto-produced. `until` (a Conductor approval, invariant 4)
//      is what actually ends the loop; a missing companion review never blocks that.
//   2. A loop round AFTER the first (following a Conductor's request-changes) is already produced
//      synchronously by board/gateops.ts#doRequest at the moment the Conductor resolves the gate — by
//      the time any walker looks again, that round's artifact already exists in-review on disk, which
//      this module's own halt rule ("a live artifact of this kind already exists and is in-review →
//      halt") already handles correctly with no extra logic.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateArtifactSource } from "./validate.ts";
import { parseArtifactDoc } from "./repo.ts";
import type { Repo } from "./repo.ts";
import { RunnerError, timeboxSeconds, type MemberRunner } from "./runner.ts";
import { responsibleTeamFor, resolveStep, unmetAfter, patchFrontmatter } from "./gates.ts";
import { runnerCommit } from "./git.ts";
import type { Artifact, FlowLoop, Team, WorkUnit } from "./types.ts";

// ---------------------------------------------------------------------------
// Pure flow-position derivation (no I/O) — the piece under direct unit test.
// ---------------------------------------------------------------------------

export type NextAction =
  | { type: "produce"; member: string; kind: string; stepLabel: string }
  | { type: "halt"; reason: string }
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
        return { type: "halt", reason: e instanceof RunnerError ? e.message : String(e) };
      }
      const current = latestLiveArtifact(repo, unit, kind);
      if (!current) return { type: "produce", member, kind, stepLabel: node.step };
      if (current.status === "in-review") return { type: "halt", reason: `gate open on ${current.id}` };
      if (current.status === "approved") continue;
      return { type: "halt", reason: `${current.id} is ${current.status}; awaiting Conductor` };
    }
    if (node.kind === "loop") {
      // Scope boundary (documented — see this file's header note): the daemon auto-advances only the
      // loop's FIRST member, treated exactly like a plain step. It never auto-produces the SECOND
      // (companion review) member — doing so unconditionally the moment a first-member artifact is
      // merely observed in-review would retroactively "fill in" a companion for an artifact that may
      // predate the daemon entirely (e.g. a hand-authored fixture gate), which is both a surprising
      // mutation of state the daemon didn't create and indistinguishable, from on-disk state alone,
      // from a companion that genuinely was never meant to be auto-produced. `until` is what actually
      // ends the loop (via a Conductor approval, invariant 4) — a missing companion review never
      // blocks that.
      const loop = node as FlowLoop;
      if (untilSatisfied(repo, unit, loop.until)) continue;
      const [firstLabel] = loop.between;
      let first: { member: string; kind: string };
      try {
        first = resolveStep(team, firstLabel, capabilities);
      } catch (e) {
        return { type: "halt", reason: e instanceof RunnerError ? e.message : String(e) };
      }
      const firstArt = latestLiveArtifact(repo, unit, first.kind);
      if (!firstArt) return { type: "produce", member: first.member, kind: first.kind, stepLabel: firstLabel };
      if (firstArt.status === "in-review") return { type: "halt", reason: `gate open on ${firstArt.id}` };
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
  | { outcome: "nothing" };

export interface AdvanceOptions {
  /**
   * Only ever true for the ONE call board/gateops.ts#doStart makes, at the exact moment the
   * Conductor resolves a unit's start gate with the `start` verb — that HTTP call IS the Conductor
   * approval this production's causal chain rests on (invariant 1). The daemon's own autonomous
   * background walk (daemon.ts) NEVER sets this: a unit with a satisfied-but-never-started `after:`
   * is a standing open start gate the daemon must render inert to, forever, until a Conductor clicks
   * it — there is no persisted "queued"/"started" status to distinguish "not yet decided" from
   * "decided" any other way (NOTES A6), so the boolean itself, passed only from that one call site,
   * IS the entire mechanism preventing an autostart.
   */
  startAuthorized?: boolean;
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
export function advanceUnit(root: string, repo: Repo, unit: WorkUnit, memberRunner: MemberRunner, opts: AdvanceOptions = {}): AdvanceResult {
  if (unit.status !== "active") return { outcome: "nothing" };

  const unmet = unmetAfter(repo, unit);
  if (unmet.length > 0) return { outcome: "nothing" }; // invisible to the walk (§6) until satisfied.

  const hasAnyArtifact = (repo.artifacts.get(`${unit.project}/${unit.unit}`)?.size ?? 0) > 0;
  if (unit.after && unit.after.length > 0 && !hasAnyArtifact && !opts.startAuthorized) {
    // The start gate is open (after: just became satisfied) but no Conductor decision authorized
    // this unit to begin — the daemon must never cross this line on its own (invariant 1).
    return { outcome: "halted", reason: "start gate open; awaiting Conductor" };
  }

  // Declared limits (§6, §10), checked before producing anything — never after, since there is no
  // interactive continue/raise/stop decision source here (unlike runner.ts's own overBudget/
  // overTimebox): the daemon's only lever is to STOP inviting more spend, deterministically, and say
  // why (deliverable f — never a silent stall). A human raising the budget/timebox (editing the
  // unit's frontmatter, itself a repo change) is what un-halts this on a later tick.
  if (typeof unit.budget === "number") {
    const spent = spentUsd(repo, unit);
    if (spent > unit.budget) return { outcome: "halted", reason: `budget $${unit.budget.toFixed(2)} exceeded (spent $${spent.toFixed(2)}); awaiting Conductor` };
  }
  const limitS = timeboxSeconds(unit.timebox ?? repo.types.get(unit.type)?.timebox ?? null);
  if (limitS !== null) {
    const spentS = spentWallS(repo, unit);
    if (spentS > limitS) return { outcome: "halted", reason: `timebox ${limitS}s exceeded (spent ${spentS}s); awaiting Conductor` };
  }

  const team = responsibleTeamFor(repo, unit);
  if (!team) return { outcome: "nothing" };

  const action = nextAction(repo, unit, team, memberRunner.capabilities());
  if (action.type === "nothing") return { outcome: "nothing" };
  if (action.type === "halt") return { outcome: "halted", reason: action.reason };

  opts.onBeforeProduce?.(action.member, action.kind);
  return produceOne(root, unit, team, action.member, action.kind, memberRunner, opts);
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

function produceOne(
  root: string,
  unit: WorkUnit,
  team: Team,
  member: string,
  kind: string,
  memberRunner: MemberRunner,
  opts: AdvanceOptions,
): AdvanceResult {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const commitFn = opts.commit ?? runnerCommit;
  const verb = opts.verb ?? "advance";
  // Every daemon-produced artifact gets the deterministic kind-unit-v1 slot id (matching the
  // convention board/gateops.ts's doStart established for E5) rather than trusting whatever id the
  // member boundary happens to emit — a mocked/stub member (invariant 10) renders the same fixed id
  // regardless of which unit asked, which would collide under the validator's project-scoped
  // DUPLICATE_ID check the moment a second unit produces the same kind. Only ever round 1: a later
  // round is produced by board/gateops.ts#doRequest's own versioning (see this file's header note).
  const newId = `${kind}-${unit.unit}-v1`;

  let baseDoc: string;
  try {
    ({ doc: baseDoc } = memberRunner.produce(member, kind, unit.unit, unit.project));
  } catch (e) {
    return writeBlocked(root, unit, team, member, kind, newId, e, today, commitFn, verb);
  }

  let doc: string;
  try {
    doc = patchFrontmatter(baseDoc, { id: newId });
  } catch (e) {
    return writeBlocked(root, unit, team, member, kind, newId, e, today, commitFn, verb);
  }

  const errs = validateArtifactSource(doc, `${member}:${kind}`, unit.dir);
  if (errs.length > 0) {
    return writeBlocked(root, unit, team, member, kind, newId, new Error(`${errs[0].code}: ${errs[0].message}`), today, commitFn, verb);
  }

  const art = parseArtifactDoc(doc);
  const file = join(unit.dir, `${art.id}.md`);
  writeFileSync(file, doc);
  const commit = commitFn(root, [file], `${verb} ${unit.unit} → ${team.name}/${member} produced ${art.kind} ${art.id}`);
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

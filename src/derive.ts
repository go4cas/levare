// Pure derivation helpers over a loaded `Repo` (PRD §9): open gates, score nodes, spend, lineage,
// summaries. Core domain logic, not board-specific — the board's render path and
// orchestrator-projection.ts (the Orchestrator's studio view, ruling C10) both derive from the exact
// same functions here, so the two surfaces never quietly disagree on what an "open gate" or a unit's
// spend is. Every function takes already-loaded repo data and returns either a display string or a
// small derived shape — no I/O, no clock reads except where a `now` is passed in explicitly, so
// callers (render + tests) can pin it. Lives at the top level of src/ (not src/board/) because it was
// core all along — moved here after the layering inversion review found orchestrator-projection.ts,
// core domain, reaching into src/board/ for logic it needed just as much as the board did.

import type { Artifact, ArtifactStatus, Team, TypeTemplate, Usage, WorkUnit } from "./types.ts";
import type { Repo } from "./repo.ts";
import { firstParagraph, repoCapabilities } from "./repo.ts";
import { isLoopCompanionKind, loopMembershipFor, responsibleTeamsFor, unreachableExpectedKinds } from "./gates.ts";
import { roundOf } from "./runner.ts";
import type { DaemonInvocation } from "./daemon.ts";

export function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Fault 4: `**bold**` — the one inline-emphasis convention member-authored bodies actually use
// (adapters.ts's own stub brief opens "**Problem.** The current three-page checkout loses buyers...")
// — was rendering as literal asterisks anywhere a unit summary is shown outside its own artifact page,
// because those call sites (project.ts's work-unit cards, studio.ts's in-flight project card) ran
// `unitSummary`'s output through plain `esc()` alone. Escapes FIRST, then converts already-escaped
// `**…**` pairs to `<strong>` — never trusts raw member text as HTML input. Block-level markdown
// (headings, paragraph breaks) is a separate concern `shell.ts#renderBody` already owns; a unit
// summary is always a single already-extracted paragraph (`firstParagraph`), so only the inline case
// applies here.
export function renderInline(s: string): string {
  return esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

/** "31k tok · ~$0.58", "unreported", or "" when there is no usage at all. */
export function costLabel(usage: Usage | null | undefined): string {
  if (!usage) return "";
  const parts: string[] = [];
  if (typeof usage.tokens_in === "number" || typeof usage.tokens_out === "number") {
    const total = (usage.tokens_in ?? 0) + (usage.tokens_out ?? 0);
    parts.push(`${tokLabel(total)} tok`);
  }
  if (typeof usage.usd === "number") parts.push(`~$${usage.usd.toFixed(2)}`);
  return parts.join(" &middot; ");
}

export function tokLabel(n: number): string {
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/**
 * "14m", "2h", "3d" — coarse age from an ISO-ish timestamp to `now`.
 *
 * NOTES "created timestamp": every artifact `created` now carries a full UTC timestamp (not a bare
 * date), so `new Date(fromIso)` here already resolves to the real instant a member was dispatched —
 * an artifact read a minute after it was produced correctly buckets as "just now", not "Nh" from a
 * fabricated midnight. A pre-change bare-date artifact (`YYYY-MM-DD`, still permanently valid per
 * validate.ts) parses as that day's UTC midnight — the honest reading for a value that never recorded
 * a time of day — so its displayed age is coarser, never wrong.
 */
export function ageLabel(fromIso: string, now: Date): string {
  const from = new Date(fromIso);
  if (Number.isNaN(from.getTime())) return "";
  const deltaMs = Math.max(0, now.getTime() - from.getTime());
  const mins = Math.floor(deltaMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * NOTES UI11: a message caption's short relative time ("now"/"2m"/"1h"/"3d") plus the full ISO
 * timestamp for the hover title — same coarse buckets as `ageLabel`, but "now" (not "just now") for
 * the first minute, since a conversation caption reads more naturally that way than an artifact's age
 * does. Every server-rendered Orchestrator caption is stamped at the render's own `now`, so the delta
 * is always zero — the bucketing exists for the identical client-side computation in assets/app.js,
 * which mirrors this exact arithmetic for turns appended after the page loaded.
 */
export function captionTime(fromIso: string, now: Date): { text: string; title: string } {
  const from = new Date(fromIso);
  const mins = Math.max(0, Math.floor((now.getTime() - from.getTime()) / 60000));
  const text = mins < 1 ? "now" : mins < 60 ? `${mins}m` : Math.floor(mins / 60) < 24 ? `${Math.floor(mins / 60)}h` : `${Math.floor(mins / 1440)}d`;
  return { text, title: from.toISOString() };
}

// ---------------------------------------------------------------------------
// Gates (ruling C2: an artifact at in-review always means an open gate)
// ---------------------------------------------------------------------------

export interface OpenGate {
  // NOTES F19: "artifact-blocked" is a member's FAILURE to produce (dagwalk.ts#writeBlocked) —
  // distinct from "blocked" (a UNIT the walk could not advance at all, F1/F18) and from "artifact"
  // (an in-review artifact awaiting a content decision). It carries its own verbs: retry/skip/abandon.
  type: "artifact" | "start" | "blocked" | "artifact-blocked";
  project: string;
  unit: string;
  /** The artifact id for an artifact-shaped gate; the unit id for a start or blocked gate. */
  target: string;
  artifact?: Artifact;
  team?: Team;
  member?: string;
  label: string;
  /** Why a blocked unit is blocked (its `blocked_reason`) — NOTES F1. */
  reason?: string;
  /**
   * NOTES F20: set only on the artifact a loop's `until` condition actually names (the one gate a
   * loop ever raises — F16). The server already refuses a `request` past `maxRounds` (ruling C14,
   * `board/gateops.ts#doRequest`) — this is what lets the BOARD say so too, before the Conductor ever
   * clicks: `exhausted` is true once this round is the loop's last without `until` satisfied, so the
   * card can state the round count up front and disable "Request changes" instead of silently
   * discarding it after a refused round-trip.
   */
  loop?: { round: number; maxRounds: number; until: string; exhausted: boolean };
}

/**
 * Every open gate in the repo: artifacts at in-review, plus start gates. Ruling C8: EVERY active
 * unit that hasn't produced anything yet carries an open start gate, regardless of `after:` — a
 * unit with `after:` is additionally invisible (no gate at all) until every dependency has shipped;
 * `after:` only ever governs WHEN the gate may be raised, never whether it exists.
 */
export function openGates(repo: Repo): OpenGate[] {
  const gates: OpenGate[] = [];
  const capabilities = repoCapabilities(repo);
  for (const unit of repo.units) {
    const key = `${unit.project}/${unit.unit}`;
    const artifacts = repo.artifacts.get(key);
    if (artifacts) {
      for (const art of artifacts.values()) {
        // NOTES F19: a blocked artifact (a member ran and failed — dagwalk.ts#writeBlocked) raises
        // its own gate, distinct from an in-review one — retry/skip/abandon, never approve/reject/
        // request. Previously invisible entirely: `openGates` skipped anything not `in-review`, so a
        // failed member left NO gate at all, and the only way past it was deleting the file by hand.
        if (art.status === "blocked") {
          const [teamName, member] = art.produced_by.split("/");
          gates.push({
            type: "artifact-blocked",
            project: unit.project,
            unit: unit.unit,
            target: art.id,
            artifact: art,
            team: repo.teams.get(teamName),
            member,
            label: art.kind,
          });
          continue;
        }
        if (art.status !== "in-review") continue;
        const [teamName, member] = art.produced_by.split("/");
        const team = repo.teams.get(teamName);
        // Ruling F16: while a loop is in progress, only the artifact its `until` condition actually
        // names may raise a gate — the loop's OTHER member (e.g. the author, while a critic's
        // `until: review.approved` is what the loop is waiting on) never independently gates; its
        // resolution rides on the until-named artifact's own gate (board/gateops.ts). Without this, a
        // round's two artifacts both showed as open gates, and resolving the wrong one left the other
        // stranded `in-review` forever with `until` unreachable.
        if (team && isLoopCompanionKind(team, art.kind, capabilities)) continue;
        // NOTES F20: this is, by construction, the loop's ONLY gate-raising artifact when it belongs
        // to one at all (the companion is skipped above) — round/exhaustion info the card needs to
        // state the round count and disable "Request changes" before the Conductor ever clicks it.
        const membership = team ? loopMembershipFor(team, art.kind, capabilities) : undefined;
        const loop = membership
          ? { round: roundOf(art.id), maxRounds: membership.loop.maxRounds, until: membership.loop.until, exhausted: roundOf(art.id) >= membership.loop.maxRounds }
          : undefined;
        gates.push({
          type: "artifact",
          project: unit.project,
          unit: unit.unit,
          target: art.id,
          artifact: art,
          team,
          member,
          label: art.kind,
          loop,
        });
      }
    }
    if (unit.status === "active") {
      const unmet = (unit.after ?? []).filter((id) => !unitShipped(repo, unit.project, id));
      const hasAnyArtifact = (artifacts?.size ?? 0) > 0;
      if (unmet.length === 0 && !hasAnyArtifact) {
        gates.push({ type: "start", project: unit.project, unit: unit.unit, target: unit.unit, label: "start" });
      }
    }
    // NOTES F1: a unit the walk BLOCKED (it could not bind a flow step to any member) carries its
    // reason on disk. It is on the Conductor — the studio needs fixing before this unit can move —
    // so it belongs in the same inbox as every other thing that is on them. A block the Conductor is
    // never shown is exactly the silent stall F1 was.
    if (unit.status === "blocked" && unit.blocked_reason) {
      gates.push({
        type: "blocked",
        project: unit.project,
        unit: unit.unit,
        target: unit.unit,
        label: "blocked",
        reason: unit.blocked_reason,
      });
    }
  }
  return gates;
}

function unitShipped(repo: Repo, project: string, unitId: string): boolean {
  return repo.units.some((u) => u.project === project && u.unit === unitId && u.status === "shipped");
}

/**
 * The Orchestrator briefing's one-line summary of a unit's open gate (run.ts's own conversation
 * turn). Previously named the artifact's kind (`gate.label`) with the fixed suffix "is ready for
 * review below" regardless of `gate.type` — true for an in-review artifact, but a lie for an
 * `artifact-blocked` gate (nothing to review; a member FAILED) or a `blocked` unit (nothing was even
 * produced). A Conductor reading a blocked review's briefing saw "review is ready for review below."
 */
export function gateBriefingSentence(gate: OpenGate): string {
  switch (gate.type) {
    case "artifact":
      return `${esc(gate.label)} is ready for review below.`;
    case "artifact-blocked":
      return `${esc(gate.label)} failed and needs your decision below.`;
    case "start":
      return "This unit is ready to start below.";
    case "blocked":
      return "This unit is blocked and needs your attention below.";
  }
}

// ---------------------------------------------------------------------------
// Mini-score / score dots (PRD §9: "state nodes in the canonical palette")
// ---------------------------------------------------------------------------

// "unreachable" (fault 1 fix): a kind the unit's type `expects:` but no member of its responsible
// team can ever produce (flow.ts#unreachableExpectedKinds) — distinct from "wait" (a kind that IS
// reachable and just hasn't been produced yet, which real progress or a Conductor action resolves).
// An unreachable stage never resolves on its own; conflating it with "wait" is what let the rail claim
// a Conductor was waiting on progress that could never come.
export type NodeState = "done" | "active" | "gate" | "wait" | "rejected" | "blocked" | "unreachable";
export interface ScoreNode {
  kind: string;
  shape: "dot" | "diamond";
  state: NodeState;
  artifact?: Artifact;
  producedBy?: string;
  /** Set only on a genuinely in-flight "active" node (Phase 2 cluster 3, part 4 — amendment 1 §2 R4
   * tier 3): the daemon invocation actually producing this kind right now, so the run view's live
   * strip has real anchors — an actual `startedAt` to compute elapsed from, and (when this kind
   * belongs to a review loop) a real round count — rather than fabricated numbers. There is no live
   * token count anywhere in the system (usage is only known once a member's call completes and the
   * ledger is written), so the live strip deliberately never shows one — inventing a ticking number
   * with nothing behind it would violate the board's own "never lie" projection invariant.
   * `until`/`onExhaust` (goal "registry cards legibility", item 2 ruling): the registry card moved the
   * loop's bound/escalation to a hover/focus affordance, since the enclosure can no longer carry that
   * text inline without pulling the loop off the sequence. Hover hides it on touch, in screenshots, and
   * from anyone auditing the registry — so the SAME two facts render unconditionally here, where the
   * loop is actually executing and the round counter is already live, never behind an interaction. */
  live?: { startedAt: string; loop?: { round: number; maxRounds: number; until: string; onExhaust: string } };
}

/**
 * One node per kind in the unit's type `expects:` list, derived from the current (non-superseded)
 * artifact of that kind. A kind with no artifact yet is "wait" — unless a daemon invocation is
 * genuinely producing it right now (`running`), in which case it is the canonical palette's real
 * "active" (Phase 2 cluster 3 part 4: this was previously unreachable — see `live` above). An
 * artifact at in-review is the gate itself (diamond, ruling C2) — never a plain "active" circle.
 * `running` defaults to `[]` so every pre-existing call site (which has no daemon invocation to pass)
 * is unaffected.
 */
export function scoreNodes(repo: Repo, unit: WorkUnit, running: DaemonInvocation[] = []): ScoreNode[] {
  const type = repo.types.get(unit.type);
  const expects = type?.expects ?? [];
  const artifacts = [...(repo.artifacts.get(`${unit.project}/${unit.unit}`)?.values() ?? [])];
  const inv = running.find((r) => r.project === unit.project && r.unit === unit.unit);
  const capabilities = repoCapabilities(repo);
  const unreachable = new Set(unreachableExpectedKinds(repo, unit, capabilities));
  return expects.map((kind) => {
    // Prefer the live (non-superseded) artifact of this kind; fall back to the most recent one so a
    // rejected/blocked kind still renders its true state rather than reading as untouched.
    const live = artifacts.filter((a) => a.kind === kind);
    const current = live.find((a) => a.status !== "superseded") ?? live[live.length - 1];
    if (!current) {
      if (inv && inv.kind === kind) {
        // The invocation names a bare member, not `team/member` (dagwalk.ts's own `action.member`) —
        // resolve which responsible team actually owns it so the avatar column reads exactly like an
        // artifact's own `produced_by` does everywhere else on the board.
        const team = responsibleTeamsFor(repo, unit).find((t) => t.members.includes(inv.member));
        const membership = team ? loopMembershipFor(team, kind, capabilities) : undefined;
        const loop = membership
          ? { round: live.length + 1, maxRounds: membership.loop.maxRounds, until: membership.loop.until, onExhaust: membership.loop.onExhaust }
          : undefined;
        return {
          kind,
          shape: "dot",
          state: "active",
          producedBy: team ? `${team.name}/${inv.member}` : inv.member,
          live: { startedAt: inv.startedAt, loop },
        };
      }
      // Fault 1: a kind no member of the responsible team can ever produce is not "wait" — nothing
      // arriving changes it, and rendering it as an ordinary queued step tells a Conductor to keep
      // watching for progress that cannot come.
      if (unreachable.has(kind)) return { kind, shape: "dot", state: "unreachable" };
      return { kind, shape: "dot", state: "wait" };
    }
    const state = nodeStateFor(current.status);
    return {
      kind,
      shape: state === "gate" ? "diamond" : "dot",
      state,
      artifact: current,
      producedBy: current.produced_by,
    };
  });
}

function nodeStateFor(status: ArtifactStatus): NodeState {
  switch (status) {
    case "approved":
      return "done";
    case "in-review":
      return "gate";
    case "rejected":
      return "rejected";
    case "blocked":
      return "blocked";
    default:
      return "wait";
  }
}

// ---------------------------------------------------------------------------
// Constitution: founding artifacts + citation counts (project view)
// ---------------------------------------------------------------------------

export interface FoundingArtifact {
  artifact: Artifact;
  citations: number;
  superseded: Artifact[];
}

/** Founding artifacts = artifacts with no `consumes` (the DAG roots) for a project. */
export function foundingArtifacts(repo: Repo, project: string): FoundingArtifact[] {
  const all: Artifact[] = [];
  for (const unit of repo.units) {
    if (unit.project !== project) continue;
    const m = repo.artifacts.get(`${unit.project}/${unit.unit}`);
    if (m) all.push(...m.values());
  }
  const roots = all.filter((a) => a.consumes.length === 0 && a.status !== "superseded");
  return roots.map((a) => ({
    artifact: a,
    citations: all.filter((x) => x.consumes.includes(a.id)).length,
    superseded: all.filter((x) => x.supersedes === a.id),
  }));
}

// ---------------------------------------------------------------------------
// Unit summary line (NOTES A8: an artifact's first paragraph is the display summary)
// ---------------------------------------------------------------------------

/** The unit's leading artifact — the open gate's artifact if any, else the most recently created. */
export function leadingArtifact(repo: Repo, unit: WorkUnit): Artifact | undefined {
  const m = repo.artifacts.get(`${unit.project}/${unit.unit}`);
  if (!m) return undefined;
  const all = [...m.values()];
  const gate = all.find((a) => a.status === "in-review");
  if (gate) return gate;
  return all.filter((a) => a.status !== "superseded").sort((a, b) => a.created.localeCompare(b.created)).pop();
}

export function unitSummary(repo: Repo, unit: WorkUnit): string {
  const art = leadingArtifact(repo, unit);
  if (art && art.body) return firstParagraph(art.body);
  return "";
}

// ---------------------------------------------------------------------------
// Cost aggregation
// ---------------------------------------------------------------------------

export function unitSpend(repo: Repo, unit: WorkUnit): { usd: number; tokens: number } {
  const m = repo.artifacts.get(`${unit.project}/${unit.unit}`);
  let usd = 0;
  let tokens = 0;
  if (m) {
    for (const a of m.values()) {
      if (typeof a.usage?.usd === "number") usd += a.usage.usd;
      tokens += (a.usage?.tokens_in ?? 0) + (a.usage?.tokens_out ?? 0);
    }
  }
  return { usd: Math.round(usd * 100) / 100, tokens };
}

export function repoSpend(repo: Repo): number {
  let usd = 0;
  for (const unit of repo.units) usd += unitSpend(repo, unit).usd;
  return Math.round(usd * 100) / 100;
}

/** Spend across every unit in one project — the project-scoped twin of `repoSpend`. */
export function projectSpend(repo: Repo, project: string): number {
  let usd = 0;
  for (const unit of repo.units.filter((u) => u.project === project)) usd += unitSpend(repo, unit).usd;
  return Math.round(usd * 100) / 100;
}

/**
 * Median count of `review`-kind artifacts per unit, across a project's units. Null with no units.
 *
 * NOTES "created timestamp" investigation: this is a PROJECT-WIDE statistic — the median, across every
 * unit in the project, of how many rounds THAT unit's own review loop took (a loop's author and
 * companion kinds are produced in lockstep each round, so counting one loop-companion kind's live+
 * superseded artifacts for a unit already equals that unit's own round count) — not a per-unit one. A
 * project where most units converge in round 1 and a single unit runs long (e.g. six rounds) correctly
 * reads a low median: that is what a median is FOR, resisting distortion from one outlier, unlike a
 * mean which the six-round unit would pull up. Reading "1" here while one specific unit ran six rounds
 * is not a bug — it says most of this project's units needed only one round; the outlier unit's own
 * round count is a fact about THAT unit, visible on its own project page, not this project-wide figure.
 * A unit type whose flow has no review step at all contributes 0, same as a unit that converged before
 * any round completed — both correctly mean "no review rounds recorded for this unit."
 */
export function medianReviewRounds(repo: Repo, project: string): number | null {
  const counts: number[] = [];
  for (const unit of repo.units) {
    if (unit.project !== project) continue;
    const m = repo.artifacts.get(`${unit.project}/${unit.unit}`);
    counts.push(m ? [...m.values()].filter((a) => a.kind === "review").length : 0);
  }
  if (counts.length === 0) return null;
  counts.sort((a, b) => a - b);
  const mid = Math.floor(counts.length / 2);
  return counts.length % 2 ? counts[mid] : (counts[mid - 1] + counts[mid]) / 2;
}

// ---------------------------------------------------------------------------
// Project-card anatomy (item 2, phase 7.5): status chip, name, one-sentence A8 summary, mono meta
// line (unit count, deploy target, latest release).
// ---------------------------------------------------------------------------

/**
 * The unit a project card summarizes (ruling A8): the newest unit currently at a gate, else the
 * newest active unit, else undefined (no work yet). "Newest" is read from the unit's leading
 * artifact's own `created` date (real authored data) rather than filesystem mtime, which a fresh git
 * checkout stamps uniformly and so carries no real recency signal. A unit with no artifact yet sorts
 * last (empty recency key), never first.
 */
export function mostRelevantUnit(repo: Repo, project: string): WorkUnit | undefined {
  const units = repo.units.filter((u) => u.project === project);
  const gatedUnitNames = new Set(openGates(repo).filter((g) => g.project === project).map((g) => g.unit));
  const gated = units.filter((u) => gatedUnitNames.has(u.unit));
  const pool = gated.length ? gated : units.filter((u) => u.status === "active");
  if (pool.length === 0) return undefined;
  const recency = (u: WorkUnit) => leadingArtifact(repo, u)?.created ?? "";
  return [...pool].sort((a, b) => recency(b).localeCompare(recency(a)))[0];
}

/**
 * Shipped units in a project, most recent first — the closest honest proxy for "releases" the
 * schema supports today (there is no dedicated release/changelog concept; see NOTES.md). Capped at
 * `limit` (project view item 6d: show the most recent few, not all).
 */
export function recentReleases(repo: Repo, project: string, limit = 3): WorkUnit[] {
  const shipped = repo.units.filter((u) => u.project === project && u.status === "shipped");
  const recency = (u: WorkUnit) => leadingArtifact(repo, u)?.created ?? "";
  return [...shipped].sort((a, b) => recency(b).localeCompare(recency(a))).slice(0, limit);
}

/** Most recently shipped unit in a project — `recentReleases`'s own head. */
export function latestRelease(repo: Repo, project: string): WorkUnit | undefined {
  return recentReleases(repo, project, 1)[0];
}

/**
 * NOTES UI11: the left nav's Projects section orders by real recency, not declared/insertion order —
 * the newest `created` date among any artifact anywhere in the project (never filesystem mtime, same
 * reasoning as `mostRelevantUnit` above). A project with no artifacts yet sorts last (empty recency
 * key), never first.
 */
export function projectLastActivity(repo: Repo, project: string): string {
  let latest = "";
  for (const unit of repo.units) {
    if (unit.project !== project) continue;
    const artifacts = repo.artifacts.get(`${unit.project}/${unit.unit}`);
    if (!artifacts) continue;
    for (const a of artifacts.values()) if (a.created > latest) latest = a.created;
  }
  return latest;
}

// ---------------------------------------------------------------------------
// Artifact lineage (item 1, phase 7.5): consumes/supersedes resolved to real artifacts, plus the two
// reverse edges (superseded-by, cited-by) files never declare directly. Searches the whole project,
// not just one unit, since `consumes` may cross a project's units (see the founding-artifact model).
// ---------------------------------------------------------------------------

/** Find an artifact by id anywhere in a project (not just the current unit). */
export function findArtifactInProject(repo: Repo, project: string, id: string): Artifact | undefined {
  for (const unit of repo.units) {
    if (unit.project !== project) continue;
    const a = repo.artifacts.get(`${unit.project}/${unit.unit}`)?.get(id);
    if (a) return a;
  }
  return undefined;
}

/** The artifact (if any) whose `supersedes` names this id — the reverse of `supersedes`. */
export function supersededByOf(repo: Repo, project: string, id: string): Artifact | undefined {
  for (const unit of repo.units) {
    if (unit.project !== project) continue;
    for (const a of repo.artifacts.get(`${unit.project}/${unit.unit}`)?.values() ?? []) {
      if (a.supersedes === id) return a;
    }
  }
  return undefined;
}

/** Every artifact in the project whose `consumes` names this id. */
export function citedByOf(repo: Repo, project: string, id: string): Artifact[] {
  const out: Artifact[] = [];
  for (const unit of repo.units) {
    if (unit.project !== project) continue;
    for (const a of repo.artifacts.get(`${unit.project}/${unit.unit}`)?.values() ?? []) {
      if (a.consumes.includes(id)) out.push(a);
    }
  }
  return out;
}

/**
 * Median days from an artifact's `created` to its `approved_by` ISO date, across approved artifacts.
 *
 * NOTES "created timestamp": `created` is a full UTC timestamp (or, for a pre-change artifact, a bare
 * date read as that day's UTC midnight — see `ageLabel`'s own doc); `approved_by`'s date is
 * deliberately left at day granularity (board/gateops.ts's `ResolveOpts.today`), extracted here via
 * regex, its time of day never recorded. Interpreting that extracted date as its own UTC midnight and
 * diffing against `created`'s real precision is what stops a gate opened and approved hours apart, but
 * straddling a UTC midnight, from reading a full day: previously BOTH sides floored to midnight, so a
 * gate opened at 23:00 and approved at 00:05 the next day read exactly 1.0 days; now only the
 * approval side floors, so the same case reads roughly `5/1440` days — correctly near zero, not "1d".
 * The residual imprecision (approval's own time of day is genuinely unknown) is real but small,
 * bounded by one day, and never inflates a same-day round-trip into "1d" the way the old day-floored
 * `created` systematically did.
 */
export function medianGateResponseDays(repo: Repo): number | null {
  const deltas: number[] = [];
  for (const unit of repo.units) {
    const m = repo.artifacts.get(`${unit.project}/${unit.unit}`);
    if (!m) continue;
    for (const a of m.values()) {
      if (a.status !== "approved" || !a.approved_by) continue;
      const m2 = /(\d{4}-\d{2}-\d{2})/.exec(a.approved_by);
      if (!m2) continue;
      const created = new Date(a.created).getTime();
      const approved = new Date(m2[1]).getTime();
      if (Number.isNaN(created) || Number.isNaN(approved)) continue;
      deltas.push(Math.max(0, (approved - created) / 86400000));
    }
  }
  if (deltas.length === 0) return null;
  deltas.sort((a, b) => a - b);
  const mid = Math.floor(deltas.length / 2);
  return deltas.length % 2 ? deltas[mid] : (deltas[mid - 1] + deltas[mid]) / 2;
}

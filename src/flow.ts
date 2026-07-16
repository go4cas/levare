// levare shared flow-resolution semantics (§6, NOTES R3). The pure policy rules the Runner's batch
// walk (runner.ts) and the live walk (dagwalk.ts) both execute, plus what the board's gate-resolution
// helpers (gates.ts) and studio validation (validate.ts) need to agree with them on: which team is
// responsible for a unit (including a unit's `team:` override), which member/kind satisfies a flow
// step label, and when a loop's `until` condition holds. This module has exactly one dependency —
// types.ts — and nothing here ever imports anything that could import it back; every module
// downstream of it (runner.ts, gates.ts, dagwalk.ts, validate.ts) can safely depend on this without a
// cycle. Before this module existed, all four kept hand-mirrored "independent copies" of these rules
// to dodge exactly that cycle risk (each copy's own comment named the circular import it was
// avoiding) — the copies drifted once (ruling C14: the Runner's batch walk and the live walk's own
// `untilSatisfied` disagreed on when a loop was actually done) and stood as a bug factory afterward.
// There is now one definition; nothing downstream re-derives it.
//
// `FlowRepo` is a structural subset of repo.ts's `Repo` (teams/types/units only), described here
// rather than imported from repo.ts — repo.ts itself imports validate.ts, and validate.ts needs this
// module, so importing `Repo` here would recreate the exact cycle this module exists to end. Every
// real `Repo` already satisfies this shape structurally, so callers just pass one straight through.

import type { Artifact, Team, TypeTemplate, WorkUnit } from "./types.ts";

/** A flow-resolution failure: a step binds to no member, or to more than one. Never guessed through. */
export class RunnerError extends Error {}

export interface FlowRepo {
  teams: Map<string, Team>;
  types: Map<string, TypeTemplate>;
  units: WorkUnit[];
}

/** A kind matches a flow step label exactly, or by the `kind-suffix` convention (`brief` → `product-brief`). */
export function kindMatches(kind: string, stepLabel: string): boolean {
  return kind === stepLabel || kind.endsWith(`-${stepLabel}`);
}

/**
 * The teams responsible for a unit's flow, in the order the walk should run them (ruling C4 — the
 * per-KIND semantics, not the old per-unit shortcut). PRD §6: "find producible kinds ... and invoke
 * the team that produces each" — this is how a unit hands from a shaping team to a build team. We
 * return every team that produces at least one of the unit type's `expects` kinds, ordered by the
 * EARLIEST expected kind each team produces (the type's `expects` list is dependency-ordered, so the
 * shaping team — which produces the first kinds — sorts ahead of a build team that produces later
 * ones), ties broken by name. The walk advances each team's flow in turn: a team whose flow is fully
 * satisfied yields nothing and the walk moves to the next; a team with an open gate halts the walk
 * (a later team's inputs depend on an earlier team's approved output, so the ordering + halt-
 * propagation is what enforces the cross-team `consumes` dependency).
 *
 * While a unit's type is served by a single team (every fixture until a multi-team one lands), this
 * returns that one team and the walk behaves exactly as the old per-unit heuristic did — the
 * divergence only appears the moment two teams produce different kinds for one unit.
 */
export function responsibleTeamsFor(repo: FlowRepo, unit: WorkUnit): Team[] {
  const type = repo.types.get(unit.type);
  const expects = type?.expects ?? [];
  // Ruling C12/F10 defect 2: an explicit `team:` override names the SOLE responsible team — never
  // guessed via produces∩expects scoring, which is exactly what silently picks a team when two of
  // them both produce a kind this unit needs (validate.ts#validateResponsibleTeam rejects that
  // ambiguity up front unless this override resolves it).
  if (unit.team) {
    const named = repo.teams.get(unit.team);
    return named ? [named] : [];
  }
  const scored: Array<{ team: Team; earliest: number }> = [];
  for (const team of repo.teams.values()) {
    const producedHere = team.produces.filter((k) => expects.includes(k));
    if (producedHere.length === 0) continue;
    const earliest = Math.min(...producedHere.map((k) => expects.indexOf(k)));
    scored.push({ team, earliest });
  }
  scored.sort((a, b) => a.earliest - b.earliest || a.team.name.localeCompare(b.team.name));
  return scored.map((s) => s.team);
}

/**
 * The single team that owns a unit's FIRST production (§6) — the head of the dependency-ordered
 * `responsibleTeamsFor` list. This is what the start gate / board `start` verb needs (the team whose
 * first flow step the Conductor is authorizing); the full walk uses `responsibleTeamsFor` to hand a
 * unit across teams. Null when no team produces any of the unit type's kinds.
 */
export function responsibleTeamFor(repo: FlowRepo, unit: WorkUnit): Team | null {
  return responsibleTeamsFor(repo, unit)[0] ?? null;
}

/**
 * Resolve a flow step label to the (member, kind) that satisfies it: a team member who can produce a
 * kind matching the label, exactly or by suffix (step `brief` → kind `product-brief`). Ambiguity or
 * absence is a hard error — a misconfigured flow fails loudly, never silently guesses.
 */
export function resolveStep(
  team: Team,
  stepLabel: string,
  capabilities: Array<{ member: string; kind: string }>,
): { member: string; kind: string } {
  const caps = capabilities.filter((c) => team.members.includes(c.member) && kindMatches(c.kind, stepLabel));
  if (caps.length === 0) {
    throw new RunnerError(`no member of team '${team.name}' can produce a kind for flow step '${stepLabel}'`);
  }
  if (caps.length > 1) {
    const opts = caps.map((c) => `${c.member}:${c.kind}`).join(", ");
    throw new RunnerError(`flow step '${stepLabel}' is ambiguous in team '${team.name}' (${opts})`);
  }
  return caps[0];
}

/** A unit's unmet `after:` ids — [] means the start gate condition is satisfied. */
export function unmetAfter(repo: FlowRepo, unit: WorkUnit): string[] {
  if (!unit.after || unit.after.length === 0) return [];
  return unit.after.filter((id) => !repo.units.some((u) => u.project === unit.project && u.unit === id && u.status === "shipped"));
}

/** `kind.status` — e.g. `spec.approved`. True when SOME artifact of that kind (in the given per-unit
 * artifact map) holds that status; a superseded artifact's own status is `superseded`, never the
 * status it held before, so this naturally only ever matches a live or terminally-resolved one. Takes
 * the artifact map directly (not a `FlowRepo`) so both the Runner's own per-run mutable map
 * (runner.ts's `this.artifacts`, updated as the batch walk produces/approves) and the live walk's
 * on-disk snapshot (dagwalk.ts's `repo.artifacts`, re-loaded before every call) can call the exact
 * same function without either needing to look like the other's container. */
export function untilSatisfied(artifacts: Map<string, Map<string, Artifact>>, unit: WorkUnit, until: string): boolean {
  const [kind, wantStatus] = until.split(".");
  const m = artifacts.get(`${unit.project}/${unit.unit}`);
  if (!m) return false;
  for (const a of m.values()) {
    if (a.kind === kind && a.status === wantStatus) return true;
  }
  return false;
}

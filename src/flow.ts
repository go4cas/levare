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

import type { Artifact, FlowNode, Team, TypeTemplate, WorkUnit } from "./types.ts";

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

/**
 * Kinds in the unit's type `expects:` list that no member of its responsible team(s) can actually
 * produce — a kind the type's SHAPE calls for, but this particular unit's team can never deliver, no
 * matter how long it waits. Checked against real per-member capabilities (the same ground truth
 * `resolveStep` binds a flow step against), never against a team's own declared `produces:` aggregate —
 * that field can promise more than its members back (UNPRODUCIBLE_KIND) or, just as easily, simply omit
 * a kind a member genuinely produces (`teams/kestrel.md` declares `produces: [product-brief, design,
 * spec]` while its member `finch` produces `review` — team-level `produces:` was never the authority on
 * what the team can actually do). Empty when every expected kind is reachable, or when the unit has no
 * responsible team at all (a different, already-reported failure — see validateResponsibleTeam/
 * validateStudioBindings). Shared by the board's score rail (derive.ts#scoreNodes — an uncoverable stage
 * must never render as merely "queued", since nothing arriving ever changes that) and `levare validate`
 * (a warning naming what a unit's assigned team can never satisfy) so the two surfaces can never
 * disagree on which stages are honestly reachable.
 */
export function unreachableExpectedKinds(
  repo: FlowRepo,
  unit: WorkUnit,
  capabilities: Array<{ member: string; kind: string }>,
): string[] {
  const type = repo.types.get(unit.type);
  const expects = type?.expects ?? [];
  if (expects.length === 0) return [];
  const teams = responsibleTeamsFor(repo, unit);
  if (teams.length === 0) return [];
  return expects.filter(
    (kind) => !teams.some((team) => capabilities.some((c) => team.members.includes(c.member) && c.kind === kind)),
  );
}

/**
 * Finding 78 part 2: the flow-step labels a team's flow declares, in encounter order — a step
 * contributes its own label, a loop contributes both `between` labels (author, then critic), a gate
 * contributes nothing (no kind). Shared by `flowKindOrder` below (typed `Team.flow`) and validate.ts's
 * own raw-YAML walk (`flowStepLabels`) so the two never re-derive "what order do a flow's labels occur
 * in" independently.
 */
function flowStepLabelsOf(flow: FlowNode[]): string[] {
  const labels: string[] = [];
  for (const node of flow) {
    if (node.kind === "step") labels.push(node.step);
    else if (node.kind === "loop") labels.push(...node.between);
  }
  return labels;
}

/**
 * Finding 78 part 2, ordering rule 4: resolve a sequence of flow-step labels to the kinds they bind
 * to, deduplicated at each kind's FIRST occurrence — "the rail answers *where are we*, and that is
 * where the kind first becomes live", never a later repeat of the same kind (e.g. a loop producing the
 * same kind on two of its rounds). A label that resolves to zero or more than one capability is
 * skipped, never guessed — that failure is already named on its own terms by validate.ts's
 * UNBINDABLE_STEP/AMBIGUOUS_STEP, and this function must not re-report or silently paper over it.
 */
export function kindOrderForLabels(
  labels: string[],
  members: string[],
  capabilities: Array<{ member: string; kind: string }>,
): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const label of labels) {
    const matches = capabilities.filter((c) => members.includes(c.member) && kindMatches(c.kind, label));
    if (matches.length !== 1) continue;
    const kind = matches[0].kind;
    if (!seen.has(kind)) {
      seen.add(kind);
      order.push(kind);
    }
  }
  return order;
}

/** `kindOrderForLabels` over one team's own flow (NOTES Finding 78 part 2). */
export function flowKindOrder(team: Team, capabilities: Array<{ member: string; kind: string }>): string[] {
  return kindOrderForLabels(flowStepLabelsOf(team.flow), team.members, capabilities);
}

/**
 * Finding 78 part 2 — the score rail's actual sort key: every kind the unit's responsible team(s)
 * FLOW places, in the order it becomes live, followed by every kind the type merely `expects` but no
 * flow step resolves to (ordering rule 1 — flow says nothing about it, so flow cannot position it; it
 * sorts after everything flow places, in `expects` order among its own peers). Multiple responsible
 * teams (NOTES ruling 3) contribute their own flow orders in `responsibleTeamsFor`'s own team order;
 * once `levare validate`'s CONFLICTING_KIND_ORDER check has passed, any kind two teams' flows both
 * place is guaranteed to agree on its relative position, so concatenating is safe — the first team to
 * place a given kind wins its position, exactly like `kindOrderForLabels`'s own within-team rule 4.
 */
export function railKindOrder(repo: FlowRepo, unit: WorkUnit, capabilities: Array<{ member: string; kind: string }>): string[] {
  const type = repo.types.get(unit.type);
  const expects = type?.expects ?? [];
  if (expects.length === 0) return [];
  const seen = new Set<string>();
  const flowOrder: string[] = [];
  for (const team of responsibleTeamsFor(repo, unit)) {
    for (const kind of flowKindOrder(team, capabilities)) {
      if (expects.includes(kind) && !seen.has(kind)) {
        seen.add(kind);
        flowOrder.push(kind);
      }
    }
  }
  const expectsOnly = expects.filter((kind) => !seen.has(kind));
  return [...flowOrder, ...expectsOnly];
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

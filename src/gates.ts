// Shared flow/gate resolution helpers (ruling C7): the pieces of gate-resolution logic that both the
// Runner's in-memory walk (runner.ts) and the board/Orchestrator's on-disk single-shot resolution
// (board/gateops.ts, orchestrator.ts) must agree on, so a Conductor's decision means the same thing
// regardless of which surface received it. `applyApproval` and `bumpVersion` (runner.ts) were already
// shared as of phase 4; `loopMembershipFor` closes the remaining gap — ruling C2 ("on any loop-gate
// resolution the round's companion review artifact resolves to approved") now has one definition of
// "is this artifact a loop-gate artifact, and who is its companion", used by both surfaces.

import { RunnerError, kindMatches } from "./runner.ts";
import type { Repo } from "./repo.ts";
import type { FlowLoop, Team, WorkUnit } from "./types.ts";

export interface LoopMembership {
  loop: FlowLoop;
  role: "first" | "second";
  /** The resolved kind of the OTHER loop member, when a capability produces it. */
  companionKind?: string;
}

/** The kind named by a loop's `until` condition (e.g. `review.approved` → `review`). */
export function loopUntilKind(loop: FlowLoop): string {
  return loop.until.split(".")[0];
}

/**
 * Ruling F16 — while a loop is in progress, only the artifact whose kind the loop's `until` condition
 * actually names may raise a gate; its companion never independently gates, regardless of whether it
 * happens to be the loop's "first" (author) or "second" (critic) role. Two open gates for one round —
 * the live defect this closes — came from treating "first" as the gate unconditionally, an assumption
 * an author/critic loop whose `until` names the CRITIC's kind (e.g. `review.approved`) violates. Used
 * by both `board/derive.ts#openGates` (visibility: never list the companion as an open gate) and
 * `board/gateops.ts` (resolution: the companion-approval cascade, and which member "request" re-runs,
 * both key off this same "is `kind` the loop's real gate" question, not off role).
 */
export function isLoopCompanionKind(team: Team, kind: string, capabilities: Array<{ member: string; kind: string }>): boolean {
  const membership = loopMembershipFor(team, kind, capabilities);
  if (!membership) return false;
  return kind !== loopUntilKind(membership.loop);
}

/**
 * Is `kind` one half of a loop in `team`'s flow? Resolves the loop's step labels to kinds the same
 * way the Runner resolves a flow step (kindMatches over the team's member capabilities), so a board
 * or Orchestrator gate resolution can find the loop's companion artifact exactly as the Runner would.
 */
export function loopMembershipFor(
  team: Team,
  kind: string,
  capabilities: Array<{ member: string; kind: string }>,
): LoopMembership | undefined {
  const kindsForLabel = (label: string) =>
    capabilities.filter((c) => team.members.includes(c.member) && kindMatches(c.kind, label)).map((c) => c.kind);
  for (const node of team.flow) {
    if (node.kind !== "loop") continue;
    const [firstLabel, secondLabel] = node.between;
    const firstKinds = kindsForLabel(firstLabel);
    const secondKinds = kindsForLabel(secondLabel);
    if (firstKinds.includes(kind)) return { loop: node, role: "first", companionKind: secondKinds[0] };
    if (secondKinds.includes(kind)) return { loop: node, role: "second", companionKind: firstKinds[0] };
  }
  return undefined;
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
export function responsibleTeamsFor(repo: Repo, unit: WorkUnit): Team[] {
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
export function responsibleTeamFor(repo: Repo, unit: WorkUnit): Team | null {
  return responsibleTeamsFor(repo, unit)[0] ?? null;
}

/**
 * Resolve a flow step label to the (member, kind) that satisfies it — the same resolution rule the
 * Runner's private `resolveStep` applies, exposed here so the board's `start` verb (E5) can execute a
 * team's first flow step without duplicating (or drifting from) the Runner's own algorithm.
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
export function unmetAfter(repo: Repo, unit: WorkUnit): string[] {
  if (!unit.after || unit.after.length === 0) return [];
  return unit.after.filter((id) => !repo.units.some((u) => u.project === unit.project && u.unit === id && u.status === "shipped"));
}

// ---------------------------------------------------------------------------
// Frontmatter patching — moved here (phase 8) from board/gateops.ts so both the board's direct gate
// operations and the phase-8 daemon's autonomous productions (dagwalk.ts) can patch a produced
// document's scalar fields without a circular import between gateops.ts and dagwalk.ts.
// ---------------------------------------------------------------------------

/** Patch top-level frontmatter scalar fields in place, preserving everything else byte-for-byte. */
export function patchFrontmatter(src: string, patches: Record<string, string | null>): string {
  const lines = src.split("\n");
  if (lines[0]?.trim() !== "---") throw new Error("document has no frontmatter fence");
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) throw new Error("frontmatter is not terminated");
  for (const [key, value] of Object.entries(patches)) {
    let found = false;
    for (let i = 1; i < end; i++) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*):/.exec(lines[i]);
      if (m && m[1] === key) {
        lines[i] = formatScalarLine(key, value);
        found = true;
        break;
      }
    }
    if (!found) throw new Error(`frontmatter key '${key}' not found to patch`);
  }
  return lines.join("\n");
}

function formatScalarLine(key: string, value: string | null): string {
  if (value === null) return `${key}: null`;
  if (/^[A-Za-z0-9._/-]+$/.test(value)) return `${key}: ${value}`;
  return `${key}: ${JSON.stringify(value)}`;
}

/**
 * Set a top-level frontmatter scalar field, patching it in place if present or inserting it as a new
 * line just before the closing `---` if absent — unlike `patchFrontmatter`, which fails loud on a
 * missing key. Used to record `approved_commit` (A7) on artifacts whose frontmatter never carried it
 * before, without demanding every existing/fixture artifact pre-declare a null placeholder.
 */
export function upsertFrontmatterField(src: string, key: string, value: string | null): string {
  const lines = src.split("\n");
  if (lines[0]?.trim() !== "---") throw new Error("document has no frontmatter fence");
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) throw new Error("frontmatter is not terminated");
  for (let i = 1; i < end; i++) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*):/.exec(lines[i]);
    if (m && m[1] === key) {
      lines[i] = formatScalarLine(key, value);
      return lines.join("\n");
    }
  }
  lines.splice(end, 0, formatScalarLine(key, value));
  return lines.join("\n");
}

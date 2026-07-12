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
 * The team responsible for a unit's flow (§6): the team whose `produces` overlaps the unit type's
 * `expects` the most, ties broken by name (ruling C4 — a fixture-scale shortcut shared verbatim by
 * the Runner's walk and the board's `start` verb, rather than re-derived in each place).
 */
export function responsibleTeamFor(repo: Repo, unit: WorkUnit): Team | null {
  const type = repo.types.get(unit.type);
  const expects = type?.expects ?? [];
  let best: Team | null = null;
  let bestScore = 0;
  for (const team of [...repo.teams.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const score = team.produces.filter((k) => expects.includes(k)).length;
    if (score > bestScore) {
      best = team;
      bestScore = score;
    }
  }
  return best;
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

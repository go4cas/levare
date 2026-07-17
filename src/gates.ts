// Shared flow/gate resolution helpers (ruling C7): the pieces of gate-resolution logic that both the
// Runner's in-memory walk (runner.ts) and the board/Orchestrator's on-disk single-shot resolution
// (board/gateops.ts, orchestrator.ts) must agree on, so a Conductor's decision means the same thing
// regardless of which surface received it. `applyApproval` and `bumpVersion` (runner.ts) were already
// shared as of phase 4; `loopMembershipFor` closes the remaining gap — ruling C2 ("on any loop-gate
// resolution the round's companion review artifact resolves to approved") now has one definition of
// "is this artifact a loop-gate artifact, and who is its companion", used by both surfaces. The pure
// flow-resolution rules themselves (`responsibleTeamsFor`, `resolveStep`, `kindMatches`, `unmetAfter`)
// live in flow.ts (NOTES R3) — this module re-exports them for its existing callers and builds the
// loop-membership helpers on top.

import { kindMatches, responsibleTeamsFor, responsibleTeamFor, resolveStep, unmetAfter } from "./flow.ts";
import type { FlowLoop, Team } from "./types.ts";

export { responsibleTeamsFor, responsibleTeamFor, resolveStep, unmetAfter };

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
 * by both `derive.ts#openGates` (visibility: never list the companion as an open gate) and
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

function formatScalar(value: string | number | boolean | null): string {
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return /^[A-Za-z0-9._/-]+$/.test(value) ? value : JSON.stringify(value);
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

/**
 * NOTES CAP-A: insert (or replace) a top-level frontmatter MAP field — `patchFrontmatter`/
 * `upsertFrontmatterField` only handle scalar values; a proposal's `execution:` record is a nested
 * block (executed_at/status/exit/output_digest/warning), the same shape adapters.ts#author already
 * hand-builds for `usage:`. Replaces any existing block for `key` (its own line plus every indented
 * continuation line that follows it) before appending the new one, so re-execution never leaves a
 * stale block behind.
 */
export function upsertFrontmatterMap(src: string, key: string, value: Record<string, string | number | boolean | null>): string {
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

  const kept: string[] = [];
  let i = 1;
  while (i < end) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*):/.exec(lines[i]);
    if (m && m[1] === key) {
      i++;
      while (i < end && /^[ \t]/.test(lines[i])) i++; // skip the existing block's own continuation lines.
      continue;
    }
    kept.push(lines[i]);
    i++;
  }

  const block = [`${key}:`, ...Object.entries(value).map(([k, v]) => `  ${k}: ${formatScalar(v)}`)];
  return ["---", ...kept, ...block, "---", ...lines.slice(end + 1)].join("\n");
}

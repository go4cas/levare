// Pure derivation helpers for the board (PRD §9). Every function here takes already-loaded repo
// data and returns either a display string or a small derived shape — no I/O, no clock reads except
// where a `now` is passed in explicitly, so callers (render + tests) can pin it.

import type { Artifact, ArtifactStatus, Team, TypeTemplate, Usage, WorkUnit } from "../types.ts";
import type { Repo } from "../repo.ts";
import { firstParagraph } from "../repo.ts";

export function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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

/** "14m", "2h", "3d" — coarse age from an ISO-ish timestamp to `now`. */
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

// ---------------------------------------------------------------------------
// Gates (ruling C2: an artifact at in-review always means an open gate)
// ---------------------------------------------------------------------------

export interface OpenGate {
  type: "artifact" | "start";
  project: string;
  unit: string;
  /** The artifact id for an artifact-shaped gate; the unit id for a start gate. */
  target: string;
  artifact?: Artifact;
  team?: Team;
  member?: string;
  label: string;
}

/** Every open gate in the repo: artifacts at in-review, plus start gates whose `after:` is met. */
export function openGates(repo: Repo): OpenGate[] {
  const gates: OpenGate[] = [];
  for (const unit of repo.units) {
    const key = `${unit.project}/${unit.unit}`;
    const artifacts = repo.artifacts.get(key);
    if (artifacts) {
      for (const art of artifacts.values()) {
        if (art.status !== "in-review") continue;
        const [teamName, member] = art.produced_by.split("/");
        gates.push({
          type: "artifact",
          project: unit.project,
          unit: unit.unit,
          target: art.id,
          artifact: art,
          team: repo.teams.get(teamName),
          member,
          label: art.kind,
        });
      }
    }
    if (unit.after && unit.after.length > 0 && unit.status === "active") {
      const unmet = unit.after.filter((id) => !unitShipped(repo, unit.project, id));
      if (unmet.length === 0) {
        gates.push({ type: "start", project: unit.project, unit: unit.unit, target: unit.unit, label: "start" });
      }
    }
  }
  return gates;
}

function unitShipped(repo: Repo, project: string, unitId: string): boolean {
  return repo.units.some((u) => u.project === project && u.unit === unitId && u.status === "shipped");
}

// ---------------------------------------------------------------------------
// Mini-score / score dots (PRD §9: "state nodes in the canonical palette")
// ---------------------------------------------------------------------------

export type NodeState = "done" | "active" | "gate" | "wait" | "rejected" | "blocked";
export interface ScoreNode {
  kind: string;
  shape: "dot" | "diamond";
  state: NodeState;
  artifact?: Artifact;
  producedBy?: string;
}

/**
 * One node per kind in the unit's type `expects:` list, derived from the current (non-superseded)
 * artifact of that kind. A kind with no artifact yet is "wait"; an artifact at in-review is the
 * gate itself (diamond, ruling C2) — never a plain "active" circle.
 */
export function scoreNodes(repo: Repo, unit: WorkUnit): ScoreNode[] {
  const type = repo.types.get(unit.type);
  const expects = type?.expects ?? [];
  const artifacts = [...(repo.artifacts.get(`${unit.project}/${unit.unit}`)?.values() ?? [])];
  return expects.map((kind) => {
    // Prefer the live (non-superseded) artifact of this kind; fall back to the most recent one so a
    // rejected/blocked kind still renders its true state rather than reading as untouched.
    const live = artifacts.filter((a) => a.kind === kind);
    const current = live.find((a) => a.status !== "superseded") ?? live[live.length - 1];
    if (!current) return { kind, shape: "dot", state: "wait" };
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

/** Median days from an artifact's `created` to its `approved_by` ISO date, across approved artifacts. */
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

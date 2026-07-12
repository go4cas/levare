// Board write path for gate verbs (PRD §4, §9). Historically NOT a re-implementation of the phase-2
// Runner's flow-walk gate lifecycle (runner.ts `raiseGate`/loop machinery) — that engine drives a
// full in-memory simulated walk against a MemberRunner. The board instead performs the direct §4 gate
// operation against the one artifact (or unit) a Conductor clicked: flip frontmatter, validate at the
// same boundary the whole repo is validated at, write, commit as the Conductor.
//
// Ruling C7 (phase 5): board gate ops and Runner gate resolution converge on one implementation. The
// pieces that must agree are shared, not re-derived: `applyApproval` + `bumpVersion` (runner.ts,
// exported for this purpose since phase 4); `loopMembershipFor` + `responsibleTeamFor` + `resolveStep`
// (gates.ts, phase 5) so ruling C2 ("on any loop-gate resolution the round's companion review resolves
// to approved") applies identically here as it does inside the Runner's own `runLoop`; and member
// production itself now goes through the real `MemberRunner`/`AdapterRunner` boundary (E4) — the same
// one the Runner and `levare replay` drive — rather than a board-only reuse of the stub's `render()`.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadRepo, parseArtifactDoc, type Repo } from "../repo.ts";
import { validateArtifactSource } from "../validate.ts";
import { applyApproval, bumpVersion, type MemberRunner, type Verb } from "../runner.ts";
import { stubAdapterRunner } from "../replay.ts";
import { loopMembershipFor, responsibleTeamFor, resolveStep, unmetAfter } from "../gates.ts";
import { locateArtifactFile } from "./locate.ts";
import { conductorCommit, CONDUCTOR_NAME, CONDUCTOR_EMAIL } from "../git.ts";
import type { Artifact, WorkUnit } from "../types.ts";

export { CONDUCTOR_NAME, CONDUCTOR_EMAIL };

export interface GateOpOk {
  ok: true;
  commit: string;
  changedFiles: string[];
}
export interface GateOpErr {
  ok: false;
  status: number;
  error: string;
}
export type GateOpResult = GateOpOk | GateOpErr;

export interface ResolveOpts {
  note?: string;
  /** ISO date to stamp approved_by / commits with; defaults to today. Injectable for deterministic tests. */
  today?: string;
  /** The member producer boundary (E4). Defaults to the same mocked-adapter boundary `levare replay`
   * drives — real context assembly, env scoping, and receipts, behind the still-mocked SDK (invariant 10). */
  memberRunner?: MemberRunner;
}

/** Resolve one gate verb against `target` (an artifact id, or — for start/notyet/rescope — a unit id). */
export function resolveGate(root: string, project: string, target: string, verb: Verb, opts: ResolveOpts = {}): GateOpResult {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const repo = loadRepo(root);
  const memberRunner = opts.memberRunner ?? stubAdapterRunner(repo);
  const unit = repo.units.find((u) => u.project === project && repo.artifacts.get(`${project}/${u.unit}`)?.has(target));

  if (verb === "start" || verb === "notyet" || verb === "rescope") {
    return resolveStartGate(root, repo, project, target, verb, memberRunner);
  }
  if (!unit) return { ok: false, status: 404, error: `no open gate for artifact '${target}' in project '${project}'` };

  const artifacts = repo.artifacts.get(`${project}/${unit.unit}`)!;
  const art = artifacts.get(target)!;
  if (art.status !== "in-review") {
    return { ok: false, status: 409, error: `artifact '${target}' is not at an open gate (status: ${art.status})` };
  }
  const located = locateArtifactFile(unit.dir, target);
  if (!located) return { ok: false, status: 404, error: `artifact file for '${target}' not found on disk` };

  // C2/C7: any resolution of a loop-first gate (approve, reject, OR request) resolves the round's
  // companion review artifact to approved — the Conductor accepted it as read — exactly as the
  // Runner's own `runLoop` does. Applied once, here, ahead of the verb-specific write, so the
  // companion lands in the same commit as the primary resolution.
  const companionFile = applyLoopCompanionApproval(root, repo, unit, art, today, memberRunner.capabilities());
  const extra = companionFile ? [companionFile] : [];

  if (verb === "approve") return doApprove(root, located.file, target, today, opts.note, extra);
  if (verb === "reject") return doReject(root, located.file, target, opts.note, extra);
  if (verb === "request") return doRequest(root, unit.dir, located.file, art, opts.note, memberRunner, extra);
  return { ok: false, status: 400, error: `verb '${verb}' is not valid for an artifact gate` };
}

function doApprove(root: string, file: string, id: string, today: string, note: string | undefined, extraFiles: string[]): GateOpResult {
  const src = readFileSync(file, "utf8");
  const patched = patchFrontmatter(src, { status: "approved", approved_by: `${CONDUCTOR_NAME} ${today}` });
  const errs = validateArtifactSource(patched, file, dirname(file));
  if (errs.length > 0) return { ok: false, status: 422, error: `${errs[0].code}: ${errs[0].message}` };
  writeFileSync(file, patched);
  const files = [file, ...extraFiles];
  const commit = conductorCommit(root, files, `approve ${id}${note ? `\n\n${note}` : ""}`);
  return { ok: true, commit, changedFiles: files };
}

function doReject(root: string, file: string, id: string, note: string | undefined, extraFiles: string[]): GateOpResult {
  const src = readFileSync(file, "utf8");
  const patched = patchFrontmatter(src, { status: "rejected" });
  const errs = validateArtifactSource(patched, file, dirname(file));
  if (errs.length > 0) return { ok: false, status: 422, error: `${errs[0].code}: ${errs[0].message}` };
  writeFileSync(file, patched);
  const files = [file, ...extraFiles];
  const commit = conductorCommit(root, files, `reject ${id}${note ? `\n\n${note}` : ""}`);
  return { ok: true, commit, changedFiles: files };
}

function doRequest(
  root: string,
  unitDir: string,
  file: string,
  art: { id: string; kind: string; produced_by: string; unit: string; project: string },
  note: string | undefined,
  memberRunner: MemberRunner,
  extraFiles: string[],
): GateOpResult {
  if (!note || !note.trim()) return { ok: false, status: 400, error: "request-changes requires a note" };
  const member = art.produced_by.split("/")[1];
  const hasCap = memberRunner.capabilities().some((c) => c.member === member && c.kind === art.kind);
  if (!hasCap) {
    return { ok: false, status: 501, error: `no producer available to re-invoke '${art.produced_by}' for kind '${art.kind}'` };
  }
  const oldRoundMatch = /-v(\d+)$/.exec(art.id);
  const nextRound = (oldRoundMatch ? Number(oldRoundMatch[1]) : 1) + 1;

  // E4: re-invoke through the real MemberRunner/AdapterRunner boundary — context assembly, env
  // scoping, and a normalized usage receipt all run for real, behind the still-mocked native/CLI
  // boundaries (invariant 10) — rather than reaching directly for the stub's `render()`.
  const { doc: baseDoc } = memberRunner.produce(member, art.kind, art.unit, art.project);
  const baseId = idOfDoc(baseDoc);
  const newId = bumpVersion(baseId, nextRound);
  const newDoc = patchFrontmatter(baseDoc, { id: newId, supersedes: art.id });
  const errs = validateArtifactSource(newDoc, `${newId}.md`, unitDir);
  if (errs.length > 0) return { ok: false, status: 422, error: `${errs[0].code}: ${errs[0].message}` };

  const oldSrc = readFileSync(file, "utf8");
  const oldPatched = patchFrontmatter(oldSrc, { status: "superseded" });

  const newFile = join(unitDir, `${newId}.md`);
  writeFileSync(file, oldPatched);
  writeFileSync(newFile, newDoc);
  const files = [file, newFile, ...extraFiles];
  const commit = conductorCommit(root, files, `request changes on ${art.id} → ${newId}\n\n${note}`);
  return { ok: true, commit, changedFiles: files };
}

// C2/C7 shared companion rule: if `art.kind` is the "first" half of some loop in its producing
// team's flow, and a companion artifact of the loop's other kind currently sits in-review for the
// same unit, that companion resolves to approved as part of THIS resolution — mirroring exactly what
// the Runner's `runLoop` does inside a live walk (see runner.ts). Returns the companion's file path
// when one was patched, so the caller folds it into the same commit; null when there is nothing to do
// (no loop, or no live companion — e.g. the golden fixture's static spec gate, which has no review
// artifact on disk yet).
function applyLoopCompanionApproval(
  root: string,
  repo: Repo,
  unit: WorkUnit,
  art: Artifact,
  today: string,
  capabilities: Array<{ member: string; kind: string }>,
): string | null {
  const [teamName] = art.produced_by.split("/");
  const team = repo.teams.get(teamName);
  if (!team) return null;
  const membership = loopMembershipFor(team, art.kind, capabilities);
  if (!membership || membership.role !== "first" || !membership.companionKind) return null;

  const artifacts = repo.artifacts.get(`${unit.project}/${unit.unit}`);
  if (!artifacts) return null;
  const companion = [...artifacts.values()]
    .filter((a) => a.kind === membership.companionKind && a.status === "in-review")
    .sort((a, b) => a.created.localeCompare(b.created))
    .pop();
  if (!companion) return null;

  const located = locateArtifactFile(unit.dir, companion.id);
  if (!located) return null;
  const src = readFileSync(located.file, "utf8");
  const patched = patchFrontmatter(src, { status: "approved", approved_by: `${CONDUCTOR_NAME} ${today}` });
  const errs = validateArtifactSource(patched, located.file, dirname(located.file));
  if (errs.length > 0) return null; // never let a companion validation edge case block the primary resolution.
  writeFileSync(located.file, patched);
  return located.file;
}

function resolveStartGate(
  root: string,
  repo: Repo,
  project: string,
  unitId: string,
  verb: "start" | "notyet" | "rescope",
  memberRunner: MemberRunner,
): GateOpResult {
  const unit = repo.units.find((u) => u.project === project && u.unit === unitId);
  if (!unit) return { ok: false, status: 404, error: `no unit '${unitId}' in project '${project}'` };
  if (verb === "notyet") return { ok: true, commit: "", changedFiles: [] }; // purely informational; nothing to persist
  if (verb === "start") return doStart(root, repo, unit, memberRunner);
  // rescope: no artifact to flip; a unit with an unmet-then-met after: has no separate persisted
  // "queued" status (NOTES A6), so rescoping simply records the decision — nothing to commit either.
  return { ok: true, commit: "", changedFiles: [] };
}

// E5: `start` invokes the unit's flow instead of returning 501. A start gate only ever sits at flow
// position zero (§6), so starting means: find the responsible team (ruling C4/C7 — the same
// heuristic the Runner's walk uses, gates.ts#responsibleTeamFor), resolve and run its FIRST flow node
// as one member invocation, write the produced artifact to disk, and stop — that new artifact sits
// at in-review, which `openGates` already renders as an ordinary gate. No bespoke "start-produced
// gate" bookkeeping is needed: files are the truth (invariant 2), so the walk's next declared gate
// (§6: "gate: human halts the walk") falls straight out of the artifact the step just wrote.
function doStart(root: string, repo: Repo, unit: WorkUnit, memberRunner: MemberRunner): GateOpResult {
  const unmet = unmetAfter(repo, unit);
  if (unmet.length > 0) return { ok: false, status: 409, error: `unit '${unit.unit}' still has unmet after: [${unmet.join(", ")}]` };
  const team = responsibleTeamFor(repo, unit);
  if (!team) return { ok: false, status: 409, error: `no team produces kinds for unit type '${unit.type}'` };
  const first = team.flow[0];
  if (!first || first.kind !== "step") {
    return {
      ok: false,
      status: 501,
      error: `team '${team.name}''s flow does not open with a step (starts with '${first?.kind ?? "nothing"}'); starting mid-flow shapes is not supported yet`,
    };
  }
  const { member, kind } = resolveStep(team, first.step, memberRunner.capabilities());
  const { doc: baseDoc } = memberRunner.produce(member, kind, unit.unit, unit.project);

  // The member boundary's produced id is not unit-scoped — a mocked/stub member (the only kind this
  // phase can invoke, invariant 10) emits the same fixed id regardless of which unit asked, so a
  // second unit in the same project starting the same kind of step would collide under the
  // validator's project-scoped DUPLICATE_ID check. Re-id to the kind-unit-vN convention every other
  // multi-round-safe artifact in the repo already follows (e.g. spec-checkout-flow-v1) — round 1,
  // since `start` only ever produces the flow's very first artifact for this unit — rather than trust
  // whatever id the boundary happened to emit.
  const newId = `${kind}-${unit.unit}-v1`;
  const doc = patchFrontmatter(baseDoc, { id: newId });

  const errs = validateArtifactSource(doc, `${member}:${kind}`, unit.dir);
  if (errs.length > 0) return { ok: false, status: 422, error: `${errs[0].code}: ${errs[0].message}` };
  const art = parseArtifactDoc(doc);
  const file = join(unit.dir, `${art.id}.md`);
  writeFileSync(file, doc);
  const commit = conductorCommit(root, [file], `start ${unit.unit} → ${team.name}/${member} produced ${art.kind} ${art.id}`);
  return { ok: true, commit, changedFiles: [file] };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function idOfDoc(doc: string): string {
  const m = /^id:\s*(.+)$/m.exec(doc);
  if (!m) throw new Error("stub-produced document has no id");
  return m[1].trim();
}

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

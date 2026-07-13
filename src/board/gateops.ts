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
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { loadRepo, type Repo } from "../repo.ts";
import { validateArtifactSource } from "../validate.ts";
import { bumpVersion, type MemberRunner, type Verb } from "../runner.ts";
import { productionAdapterRunner } from "../replay.ts";
import { loopMembershipFor, responsibleTeamFor, unmetAfter, patchFrontmatter, upsertFrontmatterField } from "../gates.ts";
import { locateArtifactFile } from "./locate.ts";
import { conductorCommit, CONDUCTOR_NAME, CONDUCTOR_EMAIL } from "../git.ts";
import { advanceUnit } from "../dagwalk.ts";
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
  /** The member producer boundary (E4). Defaults to `productionAdapterRunner` (NOTES F4) — the real
   * AdapterRunner, with a CLI member's REAL declared command spawned (native/remote stay behind the
   * still-mocked SDK/MCP boundaries, K5's own separate, documented deferral). `stubAdapterRunner`
   * (replay.ts) must never be reachable from here — see daemon.ts's identical note. */
  memberRunner?: MemberRunner;
}

/** Resolve one gate verb against `target` (an artifact id, or — for start/notyet/rescope — a unit id). */
export function resolveGate(root: string, project: string, target: string, verb: Verb, opts: ResolveOpts = {}): GateOpResult {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const repo = loadRepo(root);
  const memberRunner = opts.memberRunner ?? productionAdapterRunner(repo);
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

// The repo's current HEAD, captured BEFORE an approval commits — the commit that holds the exact
// content the Conductor is approving. Recording it as the artifact's `approved_commit` (A7) lets
// `validate` diff against a permanent ancestor rather than HEAD, so a later committed mutation can no
// longer masquerade as unchanged. Recording the pre-approval HEAD (not the approval commit's own SHA)
// sidesteps the self-reference paradox — a commit cannot contain its own hash — with no second commit
// or dangling amend; it is equivalent for detecting post-approval content change. "" when there is no
// HEAD yet (validate then falls back to the HEAD diff — nothing to launder against on an empty repo).
function headRev(root: string): string {
  const r = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
}

function stampApproval(src: string, today: string, root: string): string {
  const patched = patchFrontmatter(src, { status: "approved", approved_by: `${CONDUCTOR_NAME} ${today}` });
  const head = headRev(root);
  return head ? upsertFrontmatterField(patched, "approved_commit", head) : patched;
}

function doApprove(root: string, file: string, id: string, today: string, note: string | undefined, extraFiles: string[]): GateOpResult {
  const src = readFileSync(file, "utf8");
  const patched = stampApproval(src, today, root);
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
  const patched = stampApproval(src, today, root);
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

// Phase 8 (deliverable d, closing E5/F3): `start` no longer runs its own bespoke "resolve the first
// flow node, invoke, write" logic — it hands the unit to the shared dagwalk#advanceUnit the daemon
// itself drives, passing `startAuthorized: true` because THIS call — the Conductor's own resolution
// of the start gate — is the invariant-1 approval that makes the very first invocation legitimate.
// A flow that opens with a loop (not a plain step) is no longer a 501: advanceUnit's `nextAction`
// walks step/gate/loop nodes uniformly, so "the flow's first gate" (whatever shape it is) is reached
// either way — the old F3 scope boundary (only step-opening flows supported) is closed as a side
// effect of sharing the real walk instead of a start-only special case.
//
// Gate-review fix: `startAuthorized: true` is what makes this call LEGAL (the Conductor's click is
// the invariant-1 approval in the causal chain) — it says nothing about who WROTE the resulting
// artifact. The write itself is a member's output (kestrel/wren, here), never the Conductor's own
// content, exactly like any other daemon-driven production later in the same unit's flow. Passing
// `commit: conductorCommit` here (an earlier version of this function did) attributed that member's
// work to the Conductor in git history — authorship must reflect who ACTED, not who TRIGGERED (see
// NOTES.md's phase-8 section). `verb: "start"` is kept so the commit MESSAGE still records that this
// production followed an explicit start click, distinguishing it from a later autonomous advance —
// only the identity was ever wrong.
function doStart(root: string, repo: Repo, unit: WorkUnit, memberRunner: MemberRunner): GateOpResult {
  const unmet = unmetAfter(repo, unit);
  if (unmet.length > 0) return { ok: false, status: 409, error: `unit '${unit.unit}' still has unmet after: [${unmet.join(", ")}]` };
  const team = responsibleTeamFor(repo, unit);
  if (!team) return { ok: false, status: 409, error: `no team produces kinds for unit type '${unit.type}'` };

  const result = advanceUnit(root, repo, unit, memberRunner, { startAuthorized: true, verb: "start" });
  if (result.outcome === "nothing") {
    return { ok: false, status: 409, error: `unit '${unit.unit}' has nothing left for team '${team.name}' to produce` };
  }
  if (result.outcome === "halted" || result.outcome === "budget-gate") {
    return { ok: false, status: 409, error: result.reason };
  }
  if (result.outcome === "unbindable") {
    // NOTES F1: the team cannot bind this flow step to any member — the studio is misconfigured, not
    // merely busy. advanceUnit has already blocked the unit on disk with the reason; the Conductor is
    // told exactly that here (409, the reason verbatim) rather than getting a 200 over a no-op.
    return { ok: false, status: 409, error: result.reason };
  }
  if (result.outcome === "blocked") {
    // A start attempt that fails at the member boundary still writes something real to the repo
    // (deliverable f) — surfaced to the caller as a 502 (upstream/member failure), not a silent 200.
    return { ok: false, status: 502, error: `start failed: ${result.error}` };
  }
  return { ok: true, commit: result.commit, changedFiles: [result.file] };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function idOfDoc(doc: string): string {
  const m = /^id:\s*(.+)$/m.exec(doc);
  if (!m) throw new Error("stub-produced document has no id");
  return m[1].trim();
}

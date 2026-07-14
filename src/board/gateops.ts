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
import { bumpVersion, roundOf, type Verb } from "../runner.ts";
import { productionAdapterRunner } from "../replay.ts";
import { loopMembershipFor, isLoopCompanionKind, loopUntilKind, resolveStep, responsibleTeamFor, unmetAfter, patchFrontmatter, upsertFrontmatterField } from "../gates.ts";
import { locateArtifactFile } from "./locate.ts";
import { conductorCommit, CONDUCTOR_NAME, CONDUCTOR_EMAIL } from "../git.ts";
import { advanceUnit, latestLiveArtifact, type AsyncMemberRunner } from "../dagwalk.ts";
import type { Daemon } from "../daemon.ts";
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
  memberRunner?: AsyncMemberRunner;
  /** NOTES F10 defect 3: when set, a `start`/`request` verb that dispatches a member registers the
   * invocation with this daemon's `running()` projection for the synchronous window it's in flight —
   * so the board can show it as dispatching immediately, not only once the daemon's own tick catches
   * it later. Absent in every context with no live daemon (read-only board, most tests) — nothing
   * registers, exactly the pre-existing behavior. */
  daemon?: Daemon;
}

/** Resolve one gate verb against `target` (an artifact id, or — for start/notyet, and rescope of a
 * unit's start gate — a unit id). */
export async function resolveGate(root: string, project: string, target: string, verb: Verb, opts: ResolveOpts = {}): Promise<GateOpResult> {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const repo = loadRepo(root);
  const memberRunner = opts.memberRunner ?? productionAdapterRunner(repo);
  const unit = repo.units.find((u) => u.project === project && repo.artifacts.get(`${project}/${u.unit}`)?.has(target));

  if (verb === "start" || verb === "notyet") {
    return await resolveStartGate(root, repo, project, target, verb, memberRunner, opts.daemon);
  }
  // NOTES F20: `rescope` also targets an ARTIFACT now — a loop's on_exhaust decision — alongside its
  // pre-existing meaning against a unit's start gate. Disambiguated by whether `target` resolves to a
  // live artifact at all; a unit id never does.
  if (verb === "rescope" && !unit) {
    return await resolveStartGate(root, repo, project, target, verb, memberRunner, opts.daemon);
  }
  if (!unit) return { ok: false, status: 404, error: `no open gate for artifact '${target}' in project '${project}'` };

  const artifacts = repo.artifacts.get(`${project}/${unit.unit}`)!;
  const art = artifacts.get(target)!;

  // NOTES F19: a blocked artifact (a member ran and failed) raises its own gate with three verbs —
  // retry/skip/abandon — resolved against `art.status === "blocked"`, never `in-review`.
  if (verb === "retry" || verb === "skip" || verb === "abandon") {
    return await resolveBlockedArtifactGate(root, unit, art, verb, memberRunner, opts, today);
  }
  if (verb === "rescope") return doRescopeArtifact(root, unit, art, opts.note);

  if (art.status !== "in-review") {
    return { ok: false, status: 409, error: `artifact '${target}' is not at an open gate (status: ${art.status})` };
  }
  const located = locateArtifactFile(unit.dir, target);
  if (!located) return { ok: false, status: 404, error: `artifact file for '${target}' not found on disk` };

  // Ruling F16: while a loop is in progress, only the artifact its `until` condition actually names
  // may be resolved directly — the loop's OTHER member never independently gates (board/derive.ts's
  // `openGates` already never lists it), and a direct API call naming it anyway is refused here too,
  // loudly, rather than silently producing an orphaned artifact stuck `in-review` forever once `until`
  // is satisfied by the other half (the live wedge this ruling closes).
  const [artTeamName] = art.produced_by.split("/");
  const artTeam = repo.teams.get(artTeamName);
  if (artTeam) {
    const membership = loopMembershipFor(artTeam, art.kind, memberRunner.capabilities());
    if (membership && isLoopCompanionKind(artTeam, art.kind, memberRunner.capabilities())) {
      return {
        ok: false,
        status: 409,
        error: `'${target}' does not gate while its loop is in progress — resolve the '${loopUntilKind(membership.loop)}' artifact instead (ruling F16)`,
      };
    }
  }

  // C2/C7: any resolution of a loop-first gate (approve, reject, OR request) resolves the round's
  // companion review artifact to approved — the Conductor accepted it as read — exactly as the
  // Runner's own `runLoop` does. Applied once, here, ahead of the verb-specific write, so the
  // companion lands in the same commit as the primary resolution.
  const companionFile = applyLoopCompanionApproval(root, repo, unit, art, today, memberRunner.capabilities());
  const extra = companionFile ? [companionFile] : [];

  if (verb === "approve") return doApprove(root, located.file, target, today, opts.note, extra);
  if (verb === "reject") return doReject(root, located.file, target, opts.note, extra);
  if (verb === "request") return await doRequest(root, repo, unit, located.file, art, opts.note, memberRunner, extra, today, opts.daemon);
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

// NOTES F20: the on_exhaust gate's third decision, alongside "approve anyway" (doApprove, unchanged —
// the existing C2 companion cascade already resolves the round's review alongside it) and "reject"
// (doReject, unchanged). A loop that hit `max_rounds` without its `until` cannot simply try again
// (`doRequest` already refuses that, 409, no spend) — re-scoping rejects the artifact AND pauses the
// whole unit in one commit, so the Conductor's next move is deliberate re-planning, not another round
// this loop already proved it cannot complete on its own.
function doRescopeArtifact(root: string, unit: WorkUnit, art: Artifact, note: string | undefined): GateOpResult {
  if (art.status !== "in-review") {
    return { ok: false, status: 409, error: `artifact '${art.id}' is not at an open gate (status: ${art.status})` };
  }
  const located = locateArtifactFile(unit.dir, art.id);
  if (!located) return { ok: false, status: 404, error: `artifact file for '${art.id}' not found on disk` };
  const src = readFileSync(located.file, "utf8");
  const patched = patchFrontmatter(src, { status: "rejected" });
  const errs = validateArtifactSource(patched, located.file, dirname(located.file));
  if (errs.length > 0) return { ok: false, status: 422, error: `${errs[0].code}: ${errs[0].message}` };

  const unitFile = join(unit.dir, "unit.md");
  const unitSrc = readFileSync(unitFile, "utf8");
  const unitPatched = patchFrontmatter(unitSrc, { status: "paused" });

  writeFileSync(located.file, patched);
  writeFileSync(unitFile, unitPatched);
  const files = [located.file, unitFile];
  const commit = conductorCommit(root, files, `re-scope ${unit.unit} at ${art.id}: loop exhausted${note ? `\n\n${note}` : ""}`);
  return { ok: true, commit, changedFiles: files };
}

async function doRequest(
  root: string,
  repo: Repo,
  unit: WorkUnit,
  file: string,
  art: { id: string; kind: string; produced_by: string; unit: string; project: string },
  note: string | undefined,
  memberRunner: AsyncMemberRunner,
  extraFiles: string[],
  today: string,
  daemon?: Daemon,
): Promise<GateOpResult> {
  const unitDir = unit.dir;
  if (!note || !note.trim()) return { ok: false, status: 400, error: "request-changes requires a note" };

  const [teamName] = art.produced_by.split("/");
  const team = repo.teams.get(teamName);
  const membership = team ? loopMembershipFor(team, art.kind, memberRunner.capabilities()) : undefined;

  // Ruling F16: "request changes" always means "give the loop's AUTHOR another round" — regardless of
  // which loop member is actually the gate (resolveGate's own guard, above, ensures `art` here is
  // always the artifact the loop's `until` names). For a loop gated on its first/author member
  // (kestrel's `until: spec.approved`), that IS `art` itself — unchanged. For one gated on its
  // second/critic member (`until: review.approved`), re-running the CRITIC on an unrevised input would
  // be meaningless — the AUTHOR is who re-runs, with the critic's own feedback already in `note` and,
  // via `extraConsumes`, in its own context on the walk's next tick.
  let reinvokeMember = art.produced_by.split("/")[1];
  let reinvokeKind = art.kind;
  let supersedeId = art.id;
  let supersedeFile = file;
  // F16: when redirected, `art` itself is deliberately left untouched (still `in-review`) — it is NOT
  // the artifact being re-run, and the walk's own next tick resolves it for real: dagwalk.ts finds it
  // as the prior round's still-live companion the instant the author's new round is produced, and
  // supersedes it there with its own proper `supersedes:` edge (the identical pattern every other round
  // already goes through). Marking it "approved" here instead would trip `until` early — `review.
  // approved` would read satisfied off round N's own review while round N+1 is still unresolved, the
  // exact silent-wedge shape this whole ruling exists to prevent.
  if (membership?.role === "second") {
    const authorLabel = membership.loop.between[0];
    const authorResolved = resolveStep(team!, authorLabel, memberRunner.capabilities());
    const authorArt = latestLiveArtifact(repo, unit, authorResolved.kind);
    if (!authorArt) {
      return { ok: false, status: 409, error: `no live '${authorResolved.kind}' artifact to re-invoke for a new round` };
    }
    const authorLocated = locateArtifactFile(unitDir, authorArt.id);
    if (!authorLocated) return { ok: false, status: 404, error: `author artifact file for '${authorArt.id}' not found on disk` };
    reinvokeMember = authorResolved.member;
    reinvokeKind = authorResolved.kind;
    supersedeId = authorArt.id;
    supersedeFile = authorLocated.file;
  }

  const hasCap = memberRunner.capabilities().some((c) => c.member === reinvokeMember && c.kind === reinvokeKind);
  if (!hasCap) {
    return { ok: false, status: 501, error: `no producer available to re-invoke '${teamName}/${reinvokeMember}' for kind '${reinvokeKind}'` };
  }

  // Ruling C14: max_rounds/on_exhaust. `membership` is only ever set here for the artifact the loop's
  // `until` actually names (resolveGate's own guard refuses the other one directly, F16) — so the
  // check applies whenever a loop membership was found at all, not only when it happens to be the
  // "first" role as before. Requesting changes at the final round would create a round beyond
  // max_rounds, which the ruling forbids; mirrors runner.ts#runLoop's own exhaustion exactly (the
  // for-loop simply never starts a round beyond max_rounds).
  if (membership) {
    const round = roundOf(art.id);
    if (round >= membership.loop.maxRounds) {
      const artifacts = repo.artifacts.get(`${unit.project}/${unit.unit}`);
      const companion =
        membership.companionKind && artifacts
          ? [...artifacts.values()].filter((a) => a.kind === membership.companionKind).sort((a, b) => a.created.localeCompare(b.created)).pop()
          : undefined;
      return {
        ok: false,
        status: 409,
        error:
          `loop exhausted: ${art.id} is round ${round}/${membership.loop.maxRounds} without \`${membership.loop.until}\` — ` +
          `on_exhaust: gate (last review: ${companion ? companion.id : "none"}); only approve/reject are valid now, not request`,
      };
    }
  }

  const oldRoundMatch = /-v(\d+)$/.exec(supersedeId);
  const nextRound = (oldRoundMatch ? Number(oldRoundMatch[1]) : 1) + 1;

  // E4: re-invoke through the real MemberRunner/AdapterRunner boundary — context assembly, env
  // scoping, and a normalized usage receipt all run for real, behind the still-mocked native/CLI
  // boundaries (invariant 10) — rather than reaching directly for the stub's `render()`.
  // NOTES F10 defect 3: registered with the daemon's inFlight projection for the synchronous window
  // this call is dispatched, so the board can show it as dispatching immediately (see `beginInvocation`).
  const invocation = daemon?.beginInvocation({ project: art.project, unit: art.unit, member: reinvokeMember, kind: reinvokeKind });
  let baseDoc: string;
  try {
    ({ doc: baseDoc } = await memberRunner.produce(reinvokeMember, reinvokeKind, art.unit, art.project));
  } finally {
    if (invocation) daemon!.endInvocation(invocation);
  }
  const baseId = idOfDoc(baseDoc);
  const newId = bumpVersion(baseId, nextRound);
  const newDoc = patchFrontmatter(baseDoc, { id: newId, supersedes: supersedeId });
  const errs = validateArtifactSource(newDoc, `${newId}.md`, unitDir);
  if (errs.length > 0) return { ok: false, status: 422, error: `${errs[0].code}: ${errs[0].message}` };

  const oldSrc = readFileSync(supersedeFile, "utf8");
  // F16: the artifact being superseded may already be `approved` — the loop-companion cascade
  // (resolveGate, above) resolves the round's OTHER member to approved for every verb including
  // request, before this runs — an approved artifact superseded without clearing `approved_by` fails
  // the validator's own "only an approved artifact may name an approver" invariant (mirrors
  // dagwalk.ts's identical supersede-clears-approval handling for the live walk's own loop rounds; a
  // no-op when the old doc was already `in-review` with no approver, the pre-existing, unaffected case).
  const oldPatched = patchFrontmatter(oldSrc, { status: "superseded", approved_by: null });

  const newFile = join(unitDir, `${newId}.md`);
  writeFileSync(supersedeFile, oldPatched);
  writeFileSync(newFile, newDoc);
  const files = [supersedeFile, newFile, ...extraFiles];
  const commit = conductorCommit(root, files, `request changes on ${supersedeId} → ${newId}\n\n${note}`);
  return { ok: true, commit, changedFiles: files };
}

// The same doc shape dagwalk.ts#writeBlocked writes for the live walk's own member failures — kept as
// an independent copy (mirroring gates.ts's precedent for responsibleTeamFor/resolveStep) rather than
// exporting a dagwalk.ts internal into the board's write path. `supersedes` names the PRIOR attempt
// this retry replaces, so a repeated failure stays a proper chain, not a series of orphaned blocks.
function blockedRetryDoc(art: Artifact, newId: string, msg: string, today: string): string {
  return [
    "---",
    `kind: ${art.kind}`,
    `id: ${newId}`,
    `unit: ${art.unit}`,
    `project: ${art.project}`,
    "status: blocked",
    `produced_by: ${art.produced_by}`,
    "consumes: []",
    `supersedes: ${art.id}`,
    "approved_by: null",
    `created: ${today}`,
    "files: []",
    "---",
    "",
    `# ${art.kind} — blocked`,
    "",
    `The daemon could not produce this artifact: ${msg}`,
    "",
  ].join("\n");
}

// NOTES F19: a blocked artifact (a member ran and failed — dagwalk.ts#writeBlocked/produceOne) used
// to have no verbs at all: the only way to move past it was deleting the file by hand and committing.
// It now raises a gate with three: RETRY (re-invoke the same member with the same context — the
// context is re-assembled fresh from the SAME on-disk state, since nothing else has changed since the
// failure — through the exact `memberRunner.produce()` boundary every other invocation goes through,
// so this attempt's cost lands in the ledger exactly like any other), SKIP (mark the step abandoned;
// the walk continues past this kind if it can), ABANDON (pause the whole unit). The daemon itself
// NEVER calls this path — retry is exclusively a Conductor's explicit, costed decision; an unbounded
// automatic retry against a persistently-failing member would be a money fire, not a fix.
async function resolveBlockedArtifactGate(
  root: string,
  unit: WorkUnit,
  art: Artifact,
  verb: "retry" | "skip" | "abandon",
  memberRunner: AsyncMemberRunner,
  opts: ResolveOpts,
  today: string,
): Promise<GateOpResult> {
  if (art.status !== "blocked") {
    return { ok: false, status: 409, error: `artifact '${art.id}' is not blocked (status: ${art.status})` };
  }
  const located = locateArtifactFile(unit.dir, art.id);
  if (!located) return { ok: false, status: 404, error: `artifact file for '${art.id}' not found on disk` };

  if (verb === "abandon") {
    const unitFile = join(unit.dir, "unit.md");
    const unitPatched = patchFrontmatter(readFileSync(unitFile, "utf8"), { status: "paused" });
    writeFileSync(unitFile, unitPatched);
    const commit = conductorCommit(root, [unitFile], `abandon ${unit.unit}: pausing after ${art.id} blocked${opts.note ? `\n\n${opts.note}` : ""}`);
    return { ok: true, commit, changedFiles: [unitFile] };
  }

  if (verb === "skip") {
    // dagwalk.ts#nextAction treats a `skipped` step's artifact like an `approved` one for a plain
    // step — the walk continues past this kind on its next tick, if the rest of the flow can proceed
    // without it.
    const patched = patchFrontmatter(readFileSync(located.file, "utf8"), { status: "skipped" });
    const errs = validateArtifactSource(patched, located.file, dirname(located.file));
    if (errs.length > 0) return { ok: false, status: 422, error: `${errs[0].code}: ${errs[0].message}` };
    writeFileSync(located.file, patched);
    const commit = conductorCommit(root, [located.file], `skip ${art.id}: marking abandoned so the walk can continue${opts.note ? `\n\n${opts.note}` : ""}`);
    return { ok: true, commit, changedFiles: [located.file] };
  }

  // retry
  const [, member] = art.produced_by.split("/");
  const hasCap = memberRunner.capabilities().some((c) => c.member === member && c.kind === art.kind);
  if (!hasCap) return { ok: false, status: 501, error: `no producer available to retry '${art.produced_by}' for kind '${art.kind}'` };

  const nextRound = roundOf(art.id) + 1;
  const newId = bumpVersion(`${art.kind}-${unit.unit}`, nextRound);
  const invocation = opts.daemon?.beginInvocation({ project: art.project, unit: art.unit, member, kind: art.kind });
  let baseDoc: string;
  try {
    ({ doc: baseDoc } = await memberRunner.produce(member, art.kind, art.unit, art.project));
  } catch (e) {
    // Retried and failed again — a new blocked artifact records THIS attempt, superseding the last
    // one, so the gate stays actionable (retry/skip/abandon again) rather than wedging on a stale
    // failure the Conductor already saw.
    const msg = e instanceof Error ? e.message : String(e);
    const doc = blockedRetryDoc(art, newId, msg, today);
    const oldPatched = patchFrontmatter(readFileSync(located.file, "utf8"), { status: "superseded" });
    const newFile = join(unit.dir, `${newId}.md`);
    writeFileSync(located.file, oldPatched);
    writeFileSync(newFile, doc);
    conductorCommit(root, [located.file, newFile], `retry ${art.id} → ${newId} FAILED again: ${msg.slice(0, 120)}`);
    return { ok: false, status: 502, error: `retry failed: ${msg}` };
  } finally {
    if (invocation) opts.daemon!.endInvocation(invocation);
  }

  const newDoc = patchFrontmatter(baseDoc, { id: newId, supersedes: art.id });
  const errs = validateArtifactSource(newDoc, `${newId}.md`, unit.dir);
  if (errs.length > 0) return { ok: false, status: 422, error: `${errs[0].code}: ${errs[0].message}` };
  const oldPatched = patchFrontmatter(readFileSync(located.file, "utf8"), { status: "superseded" });
  const newFile = join(unit.dir, `${newId}.md`);
  writeFileSync(located.file, oldPatched);
  writeFileSync(newFile, newDoc);
  const files = [located.file, newFile];
  const commit = conductorCommit(root, files, `retry ${art.id} → ${newId} produced ${art.kind}`);
  return { ok: true, commit, changedFiles: files };
}

// C2/C7 shared companion rule, generalized by ruling F16: if `art.kind` is the artifact a loop's
// `until` condition actually names (the only kind `resolveGate` ever lets reach here — its own guard
// above refuses the other one directly), and a companion artifact of the loop's OTHER kind currently
// sits in-review for the same unit, that companion resolves to approved as part of THIS resolution —
// mirroring exactly what the Runner's `runLoop` does inside a live walk (see runner.ts). Previously
// hardcoded to "the loop's first (author) member is always the gate" — false for a loop whose `until`
// names its SECOND (critic) member, e.g. `until: review.approved`; the cascade now keys off `until`
// itself, so it fires regardless of which role is actually the gate. Returns the companion's file path
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
  if (!membership || !membership.companionKind) return null;
  if (isLoopCompanionKind(team, art.kind, capabilities)) return null; // defensive — resolveGate already refuses this case.

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

async function resolveStartGate(
  root: string,
  repo: Repo,
  project: string,
  unitId: string,
  verb: "start" | "notyet" | "rescope",
  memberRunner: AsyncMemberRunner,
  daemon?: Daemon,
): Promise<GateOpResult> {
  const unit = repo.units.find((u) => u.project === project && u.unit === unitId);
  if (!unit) return { ok: false, status: 404, error: `no unit '${unitId}' in project '${project}'` };
  if (verb === "notyet") return { ok: true, commit: "", changedFiles: [] }; // purely informational; nothing to persist
  if (verb === "start") return await doStart(root, repo, unit, memberRunner, daemon);
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
async function doStart(root: string, repo: Repo, unit: WorkUnit, memberRunner: AsyncMemberRunner, daemon?: Daemon): Promise<GateOpResult> {
  const unmet = unmetAfter(repo, unit);
  if (unmet.length > 0) return { ok: false, status: 409, error: `unit '${unit.unit}' still has unmet after: [${unmet.join(", ")}]` };
  const team = responsibleTeamFor(repo, unit);
  if (!team) return { ok: false, status: 409, error: `no team produces kinds for unit type '${unit.type}'` };

  // NOTES F10 defect 3: registers the invocation with the daemon's inFlight projection the instant
  // advanceUnit resolves what it's about to produce — the SAME window `daemon.ts#tickOnce`'s own
  // `onBeforeProduce` brackets for its own autonomous walk, so a Conductor-triggered start is visible
  // exactly like a daemon-tick-driven one, not invisible the whole time a real model call is thinking.
  let invocation: { project: string; unit: string; member: string; kind: string; startedAt: string } | undefined;
  const result = await advanceUnit(root, repo, unit, memberRunner, {
    startAuthorized: true,
    verb: "start",
    onBeforeProduce: (member, kind) => {
      invocation = daemon?.beginInvocation({ project: unit.project, unit: unit.unit, member, kind });
    },
  }).finally(() => {
    if (invocation && daemon) daemon.endInvocation(invocation);
  });
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

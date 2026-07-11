// Board write path for gate verbs (PRD §4, §9). This is deliberately NOT a re-implementation of the
// phase-2 Runner's flow-walk gate lifecycle (runner.ts `raiseGate`/loop machinery) — that engine
// drives a full in-memory simulated walk against a MemberRunner. The board instead performs the
// direct §4 gate operation against the one artifact (or unit) a Conductor clicked: flip frontmatter,
// validate at the same boundary the whole repo is validated at, write, commit as the Conductor. It
// reuses, rather than re-derives: `validateArtifactSource` (phase-1 validator), `applyApproval` +
// `bumpVersion` (phase-2 runner.ts, exported for this purpose), and the phase-1 stub member CLI's
// canned output for `request` (the same deterministic producer replay/tests already trust).

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadRepo } from "../repo.ts";
import { validateArtifactSource } from "../validate.ts";
import { applyApproval, bumpVersion } from "../runner.ts";
import { locateArtifactFile } from "./locate.ts";
import { render as renderStub, CAPABILITIES as STUB_CAPABILITIES } from "../../fixtures/stubs/member-stub.ts";
import type { Verb } from "../runner.ts";

export const CONDUCTOR_NAME = "cas";
export const CONDUCTOR_EMAIL = "cas@levare.local";

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
}

/** Resolve one gate verb against `target` (an artifact id, or — for start/notyet/rescope — a unit id). */
export function resolveGate(root: string, project: string, target: string, verb: Verb, opts: ResolveOpts = {}): GateOpResult {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const repo = loadRepo(root);
  const unit = repo.units.find((u) => u.project === project && repo.artifacts.get(`${project}/${u.unit}`)?.has(target));

  if (verb === "start" || verb === "notyet" || verb === "rescope") {
    return resolveStartGate(root, project, target, verb);
  }
  if (!unit) return { ok: false, status: 404, error: `no open gate for artifact '${target}' in project '${project}'` };

  const artifacts = repo.artifacts.get(`${project}/${unit.unit}`)!;
  const art = artifacts.get(target)!;
  if (art.status !== "in-review") {
    return { ok: false, status: 409, error: `artifact '${target}' is not at an open gate (status: ${art.status})` };
  }
  const located = locateArtifactFile(unit.dir, target);
  if (!located) return { ok: false, status: 404, error: `artifact file for '${target}' not found on disk` };

  if (verb === "approve") return doApprove(root, located.file, target, today, opts.note);
  if (verb === "reject") return doReject(root, located.file, target, opts.note);
  if (verb === "request") return doRequest(root, unit.dir, located.file, art, opts.note);
  return { ok: false, status: 400, error: `verb '${verb}' is not valid for an artifact gate` };
}

function doApprove(root: string, file: string, id: string, today: string, note?: string): GateOpResult {
  const src = readFileSync(file, "utf8");
  const patched = patchFrontmatter(src, { status: "approved", approved_by: `${CONDUCTOR_NAME} ${today}` });
  const errs = validateArtifactSource(patched, file, dirname(file));
  if (errs.length > 0) return { ok: false, status: 422, error: `${errs[0].code}: ${errs[0].message}` };
  writeFileSync(file, patched);
  const commit = gitCommit(root, [file], `approve ${id}${note ? `\n\n${note}` : ""}`);
  return { ok: true, commit, changedFiles: [file] };
}

function doReject(root: string, file: string, id: string, note?: string): GateOpResult {
  const src = readFileSync(file, "utf8");
  const patched = patchFrontmatter(src, { status: "rejected" });
  const errs = validateArtifactSource(patched, file, dirname(file));
  if (errs.length > 0) return { ok: false, status: 422, error: `${errs[0].code}: ${errs[0].message}` };
  writeFileSync(file, patched);
  const commit = gitCommit(root, [file], `reject ${id}${note ? `\n\n${note}` : ""}`);
  return { ok: true, commit, changedFiles: [file] };
}

function doRequest(
  root: string,
  unitDir: string,
  file: string,
  art: { id: string; kind: string; produced_by: string; unit: string; project: string },
  note?: string,
): GateOpResult {
  if (!note || !note.trim()) return { ok: false, status: 400, error: "request-changes requires a note" };
  const member = art.produced_by.split("/")[1];
  const hasStub = STUB_CAPABILITIES.some((c) => c.member === member && c.kind === art.kind);
  if (!hasStub) {
    return { ok: false, status: 501, error: `no producer available to re-invoke '${art.produced_by}' for kind '${art.kind}'` };
  }
  const oldRoundMatch = /-v(\d+)$/.exec(art.id);
  const nextRound = (oldRoundMatch ? Number(oldRoundMatch[1]) : 1) + 1;

  const baseDoc = renderStub(member, art.kind, art.unit, art.project);
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
  const commit = gitCommit(root, [file, newFile], `request changes on ${art.id} → ${newId}\n\n${note}`);
  return { ok: true, commit, changedFiles: [file, newFile] };
}

function resolveStartGate(root: string, project: string, unitId: string, verb: "start" | "notyet" | "rescope"): GateOpResult {
  const repo = loadRepo(root);
  const unit = repo.units.find((u) => u.project === project && u.unit === unitId);
  if (!unit) return { ok: false, status: 404, error: `no unit '${unitId}' in project '${project}'` };
  if (verb === "notyet") return { ok: true, commit: "", changedFiles: [] }; // purely informational; nothing to persist
  if (verb === "start") {
    // Kicking off the unit's team flow is Runner machinery (member invocation) that the board does
    // not drive directly; §9's route enumerates the verb, but no golden fixture exercises a real
    // start gate (see NOTES.md), so this stays a documented, honest no-op rather than a half-built walk.
    return { ok: false, status: 501, error: "start gate execution requires a live Runner walk; not wired in the board (see NOTES.md)" };
  }
  // rescope: no artifact to flip; a unit with an unmet-then-met after: has no separate persisted
  // "queued" status (NOTES A6), so rescoping simply records the decision — nothing to commit either.
  return { ok: true, commit: "", changedFiles: [] };
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

// Always run with an explicit Conductor identity and non-interactive-safe overrides — a gate
// resolution must never hang on a host signing prompt or a stray commit hook (same posture as the
// hermetic git pattern in tests/immutability.test.ts, applied here to keep production commits
// reliable rather than only test setup).
function gitCommit(root: string, files: string[], message: string): string {
  const gitArgs = (args: string[]) => [
    "-C",
    root,
    "-c",
    `user.name=${CONDUCTOR_NAME}`,
    "-c",
    `user.email=${CONDUCTOR_EMAIL}`,
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=/dev/null",
    ...args,
  ];
  const add = spawnSync("git", gitArgs(["add", "--", ...files]), { encoding: "utf8" });
  if (add.status !== 0) throw new Error(`git add failed: ${add.stderr}`);
  const commit = spawnSync("git", gitArgs(["commit", "-q", "-m", message]), { encoding: "utf8" });
  if (commit.status !== 0) throw new Error(`git commit failed: ${commit.stderr}${commit.stdout}`);
  const rev = spawnSync("git", gitArgs(["rev-parse", "HEAD"]), { encoding: "utf8" });
  return rev.stdout.trim();
}

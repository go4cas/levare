// Run-view timeline: "every runner walk, member spawn, and gate event" (design brief) — built from
// the sources of truth that actually exist on disk for a unit: `git log` on the unit's directory in
// the STUDIO's own repo, and — Findings 86/89 — `git log` on `levare/<unit>` in the PROJECT's own
// repo, the work a member actually did against the product itself. No separate event store; both are
// re-derived from disk on every request (invariant 2). (Finding 130: a third source, the §10 usage
// ledger `ledger.ndjson`, was removed — nothing in this codebase ever wrote that file.)

import { relative } from "node:path";
import { spawnSync } from "node:child_process";
import { CONDUCTOR_EMAIL, RUNNER_EMAIL } from "./git.ts";
import { resolveProjectRepoPath, workBranchName, branchExists, projectLog } from "./merge.ts";
import type { Project, WorkUnit } from "./types.ts";

/** Phase 2 cluster 3 part 3: who a timeline row is attributed to, structured rather than baked only
 * into `text`'s HTML — the run view uses this to render the design brief's own actor-avatar rule
 * ("agent initials on team tint, the Conductor as the only solid-filled disc, the Runner deliberately
 * gray"). `member` needs a repo lookup (a bare agent name, no team prefix) to tint correctly — that
 * lookup belongs to the render layer (which has `repo`), not here (which only has a raw git author).
 * `conductor`/`runner`/`member` are resolved right here by `resolveGitActor`, from the
 * exact identity shapes every real commit in the app funnels through (`git.ts#CONDUCTOR_EMAIL`/
 * `RUNNER_EMAIL`/`memberIdentity`, plus an optionally studio-declared human identity for the Conductor
 * — Finding 90) — never guessed by name alone. `unknown` is an honest fallback for a git identity that
 * matches none of those (e.g. a human editing files directly, under their OWN git identity, with no
 * `conductor_git_identity` declared to say who they are) — no avatar tint is fabricated for it. */
export interface TimelineActor {
  kind: "member" | "conductor" | "runner" | "unknown";
  name: string;
  /** Finding 90: for `kind: "conductor"` only — true when this exact commit's author/email IS
   * `git.ts#CONDUCTOR_NAME`/`CONDUCTOR_EMAIL` (levare's own `commitAs`, i.e. an app-mediated action);
   * false when it matched only via a studio-declared `conductor_git_identity` (the same human, but a
   * commit they made directly with their own git config, outside the app). The avatar is what unifies
   * "same person" (both resolve to the one solid Conductor disc) — `stamped` exists so the render layer
   * can still mark provenance visibly on top of that shared avatar, never by rewriting `name`. See
   * `git.ts#RUNNER_NAME`'s own doc comment on why collapsing "the app did this" into "a human decided
   * this" would misrepresent git log as a record of human decisions — this field, and `name` staying
   * the raw git author below, are what keep that same conflation from being reached from the other
   * direction (a human's own direct commit read as if levare recorded it). Absent for every other kind. */
  stamped?: boolean;
}

/** Finding 90: the one place a git (author, email) pair resolves to an actor — exhaustive over every
 * identity shape the app itself produces (`CONDUCTOR_EMAIL`, `RUNNER_EMAIL`, `git.ts#memberIdentity`'s
 * `<member>@levare.local` shape) plus, optionally, the studio's own declared human identity for the
 * Conductor. `unknown` is reserved for a git identity matching none of those — a genuinely unrecognized
 * human, not a member/runner/conductor commit this function merely failed to recognize by name alone.
 *
 * `name` is ALWAYS the raw git author, never the declared identity's name — a timeline built "from git
 * log" must keep showing what git actually recorded (an earlier version of this function rewrote it,
 * which silently relabeled a human's own hand-committed edit as if it were levare's `commitAs` output).
 * "Same person" is conveyed by `kind`/the shared avatar, not by rewriting the text; `stamped` carries
 * the provenance distinction that rewrite would otherwise have erased. */
export function resolveGitActor(name: string, email: string, declaredConductor?: { name: string; email: string }): TimelineActor {
  if (email === CONDUCTOR_EMAIL) return { kind: "conductor", name, stamped: true };
  if (email === RUNNER_EMAIL) return { kind: "runner", name };
  if (declaredConductor && email === declaredConductor.email) return { kind: "conductor", name, stamped: false };
  if (email === `${name}@levare.local`) return { kind: "member", name };
  return { kind: "unknown", name };
}

export interface TimelineRow {
  ts: string; // ISO
  kind: "commit";
  text: string;
  actor: TimelineActor;
}

export function gitLogRows(root: string, unitDir: string, declaredConductor?: { name: string; email: string }): TimelineRow[] {
  const rel = relative(root, unitDir);
  const r = spawnSync("git", ["-C", root, "log", "--format=%aI|%an|%ae|%s", "--", rel], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout.trim()) return [];
  return r.stdout
    .trim()
    .split("\n")
    .map((line) => {
      const [ts, author, email, ...subjectParts] = line.split("|");
      const subject = subjectParts.join("|");
      const actor = resolveGitActor(author, email, declaredConductor);
      return { ts, kind: "commit" as const, text: `<span class="who">${actor.name}</span> committed &mdash; ${subject}`, actor };
    });
}

export interface TimelineResult {
  rows: TimelineRow[];
  /** Set when the project repo's own commit history (the second source — Findings 86/89) could not be
   * read for this unit: no usable `repo:` at all, or `levare/<unit>` doesn't exist there yet. Absent
   * only when that source was genuinely read (even if it read as zero commits) — never conflated with
   * "no project commits happened", which is the exact Finding 77 class this exists to keep separate.
   * Prose, not a code: the two callers (board's `callout()`, orchestrator-projection's bare
   * `section()` lines) each present the same fact in their own idiom — see this goal's own ruling. */
  unavailable?: string;
}

/** The project repo's own commits on `levare/<unit>` that `default_branch` doesn't have yet — the
 * second timeline source. `project` is undefined exactly when `unit.project` names a project this
 * repo doesn't actually have (should never happen in a validated repo, but this is a read, not an
 * assumption); treated the same as "no usable repo" rather than assumed impossible. */
function projectLogRows(studioRoot: string, project: Pick<Project, "repo" | "default_branch"> | undefined, unitName: string, declaredConductor?: { name: string; email: string }): TimelineResult {
  const projectRepoPath = project ? resolveProjectRepoPath(studioRoot, project) : undefined;
  if (!projectRepoPath) return { rows: [], unavailable: "project repo not readable — no usable repo: declared for this project" };

  const branch = workBranchName(unitName);
  if (!branchExists(projectRepoPath, branch)) return { rows: [], unavailable: `work branch '${branch}' does not exist yet in the project repo` };

  const entries = projectLog(projectRepoPath, branch, project!.default_branch);
  if (!entries) return { rows: [], unavailable: `could not read '${branch}' commit history from the project repo` };

  const rows: TimelineRow[] = entries.map((e) => {
    const actor = resolveGitActor(e.author, e.email, declaredConductor);
    return { ts: e.ts, kind: "commit" as const, text: `<span class="who">${actor.name}</span> committed to the project repo &mdash; ${e.subject}`, actor };
  });
  return { rows };
}

export function buildTimeline(root: string, unit: Pick<WorkUnit, "dir" | "unit">, project: Pick<Project, "repo" | "default_branch"> | undefined, declaredConductor?: { name: string; email: string }): TimelineResult {
  const projectResult = projectLogRows(root, project, unit.unit, declaredConductor);
  const rows = [...gitLogRows(root, unit.dir, declaredConductor), ...projectResult.rows];
  rows.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  return { rows, unavailable: projectResult.unavailable };
}

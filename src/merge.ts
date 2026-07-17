// levare merge phase (PRD Amendment 2, M1–M5). This module owns every git operation the merge gate
// needs against a PROJECT's own repo — never the studio's own repo (git.ts's conductorCommit/
// runnerCommit/transactionalWrite own that entirely; the two are deliberately never mixed here).
//
// M1 — work branch: `levare/<unit>`, created from `default_branch`'s tip at unit-open time
// (board/gateops.ts#doStart). A plain `git branch` ref creation — never a checkout, never touches the
// project's working tree/index — so it is safe to call regardless of what the project repo's own
// working copy currently has checked out.
//
// M2 — trial merge: performed entirely inside a scratch git worktree, checked out DETACHED at
// `default_branch`'s tip (`git worktree add --detach`). A detached worktree shares the project repo's
// object store and refs but has its own HEAD, so a merge attempted there can never move
// `default_branch` itself, and never touches the project's own working tree either. Every path —
// clean, conflicted, or a git failure along the way — cleans the scratch worktree up (`worktree
// remove` + `worktree prune` + `rmSync`, each independent of whether the others succeeded).
//
// M4/M5 — execution: the same detached-worktree technique produces the merge COMMIT (never a
// squash/rebase — `git merge --no-ff`, preserving the work branch's own commit history verbatim), then
// `default_branch` is fast-forwarded to it with `git update-ref <ref> <new> <old>` — a compare-and-swap
// ref update, never a working-tree checkout. A declared `remote:` is pushed by exact SHA in the same
// call; a push failure resets the ref back to `<old>` with the identical compare-and-swap update-ref
// call (REV2's "capture the pre-write state, restore it exactly on failure" pattern, applied to a git
// ref instead of a file's bytes) — byte-perfect rollback, and the caller sees nothing was ever merged.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { checkGuardrails, type DiffEntry, type GuardrailViolation } from "./guardrails.ts";
import { RUNNER_NAME, RUNNER_EMAIL } from "./git.ts";
import type { Project, Team } from "./types.ts";

export class MergeError extends Error {}

// Mirrors git.ts's own HERMETIC_GIT_ENV exactly (NOTES CAP-B-FIX): every spawn below sets identity via
// `-c user.name=`/`-c user.email=`, and GIT_AUTHOR_*/GIT_COMMITTER_* env vars take precedence over a
// `-c` override — so the ambient env must be scrubbed here too, independently (this module never
// imports git.ts's private copy; both exist because they spawn against DIFFERENT repos — the studio vs.
// a project — and must never be confused into sharing one, even by accident of a shared constant).
const HERMETIC_GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: undefined,
  GIT_AUTHOR_EMAIL: undefined,
  GIT_COMMITTER_NAME: undefined,
  GIT_COMMITTER_EMAIL: undefined,
};

interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

function git(repoPath: string, args: string[]): GitResult {
  const r = spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8", env: HERMETIC_GIT_ENV });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export function workBranchName(unit: string): string {
  return `levare/${unit}`;
}

/**
 * Resolve a project's `repo:` to a real, local, git-initialized checkout — the only shape the merge
 * machinery can act on. Returns undefined for anything else: a bare placeholder/SSH URL never actually
 * cloned locally (the golden fixture's `storefront` project, deliberately — see NOTES MERGE-1), or the
 * studio's own root (a project declaring `repo: .`, e.g. the golden fixture's `studio` project) — the
 * merge machinery deliberately never touches that tree, since it is the SAME repo every gate resolution
 * in this whole app commits artifacts into (conductorCommit/runnerCommit), and branch-switching it out
 * from under those writers would be a correctness hazard the PRD never asked this goal to take on.
 */
export function resolveProjectRepoPath(studioRoot: string, project: Pick<Project, "repo">): string | undefined {
  const raw = project.repo;
  if (!raw) return undefined;
  const resolved = isAbsolute(raw) ? raw : join(studioRoot, raw);
  if (!existsSync(join(resolved, ".git"))) return undefined;
  try {
    if (realpathSync(resolved) === realpathSync(studioRoot)) return undefined;
  } catch {
    return undefined;
  }
  return resolved;
}

export function branchExists(repoPath: string, branch: string): boolean {
  return git(repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).status === 0;
}

export type CreateWorkBranchResult = { ok: true; created: boolean } | { ok: false; error: string };

/** M1: create `levare/<unit>` from `default_branch`'s tip, idempotently. A plain ref creation — never
 * a checkout — so it is safe regardless of what the project repo's working tree currently holds. */
export function createWorkBranch(repoPath: string, branch: string, defaultBranch: string): CreateWorkBranchResult {
  if (branchExists(repoPath, branch)) return { ok: true, created: false };
  const dflt = git(repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${defaultBranch}`]);
  if (dflt.status !== 0) {
    return { ok: false, error: `default_branch '${defaultBranch}' does not resolve in '${repoPath}': ${dflt.stderr.trim() || "not found"}` };
  }
  const created = git(repoPath, ["branch", branch, dflt.stdout.trim()]);
  if (created.status !== 0) return { ok: false, error: `git branch ${branch} failed: ${created.stderr.trim()}` };
  return { ok: true, created: true };
}

export type CheckoutResult = { ok: true } | { ok: false; error: string };

/**
 * Best-effort member-side wiring (goal item 1): check out `branch` in the project's OWN working tree
 * (never a per-member scratch copy — see NOTES MERGE-1 for exactly what that means is deferred: every
 * member dispatched against the same project shares one working tree and thus one checked-out branch
 * at a time, so two members concurrently dispatched against the SAME repo-bearing project race each
 * other's checkout). A no-op (returns ok immediately) when `branch` is already checked out.
 */
export function ensureWorkBranchCheckedOut(repoPath: string, branch: string): CheckoutResult {
  const current = git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (current.status === 0 && current.stdout.trim() === branch) return { ok: true };
  const co = git(repoPath, ["checkout", "-q", branch]);
  if (co.status !== 0) return { ok: false, error: `git checkout ${branch} failed: ${co.stderr.trim()}` };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// M2 — trial merge (scratch worktree only; never touches real branch state)
// ---------------------------------------------------------------------------

export interface TrialMergeResult {
  branch: string;
  target: string;
  commitsAhead: number;
  diffstat: string;
  diffFiles: string[];
  conflicted: boolean;
  conflicts: string[];
  /** Set only when the trial merge itself could not be attempted at all (missing branch/target, a
   * `git worktree` failure) — distinct from `conflicted`, which means the attempt ran and found one. */
  error?: string;
}

type ScratchResult<T> = { ok: true; value: T } | { ok: false; error: string };

function withScratchWorktree<T>(repoPath: string, startPoint: string, fn: (scratch: string) => T): ScratchResult<T> {
  const scratch = mkdtempSync(join(tmpdir(), "levare-mergewt-"));
  try {
    const wt = git(repoPath, ["worktree", "add", "--detach", "-q", scratch, startPoint]);
    if (wt.status !== 0) return { ok: false, error: `git worktree add failed: ${wt.stderr.trim()}` };
    try {
      return { ok: true, value: fn(scratch) };
    } finally {
      git(repoPath, ["worktree", "remove", "--force", scratch]);
      git(repoPath, ["worktree", "prune"]);
    }
  } finally {
    // Belt and suspenders (goal: "every scratch worktree is cleaned up on every path"): `worktree
    // remove` above already deletes this directory on the success path; rmSync is a no-op then, and
    // is what actually cleans up if `worktree remove` itself failed for any reason.
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** M2: never mutates `default_branch` or `branch` — the merge attempt happens in a scratch worktree
 * checked out DETACHED at `default_branch`'s tip, and is always undone (`merge --abort`) before the
 * worktree is torn down, whether it succeeded or conflicted. */
export function trialMerge(repoPath: string, branch: string, defaultBranch: string): TrialMergeResult {
  const empty = (error: string): TrialMergeResult => ({
    branch,
    target: defaultBranch,
    commitsAhead: 0,
    diffstat: "",
    diffFiles: [],
    conflicted: false,
    conflicts: [],
    error,
  });
  if (!branchExists(repoPath, branch)) return empty(`work branch '${branch}' does not exist`);
  const target = git(repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${defaultBranch}`]);
  if (target.status !== 0) return empty(`default_branch '${defaultBranch}' does not resolve`);

  const aheadR = git(repoPath, ["rev-list", "--count", `${defaultBranch}..${branch}`]);
  const commitsAhead = aheadR.status === 0 ? Number(aheadR.stdout.trim()) || 0 : 0;
  const diffstatR = git(repoPath, ["diff", "--stat", `${defaultBranch}...${branch}`]);
  const diffstat = diffstatR.status === 0 ? diffstatR.stdout.trim() : "";
  const namesR = git(repoPath, ["diff", "--name-only", `${defaultBranch}...${branch}`]);
  const diffFiles = namesR.status === 0 ? namesR.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];

  const attempt = withScratchWorktree(repoPath, defaultBranch, (scratch) => {
    const merge = git(scratch, ["-c", `user.name=${RUNNER_NAME}`, "-c", `user.email=${RUNNER_EMAIL}`, "merge", "--no-commit", "--no-ff", branch]);
    if (merge.status === 0) {
      git(scratch, ["merge", "--abort"]);
      return { conflicted: false, conflicts: [] as string[] };
    }
    const unmergedR = git(scratch, ["diff", "--name-only", "--diff-filter=U"]);
    const conflicts = unmergedR.status === 0 ? unmergedR.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
    git(scratch, ["merge", "--abort"]);
    return { conflicted: true, conflicts };
  });
  if (!attempt.ok) return empty(attempt.error);
  return { branch, target: defaultBranch, commitsAhead, diffstat, diffFiles, conflicted: attempt.value.conflicted, conflicts: attempt.value.conflicts };
}

// ---------------------------------------------------------------------------
// M3 — guardrails at execution, on the actual diff
// ---------------------------------------------------------------------------

/** M3: `protected_paths` against the files the merge touches, `protected_branches` against the target
 * — never against the operations performed (ruling C6's namespace split, applied here). A `never`
 * action names the merge/push operations THIS execution would perform, not an arbitrary vocabulary. */
export function mergeDiffEntries(diffFiles: string[], defaultBranch: string, willPush: boolean): DiffEntry[] {
  const entries: DiffEntry[] = diffFiles.map((path) => ({ path }));
  entries.push({ branch: defaultBranch, action: "merge" });
  if (willPush) entries.push({ branch: defaultBranch, action: "push" });
  return entries;
}

/** Every responsible team's guardrails apply to one merge — a unit can have more than one responsible
 * team (ruling C4, the per-kind walk), and the merge is one landing for all of their work together. */
export function checkGuardrailsForMerge(teams: Team[], diffFiles: string[], defaultBranch: string, willPush: boolean): GuardrailViolation[] {
  const entries = mergeDiffEntries(diffFiles, defaultBranch, willPush);
  const out: GuardrailViolation[] = [];
  for (const team of teams) out.push(...checkGuardrails(team, entries));
  return out;
}

// ---------------------------------------------------------------------------
// M4/M5 — execution: merge commit, ref fast-forward, push-in-transaction with rollback
// ---------------------------------------------------------------------------

export type MergeExecutionResult =
  | { ok: true; mergeCommit: string; pushed: boolean | null }
  | { ok: false; stage: "merge" | "push"; error: string };

/**
 * M4: produce a merge commit (`git merge --no-ff`, never squash/rebase — the work branch's own commit
 * history rides along verbatim) inside a scratch worktree detached at `default_branch`'s pre-merge tip,
 * then fast-forward the REAL `default_branch` ref to it with a compare-and-swap `update-ref` — never a
 * working-tree checkout of the project's own repo. M5: when `remote` is given, the exact merge commit
 * SHA is pushed to `remote`'s `default_branch` in the same call; a push failure resets the ref back to
 * its pre-merge value with the identical compare-and-swap update-ref call — byte-perfect rollback, and
 * the local repo ends the call in EXACTLY the state it was in before this function ran.
 */
export function executeMerge(repoPath: string, branch: string, defaultBranch: string, message: string, remote: string | null): MergeExecutionResult {
  const preRefR = git(repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${defaultBranch}`]);
  if (preRefR.status !== 0) return { ok: false, stage: "merge", error: `default_branch '${defaultBranch}' does not resolve` };
  const preSha = preRefR.stdout.trim();
  if (!branchExists(repoPath, branch)) return { ok: false, stage: "merge", error: `work branch '${branch}' does not exist` };

  const attempt = withScratchWorktree(repoPath, preSha, (scratch) => {
    const merge = git(scratch, [
      "-c",
      `user.name=${RUNNER_NAME}`,
      "-c",
      `user.email=${RUNNER_EMAIL}`,
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "merge",
      "--no-ff",
      "-m",
      message,
      branch,
    ]);
    if (merge.status !== 0) {
      git(scratch, ["merge", "--abort"]);
      return { ok: false as const, error: `merge failed: ${merge.stderr.trim()}` };
    }
    const rev = git(scratch, ["rev-parse", "HEAD"]);
    return { ok: true as const, sha: rev.stdout.trim() };
  });
  if (!attempt.ok) return { ok: false, stage: "merge", error: attempt.error };
  if (!attempt.value.ok) return { ok: false, stage: "merge", error: attempt.value.error };
  const mergeSha = attempt.value.sha;

  const updateRef = git(repoPath, ["update-ref", `refs/heads/${defaultBranch}`, mergeSha, preSha]);
  if (updateRef.status !== 0) {
    return { ok: false, stage: "merge", error: `update-ref failed (branch '${defaultBranch}' moved since the trial merge?): ${updateRef.stderr.trim()}` };
  }

  if (!remote) return { ok: true, mergeCommit: mergeSha, pushed: null };

  const push = git(repoPath, ["push", remote, `${mergeSha}:refs/heads/${defaultBranch}`]);
  if (push.status !== 0) {
    // M5: byte-perfect rollback — the identical compare-and-swap update-ref, in reverse.
    const rollback = git(repoPath, ["update-ref", `refs/heads/${defaultBranch}`, preSha, mergeSha]);
    if (rollback.status !== 0) {
      // Should not happen (nothing else touches this ref between the two calls) — surfaced loudly
      // rather than silently leaving the ref pointed at a merge commit whose push never landed.
      throw new MergeError(
        `push to '${remote}' failed (${push.stderr.trim() || push.stdout.trim() || "unknown reason"}) AND the local rollback itself failed (${rollback.stderr.trim()}) — refs/heads/${defaultBranch} in '${repoPath}' may point at an unpushed merge commit (${mergeSha}); resolve by hand`,
      );
    }
    return { ok: false, stage: "push", error: push.stderr.trim() || push.stdout.trim() || "push failed" };
  }
  return { ok: true, mergeCommit: mergeSha, pushed: true };
}

// ---------------------------------------------------------------------------
// The merge gate artifact itself — levare's own synthetic content (never a member's), same posture
// dagwalk.ts#writeBlocked/blockedRetryDoc already take for their own levare-authored records.
// ---------------------------------------------------------------------------

function q(s: string): string {
  return /^[A-Za-z0-9._/-]+$/.test(s) ? s : JSON.stringify(s);
}

/** Build the initial `kind: merge` artifact a merge gate opens with — always `status: in-review`,
 * `approved_by: null` (board/gateops.ts's `doApproveMerge`/`doRecheckMerge` own everything that
 * happens to this artifact after it exists, via the same patchFrontmatter/upsertFrontmatterMap
 * primitives every other gate resolution in this app already uses — this function is only ever called
 * once, at gate-open time). */
export function formatMergeArtifact(unit: string, project: string, id: string, created: string, trial: TrialMergeResult, guardrailViolations: string[]): string {
  const lines = [
    "---",
    "kind: merge",
    `id: ${id}`,
    `unit: ${unit}`,
    `project: ${project}`,
    "status: in-review",
    "produced_by: levare-runner",
    "consumes: []",
    "supersedes: null",
    "approved_by: null",
    `created: ${created}`,
    "files: []",
    "merge:",
    `  branch: ${q(trial.branch)}`,
    `  target: ${q(trial.target)}`,
    `  commits_ahead: ${trial.commitsAhead}`,
    `  diffstat: ${JSON.stringify(trial.diffstat)}`,
    `  conflicted: ${trial.conflicted}`,
    `  conflicts: [${trial.conflicts.map(q).join(", ")}]`,
    `  guardrail_violations: [${guardrailViolations.map(q).join(", ")}]`,
    "---",
    "",
    `# merge — ${trial.error ? "ERROR" : trial.conflicted ? "CONFLICTED" : "clean"}`,
    "",
    trial.error
      ? `The trial merge could not run: ${trial.error}`
      : trial.conflicted
        ? `${trial.commitsAhead} commit(s) on \`${trial.branch}\` ahead of \`${trial.target}\`. The trial merge conflicts on: ${trial.conflicts.join(", ")}. Resolve by hand on \`${trial.branch}\` in the project repo, then use the recheck verb.`
        : `${trial.commitsAhead} commit(s) on \`${trial.branch}\` ahead of \`${trial.target}\`, merges cleanly.${guardrailViolations.length ? ` Guardrail check found: ${guardrailViolations.join("; ")}` : ""}`,
    "",
  ];
  return lines.join("\n");
}

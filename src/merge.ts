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
import { mkdtempSync, rmSync, existsSync, realpathSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { checkGuardrails, violationLine, type DiffEntry, type GuardrailViolation } from "./guardrails.ts";
import { RUNNER_NAME, RUNNER_EMAIL, resolveGlobalExcludesFile, resolveGlobalAttributesFile } from "./git.ts";
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

// Finding 77: `~` is not absolute, so leaving it unexpanded silently mis-resolves `repo: ~/code/foo`
// to `<studioRoot>/~/code/foo` — a config that reads as correct and does nothing. Only `~/` and a bare
// `~` expand, against the real home; `~user` is deliberately left alone (needs a passwd lookup nobody
// has asked for).
function expandTilde(raw: string, home: string): string {
  if (raw === "~") return home;
  if (raw.startsWith("~/")) return join(home, raw.slice(2));
  return raw;
}

/** Tilde-expand and studio-root-join a `repo:` value, WITHOUT checking whether the result is a real
 * git checkout or the studio's own self-referential root — the same first step `resolveProjectRepoPath`
 * takes internally, exported separately so validate.ts's PROJECT_REPO_UNRESOLVED warning (Finding 77)
 * can name what an unresolvable `repo:` resolved TO, not just that resolution failed. `home` defaults
 * to the real home (`node:os#homedir`) and is only ever overridden by a test — mirrors doctor.ts's own
 * injectable `home`/`resolveCliPath` defaults. */
export function resolveProjectRepoPathRaw(studioRoot: string, raw: string, home: string = homedir()): string {
  const expanded = expandTilde(raw, home);
  return isAbsolute(expanded) ? expanded : join(studioRoot, expanded);
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
export function resolveProjectRepoPath(studioRoot: string, project: Pick<Project, "repo">, home?: string): string | undefined {
  const raw = project.repo;
  if (!raw) return undefined;
  const resolved = resolveProjectRepoPathRaw(studioRoot, raw, home);
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

export interface ProjectLogEntry {
  ts: string; // %aI
  author: string;
  email: string;
  subject: string;
}

/** Goal "the timeline reads the project repo" (Findings 86/89): every commit `branch` carries that
 * `defaultBranch` doesn't yet — the exact range idiom `trialMerge`'s own `commitsAhead` already uses
 * (`<default_branch>..<branch>`, never a bare `git log <branch>`, which would replay the branch's
 * entire upstream history through the fork point, not just this unit's own commits). Returns undefined
 * only on a git failure (e.g. `defaultBranch` itself doesn't resolve) — distinct from `[]`, a genuinely
 * empty range. The caller (timeline.ts) must not conflate the two: `branchExists` already gates the
 * "branch doesn't exist at all" case before this ever runs, so a failure here means something else
 * (Finding 77's own class — a read that fails must never render as "nothing happened"). */
export function projectLog(repoPath: string, branch: string, defaultBranch: string): ProjectLogEntry[] | undefined {
  const r = git(repoPath, ["log", "--format=%aI|%an|%ae|%s", `${defaultBranch}..${branch}`]);
  if (r.status !== 0) return undefined;
  if (!r.stdout.trim()) return [];
  return r.stdout
    .trim()
    .split("\n")
    .map((line) => {
      const [ts, author, email, ...subjectParts] = line.split("|");
      return { ts, author, email, subject: subjectParts.join("|") };
    });
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

// ---------------------------------------------------------------------------
// NOTES R4-SANDBOX (Ruling 1) — worktree per dispatch: a per-member-invocation scratch worktree of the
// unit's own work branch, extending the trial-merge/execution scratch-worktree TECHNIQUE above to a
// third, structurally distinct caller. Unlike `withScratchWorktree` (a callback-scoped helper: create,
// run a synchronous git command inside, tear down, all within one function call), a dispatch worktree
// must stay alive across an entire member invocation (context assembly already happened; the spawn/SDK
// call is what actually reads and writes inside it) — so this returns a plain create/cleanup pair, the
// same shape `env.ts#scopeHome` already uses for its own per-spawn scratch resource.
//
// Checked out NORMALLY (never `--detach`, unlike the trial-merge/execution worktrees above): a member's
// own commits must actually advance `levare/<unit>`, which only happens if the worktree has that branch
// checked out for real. Two DIFFERENT units on the same project repo get two independent worktrees of
// two different branches — git worktree has no exclusivity conflict there, which is exactly the
// concurrent-dispatch case this ruling closes (the old shared-single-working-tree checkout raced
// whichever dispatch's `git checkout` ran last). Two dispatches against the SAME unit's SAME branch at
// once is not a case this — or the pre-existing flow model — ever produces (a loop's own two members
// alternate sequentially; see NOTES R4-SANDBOX for the full reasoning): git itself would refuse a second
// `worktree add` of a branch already checked out elsewhere, which is a loud, honest failure, never a
// silent race, if that assumption is ever wrong.
// ---------------------------------------------------------------------------

export interface DispatchWorktree {
  path: string;
  /**
   * NOTES R4-SANDBOX-FIX-8 (security narrowing of FIX-7's own write grant): the resolved
   * `.git/worktrees/<name>` administrative directory for THIS worktree specifically — where its own
   * `HEAD`, `index`, `logs/HEAD`, and `COMMIT_EDITMSG` actually live (git's worktree design, never inside
   * `path` itself). Read directly from the worktree's own `.git` pointer file (`gitdir: <path>`, written
   * by `git worktree add` itself) rather than assumed from a naming scheme — git can rename the admin
   * directory on a name collision, so reading it back is the only way to know it exactly, not guess it.
   * `adapters.ts#sandboxWrap` grants write access to exactly this directory, never to any OTHER
   * worktree's own admin state sharing the same original repo.
   */
  gitDir: string;
  /** Goal "commit-on-produce": the branch's tip SHA at the moment this worktree was checked out, i.e.
   * before the dispatch that owns this worktree ever ran — `commitDispatchWorktree`'s own "did anything
   * actually land" check compares the branch's tip AFTER against this, never against whether the runner
   * itself happened to be the one that committed (a member that already self-commits its own work, e.g.
   * NOTES R4-SANDBOX-FIX-7's CLI sandbox path, must not read as "nothing happened" just because there
   * was nothing left FOR commitDispatchWorktree to do). */
  baseSha: string;
  cleanup(): void;
}

export type CreateDispatchWorktreeResult = { ok: true; worktree: DispatchWorktree } | { ok: false; error: string };

// NOTES R4-SANDBOX-FIX-8: parses the `gitdir: <path>` pointer `git worktree add` itself writes into the
// new worktree's own `.git` (a plain file, never a real git directory, for any worktree — only the
// PRIMARY checkout has a real `.git` directory). Returns undefined on anything unexpected (missing file,
// unrecognized format) rather than guessing — `createDispatchWorktree` treats that as a creation failure,
// the same loud-never-silent posture every other failure in this function already takes.
function resolveWorktreeGitDir(worktreePath: string): string | undefined {
  try {
    const pointer = readFileSync(join(worktreePath, ".git"), "utf8").trim();
    const m = /^gitdir:\s*(.+)$/.exec(pointer);
    return m ? m[1] : undefined;
  } catch {
    return undefined;
  }
}

// Unit "member authorship survives a self-commit": a member's OWN `git commit` — run directly via its
// Bash tool (`kind: native`), or by its own vendor CLI's internal git invocation (`kind: cli`, whenever
// the sandbox never reaches a working "full" tier — confirmed live on this very host: bwrap/unshare both
// refuse to create a namespace here, so `detectSandbox()` returns `none` and the spawn runs exactly as
// unconfined as native) — never passes through `commitDispatchWorktree`'s own inline `-c` flags below.
// It resolves identity, `commit.gpgsign`, and `core.hooksPath` entirely from AMBIENT config, which today
// means the real, unscoped operator `$HOME` (`env.ts#buildMemberEnv`'s baseline copies `HOME` straight
// from the daemon's own process env unless a `home:`-declaring subscription connector scopes it) — the
// live defect this unit exists to close: a member's own commit silently lands as the OPERATOR's global
// git identity, not the member's.
//
// `extensions.worktreeConfig` + `git config --worktree` is the only per-DISPATCH (not per-repo, not
// per-process) scope git itself offers, confirmed by direct repro (not assumed): a value set with
// `--worktree` in one worktree is invisible from the primary checkout and from a sibling worktree of the
// same repo, which is exactly the isolation two concurrent dispatches for two DIFFERENT members need —
// a plain `--local` write here would instead land in the shared `$GIT_DIR/config`, contaminating the
// project's own checkout and racing every other concurrent dispatch on the same repo. Enabling the
// extension itself is a one-time, idempotent, repo-wide flag (git's own `config.lock` serializes
// concurrent enablers) that sets no per-worktree value by itself.
//
// `user.name`/`user.email` close the identity gap; `commit.gpgsign=false` and `core.hooksPath=/dev/null`
// close the SAME gap for the two settings `commitDispatchWorktree` already protects its OWN commit with
// below, which a member's bare commit currently bypasses entirely — gpgsign because an inherited real
// HOME can reach the operator's own live gpg-agent (silently signing AS the operator, not just
// mis-naming them); hooks because a linked worktree shares the primary checkout's real `.git/hooks`
// directory verbatim (git has no per-worktree hooks dir), and NOTES R4-SANDBOX-FIX-8's own write grant
// deliberately excludes `.git/hooks`/`.git/config` as code-execution vectors specifically so a sandboxed
// member could never reach them — a fact a member's own UNSANDBOXED commit (every native dispatch; every
// cli dispatch on a host with no working sandbox primitive) was never protected by in the first place.
// All three are ordinary config keys with identical `--worktree` precedence — one write, same mechanism,
// same reach; no separate treatment needed for identity vs. these two.
//
// Deliberately does NOT prevent a member from overriding any of these on its own command line (`git -c
// user.email=... commit`) or by rewriting `config.worktree` itself (the sandboxed admin-dir write grant
// that makes THIS function's own write reachable under a full sandbox — see its own call site's doc —
// necessarily makes that file reachable to a member's own sandboxed commit too). Ruling: accept it,
// don't prevent it — a member writing its own `-c` override is acting deliberately, and levare cannot
// stop a process it granted real shell access to. What it must not do is pass unnoticed:
// `commitDispatchWorktree`'s own detection below (`unexpectedActor`) is what surfaces an override instead
// of silently trusting it.
function configureDispatchWorktreeGitConfig(repoPath: string, worktreePath: string, identity: { name: string; email: string }): string | undefined {
  const ext = git(repoPath, ["config", "extensions.worktreeConfig", "true"]);
  if (ext.status !== 0) return `git config extensions.worktreeConfig failed: ${ext.stderr.trim()}`;
  const settings: Array<[string, string]> = [
    ["user.name", identity.name],
    ["user.email", identity.email],
    ["commit.gpgsign", "false"],
    ["core.hooksPath", "/dev/null"],
  ];
  for (const [key, value] of settings) {
    const r = git(worktreePath, ["config", "--worktree", key, value]);
    if (r.status !== 0) return `git config --worktree ${key} failed: ${r.stderr.trim()}`;
  }
  return undefined;
}

export function createDispatchWorktree(repoPath: string, branch: string, identity: { name: string; email: string }): CreateDispatchWorktreeResult {
  const scratch = mkdtempSync(join(tmpdir(), "levare-dispatchwt-"));
  const wt = git(repoPath, ["worktree", "add", "-q", scratch, branch]);
  if (wt.status !== 0) {
    rmSync(scratch, { recursive: true, force: true });
    return { ok: false, error: `git worktree add failed: ${wt.stderr.trim()}` };
  }
  const gitDir = resolveWorktreeGitDir(scratch);
  if (!gitDir) {
    git(repoPath, ["worktree", "remove", "--force", scratch]);
    rmSync(scratch, { recursive: true, force: true });
    return { ok: false, error: `worktree at '${scratch}' has no readable/recognizable .git pointer file — cannot determine its own admin directory` };
  }
  const configError = configureDispatchWorktreeGitConfig(repoPath, scratch, identity);
  if (configError) {
    git(repoPath, ["worktree", "remove", "--force", scratch]);
    rmSync(scratch, { recursive: true, force: true });
    return { ok: false, error: `could not configure dispatch worktree git identity: ${configError}` };
  }
  const baseSha = git(scratch, ["rev-parse", "HEAD"]).stdout.trim();
  let cleaned = false;
  return {
    ok: true,
    worktree: {
      path: scratch,
      gitDir,
      baseSha,
      cleanup() {
        if (cleaned) return;
        cleaned = true;
        git(repoPath, ["worktree", "remove", "--force", scratch]);
        git(repoPath, ["worktree", "prune"]);
        rmSync(scratch, { recursive: true, force: true });
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Commit-on-produce (goal "commit-on-produce — the work must survive the worktree", Finding 74): a
// member's own file edits inside its dispatch worktree are otherwise pure working-tree state — nothing
// durable exists until it lands on the branch ref (shared with the original repo), which is NOT what
// `createDispatchWorktree#cleanup` force-deletes on teardown (that deletes the scratch directory, i.e.
// the working tree/index, not the ref). Captures whatever the member left uncommitted at teardown time
// as exactly one commit, authored as the member (never levare-runner/cas — see git.ts#memberIdentity's
// own doc), so a dispatch's code survives even when the member itself never ran `git commit`. A no-op
// when the worktree is already clean — either the member already committed its own work along the way
// (NOTES R4-SANDBOX-FIX-7's self-commit path, still fully supported: this only picks up what's LEFT),
// or the dispatch genuinely changed nothing — the caller (adapters.ts#author) distinguishes "clean" from
// "committed" and stamps which one happened onto the produced artifact (`code_commit:`), so an empty
// dispatch is visible, never silently indistinguishable from one that committed real work.
// ---------------------------------------------------------------------------

/** The observed author/committer identity of a landed dispatch commit, recorded ONLY when it doesn't
 * match the `identity` `commitDispatchWorktree` was given — i.e. a member's own commit (native Bash tool,
 * or a `cli` member's own vendor process) resolved SOME OTHER ambient identity instead of ever going
 * through this function's own `-c` override below, or explicitly overrode it on its own command line.
 * Detection only (see `commitDispatchWorktree`'s own doc) — never used to block or rewrite the commit. */
export interface DispatchCommitActor {
  authorName: string;
  authorEmail: string;
  committerName: string;
  committerEmail: string;
}

export type DispatchCommitResult =
  | { committed: true; commit: string; unexpectedActor?: DispatchCommitActor }
  | { committed: false; reason: "clean" }
  | { committed: false; reason: "error"; error: string };

// Unit "member authorship survives a self-commit": reads back the LANDED commit's own author/committer
// (never assumed from `identity` — a member's own commit, self-committed before this function ever ran,
// may have resolved a completely different identity, which is exactly the case this exists to catch) and
// compares against what this dispatch expected. `undefined` on a read failure (an unreadable `commit`,
// which should never happen for a SHA this same function just resolved via `rev-parse HEAD`, but this is
// detection, not a hard dependency — a failure here must never turn into a thrown error that blocks an
// otherwise-successful dispatch).
function readCommitActor(worktreePath: string, commit: string): DispatchCommitActor | undefined {
  const r = git(worktreePath, ["log", "-1", "--format=%an%x1f%ae%x1f%cn%x1f%ce", commit]);
  if (r.status !== 0) return undefined;
  const [authorName, authorEmail, committerName, committerEmail] = r.stdout.trim().split("\x1f");
  if (authorEmail === undefined || committerEmail === undefined) return undefined;
  return { authorName, authorEmail, committerName, committerEmail };
}

function detectUnexpectedActor(worktreePath: string, commit: string, identity: { name: string; email: string }): DispatchCommitActor | undefined {
  const actor = readCommitActor(worktreePath, commit);
  if (!actor) return undefined;
  const matches = actor.authorName === identity.name && actor.authorEmail === identity.email && actor.committerName === identity.name && actor.committerEmail === identity.email;
  return matches ? undefined : actor;
}

/** If `worktreePath` has uncommitted changes (tracked or untracked), commits all of them as one commit
 * under `identity` — this must never create an empty commit (see this section's own header), so nothing
 * is touched when the tree is already clean. Either way, reports `{ committed: true, commit }` when the
 * branch's tip now differs from `baseSha` (this dispatch's changes — whether just committed here, or
 * already self-committed by the member beforehand, e.g. NOTES R4-SANDBOX-FIX-7's CLI sandbox path — are
 * on the branch) or `{ committed: false, reason: "clean" }` when it still equals `baseSha` (nothing
 * happened this dispatch at all). A `status`/`add`/`commit` failure reports `{ committed: false, reason:
 * "error" }` rather than throwing — the caller decides how loud to be (adapters.ts#produce/produceAsync
 * throw an AdapterError on it, turning it into a `blocked` artifact via dagwalk.ts#produceOne's existing
 * member-failure handling, the same path every other member failure already takes — never silently
 * discarded alongside the worktree).
 *
 * Unit "member authorship survives a self-commit": `unexpectedActor` is set on the `committed: true` case
 * whenever the LANDED commit's own author/committer doesn't match `identity` — this fires both for a
 * member's own bare commit that resolved some other ambient identity (the live defect this unit closes)
 * and for a member that deliberately overrode identity on its own command line (accepted, never
 * prevented — see `configureDispatchWorktreeGitConfig`'s own doc — but surfaced here regardless of which
 * case it was, since this function has no way to tell them apart and no need to). Absent whenever this
 * function did the committing itself (its own `-c` flags below always match `identity` by construction). */
export function commitDispatchWorktree(worktreePath: string, baseSha: string, message: string, identity: { name: string; email: string }): DispatchCommitResult {
  // Finding 120: resolved against the real ambient env, BEFORE any HERMETIC_GIT_ENV-scrubbed spawn runs
  // below — passed through explicitly as `-c core.excludesFile=` on both `status` (so "is this worktree
  // dirty" agrees with what `add` is about to stage) and `add` (so a file the operator's global ignore
  // excludes is never what makes this a non-empty, committable dispatch) — see resolveGlobalExcludesFile's
  // own doc for why HOME being real here still isn't enough on its own.
  const excludesFlag = (() => {
    const excludesFile = resolveGlobalExcludesFile();
    return excludesFile ? ["-c", `core.excludesFile=${excludesFile}`] : [];
  })();
  // Finding 144: same gap, `core.attributesFile` — a clean filter or eol rule from the operator's global
  // attributes governs the bytes `add` stages, so it belongs only on `add` (never `status`, which never
  // invokes a filter — see resolveGlobalAttributesFile's own doc for why this must apply even though
  // `add -A`'s expansion, unlike an explicit path, was never the part attributesFile protects against).
  const attributesFlag = (() => {
    const attributesFile = resolveGlobalAttributesFile();
    return attributesFile ? ["-c", `core.attributesFile=${attributesFile}`] : [];
  })();
  const status = git(worktreePath, [...excludesFlag, "status", "--porcelain"]);
  if (status.status !== 0) return { committed: false, reason: "error", error: `git status failed: ${status.stderr.trim()}` };

  if (status.stdout.trim() !== "") {
    const add = git(worktreePath, [...excludesFlag, ...attributesFlag, "add", "-A"]);
    if (add.status !== 0) return { committed: false, reason: "error", error: `git add failed: ${add.stderr.trim()}` };

    const commit = git(worktreePath, ["-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`, "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", message]);
    if (commit.status !== 0) return { committed: false, reason: "error", error: `git commit failed: ${commit.stderr.trim()}${commit.stdout.trim()}` };
  }

  const rev = git(worktreePath, ["rev-parse", "HEAD"]);
  if (rev.status !== 0) return { committed: false, reason: "error", error: `git rev-parse HEAD failed: ${rev.stderr.trim()}` };
  const head = rev.stdout.trim();
  if (head === baseSha) return { committed: false, reason: "clean" };
  const unexpectedActor = detectUnexpectedActor(worktreePath, head, identity);
  return unexpectedActor ? { committed: true, commit: head, unexpectedActor } : { committed: true, commit: head };
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
  /** NOTES SEC-V11 F2: the exact commit SHA of `branch` this trial evaluated — the pin `executeMerge`
   * checks the branch STILL points at before landing, closing the TOCTOU window between "guardrails
   * were checked against this diff" and "this is what actually got merged" (see `executeMerge`'s own
   * doc). Undefined only when the trial couldn't resolve the branch at all (the `error` case below). */
  branchSha?: string;
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
  const branchShaR = git(repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (branchShaR.status !== 0) return empty(`work branch '${branch}' does not exist`);
  const branchSha = branchShaR.stdout.trim();
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
  return { branch, target: defaultBranch, commitsAhead, diffstat, diffFiles, conflicted: attempt.value.conflicted, conflicts: attempt.value.conflicts, branchSha };
}

// ---------------------------------------------------------------------------
// M3 — guardrails at execution, on the actual diff
// ---------------------------------------------------------------------------

/** M3: `protected_paths` against the files the merge touches, `protected_branches` against the target
 * — never against the operations performed (ruling C6's namespace split, applied here). A `never`
 * action names the merge/push operations THIS execution would perform, not an arbitrary vocabulary.
 * `approvedGate`, when given, is stamped onto every branch entry — this is only ever supplied by
 * board/gateops.ts#doApproveMerge, at the one moment it IS the approved gate executing (see
 * guardrails.ts's own header); a preview/recheck call passes nothing, so `protected-branch` still
 * reports honestly ahead of approval. */
export function mergeDiffEntries(diffFiles: string[], defaultBranch: string, willPush: boolean, approvedGate?: DiffEntry["approvedGate"]): DiffEntry[] {
  const entries: DiffEntry[] = diffFiles.map((path) => ({ path }));
  entries.push({ branch: defaultBranch, action: "merge", approvedGate });
  if (willPush) entries.push({ branch: defaultBranch, action: "push", approvedGate });
  return entries;
}

/** Every responsible team's guardrails apply to one merge — a unit can have more than one responsible
 * team (ruling C4, the per-kind walk), and the merge is one landing for all of their work together. */
export function checkGuardrailsForMerge(teams: Team[], diffFiles: string[], defaultBranch: string, willPush: boolean, approvedGate?: DiffEntry["approvedGate"]): GuardrailViolation[] {
  const entries = mergeDiffEntries(diffFiles, defaultBranch, willPush, approvedGate);
  const out: GuardrailViolation[] = [];
  for (const team of teams) out.push(...checkGuardrails(team, entries));
  return out;
}

// ---------------------------------------------------------------------------
// M4/M5 — execution: merge commit, ref fast-forward, push-in-transaction with rollback
// ---------------------------------------------------------------------------

export type MergeExecutionResult =
  | { ok: true; mergeCommit: string; pushed: boolean | null }
  | { ok: false; stage: "merge" | "push" | "stale"; error: string };

/**
 * M4: produce a merge commit (`git merge --no-ff`, never squash/rebase — the work branch's own commit
 * history rides along verbatim) inside a scratch worktree detached at `default_branch`'s pre-merge tip,
 * then fast-forward the REAL `default_branch` ref to it with a compare-and-swap `update-ref` — never a
 * working-tree checkout of the project's own repo. M5: when `remote` is given, the exact merge commit
 * SHA is pushed to `remote`'s `default_branch` in the same call; a push failure resets the ref back to
 * its pre-merge value with the identical compare-and-swap update-ref call — byte-perfect rollback, and
 * the local repo ends the call in EXACTLY the state it was in before this function ran.
 *
 * NOTES SEC-V11 F2: `expectedBranchSha`, when given, is the exact commit a prior `trialMerge` evaluated
 * (and a caller like `board/gateops.ts#doApproveMerge` already checked guardrails against). This
 * function resolves `branch`'s CURRENT tip itself — never trusting the caller's own possibly-stale
 * belief — and refuses (`stage: "stale"`) if it no longer matches, rather than silently merging whatever
 * `branch` now points at. The merge itself is performed by SHA, not by ref name, closing even the
 * residual window between this check and the `git merge` call below: a work branch advanced between
 * the guardrail check and this call (a foreign CLI member's commit landing mid-approval, e.g.) can never
 * carry unreviewed content past the gate — the caller gets a clear "recheck required" error instead.
 */
export function executeMerge(repoPath: string, branch: string, defaultBranch: string, message: string, remote: string | null, expectedBranchSha?: string): MergeExecutionResult {
  const preRefR = git(repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${defaultBranch}`]);
  if (preRefR.status !== 0) return { ok: false, stage: "merge", error: `default_branch '${defaultBranch}' does not resolve` };
  const preSha = preRefR.stdout.trim();
  const branchShaR = git(repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (branchShaR.status !== 0) return { ok: false, stage: "merge", error: `work branch '${branch}' does not exist` };
  const branchSha = branchShaR.stdout.trim();
  if (expectedBranchSha !== undefined && branchSha !== expectedBranchSha) {
    return {
      ok: false,
      stage: "stale",
      error: `work branch '${branch}' advanced since check — recheck required (checked ${expectedBranchSha}, now at ${branchSha})`,
    };
  }

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
      branchSha,
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

/**
 * Ruling (2026-08-20, live incident against `jot`): M4's "never a checkout" guarantee is deliberate
 * and stays load-bearing — `executeMerge` must keep working correctly regardless of what the project
 * repo's own primary checkout has checked out, or how dirty it is, and a conditional checkout would
 * re-introduce exactly the hazard `update-ref` was chosen to avoid. But that guarantee has exactly one
 * blind spot: when the primary checkout's `HEAD` symbolically resolves to `default_branch` itself —
 * the ordinary state right after `doStart` opens a work branch off it — `update-ref` moves the ref
 * `HEAD` points at without touching the index or working tree, so `git status` there no longer
 * matches the merge (it diffs the index against the now-advanced HEAD tree): a file the merge
 * INTRODUCED reads as staged for deletion, a file it MODIFIED reads as a staged reversion to its
 * pre-merge content. Both shapes observed live against `jot` — `find-entries` (five new files, all
 * `D `) and `find-since` (one modified file, `M `). This function detects exactly that condition.
 * Read-only, and called strictly AFTER `executeMerge`'s own transaction has already concluded
 * (success or failure) — it never gates, influences, or rolls back the merge itself; it only reports
 * on what a successful one left behind, so the caller can say so instead of staying silent about it.
 */
export function checkoutBehindMerge(repoPath: string, defaultBranch: string): boolean {
  const head = git(repoPath, ["symbolic-ref", "--quiet", "HEAD"]);
  return head.status === 0 && head.stdout.trim() === `refs/heads/${defaultBranch}`;
}

/** The exact recovery command named in the merge artifact/board notice when `checkoutBehindMerge`
 * finds the operator's checkout behind: `stash -u` first so any of the operator's OWN real
 * uncommitted work on that checkout is preserved rather than discarded, THEN a hard reset to bring
 * the index/working tree in line with the ref `executeMerge` already moved — safe unconditionally,
 * whether or not the checkout happened to be dirty for unrelated reasons at merge time. */
export const CHECKOUT_SYNC_COMMAND = "git stash -u && git reset --hard HEAD";

/** The exact notice `doApproveMerge` appends to a merge artifact's body when `checkoutBehindMerge`
 * found the operator's checkout behind (board/gateops.ts). Exported as a pure function of
 * `defaultBranch` — not inlined at the write site — so validate.ts's immutability check can
 * independently RECOMPUTE the same text and require an exact match, rather than pattern-matching a
 * marker inside untrusted post-approval content (see validate.ts#stripCheckoutSyncNotice's own doc
 * for why that distinction is load-bearing). One function, called from both the write side and the
 * read side — the text can't drift between them, and there is nothing here for member-authored
 * content to imitate: a match requires reproducing this exact string, which is not a mutation.
 *
 * STOP BEFORE YOU EDIT THIS STRING. Every artifact ever approved with the checkout-sync notice
 * attached has THIS EXACT TEXT baked into its own pre-approval baseline — validate.ts reconstructs it
 * from THIS function to recognize and strip that notice as an approval-time write, not a mutation.
 * Changing the wording here, in place, retroactively breaks that recognition for every artifact
 * approved under the old wording: `stripCheckoutSyncNotice` stops matching, the notice reads as
 * unexplained body drift, and MODIFIED_AFTER_APPROVAL fires on a byte-identical, never-touched file.
 * This is exactly how ~/source/jot-studio went down on 2026-08-23 — PR #26 reworded this function,
 * and every merge artifact approved under the pre-#26 wording failed validation from that point on,
 * with nothing else about them ever having changed.
 *
 * Before changing the return value below: copy the CURRENT body, verbatim, into a new entry at the
 * end of `FORMER_CHECKOUT_SYNC_NOTICES` (below), dated and commented with the PR retiring it. Only
 * then edit the wording here. Skipping that step is the mistake — this function has no way to catch
 * it for you; the array is what makes the old wording still recognizable afterward. */
export function formatCheckoutSyncNotice(defaultBranch: string): string {
  return `**Checkout out of sync:** \`${defaultBranch}\` was checked out in the project repo's own working tree when this merge landed. This merge never touches that working tree by design (M4) — \`git status\` there will not match the merge until synced: files it introduced show staged for deletion, files it modified show staged as reversions to their pre-merge content. Run \`${CHECKOUT_SYNC_COMMAND}\` in the project repo to bring it back in line. The \`stash -u\` preserves any uncommitted work of your own there.`;
}

/**
 * Every RETIRED wording of `formatCheckoutSyncNotice`, oldest first — the notice text is a versioned
 * schema element, not free-form prose (an artifact's approval baseline can only ever have been written
 * under whichever wording was current the day it was approved). `stripCheckoutSyncNotice` (validate.ts)
 * tries the CURRENT wording first, then every entry here, so an artifact approved years ago under a
 * since-retired wording still validates clean. Append-only: never edit an entry in place once an
 * artifact could have been approved under it — that would reintroduce the exact 2026-08-23 outage this
 * array exists to prevent, just one layer down. Each entry must reproduce its wording byte-for-byte, as
 * `formatCheckoutSyncNotice` returned it during its own lifetime.
 */
export const FORMER_CHECKOUT_SYNC_NOTICES: Array<(defaultBranch: string) => string> = [
  // 2026-08-20 (PR #22/#23, introduced) – 2026-08-22 (PR #26, retired): named only the deletion shape
  // ("will show every file it introduced staged for deletion until synced"), not the modified-file /
  // staged-reversion shape #26 added once that second shape was observed live against `jot`.
  (defaultBranch) =>
    `**Checkout out of sync:** \`${defaultBranch}\` was checked out in the project repo's own working tree when this merge landed. This merge never touches that working tree by design (M4) — \`git status\` there will show every file it introduced staged for deletion until synced. Run \`${CHECKOUT_SYNC_COMMAND}\` in the project repo to bring it back in line. The \`stash -u\` preserves any uncommitted work of your own there.`,
];

// ---------------------------------------------------------------------------
// The merge gate artifact itself — levare's own synthetic content (never a member's), same posture
// dagwalk.ts#writeBlocked/blockedRetryDoc already take for their own levare-authored records.
// ---------------------------------------------------------------------------

function q(s: string): string {
  return /^[A-Za-z0-9._/-]+$/.test(s) ? s : JSON.stringify(s);
}

// Phase 3 (2026-08-20 ruling): `# merge — clean`/`CONFLICTED`/`ERROR` names the trial merge's own git
// MECHANICS only — exactly what `trial.conflicted`/`trial.error` say happened when the diff was
// attempted — and must stay honest about that regardless of what guardrails found; conflating it with
// the gate's DISPOSITION (would approval succeed right now) is what made the pre-fix artifact read
// "clean" as if that meant "approved" next to a non-empty `guardrail_violations`. This body sentence is
// the disposition half: it names blocking findings (`protected-path`, `never` — unaffected by the
// actor-aware ruling, still fail approval) separately from a `protected-branch` note, which the SAME
// approval that would be clicked next is what resolves it, not a separate fix.
function mechanicsCleanDisposition(trial: TrialMergeResult, violations: GuardrailViolation[]): string {
  const base = `${trial.commitsAhead} commit(s) on \`${trial.branch}\` ahead of \`${trial.target}\`, merges cleanly.`;
  const blocking = violations.filter((v) => v.rule !== "protected-branch");
  const gateExempt = violations.filter((v) => v.rule === "protected-branch");
  if (blocking.length > 0) return `${base} Blocked by guardrail: ${blocking.map((v) => v.detail).join("; ")}.`;
  if (gateExempt.length > 0) return `${base} ${gateExempt.map((v) => v.detail).join("; ")} — approving this gate is the authorization to land here.`;
  return base;
}

/** Build the initial `kind: merge` artifact a merge gate opens with — always `status: in-review`,
 * `approved_by: null` (board/gateops.ts's `doApproveMerge`/`doRecheckMerge` own everything that
 * happens to this artifact after it exists, via the same patchFrontmatter/upsertFrontmatterMap
 * primitives every other gate resolution in this app already uses — this function is only ever called
 * once, at gate-open time). `violations` is the structured guardrail result (never carries
 * `approvedGate` — gate-open is never itself an approval), so this can tell a real blocker from a
 * `protected-branch` note the next approval resolves; the on-disk `guardrail_violations` field still
 * records every finding, flattened, for the full advisory record types.ts documents. */
export function formatMergeArtifact(unit: string, project: string, id: string, created: string, trial: TrialMergeResult, violations: GuardrailViolation[]): string {
  const guardrailViolations = violations.map(violationLine);
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
    ...(trial.branchSha ? [`  branch_sha: ${q(trial.branchSha)}`] : []),
    "---",
    "",
    `# merge — ${trial.error ? "ERROR" : trial.conflicted ? "CONFLICTED" : "clean"}`,
    "",
    trial.error
      ? `The trial merge could not run: ${trial.error}`
      : trial.conflicted
        ? `${trial.commitsAhead} commit(s) on \`${trial.branch}\` ahead of \`${trial.target}\`. The trial merge conflicts on: ${trial.conflicts.join(", ")}. Resolve by hand on \`${trial.branch}\` in the project repo, then use the recheck verb.`
        : mechanicsCleanDisposition(trial, violations),
    "",
  ];
  return lines.join("\n");
}

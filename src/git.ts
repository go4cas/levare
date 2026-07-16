// Shared Conductor git identity + commit helper (PRD §4, §9, ruling E6). Every write path that
// commits on the Conductor's behalf — board gate resolution, the registry edit route, and the
// Orchestrator's own writes (§7) — funnels through this one function, so "commit as the Conductor"
// means exactly one thing everywhere it happens. Always passes explicit non-interactive-safe
// overrides: a Conductor action must never hang on a host signing prompt or a stray commit hook.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export const CONDUCTOR_NAME = "cas";
export const CONDUCTOR_EMAIL = "cas@levare.local";

// Phase 8: the daemon commits artifacts it produces autonomously, between gates, with no Conductor
// click in that specific commit's causal chain (the click that satisfied invariant 1 happened
// earlier — approving the gate that unblocked this kind). Attributing those commits to "cas" would
// misrepresent `git log` as a record of human decisions; a distinct identity keeps the audit log
// (invariant 2) honest about who/what made each commit, mirroring how `makeFoundingCommit` (below)
// already deliberately avoids reusing CONDUCTOR_NAME for a commit the Conductor didn't make.
export const RUNNER_NAME = "levare-runner";
export const RUNNER_EMAIL = "runner@levare.local";

function commitAs(root: string, files: string[], message: string, identity: { name: string; email: string }): string {
  const gitArgs = (args: string[]) => [
    "-C",
    root,
    "-c",
    `user.name=${identity.name}`,
    "-c",
    `user.email=${identity.email}`,
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

export function conductorCommit(root: string, files: string[], message: string): string {
  return commitAs(root, files, message, { name: CONDUCTOR_NAME, email: CONDUCTOR_EMAIL });
}

/** The daemon's own commit identity (phase 8) — see RUNNER_NAME's own doc comment above. */
export function runnerCommit(root: string, files: string[], message: string): string {
  return commitAs(root, files, message, { name: RUNNER_NAME, email: RUNNER_EMAIL });
}

// ---------------------------------------------------------------------------
// Transactional writes ("files are the truth + git is the audit log" — a write with no matching
// commit is an unaudited mutation, and must never be left on disk).
// ---------------------------------------------------------------------------

export interface TxFile {
  path: string;
  /** Candidate content, or null meaning this path must NOT exist in the candidate state (e.g.
   * orchestrator.ts#promoteIdea's idea file, deleted as part of materializing it into a unit) —
   * deleted if currently present. */
  content: string | null;
}

export type TxResult = { ok: true; commit: string } | { ok: false; stage: "validate" | "commit"; error: string };

/**
 * Write every file in `files` to its candidate content (or delete it, for a `null` candidate), run
 * `validate` (if given), then commit — and on ANY failure (validation, `git add`, or `git commit`),
 * restore every touched file to exactly what was on disk before this call (deleting any that didn't
 * exist), so a rejected mutation never lingers as an unaudited change to the working tree. `validate`
 * runs AFTER the candidate content is written (not before) because some validators (board/serve.ts's
 * registry route) re-derive the whole repo from disk and need the candidate state to already be
 * there to see it.
 *
 * `git add` may have already staged the candidate content into the index before `git commit` itself
 * fails (e.g. a rejected commit hook, or a corrupt index) — left alone, that stale staged content
 * could ride along into a LATER, unrelated commit that happens to touch the same paths again. The
 * rollback resets the index for these paths too, not just the working tree, so a failed transaction
 * never has an afterlife via the index.
 */
export function transactionalWrite(root: string, files: TxFile[], message: string, commit: (root: string, files: string[], message: string) => string, validate?: () => string | null): TxResult {
  const originals = files.map((f) => ({ path: f.path, content: existsSync(f.path) ? readFileSync(f.path, "utf8") : null }));
  const apply = (state: Array<{ path: string; content: string | null }>) => {
    for (const s of state) {
      if (s.content === null) {
        if (existsSync(s.path)) unlinkSync(s.path);
      } else {
        writeFileSync(s.path, s.content);
      }
    }
  };
  const restore = () => {
    apply(originals);
    spawnSync("git", ["-C", root, "reset", "--", ...files.map((f) => f.path)], { encoding: "utf8" });
  };

  apply(files);

  if (validate) {
    const error = validate();
    if (error) {
      restore();
      return { ok: false, stage: "validate", error };
    }
  }

  try {
    const sha = commit(root, files.map((f) => f.path), message);
    return { ok: true, commit: sha };
  } catch (e) {
    restore();
    return { ok: false, stage: "commit", error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// `levare init`'s founding commit (phase-6 gate fix-up).
// ---------------------------------------------------------------------------
//
// Without git, `validate.ts`'s approved-artifact immutability check silently fail-opens (state S0:
// "not a git repo → cannot verify → treated as valid") and every commit-as-Conductor write path
// (gates, registry edits, the Orchestrator) is inert — a freshly-scaffolded studio must not ship with
// those guarantees off by default. This commit predates any Conductor action (there is no running
// studio yet, no gate has ever been decided), so it is attributed to the *user's own* resolved git
// identity — `git config user.name`/`user.email` — never the fictional `CONDUCTOR_NAME` above, which
// is this dev repo's own fixture convention (NOTES E6), not a stand-in for every levare user.

export interface FoundingCommitResult {
  gitAvailable: boolean;
  repoInitialized: boolean;
  identity: { name: string; email: string } | null;
  committed: boolean;
  commit: string | null;
}

function resolveGitIdentity(root: string, env: NodeJS.ProcessEnv): { name: string; email: string } | null {
  const get = (key: string) => spawnSync("git", ["-C", root, "config", "--get", key], { encoding: "utf8", env });
  const name = get("user.name");
  const email = get("user.email");
  const n = name.status === 0 ? name.stdout.trim() : "";
  const e = email.status === 0 ? email.stdout.trim() : "";
  if (!n || !e) return null;
  return { name: n, email: e };
}

/**
 * `git init` (idempotent — a no-op if `root` is already a repo) plus, only if a usable git identity
 * resolves, one commit of everything under `root`. If no identity resolves, the repo still exists
 * (so a later `git config` + manual commit works) but nothing is committed — the caller must surface
 * that prominently rather than let a disabled guarantee pass silently (see `runInitCmd`, cli.ts).
 * `env` is injectable so tests can point `GIT_CONFIG_GLOBAL`/`HOME` at an isolated identity (or none)
 * without depending on whatever git identity happens to be configured on the host running the suite.
 */
export function makeFoundingCommit(root: string, message: string, env: NodeJS.ProcessEnv = process.env): FoundingCommitResult {
  if (!Bun.which("git")) return { gitAvailable: false, repoInitialized: false, identity: null, committed: false, commit: null };

  let repoInitialized = existsSync(join(root, ".git"));
  if (!repoInitialized) {
    const init = spawnSync("git", ["-C", root, "-c", "init.defaultBranch=main", "init", "-q"], { encoding: "utf8", env });
    repoInitialized = init.status === 0;
    if (!repoInitialized) return { gitAvailable: true, repoInitialized: false, identity: null, committed: false, commit: null };
  }

  const identity = resolveGitIdentity(root, env);
  if (!identity) return { gitAvailable: true, repoInitialized: true, identity: null, committed: false, commit: null };

  const gitArgs = (args: string[]) => [
    "-C",
    root,
    "-c",
    `user.name=${identity.name}`,
    "-c",
    `user.email=${identity.email}`,
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=/dev/null",
    ...args,
  ];
  const add = spawnSync("git", gitArgs(["add", "-A"]), { encoding: "utf8", env });
  if (add.status !== 0) return { gitAvailable: true, repoInitialized: true, identity, committed: false, commit: null };

  // Nothing staged (e.g. `init` re-run against an already-committed studio with no new files) is not
  // an error — there's simply no founding commit left to make.
  const staged = spawnSync("git", gitArgs(["diff", "--cached", "--quiet"]), { encoding: "utf8", env });
  if (staged.status === 0) return { gitAvailable: true, repoInitialized: true, identity, committed: false, commit: null };

  const commit = spawnSync("git", gitArgs(["commit", "-q", "-m", message]), { encoding: "utf8", env });
  if (commit.status !== 0) return { gitAvailable: true, repoInitialized: true, identity, committed: false, commit: null };
  const rev = spawnSync("git", gitArgs(["rev-parse", "HEAD"]), { encoding: "utf8", env });
  return { gitAvailable: true, repoInitialized: true, identity, committed: true, commit: rev.stdout.trim() };
}

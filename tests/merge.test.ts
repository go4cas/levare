// NOTES MERGE-1 (PRD Amendment 2, M1-M5). Tests the merge machinery in src/merge.ts directly against
// real, local git repos this file creates itself — never the studio's own repo, never a fixture with a
// bogus/non-local `repo:` (fixtures/golden's `storefront` deliberately stays that way — see
// resolveProjectRepoPath's own doc and this file's "resolveProjectRepoPath" describe block).

import { test, expect, describe } from "bun:test";
import { spawnSync } from "node:child_process";
import { assertSpawnOk, spawnStdout } from "./spawn-helpers.ts";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  workBranchName,
  resolveProjectRepoPath,
  branchExists,
  projectLog,
  createWorkBranch,
  trialMerge,
  executeMerge,
  mergeDiffEntries,
  checkGuardrailsForMerge,
  formatMergeArtifact,
  createDispatchWorktree,
  commitDispatchWorktree,
  checkoutBehindMerge,
  formatCheckoutSyncNotice,
  CHECKOUT_SYNC_COMMAND,
} from "../src/merge.ts";
import { parseArtifactDoc } from "../src/repo.ts";
import { validateArtifactSource } from "../src/validate.ts";
import type { Team } from "../src/types.ts";

const HERMETIC_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" };

// A generic dispatch identity for tests that exercise createDispatchWorktree's own mechanics (worktree
// creation/cleanup/isolation) rather than identity attribution specifically.
const MEMBER_IDENTITY = { name: "member", email: "member@levare.local" };

function git(repoRoot: string, args: string[]): string {
  const r = spawnSync("git", ["-C", repoRoot, "-c", "user.name=seed", "-c", "user.email=seed@levare.test", "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf8",
    env: HERMETIC_ENV,
  });
  assertSpawnOk(`git ${args.join(" ")}`, r);
  return r.stdout;
}

function rev(repoRoot: string, ref: string): string {
  return git(repoRoot, ["rev-parse", ref]).trim();
}

/** A real, local project repo — `default_branch` = "main" — with one committed file. */
function makeProjectRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "levare-merge-proj-"));
  git(dir, ["-c", "init.defaultBranch=main", "init", "-q"]);
  writeFileSync(join(dir, "README.md"), "hello\n");
  writeFileSync(join(dir, "src.txt"), "line one\nline two\nline three\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "initial"]);
  return dir;
}

/** Plant a work branch with `n` commits ahead of `main`, each touching `file` (default: a fresh file
 * per commit, so no conflict with main unless `touchExisting` is set). */
function plantWorkBranch(repo: string, branch: string, opts: { touchExisting?: boolean } = {}): void {
  git(repo, ["branch", branch, "main"]);
  git(repo, ["checkout", "-q", branch]);
  if (opts.touchExisting) {
    writeFileSync(join(repo, "src.txt"), "line one\nCHANGED BY BRANCH\nline three\n");
  } else {
    writeFileSync(join(repo, "feature.txt"), "new feature content\n");
  }
  git(repo, ["-c", "user.name=member", "-c", "user.email=member@levare.test", "add", "-A"]);
  git(repo, ["-c", "user.name=member", "-c", "user.email=member@levare.test", "commit", "-q", "-m", "member work"]);
  git(repo, ["checkout", "-q", "main"]);
}

function rmrf(p: string): void {
  rmSync(p, { recursive: true, force: true });
}

describe("workBranchName", () => {
  test("levare/<unit>", () => {
    expect(workBranchName("checkout-flow")).toBe("levare/checkout-flow");
  });
});

describe("resolveProjectRepoPath", () => {
  test("undefined for an empty repo field", () => {
    expect(resolveProjectRepoPath(mkdtempSync(join(tmpdir(), "levare-merge-studio-")), { repo: "" })).toBeUndefined();
  });

  test("undefined for a path that isn't a local git checkout (e.g. an unfetched SSH URL)", () => {
    const studio = mkdtempSync(join(tmpdir(), "levare-merge-studio-"));
    try {
      expect(resolveProjectRepoPath(studio, { repo: "git@github.com:acme/storefront.git" })).toBeUndefined();
    } finally {
      rmrf(studio);
    }
  });

  test("undefined for the studio's own root (repo: .) — never touched by the merge machinery", () => {
    const studio = mkdtempSync(join(tmpdir(), "levare-merge-studio-"));
    git(studio, ["-c", "init.defaultBranch=main", "init", "-q"]);
    try {
      expect(resolveProjectRepoPath(studio, { repo: "." })).toBeUndefined();
    } finally {
      rmrf(studio);
    }
  });

  test("resolves an absolute path to a real local git checkout", () => {
    const studio = mkdtempSync(join(tmpdir(), "levare-merge-studio-"));
    const repo = makeProjectRepo();
    try {
      expect(resolveProjectRepoPath(studio, { repo })).toBe(repo);
    } finally {
      rmrf(repo);
      rmrf(studio);
    }
  });

  test("resolves a path relative to the studio root", () => {
    const studio = mkdtempSync(join(tmpdir(), "levare-merge-studio-"));
    try {
      const projDir = join(studio, "checkouts", "storefront");
      mkdirSync(projDir, { recursive: true });
      git(projDir, ["-c", "init.defaultBranch=main", "init", "-q"]);
      expect(resolveProjectRepoPath(studio, { repo: "checkouts/storefront" })).toBe(projDir);
    } finally {
      rmrf(studio);
    }
  });

  // Finding 77: `~` is not `isAbsolute` — left unexpanded it silently mis-resolves to
  // `<studioRoot>/~/...`, so a `repo: ~/code/foo` that LOOKS correct returns undefined exactly like an
  // undeclared repo would. `home` is injected (resolveProjectRepoPath's own optional third param) so
  // this is deterministic regardless of what this host's real $HOME contains.
  test("expands a `~/` repo path against an injected home", () => {
    const studio = mkdtempSync(join(tmpdir(), "levare-merge-studio-"));
    const home = mkdtempSync(join(tmpdir(), "levare-merge-home-"));
    const repo = join(home, "code", "foo");
    try {
      mkdirSync(repo, { recursive: true });
      git(repo, ["-c", "init.defaultBranch=main", "init", "-q"]);
      expect(resolveProjectRepoPath(studio, { repo: "~/code/foo" }, home)).toBe(repo);
    } finally {
      rmrf(home);
      rmrf(studio);
    }
  });

  test("expands a bare `~` repo path against an injected home", () => {
    const studio = mkdtempSync(join(tmpdir(), "levare-merge-studio-"));
    const home = mkdtempSync(join(tmpdir(), "levare-merge-home-"));
    try {
      git(home, ["-c", "init.defaultBranch=main", "init", "-q"]);
      expect(resolveProjectRepoPath(studio, { repo: "~" }, home)).toBe(home);
    } finally {
      rmrf(home);
      rmrf(studio);
    }
  });

  test("does not expand `~user` (no passwd lookup)", () => {
    const studio = mkdtempSync(join(tmpdir(), "levare-merge-studio-"));
    const home = mkdtempSync(join(tmpdir(), "levare-merge-home-"));
    try {
      expect(resolveProjectRepoPath(studio, { repo: "~someuser/code/foo" }, home)).toBeUndefined();
    } finally {
      rmrf(home);
      rmrf(studio);
    }
  });
});

// Goal "the timeline reads the project repo" (Findings 86/89): the range idiom `trialMerge`'s own
// `commitsAhead` already uses, replayed as full commit rows for timeline.ts's second source.
describe("projectLog", () => {
  test("returns every commit on branch that default_branch doesn't have, oldest first", () => {
    const repo = makeProjectRepo();
    try {
      plantWorkBranch(repo, "levare/unit-a");
      const entries = projectLog(repo, "levare/unit-a", "main");
      expect(entries).toHaveLength(1);
      expect(entries?.[0]?.subject).toBe("member work");
      expect(entries?.[0]?.author).toBe("member");
    } finally {
      rmrf(repo);
    }
  });

  test("an empty range (branch has no commits main lacks) reads as [], not undefined — a real read, not a failure", () => {
    const repo = makeProjectRepo();
    try {
      git(repo, ["branch", "levare/unit-a", "main"]);
      expect(projectLog(repo, "levare/unit-a", "main")).toEqual([]);
    } finally {
      rmrf(repo);
    }
  });

  test("undefined when default_branch itself doesn't resolve — a git failure, distinct from an empty range", () => {
    const repo = makeProjectRepo();
    try {
      plantWorkBranch(repo, "levare/unit-a");
      expect(projectLog(repo, "levare/unit-a", "does-not-exist")).toBeUndefined();
    } finally {
      rmrf(repo);
    }
  });
});

describe("createWorkBranch (M1)", () => {
  test("creates the branch from default_branch's tip", () => {
    const repo = makeProjectRepo();
    try {
      const tip = rev(repo, "main");
      const r = createWorkBranch(repo, "levare/unit-a", "main");
      expect(r).toEqual({ ok: true, created: true });
      expect(branchExists(repo, "levare/unit-a")).toBe(true);
      expect(rev(repo, "levare/unit-a")).toBe(tip);
    } finally {
      rmrf(repo);
    }
  });

  test("idempotent — a second call reports created: false and does not move the branch", () => {
    const repo = makeProjectRepo();
    try {
      createWorkBranch(repo, "levare/unit-a", "main");
      const firstTip = rev(repo, "levare/unit-a");
      // Advance main so a re-creation-from-tip would visibly differ if it happened.
      writeFileSync(join(repo, "later.txt"), "later\n");
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-q", "-m", "later commit"]);
      const r = createWorkBranch(repo, "levare/unit-a", "main");
      expect(r).toEqual({ ok: true, created: false });
      expect(rev(repo, "levare/unit-a")).toBe(firstTip);
    } finally {
      rmrf(repo);
    }
  });

  test("never checks out anything — the working tree stays on whatever branch it was on", () => {
    const repo = makeProjectRepo();
    try {
      git(repo, ["checkout", "-q", "-b", "someone-else-was-here"]);
      createWorkBranch(repo, "levare/unit-a", "main");
      expect(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("someone-else-was-here");
    } finally {
      rmrf(repo);
    }
  });

  test("fails loudly when default_branch does not resolve", () => {
    const repo = makeProjectRepo();
    try {
      const r = createWorkBranch(repo, "levare/unit-a", "does-not-exist");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("does-not-exist");
    } finally {
      rmrf(repo);
    }
  });
});

describe("trialMerge (M2) — scratch worktree only, never touches real branch state", () => {
  test("reports CLEAN with commit count and diffstat when the branch merges cleanly", () => {
    const repo = makeProjectRepo();
    try {
      plantWorkBranch(repo, "levare/unit-a");
      const mainBefore = rev(repo, "main");
      const branchBefore = rev(repo, "levare/unit-a");

      const result = trialMerge(repo, "levare/unit-a", "main");

      expect(result.conflicted).toBe(false);
      expect(result.conflicts).toEqual([]);
      expect(result.commitsAhead).toBe(1);
      expect(result.diffFiles).toEqual(["feature.txt"]);
      expect(result.diffstat).toContain("feature.txt");
      expect(result.error).toBeUndefined();

      // Never touches real branch state.
      expect(rev(repo, "main")).toBe(mainBefore);
      expect(rev(repo, "levare/unit-a")).toBe(branchBefore);
      // No leftover worktrees or scratch directories.
      const wt = git(repo, ["worktree", "list", "--porcelain"]);
      expect(wt.trim().split("\n\n").filter(Boolean).length).toBe(1);
    } finally {
      rmrf(repo);
    }
  });

  test("reports CONFLICTED and names the conflicting files — real branch state still untouched", () => {
    const repo = makeProjectRepo();
    try {
      plantWorkBranch(repo, "levare/unit-b", { touchExisting: true });
      // Also change the same file on main after the branch diverged, guaranteeing a real conflict.
      writeFileSync(join(repo, "src.txt"), "line one\nCHANGED BY MAIN\nline three\n");
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-q", "-m", "main also changed src.txt"]);
      const mainBefore = rev(repo, "main");
      const branchBefore = rev(repo, "levare/unit-b");

      const result = trialMerge(repo, "levare/unit-b", "main");

      expect(result.conflicted).toBe(true);
      expect(result.conflicts).toEqual(["src.txt"]);
      expect(result.error).toBeUndefined();

      expect(rev(repo, "main")).toBe(mainBefore);
      expect(rev(repo, "levare/unit-b")).toBe(branchBefore);
      // The real working tree/index of the main repo checkout is unaffected — no merge in progress.
      const status = git(repo, ["status", "--porcelain"]);
      expect(status.trim()).toBe("");
      expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(false);
      const wt = git(repo, ["worktree", "list", "--porcelain"]);
      expect(wt.trim().split("\n\n").filter(Boolean).length).toBe(1);
    } finally {
      rmrf(repo);
    }
  });

  test("a missing work branch is reported as an error, not a crash", () => {
    const repo = makeProjectRepo();
    try {
      const result = trialMerge(repo, "levare/ghost", "main");
      expect(result.error).toContain("levare/ghost");
      expect(result.conflicted).toBe(false);
    } finally {
      rmrf(repo);
    }
  });
});

describe("executeMerge (M4/M5)", () => {
  test("clean merge produces a real merge commit preserving member history, never squash/rebase", () => {
    const repo = makeProjectRepo();
    try {
      plantWorkBranch(repo, "levare/unit-a");
      const memberSha = rev(repo, "levare/unit-a");
      const preSha = rev(repo, "main");

      const result = executeMerge(repo, "levare/unit-a", "main", "merge levare/unit-a -> main: unit unit-a (gate merge-unit-a-v1)", null);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.pushed).toBeNull();

      // default_branch fast-forwarded to the merge commit.
      expect(rev(repo, "main")).toBe(result.mergeCommit);
      // A real merge commit: two parents, one of which is the member's own commit (history preserved,
      // not squashed) and the message names unit/gate.
      const parents = git(repo, ["log", "-1", "--pretty=%P", result.mergeCommit]).trim().split(" ");
      expect(parents).toContain(memberSha);
      expect(parents).toContain(preSha);
      expect(git(repo, ["log", "-1", "--pretty=%an <%ae>", result.mergeCommit]).trim()).toBe("levare-runner <runner@levare.local>");
      expect(git(repo, ["log", "-1", "--pretty=%s", result.mergeCommit]).trim()).toContain("unit-a");
      // The member's own commit is still reachable and still authored by "member" — never rewritten.
      expect(git(repo, ["log", "--pretty=%an", result.mergeCommit]).trim().split("\n")).toContain("member");
      // The working tree of the main repo checkout was never touched by execution: `main`'s REF now
      // points past the merge, but the checked-out files on disk still reflect the pre-merge commit —
      // update-ref moves the ref, never the working tree/index (M4's own "never a checkout" guarantee).
      expect(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("main");
      expect(existsSync(join(repo, "feature.txt"))).toBe(false);
      // 2026-08-20 checkout-sync ruling: this fixture's primary checkout has `main` (the target)
      // checked out — `plantWorkBranch` always returns to it — which is exactly the one case where
      // "never touched" above is NOT "unaffected": `main`'s ref now points past a commit the index
      // still doesn't know about, so `git status` reads the merge's own new file as staged for
      // DELETION, and `git diff --cached` shows the merge as a pure deletion. Previously this test
      // stopped at "file absent on disk" as if that alone proved safety — asserted here explicitly so
      // this known, deliberate consequence of M4's guarantee can never regress back into silence.
      expect(git(repo, ["status", "--porcelain"]).trim()).toBe("D  feature.txt");
      expect(git(repo, ["diff", "--cached", "--stat"]).trim()).toContain("1 file changed, 1 deletion(-)");
      expect(checkoutBehindMerge(repo, "main")).toBe(true);
    } finally {
      rmrf(repo);
    }
  });

  test("pushes to remote in the same transaction when the project declares one", () => {
    const repo = makeProjectRepo();
    const remote = mkdtempSync(join(tmpdir(), "levare-merge-remote-"));
    try {
      git(remote, ["-c", "init.defaultBranch=main", "init", "-q", "--bare"]);
      git(repo, ["push", remote, "main:main"]);
      plantWorkBranch(repo, "levare/unit-a");

      const result = executeMerge(repo, "levare/unit-a", "main", "merge", remote);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.pushed).toBe(true);

      const remoteHead = spawnStdout("git rev-parse refs/heads/main (remote)", spawnSync("git", ["-C", remote, "rev-parse", "refs/heads/main"], { encoding: "utf8" })).trim();
      expect(remoteHead).toBe(result.mergeCommit);
    } finally {
      rmrf(repo);
      rmrf(remote);
    }
  });

  test("push failure rolls back the local merge byte-perfectly and blocks with the reason named", () => {
    const repo = makeProjectRepo();
    try {
      plantWorkBranch(repo, "levare/unit-a");
      const preSha = rev(repo, "main");
      const badRemote = join(repo, "..", "levare-merge-does-not-exist-" + Math.random().toString(36).slice(2));

      const result = executeMerge(repo, "levare/unit-a", "main", "merge", badRemote);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.stage).toBe("push");
      expect(result.error.length).toBeGreaterThan(0);

      // Byte-perfect rollback: main is back exactly where it started.
      expect(rev(repo, "main")).toBe(preSha);
      // No dangling merge state left on the real working tree.
      expect(git(repo, ["status", "--porcelain"]).trim()).toBe("");
    } finally {
      rmrf(repo);
    }
  });

  test("fails loudly (never silently) when the work branch does not exist", () => {
    const repo = makeProjectRepo();
    try {
      const result = executeMerge(repo, "levare/ghost", "main", "merge", null);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain("levare/ghost");
    } finally {
      rmrf(repo);
    }
  });
});

// 2026-08-20 checkout-sync ruling: `executeMerge`'s never-checkout guarantee (M4) is deliberate and
// stays exactly as-is — this only detects the one case it leaves behind, so `doApproveMerge` can
// report it instead of staying silent (the live `jot` incident this ruling responds to).
describe("checkoutBehindMerge (checkout-sync ruling)", () => {
  test("true when the primary checkout has default_branch checked out — the exact case M4 leaves stale", () => {
    const repo = makeProjectRepo();
    try {
      expect(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("main");
      expect(checkoutBehindMerge(repo, "main")).toBe(true);
    } finally {
      rmrf(repo);
    }
  });

  test("false when the primary checkout has a different branch checked out", () => {
    const repo = makeProjectRepo();
    try {
      git(repo, ["checkout", "-q", "-b", "other-branch"]);
      expect(checkoutBehindMerge(repo, "main")).toBe(false);
    } finally {
      rmrf(repo);
    }
  });

  test("false when the primary checkout is detached", () => {
    const repo = makeProjectRepo();
    try {
      git(repo, ["checkout", "-q", "--detach", "main"]);
      expect(checkoutBehindMerge(repo, "main")).toBe(false);
    } finally {
      rmrf(repo);
    }
  });
});

// Enforces the two-step formatCheckoutSyncNotice's own doc comment asks for, rather than leaving it to
// memory (the 2026-08-23 ~/source/jot-studio outage was exactly a step someone had no way to be
// reminded of). Pinned byte-for-byte on purpose: the day this wording changes again, THIS is the test
// that fails, and its failure IS the prompt — copy the old body into a new dated entry at the end of
// FORMER_CHECKOUT_SYNC_NOTICES (validate.ts#stripCheckoutSyncNotice tries every entry there), then
// update this pin to match the new wording. A test that never fails on an intentional edit would be
// useless here; one that fails elsewhere for the same edit (a snapshot buried in an unrelated describe
// block) would be missed. This is deliberately the one place that catches it, named for what it's for.
test("formatCheckoutSyncNotice's wording is pinned — changing it is a two-step, and this failing is step one's reminder", () => {
  expect(formatCheckoutSyncNotice("main")).toBe(
    `**Checkout out of sync:** \`main\` was checked out in the project repo's own working tree when this merge landed. This merge never touches that working tree by design (M4) — \`git status\` there will not match the merge until synced: files it introduced show staged for deletion, files it modified show staged as reversions to their pre-merge content. Run \`${CHECKOUT_SYNC_COMMAND}\` in the project repo to bring it back in line. The \`stash -u\` preserves any uncommitted work of your own there.`,
  );
});

describe("createDispatchWorktree (NOTES R4-SANDBOX, Ruling 1)", () => {
  test("checks out the branch (never detached) in a fresh scratch worktree, distinct from the project's own working tree", () => {
    const repo = makeProjectRepo();
    try {
      git(repo, ["branch", "levare/unit-a", "main"]);
      const mainHead = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
      const created = createDispatchWorktree(repo, "levare/unit-a", MEMBER_IDENTITY);
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(created.worktree.path).not.toBe(repo);
      expect(git(created.worktree.path, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("levare/unit-a");
      // The project's own working tree is completely untouched by the dispatch worktree's checkout.
      expect(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe(mainHead);
      created.worktree.cleanup();
      expect(existsSync(created.worktree.path)).toBe(false);
      const wt = git(repo, ["worktree", "list", "--porcelain"]);
      expect(wt.trim().split("\n\n").filter(Boolean).length).toBe(1);
    } finally {
      rmrf(repo);
    }
  });

  test("a member's commit inside the worktree actually advances the work branch", () => {
    const repo = makeProjectRepo();
    try {
      git(repo, ["branch", "levare/unit-a", "main"]);
      const beforeSha = rev(repo, "levare/unit-a");
      const created = createDispatchWorktree(repo, "levare/unit-a", MEMBER_IDENTITY);
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      try {
        writeFileSync(join(created.worktree.path, "member-work.txt"), "hello\n");
        spawnSync("git", ["-C", created.worktree.path, "-c", "user.name=member", "-c", "user.email=member@levare.test", "add", "-A"], { env: HERMETIC_ENV });
        spawnSync("git", ["-C", created.worktree.path, "-c", "user.name=member", "-c", "user.email=member@levare.test", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "member commit"], {
          env: HERMETIC_ENV,
        });
      } finally {
        created.worktree.cleanup();
      }
      expect(rev(repo, "levare/unit-a")).not.toBe(beforeSha);
      expect(existsSync(join(repo, "member-work.txt"))).toBe(false); // the project's own working tree never saw it
    } finally {
      rmrf(repo);
    }
  });

  // Unit "member authorship survives a self-commit" (live evidence, 2026-08-21): a member's own bare
  // `git commit` — no `-c user.name=`/`-c user.email=` at all — is exactly what a native member's Bash
  // tool, or an unsandboxed/"none"-tier `cli` member's own vendor process, actually runs. Reproduces the
  // ambient resolution that failed live: a real (non-hermetic) `GIT_CONFIG_GLOBAL` and a `$HOME` carrying
  // a DIFFERENT, conflicting identity (standing in for the operator's own real `~/.gitconfig`) — before
  // this unit's fix, git would have resolved that global identity, not the member's. Proves
  // `createDispatchWorktree`'s own `extensions.worktreeConfig`/`--worktree` write wins regardless.
  test("a member's own commit with NO -c flags resolves the worktree's own identity, never a conflicting global $HOME config", () => {
    const repo = makeProjectRepo();
    const fakeHome = mkdtempSync(join(tmpdir(), "levare-fakehome-"));
    try {
      writeFileSync(join(fakeHome, ".gitconfig"), "[user]\n\tname = go4cas\n\temail = go4cas@gmail.com\n");
      git(repo, ["branch", "levare/unit-a", "main"]);
      const created = createDispatchWorktree(repo, "levare/unit-a", MEMBER_IDENTITY);
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      try {
        writeFileSync(join(created.worktree.path, "member-output.txt"), "written ambiently\n");
        const ambientEnv: NodeJS.ProcessEnv = { ...process.env, HOME: fakeHome, GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
        delete ambientEnv.GIT_CONFIG_GLOBAL;
        delete ambientEnv.GIT_AUTHOR_NAME;
        delete ambientEnv.GIT_AUTHOR_EMAIL;
        delete ambientEnv.GIT_COMMITTER_NAME;
        delete ambientEnv.GIT_COMMITTER_EMAIL;
        const add = spawnSync("git", ["-C", created.worktree.path, "add", "-A"], { env: ambientEnv, encoding: "utf8" });
        assertSpawnOk("git add (ambient, no -c flags)", add);
        const commit = spawnSync("git", ["-C", created.worktree.path, "commit", "-q", "-m", "ambient member commit"], { env: ambientEnv, encoding: "utf8" });
        assertSpawnOk("git commit (ambient, no -c flags)", commit);
      } finally {
        created.worktree.cleanup();
      }
      const author = git(repo, ["log", "-1", "--format=%an <%ae>", "levare/unit-a"]).trim();
      expect(author).toBe(`${MEMBER_IDENTITY.name} <${MEMBER_IDENTITY.email}>`);
    } finally {
      rmrf(repo);
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  test("two units on the same project get two independent worktrees of two different branches at once", () => {
    const repo = makeProjectRepo();
    try {
      git(repo, ["branch", "levare/unit-a", "main"]);
      git(repo, ["branch", "levare/unit-b", "main"]);
      const a = createDispatchWorktree(repo, "levare/unit-a", MEMBER_IDENTITY);
      const b = createDispatchWorktree(repo, "levare/unit-b", MEMBER_IDENTITY);
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
      if (!a.ok || !b.ok) return;
      expect(a.worktree.path).not.toBe(b.worktree.path);
      expect(git(a.worktree.path, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("levare/unit-a");
      expect(git(b.worktree.path, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("levare/unit-b");
      a.worktree.cleanup();
      b.worktree.cleanup();
      const wt = git(repo, ["worktree", "list", "--porcelain"]);
      expect(wt.trim().split("\n\n").filter(Boolean).length).toBe(1);
    } finally {
      rmrf(repo);
    }
  });

  // Unit "member authorship survives a self-commit": two concurrent dispatches for two DIFFERENT members
  // on the same project repo must never race or leak identity into each other — the reason `--worktree`
  // config (scoped to $GIT_DIR/worktrees/<name>/config.worktree) was chosen over a plain `--local` write,
  // which would land in the SHARED $GIT_DIR/config instead (confirmed live by direct repro against a real
  // git worktree during this unit's own investigation).
  test("two concurrent dispatch worktrees for two different members each resolve their OWN identity, and the primary checkout's own config is never touched", () => {
    const repo = makeProjectRepo();
    try {
      git(repo, ["branch", "levare/unit-a", "main"]);
      git(repo, ["branch", "levare/unit-b", "main"]);
      const identityA = { name: "list-entries-builder", email: "list-entries-builder@levare.local" };
      const identityB = { name: "find-since-builder", email: "find-since-builder@levare.local" };
      const a = createDispatchWorktree(repo, "levare/unit-a", identityA);
      const b = createDispatchWorktree(repo, "levare/unit-b", identityB);
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
      if (!a.ok || !b.ok) return;
      try {
        const emailA = spawnSync("git", ["-C", a.worktree.path, "config", "user.email"], { env: HERMETIC_ENV, encoding: "utf8" });
        const emailB = spawnSync("git", ["-C", b.worktree.path, "config", "user.email"], { env: HERMETIC_ENV, encoding: "utf8" });
        expect(spawnStdout("git config user.email (worktree a)", emailA).trim()).toBe(identityA.email);
        expect(spawnStdout("git config user.email (worktree b)", emailB).trim()).toBe(identityB.email);
      } finally {
        a.worktree.cleanup();
        b.worktree.cleanup();
      }
      // The primary checkout's own config was never given either member's identity — unset, not just
      // "different" (a plain --local write would have left ONE of the two member identities here instead).
      const primaryEmail = spawnSync("git", ["-C", repo, "config", "user.email"], { env: HERMETIC_ENV, encoding: "utf8" });
      expect(primaryEmail.status).not.toBe(0);
    } finally {
      rmrf(repo);
    }
  });

  // Unit "member authorship survives a self-commit" fold-in: a linked worktree shares the primary
  // checkout's real `.git/hooks` directory (git has no per-worktree hooks dir) — a member's own bare
  // commit would otherwise run repo hooks completely unconfined, exactly the "code-execution vector"
  // NOTES R4-SANDBOX-FIX-8 excludes `.git/hooks` from the sandbox's own write grant to guard against.
  // `core.hooksPath=/dev/null` at the worktree-config level closes this for a member's own bare commit
  // too, without touching the primary checkout's real hooks at all.
  test("a member's own bare commit never runs the shared repo's real pre-commit hook", () => {
    const repo = makeProjectRepo();
    try {
      git(repo, ["branch", "levare/unit-a", "main"]);
      mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
      const marker = join(repo, ".git", "hooks-ran.marker");
      writeFileSync(join(repo, ".git", "hooks", "pre-commit"), `#!/bin/sh\ntouch "${marker}"\nexit 1\n`, { mode: 0o755 });
      const created = createDispatchWorktree(repo, "levare/unit-a", MEMBER_IDENTITY);
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      try {
        writeFileSync(join(created.worktree.path, "member-output.txt"), "hello\n");
        const add = spawnSync("git", ["-C", created.worktree.path, "add", "-A"], { env: HERMETIC_ENV, encoding: "utf8" });
        assertSpawnOk("git add", add);
        // No -c flags at all: if the real hook (which exits 1) ran, this commit would fail.
        const commit = spawnSync("git", ["-C", created.worktree.path, "commit", "-q", "-m", "member commit"], { env: HERMETIC_ENV, encoding: "utf8" });
        assertSpawnOk("git commit (hook must be disabled)", commit);
      } finally {
        created.worktree.cleanup();
      }
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmrf(repo);
    }
  });

  test("fails loudly (never silently) when the branch does not exist", () => {
    const repo = makeProjectRepo();
    try {
      const created = createDispatchWorktree(repo, "levare/ghost", MEMBER_IDENTITY);
      expect(created.ok).toBe(false);
      if (created.ok) return;
      expect(created.error).toContain("ghost");
    } finally {
      rmrf(repo);
    }
  });
});

// Goal "commit-on-produce" (Finding 74): the runner-side commit that must fire before a dispatch
// worktree's teardown — this is what closes the gap a native member's own uncommitted file edits fell
// into (nothing ever ran `git add`/`git commit` against the worktree, so `createDispatchWorktree#cleanup`
// force-deleted them along with the scratch directory). Tested directly against `commitDispatchWorktree`
// here (never through the full AdapterRunner) — adapters.test.ts covers the wiring into produce/
// produceAsync/author() instead.
describe("commitDispatchWorktree (goal commit-on-produce, Finding 74)", () => {
  test("commits whatever the member left uncommitted, under the given identity, as one commit on the work branch", () => {
    const repo = makeProjectRepo();
    try {
      git(repo, ["branch", "levare/unit-a", "main"]);
      const beforeSha = rev(repo, "levare/unit-a");
      const identity = { name: "list-entries-builder", email: "list-entries-builder@levare.local" };
      const created = createDispatchWorktree(repo, "levare/unit-a", identity);
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      try {
        writeFileSync(join(created.worktree.path, "jot-list.ts"), "export function list() {}\n");
        const result = commitDispatchWorktree(created.worktree.path, created.worktree.baseSha, "list-entries-builder: code for list-entries", identity);
        expect(result.committed).toBe(true);
        if (!result.committed) return;
        expect(result.commit).toBe(rev(repo, "levare/unit-a"));
      } finally {
        created.worktree.cleanup();
      }
      expect(rev(repo, "levare/unit-a")).not.toBe(beforeSha);
      // Authored as the member, never levare-runner/cas — the code is the member's own work product.
      const author = git(repo, ["log", "-1", "--format=%an <%ae>", "levare/unit-a"]).trim();
      expect(author).toBe("list-entries-builder <list-entries-builder@levare.local>");
      // Never landed in the project's own working tree.
      expect(existsSync(join(repo, "jot-list.ts"))).toBe(false);
    } finally {
      rmrf(repo);
    }
  });

  // Finding 120: `HERMETIC_GIT_ENV` forces GIT_CONFIG_GLOBAL/SYSTEM to `/dev/null` so a stray ambient
  // GIT_AUTHOR_* never misattributes a commit (NOTES CAP-B-FIX) — this must never ALSO mean the
  // operator's own `core.excludesFile` gets silently defeated, letting a file they configured git to
  // never track land in a member's commit. Mutates the real `process.env.HOME` for the duration of the
  // test (restored in `finally`) rather than threading a fake env through `commitDispatchWorktree` — the
  // function takes no env override; this is the same ambient-HOME surface a real operator's shell sets.
  test("a file the operator's global core.excludesFile excludes is never staged, committed, or lost as an empty commit", () => {
    const repo = makeProjectRepo();
    const fakeHome = mkdtempSync(join(tmpdir(), "levare-op-home-"));
    const realHome = process.env.HOME;
    try {
      mkdirSync(join(fakeHome, ".config", "git"), { recursive: true });
      writeFileSync(join(fakeHome, ".config", "git", "ignore"), "*.secret\n");
      process.env.HOME = fakeHome;

      git(repo, ["branch", "levare/unit-a", "main"]);
      const beforeSha = rev(repo, "levare/unit-a");
      const identity = { name: "finch", email: "finch@levare.local" };
      const created = createDispatchWorktree(repo, "levare/unit-a", identity);
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      let result: ReturnType<typeof commitDispatchWorktree>;
      try {
        writeFileSync(join(created.worktree.path, "leaked.secret"), "should never be tracked\n");
        result = commitDispatchWorktree(created.worktree.path, created.worktree.baseSha, "should never land", identity);
      } finally {
        created.worktree.cleanup();
      }
      // No real, trackable change happened — the only file present is one the operator's own global
      // config excludes, so this must read as "clean", never a real commit.
      expect(result).toEqual({ committed: false, reason: "clean" });
      expect(rev(repo, "levare/unit-a")).toBe(beforeSha);
    } finally {
      process.env.HOME = realHome;
      rmSync(fakeHome, { recursive: true, force: true });
      rmrf(repo);
    }
  });

  // The repo's own `.gitignore` (never the operator's global config) must keep working exactly as
  // before — Finding 120's fix passes an explicit `core.excludesFile` through; it must never suppress
  // or interfere with per-repo ignore rules `git` already applies on its own.
  test("the project repo's own .gitignore still excludes a file, independent of any operator global config", () => {
    const repo = makeProjectRepo();
    try {
      writeFileSync(join(repo, ".gitignore"), "*.local\n");
      git(repo, ["add", ".gitignore"]);
      git(repo, ["commit", "-q", "-m", "add gitignore"]);
      git(repo, ["branch", "levare/unit-a", "main"]);
      const beforeSha = rev(repo, "levare/unit-a");
      const identity = { name: "finch", email: "finch@levare.local" };
      const created = createDispatchWorktree(repo, "levare/unit-a", identity);
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      let result: ReturnType<typeof commitDispatchWorktree>;
      try {
        writeFileSync(join(created.worktree.path, "scratch.local"), "should never be tracked\n");
        result = commitDispatchWorktree(created.worktree.path, created.worktree.baseSha, "should never land", identity);
      } finally {
        created.worktree.cleanup();
      }
      expect(result).toEqual({ committed: false, reason: "clean" });
      expect(rev(repo, "levare/unit-a")).toBe(beforeSha);
    } finally {
      rmrf(repo);
    }
  });

  test("a clean worktree (member already self-committed, or genuinely no changes) never creates an empty commit", () => {
    const repo = makeProjectRepo();
    try {
      git(repo, ["branch", "levare/unit-a", "main"]);
      const beforeSha = rev(repo, "levare/unit-a");
      const created = createDispatchWorktree(repo, "levare/unit-a", { name: "finch", email: "finch@levare.local" });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      let result: ReturnType<typeof commitDispatchWorktree>;
      try {
        result = commitDispatchWorktree(created.worktree.path, created.worktree.baseSha, "should never land", { name: "finch", email: "finch@levare.local" });
      } finally {
        created.worktree.cleanup();
      }
      expect(result).toEqual({ committed: false, reason: "clean" });
      expect(rev(repo, "levare/unit-a")).toBe(beforeSha);
    } finally {
      rmrf(repo);
    }
  });

  test("a member's own self-commit is reported as committed too — commitDispatchWorktree compares against baseSha, never just 'did I personally just commit'", () => {
    const repo = makeProjectRepo();
    try {
      git(repo, ["branch", "levare/unit-a", "main"]);
      const created = createDispatchWorktree(repo, "levare/unit-a", { name: "finch", email: "finch@levare.local" });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      let selfCommitSha: string;
      let result: ReturnType<typeof commitDispatchWorktree>;
      try {
        writeFileSync(join(created.worktree.path, "member-output.txt"), "written by the member itself\n");
        // An explicit `-c` override on the member's own command line — accepted, never prevented (a
        // member holds real shell access), but this is exactly what commitDispatchWorktree's own
        // `unexpectedActor` detection below must surface rather than silently trust.
        spawnSync("git", ["-C", created.worktree.path, "-c", "user.name=member", "-c", "user.email=member@levare.test", "add", "-A"], { env: HERMETIC_ENV });
        spawnSync("git", ["-C", created.worktree.path, "-c", "user.name=member", "-c", "user.email=member@levare.test", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "member self-commit"], {
          env: HERMETIC_ENV,
        });
        selfCommitSha = git(created.worktree.path, ["rev-parse", "HEAD"]).trim();
        // The tree is already clean by this point — commitDispatchWorktree adds/commits nothing of its
        // own — but the branch still moved past baseSha, so this must read as "committed", not "clean".
        result = commitDispatchWorktree(created.worktree.path, created.worktree.baseSha, "should never land", { name: "finch", email: "finch@levare.local" });
      } finally {
        created.worktree.cleanup();
      }
      expect(result).toEqual({
        committed: true,
        commit: selfCommitSha,
        unexpectedActor: { authorName: "member", authorEmail: "member@levare.test", committerName: "member", committerEmail: "member@levare.test" },
      });
      // No second, redundant commit was created on top of the member's own.
      expect(rev(repo, "levare/unit-a")).toBe(selfCommitSha);
      const author = git(repo, ["log", "-1", "--format=%an <%ae>", "levare/unit-a"]).trim();
      expect(author).toBe("member <member@levare.test>");
    } finally {
      rmrf(repo);
    }
  });

  test("reports an error (never throws, never silently discards) when the commit itself fails", () => {
    const repo = makeProjectRepo();
    try {
      git(repo, ["branch", "levare/unit-a", "main"]);
      const created = createDispatchWorktree(repo, "levare/unit-a", { name: "finch", email: "finch@levare.local" });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      let result: ReturnType<typeof commitDispatchWorktree>;
      try {
        writeFileSync(join(created.worktree.path, "jot-list.ts"), "export function list() {}\n");
        // Force a hard git-level failure the same way a real host might hit one — a stale index.lock
        // left behind in THIS worktree's own admin dir (each worktree has its own index; the lock lives
        // beside it, never at the shared repo's own `.git/index.lock`), which `git commit` refuses to
        // proceed past.
        writeFileSync(join(created.worktree.gitDir, "index.lock"), "");
        result = commitDispatchWorktree(created.worktree.path, created.worktree.baseSha, "message", { name: "finch", email: "finch@levare.local" });
      } finally {
        rmSync(join(created.worktree.gitDir, "index.lock"), { force: true });
        created.worktree.cleanup();
      }
      expect(result.committed).toBe(false);
      if (result.committed) return;
      expect(result.reason).toBe("error");
    } finally {
      rmrf(repo);
    }
  });
});

describe("checkGuardrailsForMerge / mergeDiffEntries (M3 namespace shape)", () => {
  const team = (guardrails: Team["guardrails"]): Team => ({
    name: "kestrel",
    consumes: [],
    produces: [],
    members: [],
    flow: [],
    style: { color: "#000" },
    charter: "",
    learnings: "",
    guardrails,
  });

  test("a protected path touched by the diff is named as a violation", () => {
    const violations = checkGuardrailsForMerge([team({ protected_paths: ["payments/"] })], ["payments/charge.ts", "readme.md"], "main", false);
    expect(violations.length).toBe(1);
    expect(violations[0].rule).toBe("protected-path");
    expect(violations[0].detail).toContain("payments/charge.ts");
  });

  test("protected_branches matches the merge TARGET, never a file path", () => {
    const violations = checkGuardrailsForMerge([team({ protected_branches: ["main"] })], ["readme.md"], "main", false);
    expect(violations.some((v) => v.rule === "protected-branch")).toBe(true);
  });

  test("the violation names the actual action ('merge', or 'push' only when willPush) rather than a hardcoded 'push'", () => {
    const merged = checkGuardrailsForMerge([team({ protected_branches: ["main"] })], [], "main", false);
    expect(merged.find((v) => v.rule === "protected-branch")!.detail).toContain("merge to protected branch");
    const pushed = checkGuardrailsForMerge([team({ protected_branches: ["main"] })], [], "main", true);
    // Both entries (merge AND push) match the same protected branch — one violation per action.
    expect(pushed.filter((v) => v.rule === "protected-branch").map((v) => v.detail).join(" | ")).toContain("push to protected branch");
  });

  // Actor-aware ruling (2026-08-20): Conductor approval at the merge gate is itself the authority to
  // land on a protected branch — `approvedGate` is board/gateops.ts#doApproveMerge's own proof of that,
  // never supplied by a preview/recheck call. `protected_paths` is a different namespace and untouched.
  test("approvedGate exempts protected_branches on the merge target, but never protected_paths", () => {
    const approvedGate = { approvedBy: "cas 2026-08-20", branchSha: "deadbeef" };
    const branchOnly = checkGuardrailsForMerge([team({ protected_branches: ["main"] })], ["readme.md"], "main", false, approvedGate);
    expect(branchOnly).toEqual([]);

    const both = checkGuardrailsForMerge([team({ protected_paths: ["payments/"], protected_branches: ["main"] })], ["payments/x.ts"], "main", false, approvedGate);
    expect(both.length).toBe(1);
    expect(both[0].rule).toBe("protected-path");
  });

  test("a clean diff against a team with no matching guardrail produces zero violations", () => {
    const violations = checkGuardrailsForMerge([team({ protected_paths: ["payments/"] })], ["readme.md"], "main", false);
    expect(violations).toEqual([]);
  });

  test("violations union across every responsible team", () => {
    const violations = checkGuardrailsForMerge(
      [team({ protected_paths: ["payments/"] }), team({ protected_paths: ["infra/"] })],
      ["payments/x.ts", "infra/y.ts"],
      "main",
      false,
    );
    expect(violations.length).toBe(2);
  });

  test("mergeDiffEntries never cross-matches a file path against protected_branches (ruling C6)", () => {
    const entries = mergeDiffEntries(["main.ts"], "main", false);
    // 'main.ts' is a PATH entry, never a branch entry — a team protecting branch 'main' must not treat
    // a file literally named 'main.ts' as touching it.
    const violations = checkGuardrailsForMerge([team({ protected_branches: ["main.ts"] })], ["main.ts"], "main", false);
    expect(violations).toEqual([]);
    void entries;
  });

  test("a push action entry is only added when willPush is true", () => {
    const withoutPush = mergeDiffEntries([], "main", false);
    const withPush = mergeDiffEntries([], "main", true);
    expect(withoutPush.some((e) => e.action === "push")).toBe(false);
    expect(withPush.some((e) => e.action === "push")).toBe(true);
  });
});

describe("formatMergeArtifact — schema-valid, round-trips through repo.ts's own parser", () => {
  test("a clean gate's doc parses back with every field intact and passes validateArtifactSource", () => {
    const trial = { branch: "levare/unit-a", target: "main", commitsAhead: 2, diffstat: " feature.txt | 1 +\n", diffFiles: ["feature.txt"], conflicted: false, conflicts: [] };
    const doc = formatMergeArtifact("unit-a", "storefront", "merge-unit-a-v1", "2026-07-17", trial, []);
    const errs = validateArtifactSource(doc);
    expect(errs).toEqual([]);
    const art = parseArtifactDoc(doc);
    expect(art.kind).toBe("merge");
    expect(art.status).toBe("in-review");
    expect(art.approved_by).toBeNull();
    expect(art.merge).toEqual({ branch: "levare/unit-a", target: "main", commits_ahead: 2, diffstat: " feature.txt | 1 +\n", conflicted: false, conflicts: [], guardrail_violations: [] });
  });

  test("a conflicted gate's doc names every conflicting file, quoted safely", () => {
    const trial = { branch: "levare/unit-b", target: "main", commitsAhead: 1, diffstat: "", diffFiles: ["a b.txt"], conflicted: true, conflicts: ["a b.txt", "src/x.ts"] };
    const doc = formatMergeArtifact("unit-b", "storefront", "merge-unit-b-v1", "2026-07-17", trial, [
      { rule: "protected-path", detail: "'a b.txt' touches protected path 'a b.txt' (team 'kestrel')" },
    ]);
    const errs = validateArtifactSource(doc);
    expect(errs).toEqual([]);
    const art = parseArtifactDoc(doc);
    expect(art.merge?.conflicted).toBe(true);
    expect(art.merge?.conflicts).toEqual(["a b.txt", "src/x.ts"]);
    expect(art.merge?.guardrail_violations.length).toBe(1);
    expect(art.body).toContain("CONFLICTED");
  });

  // Phase 3 (2026-08-20 ruling): the heading is trial-merge MECHANICS only (never conflated with the
  // gate's disposition) — a `protected-path`/`never` violation still reads as blocked in the body, but
  // a `protected-branch` finding reads as "approval resolves this", never as a generic block.
  describe("heading vs. disposition are separate facts", () => {
    const trial = { branch: "levare/unit-c", target: "main", commitsAhead: 1, diffstat: "", diffFiles: [], conflicted: false, conflicts: [] };

    test("a real blocker (protected-path) still reads as blocked, even though the trial itself is clean", () => {
      const doc = formatMergeArtifact("unit-c", "storefront", "merge-unit-c-v1", "2026-07-17", trial, [{ rule: "protected-path", detail: "'x' touches protected path 'x' (team 'kestrel')" }]);
      const art = parseArtifactDoc(doc);
      expect(art.body).toContain("# merge — clean");
      expect(art.body).toContain("Blocked by guardrail");
      expect(art.body).not.toContain("clean.\n\nBlocked"); // sanity: the mechanics sentence and the disposition sentence are distinct, not merged into one claim
    });

    test("a protected-branch finding (gate-exempt) never reads as a generic block", () => {
      const doc = formatMergeArtifact("unit-c", "storefront", "merge-unit-c-v1", "2026-07-17", trial, [{ rule: "protected-branch", detail: "merge to protected branch 'main' (team 'quill')" }]);
      const art = parseArtifactDoc(doc);
      expect(art.body).toContain("# merge — clean");
      expect(art.body).not.toContain("Blocked by guardrail");
      expect(art.body).toContain("approving this gate is the authorization to land here");
    });

    test("no violations reads as a plain clean merge", () => {
      const doc = formatMergeArtifact("unit-c", "storefront", "merge-unit-c-v1", "2026-07-17", trial, []);
      const art = parseArtifactDoc(doc);
      expect(art.body).toContain("merges cleanly.");
      expect(art.body).not.toContain("Blocked by guardrail");
      expect(art.body).not.toContain("authorization to land here");
    });
  });
});

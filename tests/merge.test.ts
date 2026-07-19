// NOTES MERGE-1 (PRD Amendment 2, M1-M5). Tests the merge machinery in src/merge.ts directly against
// real, local git repos this file creates itself — never the studio's own repo, never a fixture with a
// bogus/non-local `repo:` (fixtures/golden's `storefront` deliberately stays that way — see
// resolveProjectRepoPath's own doc and this file's "resolveProjectRepoPath" describe block).

import { test, expect, describe } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  workBranchName,
  resolveProjectRepoPath,
  branchExists,
  createWorkBranch,
  trialMerge,
  executeMerge,
  mergeDiffEntries,
  checkGuardrailsForMerge,
  formatMergeArtifact,
  createDispatchWorktree,
} from "../src/merge.ts";
import { parseArtifactDoc } from "../src/repo.ts";
import { validateArtifactSource } from "../src/validate.ts";
import type { Team } from "../src/types.ts";

const HERMETIC_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" };

function git(repoRoot: string, args: string[]): string {
  const r = spawnSync("git", ["-C", repoRoot, "-c", "user.name=seed", "-c", "user.email=seed@levare.test", "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf8",
    env: HERMETIC_ENV,
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}${r.stdout}`);
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

      const remoteHead = spawnSync("git", ["-C", remote, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).stdout.trim();
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

describe("createDispatchWorktree (NOTES R4-SANDBOX, Ruling 1)", () => {
  test("checks out the branch (never detached) in a fresh scratch worktree, distinct from the project's own working tree", () => {
    const repo = makeProjectRepo();
    try {
      git(repo, ["branch", "levare/unit-a", "main"]);
      const mainHead = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
      const created = createDispatchWorktree(repo, "levare/unit-a");
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
      const created = createDispatchWorktree(repo, "levare/unit-a");
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

  test("two units on the same project get two independent worktrees of two different branches at once", () => {
    const repo = makeProjectRepo();
    try {
      git(repo, ["branch", "levare/unit-a", "main"]);
      git(repo, ["branch", "levare/unit-b", "main"]);
      const a = createDispatchWorktree(repo, "levare/unit-a");
      const b = createDispatchWorktree(repo, "levare/unit-b");
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

  test("fails loudly (never silently) when the branch does not exist", () => {
    const repo = makeProjectRepo();
    try {
      const created = createDispatchWorktree(repo, "levare/ghost");
      expect(created.ok).toBe(false);
      if (created.ok) return;
      expect(created.error).toContain("ghost");
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
    const doc = formatMergeArtifact("unit-b", "storefront", "merge-unit-b-v1", "2026-07-17", trial, ["protected-path: 'a b.txt' touches protected path 'a b.txt' (team 'kestrel')"]);
    const errs = validateArtifactSource(doc);
    expect(errs).toEqual([]);
    const art = parseArtifactDoc(doc);
    expect(art.merge?.conflicted).toBe(true);
    expect(art.merge?.conflicts).toEqual(["a b.txt", "src/x.ts"]);
    expect(art.merge?.guardrail_violations.length).toBe(1);
    expect(art.body).toContain("CONFLICTED");
  });
});

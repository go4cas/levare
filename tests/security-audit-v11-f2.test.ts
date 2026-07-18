// Security audit v1.1, F2 (HIGH) — merge TOCTOU: guardrails check one branch tip, execution merges a
// later one (docs/security-audit-v11.md, NOTES SEC-V11). Adopts the auditors' repro against a real,
// local git fixture repo — never a mock of the merge machinery.

import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workBranchName, trialMerge, executeMerge } from "../src/merge.ts";

function rmrf(p: string): void {
  rmSync(p, { recursive: true, force: true });
}

describe("F2 — a post-trial protected-path commit cannot land (merge TOCTOU)", () => {
  const HERMETIC_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" };

  function git(repoRoot: string, args: string[]): string {
    const r = spawnSync(
      "git",
      ["-C", repoRoot, "-c", "user.name=seed", "-c", "user.email=seed@levare.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "init.defaultBranch=main", ...args],
      { encoding: "utf8", env: HERMETIC_ENV },
    );
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}${r.stdout}`);
    return r.stdout;
  }

  function makeProjectRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "levare-f2-proj-"));
    git(dir, ["init", "-q"]);
    writeFileSync(join(dir, "README.md"), "hello\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "initial"]);
    return dir;
  }

  function commit(repo: string, branch: string, file: string, content: string): void {
    git(repo, ["checkout", "-q", branch]);
    mkdirSync(join(repo, file, ".."), { recursive: true });
    writeFileSync(join(repo, file), content);
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", `commit ${file}`]);
    git(repo, ["checkout", "-q", "main"]);
  }

  test("a stale pinned SHA refuses to land — the protected file never reaches default_branch (real fixture repo)", () => {
    const repo = makeProjectRepo();
    try {
      const branch = workBranchName("widget-1");
      git(repo, ["branch", branch, "main"]);
      commit(repo, branch, "feature.txt", "clean work\n");

      // The Conductor's own guardrail check runs against THIS trial — clean, no protected path.
      const trial = trialMerge(repo, branch, "main");
      expect(trial.conflicted).toBe(false);
      expect(trial.diffFiles).toEqual(["feature.txt"]);
      expect(trial.branchSha).toBeDefined();
      const checkedSha = trial.branchSha!;

      // Between the check and the click landing, a FOREIGN commit (a still-running CLI member, or an
      // adversary with branch-push access per the threat model) adds a protected-path change.
      commit(repo, branch, "deploy/config.yml", "secret: true\n");
      const advancedSha = git(repo, ["rev-parse", branch]).trim();
      expect(advancedSha).not.toBe(checkedSha);

      const preMainSha = git(repo, ["rev-parse", "main"]).trim();
      // Pre-fix (no `expectedBranchSha` pin): this call would silently resolve `branch` to its NEW tip
      // and merge the protected file straight past the guardrail check that already ran. Post-fix: it
      // must refuse, naming the staleness, and touch nothing.
      const exec = executeMerge(repo, branch, "main", "merge widget-1", null, checkedSha);
      expect(exec.ok).toBe(false);
      if (exec.ok) return;
      expect(exec.stage).toBe("stale");
      expect(exec.error).toContain("advanced");

      // default_branch never moved, and specifically never contains the protected file.
      expect(git(repo, ["rev-parse", "main"]).trim()).toBe(preMainSha);
      const mainFiles = git(repo, ["ls-tree", "-r", "--name-only", "main"]);
      expect(mainFiles).not.toContain("deploy/config.yml");
    } finally {
      rmrf(repo);
    }
  });

  test("executing with the CURRENT sha (no staleness) still lands normally — the fix never blocks a legitimate merge", () => {
    const repo = makeProjectRepo();
    try {
      const branch = workBranchName("widget-2");
      git(repo, ["branch", branch, "main"]);
      commit(repo, branch, "feature.txt", "clean work\n");
      const trial = trialMerge(repo, branch, "main");
      expect(trial.conflicted).toBe(false);
      const exec = executeMerge(repo, branch, "main", "merge widget-2", null, trial.branchSha);
      expect(exec.ok).toBe(true);
      if (!exec.ok) return;
      const mainFiles = git(repo, ["ls-tree", "-r", "--name-only", "main"]);
      expect(mainFiles).toContain("feature.txt");
    } finally {
      rmrf(repo);
    }
  });

  test("omitting expectedBranchSha preserves old behaviour (merges the current tip) — the pin is additive, not a breaking change", () => {
    const repo = makeProjectRepo();
    try {
      const branch = workBranchName("widget-3");
      git(repo, ["branch", branch, "main"]);
      commit(repo, branch, "feature.txt", "x\n");
      const exec = executeMerge(repo, branch, "main", "merge widget-3", null);
      expect(exec.ok).toBe(true);
    } finally {
      rmrf(repo);
    }
  });
});

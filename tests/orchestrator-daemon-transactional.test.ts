import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, cpSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promoteIdea } from "../src/orchestrator.ts";
import { resolveGate } from "../src/board/gateops.ts";
import { Daemon } from "../src/daemon.ts";
import { stubAdapterRunner } from "../src/replay.ts";
import { loadRepo } from "../src/repo.ts";
import type { Verb } from "../src/runner.ts";

// NOTES REV2, finding 1 (continued): the shared `transactionalWrite` helper (src/git.ts) is also what
// orchestrator.ts's unit operations and daemon.ts's budget-gate `stop` resolution now route through —
// "every mutating path" in the goal's own words, not just the three call sites it named explicitly.
// These tests force a commit failure for two of those remaining paths and assert the same
// byte-identical-rollback guarantee.

const HERMETIC_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" };

function git(root: string, args: string[]): ReturnType<typeof spawnSync> {
  const r = spawnSync(
    "git",
    ["-C", root, "-c", "user.name=seed", "-c", "user.email=seed@levare.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "init.defaultBranch=main", ...args],
    { encoding: "utf8", env: HERMETIC_ENV },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}${r.stdout}`);
  return r;
}

function seedScratchRepo(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  cpSync("fixtures/golden", root, { recursive: true });
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "seed golden fixture"]);
  return root;
}

function headRev(root: string): string {
  return spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
}

function sabotageIndex(root: string): void {
  writeFileSync(join(root, ".git", "index"), "not a valid git index\n");
}

test("orchestrator.ts#promoteIdea: a forced commit failure restores the idea file and removes the half-created unit", () => {
  const root = seedScratchRepo("levare-rev2-promote-");
  try {
    const ideaFile = join(root, "ideas/loyalty-program.md");
    const before = readFileSync(ideaFile, "utf8");
    const headBefore = headRev(root);
    const unitDir = join(root, "work/storefront/loyalty-program-unit");
    expect(existsSync(unitDir)).toBe(false);

    sabotageIndex(root);
    const result = promoteIdea({ root, idea: "loyalty-program", project: "storefront", unit: "loyalty-program-unit" });

    expect(result.ok).toBe(false);
    // The idea is exactly as it was — never left half-promoted.
    expect(readFileSync(ideaFile, "utf8")).toBe(before);
    // The unit directory this call itself created is gone again.
    expect(existsSync(unitDir)).toBe(false);
    expect(headRev(root)).toBe(headBefore);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("daemon.ts#resolveBudget('stop'): a forced commit failure leaves the unit's on-disk status untouched", async () => {
  const root = seedScratchRepo("levare-rev2-daemon-stop-");
  try {
    const unitDir = join(root, "work/storefront/stop-unit-tx");
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(join(unitDir, "unit.md"), `---\ntype: feature\nstatus: active\nproject: storefront\nunit: stop-unit-tx\nbudget: 0.01\n---\n\n# stop-unit-tx\n\nBudget-gate rollback fixture.\n`);
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "seed stop-unit-tx"]);

    const started = await resolveGate(root, "storefront", "stop-unit-tx", "start" as Verb, { memberRunner: stubAdapterRunner(loadRepo(root)), today: "2026-07-16" });
    if (!started.ok) throw new Error(`seed start failed: ${(started as { error: string }).error}`);
    const approved = await resolveGate(root, "storefront", "product-brief-stop-unit-tx-v1", "approve" as Verb, { today: "2026-07-16" });
    if (!approved.ok) throw new Error(`seed approve failed: ${(approved as { error: string }).error}`);

    const daemon = new Daemon(root, { memberRunner: stubAdapterRunner });
    const tick = await daemon.tick();
    expect(tick.entries.find((e) => e.unit === "stop-unit-tx")!.outcome.outcome).toBe("budget-gate");

    const before = readFileSync(join(unitDir, "unit.md"), "utf8");
    const headBefore = headRev(root);

    sabotageIndex(root);
    expect(() => daemon.resolveBudget("storefront", "stop-unit-tx", "stop")).toThrow();

    expect(readFileSync(join(unitDir, "unit.md"), "utf8")).toBe(before);
    expect(headRev(root)).toBe(headBefore);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

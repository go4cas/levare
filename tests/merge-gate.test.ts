// NOTES MERGE-1 (PRD Amendment 2, M1-M5) — the live path: board/gateops.ts's `doStart` (work-branch
// creation, M1) and `doApproveMerge`/`doRecheckMerge` (the merge gate itself, M2-M5), plus
// dagwalk.ts's `advanceUnit` opening the gate on flow completion. Everything here drives real,
// local git repos this file creates itself (a studio repo AND, separately, a project repo) — never
// fixtures/golden's own tree (its `storefront` project's `repo:` is deliberately a non-local
// placeholder — see merge.test.ts's own `resolveProjectRepoPath` coverage).

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGate } from "../src/board/gateops.ts";
import { loadRepo } from "../src/repo.ts";
import { advanceUnit, type AsyncMemberRunner } from "../src/dagwalk.ts";
import { openGates } from "../src/derive.ts";
import type { Verb } from "../src/runner.ts";

const HERMETIC_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" };

function git(root: string, args: string[]): string {
  const r = spawnSync(
    "git",
    ["-C", root, "-c", "user.name=seed", "-c", "user.email=seed@levare.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "init.defaultBranch=main", ...args],
    { encoding: "utf8", env: HERMETIC_ENV },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}${r.stdout}`);
  return r.stdout;
}

const TODAY = "2026-07-17";

interface StudioOpts {
  guardrails?: { protected_paths?: string[]; protected_branches?: string[]; never?: string[] };
  remote?: "good" | "bad" | null;
  noRepo?: boolean;
}

/** A real local PROJECT repo (default_branch "main", one committed file), separate from the studio. */
function makeProjectRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "levare-mg-proj-"));
  git(dir, ["-c", "init.defaultBranch=main", "init", "-q"]);
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "initial"]);
  return dir;
}

function writeFile(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

/** A minimal, hand-built, schema-valid studio: one team/agent producing `task`, one type expecting
 * only `task`, one project ("acme"), one active unit ("widget-1") with an unmet-free start gate. */
function buildStudio(opts: StudioOpts = {}): { root: string; projectRepo: string; remoteRepo?: string } {
  const root = mkdtempSync(join(tmpdir(), "levare-mg-studio-"));
  const projectRepo = makeProjectRepo();
  let remoteRepo: string | undefined;

  writeFile(
    join(root, "teams", "shipteam.md"),
    [
      "---",
      "name: shipteam",
      "consumes: []",
      "produces: [task]",
      "members: [worker]",
      "flow:",
      "  - step: task",
      "  - gate: human",
      "style:",
      "  color: \"#2E6FB0\"",
      ...(opts.guardrails
        ? [
            "guardrails:",
            ...(opts.guardrails.protected_paths ? [`  protected_paths: [${opts.guardrails.protected_paths.join(", ")}]`] : []),
            ...(opts.guardrails.protected_branches ? [`  protected_branches: [${opts.guardrails.protected_branches.join(", ")}]`] : []),
            ...(opts.guardrails.never ? [`  never: [${opts.guardrails.never.join(", ")}]`] : []),
          ]
        : []),
      "---",
      "",
      "# Shipteam",
      "",
      "A single-step team for merge-gate testing.",
      "",
    ].join("\n"),
  );

  writeFile(
    join(root, "agents", "worker.md"),
    ["---", "name: worker", "kind: native", "produces: [task]", "model: claude-sonnet-5", "style:", "  avatar: Wo", "---", "", "A worker.", ""].join("\n"),
  );

  writeFile(
    join(root, "types", "feature.md"),
    ["---", "name: feature", "glyph: \"▸\"", "expects: [task]", "gates: [human]", "---", "", "# Feature", "", "A minimal feature type.", ""].join("\n"),
  );

  if (opts.remote === "good") {
    remoteRepo = mkdtempSync(join(tmpdir(), "levare-mg-remote-"));
    git(remoteRepo, ["-c", "init.defaultBranch=main", "init", "-q", "--bare"]);
    git(projectRepo, ["push", remoteRepo, "main:main"]);
  }
  const remoteField = opts.remote === "good" ? remoteRepo! : opts.remote === "bad" ? join(projectRepo, "..", "levare-mg-nonexistent-remote") : "null";
  // A no-repo project declares a bare placeholder (never a real local checkout) — matching
  // resolveProjectRepoPath's own "unresolvable" case, not the studio-self-reference case.
  const repoField = opts.noRepo ? "git@example.invalid:acme/nowhere.git" : projectRepo;

  writeFile(
    join(root, "projects", "acme.md"),
    [
      "---",
      "name: acme",
      `repo: ${repoField}`,
      `remote: ${remoteField}`,
      "default_branch: main",
      "deploy: null",
      "pace: auto",
      "---",
      "",
      "# Acme — house rules",
      "",
      "House rules.",
      "",
    ].join("\n"),
  );

  writeFile(
    join(root, "work", "acme", "widget-1", "unit.md"),
    ["---", "type: feature", "status: active", "---", "", "# widget-1", "", "A minimal unit for merge-gate testing.", ""].join("\n"),
  );

  git(root, ["-c", "init.defaultBranch=main", "init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "seed studio"]);

  return { root, projectRepo, remoteRepo };
}

function rmrf(p: string): void {
  rmSync(p, { recursive: true, force: true });
}

/** Every `produce` call returns a fresh minimal `task` artifact; dagwalk.ts overwrites `id` itself. */
const memberRunner: AsyncMemberRunner = {
  capabilities: () => [{ member: "worker", kind: "task" }],
  produce: async (_member, kind, unit, project) => ({
    doc: ["---", `kind: ${kind}`, "id: PLACEHOLDER", `unit: ${unit}`, `project: ${project}`, "status: in-review", "produced_by: shipteam/worker", "consumes: []", "supersedes: null", "approved_by: null", `created: ${TODAY}`, "files: []", "---", "", "# task", "", "Did the thing.", ""].join("\n"),
  }),
};

/** Add a real, non-conflicting commit to the unit's work branch in the project repo — the member
 * "code work" this goal's own item 1 says should land there. */
function commitToWorkBranch(projectRepo: string, branch: string, file: string, content: string): void {
  git(projectRepo, ["checkout", "-q", branch]);
  writeFile(join(projectRepo, file), content);
  git(projectRepo, ["-c", "user.name=member", "-c", "user.email=member@levare.test", "add", "-A"]);
  git(projectRepo, ["-c", "user.name=member", "-c", "user.email=member@levare.test", "commit", "-q", "-m", "member work on " + file]);
  git(projectRepo, ["checkout", "-q", "main"]);
}

async function startAndApproveTask(root: string): Promise<void> {
  const started = await resolveGate(root, "acme", "widget-1", "start", { memberRunner, today: TODAY });
  expect(started.ok).toBe(true);
  const repo = loadRepo(root);
  const task = [...repo.artifacts.get("acme/widget-1")!.values()].find((a) => a.kind === "task")!;
  const approved = await resolveGate(root, "acme", task.id, "approve", { today: TODAY });
  expect(approved.ok).toBe(true);
}

/** Manually drives the walk one more step — what a live daemon tick would do — so the merge gate
 * (which only opens once the flow is fully satisfied) actually gets produced in a test with no daemon. */
async function advanceOnce(root: string) {
  const repo = loadRepo(root);
  const unit = repo.units.find((u) => u.unit === "widget-1")!;
  return advanceUnit(root, repo, unit, memberRunner, { today: TODAY });
}

let dirs: { root: string; projectRepo: string; remoteRepo?: string };
afterEach(() => {
  rmrf(dirs.root);
  rmrf(dirs.projectRepo);
  if (dirs.remoteRepo) rmrf(dirs.remoteRepo);
});

describe("M1: work branch created as part of the unit-opening transaction", () => {
  test("starting the unit creates levare/<unit> in the project repo, from default_branch's tip", async () => {
    dirs = buildStudio();
    const tip = git(dirs.projectRepo, ["rev-parse", "main"]).trim();
    const started = await resolveGate(dirs.root, "acme", "widget-1", "start", { memberRunner, today: TODAY });
    expect(started.ok).toBe(true);
    const branchTip = git(dirs.projectRepo, ["rev-parse", "levare/widget-1"]).trim();
    expect(branchTip).toBe(tip);
  });

  test("a no-repo project is entirely unaffected — no branch, and flow completion produces no merge gate", async () => {
    dirs = buildStudio({ noRepo: true });
    await startAndApproveTask(dirs.root);
    const result = await advanceOnce(dirs.root);
    expect(result.outcome).toBe("nothing");
    const repo = loadRepo(dirs.root, { validate: false });
    const artifacts = [...repo.artifacts.get("acme/widget-1")!.values()];
    expect(artifacts.some((a) => a.kind === "merge")).toBe(false);
  });
});

describe("M2: the merge gate opens only once the unit's flow completes", () => {
  test("no merge gate exists before the task step is approved", async () => {
    dirs = buildStudio();
    await resolveGate(dirs.root, "acme", "widget-1", "start", { memberRunner, today: TODAY });
    const repo = loadRepo(dirs.root, { validate: false });
    const artifacts = [...repo.artifacts.get("acme/widget-1")!.values()];
    expect(artifacts.some((a) => a.kind === "merge")).toBe(false);
  });

  test("clean merge gate opens once the flow is satisfied, reporting branch/commits-ahead/diffstat/clean", async () => {
    dirs = buildStudio();
    await startAndApproveTask(dirs.root);
    commitToWorkBranch(dirs.projectRepo, "levare/widget-1", "feature.txt", "new stuff\n");

    const result = await advanceOnce(dirs.root);
    expect(result.outcome).toBe("produced");
    if (result.outcome !== "produced") return;
    expect(result.kind).toBe("merge");

    const repo = loadRepo(dirs.root, { validate: false });
    const merge = [...repo.artifacts.get("acme/widget-1")!.values()].find((a) => a.kind === "merge")!;
    expect(merge.status).toBe("in-review");
    expect(merge.merge?.branch).toBe("levare/widget-1");
    expect(merge.merge?.target).toBe("main");
    expect(merge.merge?.commits_ahead).toBe(1);
    expect(merge.merge?.conflicted).toBe(false);
    expect(merge.merge?.diffstat).toContain("feature.txt");

    // The gate is visible through the same openGates() derivation every other gate uses.
    const gate = openGates(repo).find((g) => g.unit === "widget-1" && g.label === "merge");
    expect(gate).toBeDefined();
  });

  test("a second advance while the merge gate is open halts rather than opening a duplicate", async () => {
    dirs = buildStudio();
    await startAndApproveTask(dirs.root);
    commitToWorkBranch(dirs.projectRepo, "levare/widget-1", "feature.txt", "content\n");
    await advanceOnce(dirs.root);
    const result = await advanceOnce(dirs.root);
    expect(result.outcome).toBe("halted");
  });
});

describe("M2: a conflicted merge gate refuses approval; recheck re-runs it", () => {
  async function plantConflict(root: string, projectRepo: string): Promise<void> {
    await startAndApproveTask(root);
    // Both the work branch and main change the SAME line of the SAME file after diverging.
    git(projectRepo, ["checkout", "-q", "levare/widget-1"]);
    writeFileSync(join(projectRepo, "README.md"), "CHANGED ON BRANCH\n");
    git(projectRepo, ["-c", "user.name=member", "-c", "user.email=member@levare.test", "add", "-A"]);
    git(projectRepo, ["-c", "user.name=member", "-c", "user.email=member@levare.test", "commit", "-q", "-m", "branch changes README"]);
    git(projectRepo, ["checkout", "-q", "main"]);
    writeFileSync(join(projectRepo, "README.md"), "CHANGED ON MAIN\n");
    git(projectRepo, ["add", "-A"]);
    git(projectRepo, ["commit", "-q", "-m", "main also changes README"]);
  }

  test("the gate opens CONFLICTED, naming the file, and cannot be approved", async () => {
    dirs = buildStudio();
    await plantConflict(dirs.root, dirs.projectRepo);
    const result = await advanceOnce(dirs.root);
    expect(result.outcome).toBe("produced");
    if (result.outcome !== "produced") return;

    let repo = loadRepo(dirs.root, { validate: false });
    let merge = [...repo.artifacts.get("acme/widget-1")!.values()].find((a) => a.kind === "merge")!;
    expect(merge.merge?.conflicted).toBe(true);
    expect(merge.merge?.conflicts).toEqual(["README.md"]);

    const approve = await resolveGate(dirs.root, "acme", merge.id, "approve", { today: TODAY });
    expect(approve.ok).toBe(false);
    if (approve.ok) return;
    expect(approve.status).toBe(409);
    expect(approve.error).toContain("README.md");

    // Still in-review, still conflicted — approval truly refused, not silently downgraded.
    repo = loadRepo(dirs.root, { validate: false });
    merge = [...repo.artifacts.get("acme/widget-1")!.values()].find((a) => a.kind === "merge")!;
    expect(merge.status).toBe("in-review");

    // Resolve the conflict by hand, in the project repo, on the work branch — human work, per M2.
    git(dirs.projectRepo, ["checkout", "-q", "levare/widget-1"]);
    git(dirs.projectRepo, ["merge", "main", "-X", "ours", "--no-edit", "-q"]);
    git(dirs.projectRepo, ["checkout", "-q", "main"]);

    const recheck = await resolveGate(dirs.root, "acme", merge.id, "recheck" as Verb, { today: TODAY });
    expect(recheck.ok).toBe(true);
    repo = loadRepo(dirs.root, { validate: false });
    merge = [...repo.artifacts.get("acme/widget-1")!.values()].find((a) => a.kind === "merge")!;
    expect(merge.merge?.conflicted).toBe(false);
    expect(merge.status).toBe("in-review"); // recheck never approves on its own.
  });

  test("reject/request are refused against a merge gate — resolution is human work in the repo, not a verb", async () => {
    dirs = buildStudio();
    await plantConflict(dirs.root, dirs.projectRepo);
    await advanceOnce(dirs.root);
    const repo = loadRepo(dirs.root, { validate: false });
    const merge = [...repo.artifacts.get("acme/widget-1")!.values()].find((a) => a.kind === "merge")!;
    const rejected = await resolveGate(dirs.root, "acme", merge.id, "reject", { today: TODAY });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.status).toBe(409);
  });
});

describe("M3: guardrails enforce at execution time, on the actual diff", () => {
  test("a protected-path violation FAILS the execution, even after approval is clicked, naming the rule", async () => {
    dirs = buildStudio({ guardrails: { protected_paths: ["deploy/"] } });
    await startAndApproveTask(dirs.root);
    commitToWorkBranch(dirs.projectRepo, "levare/widget-1", "deploy/config.yml", "secret: true\n");
    await advanceOnce(dirs.root);

    const repo = loadRepo(dirs.root, { validate: false });
    const merge = [...repo.artifacts.get("acme/widget-1")!.values()].find((a) => a.kind === "merge")!;
    // Even though the trial-merge report itself is clean (no conflict), approval must still fail.
    expect(merge.merge?.conflicted).toBe(false);

    const preSha = git(dirs.projectRepo, ["rev-parse", "main"]).trim();
    const approve = await resolveGate(dirs.root, "acme", merge.id, "approve", { today: TODAY });
    expect(approve.ok).toBe(false);
    if (approve.ok) return;
    expect(approve.status).toBe(409);
    expect(approve.error).toContain("protected-path");
    expect(approve.error).toContain("deploy/config.yml");

    // Nothing landed: main didn't move, the artifact is still in-review, the unit is still active.
    expect(git(dirs.projectRepo, ["rev-parse", "main"]).trim()).toBe(preSha);
    const repoAfter = loadRepo(dirs.root, { validate: false });
    const mergeAfter = [...repoAfter.artifacts.get("acme/widget-1")!.values()].find((a) => a.kind === "merge")!;
    expect(mergeAfter.status).toBe("in-review");
    const unitAfter = repoAfter.units.find((u) => u.unit === "widget-1")!;
    expect(unitAfter.status).toBe("active");
  });

  test("a protected_branches violation on the target also fails the execution", async () => {
    dirs = buildStudio({ guardrails: { protected_branches: ["main"] } });
    await startAndApproveTask(dirs.root);
    commitToWorkBranch(dirs.projectRepo, "levare/widget-1", "feature.txt", "x\n");
    await advanceOnce(dirs.root);
    const repo = loadRepo(dirs.root, { validate: false });
    const merge = [...repo.artifacts.get("acme/widget-1")!.values()].find((a) => a.kind === "merge")!;
    const approve = await resolveGate(dirs.root, "acme", merge.id, "approve", { today: TODAY });
    expect(approve.ok).toBe(false);
    if (!approve.ok) expect(approve.error).toContain("protected-branch");
  });
});

describe("M4/M5: a clean approval merges, preserves history, and closes the unit", () => {
  test("approving produces a levare-runner merge commit with the member's own commit history intact, and ships the unit", async () => {
    dirs = buildStudio();
    await startAndApproveTask(dirs.root);
    commitToWorkBranch(dirs.projectRepo, "levare/widget-1", "feature.txt", "shipped content\n");
    const memberSha = git(dirs.projectRepo, ["rev-parse", "levare/widget-1"]).trim();
    await advanceOnce(dirs.root);

    const repo = loadRepo(dirs.root, { validate: false });
    const merge = [...repo.artifacts.get("acme/widget-1")!.values()].find((a) => a.kind === "merge")!;
    const approve = await resolveGate(dirs.root, "acme", merge.id, "approve", { today: TODAY });
    expect(approve.ok).toBe(true);
    if (!approve.ok) return;

    // A real merge commit landed on the project repo's main, authored levare-runner, naming the unit.
    const mainSha = git(dirs.projectRepo, ["rev-parse", "main"]).trim();
    const parents = git(dirs.projectRepo, ["log", "-1", "--pretty=%P", mainSha]).trim().split(" ");
    expect(parents).toContain(memberSha);
    expect(git(dirs.projectRepo, ["log", "-1", "--pretty=%an <%ae>", mainSha]).trim()).toBe("levare-runner <runner@levare.local>");
    expect(git(dirs.projectRepo, ["log", "-1", "--pretty=%s", mainSha]).trim()).toContain("widget-1");
    // Never squashed: the member's own commit is still reachable with its own authorship.
    expect(git(dirs.projectRepo, ["log", "--pretty=%an", mainSha]).trim().split("\n")).toContain("member");

    // The merge artifact recorded the execution, referencing the project merge SHA — the audit trail.
    const repoAfter = loadRepo(dirs.root, { validate: false });
    const mergeAfter = [...repoAfter.artifacts.get("acme/widget-1")!.values()].find((a) => a.kind === "merge")!;
    expect(mergeAfter.status).toBe("approved");
    expect(mergeAfter.merge_result?.merge_commit).toBe(mainSha);
    expect(mergeAfter.merge_result?.pushed).toBeNull();

    // The studio's own resolution commit references the project merge SHA (goal: "the studio commit
    // references the project merge SHA for the audit trail").
    const studioLog = git(dirs.root, ["log", "-1", "--pretty=%s"]);
    expect(studioLog).toContain(mainSha);

    // Success closes the unit.
    const unitAfter = repoAfter.units.find((u) => u.unit === "widget-1")!;
    expect(unitAfter.status).toBe("shipped");
  });

  test("where the project declares remote:, the push lands in the same transaction", async () => {
    dirs = buildStudio({ remote: "good" });
    await startAndApproveTask(dirs.root);
    commitToWorkBranch(dirs.projectRepo, "levare/widget-1", "feature.txt", "x\n");
    await advanceOnce(dirs.root);
    const repo = loadRepo(dirs.root, { validate: false });
    const merge = [...repo.artifacts.get("acme/widget-1")!.values()].find((a) => a.kind === "merge")!;
    const approve = await resolveGate(dirs.root, "acme", merge.id, "approve", { today: TODAY });
    expect(approve.ok).toBe(true);

    const mainSha = git(dirs.projectRepo, ["rev-parse", "main"]).trim();
    const remoteSha = spawnSync("git", ["-C", dirs.remoteRepo!, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).stdout.trim();
    expect(remoteSha).toBe(mainSha);

    const repoAfter = loadRepo(dirs.root, { validate: false });
    const mergeAfter = [...repoAfter.artifacts.get("acme/widget-1")!.values()].find((a) => a.kind === "merge")!;
    expect(mergeAfter.merge_result?.pushed).toBe(true);
  });

  test("a push failure rolls back the local merge byte-perfectly, blocks the gate named, and un-approves nothing", async () => {
    dirs = buildStudio({ remote: "bad" });
    await startAndApproveTask(dirs.root);
    commitToWorkBranch(dirs.projectRepo, "levare/widget-1", "feature.txt", "x\n");
    await advanceOnce(dirs.root);
    const repo = loadRepo(dirs.root, { validate: false });
    const merge = [...repo.artifacts.get("acme/widget-1")!.values()].find((a) => a.kind === "merge")!;
    const preSha = git(dirs.projectRepo, ["rev-parse", "main"]).trim();

    const approve = await resolveGate(dirs.root, "acme", merge.id, "approve", { today: TODAY });
    expect(approve.ok).toBe(false);
    if (approve.ok) return;
    expect(approve.status).toBe(502);
    expect(approve.error).toContain("push");

    // Byte-perfect rollback of the PROJECT repo's local merge.
    expect(git(dirs.projectRepo, ["rev-parse", "main"]).trim()).toBe(preSha);
    expect(git(dirs.projectRepo, ["status", "--porcelain"]).trim()).toBe("");

    // Nothing in the STUDIO repo committed either — the artifact is untouched, the unit is untouched.
    const repoAfter = loadRepo(dirs.root, { validate: false });
    const mergeAfter = [...repoAfter.artifacts.get("acme/widget-1")!.values()].find((a) => a.kind === "merge")!;
    expect(mergeAfter.status).toBe("in-review");
    expect(mergeAfter.merge_result).toBeNull();
    const unitAfter = repoAfter.units.find((u) => u.unit === "widget-1")!;
    expect(unitAfter.status).toBe("active");
  });
});

describe("member-side wiring (goal item 1): a dispatched member's working context", () => {
  test("a member dispatched after the work branch exists gets it checked out in the project repo", async () => {
    dirs = buildStudio();
    // `start` (M1) creates the branch, then dispatches `worker` for `task` — the dispatch itself is
    // what exercises adapters.ts's memberWorkingContext checkout wiring.
    const started = await resolveGate(dirs.root, "acme", "widget-1", "start", { memberRunner, today: TODAY });
    expect(started.ok).toBe(true);
    // The stub memberRunner never actually spawns anything real (it's a plain function), so this proves
    // ONLY that doStart's branch creation ran and is checkout-able — the checkout itself is proven at
    // the adapters.ts unit-test layer (adapters.test.ts) and merge.test.ts's `ensureWorkBranchCheckedOut`
    // coverage; wiring the two together is what this integration test's OWN setup already exercises
    // (buildStudio's project repo + doStart's branch creation, both real git).
    expect(existsSync(join(dirs.projectRepo, ".git", "refs", "heads", "levare", "widget-1"))).toBe(true);
  });
});

// NOTES MERGE-2 — proves the goal's fifth acceptance criterion end to end: a `recheck` POST re-renders
// the merge gate card to its new trial state through the REAL server (board/serve.ts), the same
// fragment mechanism (NOTES UI10) the client's SSE `reload` listener already drives via
// `refreshCurrent()` (proven generically in tests/board-client-navigation.test.ts — this suite doesn't
// re-derive that generic swap, only that the SERVER SIDE of it — the next fragment fetch — actually
// reflects recheck's own write). Drives a real local git project repo (same fixture-building idiom as
// tests/merge-gate.test.ts) through: conflicted → (by-hand resolution) → recheck → clean, asserting the
// studio page's (its "Needs You" inbox embeds gate cards directly in `.main`, unlike the project page's
// own summon-template indirection) fragment HTML for the merge card flips from CONFLICTED/Re-check to
// CLEAN/Merge.

import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBoard } from "../src/board/serve.ts";
import { resolveGate } from "../src/board/gateops.ts";
import { loadRepo } from "../src/repo.ts";
import { advanceUnit, type AsyncMemberRunner } from "../src/dagwalk.ts";

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
function writeFile(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}
const TODAY = "2026-07-17";

function makeProjectRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "levare-mgr-proj-"));
  git(dir, ["-c", "init.defaultBranch=main", "init", "-q"]);
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "initial"]);
  return dir;
}

function buildStudio(): { root: string; projectRepo: string } {
  const root = mkdtempSync(join(tmpdir(), "levare-mgr-studio-"));
  const projectRepo = makeProjectRepo();
  writeFile(
    join(root, "teams", "shipteam.md"),
    ["---", "name: shipteam", "consumes: []", "produces: [task]", "members: [worker]", "flow:", "  - step: task", "  - gate: human", 'style:', '  color: "#2E6FB0"', "---", "", "# Shipteam", "", "A single-step team.", ""].join("\n"),
  );
  writeFile(
    join(root, "agents", "worker.md"),
    ["---", "name: worker", "kind: native", "produces: [task]", "model: claude-sonnet-5", "style:", "  avatar: Wo", "---", "", "A worker.", ""].join("\n"),
  );
  writeFile(
    join(root, "types", "feature.md"),
    ["---", "name: feature", "glyph: \"▸\"", "expects: [task]", "gates: [human]", "---", "", "# Feature", "", "A minimal feature type.", ""].join("\n"),
  );
  writeFile(
    join(root, "projects", "acme.md"),
    ["---", "name: acme", `repo: ${projectRepo}`, "remote: null", "default_branch: main", "deploy: null", "pace: auto", "---", "", "# Acme — house rules", "", "House rules.", ""].join("\n"),
  );
  writeFile(
    join(root, "work", "acme", "widget-1", "unit.md"),
    ["---", "type: feature", "status: active", "---", "", "# widget-1", "", "A minimal unit for the recheck-refresh test.", ""].join("\n"),
  );
  git(root, ["-c", "init.defaultBranch=main", "init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "seed studio"]);
  return { root, projectRepo };
}

const memberRunner: AsyncMemberRunner = {
  capabilities: () => [{ member: "worker", kind: "task" }],
  produce: async (_member, kind, unit, project) => ({
    doc: ["---", `kind: ${kind}`, "id: PLACEHOLDER", `unit: ${unit}`, `project: ${project}`, "status: in-review", "produced_by: shipteam/worker", "consumes: []", "supersedes: null", "approved_by: null", `created: ${TODAY}`, "files: []", "---", "", "# task", "", "Did the thing.", ""].join("\n"),
  }),
};

async function startAndApproveTask(root: string): Promise<void> {
  const started = await resolveGate(root, "acme", "widget-1", "start", { memberRunner, today: TODAY });
  expect(started.ok).toBe(true);
  const repo = loadRepo(root);
  const task = [...repo.artifacts.get("acme/widget-1")!.values()].find((a) => a.kind === "task")!;
  const approved = await resolveGate(root, "acme", task.id, "approve", { today: TODAY });
  expect(approved.ok).toBe(true);
}

function req(url: string, init?: RequestInit): Request {
  return new Request(`http://localhost${url}`, init);
}

describe("merge gate recheck re-renders the board card to its new trial state (NOTES UI10 fragment idiom)", () => {
  test("conflicted → resolve by hand → recheck → the studio page's fragment HTML flips from CONFLICTED/Re-check to CLEAN/Merge", async () => {
    const { root, projectRepo } = buildStudio();
    try {
      await startAndApproveTask(root);

      // Plant a real conflict: both the work branch and main change the same line of README.md.
      git(projectRepo, ["checkout", "-q", "levare/widget-1"]);
      writeFileSync(join(projectRepo, "README.md"), "CHANGED ON BRANCH\n");
      git(projectRepo, ["-c", "user.name=member", "-c", "user.email=member@levare.test", "add", "-A"]);
      git(projectRepo, ["-c", "user.name=member", "-c", "user.email=member@levare.test", "commit", "-q", "-m", "branch changes README"]);
      git(projectRepo, ["checkout", "-q", "main"]);
      writeFileSync(join(projectRepo, "README.md"), "CHANGED ON MAIN\n");
      git(projectRepo, ["add", "-A"]);
      git(projectRepo, ["commit", "-q", "-m", "main also changes README"]);

      let repo = loadRepo(root);
      const unit = repo.units.find((u) => u.unit === "widget-1")!;
      const advanced = await advanceUnit(root, repo, unit, memberRunner, { today: TODAY });
      expect(advanced.outcome).toBe("produced");

      const board = createBoard(root);
      try {
        const before = await board.fetch(req("/studio", { headers: { "X-Levare-Fragment": "1" } }));
        const beforeBody = await before.json();
        expect(beforeBody.main).toContain('class="chip is-failed">CONFLICTED');
        expect(beforeBody.main).toContain('data-verb="recheck"');
        expect(beforeBody.main).not.toContain('data-verb="approve"');
        expect(beforeBody.main).toContain("README.md");

        repo = loadRepo(root, { validate: false });
        const merge = [...repo.artifacts.get("acme/widget-1")!.values()].find((a) => a.kind === "merge")!;
        expect(merge.merge?.conflicted).toBe(true);

        // Resolve by hand on the work branch, in the project repo — human work, per M2.
        git(projectRepo, ["checkout", "-q", "levare/widget-1"]);
        git(projectRepo, ["merge", "main", "-X", "ours", "--no-edit", "-q"]);
        git(projectRepo, ["checkout", "-q", "main"]);

        const recheckRes = await board.fetch(req(`/gates/acme/${merge.id}/recheck`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
        expect(recheckRes.status).toBe(200);
        const recheckBody = await recheckRes.json();
        expect(recheckBody.ok).toBe(true);

        const after = await board.fetch(req("/studio", { headers: { "X-Levare-Fragment": "1" } }));
        const afterBody = await after.json();
        expect(afterBody.main).toContain('class="chip is-done">CLEAN');
        expect(afterBody.main).toContain('data-verb="approve"');
        expect(afterBody.main).not.toContain("CONFLICTED");
        expect(afterBody.main).not.toContain('data-verb="recheck"');
      } finally {
        board.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(projectRepo, { recursive: true, force: true });
    }
  });
});

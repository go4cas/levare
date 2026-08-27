import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { assertSpawnOk } from "./spawn-helpers.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.ts";
import { resolveGate } from "../src/board/gateops.ts";
import { loadRepo } from "../src/repo.ts";
import { scoreNodes } from "../src/derive.ts";
import { advanceUnit, type AsyncMemberRunner } from "../src/dagwalk.ts";

// Finding 145 site 1: PR #61 taught the merge gate CARD to render RE-CHECKING while a recheck is in
// flight, but `scoreNodes`'s merge node (derive.ts) never consulted `inv` — the live-invocation lookup
// every other expected kind already does — and read `currentMerge.status` directly instead, so the
// score rail kept showing a stale "needs you" diamond (or a stale verdict) throughout a recheck.

const HERMETIC_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
function git(root: string, args: string[]) {
  const r = spawnSync(
    "git",
    ["-C", root, "-c", "user.name=seed", "-c", "user.email=seed@levare.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "init.defaultBranch=main", ...args],
    { encoding: "utf8", env: HERMETIC_ENV },
  );
  assertSpawnOk(`git ${args.join(" ")}`, r);
  return r;
}

const TODAY_MERGE = "2026-07-17";

function makeProjectRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "levare-f145-proj-"));
  git(dir, ["init", "-q"]);
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "initial"]);
  return dir;
}

function writeFile(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

function buildMergeStudio(): { root: string; projectRepo: string } {
  const root = mkdtempSync(join(tmpdir(), "levare-f145-studio-"));
  const projectRepo = makeProjectRepo();
  writeFile(
    join(root, "teams", "shipteam.md"),
    ["---", "name: shipteam", "consumes: []", "produces: [task]", "members: [worker]", "flow:", "  - step: task", "  - gate: human", 'style:', '  color: "#2E6FB0"', "---", "", "# Shipteam", ""].join("\n"),
  );
  writeFile(join(root, "agents", "worker.md"), ["---", "name: worker", "kind: native", "produces: [task]", "model: claude-sonnet-5", "style:", "  avatar: Wo", "---", "", "A worker.", ""].join("\n"));
  writeFile(join(root, "types", "feature.md"), ["---", "name: feature", 'glyph: "▸"', "expects: [task]", "gates: [human]", "---", "", "# Feature", ""].join("\n"));
  writeFile(
    join(root, "projects", "acme.md"),
    ["---", "name: acme", `repo: ${projectRepo}`, "remote: null", "default_branch: main", "deploy: null", "pace: auto", "---", "", "# Acme", ""].join("\n"),
  );
  writeFile(join(root, "work", "acme", "widget-1", "unit.md"), ["---", "type: feature", "status: active", "---", "", "# widget-1", ""].join("\n"));
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "seed studio"]);
  return { root, projectRepo };
}

const mergeMemberRunner: AsyncMemberRunner = {
  capabilities: () => [{ member: "worker", kind: "task" }],
  produce: async (_member, kind, unit, project) => ({
    doc: ["---", `kind: ${kind}`, "id: PLACEHOLDER", `unit: ${unit}`, `project: ${project}`, "status: in-review", "produced_by: shipteam/worker", "consumes: []", "supersedes: null", "approved_by: null", `created: ${TODAY_MERGE}`, "files: []", "---", "", "# task", "", "Did the thing.", ""].join("\n"),
  }),
};

describe("Finding 145 site 1: the merge score node vs. an in-flight recheck", () => {
  test("with a merge recheck in flight, the merge node reads active, not the stale gate/verdict", async () => {
    const { root, projectRepo } = buildMergeStudio();
    try {
      const started = await resolveGate(root, "acme", "widget-1", "start", { memberRunner: mergeMemberRunner, today: TODAY_MERGE });
      expect(started.ok).toBe(true);
      let repo = loadRepo(root);
      const task = [...repo.artifacts.get("acme/widget-1")!.values()].find((a) => a.kind === "task")!;
      const approved = await resolveGate(root, "acme", task.id, "approve", { today: TODAY_MERGE });
      expect(approved.ok).toBe(true);

      repo = loadRepo(root);
      const unit = repo.units.find((u) => u.unit === "widget-1")!;
      const advanced = await advanceUnit(root, repo, unit, mergeMemberRunner, { today: TODAY_MERGE });
      expect(advanced.outcome).toBe("produced");

      repo = loadRepo(root, { validate: false });
      const beforeNodes = scoreNodes(repo, unit);
      const beforeMerge = beforeNodes.find((n) => n.kind === "merge")!;
      expect(beforeMerge.state).toBe("gate"); // an open merge trial reads as the rail's own "needs you" diamond.
      expect(beforeMerge.shape).toBe("diamond");

      // Simulate the recheck's in-flight window (board/serve.ts registers exactly this shape around
      // doRecheckMerge's own synchronous work) — the old merge artifact is still on disk, unsuperseded.
      const daemon = new Daemon(root, { memberRunner: () => mergeMemberRunner });
      const invocation = daemon.beginInvocation({ project: "acme", unit: "widget-1", member: "levare-runner", kind: "merge" });
      try {
        const duringNodes = scoreNodes(repo, unit, daemon.running());
        const duringMerge = duringNodes.find((n) => n.kind === "merge")!;
        expect(duringMerge.state).toBe("active");
        expect(duringMerge.shape).toBe("dot");
        expect(duringMerge.live?.startedAt).toBe(invocation.startedAt);
      } finally {
        daemon.endInvocation(invocation);
      }

      // Once the invocation clears, a genuinely settled node is unchanged from before.
      const afterNodes = scoreNodes(repo, unit, daemon.running());
      expect(afterNodes.find((n) => n.kind === "merge")).toEqual(beforeMerge);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(projectRepo, { recursive: true, force: true });
    }
  });
});

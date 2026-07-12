import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, cpSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBoard } from "../src/board/serve.ts";
import {
  handle,
  buildBriefing,
  computeStats,
  openUnit,
  captureIdea,
  promoteIdea,
  proposeRetro,
  proposeKnowledgePromotion,
  resolveProposal,
  locateProjectForTarget,
} from "../src/orchestrator.ts";
import { loadRepo, type Repo } from "../src/repo.ts";
import type { CliProbe, EnvProbe } from "../src/doctor.ts";
import type { Team, TypeTemplate, Project, WorkUnit, Artifact, FlowNode } from "../src/types.ts";

// PRD §7 / §11 phase-5 acceptance. The Orchestrator is a Claude Agent SDK application behind a mocked
// SDK boundary (invariant 10): the deterministic default `interpret`/`narrate` stand in for the real
// model this phase. What's under test here is everything that must hold regardless of what the model
// says: the briefing derives correctly from repo state, a chat gate decision round-trips to the exact
// same mutation the board's POST route makes (ruling C7), a retro proposal never writes LEARNINGS.md
// directly, and intent-to-unit operations produce exactly the repo change they claim to.

const HERMETIC_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" };

function git(repoRoot: string, args: string[]): ReturnType<typeof spawnSync> {
  const r = spawnSync(
    "git",
    ["-C", repoRoot, "-c", "user.name=seed", "-c", "user.email=seed@levare.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "init.defaultBranch=main", ...args],
    { encoding: "utf8", env: HERMETIC_ENV },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}${r.stdout}`);
  return r;
}

function seedScratchRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "levare-orch-"));
  cpSync("fixtures/golden", root, { recursive: true });
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "seed golden fixture"]);
  return root;
}

// Computed from the real clock, not hardcoded: the POST /gates route (board.fetch, no `today`
// override) always stamps the real wall-clock date, and the (b) chat-vs-route parity test below
// asserts byte-for-byte equality against it — a fixed past date would silently drift out of sync
// the next time this suite runs on a later day.
const CAS_TODAY = `cas ${new Date().toISOString().slice(0, 10)}`;
const env: EnvProbe = { has: (n) => n === "GITHUB_TOKEN" };
const noGh: CliProbe = () => "not-found";

// ---------------------------------------------------------------------------
// (a) briefing: gates oldest-first, what unblocked, doctor warnings
// ---------------------------------------------------------------------------

function art(over: Partial<Artifact> & { id: string; kind: string; created: string }): Artifact {
  return {
    unit: "u",
    project: "p",
    status: "in-review",
    produced_by: "kestrel/lyra",
    consumes: [],
    supersedes: null,
    approved_by: null,
    files: [],
    ...over,
  };
}

function syntheticRepoWithGates(): Repo {
  const teams = new Map<string, Team>([
    ["kestrel", { name: "kestrel", consumes: [], produces: ["spec"], members: ["lyra"], flow: [], mode: "declarative", style: { color: "#000" }, charter: "", learnings: "" }],
  ]);
  const artifacts = new Map<string, Map<string, Artifact>>([
    [
      "p/u",
      new Map([
        ["mid", art({ id: "mid", kind: "spec", created: "2026-06-15" })],
        ["oldest", art({ id: "oldest", kind: "spec", created: "2026-06-01" })],
        ["newest", art({ id: "newest", kind: "spec", created: "2026-06-30" })],
      ]),
    ],
  ]);
  const units: WorkUnit[] = [{ type: "feature", status: "active", project: "p", unit: "u", dir: "/tmp/x" }];
  return { root: "/tmp/synthetic", teams, agents: new Map(), types: new Map(), projects: new Map(), connectors: new Map(), units, artifacts };
}

describe("(a) briefing derivation", () => {
  test("open gates are ordered oldest artifact first", () => {
    const b = buildBriefing(syntheticRepoWithGates(), env, noGh);
    expect(b.gates.map((g) => g.target)).toEqual(["oldest", "mid", "newest"]);
  });

  test("what unblocked: loyalty-flow's satisfied after: shows up as unblocked, not a plain gate", () => {
    const repo = loadRepo("fixtures/golden");
    const b = buildBriefing(repo, env, noGh);
    expect(b.unblocked.map((g) => g.unit)).toContain("loyalty-flow");
    expect(b.gates.some((g) => g.unit === "loyalty-flow")).toBe(false);
    expect(b.text).toContain("loyalty-flow");
  });

  test("doctor warnings surface the fixture's missing-env connector (linear), github is not a warning", () => {
    const repo = loadRepo("fixtures/golden");
    const b = buildBriefing(repo, env, noGh);
    expect(b.warnings.map((w) => w.name)).toEqual(["linear"]);
    expect(b.text).toContain("linear missing-env");
  });

  test("the fixture's open spec gate is present, oldest (only) artifact gate", () => {
    const repo = loadRepo("fixtures/golden");
    const b = buildBriefing(repo, env, noGh);
    expect(b.gates.map((g) => g.target)).toEqual(["spec-checkout-flow-v1"]);
  });
});

// ---------------------------------------------------------------------------
// (b) chat "approve" round-trips to the identical mutation/commit as POST /gates (ruling C7)
// ---------------------------------------------------------------------------

describe("(b) one gate-resolution path: chat vs POST /gates", () => {
  test("approving via chat produces the same file mutation and commit shape as the board route", async () => {
    const viaChat = seedScratchRepo();
    const viaRoute = seedScratchRepo();
    try {
      const chatResult = await handle("approve spec-checkout-flow-v1", { root: viaChat, by: CAS_TODAY });
      expect(chatResult.result && "ok" in chatResult.result && chatResult.result.ok).toBe(true);

      const board = createBoard(viaRoute);
      const res = await board.fetch(new Request("http://localhost/gates/storefront/spec-checkout-flow-v1/approve", { method: "POST" }));
      board.close();
      expect(res.status).toBe(200);

      const chatFile = readFileSync(join(viaChat, "work/storefront/checkout-flow/spec-checkout-flow-v1.md"), "utf8");
      const routeFile = readFileSync(join(viaRoute, "work/storefront/checkout-flow/spec-checkout-flow-v1.md"), "utf8");
      expect(chatFile).toBe(routeFile);
      expect(chatFile).toContain("status: approved");
      expect(chatFile).toMatch(/approved_by: "cas \d{4}-\d{2}-\d{2}"/);

      const chatLog = spawnSync("git", ["-C", viaChat, "log", "-1", "--format=%an|%ae|%s"], { encoding: "utf8" }).stdout.trim();
      const routeLog = spawnSync("git", ["-C", viaRoute, "log", "-1", "--format=%an|%ae|%s"], { encoding: "utf8" }).stdout.trim();
      expect(chatLog).toBe(routeLog);
      expect(chatLog).toContain("cas|cas@levare.local|approve spec-checkout-flow-v1");
    } finally {
      rmSync(viaChat, { recursive: true, force: true });
      rmSync(viaRoute, { recursive: true, force: true });
    }
  });

  test("chat locates the project automatically from the artifact id (no project param needed)", () => {
    const root = seedScratchRepo();
    try {
      expect(locateProjectForTarget(loadRepo(root), "spec-checkout-flow-v1")).toBe("storefront");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a chat gate-decision on an unknown target replies without touching the repo", async () => {
    const root = seedScratchRepo();
    try {
      const before = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
      const r = await handle("approve does-not-exist", { root, by: CAS_TODAY });
      expect(r.result).toBeNull();
      const after = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
      expect(after).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// (c) retro proposal renders as a gate awaiting the Conductor, never a direct LEARNINGS.md write
// ---------------------------------------------------------------------------

describe("(c) retro / knowledge-promotion proposals are gates, not direct writes", () => {
  test("proposeRetro never touches LEARNINGS.md; it returns a gate-shaped proposal", () => {
    const root = seedScratchRepo();
    try {
      const learningsFile = join(root, "teams/kestrel.learnings.md");
      const before = readFileSync(learningsFile, "utf8");
      const repo = loadRepo(root);
      const proposal = proposeRetro(repo, { team: "kestrel", unit: "checkout-flow", project: "storefront", text: "The loop converges faster when the review note names a field explicitly." });

      expect(proposal.kind).toBe("learnings");
      expect(proposal.verbs).toEqual(["approve", "reject"]);
      expect(proposal.targetFile).toBe("teams/kestrel.learnings.md");
      expect(readFileSync(learningsFile, "utf8")).toBe(before); // untouched by proposing
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("resolving the proposal with approve appends to LEARNINGS.md and commits; reject writes nothing", () => {
    const root = seedScratchRepo();
    try {
      const learningsFile = join(root, "teams/kestrel.learnings.md");
      const before = readFileSync(learningsFile, "utf8");
      const repo = loadRepo(root);
      const proposal = proposeRetro(repo, { team: "kestrel", unit: "checkout-flow", project: "storefront", text: "Name the idempotency field up front next time." });

      const rejected = resolveProposal(root, proposal, "reject", CAS_TODAY);
      expect(rejected.ok).toBe(true);
      expect(readFileSync(learningsFile, "utf8")).toBe(before);

      const approved = resolveProposal(root, proposal, "approve", CAS_TODAY);
      expect(approved.ok).toBe(true);
      const after = readFileSync(learningsFile, "utf8");
      expect(after).toContain("Name the idempotency field up front next time.");
      expect(after.startsWith(before)).toBe(true);
      if (approved.ok) {
        const log = spawnSync("git", ["-C", root, "log", "-1", "--format=%an|%s"], { encoding: "utf8" }).stdout.trim();
        expect(log).toContain("cas|retro: kestrel learnings");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a knowledge-promotion proposal writes to knowledge/ only on approve, and validates first", () => {
    const root = seedScratchRepo();
    try {
      const file = join(root, "knowledge/checkout-perf.md");
      const proposal = proposeKnowledgePromotion({ reportArtifactId: "report-checkout-perf-v1", project: "storefront", unit: "checkout-flow", knowledgeName: "checkout-perf", content: "Checkout p95 latency under 300ms is the bar." });
      expect(existsSync(file)).toBe(false);
      const result = resolveProposal(root, proposal, "approve", CAS_TODAY);
      expect(result.ok).toBe(true);
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file, "utf8")).toContain("Checkout p95 latency under 300ms is the bar.");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// (d) intent-to-unit operations produce the expected repo change
// ---------------------------------------------------------------------------

describe("(d) intent-to-unit operations", () => {
  test("open a unit of a given type creates work/<project>/<unit>/unit.md and commits", async () => {
    const root = seedScratchRepo();
    try {
      const r = await handle("open spike unit perf-spike in storefront", { root, by: CAS_TODAY });
      expect(r.result && "ok" in r.result && r.result.ok).toBe(true);
      const unitFile = join(root, "work/storefront/perf-spike/unit.md");
      expect(existsSync(unitFile)).toBe(true);
      expect(readFileSync(unitFile, "utf8")).toContain("type: spike");
      const status = spawnSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" }).stdout;
      expect(status.trim()).toBe(""); // committed, working tree clean
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("capture an idea writes ideas/<name>.md and commits", async () => {
    const root = seedScratchRepo();
    try {
      const r = await handle("capture idea: faster-checkout | Skip the confirmation step for repeat buyers. | storefront, speed", { root, by: CAS_TODAY });
      expect(r.result && "ok" in r.result && r.result.ok).toBe(true);
      const file = join(root, "ideas/faster-checkout.md");
      expect(existsSync(file)).toBe(true);
      const content = readFileSync(file, "utf8");
      expect(content).toContain("Skip the confirmation step for repeat buyers.");
      expect(content).toContain("tags: [storefront, speed]");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("promote idea → project opens an inception unit and removes the idea file, in one commit", () => {
    const root = seedScratchRepo();
    try {
      expect(existsSync(join(root, "ideas/loyalty-program.md"))).toBe(true);
      const r = promoteIdea({ root, idea: "loyalty-program", project: "storefront", unit: "loyalty-inception" });
      expect(r.ok).toBe(true);
      expect(existsSync(join(root, "ideas/loyalty-program.md"))).toBe(false);
      const unitFile = join(root, "work/storefront/loyalty-inception/unit.md");
      expect(existsSync(unitFile)).toBe(true);
      expect(readFileSync(unitFile, "utf8")).toContain("type: inception");
      if (r.ok) expect(r.commit.length).toBe(40);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("openUnit refuses to clobber an existing unit directory", () => {
    const root = seedScratchRepo();
    try {
      const r = openUnit({ root, project: "storefront", unit: "checkout-flow", type: "feature", body: "dup" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.status).toBe(409);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// stats (§8)
// ---------------------------------------------------------------------------

describe("stats", () => {
  test("computeStats derives from the golden fixture without instrumentation", () => {
    const repo = loadRepo("fixtures/golden");
    const s = computeStats(repo);
    expect(s.gatesOpen).toBeGreaterThan(0);
    expect(s.unitsShipped).toBe(1); // cart-icon-fix
    expect(typeof s.spendUsd).toBe("number");
  });

  test("a chat 'stats' message answers from the derived metrics", async () => {
    const root = seedScratchRepo();
    try {
      const r = await handle("stats", { root, by: CAS_TODAY });
      expect(r.intent.kind).toBe("stats");
      expect(r.reply).toMatch(/gate\(s\) open/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBoard } from "../src/board/serve.ts";
import { resolveGate } from "../src/board/gateops.ts";
import { runNewProjectSkill } from "../src/orchestrator.ts";
import { validatePath } from "../src/validate.ts";

// (e) new-project skill end-to-end, (f) `start` invokes the flow instead of 501, and the C2/C7 loop
// companion-approval rule applied through the board's single gate-resolution path.

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
  const root = mkdtempSync(join(tmpdir(), "levare-p5-"));
  cpSync("fixtures/golden", root, { recursive: true });
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "seed golden fixture"]);
  return root;
}

function req(url: string, init?: RequestInit): Request {
  return new Request(`http://localhost${url}`, init);
}

// ---------------------------------------------------------------------------
// (f) `start` invokes the flow rather than 501 (E5)
// ---------------------------------------------------------------------------

describe("(f) POST /gates/:project/:unit/start invokes the flow", () => {
  test("starting loyalty-flow's satisfied start gate produces the flow's first artifact, not a 501", async () => {
    const root = seedScratchRepo();
    try {
      const board = createBoard(root);
      const res = await board.fetch(req("/gates/storefront/loyalty-flow/start", { method: "POST" }));
      board.close();
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(typeof body.commit).toBe("string");
      expect(body.commit.length).toBe(40);

      // The team's flow opens with `step: brief`, resolved to wren's product-brief kind — a new
      // in-review artifact now sits in loyalty-flow's directory, forming the next gate (no bespoke
      // bookkeeping needed: files are the truth).
      const unitDir = join(root, "work/storefront/loyalty-flow");
      const files = readdirSync(unitDir).filter((f) => f !== "unit.md");
      expect(files.length).toBeGreaterThan(0);

      // Unit-scoped id (matching the spec-checkout-flow-v1 convention), NOT the stub boundary's raw
      // fixed id ("product-brief-v1") — that raw id already belongs to checkout-flow's own artifact
      // in the same project, and this test would otherwise collide with it under DUPLICATE_ID.
      expect(files).toEqual(["product-brief-loyalty-flow-v1.md"]);
      const produced = readFileSync(join(unitDir, files[0]), "utf8");
      expect(produced).toContain("kind: product-brief");
      expect(produced).toContain("id: product-brief-loyalty-flow-v1");
      expect(produced).toContain("status: in-review");
      expect(produced).toContain("unit: loyalty-flow");

      // Phase 8 gate-review fix (NOTES.md O6): the commit's CONTENT is entirely a member's own output
      // (wren's product brief) — the Conductor's start click made the invocation legal, but authorship
      // reflects who wrote the file, not who triggered the write, so this is the runner identity, not
      // the Conductor's.
      const log = spawnSync("git", ["-C", root, "log", "-1", "--format=%an|%ae|%s"], { encoding: "utf8" }).stdout.trim();
      expect(log).toContain("levare-runner|runner@levare.local|start loyalty-flow");

      // The whole repo — including checkout-flow's own, separately-created product-brief-v1 — still
      // validates: no DUPLICATE_ID between the two units' product-brief artifacts in "storefront".
      expect(validatePath(root).ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("starting a second unit in the same project never collides on id with the first (DUPLICATE_ID regression)", async () => {
    const root = seedScratchRepo();
    try {
      // checkout-flow already has its own product-brief-v1 on disk (the static golden fixture).
      // loyalty-flow's `start` produces a SECOND product-brief artifact in the SAME project
      // ("storefront") via the same (member, kind) — wren:product-brief — the exact shape that
      // collided before this fix (both would-be ids were the stub's fixed "product-brief-v1").
      const board = createBoard(root);
      const res = await board.fetch(req("/gates/storefront/loyalty-flow/start", { method: "POST" }));
      board.close();
      expect(res.status).toBe(200);

      const checkoutBrief = readFileSync(join(root, "work/storefront/checkout-flow/product-brief-v1.md"), "utf8");
      const loyaltyBrief = readFileSync(join(root, "work/storefront/loyalty-flow/product-brief-loyalty-flow-v1.md"), "utf8");
      expect(checkoutBrief).toContain("id: product-brief-v1");
      expect(loyaltyBrief).toContain("id: product-brief-loyalty-flow-v1");

      // Both units' artifacts validate together, with no duplicate ids anywhere in the project.
      const result = validatePath(root);
      expect(result.errors.filter((e) => e.code === "DUPLICATE_ID")).toEqual([]);
      expect(result.ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("starting a unit whose after: is unmet is refused (409), not silently started", async () => {
    const root = seedScratchRepo();
    try {
      // Flip loyalty-flow back to an unmet after: by pointing it at a unit that hasn't shipped.
      const unitFile = join(root, "work/storefront/loyalty-flow/unit.md");
      writeFileSync(unitFile, readFileSync(unitFile, "utf8").replace("after: [cart-icon-fix]", "after: [checkout-flow]"));
      const board = createBoard(root);
      const res = await board.fetch(req("/gates/storefront/loyalty-flow/start", { method: "POST" }));
      board.close();
      expect(res.status).toBe(409);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// C2/C7: the loop companion-approval rule applies through the board's single resolution path too
// ---------------------------------------------------------------------------

const REVIEW_COMPANION = `---
kind: review
id: review-checkout-flow-v1
unit: checkout-flow
project: storefront
status: in-review
produced_by: kestrel/finch
consumes: [spec-checkout-flow-v1]
supersedes: null
approved_by: null
created: 2026-07-11
files: []
---

# Review — checkout-flow spec

Approved with one note: name the idempotency key column in the spec.
`;

describe("C2/C7: board approval of a loop-first artifact also resolves its live companion", () => {
  test("approving spec-checkout-flow-v1 also approves an in-review review-checkout-flow-v1, in one commit", () => {
    const root = seedScratchRepo();
    try {
      const reviewFile = join(root, "work/storefront/checkout-flow/review-checkout-flow-v1.md");
      writeFileSync(reviewFile, REVIEW_COMPANION);
      git(root, ["add", "-A"]);
      git(root, ["commit", "-q", "-m", "seed a live loop round's review artifact"]);

      const before = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
      const result = resolveGate(root, "storefront", "spec-checkout-flow-v1", "approve", { today: "2026-07-11" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.changedFiles).toContain(reviewFile);

      const specDoc = readFileSync(join(root, "work/storefront/checkout-flow/spec-checkout-flow-v1.md"), "utf8");
      expect(specDoc).toContain("status: approved");
      const reviewDoc = readFileSync(reviewFile, "utf8");
      expect(reviewDoc).toContain("status: approved");
      expect(reviewDoc).toMatch(/approved_by: "cas 2026-07-11"/);

      // Same commit — the companion is not a second, separate commit.
      const after = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
      expect(after).toBe(result.commit);
      const parents = spawnSync("git", ["-C", root, "log", "-1", "--format=%P"], { encoding: "utf8" }).stdout.trim().split(/\s+/);
      expect(parents.length).toBe(1); // one new commit on top of the seeded baseline, not two
      expect(before).not.toBe(after);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("without a live companion on disk (the ordinary golden fixture), approval touches only the target artifact", () => {
    const root = seedScratchRepo();
    try {
      const result = resolveGate(root, "storefront", "spec-checkout-flow-v1", "approve", { today: "2026-07-11" });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.changedFiles).toEqual([join(root, "work/storefront/checkout-flow/spec-checkout-flow-v1.md")]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// (e) new-project skill: end-to-end against a scratch git dir, never real GitHub
// ---------------------------------------------------------------------------

describe("(e) new-project skill", () => {
  test("creates the remote stand-in, clones it for real, writes the pointer, and commits", () => {
    const root = seedScratchRepo();
    const base = mkdtempSync(join(tmpdir(), "levare-newproj-"));
    const remoteDir = join(base, "loyalty.git");
    const cloneDir = join(base, "loyalty-checkout");
    try {
      // Stand-in for `gh repo create`: a bare local repo, never a real GitHub call.
      const init = spawnSync("git", ["init", "-q", "--bare", remoteDir]);
      expect(init.status).toBe(0);
      expect(existsSync(join(root, "projects/loyalty.md"))).toBe(false);

      const result = runNewProjectSkill({
        root,
        name: "loyalty",
        remoteDir,
        cloneDir,
        deploy: "https://loyalty.acme.dev",
        houseRules: "Keep the redemption flow under two taps.",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.commit.length).toBe(40);

      // The clone step was real, not mocked: an actual .git dir and working tree exist.
      expect(existsSync(join(cloneDir, ".git"))).toBe(true);
      expect(existsSync(join(cloneDir, "README.md"))).toBe(true);
      const cloneLog = spawnSync("git", ["-C", cloneDir, "log", "--oneline"], { encoding: "utf8" }).stdout.trim();
      expect(cloneLog).not.toBe("");

      const pointer = join(root, "projects/loyalty.md");
      const content = readFileSync(pointer, "utf8");
      expect(content).toContain("name: loyalty");
      expect(content).toContain(`repo: ${cloneDir}`);
      expect(content).toContain(`remote: ${remoteDir}`);
      expect(content).toContain("default_branch: main");
      expect(content).toContain("deploy: https://loyalty.acme.dev");
      expect(content).toContain("Keep the redemption flow under two taps.");

      const log = spawnSync("git", ["-C", root, "log", "-1", "--format=%an|%ae|%s"], { encoding: "utf8" }).stdout.trim();
      expect(log).toBe("cas|cas@levare.local|new-project loyalty");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("refuses to clobber an existing project pointer", () => {
    const root = seedScratchRepo();
    const base = mkdtempSync(join(tmpdir(), "levare-newproj-"));
    const remoteDir = join(base, "storefront.git");
    const cloneDir = join(base, "storefront-checkout");
    try {
      spawnSync("git", ["init", "-q", "--bare", remoteDir]);
      const result = runNewProjectSkill({ root, name: "storefront", remoteDir, cloneDir, deploy: null, houseRules: "n/a" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.status).toBe(409);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(base, { recursive: true, force: true });
    }
  });
});

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, cpSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBoard, isUnderFixtures } from "../src/board/serve.ts";

// Structural fix for the fixture-mutation incident (NOTES E14): a board pointed at a path under
// fixtures/ must be unable to run any write route at all, not merely "shouldn't be pointed there" as
// an operator rule. Demos and screenshots against a fixtures/ tree are then safe by construction —
// the mutating handler code never runs, the request is refused before dispatch.

const HERMETIC_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

function git(repoRoot: string, args: string[]): ReturnType<typeof spawnSync> {
  const r = spawnSync(
    "git",
    ["-C", repoRoot, "-c", "user.name=seed", "-c", "user.email=seed@levare.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "init.defaultBranch=main", ...args],
    { encoding: "utf8", env: HERMETIC_ENV },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}${r.stdout}`);
  return r;
}

function seedAt(root: string): string {
  mkdirSync(root, { recursive: true });
  cpSync("fixtures/golden", root, { recursive: true });
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "seed golden fixture"]);
  return root;
}

/** A scratch copy of the golden fixture reachable through a literal `fixtures/` path segment. */
function seedScratchFixturesRepo(): { root: string; base: string } {
  const base = mkdtempSync(join(tmpdir(), "levare-ro-"));
  return { root: seedAt(join(base, "fixtures", "golden")), base };
}

/** A scratch copy reachable through an ordinary (non-fixtures) path — a normal studio repo. */
function seedScratchStudioRepo(): string {
  const base = mkdtempSync(join(tmpdir(), "levare-studio-"));
  return seedAt(join(base, "storefront-studio"));
}

function req(url: string, init?: RequestInit): Request {
  return new Request(`http://localhost${url}`, init);
}

describe("isUnderFixtures", () => {
  test("detects a literal fixtures/ path segment, relative or absolute", () => {
    expect(isUnderFixtures("fixtures/golden")).toBe(true);
    expect(isUnderFixtures("./fixtures/golden")).toBe(true);
    expect(isUnderFixtures("/workspaces/levare/fixtures/golden")).toBe(true);
    expect(isUnderFixtures("/tmp/foo/fixtures/golden")).toBe(true);
  });

  test("does not false-positive on a path that merely contains the substring", () => {
    expect(isUnderFixtures("/tmp/my-fixtures-dir/golden")).toBe(false);
    expect(isUnderFixtures("/tmp/fixturesplus/golden")).toBe(false);
  });

  test("an ordinary studio repo path is not under fixtures/", () => {
    expect(isUnderFixtures("/tmp/storefront-studio")).toBe(false);
    expect(isUnderFixtures("work/storefront")).toBe(false);
  });
});

describe("levare serve — read-only by default under fixtures/", () => {
  let root: string;
  let base: string;
  let board: ReturnType<typeof createBoard>;

  beforeAll(() => {
    ({ root, base } = seedScratchFixturesRepo());
    board = createBoard(root); // no explicit readOnly — must default from the path
  });
  afterAll(() => {
    board.close();
    rmSync(base, { recursive: true, force: true });
  });

  test("the board reports itself read-only", () => {
    expect(board.ctx.readOnly).toBe(true);
  });

  test("a gate POST against a fixture path is refused (405), and nothing on disk changes", () => {
    const artifactPath = join(root, "work/storefront/checkout-flow/spec-checkout-flow-v1.md");
    const before = readFileSync(artifactPath, "utf8");
    expect(before).toContain("status: in-review");

    const res = board.fetch(
      req("/gates/storefront/spec-checkout-flow-v1/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note: "should never land" }),
      }),
    );
    return res.then(async (r) => {
      expect(r.status).toBe(405);
      const body = await r.json();
      expect(body.ok).toBe(false);
      expect(body.error).toContain("read-only");
      expect(readFileSync(artifactPath, "utf8")).toBe(before); // byte-for-byte untouched
    });
  });

  test("the registry write route is refused too", async () => {
    const res = await board.fetch(
      req("/registry/knowledge/house-style.md", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "---\nname: house-style\n---\nshould never land\n" }),
      }),
    );
    expect(res.status).toBe(405);
  });

  test("the orchestrator route is refused too — read-only means all three write routes, not just gates", async () => {
    const res = await board.fetch(req("/orchestrator/message", { method: "POST", body: JSON.stringify({ text: "hi" }) }));
    expect(res.status).toBe(405);
  });

  test("GET routes are unaffected — read-only disables writes, not reads", async () => {
    const res = await board.fetch(req("/studio"));
    expect(res.status).toBe(200);
  });
});

describe("levare serve — write-enabled by default on a normal studio repo path", () => {
  let root: string;
  let board: ReturnType<typeof createBoard>;

  beforeAll(() => {
    root = seedScratchStudioRepo();
    board = createBoard(root);
  });
  afterAll(() => {
    board.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("the board reports itself write-enabled", () => {
    expect(board.ctx.readOnly).toBe(false);
  });

  test("the same approve POST that a fixtures/ path refuses succeeds here", async () => {
    const res = await board.fetch(
      req("/gates/storefront/spec-checkout-flow-v1/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note: "fine here" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    const artifactPath = join(root, "work/storefront/checkout-flow/spec-checkout-flow-v1.md");
    expect(readFileSync(artifactPath, "utf8")).toContain("status: approved");
  });
});

describe("levare serve — --read-only forces read-only on any path, fixtures/ or not", () => {
  test("an ordinary studio repo path can still be forced read-only explicitly", async () => {
    const root = seedScratchStudioRepo();
    const board = createBoard(root, { readOnly: true });
    try {
      expect(board.ctx.readOnly).toBe(true);
      const res = await board.fetch(req("/gates/storefront/spec-checkout-flow-v1/approve", { method: "POST" }));
      expect(res.status).toBe(405);
    } finally {
      board.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

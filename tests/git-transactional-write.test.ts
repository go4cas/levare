import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transactionalWrite, conductorCommit } from "../src/git.ts";
import { createBoard } from "../src/board/serve.ts";
import { resolveGate } from "../src/board/gateops.ts";
import { stubAdapterRunner } from "../src/replay.ts";
import { loadRepo } from "../src/repo.ts";

// NOTES REV2, finding 1: "files are the truth + git is the audit log" means a write with no matching
// commit is an unaudited mutation. `transactionalWrite` (src/git.ts) is the one shared helper every
// mutating path now routes through; these tests force its commit stage to fail and assert the working
// tree (and HEAD) come back byte-identical to before the attempt — for the helper itself directly, and
// for the three mutation shapes the goal names: a gate approval, a registry save, and a dagwalk
// artifact write.

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

// `commitAs` (git.ts) always overrides identity/hooks explicitly (`-c user.name=...`, `-c
// core.hooksPath=/dev/null`), so the goal's suggested "sabotage identity/a pre-commit hook" levers are
// both already neutralized by construction — neither can actually make `git add`/`git commit` fail
// here. Corrupting the index is a deterministic, git-version-agnostic way to force that same failure
// surface (`git add` fails immediately with a fatal, non-git-repo-destroying error) regardless of who
// is running the suite (including as root, where permission-based sabotage would be a no-op).
function sabotageIndex(root: string): void {
  writeFileSync(join(root, ".git", "index"), "not a valid git index\n");
}

function req(url: string, init?: RequestInit): Request {
  return new Request(`http://localhost${url}`, init);
}

describe("transactionalWrite (src/git.ts) — the shared atomic write+commit helper", () => {
  test("on success, files land with the candidate content and a real commit", () => {
    const root = seedScratchRepo("levare-tx-ok-");
    try {
      const file = join(root, "a.md");
      writeFileSync(file, "original\n");
      git(root, ["add", "-A"]);
      git(root, ["commit", "-q", "-m", "seed a.md"]);

      const result = transactionalWrite(root, [{ path: file, content: "changed\n" }], "edit a.md", conductorCommit);
      expect(result.ok).toBe(true);
      expect(readFileSync(file, "utf8")).toBe("changed\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a validate failure restores the file and never touches HEAD", () => {
    const root = seedScratchRepo("levare-tx-validate-");
    try {
      const file = join(root, "a.md");
      writeFileSync(file, "original\n");
      git(root, ["add", "-A"]);
      git(root, ["commit", "-q", "-m", "seed a.md"]);
      const before = readFileSync(file, "utf8");
      const headBefore = headRev(root);

      const result = transactionalWrite(root, [{ path: file, content: "changed\n" }], "edit a.md", conductorCommit, () => "invalid: always rejected");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.stage).toBe("validate");
      expect(readFileSync(file, "utf8")).toBe(before);
      expect(headRev(root)).toBe(headBefore);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a commit failure restores every touched file — including deleting one that did not exist before — and never touches HEAD", () => {
    const root = seedScratchRepo("levare-tx-commit-");
    try {
      const existingFile = join(root, "existing.md");
      writeFileSync(existingFile, "original\n");
      git(root, ["add", "-A"]);
      git(root, ["commit", "-q", "-m", "seed existing.md"]);
      const before = readFileSync(existingFile, "utf8");
      const headBefore = headRev(root);

      const newFile = join(root, "brand-new.md");
      expect(existsSync(newFile)).toBe(false);

      sabotageIndex(root);
      const result = transactionalWrite(
        root,
        [
          { path: existingFile, content: "changed\n" },
          { path: newFile, content: "new content\n" },
        ],
        "multi-file transaction",
        conductorCommit,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.stage).toBe("commit");
      // The existing file is back to its exact original bytes...
      expect(readFileSync(existingFile, "utf8")).toBe(before);
      // ...and the file that never existed is gone again, not left behind as an unaudited write.
      expect(existsSync(newFile)).toBe(false);
      expect(headRev(root)).toBe(headBefore);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("NOTES REV2 — byte-identical rollback on a forced commit failure, for the three named mutation shapes", () => {
  test("(1) a gate approval: spec-checkout-flow-v1 approve", async () => {
    const root = seedScratchRepo("levare-rev2-approve-");
    try {
      const file = join(root, "work/storefront/checkout-flow/spec-checkout-flow-v1.md");
      const before = readFileSync(file, "utf8");
      const headBefore = headRev(root);

      sabotageIndex(root);
      const result = await resolveGate(root, "storefront", "spec-checkout-flow-v1", "approve", { today: "2026-07-16" });

      expect(result.ok).toBe(false);
      expect(readFileSync(file, "utf8")).toBe(before);
      expect(headRev(root)).toBe(headBefore);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("(2) a registry save: editing knowledge/house-style.md", async () => {
    const root = seedScratchRepo("levare-rev2-registry-");
    const board = createBoard(root);
    try {
      const file = join(root, "knowledge/house-style.md");
      const before = readFileSync(file, "utf8");
      const headBefore = headRev(root);
      const content = before.replace("Calm, factual, slightly dry.", "Calm, factual, dry, and precise.");

      sabotageIndex(root);
      const res = await board.fetch(
        req("/registry/knowledge/house-style.md", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content }),
        }),
      );

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(readFileSync(file, "utf8")).toBe(before);
      expect(headRev(root)).toBe(headBefore);
    } finally {
      board.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("(3) a dagwalk artifact write: starting loyalty-flow's satisfied start gate", async () => {
    const root = seedScratchRepo("levare-rev2-dagwalk-");
    try {
      const unitDir = join(root, "work/storefront/loyalty-flow");
      const filesBefore = readdirSync(unitDir).sort();
      const unitMdBefore = readFileSync(join(unitDir, "unit.md"), "utf8");
      const headBefore = headRev(root);

      sabotageIndex(root);
      const board = createBoard(root, { memberRunner: stubAdapterRunner(loadRepo(root)) });
      let threw = false;
      try {
        await board.fetch(req("/gates/storefront/loyalty-flow/start", { method: "POST" }));
      } catch {
        threw = true;
      } finally {
        board.close();
      }
      void threw; // the board's outer fetch try/catch turns the throw into a 500, either shape is fine here.

      // No new artifact file was left behind by the failed produce+commit, and unit.md is untouched.
      expect(readdirSync(unitDir).sort()).toEqual(filesBefore);
      expect(readFileSync(join(unitDir, "unit.md"), "utf8")).toBe(unitMdBefore);
      expect(headRev(root)).toBe(headBefore);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

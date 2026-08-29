import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, cpSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { assertSpawnOk, assertExitCode, spawnStdout } from "./spawn-helpers.ts";
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
  assertSpawnOk(`git ${args.join(" ")}`, r);
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
  return spawnStdout("git rev-parse HEAD", spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" })).trim();
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

// NOTES CAP-B-FIX closed this gap as hardening ("Reproduction: not achieved... No test in the current
// suite was found to actually set those four vars, so this is not confirmed as the live mechanism...
// but it is a real, currently-unguarded gap") — `commitAs` was given a HERMETIC_GIT_ENV that unsets
// GIT_AUTHOR_NAME/GIT_AUTHOR_EMAIL/GIT_COMMITTER_NAME/GIT_COMMITTER_EMAIL unconditionally, but never
// got the confirming test that entry's own text asked for. NOTES "runner-authored-commit audit" found
// why a straightforward attempt (mutate `process.env` in this test's own process, then call
// `conductorCommit`) could never have caught a regression here even if one existed: Bun's `spawnSync`,
// when its `env` option is omitted, inherits the PARENT PROCESS'S OWN startup environment, not a later
// runtime mutation to `process.env` — confirmed directly (a `process.env.GIT_AUTHOR_NAME = "x"`
// mutation right before an omitted-env `spawnSync` call is invisible to the child). A real subprocess,
// with the four vars set as ITS OWN startup env, is the only way to actually exercise this.
describe("commitAs's identity override survives a startup-environment GIT_AUTHOR_NAME/EMAIL leak (closes NOTES CAP-B-FIX's own open question)", () => {
  test("conductorCommit records the Conductor's identity, not a leaked GIT_AUTHOR_NAME/EMAIL present at process startup", () => {
    const root = seedScratchRepo("levare-capbfix-leak-");
    const driver = join(tmpdir(), `levare-capbfix-driver-${Math.random().toString(36).slice(2)}.ts`);
    try {
      writeFileSync(
        driver,
        [
          `import { conductorCommit } from ${JSON.stringify(join(process.cwd(), "src/git.ts"))};`,
          `import { writeFileSync } from "node:fs";`,
          `import { join } from "node:path";`,
          `const root = ${JSON.stringify(root)};`,
          `writeFileSync(join(root, "leak-probe.md"), "probe\\n");`,
          `conductorCommit(root, [join(root, "leak-probe.md")], "leak probe commit");`,
        ].join("\n"),
      );
      const leakEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: "ambient-leak",
        GIT_AUTHOR_EMAIL: "leak@example.com",
        GIT_COMMITTER_NAME: "ambient-leak",
        GIT_COMMITTER_EMAIL: "leak@example.com",
      };
      const run = spawnSync("bun", ["run", driver], { encoding: "utf8", env: leakEnv });
      assertExitCode("bun run driver.ts (leak-env)", run, 0);

      const author = spawnStdout("git log -1 (leak-env)", spawnSync("git", ["-C", root, "log", "-1", "--format=%an|%ae"], { encoding: "utf8" })).trim();
      expect(author).toBe("cas|cas@levare.local");
      expect(author).not.toContain("ambient-leak");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(driver, { force: true });
    }
  });
});

// Finding 142 (git-config family sweep, sibling of Finding 120/144): ruled NOT a defect — `commitAs`
// commits into the studio's own repo on levare's own behalf (gate approvals, registry edits), not into
// an operator-owned project the way Finding 120's member dispatch does, so there is no "operator's own
// config" for `core.excludesFile`/`core.attributesFile` to honor here. This asserts the ruling holds in
// code, not just in a comment: a `conductorCommit` must succeed and land content untransformed even when
// the operator's global config would, if honored, either refuse the explicit add (excludesFile matching
// the target path) or rewrite its bytes (an attributesFile filter) — see git.ts#commitAs's own doc.
describe("Finding 142 — commitAs stays hermetic to the operator's global excludesFile/attributesFile", () => {
  test("a path matching the operator's global core.excludesFile still commits normally via conductorCommit", () => {
    const root = seedScratchRepo("levare-f142-excludes-");
    const fakeHome = mkdtempSync(join(tmpdir(), "levare-f142-home-"));
    const realHome = process.env.HOME;
    try {
      mkdirSync(join(fakeHome, ".config", "git"), { recursive: true });
      writeFileSync(join(fakeHome, ".config", "git", "ignore"), "*.md\n");
      process.env.HOME = fakeHome;

      const file = join(root, "gate-note.md");
      writeFileSync(file, "approved\n");
      const result = transactionalWrite(root, [{ path: file, content: "approved\n" }], "approve gate", conductorCommit);
      expect(result.ok).toBe(true);
      expect(readFileSync(file, "utf8")).toBe("approved\n");
    } finally {
      process.env.HOME = realHome;
      rmSync(fakeHome, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a filter from the operator's global core.attributesFile never transforms a conductorCommit's content", () => {
    const root = seedScratchRepo("levare-f142-attrs-");
    const fakeHome = mkdtempSync(join(tmpdir(), "levare-f142-home-attrs-"));
    const realHome = process.env.HOME;
    try {
      mkdirSync(join(fakeHome, ".config", "git"), { recursive: true });
      writeFileSync(join(fakeHome, ".config", "git", "attributes"), "*.shout filter=shout\n");
      process.env.HOME = fakeHome;
      git(root, ["config", "filter.shout.clean", "tr a-z A-Z"]);
      git(root, ["config", "filter.shout.smudge", "cat"]);

      const file = join(root, "loud.shout");
      writeFileSync(file, "hello world\n");
      const result = transactionalWrite(root, [{ path: file, content: "hello world\n" }], "approve gate", conductorCommit);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const stored = spawnStdout("git show", spawnSync("git", ["-C", root, "show", `${result.commit}:loud.shout`], { encoding: "utf8" }));
      expect(stored).toBe("hello world\n");
    } finally {
      process.env.HOME = realHome;
      rmSync(fakeHome, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});

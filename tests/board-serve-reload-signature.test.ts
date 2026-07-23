import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBoard, computeChangeSignature, isRelevantWatchPath } from "../src/board/serve.ts";

// Reload storm fix (NOTES UI-PHASE2 addendum): a recursive fs.watch on the studio root previously
// broadcast "reload" on ANY filesystem event under root, including `.git/*` churn (index.lock, refs,
// logs — all touched constantly by ordinary `git` use, whether from a human, the daemon, or a
// background `git status`). With one connected client that meant a same-URL refetch every time git so
// much as looked at its own index — observed live as ~4 refetches/sec, indefinitely, on an otherwise
// idle page. Two independent layers fix it: `isRelevantWatchPath` scopes which raw fs events are even
// allowed to schedule a debounced check, and `computeChangeSignature` makes the eventual broadcast
// itself conditional on the content actually having changed, regardless of how many — or how few —
// raw events preceded it.

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

function seedScratchRepo(prefix = "levare-reload-sig-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  cpSync("fixtures/golden", root, { recursive: true });
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "seed golden fixture"]);
  return root;
}

describe("isRelevantWatchPath — scoping layer", () => {
  test("discards .git/* churn", () => {
    expect(isRelevantWatchPath(".git/index.lock")).toBe(false);
    expect(isRelevantWatchPath(".git/logs/HEAD")).toBe(false);
    expect(isRelevantWatchPath(".git/refs/heads/main")).toBe(false);
  });

  test("keeps paths under the directories a rendered page is actually derived from", () => {
    expect(isRelevantWatchPath("work/storefront/checkout-flow/unit.md")).toBe(true);
    expect(isRelevantWatchPath("teams/core.md")).toBe(true);
    expect(isRelevantWatchPath("skills/new-project/SKILL.md")).toBe(true);
    expect(isRelevantWatchPath("studio.md")).toBe(true);
  });

  test("discards paths outside both the registry-editable dirs and work/", () => {
    expect(isRelevantWatchPath(".DS_Store")).toBe(false);
    expect(isRelevantWatchPath("node_modules/foo/index.js")).toBe(false);
  });

  test("a null filename (platform doesn't report one) is NOT scoped out — falls through to the signature check", () => {
    expect(isRelevantWatchPath(null)).toBe(true);
  });
});

describe("computeChangeSignature — belt-and-braces broadcast guard", () => {
  let root: string;
  beforeAll(() => {
    root = seedScratchRepo();
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("is stable across repeated calls when nothing has changed", () => {
    expect(computeChangeSignature(root)).toBe(computeChangeSignature(root));
  });

  test("changes when a real content file (under work/) is edited", () => {
    const before = computeChangeSignature(root);
    const unitPath = join(root, "work/storefront/checkout-flow/unit.md");
    writeFileSync(unitPath, readFileSync(unitPath, "utf8") + "\n");
    const after = computeChangeSignature(root);
    expect(after).not.toBe(before);
  });

  test("is UNCHANGED by writes under .git/ — git churn is not content the pages read", () => {
    const before = computeChangeSignature(root);
    // Simulate the steady .git/* trickle: index.lock, refs, logs — none of it is a directory the
    // signature walks, so touching it must never move the signature.
    mkdirSync(join(root, ".git", "levare-churn-probe"), { recursive: true });
    writeFileSync(join(root, ".git", "levare-churn-probe", "index.lock"), "churn");
    writeFileSync(join(root, ".git", "levare-churn-probe", "index.lock"), "more churn");
    const after = computeChangeSignature(root);
    expect(after).toBe(before);
  });
});

function req(url: string, init?: RequestInit): Request {
  return new Request(`http://localhost${url}`, init);
}

describe("levare serve — reload storm regression", () => {
  test("sustained .git churn produces ZERO reload broadcasts; a real content change produces exactly ONE", async () => {
    const root = seedScratchRepo();
    const board = createBoard(root);
    try {
      const res = await board.fetch(req("/events"));
      const reader = res.body!.getReader();
      await reader.read(); // drain ": connected"

      let reloadCount = 0;
      let stopReading = false;
      const readLoop = (async () => {
        while (!stopReading) {
          const { value, done } = await reader.read();
          if (done) break;
          const chunk = new TextDecoder().decode(value);
          if (chunk.includes("data: reload")) reloadCount++;
        }
      })();

      // Idle phase: hammer .git with the same kind of churn a live index/refs/logs update produces —
      // no real page content changes at all. This is the exact reproduction of the reported storm.
      const deadline = Date.now() + 1500;
      let i = 0;
      while (Date.now() < deadline) {
        writeFileSync(join(root, ".git", "levare-churn-probe"), `churn-${i++}`);
        await new Promise((r) => setTimeout(r, 20));
      }
      // Let any (wrongly) scheduled debounce settle before asserting silence.
      await new Promise((r) => setTimeout(r, 200));
      expect(reloadCount).toBe(0);

      // Now a REAL content change — must produce exactly one reload.
      const unitPath = join(root, "work/storefront/checkout-flow/unit.md");
      writeFileSync(unitPath, readFileSync(unitPath, "utf8") + "\n");
      await new Promise((r) => setTimeout(r, 500));

      stopReading = true;
      reader.cancel().catch(() => {});
      await readLoop;

      expect(reloadCount).toBe(1);
    } finally {
      board.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 10000);
});

import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { assertSpawnOk } from "./spawn-helpers.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGate } from "../src/board/gateops.ts";
import { validatePath } from "../src/validate.ts";

// Finding 165: reject terminates the unit. This covers the `levare validate` half of the fix — a
// studio written before this ruling (or hand-repaired) can carry `status: rejected` on an artifact
// while `unit.md` says something else. That mismatch is now a real validation error, not a silent
// stale state — with no auto-repair: an operator with an already-rejected artifact edits `unit.md`'s
// `status:` to `rejected` by hand, the same one-line fix `doReject` now makes atomically going forward.

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

function seedGoldenScratch(): string {
  const root = mkdtempSync(join(tmpdir(), "levare-f165-validate-golden-"));
  cpSync("fixtures/golden", root, { recursive: true });
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "seed golden fixture"]);
  return root;
}

describe("Finding 165: levare validate flags a rejected artifact whose unit isn't marked terminal", () => {
  test("clean once reject has patched unit.md through doReject", async () => {
    const root = seedGoldenScratch();
    try {
      await resolveGate(root, "storefront", "spec-checkout-flow-v1", "reject", { today: "2026-07-12" });
      const result = validatePath(root);
      expect(result.errors.find((e) => e.code === "REJECTED_ARTIFACT_UNIT_NOT_TERMINATED")).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("flags the exact pre-fix inconsistency: artifact rejected, unit.md left active", async () => {
    const root = seedGoldenScratch();
    try {
      const unitDir = join(root, "work/storefront/checkout-flow");
      const specFile = join(unitDir, "spec-checkout-flow-v1.md");
      const rejected = readFileSync(specFile, "utf8").replace("status: in-review", "status: rejected");
      writeFileSync(specFile, rejected);
      // unit.md deliberately left at `status: active` — the exact shape this Finding was raised
      // against (the artifact resolved, the unit never recorded that its work was over).
      expect(existsSync(unitDir)).toBe(true);

      const result = validatePath(root);
      const err = result.errors.find((e) => e.code === "REJECTED_ARTIFACT_UNIT_NOT_TERMINATED");
      expect(err).toBeDefined();
      expect(err?.message).toContain("spec-checkout-flow-v1");
      expect(err?.message).toContain("active");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

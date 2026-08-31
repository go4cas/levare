import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, cpSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { assertSpawnOk } from "./spawn-helpers.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGate } from "../src/board/gateops.ts";
import { loadRepo } from "../src/repo.ts";
import { advanceUnit } from "../src/dagwalk.ts";
import { stubAdapterRunner } from "../src/replay.ts";
import { openGates } from "../src/derive.ts";
import { fromWorkUnitStatus } from "../src/board/status.ts";

// Finding 165: rejecting an artifact used to leave `unit.md` untouched — the artifact said `rejected`,
// forever a dead end (nothing ever supersedes it), while the unit itself stayed `active` and every
// render surface kept treating it as live. Reject is now terminal for the unit, exactly like a
// merge-gate approval closes it to `shipped` (doApproveMerge's own precedent, same `patchFrontmatter`
// mechanism, same transaction).

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
  const root = mkdtempSync(join(tmpdir(), "levare-f165-golden-"));
  cpSync("fixtures/golden", root, { recursive: true });
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "seed golden fixture"]);
  return root;
}

describe("Finding 165: reject terminates the unit", () => {
  test("rejecting an open gate's artifact patches unit.md to status: rejected in the same commit", async () => {
    const root = seedGoldenScratch();
    try {
      const unitDir = join(root, "work/storefront/checkout-flow");
      // fixtures/golden's checkout-flow ships with spec-checkout-flow-v1 sitting in-review — a plain
      // open gate, no loop/companion involved.
      const before = readFileSync(join(unitDir, "unit.md"), "utf8");
      expect(before).toContain("status: active");

      const result = await resolveGate(root, "storefront", "spec-checkout-flow-v1", "reject", { today: "2026-07-12" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Both files land in the one resolution commit — mirrors doApproveMerge's own two-file pattern.
      expect(result.changedFiles.some((f) => f.endsWith("unit.md"))).toBe(true);
      expect(result.changedFiles.some((f) => f.endsWith("spec-checkout-flow-v1.md"))).toBe(true);

      const spec = readFileSync(join(unitDir, "spec-checkout-flow-v1.md"), "utf8");
      expect(spec).toContain("status: rejected");
      const unitAfter = readFileSync(join(unitDir, "unit.md"), "utf8");
      expect(unitAfter).toContain("status: rejected");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the daemon's walk skips a rejected unit exactly as it already skips a shipped one", async () => {
    const root = seedGoldenScratch();
    try {
      await resolveGate(root, "storefront", "spec-checkout-flow-v1", "reject", { today: "2026-07-12" });
      const repo = loadRepo(root);
      const unit = repo.units.find((u) => u.project === "storefront" && u.unit === "checkout-flow")!;
      expect(unit.status).toBe("rejected");

      const outcome = await advanceUnit(root, repo, unit, stubAdapterRunner(repo));
      expect(outcome).toEqual({ outcome: "nothing" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a rejected unit carries no open gate — openGates and the run-page briefing agree it's over", async () => {
    const root = seedGoldenScratch();
    try {
      await resolveGate(root, "storefront", "spec-checkout-flow-v1", "reject", { today: "2026-07-12" });
      const repo = loadRepo(root);
      const gates = openGates(repo).filter((g) => g.unit === "checkout-flow");
      expect(gates).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fromWorkUnitStatus maps a rejected unit into the canonical 'failed' palette entry", () => {
    expect(fromWorkUnitStatus("rejected")).toBe("failed");
  });
});

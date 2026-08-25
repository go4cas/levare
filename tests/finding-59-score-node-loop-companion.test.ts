import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { assertSpawnOk } from "./spawn-helpers.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cpSync } from "node:fs";
import { Daemon } from "../src/daemon.ts";
import { resolveGate } from "../src/board/gateops.ts";
import { stubAdapterRunner } from "../src/replay.ts";
import { loadRepo } from "../src/repo.ts";
import { scoreNodes } from "../src/derive.ts";
import { renderRun } from "../src/board/render/run.ts";
import type { Verb } from "../src/runner.ts";

// Finding 59: at a loop's review gate, the score rail showed "needs you" on BOTH the loop's real gate
// (the artifact the loop's `until` names) and its companion (already produced, already consumed by
// the round's other side) — two "act now" signals for one actual decision. loyalty-flow's kestrel
// loop (spec/review, until: spec.approved — fixtures/golden/teams/kestrel.md) reproduces it the same
// way tests/f20-loop-exhaustion.test.ts's own non-exhausted-round scenario does: mid-round, both
// spec-loyalty-flow-v1 (the real gate) and review-loyalty-flow-v1 (the companion) sit at in-review
// simultaneously (dagwalk.ts#nextAction).

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
  const root = mkdtempSync(join(tmpdir(), "levare-finding59-"));
  cpSync("fixtures/golden", root, { recursive: true });
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "seed golden fixture"]);
  return root;
}

/** Drives loyalty-flow to mid-round-1 of its spec/review loop — both artifacts in-review, neither
 * resolved. Verbatim the same walk as f20-loop-exhaustion.test.ts's "non-exhausted round" scenario. */
async function driveToOpenLoopRound(root: string): Promise<void> {
  const runner = stubAdapterRunner(loadRepo(root));
  const daemon = new Daemon(root, { memberRunner: () => runner });
  await resolveGate(root, "storefront", "loyalty-flow", "start", { memberRunner: runner, today: "2026-07-12" });
  await resolveGate(root, "storefront", "product-brief-loyalty-flow-v1", "approve" as Verb, { today: "2026-07-12" });
  await daemon.tick(); // design
  await resolveGate(root, "storefront", "design-loyalty-flow-v1", "approve" as Verb, { today: "2026-07-12" });
  await daemon.tick(); // spec round 1
  await daemon.tick(); // review round 1
}

describe("Finding 59: a loop's companion turn is not a second open gate", () => {
  test("scoreNodes marks only the loop's real gate (until-named kind) as needing a decision", async () => {
    const root = seedGoldenScratch();
    try {
      await driveToOpenLoopRound(root);
      const repo = loadRepo(root, { validate: false });
      const unit = repo.units.find((u) => u.project === "storefront" && u.unit === "loyalty-flow")!;
      const nodes = scoreNodes(repo, unit);

      const specNode = nodes.find((n) => n.kind === "spec")!;
      const reviewNode = nodes.find((n) => n.kind === "review")!;

      // Both are genuinely in-review — both stay "gate" (state alone doesn't distinguish them,
      // ruling C2 still holds for the round as a whole).
      expect(specNode.state).toBe("gate");
      expect(reviewNode.state).toBe("gate");

      // `spec` is the kind the loop's `until` names — it's the real, decision-bearing gate.
      expect(specNode.loopCompanion).toBeFalsy();
      // `review` ran and was consumed by the round; it is the companion, not a second decision.
      expect(reviewNode.loopCompanion).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the run view shows exactly one 'needs you' chip for the open round, not two", async () => {
    const root = seedGoldenScratch();
    try {
      await driveToOpenLoopRound(root);
      const repo = loadRepo(root, { validate: false });
      const html = renderRun(repo, "storefront", "loyalty-flow", root, new Date("2026-07-12T00:00:00Z"));

      const needsYouCount = (html.match(/>needs you</g) ?? []).length;
      expect(needsYouCount).toBe(1);
      // The companion's node still reads as informational, not an error or a warning.
      expect(html).toContain("under review");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

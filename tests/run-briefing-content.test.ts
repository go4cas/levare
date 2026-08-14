import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, cpSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRepo } from "../src/repo.ts";
import { renderRun } from "../src/board/render.ts";
import { openGates } from "../src/derive.ts";
import { advanceUnit } from "../src/dagwalk.ts";
import { resolveGate } from "../src/board/gateops.ts";
import { stubAdapterRunner } from "../src/replay.ts";
import type { AsyncMemberRunner } from "../src/dagwalk.ts";
import type { Verb } from "../src/runner.ts";
import type { OrchestratorStatus } from "../src/orchestrator-status.ts";

// The briefing sentence lives inside `briefingHtml`, which `orchestratorPanel` (render/shell.ts) only
// renders when the Orchestrator is available — an unavailable one (e.g. no ANTHROPIC_API_KEY in this
// test environment) shows a fixed "Orchestrator unavailable..." turn instead. Pin availability so
// every assertion below is actually exercising the briefing text, not the disabled-state branch.
const ON: OrchestratorStatus = { available: true, reason: "The Orchestrator is live.", envVar: "ANTHROPIC_API_KEY" };

// NOTES ORCH-STALE-CARD (content fault 2, independent of the propagation fix): the run view's
// Orchestrator briefing used to say "<kind> is ready for review below." for EVERY open gate on the
// unit, regardless of what state that gate was actually in. This exercises the real `renderRun` path
// (never `gateBriefingSentence` in isolation) so the fix is proven against the same render function
// the product actually serves, for every gate shape a run page can carry.

const HERMETIC_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" };

function git(root: string, args: string[]) {
  const r = spawnSync(
    "git",
    ["-C", root, "-c", "user.name=seed", "-c", "user.email=seed@levare.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "init.defaultBranch=main", ...args],
    { encoding: "utf8", env: HERMETIC_ENV },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}${r.stdout}`);
  return r;
}

function seedScratchRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "levare-run-briefing-"));
  cpSync("fixtures/golden", root, { recursive: true });
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "seed golden fixture"]);
  return root;
}

const now = new Date("2026-07-12T00:00:00Z");

describe("run view briefing — states what's true about the gate it's actually reporting on", () => {
  test("an in-review artifact gate (fixtures/golden's checkout-flow spec) reads as ready for review", () => {
    const root = "fixtures/golden";
    const repo = loadRepo(root);
    expect(openGates(repo).find((g) => g.project === "storefront" && g.unit === "checkout-flow")?.type).toBe("artifact");
    const html = renderRun(repo, "storefront", "checkout-flow", root, now, [], ON);
    expect(html).toContain("spec is ready for review below.");
  });

  // The exact live-observed bug for a start gate: `gate.label` is the literal string "start", so the
  // old unconditional "<label> is ready for review below." rendered the nonsensical "start is ready
  // for review below." — a unit that has produced nothing yet has nothing to review.
  test("a start gate (fixtures/golden's loyalty-flow) reads as ready to START, never 'start is ready for review'", () => {
    const root = "fixtures/golden";
    const repo = loadRepo(root);
    expect(openGates(repo).find((g) => g.project === "storefront" && g.unit === "loyalty-flow")?.type).toBe("start");
    const html = renderRun(repo, "storefront", "loyalty-flow", root, now, [], ON);
    expect(html).toContain("This unit is ready to start below.");
    expect(html).not.toContain("start is ready for review");
  });

  // The exact case from live evidence: a blocked (failed) artifact's briefing announced it as ready
  // for review — "product-brief is ready for review below." with nothing to review, the member failed.
  test("a blocked (failed) artifact's briefing reports the failure, never 'ready for review'", async () => {
    const root = seedScratchRepo();
    try {
      await resolveGate(root, "storefront", "loyalty-flow", "start", { memberRunner: stubAdapterRunner(loadRepo(root)), today: "2026-07-12" });
      await resolveGate(root, "storefront", "product-brief-loyalty-flow-v1", "approve" as Verb, { today: "2026-07-12" });

      const failingRunner: AsyncMemberRunner = {
        capabilities: () => [
          { member: "wren", kind: "product-brief" },
          { member: "lyra", kind: "design" },
          { member: "lyra", kind: "spec" },
        ],
        produce: () => {
          throw new Error("simulated member timeout");
        },
      };
      const repo = loadRepo(root);
      const unit = repo.units.find((u) => u.unit === "loyalty-flow")!;
      const result = await advanceUnit(root, repo, unit, failingRunner, { today: "2026-07-12" });
      expect(result.outcome).toBe("blocked");

      const after = loadRepo(root, { validate: false });
      const gate = openGates(after).find((g) => g.project === "storefront" && g.unit === "loyalty-flow");
      expect(gate?.type).toBe("artifact-blocked");
      expect(gate?.label).toBe("design");

      const html = renderRun(after, "storefront", "loyalty-flow", root, now, [], ON);
      expect(html).toContain("design failed and needs your decision below.");
      expect(html).not.toContain("design is ready for review");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a unit with no open gate at all still reads honestly — never a fabricated 'ready' claim", () => {
    const root = "fixtures/golden";
    const repo = loadRepo(root);
    const noGateUnit = repo.units.find((u) => openGates(repo).every((g) => g.unit !== u.unit));
    expect(noGateUnit).toBeDefined();
    const html = renderRun(repo, noGateUnit!.project, noGateUnit!.unit, root, now, [], ON);
    expect(html).toContain("No open gate on this unit right now.");
  });
});

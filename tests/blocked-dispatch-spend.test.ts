import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, cpSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { assertSpawnOk } from "./spawn-helpers.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGate } from "../src/board/gateops.ts";
import { stubAdapterRunner } from "../src/replay.ts";
import { loadRepo } from "../src/repo.ts";
import { unitSpend } from "../src/derive.ts";
import { AdapterError } from "../src/adapters.ts";
import type { AsyncMemberRunner } from "../src/dagwalk.ts";
import type { Verb } from "../src/runner.ts";
import type { Receipt } from "../src/types.ts";

// Findings 162/95: a dispatch that produces no artifact must still cost something whenever the SDK
// reported a real receipt for the failed call. Mirrors f19-blocked-artifact-verbs.test.ts's own harness
// (same golden fixture, same blockLoyaltyFlowDesignWith shape) — this file is scoped to the NEW
// usage-on-blocked-artifact behavior, not Finding 85/167's Retry/class assertions already covered there.

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

function seedScratchRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "levare-blocked-spend-"));
  cpSync("fixtures/golden", root, { recursive: true });
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "seed golden fixture"]);
  return root;
}

let root: string;
beforeEach(() => {
  root = seedScratchRepo();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Gets loyalty-flow to "product-brief approved, design not yet attempted" — the state every test
 * below starts its own spend baseline from, since `start`'s own stubbed product-brief already carries
 * a nonzero usage this suite must not conflate with the design failure under test. */
async function setupLoyaltyFlowForDesign(): Promise<void> {
  await resolveGate(root, "storefront", "loyalty-flow", "start", { memberRunner: stubAdapterRunner(loadRepo(root)), today: "2026-07-12" });
  await resolveGate(root, "storefront", "product-brief-loyalty-flow-v1", "approve" as Verb, { today: "2026-07-12" });
}

async function triggerDesignFailure(error: unknown): Promise<void> {
  const failingRunner: AsyncMemberRunner = {
    capabilities: () => [{ member: "wren", kind: "product-brief" }, { member: "lyra", kind: "design" }, { member: "lyra", kind: "spec" }],
    produce: () => {
      throw error;
    },
  };
  const repo = loadRepo(root);
  const unit = repo.units.find((u) => u.unit === "loyalty-flow")!;
  const { advanceUnit } = await import("../src/dagwalk.ts");
  const result = await advanceUnit(root, repo, unit, failingRunner, { today: "2026-07-12" });
  expect(result.outcome).toBe("blocked");
}

async function blockLoyaltyFlowDesignWith(error: unknown): Promise<void> {
  await setupLoyaltyFlowForDesign();
  await triggerDesignFailure(error);
}

describe("Findings 162/95: a blocked artifact carries the failed dispatch's real receipt", () => {
  test("an AdapterError carrying a priced receipt lands usage: on the blocked artifact, and unitSpend counts it", async () => {
    await setupLoyaltyFlowForDesign();
    const before = loadRepo(root);
    const unitBefore = before.units.find((u) => u.unit === "loyalty-flow")!;
    const baseline = unitSpend(before, unitBefore).usd;

    const receipt: Receipt = { model: "claude-sonnet-5", tokens_in: 500, tokens_out: 200, wall_clock_s: 45, usd: 0.0372, unreported: false };
    await triggerDesignFailure(new AdapterError("native member 'lyra' sdk call failed: sdk query did not succeed (error_max_turns)", { receipt }));

    const repo = loadRepo(root, { validate: false });
    const art = [...(repo.artifacts.get("storefront/loyalty-flow")?.values() ?? [])].find((a) => a.kind === "design" && a.status === "blocked");
    expect(art?.usage?.usd).toBe(0.0372);
    expect(art?.usage?.model).toBe("claude-sonnet-5");
    expect(art?.usage?.tokens_in).toBe(500);

    // unitSpend rounds its total to the nearest cent (derive.ts's own `Math.round(usd * 100) / 100`),
    // so the diff against a separately-rounded baseline is only exact to 2 decimals, not the receipt's
    // own 4-decimal precision.
    const unit = repo.units.find((u) => u.unit === "loyalty-flow")!;
    expect(unitSpend(repo, unit).usd - baseline).toBeCloseTo(0.0372, 2);
  });

  test("an AdapterError with no receipt (idle/transport-level failure) leaves usage absent, contributes zero, and the failure is still visible", async () => {
    await setupLoyaltyFlowForDesign();
    const before = loadRepo(root);
    const unitBefore = before.units.find((u) => u.unit === "loyalty-flow")!;
    const baseline = unitSpend(before, unitBefore).usd;

    await triggerDesignFailure(new AdapterError("native member 'lyra' sdk call failed: sdk worker timed out after 600000ms"));

    const repo = loadRepo(root, { validate: false });
    const art = [...(repo.artifacts.get("storefront/loyalty-flow")?.values() ?? [])].find((a) => a.kind === "design" && a.status === "blocked");
    expect(art).toBeDefined();
    expect(art?.status).toBe("blocked");
    expect(art?.usage).toBeNull();

    const unit = repo.units.find((u) => u.unit === "loyalty-flow")!;
    expect(unitSpend(repo, unit).usd).toBe(baseline);
  });

  test("an unreported receipt (e.g. genuinely silent SDK response) is never written as a fabricated usd: null block", async () => {
    const receipt: Receipt = { model: null, tokens_in: null, tokens_out: null, wall_clock_s: null, usd: null, unreported: true };
    await blockLoyaltyFlowDesignWith(new AdapterError("native member 'lyra' sdk call failed: sdk query produced no result message", { receipt }));

    const repo = loadRepo(root, { validate: false });
    const art = [...(repo.artifacts.get("storefront/loyalty-flow")?.values() ?? [])].find((a) => a.kind === "design" && a.status === "blocked");
    expect(art?.usage).toBeNull();
  });

  test("a plain (non-AdapterError) thrown error is unaffected — no usage: field, unchanged pre-existing behavior", async () => {
    await blockLoyaltyFlowDesignWith(new Error("simulated member timeout"));

    const repo = loadRepo(root, { validate: false });
    const art = [...(repo.artifacts.get("storefront/loyalty-flow")?.values() ?? [])].find((a) => a.kind === "design" && a.status === "blocked");
    expect(art?.usage).toBeNull();
  });
});

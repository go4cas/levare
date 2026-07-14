import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, cpSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGate } from "../src/board/gateops.ts";
import { stubAdapterRunner } from "../src/replay.ts";
import { loadRepo } from "../src/repo.ts";
import { openGates } from "../src/board/derive.ts";
import { renderStudio } from "../src/board/render.ts";
import { unitSpend } from "../src/board/derive.ts";
import type { AsyncMemberRunner } from "../src/dagwalk.ts";
import type { Verb } from "../src/runner.ts";

// NOTES F19: a blocked artifact (a member ran and failed) had no verbs at all — the daemon correctly
// never auto-retries (that would be a money fire), but the ONLY way to move past it was deleting the
// file by hand and committing. It now raises a gate with three: RETRY (re-invoke the same member,
// costing money again — a Conductor's explicit decision, never the daemon's own), SKIP (mark the step
// abandoned; the walk continues if it can), ABANDON (pause the unit).

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
  const root = mkdtempSync(join(tmpdir(), "levare-f19-"));
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

/** Blocks loyalty-flow's `design` step by driving it through a runner that always throws for `design`
 * (matching the shape of the pre-existing daemon.test.ts "(d) failures never crash" scenario), leaving
 * a `status: blocked` artifact in design's slot. */
async function blockLoyaltyFlowDesign(): Promise<void> {
  await resolveGate(root, "storefront", "loyalty-flow", "start", { memberRunner: stubAdapterRunner(loadRepo(root)), today: "2026-07-12" });
  await resolveGate(root, "storefront", "product-brief-loyalty-flow-v1", "approve" as Verb, { today: "2026-07-12" });

  const failingRunner: AsyncMemberRunner = {
    capabilities: () => [{ member: "wren", kind: "product-brief" }, { member: "lyra", kind: "design" }, { member: "lyra", kind: "spec" }],
    produce: () => {
      throw new Error("simulated member timeout");
    },
  };
  const repo = loadRepo(root);
  const unit = repo.units.find((u) => u.unit === "loyalty-flow")!;
  const { advanceUnit } = await import("../src/dagwalk.ts");
  const result = await advanceUnit(root, repo, unit, failingRunner, { today: "2026-07-12" });
  expect(result.outcome).toBe("blocked");
}

describe("F19: a blocked artifact raises a gate with retry/skip/abandon", () => {
  test("the blocked artifact surfaces as its own gate, distinct from an in-review one — never approve/reject/request", async () => {
    await blockLoyaltyFlowDesign();
    const repo = loadRepo(root, { validate: false });
    const gate = openGates(repo).find((g) => g.type === "artifact-blocked");
    expect(gate).toBeDefined();
    expect(gate!.unit).toBe("loyalty-flow");
    expect(gate!.artifact!.status).toBe("blocked");

    const html = renderStudio(repo, root, new Date("2026-07-12T00:00:00Z"), []);
    const cardStart = html.indexOf("gate--artifact-blocked");
    expect(cardStart).toBeGreaterThan(-1);
    const card = html.slice(cardStart, html.indexOf("</article>", cardStart));
    expect(card).toContain('data-verb="retry"');
    expect(card).toContain('data-verb="skip"');
    expect(card).toContain('data-verb="abandon"');
    expect(card).not.toContain("data-verb=\"approve\""); // never approve/reject/request on THIS gate
  });

  test("retry re-invokes the same member and re-costs — a successful retry produces a real artifact with its own usage", async () => {
    await blockLoyaltyFlowDesign();
    const repo = loadRepo(root, { validate: false });
    const blockedId = "design-loyalty-flow-v1";

    let calls = 0;
    const succeedingRunner: AsyncMemberRunner = {
      capabilities: () => [{ member: "lyra", kind: "design" }],
      produce: (member, kind, unit, project) => {
        calls++;
        return {
          doc: [
            "---",
            `kind: ${kind}`,
            "id: placeholder",
            `unit: ${unit}`,
            `project: ${project}`,
            "status: in-review",
            `produced_by: kestrel/${member}`,
            "consumes: []",
            "supersedes: null",
            "approved_by: null",
            "created: 2026-07-12",
            "files: []",
            "usage:",
            "  model: claude-sonnet-5",
            "  tokens_in: 500",
            "  tokens_out: 200",
            "  usd: 0.05",
            "  wall_clock_s: 3",
            "---",
            "",
            "# design",
            "",
            "Retried and succeeded.",
            "",
          ].join("\n"),
        };
      },
    };
    const before = unitSpend(repo, repo.units.find((u) => u.unit === "loyalty-flow")!);

    const result = await resolveGate(root, "storefront", blockedId, "retry" as Verb, { memberRunner: succeedingRunner, today: "2026-07-12" });
    expect(result.ok).toBe(true);
    expect(calls).toBe(1); // re-invoked — the same member, the same kind.

    const after = loadRepo(root, { validate: false });
    const unitDir = join(root, "work/storefront/loyalty-flow");
    const oldSrc = readFileSync(join(unitDir, `${blockedId}.md`), "utf8");
    expect(oldSrc).toContain("status: superseded");

    const newArt = [...(after.artifacts.get("storefront/loyalty-flow")?.values() ?? [])].find((a) => a.kind === "design" && a.status === "in-review");
    expect(newArt).toBeDefined();
    expect(newArt!.supersedes).toBe(blockedId);

    // The retry's cost is recorded in the ledger like any other invocation.
    const afterSpend = unitSpend(after, after.units.find((u) => u.unit === "loyalty-flow")!);
    expect(afterSpend.usd).toBeGreaterThan(before.usd);
  });

  test("a retry that fails again writes a new blocked artifact, superseding the last, and stays actionable", async () => {
    await blockLoyaltyFlowDesign();
    const blockedId = "design-loyalty-flow-v1";
    let calls = 0;
    const stillFailingRunner: AsyncMemberRunner = {
      capabilities: () => [{ member: "lyra", kind: "design" }],
      produce: () => {
        calls++;
        throw new Error("still no license");
      },
    };
    const result = await resolveGate(root, "storefront", blockedId, "retry" as Verb, { memberRunner: stillFailingRunner, today: "2026-07-12" });
    expect(result.ok).toBe(false);
    expect(calls).toBe(1);

    const after = loadRepo(root, { validate: false });
    const gate = openGates(after).find((g) => g.type === "artifact-blocked");
    expect(gate).toBeDefined();
    expect(gate!.artifact!.id).not.toBe(blockedId); // a NEW blocked artifact, not the stale one
    expect(gate!.artifact!.body).toContain("still no license");

    const oldSrc = readFileSync(join(root, "work/storefront/loyalty-flow", `${blockedId}.md`), "utf8");
    expect(oldSrc).toContain("status: superseded");
  });

  test("skip marks the step abandoned, and the walk continues past it", async () => {
    await blockLoyaltyFlowDesign();
    const blockedId = "design-loyalty-flow-v1";
    const result = await resolveGate(root, "storefront", blockedId, "skip" as Verb, { memberRunner: stubAdapterRunner(loadRepo(root)), today: "2026-07-12" });
    expect(result.ok).toBe(true);

    const after = loadRepo(root, { validate: false });
    const art = after.artifacts.get("storefront/loyalty-flow")?.get(blockedId);
    expect(art?.status).toBe("skipped");
    expect(openGates(after).some((g) => g.type === "artifact-blocked")).toBe(false); // no longer a gate

    // The next walk step (spec) is now producible — dagwalk treats `skipped` like `approved` for a
    // plain step, so the flow proceeds past `design` instead of halting on it forever.
    const { advanceUnit } = await import("../src/dagwalk.ts");
    const unit = after.units.find((u) => u.unit === "loyalty-flow")!;
    const next = await advanceUnit(root, after, unit, stubAdapterRunner(after), { today: "2026-07-12" });
    expect(next.outcome).toBe("produced");
    if (next.outcome === "produced") expect(next.kind).toBe("spec");
  });

  test("abandon pauses the whole unit", async () => {
    await blockLoyaltyFlowDesign();
    const blockedId = "design-loyalty-flow-v1";
    const result = await resolveGate(root, "storefront", blockedId, "abandon" as Verb, { memberRunner: stubAdapterRunner(loadRepo(root)), today: "2026-07-12" });
    expect(result.ok).toBe(true);

    const after = loadRepo(root, { validate: false });
    const unit = after.units.find((u) => u.unit === "loyalty-flow")!;
    expect(unit.status).toBe("paused");
    // The blocked artifact itself is untouched — the pause is what stops the walk, not a status flip.
    expect(after.artifacts.get("storefront/loyalty-flow")?.get(blockedId)?.status).toBe("blocked");
  });

  test("the daemon still never retries on its own — retry/skip/abandon are exclusively Conductor-triggered", async () => {
    await blockLoyaltyFlowDesign();
    const repo = loadRepo(root, { validate: false });
    const unit = repo.units.find((u) => u.unit === "loyalty-flow")!;
    let calls = 0;
    const countingRunner: AsyncMemberRunner = {
      capabilities: () => [{ member: "wren", kind: "product-brief" }, { member: "lyra", kind: "design" }, { member: "lyra", kind: "spec" }],
      produce: () => {
        calls++;
        throw new Error("should never be called by the daemon's own walk");
      },
    };
    const { advanceUnit } = await import("../src/dagwalk.ts");
    const result = await advanceUnit(root, repo, unit, countingRunner, { today: "2026-07-12" });
    expect(result.outcome).toBe("halted"); // the design kind is already blocked; the walk halts, never re-invokes.
    expect(calls).toBe(0);
  });
});

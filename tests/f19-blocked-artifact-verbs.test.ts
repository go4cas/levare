import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, cpSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { assertSpawnOk } from "./spawn-helpers.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGate } from "../src/board/gateops.ts";
import { stubAdapterRunner } from "../src/replay.ts";
import { loadRepo } from "../src/repo.ts";
import { openGates } from "../src/derive.ts";
import { renderStudio } from "../src/board/render.ts";
import { unitSpend } from "../src/derive.ts";
import { AdapterError } from "../src/adapters.ts";
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
  assertSpawnOk(`git ${args.join(" ")}`, r);
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

/** Same shape as `blockLoyaltyFlowDesign`, but the failing runner throws a caller-supplied error — lets
 * a test drive an `AdapterError` carrying a `class` through the exact same path a real one would. */
async function blockLoyaltyFlowDesignWith(error: unknown): Promise<void> {
  await resolveGate(root, "storefront", "loyalty-flow", "start", { memberRunner: stubAdapterRunner(loadRepo(root)), today: "2026-07-12" });
  await resolveGate(root, "storefront", "product-brief-loyalty-flow-v1", "approve" as Verb, { today: "2026-07-12" });

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

// Finding 85: an operator-actionable failure (credit balance, invalid/revoked key — Retry can never
// succeed until the studio/environment changes) must not offer Retry the way a member-caused failure
// does. `blockLoyaltyFlowDesign` (unchanged, above) is the pre-existing member-caused/default case —
// every one of ITS tests staying green is the regression check that this unit changes nothing for it.
describe("Finding 85: an operator-actionable blocked artifact withholds Retry, server-side and on the card", () => {
  test("the AdapterError's class lands on the blocked artifact as blocked_class", async () => {
    await blockLoyaltyFlowDesignWith(new AdapterError("sdk worker: request rejected (HTTP 400) — credit balance too low", { class: "operator" }));
    const repo = loadRepo(root, { validate: false });
    const art = [...(repo.artifacts.get("storefront/loyalty-flow")?.values() ?? [])].find((a) => a.kind === "design" && a.status === "blocked");
    expect(art?.blocked_class).toBe("operator");
    expect(art?.blocked_reason).toContain("credit balance too low");
  });

  test("openGates carries the class onto the gate, and the rendered card omits Retry but keeps Skip/Abandon", async () => {
    await blockLoyaltyFlowDesignWith(new AdapterError("sdk worker: request rejected (HTTP 400) — credit balance too low", { class: "operator" }));
    const repo = loadRepo(root, { validate: false });
    const gate = openGates(repo).find((g) => g.type === "artifact-blocked");
    expect(gate?.class).toBe("operator");

    const html = renderStudio(repo, root, new Date("2026-07-12T00:00:00Z"), []);
    const cardStart = html.indexOf("gate--artifact-blocked");
    const card = html.slice(cardStart, html.indexOf("</article>", cardStart));
    expect(card).not.toContain('data-verb="retry"');
    expect(card).toContain('data-verb="skip"');
    expect(card).toContain('data-verb="abandon"');
    expect(card).toContain("credit balance too low"); // the classified message names the operator's own action
  });

  test("resolveGate refuses the retry verb server-side (409), even if a stale client still sends it", async () => {
    await blockLoyaltyFlowDesignWith(new AdapterError("sdk worker: authentication failure (HTTP 401)", { class: "operator" }));
    const blockedId = "design-loyalty-flow-v1";
    let calls = 0;
    const countingRunner: AsyncMemberRunner = {
      capabilities: () => [{ member: "lyra", kind: "design" }],
      produce: () => {
        calls++;
        throw new Error("should never be invoked — retry is refused before the member runs");
      },
    };
    const result = await resolveGate(root, "storefront", blockedId, "retry" as Verb, { memberRunner: countingRunner, today: "2026-07-12" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.error).toContain("operator-actionable");
    }
    expect(calls).toBe(0); // never spent a costed dispatch attempt on a call levare already knows will fail

    // Skip still works — the remedy that DOES make sense stays available.
    const skipResult = await resolveGate(root, "storefront", blockedId, "skip" as Verb, { memberRunner: countingRunner, today: "2026-07-12" });
    expect(skipResult.ok).toBe(true);
  });

  test("a member-caused failure (no class) is unchanged — Retry stays offered, exactly as F19 established", async () => {
    await blockLoyaltyFlowDesign();
    const repo = loadRepo(root, { validate: false });
    const gate = openGates(repo).find((g) => g.type === "artifact-blocked");
    expect(gate?.class).toBeUndefined();
    const html = renderStudio(repo, root, new Date("2026-07-12T00:00:00Z"), []);
    const cardStart = html.indexOf("gate--artifact-blocked");
    const card = html.slice(cardStart, html.indexOf("</article>", cardStart));
    expect(card).toContain('data-verb="retry"');
  });

  test("a retry that fails again on an operator-actionable AdapterError records the class on the new blocked artifact too", async () => {
    await blockLoyaltyFlowDesign(); // member-caused first attempt — retry is offered
    const blockedId = "design-loyalty-flow-v1";
    const nowOperatorFailing: AsyncMemberRunner = {
      capabilities: () => [{ member: "lyra", kind: "design" }],
      produce: () => {
        throw new AdapterError("sdk worker: request rejected (HTTP 400) — credit balance too low", { class: "operator" });
      },
    };
    const result = await resolveGate(root, "storefront", blockedId, "retry" as Verb, { memberRunner: nowOperatorFailing, today: "2026-07-12" });
    expect(result.ok).toBe(false);

    const after = loadRepo(root, { validate: false });
    const gate = openGates(after).find((g) => g.type === "artifact-blocked");
    expect(gate?.class).toBe("operator");
    expect(gate?.artifact?.id).not.toBe(blockedId); // a new blocked artifact, as F19's own retry-fails-again test established
  });
});

// Finding 167: `blocked_class_source` is the sibling of `blocked_class` that says HOW the class was
// decided (a real status vs a matched vendor message) — the classification behavior itself (Retry
// withheld for "operator") is entirely Finding 85's, unchanged. These tests only cover that the
// provenance field lands on disk and carries through to the gate, mirroring the tests above.
describe("Finding 167: blocked_class_source records how blocked_class was decided", () => {
  test("dagwalk.ts#writeBlocked (first attempt) carries AdapterError.classSource onto blocked_class_source", async () => {
    await blockLoyaltyFlowDesignWith(
      new AdapterError("native member 'lyra' sdk call failed: Claude Code returned an error result: Not logged in · Please run /login", {
        class: "operator",
        classSource: "message",
      }),
    );
    const repo = loadRepo(root, { validate: false });
    const art = [...(repo.artifacts.get("storefront/loyalty-flow")?.values() ?? [])].find((a) => a.kind === "design" && a.status === "blocked");
    expect(art?.blocked_class).toBe("operator");
    expect(art?.blocked_class_source).toBe("message");
  });

  test("a status-classified failure records blocked_class_source: 'status' — the pre-existing Finding-85 path, distinguishable from a message match", async () => {
    await blockLoyaltyFlowDesignWith(
      new AdapterError("sdk worker: request rejected (HTTP 400) — credit balance too low", { class: "operator", classSource: "status" }),
    );
    const repo = loadRepo(root, { validate: false });
    const art = [...(repo.artifacts.get("storefront/loyalty-flow")?.values() ?? [])].find((a) => a.kind === "design" && a.status === "blocked");
    expect(art?.blocked_class_source).toBe("status");
  });

  test("a classified failure with no classSource (pre-Finding-167 shape) leaves blocked_class_source absent — unchanged behavior", async () => {
    await blockLoyaltyFlowDesignWith(new AdapterError("sdk worker: request rejected (HTTP 400) — credit balance too low", { class: "operator" }));
    const repo = loadRepo(root, { validate: false });
    const art = [...(repo.artifacts.get("storefront/loyalty-flow")?.values() ?? [])].find((a) => a.kind === "design" && a.status === "blocked");
    expect(art?.blocked_class).toBe("operator");
    expect(art?.blocked_class_source).toBeFalsy();
  });

  test("a member-caused failure (no class, no source) is unchanged — both stay absent, Retry stays offered", async () => {
    await blockLoyaltyFlowDesign();
    const repo = loadRepo(root, { validate: false });
    const art = [...(repo.artifacts.get("storefront/loyalty-flow")?.values() ?? [])].find((a) => a.kind === "design" && a.status === "blocked");
    expect(art?.blocked_class).toBeFalsy();
    expect(art?.blocked_class_source).toBeFalsy();
  });

  test("a retry that fails again with a message-classified AdapterError records blocked_class_source on the NEW blocked artifact (blockedRetryDoc path)", async () => {
    await blockLoyaltyFlowDesign(); // member-caused first attempt — retry is offered
    const blockedId = "design-loyalty-flow-v1";
    const nowNoCredentialFailing: AsyncMemberRunner = {
      capabilities: () => [{ member: "lyra", kind: "design" }],
      produce: () => {
        throw new AdapterError("native member 'lyra' sdk call failed: Claude Code returned an error result: Not logged in · Please run /login", {
          class: "operator",
          classSource: "message",
        });
      },
    };
    const result = await resolveGate(root, "storefront", blockedId, "retry" as Verb, { memberRunner: nowNoCredentialFailing, today: "2026-07-12" });
    expect(result.ok).toBe(false);

    const after = loadRepo(root, { validate: false });
    const gate = openGates(after).find((g) => g.type === "artifact-blocked");
    expect(gate?.class).toBe("operator");
    expect(gate?.artifact?.blocked_class_source).toBe("message");
    expect(gate?.artifact?.id).not.toBe(blockedId);
  });
});

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

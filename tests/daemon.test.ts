import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, cpSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.ts";
import { resolveGate } from "../src/board/gateops.ts";
import { stubAdapterRunner } from "../src/replay.ts";
import { loadRepo } from "../src/repo.ts";
import { loadPricing } from "../src/pricing.ts";
import { AdapterRunner } from "../src/adapters.ts";
import type { MemberRunner } from "../src/runner.ts";
import type { Verb } from "../src/runner.ts";

// Phase 8: the daemon walks the DAG between gates and halts at every gate (invariant 1). These tests
// drive a real scratch studio (a git-backed copy of fixtures/golden) with the real AdapterRunner
// boundary behind the still-mocked native/CLI adapters (invariant 10) — the same boundary
// board/gateops.ts and `levare replay` already drive — never a second, daemon-only member-invocation
// path.

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
  const root = mkdtempSync(join(tmpdir(), "levare-daemon-"));
  cpSync("fixtures/golden", root, { recursive: true });
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "seed golden fixture"]);
  return root;
}

// A MemberRunner wrapper that records every (member, kind, unit) call, in order — the causal-chain
// audit trail these tests assert against. `unit` is recorded (not just member/kind) because ruling
// C14 means the golden fixture's OWN static checkout-flow — seeded mid-loop (spec in-review, no
// review, forever, exactly the standing state the pre-C14 defect left it in) — now completes its
// round the instant any daemon walks it, alongside whichever unit a given test actually targets.
function countingRunner(root: string): { runner: MemberRunner; calls: Array<{ member: string; kind: string; unit: string }> } {
  const calls: Array<{ member: string; kind: string; unit: string }> = [];
  const inner = stubAdapterRunner(loadRepo(root));
  return {
    calls,
    runner: {
      capabilities: () => inner.capabilities(),
      produce: (member, kind, unit, project, extraConsumes) => {
        calls.push({ member, kind, unit });
        return inner.produce(member, kind, unit, project, extraConsumes);
      },
    },
  };
}

// Scope a countingRunner's calls to one unit, dropping the unit tag — the shape every pre-C14
// assertion already expects. Ruling C14: checkout-flow's own frozen loop (see countingRunner's doc)
// completes alongside whatever unit a test is actually driving, so tests that care about ONE unit's
// causal chain filter to it explicitly rather than asserting on the raw, multi-unit call log.
function callsFor(calls: Array<{ member: string; kind: string; unit: string }>, unit: string): Array<{ member: string; kind: string }> {
  return calls.filter((c) => c.unit === unit).map(({ member, kind }) => ({ member, kind }));
}

let root: string;
beforeEach(() => {
  root = seedScratchRepo();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("(a) the daemon walks between gates and halts at every gate", () => {
  test("loyalty-flow: start gate never auto-starts; approving each gate advances exactly one step, which halts as the next gate", async () => {
    const unitDir = join(root, "work/storefront/loyalty-flow");
    const { runner, calls } = countingRunner(root);
    const daemon = new Daemon(root, { memberRunner: () => runner });

    // Invariant 1: a satisfied-but-unauthorized start gate is never crossed by the autonomous walk,
    // no matter how many times it ticks.
    for (let i = 0; i < 3; i++) await daemon.tick();
    expect(callsFor(calls, "loyalty-flow")).toEqual([]);
    expect(readdirSync(unitDir)).toEqual(["unit.md"]);

    // The Conductor authorizes the start gate (the ONE call allowed to cross it — board/gateops.ts).
    const started = await resolveGate(root, "storefront", "loyalty-flow", "start", { memberRunner: runner, today: "2026-07-12" });
    expect(started.ok).toBe(true);
    expect(callsFor(calls, "loyalty-flow")).toEqual([{ member: "wren", kind: "product-brief" }]);
    const brief = readFileSync(join(unitDir, "product-brief-loyalty-flow-v1.md"), "utf8");
    expect(brief).toContain("status: in-review");

    // Halts at the gate the start just reached: repeated ticks produce nothing further.
    for (let i = 0; i < 3; i++) await daemon.tick();
    expect(callsFor(calls, "loyalty-flow")).toEqual([{ member: "wren", kind: "product-brief" }]);

    // Conductor approves → daemon advances exactly one more step (design), then halts again.
    const approve: Verb = "approve";
    const approved1 = await resolveGate(root, "storefront", "product-brief-loyalty-flow-v1", approve, { memberRunner: runner, today: "2026-07-12" });
    expect(approved1.ok).toBe(true);
    expect(callsFor(calls, "loyalty-flow")).toEqual([{ member: "wren", kind: "product-brief" }]); // approval itself never invokes a member.

    let result = await daemon.tick();
    expect(callsFor(calls, "loyalty-flow")).toEqual([{ member: "wren", kind: "product-brief" }, { member: "lyra", kind: "design" }]);
    expect(existsSync(join(unitDir, "design-loyalty-flow-v1.md"))).toBe(true);
    let entry = result.entries.find((e) => e.unit === "loyalty-flow")!;
    expect(entry.outcome.outcome).toBe("produced");

    // Halts at design's gate.
    result = await daemon.tick();
    entry = result.entries.find((e) => e.unit === "loyalty-flow")!;
    expect(entry.outcome.outcome).toBe("halted");
    expect(callsFor(calls, "loyalty-flow").length).toBe(2);

    // Approve design → the loop's first member (spec) is produced; ruling C14: the walk then ALSO
    // dispatches the loop's companion (review), in the same round, before halting at the round's
    // outcome gate — the exact live defect this ruling fixes (previously spec sat alone forever).
    await resolveGate(root, "storefront", "design-loyalty-flow-v1", approve, { memberRunner: runner, today: "2026-07-12" });
    result = await daemon.tick();
    expect(callsFor(calls, "loyalty-flow")).toEqual([
      { member: "wren", kind: "product-brief" },
      { member: "lyra", kind: "design" },
      { member: "lyra", kind: "spec" },
    ]);
    expect(existsSync(join(unitDir, "spec-loyalty-flow-v1.md"))).toBe(true);
    expect(existsSync(join(unitDir, "review-loyalty-flow-v1.md"))).toBe(false);
    entry = result.entries.find((e) => e.unit === "loyalty-flow")!;
    expect(entry.outcome.outcome).toBe("produced");

    // The NEXT tick dispatches the companion (review) — same round, second half — then the walk
    // halts at the round's outcome gate: spec sits in-review, review sits in-review, awaiting the
    // Conductor's decision on spec (which resolves both, ruling C2/C14).
    result = await daemon.tick();
    expect(callsFor(calls, "loyalty-flow")).toEqual([
      { member: "wren", kind: "product-brief" },
      { member: "lyra", kind: "design" },
      { member: "lyra", kind: "spec" },
      { member: "finch", kind: "review" },
    ]);
    expect(existsSync(join(unitDir, "review-loyalty-flow-v1.md"))).toBe(true);
    const review = readFileSync(join(unitDir, "review-loyalty-flow-v1.md"), "utf8");
    expect(review).toContain("status: in-review");
    // The critic consumed the author's own artifact (spec) — still in-review at this moment — plus
    // whatever else was already approved (design, product-brief); ruling C14's `extraConsumes` seam.
    expect(review).toMatch(/consumes: \[.*spec-loyalty-flow-v1.*\]/);

    // Invariant 1, the hard part: the daemon NEVER resolves the gate it just raised — both artifacts
    // sit at in-review indefinitely, no matter how many times it ticks.
    for (let i = 0; i < 5; i++) await daemon.tick();
    expect(callsFor(calls, "loyalty-flow").length).toBe(4);
    const spec = readFileSync(join(unitDir, "spec-loyalty-flow-v1.md"), "utf8");
    expect(spec).toContain("status: in-review");
    expect(spec).toContain("approved_by: null");

    // Every commit whose CONTENT is a member's own output — including the `start` verb's own
    // production, not just the daemon's later autonomous ones — is attributed to the runner identity,
    // never "cas": authorship reflects who wrote the file, not whose click caused the commit
    // (NOTES.md's phase-8 O6 gate-review fix). Conductor decisions (approve/reject/start's own
    // authorization click) stay "cas" — this is exactly the mixed sequence the gate finding's own
    // live evidence showed, reproduced deterministically here.
    const log = spawnSync("git", ["-C", root, "log", "--format=%an|%ae|%s"], { encoding: "utf8" }).stdout;
    expect(log).toContain("levare-runner|runner@levare.local|start loyalty-flow → kestrel/wren produced product-brief product-brief-loyalty-flow-v1");
    expect(log).toContain("levare-runner|runner@levare.local|advance loyalty-flow → kestrel/lyra produced design");
    expect(log).toContain("levare-runner|runner@levare.local|advance loyalty-flow → kestrel/lyra produced spec");
    expect(log).toContain("cas|cas@levare.local|approve product-brief-loyalty-flow-v1");
    expect(log).toContain("cas|cas@levare.local|approve design-loyalty-flow-v1");
    // Never the other way around: no member-produced artifact's commit is ever attributed to cas.
    expect(log).not.toContain("cas|cas@levare.local|start loyalty-flow");
    expect(log).not.toContain("cas|cas@levare.local|advance loyalty-flow");
  });
});

describe("(g) commit authorship reflects who acted, not who triggered (gate-review fix)", () => {
  test("a gate resolution (no member invoked) commits as the Conductor; a member-produced artifact — however it was triggered — commits as levare-runner", async () => {
    // (1) A plain gate resolution: no member runs, the Conductor's own frontmatter flip is the sole
    // content of the commit.
    const started = await resolveGate(root, "storefront", "loyalty-flow", "start" as Verb, { memberRunner: stubAdapterRunner(loadRepo(root)), today: "2026-07-12" });
    expect(started.ok).toBe(true);
    const approveCommit = await resolveGate(root, "storefront", "product-brief-loyalty-flow-v1", "approve" as Verb, { today: "2026-07-12" });
    expect(approveCommit.ok).toBe(true);
    const approveAuthor = commitAuthor(root, (approveCommit as { commit: string }).commit);
    expect(approveAuthor).toEqual({ name: "cas", email: "cas@levare.local" });

    // (2) The `start` verb's own production: legal because the Conductor clicked it, but the file
    // content is entirely a member's output — must NOT carry the Conductor's identity.
    const startCommit = (started as { commit: string }).commit;
    const startAuthor = commitAuthor(root, startCommit);
    expect(startAuthor).toEqual({ name: "levare-runner", email: "runner@levare.local" });
    expect(startAuthor).not.toEqual({ name: "cas", email: "cas@levare.local" });

    // (3) A daemon-driven, fully autonomous production (no verb, no direct click at all): the same
    // identity as (2) — confirming the rule is about WHO WROTE the content, not which code path ran.
    const daemon = new Daemon(root, { memberRunner: stubAdapterRunner });
    const result = await daemon.tick(); // advances loyalty-flow past the now-approved product-brief → design
    const designEntry = result.entries.find((e) => e.unit === "loyalty-flow" && e.outcome.outcome === "produced")!;
    const daemonAuthor = commitAuthor(root, (designEntry.outcome as { commit: string }).commit);
    expect(daemonAuthor).toEqual({ name: "levare-runner", email: "runner@levare.local" });
  });
});

function commitAuthor(root: string, sha: string): { name: string; email: string } {
  const out = spawnSync("git", ["-C", root, "show", "-s", "--format=%an|%ae", sha], { encoding: "utf8" }).stdout.trim();
  const [name, email] = out.split("|");
  return { name, email };
}

describe("(b) EVERY unit's first flow step raises a start gate — no auto-start path (ruling C8)", () => {
  test("a freshly-declared active unit with no after: raises a start gate; the daemon never crosses it on its own", async () => {
    const unitDir = join(root, "work/storefront/widget-tweak");
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(
      join(unitDir, "unit.md"),
      "---\ntype: feature\nstatus: active\n---\n\n# widget-tweak\n\nA small storefront affordance change, for daemon test coverage.\n",
    );
    const { runner, calls } = countingRunner(root);
    const daemon = new Daemon(root, { memberRunner: () => runner });
    // No `after:` at all — still a start gate, not a licence to begin (invariant 1): a hand-written
    // or injected unit.md causes NO member invocation, only a start gate, no matter how many ticks.
    for (let i = 0; i < 3; i++) await daemon.tick();
    expect(callsFor(calls, "widget-tweak")).toEqual([]);
    expect(readdirSync(unitDir)).toEqual(["unit.md"]);
  });

  test("once the Conductor resolves the start gate, the daemon advances the unit normally on later ticks", async () => {
    const unitDir = join(root, "work/storefront/widget-tweak");
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(
      join(unitDir, "unit.md"),
      "---\ntype: feature\nstatus: active\n---\n\n# widget-tweak\n\nA small storefront affordance change, for daemon test coverage.\n",
    );

    // The Conductor's own explicit click is the only thing allowed to cross the start gate.
    const started = await resolveGate(root, "storefront", "widget-tweak", "start" as Verb, { memberRunner: stubAdapterRunner(loadRepo(root)), today: "2026-07-12" });
    expect(started.ok).toBe(true);
    expect(existsSync(join(unitDir, "product-brief-widget-tweak-v1.md"))).toBe(true);
    await resolveGate(root, "storefront", "product-brief-widget-tweak-v1", "approve" as Verb, { today: "2026-07-12" });

    // Past the start gate, the daemon advances the unit exactly like any other flow step, with no
    // further authorization required.
    const { runner, calls } = countingRunner(root);
    const daemon = new Daemon(root, { memberRunner: () => runner });
    await daemon.tick();
    expect(callsFor(calls, "widget-tweak")).toEqual([{ member: "lyra", kind: "design" }]);
    expect(existsSync(join(unitDir, "design-widget-tweak-v1.md"))).toBe(true);
    // Halts at design's gate — a second tick does not chase further without an approval.
    await daemon.tick();
    expect(callsFor(calls, "widget-tweak").length).toBe(1);
  });
});

describe("(c) 'Members running' is a true projection of in-flight invocations", () => {
  test("running() reflects exactly the window a member call is in flight, and clears after", async () => {
    // Get loyalty-flow past its start gate first (not itself under observation here).
    await resolveGate(root, "storefront", "loyalty-flow", "start", { memberRunner: stubAdapterRunner(loadRepo(root)), today: "2026-07-12" });
    await resolveGate(root, "storefront", "product-brief-loyalty-flow-v1", "approve" as Verb, { today: "2026-07-12" });

    let sawRunning: ReturnType<Daemon["running"]> | null = null;
    const inner = stubAdapterRunner(loadRepo(root));
    const daemon = new Daemon(root, {
      memberRunner: () => ({
        capabilities: () => inner.capabilities(),
        produce: (member, kind, unit, project) => {
          sawRunning = daemon.running();
          return inner.produce(member, kind, unit, project);
        },
      }),
    });
    expect(daemon.running()).toEqual([]);
    await daemon.tick(); // advances loyalty-flow to `design`
    expect(sawRunning).not.toBeNull();
    expect(sawRunning!).toEqual([{ project: "storefront", unit: "loyalty-flow", member: "lyra", kind: "design", startedAt: sawRunning![0].startedAt }]);
    // Cleared the instant production finishes.
    expect(daemon.running()).toEqual([]);
  });
});

describe("(d) failures never crash the daemon or stall silently — they surface as a blocked artifact", () => {
  test("a member that throws produces a `blocked` artifact instead of crashing the tick, and is never retried", async () => {
    await resolveGate(root, "storefront", "loyalty-flow", "start", { memberRunner: stubAdapterRunner(loadRepo(root)), today: "2026-07-12" });
    await resolveGate(root, "storefront", "product-brief-loyalty-flow-v1", "approve" as Verb, { today: "2026-07-12" });

    let calls = 0;
    const daemon = new Daemon(root, {
      memberRunner: () => ({
        // "product-brief" is included so `brief`'s own step resolution still succeeds (it's already
        // approved on disk, so it's never re-produced) — otherwise resolveStep would fail to resolve
        // that earlier step at all and mask the case under test.
        capabilities: () => [{ member: "wren", kind: "product-brief" }, { member: "lyra", kind: "design" }, { member: "lyra", kind: "spec" }],
        produce: () => {
          calls++;
          throw new Error("simulated member timeout");
        },
      }),
    });

    const r1 = await daemon.tick();
    expect(calls).toBe(1);
    const entry = r1.entries.find((e) => e.unit === "loyalty-flow")!;
    expect(entry.outcome.outcome).toBe("blocked");
    const unitDir = join(root, "work/storefront/loyalty-flow");
    const blocked = readFileSync(join(unitDir, "design-loyalty-flow-v1.md"), "utf8");
    expect(blocked).toContain("status: blocked");
    expect(blocked).toContain("simulated member timeout");

    // The daemon is still alive and keeps ticking normally — a member failure never crashes it.
    const r2 = await daemon.tick();
    expect(r2.entries.length).toBeGreaterThan(0);
    // Never retried: the blocked artifact occupies design's slot, so the daemon halts there instead.
    expect(calls).toBe(1);
  });
});

// NOTES F11 part 2 — proven live: a native member's usage receipt can name a DIFFERENT model than the
// one it declared (the SDK silently substitutes its own default with no error and no warning — see
// tests/sdk-worker-receipt.test.ts for the root-cause reproduction). levare's only real defence is
// comparing what it asked for against what its own receipt reports, end to end: a member that ran on a
// model the Conductor did not authorise must never land as a quiet in-review artifact.
describe("(d2) NOTES F11: a native member's receipt naming a model other than the one it declared blocks the artifact, naming BOTH models", () => {
  test("a real AdapterRunner backed by a native boundary that reports the wrong model produces a `blocked` artifact naming the declared and the actual model", async () => {
    const repo = loadRepo(root);
    const adapterRunner = new AdapterRunner(repo, {
      pricing: loadPricing(root),
      capabilities: [{ member: "wren", kind: "product-brief" }],
      native: {
        // Simulates exactly the live defect: the SDK reports back a DIFFERENT model than the one
        // requested (wren declares claude-sonnet-5; the boundary here reports claude-haiku-4-5-20251001).
        invoke: (r) => ({
          doc: `# product brief\n\nDrafted for ${r.unit}.\n`,
          receipt: { model: "claude-haiku-4-5-20251001", tokens_in: 500, tokens_out: 100, wall_clock_s: 2, usd: 0.002, unreported: false },
        }),
      },
      remote: { call: () => { throw new Error("not used"); } },
    });
    const memberRunner = {
      capabilities: () => adapterRunner.capabilities(),
      produce: (member: string, kind: string, unit: string, project: string) => adapterRunner.produce(member, kind, unit, project),
    };

    const started = await resolveGate(root, "storefront", "loyalty-flow", "start", { memberRunner, today: "2026-07-12" });
    expect(started.ok).toBe(false);
    // doStart surfaces a member-boundary failure as 502, the reason verbatim (board/gateops.ts#doStart).
    expect((started as { error: string }).error).toContain("claude-sonnet-5"); // wren's declared model
    expect((started as { error: string }).error).toContain("claude-haiku-4-5-20251001"); // what actually ran

    // The artifact landed on disk, BLOCKED (dagwalk.ts#writeBlocked — the same path every other member
    // failure already takes), naming both models — never a silent in-review artifact carrying
    // unauthorised, unbudgeted work.
    const unitDir = join(root, "work/storefront/loyalty-flow");
    const files = readdirSync(unitDir).filter((f) => f.startsWith("product-brief-"));
    expect(files.length).toBe(1);
    const doc = readFileSync(join(unitDir, files[0]), "utf8");
    expect(doc).toContain("status: blocked");
    expect(doc).toContain("claude-sonnet-5");
    expect(doc).toContain("claude-haiku-4-5-20251001");

    // The daemon's own re-derivation agrees: nothing further happens for this unit until a human acts —
    // the blocked artifact occupies the slot, exactly like any other member-failure block.
    const daemon = new Daemon(root, { memberRunner: () => memberRunner });
    const before = readFileSync(join(unitDir, files[0]), "utf8");
    await daemon.tick();
    const after = readFileSync(join(unitDir, files[0]), "utf8");
    expect(after).toBe(before);
  });
});

describe("(e) concurrency safety: a single-threaded work queue", () => {
  test(
    "many rapid ticks never invoke a member twice for the same producible kind",
    async () => {
      await resolveGate(root, "storefront", "loyalty-flow", "start", { memberRunner: stubAdapterRunner(loadRepo(root)), today: "2026-07-12" });
      await resolveGate(root, "storefront", "product-brief-loyalty-flow-v1", "approve" as Verb, { today: "2026-07-12" });

      const { runner, calls } = countingRunner(root);
      const daemon = new Daemon(root, { memberRunner: () => runner });
      // 30 rapid repeated ticks — simulating a burst of repo-change signals — must produce `design`
      // exactly once (it halts there; spec is behind an unresolved gate). The property under test
      // (the mutex holds; a member is never invoked twice for the same producible kind) is entirely
      // deterministic — a fixed number of ticks, an exact invocation-count assertion — and has
      // nothing to do with wall-clock time. Each tick does real git commits (spawnSync), so the WALL
      // TIME to run all 30 varies with host load; the third `test()` argument below only raises the
      // ceiling bun would otherwise kill a slow-but-correct run at — it is a generous "this should
      // never hang" backstop, never part of what the assertion depends on.
      for (let i = 0; i < 30; i++) await daemon.tick();
      expect(callsFor(calls, "loyalty-flow")).toEqual([{ member: "lyra", kind: "design" }]);
    },
    30_000,
  );

  test("tick() refuses to run re-entrantly (the mutex itself), rather than interleaving", async () => {
    // A member call that itself (synchronously) tries to trigger another tick — the one genuine
    // reentrancy hazard possible with today's fully-synchronous MemberRunner boundary — must be
    // refused by the same single-flight guard the watcher-driven loop relies on, not silently allowed
    // to interleave two unit-walks against the same on-disk state. Past its start gate and with its
    // brief already approved (ruling C8 — every unit's first production needs an explicit Conductor
    // start), a unit is immediately walkable again, guaranteeing `produce` genuinely fires within
    // this tick.
    const unitDir = join(root, "work/storefront/widget-tweak");
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(join(unitDir, "unit.md"), "---\ntype: feature\nstatus: active\n---\n\n# widget-tweak\n\nReentrancy test fixture unit.\n");
    await resolveGate(root, "storefront", "widget-tweak", "start" as Verb, { memberRunner: stubAdapterRunner(loadRepo(root)), today: "2026-07-12" });
    await resolveGate(root, "storefront", "product-brief-widget-tweak-v1", "approve" as Verb, { today: "2026-07-12" });

    let sawReentrantThrow = false;
    const inner = new Daemon(root, {
      memberRunner: () => ({
        // "product-brief" is included so `brief`'s own step resolution still succeeds (it's already
        // approved on disk, so it's never re-produced) — otherwise resolveStep would fail to resolve
        // that earlier step at all and mask the case under test (mirrors test (d)'s own note).
        capabilities: () => [{ member: "wren", kind: "product-brief" }, { member: "lyra", kind: "design" }],
        produce: async (member, kind, unit, project) => {
          try {
            await inner.tick();
          } catch (e) {
            sawReentrantThrow = /already in progress/.test(String(e));
          }
          return stubAdapterRunner(loadRepo(root)).produce(member, kind, unit, project);
        },
      }),
    });
    await inner.tick();
    expect(sawReentrantThrow).toBe(true);
  });
});

describe("(f) budget halts stop the walk without crashing or silently dropping the reason", () => {
  test("a unit already over budget halts with a visible reason instead of producing further", async () => {
    const unitDir = join(root, "work/storefront/loyalty-flow");
    await resolveGate(root, "storefront", "loyalty-flow", "start", { memberRunner: stubAdapterRunner(loadRepo(root)), today: "2026-07-12" });
    // product-brief's canned usage.usd is 0.06 (fixtures/stubs/member-stub.ts) — set a budget below
    // that so the very next production attempt is already over it.
    const unitSrc = readFileSync(join(unitDir, "unit.md"), "utf8").replace("budget: 15.00", "budget: 0.01");
    writeFileSync(join(unitDir, "unit.md"), unitSrc);
    await resolveGate(root, "storefront", "product-brief-loyalty-flow-v1", "approve" as Verb, { today: "2026-07-12" });

    const { runner, calls } = countingRunner(root);
    const daemon = new Daemon(root, { memberRunner: () => runner });
    const result = await daemon.tick();
    expect(callsFor(calls, "loyalty-flow")).toEqual([]); // never invoked — the budget check runs before production.
    const entry = result.entries.find((e) => e.unit === "loyalty-flow")!;
    expect(entry.outcome.outcome).toBe("budget-gate");
    expect((entry.outcome as { reason: string }).reason).toContain("budget");
    expect(daemon.recentActivity().some((e) => e.outcome.outcome === "budget-gate" && (e.outcome as { reason: string }).reason.includes("budget"))).toBe(true);
    // The gate is raised and awaiting the Conductor — not silently swallowed.
    expect(daemon.budgetGates().some((g) => g.unit === "loyalty-flow")).toBe(true);
  });
});

// Ruling C3 (extended, PRD v1.1 §5): a budget gate HALTS the unit that crossed it until the Conductor
// resolves it — per-unit, never global — and the resolution verbs continue/raise/stop govern whether
// and how the walk resumes. The stub member's canned spend is $0.06 for product-brief, $0.10 for
// design (fixtures/stubs/member-stub.ts) — so spend accrues 0.06 → 0.16 as a feature unit walks.

// Create a fresh storefront feature unit with a given budget, get it past its start gate, and approve
// its product-brief — leaving the unit walkable and $0.06 already spent (one brief). Returns its dir.
async function seedFeatureUnit(root: string, name: string, budget: number): Promise<string> {
  const unitDir = join(root, "work/storefront", name);
  mkdirSync(unitDir, { recursive: true });
  writeFileSync(
    join(unitDir, "unit.md"),
    `---\ntype: feature\nstatus: active\nproject: storefront\nunit: ${name}\nbudget: ${budget.toFixed(2)}\n---\n\n# ${name}\n\nBudget-gate test fixture unit.\n`,
  );
  const started = await resolveGate(root, "storefront", name, "start" as Verb, { memberRunner: stubAdapterRunner(loadRepo(root)), today: "2026-07-12" });
  if (!started.ok) throw new Error(`seed start failed: ${(started as { error: string }).error}`);
  const approved = await resolveGate(root, "storefront", `product-brief-${name}-v1`, "approve" as Verb, { today: "2026-07-12" });
  if (!approved.ok) throw new Error(`seed approve failed: ${(approved as { error: string }).error}`);
  return unitDir;
}

describe("(h) C3 extended: a budget gate halts ONLY its own unit; other units in the project keep advancing", () => {
  test("the over-budget unit sits at its gate and never advances until resolved; a sibling unit advances normally throughout", async () => {
    // over-budget: $0.06 already spent (its approved brief) against a $0.01 budget → next walk is a gate.
    const overDir = await seedFeatureUnit(root, "over-unit", 0.01);
    // solvent: same project, a budget far above its spend → nothing stops it advancing.
    const solventDir = await seedFeatureUnit(root, "solvent-unit", 15.0);

    const daemon = new Daemon(root, { memberRunner: stubAdapterRunner });

    // First tick: the over-budget unit halts AT its budget gate (produces nothing); the solvent unit
    // advances one step (design) — a per-unit halt, never a global stop.
    const r1 = await daemon.tick();
    expect(r1.entries.find((e) => e.unit === "over-unit")!.outcome.outcome).toBe("budget-gate");
    expect(r1.entries.find((e) => e.unit === "solvent-unit")!.outcome.outcome).toBe("produced");
    expect(existsSync(join(overDir, "design-over-unit-v1.md"))).toBe(false);
    expect(existsSync(join(solventDir, "design-solvent-unit-v1.md"))).toBe(true);
    expect(daemon.budgetGates().map((g) => g.unit)).toEqual(["over-unit"]);

    // Many more ticks: the over-budget unit STILL never advances (no design file ever appears) — the
    // daemon does not cross its budget gate on its own, no matter how many times it ticks (the exact
    // shape of the start-gate invariant, applied to the budget gate).
    for (let i = 0; i < 5; i++) await daemon.tick();
    expect(existsSync(join(overDir, "design-over-unit-v1.md"))).toBe(false);
    // The solvent unit, meanwhile, reached and halted at its own (flow) gate — it advanced freely.
    expect(existsSync(join(solventDir, "design-solvent-unit-v1.md"))).toBe(true);

    // Only when the Conductor resolves the over-unit's budget gate does it advance — proving the halt
    // was the budget gate, not some unrelated block.
    const resolved = daemon.resolveBudget("storefront", "over-unit", "continue");
    expect(resolved.ok).toBe(true);
    await daemon.tick();
    expect(existsSync(join(overDir, "design-over-unit-v1.md"))).toBe(true);
  });
});

describe("(i) C3 extended: `continue` suppresses re-raising until a new threshold; `raise` lifts the effective budget", () => {
  test("continue lets the walk resume and the gate re-raises only when spend crosses a NEW threshold; raise updates the effective budget for the run", async () => {
    // --- continue path ---
    // brief spent $0.06 against a $0.05 budget → over budget immediately.
    const contDir = await seedFeatureUnit(root, "cont-unit", 0.05);
    const daemon = new Daemon(root, { memberRunner: stubAdapterRunner });

    const c1 = await daemon.tick();
    expect(c1.entries.find((e) => e.unit === "cont-unit")!.outcome.outcome).toBe("budget-gate");
    const gate1 = daemon.budgetGates().find((g) => g.unit === "cont-unit")!;
    expect(gate1.spent).toBeCloseTo(0.06, 5);

    // continue acknowledges $0.06 — the next tick is NOT re-raised at the same spend; the unit advances
    // one step (design), pushing spend to $0.16.
    expect(daemon.resolveBudget("storefront", "cont-unit", "continue").ok).toBe(true);
    const c2 = await daemon.tick();
    expect(c2.entries.find((e) => e.unit === "cont-unit")!.outcome.outcome).toBe("produced");
    expect(existsSync(join(contDir, "design-cont-unit-v1.md"))).toBe(true);
    expect(daemon.budgetGates().some((g) => g.unit === "cont-unit")).toBe(false);

    // The NEW spend level ($0.16) crosses beyond the acknowledged $0.06 → the gate re-raises. So
    // `continue` suppressed re-raising ONLY until a new threshold, exactly as C3's memory rule requires.
    const c3 = await daemon.tick();
    expect(c3.entries.find((e) => e.unit === "cont-unit")!.outcome.outcome).toBe("budget-gate");
    expect(daemon.budgetGates().find((g) => g.unit === "cont-unit")!.spent).toBeCloseTo(0.16, 5);

    // --- raise path ---
    const raiseDir = await seedFeatureUnit(root, "raise-unit", 0.05);
    const r1 = await daemon.tick();
    expect(r1.entries.find((e) => e.unit === "raise-unit")!.outcome.outcome).toBe("budget-gate");
    // No effective budget lifted yet — the unit is over its declared $0.05.
    expect(daemon.effectiveBudget("storefront", "raise-unit")).toBeUndefined();

    // raise lifts the effective budget to the current spend ($0.06) for the rest of the run.
    expect(daemon.resolveBudget("storefront", "raise-unit", "raise").ok).toBe(true);
    const eff = daemon.effectiveBudget("storefront", "raise-unit");
    expect(eff).toBeCloseTo(0.06, 5);
    expect(eff!).toBeGreaterThan(0.05); // strictly above the original declared budget — it moved.

    // With the effective budget lifted to $0.06, the unit is no longer over budget and advances.
    const r2 = await daemon.tick();
    expect(r2.entries.find((e) => e.unit === "raise-unit")!.outcome.outcome).toBe("produced");
    expect(existsSync(join(raiseDir, "design-raise-unit-v1.md"))).toBe(true);
  });
});

describe("(j) C3 extended: `stop` pauses the unit so the daemon skips it thereafter", () => {
  test("resolving a budget gate with stop pauses the unit on disk; the daemon no longer walks it", async () => {
    const dir = await seedFeatureUnit(root, "stop-unit", 0.05);
    const daemon = new Daemon(root, { memberRunner: stubAdapterRunner });

    expect((await daemon.tick()).entries.find((e) => e.unit === "stop-unit")!.outcome.outcome).toBe("budget-gate");
    expect(daemon.resolveBudget("storefront", "stop-unit", "stop").ok).toBe(true);

    // Persisted to disk (files are the truth): the unit is paused, and a paused unit is invisible to
    // the walk — no design is ever produced.
    expect(readFileSync(join(dir, "unit.md"), "utf8")).toContain("status: paused");
    for (let i = 0; i < 3; i++) await daemon.tick();
    expect(existsSync(join(dir, "design-stop-unit-v1.md"))).toBe(false);
    // The gate is cleared — a stopped unit is not still "awaiting the Conductor".
    expect(daemon.budgetGates().some((g) => g.unit === "stop-unit")).toBe(false);
  });
});

import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, cpSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.ts";
import { resolveGate } from "../src/board/gateops.ts";
import { stubAdapterRunner } from "../src/replay.ts";
import { runReplay } from "../src/replay.ts";
import { loadRepo } from "../src/repo.ts";
import type { AsyncMemberRunner } from "../src/dagwalk.ts";
import type { Verb } from "../src/runner.ts";

// Ruling C14 (NOTES.md): a loop must actually loop on the live path. Before this fix, dagwalk.ts
// auto-advanced only a loop's FIRST member and documented the companion as never auto-produced — the
// exact live defect a real studio's author/critic loop hit (one artifact, then a silent halt). These
// tests exercise the fix from three angles: (1) an end-to-end scratch studio proving both members run,
// in order, with the critic consuming the author's own artifact, and that a satisfied `until` ends the
// loop and lets the walk continue past it; (2) a non-converging loop exhausting at max_rounds and
// raising an on_exhaust gate naming the round count; (3) the batch Runner (runner.ts) and the live
// dagwalk walk producing the SAME member-invocation sequence for the golden fixture's own flow — the
// cross-engine equivalence test NOTES R3 asked for, so a future divergence between the two engines
// fails the suite instead of shipping unnoticed.

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

function seedGoldenScratch(): string {
  const root = mkdtempSync(join(tmpdir(), "levare-c14-golden-"));
  cpSync("fixtures/golden", root, { recursive: true });
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "seed golden fixture"]);
  return root;
}

// ---------------------------------------------------------------------------
// (1) A minimal, self-contained scratch studio matching the goal's own live-bug shape verbatim:
// team `press`, members scribe (author, product-brief) / corvid (critic, review), flow: [loop, gate:
// human]. Fully independent of fixtures/golden — no team here overlaps kestrel's kinds, so there is
// no produces∩expects ambiguity to work around.
// ---------------------------------------------------------------------------

const TYPE_FEATURE = `---
name: feature
glyph: "▸"
expects: [product-brief, review]
gates: [brief, review]
output: review
---

# Feature

Minimal feature type for the C14 author/critic loop test.
`;

const PROJECT_ACME = `---
name: acme
repo: .
remote: null
default_branch: main
deploy: null
pace: auto
---

# Acme
`;

const TEAM_PRESS = `---
name: press
consumes: []
produces: [product-brief, review]
members: [scribe, corvid]
flow:
  - loop:
      between: [product-brief, review]
      until: review.approved
      max_rounds: 3
      on_exhaust: gate
  - gate: human
style:
  color: "#4B2E83"
---

# Press — author/critic loop

Scribe drafts, corvid reviews. The loop repeats until corvid approves.
`;

const AGENT_SCRIBE = `---
name: scribe
kind: native
produces: [product-brief]
model: claude-sonnet-5
style:
  avatar: Sc
---

# Scribe

Drafts the product brief.
`;

const AGENT_CORVID = `---
name: corvid
kind: native
produces: [review]
model: claude-sonnet-5
style:
  avatar: Co
---

# Corvid

Reviews the product brief.
`;

const UNIT_ANNOUNCEMENT = `---
type: feature
status: active
project: acme
unit: announcement
---

# Announcement

A press-release work unit exercising the author/critic loop.
`;

function seedPressStudio(): string {
  const root = mkdtempSync(join(tmpdir(), "levare-c14-press-"));
  mkdirSync(join(root, "types"), { recursive: true });
  mkdirSync(join(root, "projects"), { recursive: true });
  mkdirSync(join(root, "teams"), { recursive: true });
  mkdirSync(join(root, "agents"), { recursive: true });
  mkdirSync(join(root, "work/acme/announcement"), { recursive: true });
  writeFileSync(join(root, "types/feature.md"), TYPE_FEATURE);
  writeFileSync(join(root, "projects/acme.md"), PROJECT_ACME);
  writeFileSync(join(root, "teams/press.md"), TEAM_PRESS);
  writeFileSync(join(root, "agents/scribe.md"), AGENT_SCRIBE);
  writeFileSync(join(root, "agents/corvid.md"), AGENT_CORVID);
  writeFileSync(join(root, "work/acme/announcement/unit.md"), UNIT_ANNOUNCEMENT);
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "seed press studio"]);
  return root;
}

// A minimal AsyncMemberRunner that bakes `extraConsumes` straight into the returned doc's own
// `consumes:` — the whole point is to observe, at the boundary, exactly what dagwalk.ts hands the
// critic, without going through AdapterRunner's own (separately-tested) context assembly.
function pressRunner(): { runner: AsyncMemberRunner; calls: Array<{ member: string; kind: string; extraConsumes: string[] }> } {
  const calls: Array<{ member: string; kind: string; extraConsumes: string[] }> = [];
  return {
    calls,
    runner: {
      capabilities: () => [
        { member: "scribe", kind: "product-brief" },
        { member: "corvid", kind: "review" },
      ],
      produce: (member, kind, unit, project, extraConsumes = []) => {
        calls.push({ member, kind, extraConsumes: [...extraConsumes] });
        const doc = [
          "---",
          `kind: ${kind}`,
          "id: placeholder",
          `unit: ${unit}`,
          `project: ${project}`,
          "status: in-review",
          `produced_by: press/${member}`,
          `consumes: [${extraConsumes.join(", ")}]`,
          "supersedes: null",
          "approved_by: null",
          "created: 2026-07-14",
          "files: []",
          "---",
          "",
          `# ${kind}`,
          "",
          `Drafted by ${member}.`,
          "",
        ].join("\n");
        return { doc };
      },
    },
  };
}

describe("C14: the live walk dispatches BOTH loop members", () => {
  test("scribe (author) then corvid (critic) run in order, the critic consumes the author's own artifact, and a satisfied `until` ends the loop and the walk continues past the trailing gate", async () => {
    const root = seedPressStudio();
    try {
      const { runner, calls } = pressRunner();
      const unitDir = join(root, "work/acme/announcement");
      const daemon = new Daemon(root, { memberRunner: () => runner });

      // Start: only the AUTHOR (scribe) runs — round 1 has no companion yet.
      const started = await resolveGate(root, "acme", "announcement", "start", { memberRunner: runner, today: "2026-07-14" });
      expect(started.ok).toBe(true);
      expect(calls).toEqual([{ member: "scribe", kind: "product-brief", extraConsumes: [] }]);
      expect(existsSync(join(unitDir, "product-brief-announcement-v1.md"))).toBe(true);
      expect(existsSync(join(unitDir, "review-announcement-v1.md"))).toBe(false);

      // The defect this ruling fixes: corvid was never dispatched. Now the very next walk produces
      // the critic's review, in the SAME round, with the author's (still in-review) brief as its
      // own consumed artifact.
      const tick1 = await daemon.tick();
      expect(calls).toEqual([
        { member: "scribe", kind: "product-brief", extraConsumes: [] },
        { member: "corvid", kind: "review", extraConsumes: ["product-brief-announcement-v1"] },
      ]);
      expect(existsSync(join(unitDir, "review-announcement-v1.md"))).toBe(true);
      const review = readFileSync(join(unitDir, "review-announcement-v1.md"), "utf8");
      expect(review).toContain("consumes: [product-brief-announcement-v1]");
      expect(tick1.entries.find((e) => e.unit === "announcement")!.outcome.outcome).toBe("produced");

      // Round complete: both sit in-review. The walk halts at the round's OUTCOME gate — never a
      // second, separate human gate for the companion (ruling C2, unchanged by C14).
      const tick2 = await daemon.tick();
      expect(tick2.entries.find((e) => e.unit === "announcement")!.outcome.outcome).toBe("halted");
      expect(calls.length).toBe(2); // no third invocation while the round awaits the Conductor.

      // The Conductor approves the AUTHOR's gate. Ruling C2/C14: this resolves the companion (review)
      // too, in the same commit — `until: review.approved` is now satisfied.
      const approved = await resolveGate(root, "acme", "product-brief-announcement-v1", "approve" as Verb, { memberRunner: runner, today: "2026-07-14" });
      expect(approved.ok).toBe(true);
      const reviewAfter = readFileSync(join(unitDir, "review-announcement-v1.md"), "utf8");
      expect(reviewAfter).toContain("status: approved");

      // The walk continues PAST the loop to the trailing `gate: human` (a structural marker only —
      // nothing left for the team to produce): the unit's flow is now fully satisfied, not halted.
      const tick3 = await daemon.tick();
      expect(tick3.entries.find((e) => e.unit === "announcement")!.outcome.outcome).toBe("nothing");
      expect(calls.length).toBe(2); // the loop never re-invokes either member once `until` holds.
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("C14: max_rounds/on_exhaust — a non-converging loop escalates, never spins, never gives up silently", () => {
  test("requesting changes at the final round is refused, naming the round count and the last review, instead of opening a 4th round", async () => {
    const root = seedGoldenScratch();
    try {
      const unitDir = join(root, "work/storefront/loyalty-flow");
      const runner = stubAdapterRunner(loadRepo(root));
      const daemon = new Daemon(root, { memberRunner: () => runner });

      await resolveGate(root, "storefront", "loyalty-flow", "start", { memberRunner: runner, today: "2026-07-12" });
      await resolveGate(root, "storefront", "product-brief-loyalty-flow-v1", "approve" as Verb, { today: "2026-07-12" });
      await daemon.tick(); // design
      await resolveGate(root, "storefront", "design-loyalty-flow-v1", "approve" as Verb, { today: "2026-07-12" });
      await daemon.tick(); // spec round 1
      await daemon.tick(); // review round 1
      expect(existsSync(join(unitDir, "spec-loyalty-flow-v1.md"))).toBe(true);
      expect(existsSync(join(unitDir, "review-loyalty-flow-v1.md"))).toBe(true);

      // Round 1 → round 2.
      const req1 = await resolveGate(root, "storefront", "spec-loyalty-flow-v1", "request" as Verb, { memberRunner: runner, note: "round 1", today: "2026-07-12" });
      expect(req1.ok).toBe(true);
      await daemon.tick(); // review round 2
      expect(existsSync(join(unitDir, "spec-loyalty-flow-v2.md"))).toBe(true);
      expect(existsSync(join(unitDir, "review-loyalty-flow-v2.md"))).toBe(true);

      // Round 2 → round 3 (the loop's max_rounds, per kestrel.md).
      const req2 = await resolveGate(root, "storefront", "spec-loyalty-flow-v2", "request" as Verb, { memberRunner: runner, note: "round 2", today: "2026-07-12" });
      expect(req2.ok).toBe(true);
      await daemon.tick(); // review round 3
      expect(existsSync(join(unitDir, "spec-loyalty-flow-v3.md"))).toBe(true);
      expect(existsSync(join(unitDir, "review-loyalty-flow-v3.md"))).toBe(true);

      // Round 3 IS the final round: requesting a 4th is refused — on_exhaust: gate — naming the round
      // count, max_rounds, and the last review, never silently opening spec-loyalty-flow-v4.
      const req3 = await resolveGate(root, "storefront", "spec-loyalty-flow-v3", "request" as Verb, { memberRunner: runner, note: "round 3", today: "2026-07-12" });
      expect(req3.ok).toBe(false);
      if (req3.ok) return;
      expect(req3.status).toBe(409);
      expect(req3.error).toContain("3/3");
      expect(req3.error).toContain("review-loyalty-flow-v3");
      expect(req3.error).toContain("on_exhaust");
      expect(existsSync(join(unitDir, "spec-loyalty-flow-v4.md"))).toBe(false);

      // The Conductor's only remaining moves are approve/reject; reject pauses the unit, never a spin.
      const rejected = await resolveGate(root, "storefront", "spec-loyalty-flow-v3", "reject" as Verb, { today: "2026-07-12" });
      expect(rejected.ok).toBe(true);
      const spec3 = readFileSync(join(unitDir, "spec-loyalty-flow-v3.md"), "utf8");
      expect(spec3).toContain("status: rejected");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("C14: the batch Runner (runner.ts) and the live dagwalk walk agree on member-invocation order (closing NOTES R3)", () => {
  test("the golden fixture's own flow produces the identical (member, kind) sequence on both engines", async () => {
    // Batch side: the golden replay scenario already scripts checkout-flow's flow end to end
    // (brief → design → spec/review loop, one request then an approve) — reuse it verbatim rather
    // than re-deriving a second copy of the same script.
    const batchEvents = runReplay("fixtures/golden").scenarios.find((s) => s.name === "golden")!.events;
    const batchSequence = batchEvents
      .filter((e): e is Extract<typeof e, { t: "produce" }> => e.t === "produce")
      .map((e) => ({ member: e.member.split("/")[1], kind: e.kind }));
    expect(batchSequence).toEqual([
      { member: "wren", kind: "product-brief" },
      { member: "lyra", kind: "design" },
      { member: "lyra", kind: "spec" },
      { member: "finch", kind: "review" },
      { member: "lyra", kind: "spec" },
      { member: "finch", kind: "review" },
    ]);

    // Live side: loyalty-flow is kestrel's OTHER unit — same team, same flow, same declared max_rounds
    // — but starts from a genuinely clean on-disk slate (unlike checkout-flow, which the golden fixture
    // seeds mid-loop), making it the fair live-path analog of the batch scenario's own fresh start.
    // Drive the identical decision shape: start, approve, approve, request, approve.
    const root = seedGoldenScratch();
    try {
      const runner = stubAdapterRunner(loadRepo(root));
      const liveSequence: Array<{ member: string; kind: string }> = [];
      const recording: AsyncMemberRunner = {
        capabilities: () => runner.capabilities(),
        produce: (member, kind, unit, project, extraConsumes) => {
          if (unit === "loyalty-flow") liveSequence.push({ member, kind });
          return runner.produce(member, kind, unit, project, extraConsumes);
        },
      };
      const liveDaemon = new Daemon(root, { memberRunner: () => recording });

      await resolveGate(root, "storefront", "loyalty-flow", "start", { memberRunner: recording, today: "2026-07-12" });
      await resolveGate(root, "storefront", "product-brief-loyalty-flow-v1", "approve" as Verb, { today: "2026-07-12" });
      await liveDaemon.tick(); // design
      await resolveGate(root, "storefront", "design-loyalty-flow-v1", "approve" as Verb, { today: "2026-07-12" });
      await liveDaemon.tick(); // spec round 1
      await liveDaemon.tick(); // review round 1
      await resolveGate(root, "storefront", "spec-loyalty-flow-v1", "request" as Verb, { memberRunner: recording, note: "more detail", today: "2026-07-12" });
      await liveDaemon.tick(); // review round 2
      await resolveGate(root, "storefront", "spec-loyalty-flow-v2", "approve" as Verb, { today: "2026-07-12" });
      await liveDaemon.tick(); // walk continues past the (now-satisfied) loop; nothing left to produce.

      expect(liveSequence).toEqual(batchSequence);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

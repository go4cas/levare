import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { assertSpawnOk } from "./spawn-helpers.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.ts";
import { resolveGate } from "../src/board/gateops.ts";
import { productionAdapterRunner } from "../src/replay.ts";
import { loadRepo } from "../src/repo.ts";
import { openGates } from "../src/derive.ts";
import type { NativeBoundary, AsyncNativeBoundary } from "../src/adapters.ts";
import type { Verb } from "../src/runner.ts";

// Live-incident regression (NOTES R4-SANDBOX-TLS goal, faults 2+3): a loop critic that gets blocked
// on its FIRST attempt (e.g. a transient network/TLS failure) and is retried through
// `resolveGate(..., "retry")` — the Conductor's own explicit re-invocation of a blocked artifact
// (NOTES F19) — used to (a) drop ruling C14's `extraConsumes`, so the retried critic's assembled
// context carried an EMPTY consumed-artifacts section despite `context_artifacts: inline` being
// correctly declared, and (b) bump `roundOf`/`bumpVersion` on every failed attempt, so N blocked
// retries before a genuine success inflated the loop's own `max_rounds` accounting — a loop that
// converged on attempt 5 after 4 infrastructure failures reported "round 5", not round 1, even
// though only one genuine author/critic exchange ever happened. Both tests below drive a REAL `bash`
// subprocess through `productionAdapterRunner` (the actual production wiring `daemon.ts`/
// `board/gateops.ts` use) — not a hand-rolled stand-in — so a regression here fails on what the
// member actually received, exactly as `tests/loop-critic-context.test.ts` (F15) already does for
// the live-walk's own first dispatch.

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

const BRIEF_MARKER = "ACME-BRIEF-42: ship the thing by Friday.";

const TYPE_FEATURE = `---
name: feature
glyph: "▸"
expects: [product-brief, review]
gates: [brief, review]
output: review
---

# Feature
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

// max_rounds: 3 — the loop's real budget. `failCount` (below) fails corvid MORE than 3 times before
// it succeeds, so the pre-fix behaviour ("every retry burns a round") would report a round past this
// cap; the fix's behaviour (a blocked retry never spends a round) must still read round 1 throughout.
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

# Press — author/critic loop, blocked-retry regression
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

// A REAL subprocess that fails (simulating a transient TLS/network fault) on its first `failCount`
// invocations, then echoes stdin (the assembled §6 context) exactly like `cat` — the same technique
// `tests/loop-critic-context.test.ts` (F15) uses to assert on what a member actually received, here
// extended across a blocked → retry → retry → … → success chain rather than a single dispatch.
//
// `cwd: <root>` is declared explicitly (host-only regression, see NOTES): corvid's own dispatch has no
// real project checkout (`PROJECT_ACME`'s `repo: .` is self-referential, so `resolveProjectRepoPath`
// deliberately returns undefined — merge.ts's own exclusion) and no `home:`-requesting connector, so
// with no declared `cwd` the spawn's cwd falls back to `process.cwd()` — wherever `bun test` itself
// runs from, NOT this test's own scratch `root`. Under a REAL macOS `sandbox-exec` profile, ONLY the
// resolved cwd (and the spawn's own HOME) ever gets a write grant — writing the attempt counter
// anywhere else, including this test's own `root`, is correctly DENIED, the script exits 1 on its very
// first attempt for a reason that has nothing to do with the fix under test, and the counter never
// advances. Declaring `cwd: root` here makes the counter file land inside the one path the generated
// profile actually grants, on every platform — the studio's own `work/` tree is nested under it too, so
// nothing else about the fixture needs to move.
function agentCorvid(mode: "paths" | "inline", root: string, counterFile: string, failCount: number): string {
  const script = `n=$(cat '${counterFile}' 2>/dev/null || echo 0); n=$((n+1)); echo $n > '${counterFile}'; if [ "$n" -le ${failCount} ]; then echo "simulated TLS failure attempt $n" >&2; exit 1; fi; cat`;
  return `---
name: corvid
kind: cli
produces: [review]
command: ["bash", "-c", ${JSON.stringify(script)}]
cwd: ${JSON.stringify(root)}
context_via: stdin
context_artifacts: ${mode}
timeout: 30
result: "Emits a review artifact markdown file to stdout."
style:
  avatar: Co
---

# Corvid

Reviews the product brief — fails ${failCount} times (simulated infrastructure fault) before it
finally runs for real.
`;
}

const UNIT_ANNOUNCEMENT = `---
type: feature
status: active
project: acme
unit: announcement
---

# Announcement
`;

function seedPressStudio(mode: "paths" | "inline", failCount: number): { root: string; counterFile: string } {
  const root = mkdtempSync(join(tmpdir(), `levare-f21-${mode}-`));
  const counterFile = join(root, ".corvid-attempts");
  mkdirSync(join(root, "types"), { recursive: true });
  mkdirSync(join(root, "projects"), { recursive: true });
  mkdirSync(join(root, "teams"), { recursive: true });
  mkdirSync(join(root, "agents"), { recursive: true });
  mkdirSync(join(root, "work/acme/announcement"), { recursive: true });
  writeFileSync(join(root, "types/feature.md"), TYPE_FEATURE);
  writeFileSync(join(root, "projects/acme.md"), PROJECT_ACME);
  writeFileSync(join(root, "teams/press.md"), TEAM_PRESS);
  writeFileSync(join(root, "agents/scribe.md"), AGENT_SCRIBE);
  writeFileSync(join(root, "agents/corvid.md"), agentCorvid(mode, root, counterFile, failCount));
  writeFileSync(join(root, "work/acme/announcement/unit.md"), UNIT_ANNOUNCEMENT);
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "seed press studio"]);
  return { root, counterFile };
}

const scribeNative: NativeBoundary = {
  invoke: () => ({ doc: `# Product brief\n\n${BRIEF_MARKER}\n` }),
};
const scribeAsyncNative: AsyncNativeBoundary = { invoke: async (r) => scribeNative.invoke(r) };

describe("F21: a blocked loop critic's retry keeps the round's consumed set and never spends a round", () => {
  for (const mode of ["inline", "paths"] as const) {
    test(`context_artifacts: ${mode} — a retried corvid still receives the author artifact, and the review keeps its round-1 id`, async () => {
      const failCount = 4; // more than max_rounds (3) — proves a blocked retry never spends a round.
      const { root, counterFile } = seedPressStudio(mode, failCount);
      try {
        const runner = productionAdapterRunner(loadRepo(root), { native: scribeNative, asyncNative: scribeAsyncNative });
        const unitDir = join(root, "work/acme/announcement");
        const daemon = new Daemon(root, { memberRunner: () => runner });

        await resolveGate(root, "acme", "announcement", "start", { memberRunner: runner, today: "2026-08-13" });
        expect(readFileSync(join(unitDir, "product-brief-announcement-v1.md"), "utf8")).toContain(BRIEF_MARKER);

        // First dispatch: corvid's own script fails (attempt 1 of failCount) — the live walk's own
        // writeBlocked path (dagwalk.ts), unrelated to the retry fix, just gets us to a blocked gate.
        await daemon.tick();
        const reviewFile = join(unitDir, "review-announcement-v1.md");
        expect(readFileSync(reviewFile, "utf8")).toContain("status: blocked");

        // Retry repeatedly through the SAME Conductor-triggered path the live incident used
        // (board/gateops.ts#resolveGate "retry") until corvid's script finally succeeds.
        let result;
        for (let i = 0; i < failCount; i++) {
          result = await resolveGate(root, "acme", "review-announcement-v1", "retry" as Verb, { memberRunner: runner, today: "2026-08-13" });
        }
        expect(result!.ok).toBe(true);

        // Exactly one review file ever existed for this unit — every retry (failed or successful)
        // rewrote the SAME slot in place; a pre-fix retry would have left review-announcement-v2..v5
        // scattered across the directory (one new -vN file per attempt).
        const reviewFiles = readdirSync(unitDir).filter((f) => f.startsWith("review-announcement"));
        expect(reviewFiles).toEqual(["review-announcement-v1.md"]);

        const review = readFileSync(reviewFile, "utf8");
        // NOTES: this round's own recurring pattern (a test passing because its environment never
        // exercised the constraint under test — see NOTES's "environment-blind tests" entry) is
        // surfaced here rather than left silent: `sandbox:` names the level THIS run actually engaged
        // (`none` in a container with no working primitive; `full` on a host with a real one). A "3
        // pass" line alone cannot distinguish those two cases — this makes the difference visible in
        // every run's own output, not just discoverable by re-deriving it from the host after the fact.
        console.log(`        [F21 ${mode}] sandbox level this run engaged: ${/^sandbox: .+$/m.exec(review)?.[0] ?? "(not reported)"}`);
        expect(review).toContain("status: in-review");
        expect(review).toContain("id: review-announcement-v1"); // round never bumped by a blocked retry.
        expect(review).toMatch(/consumes:\s*\[[^\]]*product-brief-announcement-v1[^\]]*\]/); // F15's own assertion, now proven across a retry too.

        if (mode === "inline") {
          expect(review).toContain(BRIEF_MARKER); // the retried context assembly actually inlined it.
          expect(review).toContain("── consumed artifact: product-brief-announcement-v1");
        } else {
          expect(review).toContain("work/acme/announcement/product-brief-announcement-v1.md");
          expect(review).not.toContain(BRIEF_MARKER);
        }

        // The loop's own round accounting (openGates → derive.ts, the SAME field F20's board card
        // reads) must still read round 1/3 — never having climbed toward, let alone past, max_rounds
        // just because corvid needed 4 infrastructure retries to get there.
        const repo = loadRepo(root, { validate: false });
        const gate = openGates(repo).find((g) => g.target === "review-announcement-v1");
        expect(gate).toBeDefined();
        expect(gate!.loop).toEqual({ round: 1, maxRounds: 3, until: "review.approved", exhausted: false, companionKind: "product-brief" });

        expect(readFileSync(counterFile, "utf8").trim()).toBe(String(failCount + 1)); // every attempt really ran.
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  test("a round genuinely never exceeds max_rounds: many more blocked retries than max_rounds still reads round 1", async () => {
    const failCount = 7; // more than double max_rounds (3).
    const { root } = seedPressStudio("inline", failCount);
    try {
      const runner = productionAdapterRunner(loadRepo(root), { native: scribeNative, asyncNative: scribeAsyncNative });
      const daemon = new Daemon(root, { memberRunner: () => runner });
      await resolveGate(root, "acme", "announcement", "start", { memberRunner: runner, today: "2026-08-13" });
      await daemon.tick(); // first (blocked) dispatch

      for (let i = 0; i < failCount; i++) {
        await resolveGate(root, "acme", "review-announcement-v1", "retry" as Verb, { memberRunner: runner, today: "2026-08-13" });
      }

      const repo = loadRepo(root, { validate: false });
      const gate = openGates(repo).find((g) => g.target === "review-announcement-v1");
      expect(gate).toBeDefined();
      expect(gate!.loop!.round).toBeLessThanOrEqual(gate!.loop!.maxRounds); // the property under test: never exceeded.
      expect(gate!.loop!.round).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

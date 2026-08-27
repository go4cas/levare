import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { assertSpawnOk } from "./spawn-helpers.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cpSync } from "node:fs";
import { Daemon } from "../src/daemon.ts";
import { resolveGate } from "../src/board/gateops.ts";
import { productionAdapterRunner, stubAdapterRunner } from "../src/replay.ts";
import { loadRepo } from "../src/repo.ts";
import { scoreNodes } from "../src/derive.ts";
import type { NativeBoundary, AsyncNativeBoundary } from "../src/adapters.ts";
import type { Verb } from "../src/runner.ts";

// Finding 145 site 2: `scoreNodes` (derive.ts) only ever consulted a live daemon invocation when NO
// artifact of that kind existed yet — but loop redo (`board/gateops.ts`'s own `reinvokeKind`) and
// blocked-artifact retry (`resolveBlockedArtifactGate`) both leave the artifact being replaced on disk
// for the whole in-flight window, so the score rail kept demanding Conductor action (a stale `blocked`
// or `gate` node) while the replacement was actively being produced. Fixed by consulting `inv` before
// the "no artifact yet" check, not only inside it.

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

// ---------------------------------------------------------------------------
// Blocked-artifact retry vs. the rail's "blocked" node.
// ---------------------------------------------------------------------------

const TODAY_BLOCKED = "2026-08-13";

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

# Press
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
`;

function agentCorvid(root: string, counterFile: string, failCount: number): string {
  const script = `n=$(cat '${counterFile}' 2>/dev/null || echo 0); n=$((n+1)); echo $n > '${counterFile}'; if [ "$n" -le ${failCount} ]; then echo "simulated failure attempt $n" >&2; exit 1; fi; cat`;
  return `---
name: corvid
kind: cli
produces: [review]
command: ["bash", "-c", ${JSON.stringify(script)}]
cwd: ${JSON.stringify(root)}
context_via: stdin
context_artifacts: inline
timeout: 30
result: "Emits a review artifact markdown file to stdout."
style:
  avatar: Co
---

# Corvid
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

function seedPressStudio(failCount: number): { root: string; counterFile: string } {
  const root = mkdtempSync(join(tmpdir(), "levare-f145-press-"));
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
  writeFileSync(join(root, "agents/corvid.md"), agentCorvid(root, counterFile, failCount));
  writeFileSync(join(root, "work/acme/announcement/unit.md"), UNIT_ANNOUNCEMENT);
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "seed press studio"]);
  return { root, counterFile };
}

const scribeNative: NativeBoundary = { invoke: () => ({ doc: `# Product brief\n\nShip it.\n` }) };
const scribeAsyncNative: AsyncNativeBoundary = { invoke: async (r) => scribeNative.invoke(r) };

describe("Finding 145 site 2: a blocked-artifact retry vs. the rail's stale 'blocked' node", () => {
  test("with a blocked retry in flight, the review node renders active, not the stale blocked state; settled with no invocation is unchanged", async () => {
    const failCount = 1;
    const { root } = seedPressStudio(failCount);
    try {
      const runner = productionAdapterRunner(loadRepo(root), { native: scribeNative, asyncNative: scribeAsyncNative });
      const daemon = new Daemon(root, { memberRunner: () => runner });
      await resolveGate(root, "acme", "announcement", "start", { memberRunner: runner, today: TODAY_BLOCKED });
      await daemon.tick(); // corvid's first attempt fails → review-announcement-v1 is blocked.

      let repo = loadRepo(root, { validate: false });
      const unit = repo.units.find((u) => u.unit === "announcement")!;
      const beforeNodes = scoreNodes(repo, unit);
      const beforeReview = beforeNodes.find((n) => n.kind === "review")!;
      expect(beforeReview.state).toBe("blocked");

      // Simulate the retry's in-flight window (board/gateops.ts#resolveBlockedArtifactGate registers
      // exactly this shape before awaiting `memberRunner.produce`) — the blocked artifact is still on
      // disk, unmodified, throughout.
      const invocation = daemon.beginInvocation({ project: "acme", unit: "announcement", member: "corvid", kind: "review" });
      try {
        const duringNodes = scoreNodes(repo, unit, daemon.running());
        const duringReview = duringNodes.find((n) => n.kind === "review")!;
        expect(duringReview.state).toBe("active");
        expect(duringReview.shape).toBe("dot");
      } finally {
        daemon.endInvocation(invocation);
      }

      // No live invocation for this unit any more — a settled (still-blocked) node reads exactly as
      // it did before the retry began.
      const afterNodes = scoreNodes(repo, unit, daemon.running());
      expect(afterNodes.find((n) => n.kind === "review")).toEqual(beforeReview);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Loop redo: the golden fixture's kestrel loop, mid-round, redo in flight.
// ---------------------------------------------------------------------------

function seedGoldenScratch(): string {
  const root = mkdtempSync(join(tmpdir(), "levare-f145-golden-"));
  cpSync("fixtures/golden", root, { recursive: true });
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "seed golden fixture"]);
  return root;
}

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

describe("Finding 145 site 2: a loop redo vs. the rail's stale companion/gate node", () => {
  test("with a loop redo in flight for a kind that already has a stale in-review artifact, that node renders active", async () => {
    const root = seedGoldenScratch();
    try {
      await driveToOpenLoopRound(root);
      const repo = loadRepo(root, { validate: false });
      const unit = repo.units.find((u) => u.project === "storefront" && u.unit === "loyalty-flow")!;

      const beforeNodes = scoreNodes(repo, unit);
      const beforeReview = beforeNodes.find((n) => n.kind === "review")!;
      expect(beforeReview.state).toBe("gate"); // still in-review on disk — the companion's stale rendering pre-fix.

      // Simulate `reinvokeKind`'s in-flight window (board/gateops.ts:508) — the old `review` artifact
      // stays in-review on disk for the whole async gap, exactly as it does mid-redo.
      const daemon = new Daemon(root, { memberRunner: () => stubAdapterRunner(repo) });
      const invocation = daemon.beginInvocation({ project: "storefront", unit: "loyalty-flow", member: "finch", kind: "review" });
      try {
        const duringNodes = scoreNodes(repo, unit, daemon.running());
        const duringReview = duringNodes.find((n) => n.kind === "review")!;
        expect(duringReview.state).toBe("active");
      } finally {
        daemon.endInvocation(invocation);
      }

      const afterNodes = scoreNodes(repo, unit, daemon.running());
      expect(afterNodes.find((n) => n.kind === "review")).toEqual(beforeReview);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

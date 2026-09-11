import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { assertSpawnOk } from "./spawn-helpers.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.ts";
import { resolveGate } from "../src/board/gateops.ts";
import { productionAdapterRunner } from "../src/replay.ts";
import { loadRepo } from "../src/repo.ts";
import type { NativeBoundary, AsyncNativeBoundary } from "../src/adapters.ts";

// Goal: a loop's author redo (board/gateops.ts#doRequest, the "request changes" verb resolved against
// the CRITIC's own gate — ruling F16 redirects that to re-invoke the AUTHOR) must actually receive (a)
// the round's live companion review in its consumed set, and (b) the Conductor's own note. Today
// `doRequest` calls `memberRunner.produce(reinvokeMember, reinvokeKind, art.unit, art.project)` with no
// 5th `extraConsumes` argument and never threads `note` into context assembly at all — mirroring F15's
// own test technique (a real, unmocked `cat` subprocess as the member under test, so the assertion is on
// what the member ACTUALLY RECEIVED, not a hand-rolled stand-in that would pass by construction).

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

// until: review.approved — the CRITIC (review) is the loop's gate artifact, so a "request" resolved
// against it redirects to re-invoke the AUTHOR (scribe) for round 2, per ruling F16.
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

# Press — author/critic loop, request-changes redo regression
`;

// scribe (the AUTHOR — who gets re-invoked on request-changes) is a REAL, unmocked \`cat\` subprocess:
// its own stdout is exactly its stdin (the assembled §6 context), so the test can assert on what it
// actually received rather than trusting a mock's own account.
const AGENT_SCRIBE = `---
name: scribe
kind: cli
produces: [product-brief]
command: ["cat"]
context_via: stdin
context_artifacts: inline
timeout: 30
result: "Emits a product-brief artifact markdown file to stdout."
style:
  avatar: Sc
---

# Scribe

Drafts the product brief (a real, unmocked \`cat\` subprocess — echoes its own stdin).
`;

const REVIEW_MARKER = "CORVID-REVIEW-77: the pricing section is missing a citation.";

const corvidNative: NativeBoundary = {
  invoke: () => ({ doc: `# Review\n\n${REVIEW_MARKER}\n` }),
};
const corvidAsyncNative: AsyncNativeBoundary = { invoke: async (r) => corvidNative.invoke(r) };

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
`;

function seedPressStudio(): string {
  const root = mkdtempSync(join(tmpdir(), "levare-request-changes-context-"));
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

describe("a loop author's request-changes redo actually receives the companion review and the Conductor's note", () => {
  test("round-2 scribe (the author) receives round-1's review in its consumed set, and the Conductor's note in its context", async () => {
    const root = seedPressStudio();
    try {
      const runner = productionAdapterRunner(loadRepo(root), { native: corvidNative, asyncNative: corvidAsyncNative });
      const unitDir = join(root, "work/acme/announcement");
      const daemon = new Daemon(root, { memberRunner: () => runner });

      // Round 1: scribe (author) runs alone, then corvid (critic) runs with scribe's artifact in its
      // own consumed set (F15 territory, already fixed — not under test here).
      const started = await resolveGate(root, "acme", "announcement", "start", { memberRunner: runner, today: "2026-09-11" });
      expect(started.ok).toBe(true);
      expect(existsSync(join(unitDir, "product-brief-announcement-v1.md"))).toBe(true);

      await daemon.tick();
      const reviewFile = join(unitDir, "review-announcement-v1.md");
      expect(existsSync(reviewFile)).toBe(true);
      expect(readFileSync(reviewFile, "utf8")).toContain("status: in-review");

      // The Conductor requests changes against the CRITIC's own gate (review-announcement-v1) — F16
      // redirects this to re-invoke the AUTHOR (scribe) for round 2.
      const NOTE = "Please add a citation for the pricing claim in section 2.";
      const result = await resolveGate(root, "acme", "review-announcement-v1", "request", { memberRunner: runner, note: NOTE, today: "2026-09-11" });
      expect(result.ok).toBe(true);

      const briefV2File = join(unitDir, "product-brief-announcement-v2.md");
      expect(existsSync(briefV2File)).toBe(true);
      const briefV2 = readFileSync(briefV2File, "utf8");

      // (a) the round's live companion review must be in the redo's consumed set — the exact
      // `extraConsumes` seam ruling C14 established and F15/F19 already fixed for the live-walk
      // dispatch and the blocked-retry path. `doRequest`'s own redo call site never threads it.
      expect(briefV2).toMatch(/consumes:\s*\[[^\]]*review-announcement-v1[^\]]*\]/);

      // scribe is a real `cat` subprocess — its own produced body IS exactly the context it received
      // (ruling C12). The assembled context must actually have contained the prior review's content
      // (inline mode) and, since it was still only `in-review` on disk when produce() was called
      // (approved in the SAME transaction, after produce() returns), it only lands in the consumed set
      // at all via `extraConsumes` — the same mechanism (a) checks from the other direction.
      expect(briefV2).toContain(REVIEW_MARKER);

      // (b) the Conductor's own note must reach the author's context, as a distinct, labelled section —
      // not smuggled into the unit body, and not simply absent (context.ts's recipe today has no
      // section for it at all).
      expect(briefV2).toContain(NOTE);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

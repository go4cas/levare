import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.ts";
import { resolveGate } from "../src/board/gateops.ts";
import { productionAdapterRunner } from "../src/replay.ts";
import { loadRepo } from "../src/repo.ts";
import type { NativeBoundary, AsyncNativeBoundary } from "../src/adapters.ts";

// Ruling F15: the loop's companion (critic) member received NO consumed artifact on the live path —
// `consumes: []` on the produced review, even though C14 added `extraConsumes` for exactly this seam.
// Root cause: `replay.ts#productionAdapterRunner` (the ACTUAL production wiring `daemon.ts`/
// `board/gateops.ts` use) built its returned `produce()` closure over only 4 of the 5 parameters —
// `extraConsumes` was silently dropped before it ever reached `AdapterRunner.produceAsync`, even
// though dagwalk.ts and AdapterRunner itself already threaded it correctly. These tests dispatch a
// real loop's critic through `productionAdapterRunner` itself (not a hand-rolled stand-in that would
// pass by construction) and assert on what the member ACTUALLY RECEIVED: corvid is a real, unmocked
// `cat` subprocess (ruling C9's own test technique) whose stdout — the artifact's own body, ruling
// C12 — is exactly the assembled §6 context handed to it. `context_artifacts: inline` must contain the
// author's artifact body verbatim; `context_artifacts: paths` must contain its path instead. Either
// way, the produced review's own `consumes:` must name the author's artifact.

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

# Press — author/critic loop (F15 regression)
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

function agentCorvid(mode: "paths" | "inline"): string {
  return `---
name: corvid
kind: cli
produces: [review]
command: ["cat"]
context_via: stdin
context_artifacts: ${mode}
timeout: 30
result: "Emits a review artifact markdown file to stdout."
style:
  avatar: Co
---

# Corvid

Reviews the product brief (a real, unmocked \`cat\` subprocess — echoes its own stdin).
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

function seedPressStudio(mode: "paths" | "inline"): string {
  const root = mkdtempSync(join(tmpdir(), `levare-f15-${mode}-`));
  mkdirSync(join(root, "types"), { recursive: true });
  mkdirSync(join(root, "projects"), { recursive: true });
  mkdirSync(join(root, "teams"), { recursive: true });
  mkdirSync(join(root, "agents"), { recursive: true });
  mkdirSync(join(root, "work/acme/announcement"), { recursive: true });
  writeFileSync(join(root, "types/feature.md"), TYPE_FEATURE);
  writeFileSync(join(root, "projects/acme.md"), PROJECT_ACME);
  writeFileSync(join(root, "teams/press.md"), TEAM_PRESS);
  writeFileSync(join(root, "agents/scribe.md"), AGENT_SCRIBE);
  writeFileSync(join(root, "agents/corvid.md"), agentCorvid(mode));
  writeFileSync(join(root, "work/acme/announcement/unit.md"), UNIT_ANNOUNCEMENT);
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "seed press studio"]);
  return root;
}

// Scribe's own native invocation is mocked (no real SDK call in a hermetic test) — but corvid, the
// critic under test, is a REAL spawned `cat` process the whole way through `productionAdapterRunner`.
const scribeNative: NativeBoundary = {
  invoke: () => ({
    doc: `# Product brief\n\n${BRIEF_MARKER}\n`,
  }),
};
const scribeAsyncNative: AsyncNativeBoundary = { invoke: async (r) => scribeNative.invoke(r) };

describe("F15: a loop critic's assembled context actually contains the author's artifact", () => {
  for (const mode of ["inline", "paths"] as const) {
    test(`context_artifacts: ${mode} — corvid (a real \`cat\` subprocess) receives it, and the produced review's consumes: names it`, async () => {
      const root = seedPressStudio(mode);
      try {
        const runner = productionAdapterRunner(loadRepo(root), { native: scribeNative, asyncNative: scribeAsyncNative });
        const unitDir = join(root, "work/acme/announcement");
        const daemon = new Daemon(root, { memberRunner: () => runner });

        // Round 1: scribe (author) runs alone — no companion yet.
        const started = await resolveGate(root, "acme", "announcement", "start", { memberRunner: runner, today: "2026-07-14" });
        expect(started.ok).toBe(true);
        const briefFile = join(unitDir, "product-brief-announcement-v1.md");
        expect(existsSync(briefFile)).toBe(true);
        expect(readFileSync(briefFile, "utf8")).toContain(BRIEF_MARKER);

        // Corvid (the critic) is dispatched in the same round, with the author's still-in-review
        // artifact in ITS context — this is the exact seam F15 found broken on the live path.
        await daemon.tick();
        const reviewFile = join(unitDir, "review-announcement-v1.md");
        expect(existsSync(reviewFile)).toBe(true);
        const review = readFileSync(reviewFile, "utf8");

        // What corvid actually received (its own stdout, echoed by `cat`, IS the review's body — ruling
        // C12: the member's raw output is the artifact's content verbatim).
        if (mode === "inline") {
          // C9: a member that cannot open a path back into the studio gets the FULL TEXT — the
          // author's actual brief content must appear verbatim, not merely a pointer to it.
          expect(review).toContain(BRIEF_MARKER);
          expect(review).toContain("── consumed artifact: product-brief-announcement-v1");
        } else {
          // C9: a member with studio filesystem access gets a root-relative PATH, never the contents.
          expect(review).toContain("work/acme/announcement/product-brief-announcement-v1.md");
          expect(review).not.toContain(BRIEF_MARKER);
        }

        // Whichever mode delivered it, levare's own record of what the member consumed must name the
        // author's artifact — never `consumes: []` (the live bug's own frontmatter symptom).
        expect(review).toMatch(/consumes:\s*\[[^\]]*product-brief-announcement-v1[^\]]*\]/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

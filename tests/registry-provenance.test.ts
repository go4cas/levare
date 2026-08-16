import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, cpSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { assertSpawnOk, spawnStdout } from "./spawn-helpers.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGate } from "../src/board/gateops.ts";
import { stubAdapterRunner } from "../src/replay.ts";
import { loadRepo } from "../src/repo.ts";
import { Daemon } from "../src/daemon.ts";
import { dirtyRegistryFiles, registryStateHash } from "../src/git.ts";
import type { AsyncMemberRunner } from "../src/dagwalk.ts";

// Goal REGISTRY-PROVENANCE: everything a member PRODUCES commits itself automatically (the runner
// commits artifacts, gate resolutions commit as Conductor), but everything that GOVERNS a dispatch —
// teams/, agents/, connectors/, projects/, skills/, knowledge/, types/, studio.md — was previously
// committed only if the operator remembered to do it by hand. Part 1: refuse to dispatch (the `start`
// verb — the operator's own consent point) while the registry is dirty. Part 2: stamp every produced
// artifact with a content hash over the registry subtree, so a run is reconstructable independent of
// Part 1 ever firing.

const HERMETIC_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" };

function git(root: string, args: string[]): ReturnType<typeof spawnSync> {
  const r = spawnSync(
    "git",
    ["-C", root, "-c", "user.name=seed", "-c", "user.email=seed@levare.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "init.defaultBranch=main", ...args],
    { encoding: "utf8", env: HERMETIC_ENV },
  );
  assertSpawnOk(`git ${args.join(" ")}`, r);
  return r;
}

function seedGoldenScratch(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  cpSync("fixtures/golden", root, { recursive: true });
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "seed golden fixture"]);
  return root;
}

// ---------------------------------------------------------------------------
// Part 1: refuse to dispatch with a dirty registry — the `start` verb only (the operator's own
// consent point; not the daemon's own subsequent, autonomous advance — see the loop test below).
// ---------------------------------------------------------------------------

describe("Part 1: `start` refuses to dispatch while the registry is dirty", () => {
  test("a MODIFIED, tracked registry file refuses, naming it", async () => {
    const root = seedGoldenScratch("levare-provenance-mod-");
    try {
      appendFileSync(join(root, "agents/wren.md"), "\n<!-- an uncommitted edit -->\n");
      const memberRunner = stubAdapterRunner(loadRepo(root));
      const result = await resolveGate(root, "storefront", "loyalty-flow", "start", { memberRunner });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(409);
        expect(result.error).toContain("agents/wren.md");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an UNTRACKED registry file refuses, naming it", async () => {
    const root = seedGoldenScratch("levare-provenance-untracked-");
    try {
      writeFileSync(
        join(root, "agents/scout.md"),
        "---\nname: scout\nkind: native\nproduces: [scouting]\nmodel: claude-sonnet-5\nstyle:\n  avatar: Sc\n---\n\nScouts.\n",
      );
      const memberRunner = stubAdapterRunner(loadRepo(root));
      const result = await resolveGate(root, "storefront", "loyalty-flow", "start", { memberRunner });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(409);
        expect(result.error).toContain("agents/scout.md");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a dirty `work/` with a CLEAN registry dispatches successfully — `work/` is explicitly out of scope", async () => {
    const root = seedGoldenScratch("levare-provenance-work-dirty-");
    try {
      // Real, uncommitted work/ churn: an in-progress edit to a DIFFERENT unit — exactly the kind of
      // thing that's normal mid-session and must never block an unrelated dispatch.
      appendFileSync(join(root, "work/storefront/cart-icon-fix/unit.md"), "\n<!-- note to self -->\n");
      expect(dirtyRegistryFiles(root)).toEqual([]); // sanity: the registry itself is untouched

      const memberRunner = stubAdapterRunner(loadRepo(root));
      const result = await resolveGate(root, "storefront", "loyalty-flow", "start", { memberRunner });
      expect(result.ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a dirty `studio.md` (the root singleton) refuses too — it's in scope alongside the directories", async () => {
    const root = seedGoldenScratch("levare-provenance-studio-md-");
    try {
      writeFileSync(join(root, "studio.md"), "---\norchestrator_model: claude-sonnet-5\n---\n\nStudio settings.\n");
      const memberRunner = stubAdapterRunner(loadRepo(root));
      const result = await resolveGate(root, "storefront", "loyalty-flow", "start", { memberRunner });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("studio.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("committing the dirty file (the remedy the error itself names) lets the retried start through", async () => {
    const root = seedGoldenScratch("levare-provenance-remedy-");
    try {
      appendFileSync(join(root, "agents/wren.md"), "\n<!-- edited -->\n");
      const memberRunner = stubAdapterRunner(loadRepo(root));
      const refused = await resolveGate(root, "storefront", "loyalty-flow", "start", { memberRunner });
      expect(refused.ok).toBe(false);

      git(root, ["add", "-A"]);
      git(root, ["commit", "-q", "-m", "commit the registry edit"]);
      const started = await resolveGate(root, "storefront", "loyalty-flow", "start", { memberRunner: stubAdapterRunner(loadRepo(root)) });
      expect(started.ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Part 2: the stamp — every produced artifact carries `registry:`, a content hash over the governing
// registry subtree exactly as it stood on disk at dispatch time.
// ---------------------------------------------------------------------------

describe("Part 2: produced artifacts are stamped with the registry state that governed them", () => {
  test("a freshly-produced artifact's `registry:` matches an independently-computed hash of the same tree", async () => {
    const root = seedGoldenScratch("levare-provenance-stamp-");
    try {
      const memberRunner = stubAdapterRunner(loadRepo(root));
      const result = await resolveGate(root, "storefront", "loyalty-flow", "start", { memberRunner });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const producedFile = result.changedFiles.find((f) => f.endsWith(".md"))!;
      const doc = readFileSync(producedFile, "utf8");
      const m = /^registry: (\w+)$/m.exec(doc);
      expect(m).not.toBeNull();
      expect(m![1]).toBe(registryStateHash(root));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the hash is a content hash, NOT `HEAD` — an unrelated `work/` commit landing afterward leaves it unchanged", () => {
    const root = seedGoldenScratch("levare-provenance-content-hash-");
    try {
      const before = registryStateHash(root);
      const headBefore = spawnStdout("git rev-parse HEAD (before)", spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" })).trim();

      writeFileSync(join(root, "work/storefront/cart-icon-fix/note.md"), "unrelated work/ note\n");
      git(root, ["add", "-A"]);
      git(root, ["commit", "-q", "-m", "an unrelated work/ commit"]);
      const headAfter = spawnStdout("git rev-parse HEAD (after)", spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" })).trim();

      expect(headAfter).not.toBe(headBefore); // HEAD moved...
      expect(registryStateHash(root)).toBe(before); // ...but nothing that governs a dispatch did.
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the hash changes when a governing file's content changes", () => {
    const root = seedGoldenScratch("levare-provenance-hash-changes-");
    try {
      const before = registryStateHash(root);
      appendFileSync(join(root, "agents/wren.md"), "\n<!-- a real definitional change -->\n");
      expect(registryStateHash(root)).not.toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The loop's own automatic continuation must never be stranded by a stray, uncommitted registry edit
// mid-round — only the operator's explicit `start` click is a consent point (ruling REGISTRY-PROVENANCE
// Part 1); the daemon's own autonomous walk (here, dispatching the critic the instant the author's
// artifact lands in-review, with no operator involvement at all — ruling C14) is never checked.
// ---------------------------------------------------------------------------

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

# Press — author/critic loop
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

const AGENT_CORVID = `---
name: corvid
kind: native
produces: [review]
model: claude-sonnet-5
style:
  avatar: Co
---

# Corvid
`;

const UNIT_ANNOUNCEMENT = `---
type: feature
status: active
project: acme
unit: announcement
---

# Announcement
`;

function seedPressStudio(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
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

// A minimal AsyncMemberRunner (mirrors tests/loop-c14.test.ts's own) — the point of THIS test is the
// dirty-registry gating behaviour around the walk, not context assembly, so a hand-rolled boundary is
// enough; the real AdapterRunner boundary is already covered by the Part 1/2 tests above.
function pressRunner(): AsyncMemberRunner {
  return {
    capabilities: () => [
      { member: "scribe", kind: "product-brief" },
      { member: "corvid", kind: "review" },
    ],
    produce: (member, kind, unit, project, extraConsumes = []) => {
      const doc = [
        "---",
        `kind: ${kind}`,
        `id: ${kind}-${unit}-v1`,
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
  };
}

describe("the loop's automatic author→critic continuation is never stranded by a mid-round dirty registry", () => {
  test("start (clean) → dirty the registry → the daemon's own next tick still dispatches the critic", async () => {
    const root = seedPressStudio("levare-provenance-loop-");
    try {
      const runner = pressRunner();
      const unitDir = join(root, "work/acme/announcement");
      const daemon = new Daemon(root, { memberRunner: () => runner });

      // The operator's own consent point: the registry is clean here, so `start` succeeds.
      const started = await resolveGate(root, "acme", "announcement", "start", { memberRunner: runner, today: "2026-07-14" });
      expect(started.ok).toBe(true);

      // A stray, uncommitted editor save — exactly the scenario the goal names. No operator click
      // follows; the walk must still complete the round it already consented to.
      appendFileSync(join(root, "teams/press.md"), "\n# a stray, uncommitted edit\n");
      expect(dirtyRegistryFiles(root)).not.toEqual([]); // sanity: the registry really is dirty now

      const tick = await daemon.tick();
      const outcome = tick.entries.find((e) => e.unit === "announcement")!.outcome;
      expect(outcome.outcome).toBe("produced");
      expect(readFileSync(join(unitDir, "review-announcement-v1.md"), "utf8")).toContain("kind: review");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("by contrast, a FRESH `start` on a different unit against that same dirty registry is refused — the exemption is scoped to the daemon's own advance, not to dispatch in general", async () => {
    const root = seedPressStudio("levare-provenance-loop-contrast-");
    try {
      mkdirSync(join(root, "work/acme/second-unit"), { recursive: true });
      writeFileSync(
        join(root, "work/acme/second-unit/unit.md"),
        `---\ntype: feature\nstatus: active\nproject: acme\nunit: second-unit\n---\n\n# Second unit\n`,
      );
      git(root, ["add", "-A"]);
      git(root, ["commit", "-q", "-m", "add a second unit"]);

      appendFileSync(join(root, "teams/press.md"), "\n# a stray, uncommitted edit\n");
      const runner = pressRunner();
      const result = await resolveGate(root, "acme", "second-unit", "start", { memberRunner: runner, today: "2026-07-14" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("teams/press.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

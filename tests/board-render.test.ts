import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, rmSync, cpSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRepo } from "../src/repo.ts";
import { renderStudio, renderProject, renderRun, renderRegistry } from "../src/board/render.ts";
import { scoreNodes } from "../src/board/derive.ts";
import { resolveGate } from "../src/board/gateops.ts";

// PRD §9 / phase-4 acceptance: snapshot tests assert each screen's rendered HTML contains the
// required structures — score with state nodes + team-avatar column, gate cards with
// origin+consumes+age+cost, a derivation line on every screen, the five type glyphs, and the ideas
// rail. These run against the golden fixture directly (no git repo mutation needed for GET renders).

const root = "fixtures/golden";
const repo = loadRepo(root);
const now = new Date("2026-07-11T20:00:00Z");

describe("studio screen", () => {
  const html = renderStudio(repo, root, now);

  test("carries a derivation line", () => {
    expect(html).toContain('class="deriv"');
    expect(html).toContain("derived from work/ on every request");
  });

  test("gate card shows origin, consumes, age, and cost", () => {
    expect(html).toContain('class="gate__producer"');
    expect(html).toContain("member/<b>lyra</b>");
    expect(html).toContain('class="gate__consumes"');
    expect(html).toContain("product-brief-v1");
    expect(html).toContain("design-checkout-v1");
    expect(html).toContain('class="gate__meta"');
    expect(html).toContain('class="cost"');
    expect(html).toContain("~$0.58");
  });

  test("renders the ideas rail from ideas/", () => {
    expect(html).toContain('class="idea"');
    expect(html).toContain("loyalty-program");
  });

  test("every gate name is a mono link", () => {
    expect(html).toMatch(/<a class="tok link mono" href="\/run\/storefront\/checkout-flow">spec-checkout-flow-v1\.md<\/a>/);
  });
});

describe("project screen", () => {
  const html = renderProject(repo, "storefront", now);

  test("carries a derivation line", () => {
    expect(html).toContain('class="deriv"');
    expect(html).toContain("derived from work/storefront/");
  });

  test("unit row has a type glyph, a mini-score, and a gate chip", () => {
    expect(html).toContain('class="unit__glyph">▸<');
    expect(html).toContain('class="miniscore unit__score"');
    expect(html).toContain('class="chip is-gate">at gate</span>');
  });

  test("constitution shows founding artifacts with citation counts", () => {
    expect(html).toContain('class="founding"');
    expect(html).toContain("cited 2"); // product-brief-v1 is consumed by design + spec
  });

  test("gate summon template embeds the full gate card anatomy", () => {
    expect(html).toContain('id="tpl-gate-spec-checkout-flow-v1"');
    expect(html).toContain('class="gate__consumes"');
    expect(html).toContain('class="cost"');
  });
});

describe("run screen", () => {
  const html = renderRun(repo, "storefront", "checkout-flow", root, now);

  test("carries a derivation line", () => {
    expect(html).toContain('class="deriv"');
  });

  test("score rail has state nodes and a team-avatar column", () => {
    expect(html).toContain('class="score2"');
    const snodeCount = (html.match(/class="snode/g) || []).length;
    expect(snodeCount).toBeGreaterThanOrEqual(5); // one per expected kind (feature: 5)
    expect(html).toContain('class="snode done"');
    expect(html).toContain('class="snode is-gate-open"');
    // team-avatar column: at least one sstep__av holding a real avatar tinted with the team color
    expect(html).toMatch(/class="sstep__av"><span class="avatar sm" style="background:#2E6FB0">/);
  });

  test("open gate renders as a full gate card with origin, consumes, age, and cost", () => {
    expect(html).toContain('class="gate gate--cta"');
    expect(html).toContain('class="gate__producer"');
    expect(html).toContain('class="gate__consumes"');
    expect(html).toContain('class="cost"');
  });

  test("timeline is built from ledger + git log, not fabricated", () => {
    expect(html).toContain('class="timeline"');
    expect(html).toContain("kestrel/wren");
    expect(html).toContain("kestrel/lyra");
  });
});

describe("registry screen", () => {
  const html = renderRegistry(repo, root);

  test("carries a derivation line", () => {
    expect(html).toContain('class="deriv"');
  });

  test("renders all five type glyphs", () => {
    for (const glyph of ["▸", "◦", "◈", "▤", "∻"]) {
      expect(html).toContain(glyph);
    }
  });

  test("no HTML-entity double-escaping artifacts survive", () => {
    expect(html).not.toContain("&amp;middot;");
    expect(html).not.toContain("&amp;mdash;");
  });

  test("each entity is one bordered card — header, body, and edit actions inside it, no nested cards", () => {
    // One outer <article class="entity card"> per entity (matches the gate/unit/project card
    // vocabulary — a single bordered container, not a bare heading beside a separately-bordered panel).
    const cardOpens = (html.match(/<article class="entity card"/g) || []).length;
    expect(cardOpens).toBeGreaterThan(0);
    // teams(1) + agents(3) + skills(3) + knowledge(2) + types(5) + connectors(2) + evals(1)
    expect(cardOpens).toBe(1 + 3 + 3 + 2 + 5 + 2 + 1);

    // Every entity card carries its own Edit-source actions and validity indicator inside it — never
    // a bare <div class="card"> floating outside, and never an editbar with nothing bordering it.
    const editbarCount = (html.match(/class="editbar"/g) || []).length;
    expect(editbarCount).toBe(cardOpens);

    // No entity nests a second `.card` inside itself (that was the double-bordered-panel defect):
    // every `<div class="card">` that used to wrap a sub-panel is gone — only the outer article
    // carries the "card" class now.
    expect(html).not.toContain('<div class="card">');

    // Sanity: for a specific entity (kestrel), the header, the flow-strip body, and the edit actions
    // all sit between the same opening <article> and its closing </article> — genuinely one container.
    const kestrelCard = /<article class="entity card" data-entity="teams">[\s\S]*?<\/article>/.exec(html)![0];
    expect(kestrelCard).toContain('class="entity__head"');
    expect(kestrelCard).toContain('class="flowstrip"');
    expect(kestrelCard).toContain('class="editbar"');
    expect(kestrelCard).toContain("data-edit-toggle");
  });
});

// ---------------------------------------------------------------------------
// Run-view score rail: a node marker for EVERY step, artifact or not, including after a gate
// resolution. Reproduced against a real scratch git repo through the actual `resolveGate` write
// path (not a synthetic in-memory repo) — the same shape a reported regression described: queued
// steps with no artifact (code, review) losing their hollow node marker specifically after a gate
// is resolved and the repo is re-derived from disk.
// ---------------------------------------------------------------------------

const HERMETIC_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" };

function git(repoRoot: string, args: string[]): ReturnType<typeof spawnSync> {
  const r = spawnSync(
    "git",
    ["-C", repoRoot, "-c", "user.name=seed", "-c", "user.email=seed@levare.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "init.defaultBranch=main", ...args],
    { encoding: "utf8", env: HERMETIC_ENV },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}${r.stdout}`);
  return r;
}

function seedScratchRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "levare-render-run-"));
  cpSync("fixtures/golden", dir, { recursive: true });
  git(dir, ["init", "-q"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "seed golden fixture"]);
  return dir;
}

// One <span class="snode ..."> per <div class="sstep ...">, in order — the score rail must never
// render a step's label/rail line without its node marker, regardless of state.
function snodeClassesOf(scoreHtml: string): string[] {
  return [...scoreHtml.matchAll(/<span class="(snode[^"]*)" aria-hidden="true">/g)].map((m) => m[1]);
}
function stepCount(scoreHtml: string): number {
  // The outer <div class="sstep ..."> per node — not its sstep__rail/__av/__body sub-elements.
  return (scoreHtml.match(/<div class="sstep(?: |")/g) || []).length;
}
function scoreBlock(html: string): string {
  const start = html.indexOf('class="score2"');
  const end = html.indexOf('class="railfoot"');
  return html.slice(start, end);
}

describe("run screen — score rail node markers survive a real gate resolution", () => {
  let scratchRoot: string | undefined;
  afterEach(() => {
    if (scratchRoot) rmSync(scratchRoot, { recursive: true, force: true });
    scratchRoot = undefined;
  });

  test("every score step (approved, gate, and artifact-less queued) has exactly one node marker, both before and after approving the open gate", () => {
    scratchRoot = seedScratchRepo();
    const before = renderRun(loadRepo(scratchRoot), "storefront", "checkout-flow", scratchRoot, now);
    const beforeScore = scoreBlock(before);

    // Sanity on the fixture shape this pins: 5 expected kinds, 2 of them (code, review) genuinely
    // have no artifact at all yet — the exact "artifact-shaped assumption" case.
    const beforeNodes = scoreNodes(loadRepo(scratchRoot), loadRepo(scratchRoot).units.find((u) => u.unit === "checkout-flow")!);
    expect(beforeNodes.map((n) => n.kind)).toEqual(["product-brief", "design", "spec", "code", "review"]);
    expect(beforeNodes.filter((n) => !n.artifact).map((n) => n.kind)).toEqual(["code", "review"]);

    expect(stepCount(beforeScore)).toBe(5);
    expect(snodeClassesOf(beforeScore).length).toBe(5); // one marker per step — no gaps before the approve
    expect(snodeClassesOf(beforeScore)).toEqual(["snode done", "snode done", "snode is-gate-open", "snode is-wait", "snode is-wait"]);

    // The actual failing path: a real gate resolution against the real repo (not a hand-built one),
    // then a fresh re-derive from disk — exactly what the board's GET handler does on the next request.
    const result = resolveGate(scratchRoot, "storefront", "spec-checkout-flow-v1", "approve", { today: "2026-07-11" });
    expect(result.ok).toBe(true);

    const after = renderRun(loadRepo(scratchRoot), "storefront", "checkout-flow", scratchRoot, now);
    const afterScore = scoreBlock(after);

    expect(stepCount(afterScore)).toBe(5);
    // Every step still carries its node marker post-resolution — code and review (still artifact-less)
    // must still render their hollow "is-wait" marker, not a missing one.
    expect(snodeClassesOf(afterScore).length).toBe(5);
    expect(snodeClassesOf(afterScore)).toEqual(["snode done", "snode done", "snode done", "snode is-wait", "snode is-wait"]);
  });
});

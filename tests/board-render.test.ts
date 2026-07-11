import { test, expect, describe } from "bun:test";
import { loadRepo } from "../src/repo.ts";
import { renderStudio, renderProject, renderRun, renderRegistry } from "../src/board/render.ts";

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
});

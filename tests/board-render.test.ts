import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, rmSync, cpSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRepo } from "../src/repo.ts";
import { renderStudio, renderProject, renderRun, renderRegistry, renderArtifact, renderIdea, scoreNodeClass, projectStatusChip } from "../src/board/render.ts";
import { scoreNodes, type NodeState } from "../src/board/derive.ts";
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

  // Item 1, phase 7.5: an artifact id is a mono link into the artifact render view now, never a
  // fallback to the unit/run view.
  test("every gate name is a mono link into the artifact render view", () => {
    expect(html).toMatch(/<a class="tok link mono" href="\/artifact\/storefront\/checkout-flow\/spec-checkout-flow-v1">spec-checkout-flow-v1\.md<\/a>/);
  });

  test("renders ideas as real links into the idea render view (item 6)", () => {
    expect(html).toContain('<a class="idea" href="/idea/loyalty-program">loyalty-program</a>');
  });

  // Item 2, phase 7.5: a project card carries the full anatomy — status chip, name, an A8 one-
  // paragraph summary from its most relevant unit (newest gated, else newest active), and a mono
  // meta line (unit count, deploy target, latest release).
  test("project card carries the full approved anatomy", () => {
    const storefrontCardMatch = html.match(/<a class="pcard" href="\/project\/storefront">[\s\S]*?<\/a>/);
    expect(storefrontCardMatch).not.toBeNull();
    const card = storefrontCardMatch![0];
    expect(card).toContain('<span class="chip is-gate">2 gates</span>');
    expect(card).toContain('<span class="pcard__name">storefront</span>');
    // A8: the summary is the spec's full first paragraph (newest gated unit's leading artifact),
    // not a first-sentence truncation and not the alphabetically-first unit.
    expect(card).toContain("The guest-checkout spec is ready for review");
    expect(card).toContain("how a payment should be kept idempotent when there is no account to anchor the order.");
    expect(card).toContain('class="pcard__meta mono"');
    expect(card).toContain("3 units");
    expect(card).toContain("https://storefront.acme.dev"); // deploy target from the project pointer
    expect(card).toContain("released cart-icon-fix"); // latest release proxy: most recently shipped unit
  });

  // Phase-6 gate fix-up: a project's status chip is a real derivation (gate count → active → idle),
  // not a hardcoded "running". `studio` (fixtures/golden/projects/studio.md) has zero units and zero
  // open gates — the empty-project case that previously mislabeled it "running".
  test("an empty project (no units, no open gates) shows an idle chip, not a fabricated 'running'", () => {
    const studioCardMatch = html.match(/<a class="pcard" href="\/project\/studio">[\s\S]*?<\/a>/);
    expect(studioCardMatch).not.toBeNull();
    expect(studioCardMatch![0]).toContain('<span class="chip is-blocked">idle</span>');
    expect(studioCardMatch![0]).not.toContain("running");
  });

  test("a project with an open gate shows the gate-count chip", () => {
    const storefrontCardMatch = html.match(/<a class="pcard" href="\/project\/storefront">[\s\S]*?<\/a>/);
    expect(storefrontCardMatch).not.toBeNull();
    expect(storefrontCardMatch![0]).toContain('<span class="chip is-gate">2 gates</span>');
  });
});

describe("projectStatusChip — gate count wins, then active, else idle", () => {
  test("an open gate always wins, regardless of activity", () => {
    expect(projectStatusChip(2, true, 3)).toBe('<span class="chip is-gate">2 gates</span>');
  });
  test("no gates but an active unit → active", () => {
    expect(projectStatusChip(0, true, 0)).toBe('<span class="chip is-progress">active</span>');
  });
  test("no gates but a live member → active", () => {
    expect(projectStatusChip(0, false, 1)).toBe('<span class="chip is-progress">active</span>');
  });
  test("no gates, no active unit, no live members → idle", () => {
    expect(projectStatusChip(0, false, 0)).toBe('<span class="chip is-blocked">idle</span>');
  });
});

describe("project screen", () => {
  const html = renderProject(repo, "storefront", root, now);

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

  test("founding artifact links into the artifact render view (item 1)", () => {
    expect(html).toContain('href="/artifact/storefront/checkout-flow/product-brief-v1"');
  });

  // Item 3, phase 7.5: the stat strip must never leave an empty grid cell — five stats now fill a
  // five-column grid (was three stats in a four-column grid, leaving one dark cell).
  test("stat strip has no empty grid cells — five stats, five columns", () => {
    expect(html).toContain('style="grid-template-columns:repeat(5,1fr)"');
    const statCount = (html.match(/class="stat"/g) || []).length;
    expect(statCount).toBe(5);
    expect(html).toContain("Median review rounds");
    expect(html).toContain("Spend");
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
    // teams(1) + agents(4, incl. rook — ruling C9's isolated-scratch-dir fixture) + skills(3) +
    // knowledge(2) + types(5) + connectors(2) + evals(1)
    expect(cardOpens).toBe(1 + 4 + 3 + 2 + 5 + 2 + 1);

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
    const kestrelCard = /<article class="entity card" data-entity="teams"[^>]*>[\s\S]*?<\/article>/.exec(html)![0];
    expect(kestrelCard).toContain('class="entity__head"');
    expect(kestrelCard).toContain('class="flowstrip"');
    expect(kestrelCard).toContain('class="editbar"');
    expect(kestrelCard).toContain("data-edit-toggle");
  });

  // E8: the registry editor is no longer preview-only. Each entity card now carries an editable raw-
  // markdown control wired to the write route: an actual <textarea> (raw markdown, not form fields),
  // a data-path naming the entity's repo-relative file, and a Save button — the pieces that were
  // missing when "Edit source" only ever revealed a read-only <pre>. (The server route that consumes
  // this — validate → write → commit as the Conductor — is exercised in board-serve.test.ts.)
  test("each entity exposes an editable raw-markdown control wired to POST /registry/*path (E8)", () => {
    const cardOpens = (html.match(/<article class="entity card"/g) || []).length;
    // One editable textarea per card, and each is the raw-markdown editor (not a preview <pre>).
    const textareas = (html.match(/<textarea class="rawmd rawmd-edit"[^>]*>/g) || []);
    expect(textareas.length).toBe(cardOpens);
    // A Save button per card, and every card names the file the editor will POST to.
    expect((html.match(/data-save/g) || []).length).toBe(cardOpens);
    // The kestrel card's editor targets teams/kestrel.md — the exact path the write route confines to.
    const kestrelCard = /<article class="entity card" data-entity="teams"[^>]*>[\s\S]*?<\/article>/.exec(html)![0];
    expect(kestrelCard).toContain('data-path="teams/kestrel.md"');
    expect(kestrelCard).toMatch(/<textarea class="rawmd rawmd-edit" data-path="teams\/kestrel\.md"/);
    // The raw markdown source is inside the textarea (the entity's own frontmatter is editable).
    expect(kestrelCard).toContain("name: kestrel");
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
// Gate-review round 2, item 1: the score moved out of the rail into its own content column, beside
// the timeline — slice up to the timeline column's own marker instead of the rail's old `railfoot`.
function scoreBlock(html: string): string {
  const start = html.indexOf('class="score2"');
  const end = html.indexOf('class="timeline"');
  return html.slice(start, end);
}

describe("run screen — score rail node markers survive a real gate resolution", () => {
  let scratchRoot: string | undefined;
  afterEach(() => {
    if (scratchRoot) rmSync(scratchRoot, { recursive: true, force: true });
    scratchRoot = undefined;
  });

  test("every score step (approved, gate, and artifact-less queued) has exactly one node marker, both before and after approving the open gate", async () => {
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
    expect(snodeClassesOf(beforeScore)).toEqual(["snode done", "snode done", "snode is-gate-open", "snode upcoming", "snode upcoming"]);

    // The actual failing path: a real gate resolution against the real repo (not a hand-built one),
    // then a fresh re-derive from disk — exactly what the board's GET handler does on the next request.
    const result = await resolveGate(scratchRoot, "storefront", "spec-checkout-flow-v1", "approve", { today: "2026-07-11" });
    expect(result.ok).toBe(true);

    const after = renderRun(loadRepo(scratchRoot), "storefront", "checkout-flow", scratchRoot, now);
    const afterScore = scoreBlock(after);

    expect(stepCount(afterScore)).toBe(5);
    // Every step still carries its node marker post-resolution — code and review (still artifact-less)
    // must still render their hollow "upcoming" marker, not a missing/mismatched one.
    expect(snodeClassesOf(afterScore).length).toBe(5);
    expect(snodeClassesOf(afterScore)).toEqual(["snode done", "snode done", "snode done", "snode upcoming", "snode upcoming"]);
  });
});

// ---------------------------------------------------------------------------
// scoreNodeClass ↔ assets/styles.css: a renderer/stylesheet class mismatch must never render an
// invisible element again. assets/styles.css is frozen (design-approved) — this test doesn't add or
// change any CSS, it only proves every class the renderer can emit for a canonical-palette state has
// an existing compound selector (`.snode.<state>`) defined for it.
// ---------------------------------------------------------------------------

const STYLES = readFileSync("assets/styles.css", "utf8");

/** Does the frozen stylesheet define a NON-EMPTY rule for this exact compound class list (e.g.
 * "snode upcoming" → `.snode.upcoming{ … }`)? Requiring at least one real declaration (a `property:`)
 * in the matched block is the fix for the original weakness: a bare selector token or an empty rule
 * `.snode.upcoming{}` would render just as invisibly as an undefined class, so "the selector exists"
 * is not the outcome — "the selector has a rule that paints something" is. Handles grouped selectors
 * (the class may appear in a comma list before the block). */
function hasCssRuleFor(classAttr: string): boolean {
  const selector = "." + classAttr.trim().split(/\s+/).join(".");
  const re = new RegExp(escapeRegExp(selector) + "(?=[,{\\s])");
  const m = re.exec(STYLES);
  if (!m) return false;
  const open = STYLES.indexOf("{", m.index);
  if (open === -1) return false;
  const close = STYLES.indexOf("}", open);
  if (close === -1) return false;
  const body = STYLES.slice(open + 1, close);
  return /\S/.test(body) && body.includes(":"); // at least one real declaration, not an empty rule
}
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("scoreNodeClass — every canonical-palette state maps to a class assets/styles.css defines", () => {
  // done/active/waiting/blocked/needs-you/failed — all six canonical-palette states (design-brief
  // §"canonical state palette"). "failed" (rejected) closed NOTES.md gap G1: assets/styles.css now
  // defines `.snode.is-danger`, so this case is asserted exactly like its five siblings.
  const cases: Array<{ label: string; state: NodeState; isGate: boolean }> = [
    { label: "done", state: "done", isGate: false },
    { label: "active", state: "active", isGate: false },
    { label: "waiting", state: "wait", isGate: false },
    { label: "blocked", state: "blocked", isGate: false },
    { label: "needs-you (open gate)", state: "gate", isGate: true },
    { label: "failed", state: "rejected", isGate: false },
  ];

  for (const c of cases) {
    test(`${c.label} → a class with a matching assets/styles.css rule (never an invisible element)`, () => {
      const cls = scoreNodeClass({ state: c.state }, c.isGate);
      expect(hasCssRuleFor(cls)).toBe(true);
    });
  }

  test("the previously-broken case: a queued/artifact-less step no longer emits an undefined class", () => {
    const cls = scoreNodeClass({ state: "wait" }, false);
    expect(cls).toBe("snode upcoming");
    expect(hasCssRuleFor("snode is-wait")).toBe(false); // the old, invisible class — confirms this is a real fix, not a coincidence
    expect(hasCssRuleFor(cls)).toBe(true);
  });

  test("hasCssRuleFor rejects an empty rule (an empty rule paints nothing — same defect as an undefined class)", () => {
    // Guards the guard: prove the hardened check actually discriminates, so it cannot silently pass on
    // a gutted rule the way "selector token exists" would have. `.snode` (the base) is real & non-empty;
    // a fabricated class is absent; and the discipline is that a defined-but-empty rule is NOT a pass.
    expect(hasCssRuleFor("snode")).toBe(true);
    expect(hasCssRuleFor("snode this-class-does-not-exist")).toBe(false);
  });
});

// The mini-score (project view) emits its own state classes on `.dot`/`.diamond` — the same class of
// bug (a renderer class the stylesheet never painted) can strike here too, so every reachable
// mini-score marker class is cross-checked against a non-empty assets/styles.css rule, generalizing
// the scoreNodeClass guard beyond the run-view rail (test-quality rule 4).
describe("mini-score marker classes all map to a non-empty assets/styles.css rule", () => {
  // Exactly the classes miniScoreHtml can emit (render.ts): a gate node's diamond, and a dot in each
  // of its reachable states (done / rejected / everything-else→wait).
  const markerClasses = ["diamond is-gate", "dot is-done", "dot is-danger", "dot is-wait"];
  for (const cls of markerClasses) {
    test(`"${cls}" has a defined, non-empty rule`, () => {
      expect(hasCssRuleFor(cls)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Item 4, phase 7.5: the derivation line used to render twice (once under the page title, once in
// the sidebar footer) on several screens. Exactly one must survive now, and it must live in the
// footer — never bare in `.phead`/`.main`.
// ---------------------------------------------------------------------------

describe("derivation line renders exactly once per screen, in the sidebar footer", () => {
  const screens: Array<[string, string]> = [
    ["studio", renderStudio(repo, root, now)],
    ["project", renderProject(repo, "storefront", root, now)],
    ["run", renderRun(repo, "storefront", "checkout-flow", root, now)],
    ["registry", renderRegistry(repo, root)],
  ];

  for (const [name, html] of screens) {
    test(`${name} screen carries exactly one derivation line`, () => {
      const count = (html.match(/class="deriv"/g) || []).length;
      expect(count).toBe(1);
    });

    test(`${name} screen's derivation line lives inside the railfoot, not under the title`, () => {
      const footMatch = /<div class="railfoot">[\s\S]*?<\/div>\s*<\/aside>/.exec(html);
      expect(footMatch).not.toBeNull();
      expect(footMatch![0]).toContain('class="deriv"');
      const pheadMatch = /<header class="phead">[\s\S]*?<\/header>/.exec(html);
      if (pheadMatch) expect(pheadMatch[0]).not.toContain('class="deriv"');
    });
  }
});

// ---------------------------------------------------------------------------
// Item 1 + 6, phase 7.5: the artifact render view. Read-only projection of one artifact or idea
// markdown file — frontmatter as a header block, the full body (not just the A8 first paragraph),
// and navigable lineage (consumes, supersedes/superseded-by, cited-by).
// ---------------------------------------------------------------------------

describe("artifact render view", () => {
  const html = renderArtifact(repo, "storefront", "checkout-flow", "spec-checkout-flow-v1", root, now);

  test("renders frontmatter as a header block", () => {
    expect(html).toContain('<span class="k">kind</span><span class="v mono">spec</span>');
    expect(html).toContain('<span class="k">id</span><span class="v mono">spec-checkout-flow-v1</span>');
    expect(html).toContain('<span class="chip is-gate">at gate</span>'); // status: in-review
    expect(html).toContain("kestrel/lyra");
    expect(html).toContain("2026-07-11");
  });

  test("renders the full body, not just the A8 first-paragraph summary", () => {
    expect(html).toContain("The guest-checkout spec is ready for review");
    expect(html).toContain("Route"); // second paragraph
    expect(html).toContain("Payment submission is idempotent on an order key"); // third paragraph
  });

  test("renders navigable lineage: consumes, supersedes, superseded-by, cited-by", () => {
    expect(html).toContain("Consumes");
    expect(html).toContain('href="/artifact/storefront/checkout-flow/product-brief-v1"');
    expect(html).toContain('href="/artifact/storefront/checkout-flow/design-checkout-v1"');
    expect(html).toContain("Supersedes");
    expect(html).toContain("supersedes nothing");
    expect(html).toContain("Superseded by");
    expect(html).toContain("not superseded");
    expect(html).toContain("Cited by");
    expect(html).toContain("not cited yet"); // nothing in the fixture consumes the spec itself
  });

  test("a cited artifact shows the real citing artifact in its cited-by lineage", () => {
    const designHtml = renderArtifact(repo, "storefront", "checkout-flow", "design-checkout-v1", root, now);
    expect(designHtml).toContain("Cited by");
    expect(designHtml).toContain('href="/artifact/storefront/checkout-flow/spec-checkout-flow-v1"');
  });

  test("throws on an unknown artifact id (routed to a 404-equivalent by the caller)", () => {
    expect(() => renderArtifact(repo, "storefront", "checkout-flow", "not-a-real-id", root, now)).toThrow();
  });
});

describe("idea render view", () => {
  const html = renderIdea(repo, root, "loyalty-program");

  test("renders frontmatter as a header block", () => {
    expect(html).toContain('<span class="k">name</span><span class="v mono">loyalty-program</span>');
    expect(html).toContain("Reward repeat storefront buyers with points redeemable at checkout.");
    expect(html).toContain("storefront");
    expect(html).toContain("retention");
  });

  test("renders the body", () => {
    expect(html).toContain("A captured pitch with no project yet");
  });

  test("renders a lineage section (honestly empty — no schema field ties an idea back to a project)", () => {
    expect(html).toContain("Lineage");
    expect(html).toContain("nothing consumes, supersedes, or cites it");
  });

  test("throws on an unknown idea name", () => {
    expect(() => renderIdea(repo, root, "not-a-real-idea")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Gate-review round 2, item 1 (structural): the rail is ONE thing — persistent navigation, byte-
// identical in structure on every screen. Page-specific material (a project's pointer/constitution,
// a run's score, the registry's own entity switcher) must never appear in it again.
// ---------------------------------------------------------------------------

describe("the rail is identical navigation on every screen", () => {
  const screens: Array<[string, string]> = [
    ["studio", renderStudio(repo, root, now)],
    ["project", renderProject(repo, "storefront", root, now)],
    ["run", renderRun(repo, "storefront", "checkout-flow", root, now)],
    ["registry", renderRegistry(repo, root)],
    ["artifact", renderArtifact(repo, "storefront", "checkout-flow", "spec-checkout-flow-v1", root, now)],
    ["idea", renderIdea(repo, root, "loyalty-program")],
  ];

  function railOf(html: string): string {
    const m = /<aside class="rail">[\s\S]*?<\/aside>/.exec(html);
    expect(m).not.toBeNull();
    return m![0];
  }

  for (const [name, html] of screens) {
    test(`${name}: rail carries exactly the approved nav-index sections, in order, and nothing else`, () => {
      const rail = railOf(html);
      const headings = [...rail.matchAll(/<h3 class="railsec__h">([^<]*)<\/h3>/g)].map((m) => m[1]);
      expect(headings).toEqual(["Projects", "Registry", "Connectors", "Ideas"]);
      // Page-specific material must never leak back into the rail.
      expect(rail).not.toContain("Pointer");
      expect(rail).not.toContain("Constitution");
      expect(rail).not.toContain('>Score<');
      expect(rail).not.toContain("Recent releases");
      expect(rail).not.toContain('class="score2"');
      expect(rail).not.toContain('class="founding"');
    });

    test(`${name}: rail carries the logo, theme toggle, and exactly one derivation line`, () => {
      const rail = railOf(html);
      expect(rail).toContain('class="logo"');
      expect(rail).toContain("data-theme-toggle");
      expect((rail.match(/class="deriv"/g) || []).length).toBe(1);
    });
  }

  test("the rail's structure (sections, classes, order) is byte-identical across all six screens — only the derivation-footer text and the registry sub-nav's is-active highlight legitimately vary", () => {
    const normalize = (rail: string) =>
      rail.replace(/<span class="deriv">[^<]*<\/span>/, '<span class="deriv"></span>').replace(/ class="is-active"/g, ' class=""');
    const rails = screens.map(([, html]) => normalize(railOf(html)));
    for (const r of rails.slice(1)) expect(r).toBe(rails[0]);
  });
});

// ---------------------------------------------------------------------------
// The breadcrumb rule (gate-review round 3, item 2 — stated once here, applied everywhere): a
// breadcrumb renders one segment per REAL, LINKABLE page between studio and the current page, each
// one a link except the last (the current page, rendered as plain — or mono, for a filesystem-truth
// token — text, never a link to itself). No synthetic or non-navigable category label is ever
// inserted as a segment — an idea has no project to nest under and no `/ideas` listing route, so its
// crumb is `studio / <name>`, the same two-segment shape as a project's `studio / <project>`, not the
// three-segment `studio / ideas / <name>` a prior round rendered ("ideas" pointed nowhere). Always in
// the same place — inside .phead, immediately before the <h1>.
// ---------------------------------------------------------------------------

describe("breadcrumbs are consistent across all screens", () => {
  test("studio carries the root crumb", () => {
    expect(renderStudio(repo, root, now)).toContain('<div class="crumb"><span>studio</span></div>');
  });

  test("project: studio(link) / project(current)", () => {
    expect(renderProject(repo, "storefront", root, now)).toContain(
      '<div class="crumb"><a href="/studio">studio</a><span>/</span><span>storefront</span></div>',
    );
  });

  test("run: studio(link) / project(link) / unit(current)", () => {
    expect(renderRun(repo, "storefront", "checkout-flow", root, now)).toContain(
      '<div class="crumb"><a href="/studio">studio</a><span>/</span><a href="/project/storefront">storefront</a><span>/</span><span>checkout-flow</span></div>',
    );
  });

  test("artifact: studio(link) / project(link) / unit(link) / artifact(current, mono)", () => {
    expect(renderArtifact(repo, "storefront", "checkout-flow", "spec-checkout-flow-v1", root, now)).toContain(
      '<div class="crumb"><a href="/studio">studio</a><span>/</span><a href="/project/storefront">storefront</a><span>/</span><a href="/run/storefront/checkout-flow">checkout-flow</a><span>/</span><span class="mono">spec-checkout-flow-v1</span></div>',
    );
  });

  test("registry: studio(link) / registry(current)", () => {
    expect(renderRegistry(repo, root)).toContain('<div class="crumb"><a href="/studio">studio</a><span>/</span><span>registry</span></div>');
  });

  // Idea has no project to nest under and no real `/ideas` route — its crumb is two segments
  // (studio/link, name/current), the same shape as a project's, never a fake "ideas" middle segment.
  test("idea: studio(link) / name(current, mono) — no synthetic 'ideas' segment", () => {
    const html = renderIdea(repo, root, "loyalty-program");
    expect(html).toContain('<div class="crumb"><a href="/studio">studio</a><span>/</span><span class="mono">loyalty-program</span></div>');
    expect(html).not.toContain(">ideas<");
  });

  test("every breadcrumb segment is either a link or the final (current-page) segment — never a bare non-linkable middle segment", () => {
    const screens = [
      renderStudio(repo, root, now),
      renderProject(repo, "storefront", root, now),
      renderRun(repo, "storefront", "checkout-flow", root, now),
      renderRegistry(repo, root),
      renderArtifact(repo, "storefront", "checkout-flow", "spec-checkout-flow-v1", root, now),
      renderIdea(repo, root, "loyalty-program"),
    ];
    for (const html of screens) {
      const crumbMatch = /<div class="crumb">([\s\S]*?)<\/div>/.exec(html);
      expect(crumbMatch).not.toBeNull();
      // Every top-level child of .crumb is either <a ...>text</a>, <span>/</span> (a separator), or
      // the one trailing <span> (current page — plain or mono). Strip separators and the trailing
      // segment; everything left must be an <a>.
      const withoutSeparators = crumbMatch![1].replace(/<span>\/<\/span>/g, "");
      const segments = [...withoutSeparators.matchAll(/<a [^>]*>[^<]*<\/a>|<span[^>]*>[^<]*<\/span>/g)].map((m) => m[0]);
      expect(segments.length).toBeGreaterThan(0);
      // Every segment except the last must be a real link.
      for (const seg of segments.slice(0, -1)) expect(seg.startsWith("<a ")).toBe(true);
    }
  });

  test("every screen's breadcrumb sits in the same place — inside .phead, immediately before the h1", () => {
    const screens = [
      renderStudio(repo, root, now),
      renderProject(repo, "storefront", root, now),
      renderRun(repo, "storefront", "checkout-flow", root, now),
      renderRegistry(repo, root),
      renderArtifact(repo, "storefront", "checkout-flow", "spec-checkout-flow-v1", root, now),
      renderIdea(repo, root, "loyalty-program"),
    ];
    for (const html of screens) {
      expect(html).toMatch(/<header class="phead">\s*<div class="crumb">[\s\S]*?<\/div>\s*<h1/);
    }
  });
});

// ---------------------------------------------------------------------------
// Gate-review round 2, item 1 (score column): the run view's score is that page's primary content,
// not navigation — it renders as its own content column beside the timeline now.
// ---------------------------------------------------------------------------

test("run view: the score is a content column beside the timeline, not the nav rail", () => {
  const html = renderRun(repo, "storefront", "checkout-flow", root, now);
  const railHtml = /<aside class="rail">[\s\S]*?<\/aside>/.exec(html)![0];
  expect(railHtml).not.toContain('class="score2"');
  const mainHtml = /<main class="main">[\s\S]*?<\/main>/.exec(html)![0];
  expect(mainHtml).toContain('class="score2"');
  expect(mainHtml).toContain('class="timeline"');
});

// ---------------------------------------------------------------------------
// Gate-review round 2, item 2: project cards — title and status chip share one line (chip
// right-aligned, matching gate cards/unit rows), and the A8 summary clamps to two lines so every
// card is the same height regardless of content.
// ---------------------------------------------------------------------------

describe("project card layout consistency", () => {
  test("title and status chip share the same line, chip after the title", () => {
    const html = renderStudio(repo, root, now);
    expect(html).toContain('<div class="pcard__top"><span class="pcard__name">storefront</span><span class="chip is-gate">2 gates</span></div>');
  });

  test(".pcard__desc clamps to two lines regardless of content length, so card height never depends on summary length", () => {
    const css = readFileSync("assets/styles.css", "utf8");
    expect(css).toMatch(/\.pcard__desc\{[^}]*-webkit-line-clamp:2/);
  });
});

// ---------------------------------------------------------------------------
// Gate-review round 2, item 3: registry cards grid (repeat(auto-fill, minmax(320px,1fr))) instead of
// one full-width card per row, and the entity switcher moved into an in-content tab strip.
// ---------------------------------------------------------------------------

describe("registry cards are gridded, not one-per-row", () => {
  test("entity cards render inside an auto-fill grid wrapper, minmax(320px,1fr)", () => {
    const html = renderRegistry(repo, root);
    expect(html).toContain('<div class="pcards" style="grid-template-columns:repeat(auto-fill,minmax(320px,1fr))">');
  });

  test("the in-content tab strip lists every entity kind and highlights the active one", () => {
    const html = renderRegistry(repo, root, "agents");
    const tabMatch = /<nav class="reg-nav" style="flex-direction:row[^"]*">[\s\S]*?<\/nav>/.exec(html);
    expect(tabMatch).not.toBeNull();
    expect(tabMatch![0]).toContain('data-goto="agents" class="is-active"');
    for (const k of ["teams", "agents", "skills", "knowledge", "types", "connectors", "evals"]) {
      expect(tabMatch![0]).toContain(`data-goto="${k}"`);
    }
  });

  test("the rail's own Registry section and the in-content tab strip never drift apart (same shared link list)", () => {
    const html = renderRegistry(repo, root, "skills");
    const railHtml = /<aside class="rail">[\s\S]*?<\/aside>/.exec(html)![0];
    const tabHtml = /<nav class="reg-nav" style="flex-direction:row[^"]*">[\s\S]*?<\/nav>/.exec(html)![0];
    for (const k of ["teams", "agents", "skills", "knowledge", "types", "connectors", "evals"]) {
      expect(railHtml).toContain(`data-goto="${k}"`);
      expect(tabHtml).toContain(`data-goto="${k}"`);
    }
  });

  // Gate-review round 3, item 3: the kind chip and the Edit-source action row weren't on consistent
  // baselines. Fix: the kind badge (.entity__kind) right-aligns on the header line (matching every
  // other card's label-left/status-right anatomy), and the actions row (.editbar) pins to the card's
  // bottom edge regardless of that entity's own content height.
  describe("registry card header/actions alignment", () => {
    const css = readFileSync("assets/styles.css", "utf8");

    test(".entity__kind right-aligns on the header line", () => {
      expect(css).toMatch(/\.entity__kind\{[^}]*margin-left:auto/);
    });

    test(".editbar pins to the bottom of the card regardless of the entity's own content height", () => {
      expect(css).toMatch(/\.rendered\{[^}]*flex:1/);
      expect(css).toMatch(/\.editbar\{[^}]*margin-top:auto/);
    });

    test("entity__head puts the title before the (now right-aligned) kind badge, for every entity kind", () => {
      const html = renderRegistry(repo, root);
      for (const m of html.matchAll(/<div class="entity__head">([\s\S]*?)<\/div>/g)) {
        const head = m[1];
        const titleIdx = head.indexOf('class="entity__title"');
        const kindIdx = head.indexOf('class="entity__kind"');
        expect(titleIdx).toBeGreaterThanOrEqual(0);
        expect(kindIdx).toBeGreaterThan(titleIdx);
      }
    });
  });
});

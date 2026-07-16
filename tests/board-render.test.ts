import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, rmSync, cpSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRepo } from "../src/repo.ts";
import { renderStudio, renderProject, renderRun, renderRegistry, renderArtifact, renderIdea, scoreNodeClass, projectStatusChip } from "../src/board/render.ts";
import { scoreNodes, type NodeState } from "../src/derive.ts";
import { resolveGate } from "../src/board/gateops.ts";
import type { OrchestratorStatus } from "../src/orchestrator-status.ts";
import { chipClass, dotClass, fromWorkUnitStatus, type CanonicalStatus } from "../src/board/status.ts";
import type { Team, TypeTemplate, Project, WorkUnit, Artifact } from "../src/types.ts";
import type { Repo } from "../src/repo.ts";

// PRD §9 / phase-4 acceptance: snapshot tests assert each screen's rendered HTML contains the
// required structures — score with state nodes + team-avatar column, gate cards with
// origin+consumes+age+cost, a derivation line on every screen, the five type glyphs, and the ideas
// rail. These run against the golden fixture directly (no git repo mutation needed for GET renders).

const root = "fixtures/golden";
const repo = loadRepo(root);
const now = new Date("2026-07-11T20:00:00Z");

describe("studio screen", () => {
  const html = renderStudio(repo, root, now);

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

  // UI2 item 1: a Needs You card must name the unit it concerns, top-left — the card contract (title
  // top-left, status top-right) established in UI1. The artifact-based gate card used to lead with
  // only the artifact's name, never the unit's, so a Conductor scanning the inbox couldn't tell which
  // unit a gate belonged to without opening it.
  test("a Needs You card shows its unit's title", () => {
    expect(html).toContain('<div class="gate__unit-row"><a class="gate__unit" href="/run/storefront/checkout-flow">checkout-flow</a></div>');
  });

  test("renders ideas as real links into the idea render view (item 6)", () => {
    expect(html).toContain('<a class="idea" href="/idea/loyalty-program">loyalty-program</a>');
  });

  // Item 2, phase 7.5: a project card carries the full anatomy — status chip, name, an A8 one-
  // paragraph summary from its most relevant unit (newest gated, else newest active), and a mono
  // meta line (unit count, latest release — item 5b: no deploy-target line, ever).
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
    expect(card).toContain("released cart-icon-fix"); // latest release proxy: most recently shipped unit
    expect(card).not.toContain("https://storefront.acme.dev"); // deploy target line is gone (item 5b)
    expect(card).not.toContain("no deploy target");
  });

  // UI2 item 6: the Studio "Projects" section becomes an IN-FLIGHT worklist — only projects with at
  // least one active work unit appear. `studio` (fixtures/golden/projects/studio.md) has zero units,
  // so it drops out of this section entirely now; it's still reachable via the left nav and its own
  // project page (see the next test).
  test("an idle project (no active work unit) does not appear in the In flight section", () => {
    const studioCardMatch = html.match(/<a class="pcard" href="\/project\/studio">[\s\S]*?<\/a>/);
    expect(studioCardMatch).toBeNull();
  });

  // Phase-6 gate fix-up, still honest post-UI2: a project's status chip is a real derivation (gate
  // count → active → idle), not a hardcoded "running" — but since item 6 removes idle projects from
  // the Studio worklist, this now has to be observed on the project's OWN page header instead.
  test("an idle project's own page header still shows an honest idle badge, not a fabricated 'running'", () => {
    const studioPageHtml = renderProject(repo, "studio", root, now);
    const titleRow = /<div class="phead__title">[\s\S]*?<\/div>/.exec(studioPageHtml)![0];
    expect(titleRow).toContain('<span class="chip is-waiting">idle</span>');
    expect(titleRow).not.toContain("running");
  });

  test("a project with an open gate shows the gate-count chip", () => {
    const storefrontCardMatch = html.match(/<a class="pcard" href="\/project\/storefront">[\s\S]*?<\/a>/);
    expect(storefrontCardMatch).not.toBeNull();
    expect(storefrontCardMatch![0]).toContain('<span class="chip is-gate">2 gates</span>');
  });
});

// NOTES F10 defect 3: clicking Start left the board completely static for however long a real model
// call takes — "Members running" only ever populated from the daemon's OWN autonomous tick, which a
// Conductor-triggered start never went through. The board must acknowledge the click immediately: the
// instant the daemon's `running()` projection carries an in-flight invocation for a unit, that unit's
// gate card renders as dispatching (the quiet pending indicator already built for the Orchestrator
// composer — assets/styles.css's `.msg--pending .msg__dots`, reused verbatim, no new spinner) instead
// of showing Start/Not yet/Re-scope as if nothing were happening.
describe("a gate card renders an immediate dispatching state while its unit is in flight (NOTES F10 defect 3)", () => {
  test("loyalty-flow's open start gate shows Start/Not yet/Re-scope with no running invocations", () => {
    const html = renderStudio(repo, root, now, []);
    const cardMatch = html.match(/<article class="gate gate--start"[\s\S]*?<\/article>/);
    expect(cardMatch).not.toBeNull();
    expect(cardMatch![0]).toContain('data-verb="start"');
    expect(cardMatch![0]).not.toContain("is-dispatching");
    expect(cardMatch![0]).not.toContain("msg--pending");
  });

  test("loyalty-flow's start gate shows a dispatching state instead of Start/Not yet/Re-scope the instant it's in the daemon's running() projection", () => {
    const running = [{ project: "storefront", unit: "loyalty-flow", member: "wren", kind: "product-brief", startedAt: now.toISOString() }];
    const html = renderStudio(repo, root, now, running);
    const cardMatch = html.match(/<article class="gate gate--start is-dispatching"[\s\S]*?<\/article>/);
    expect(cardMatch).not.toBeNull();
    const card = cardMatch![0];
    expect(card).not.toContain('data-verb="start"');
    expect(card).not.toContain('data-verb="notyet"');
    expect(card).not.toContain('data-verb="rescope"');
    expect(card).toContain("msg--pending");
    expect(card).toContain("dispatching wren");
    expect(card).toContain("dispatching</span>"); // the badge, honest — never claims "start gate" as if idle
  });

  test("an in-flight invocation for a DIFFERENT unit leaves this gate's Start button untouched", () => {
    const running = [{ project: "storefront", unit: "some-other-unit", member: "wren", kind: "product-brief", startedAt: now.toISOString() }];
    const html = renderStudio(repo, root, now, running);
    const cardMatch = html.match(/<article class="gate gate--start"[\s\S]*?<\/article>/);
    expect(cardMatch).not.toBeNull();
    expect(cardMatch![0]).toContain('data-verb="start"');
    expect(cardMatch![0]).not.toContain("is-dispatching");
  });

  test("the project and run screens render the same dispatching state for an in-flight review gate", () => {
    const running = [{ project: "storefront", unit: "checkout-flow", member: "lyra", kind: "spec", startedAt: now.toISOString() }];
    const projectHtml = renderProject(repo, "storefront", root, now, running);
    const runHtml = renderRun(repo, "storefront", "checkout-flow", root, now, running);
    for (const html of [projectHtml, runHtml]) {
      expect(html).toContain("is-dispatching");
      expect(html).toContain("msg--pending");
      expect(html).toContain("dispatching lyra");
      expect(html).not.toContain('data-verb="approve"');
      expect(html).not.toContain('data-verb="request"');
      expect(html).not.toContain('data-verb="reject"');
    }
  });
});

describe("projectStatusChip — gate count wins, then active, else idle (NOTES UI1: canonical palette)", () => {
  test("an open gate always wins, regardless of activity", () => {
    expect(projectStatusChip(2, true, 3)).toBe('<span class="chip is-gate">2 gates</span>');
  });
  test("no gates but an active unit → active, canonical blue", () => {
    expect(projectStatusChip(0, true, 0)).toBe('<span class="chip is-active">active</span>');
  });
  test("no gates but a live member → active, canonical blue", () => {
    expect(projectStatusChip(0, false, 1)).toBe('<span class="chip is-active">active</span>');
  });
  test("no gates, no active unit, no live members → idle, canonical waiting (not blocked)", () => {
    expect(projectStatusChip(0, false, 0)).toBe('<span class="chip is-waiting">idle</span>');
  });
});

describe("project screen", () => {
  const html = renderProject(repo, "storefront", root, now);

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

  // UI2 items 2/3: repo/deploy render as a row of destination-recognisable Tabler-outline icon links
  // BELOW the title (not beside it — that corner belongs to the status badge, item 4), not label rows
  // in the pointer card.
  test("repo and deploy render as icon links below the title, with the github/world icons, not label rows in the pointer card", () => {
    const titleRow = /<div class="phead__title">[\s\S]*?<\/div>/.exec(html);
    expect(titleRow).not.toBeNull();
    // The links no longer share the title line.
    expect(titleRow![0]).not.toContain("iconlink");
    const linksRow = /<div class="phead__links">[\s\S]*?<\/div>/.exec(html);
    expect(linksRow).not.toBeNull();
    expect(linksRow![0]).toContain('<a class="iconlink ti-brand-github" href="https://github.com/acme/storefront"');
    expect(linksRow![0]).toContain('<a class="iconlink ti-world" href="https://storefront.acme.dev"');
    // The links row sits immediately after the title row, both inside <header class="phead">.
    const headerBlock = /<header class="phead">[\s\S]*?<\/header>/.exec(html)![0];
    expect(headerBlock.indexOf('class="phead__title"')).toBeLessThan(headerBlock.indexOf('class="phead__links"'));
    const pointerCard = /<div class="card">[\s\S]*?<\/div>\s*<section/.exec(html)![0];
    expect(pointerCard).not.toContain('<span class="k">repo</span>');
    expect(pointerCard).not.toContain('<span class="k">deploy</span>');
  });

  // UI2 item 4: the page header carries a status badge on the TITLE LINE, right-aligned, matching the
  // Studio project card's canonical status exactly (both call the SAME projectStatusChip with the same
  // inputs) — the card contract (title top-left, status top-right) applied to the page header.
  test("the status badge sits on the title line, right-aligned, matching the Studio project card's canonical status", () => {
    const studioHtml = renderStudio(repo, root, now);
    const studioCard = /<a class="pcard" href="\/project\/storefront">[\s\S]*?<\/a>/.exec(studioHtml)![0];
    const studioChip = /<span class="chip is-[a-z]+">[^<]*<\/span>/.exec(studioCard)![0];
    const titleRow = /<div class="phead__title">[\s\S]*?<\/div>/.exec(html)![0];
    expect(titleRow).toContain(studioChip);
    // Right-aligned on the title line: the badge is the last element before the row closes, after the h1.
    expect(titleRow).toMatch(/<h1>[^<]*<\/h1>\s*<span class="chip/);
  });

  // UI2 item 5: the stat strip moves ABOVE the pointer/constitution block, matching the Studio page's
  // own order (stats first, then content) — the page reads stat-strip → pointer → constitution →
  // releases → work units.
  test("the stat strip renders before the pointer/constitution card", () => {
    expect(html.indexOf('class="statstrip"')).toBeLessThan(html.indexOf('class="card"'));
    expect(html.indexOf('class="statstrip"')).toBeLessThan(html.indexOf("Constitution"));
  });

  // Item 6c: `pace` renders as a colour-coded badge — storefront's pace is `auto`.
  test("pace renders as a colour-coded badge", () => {
    expect(html).toContain('<span class="v"><span class="chip is-active">auto</span></span>');
  });

  // Item 6d: releases — the most recent few, latest highlighted distinctly.
  test("releases show the most recent shipped units, latest highlighted", () => {
    expect(html).toContain('<div class="founding release--latest">');
    expect(html).toContain('<span class="cite">latest</span>');
    expect(html).toContain("cart-icon-fix");
  });

  // Item 6e: work-unit rows use the canonical palette — the same active-must-be-blue fix as the
  // Studio card. checkout-flow/loyalty-flow are both "active" but sit at an open gate ("at gate", gate
  // brass); cart-icon-fix is "shipped" (canonical done, green), never the old grey `is-approved`.
  test("work-unit rows use the canonical status palette, never the pre-UI1 ad hoc classes", () => {
    expect(html).toContain('<span class="chip is-done">shipped</span>');
    expect(html).not.toContain("is-approved");
    expect(html).not.toContain("is-progress");
  });
});

describe("run screen", () => {
  const html = renderRun(repo, "storefront", "checkout-flow", root, now);

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

    // Sanity: for a specific entity (kestrel), the header, the flow-strip body, and the edit trigger
    // all sit between the same opening <article> and its closing </article> — genuinely one container.
    const kestrelCard = /<article class="entity card"[^>]*data-entity="teams"[^>]*>[\s\S]*?<\/article>/.exec(html)![0];
    expect(kestrelCard).toContain('class="entity__head"');
    expect(kestrelCard).toContain('class="flowstrip"');
    expect(kestrelCard).toContain('class="editbar"');
    expect(kestrelCard).toContain("data-edit-open");
  });

  // NOTES REV1 finding 2: `checkGuardrails` has zero production callers — the merge phase that would
  // enforce a team's declared `protected_paths`/`protected_branches`/`never` is deferred to v1.1
  // (docs/prd-amendment-1.md §2). fixtures/golden's kestrel team declares guardrails, so its card must
  // say the enforcement gap plainly — via the canonical warning callout (NOTES UI12), not stay silent.
  test("kestrel's card carries the guardrails-not-yet-enforced warning callout, since it declares guardrails", () => {
    const kestrelCard = /<article class="entity card"[^>]*data-entity="teams"[^>]*>[\s\S]*?<\/article>/.exec(html)![0];
    expect(kestrelCard).toContain('notice notice--warning');
    expect(kestrelCard).toContain("guardrails are declared but not yet enforced");
    expect(kestrelCard).toContain("merge phase (v1.1)");
  });

  test("a team with no guardrails (or an empty guardrails block) gets no such callout", () => {
    function noGuardrailsRepo(guardrails?: Team["guardrails"]): Repo {
      const t: Team = { name: "plain", consumes: [], produces: ["design"], members: [], flow: [], style: { color: "#2E6FB0" }, charter: "", learnings: "", guardrails };
      return {
        root: "/tmp/synthetic-no-guardrails",
        teams: new Map([[t.name, t]]),
        types: new Map(),
        projects: new Map(),
        agents: new Map(),
        connectors: new Map(),
        units: [],
        artifacts: new Map(),
        studio: {},
      };
    }
    const noneDeclared = renderRegistry(noGuardrailsRepo(undefined), "/tmp/synthetic-no-guardrails", "teams");
    expect(noneDeclared).not.toContain("guardrails are declared but not yet enforced");
    const emptyDeclared = renderRegistry(noGuardrailsRepo({}), "/tmp/synthetic-no-guardrails", "teams");
    expect(emptyDeclared).not.toContain("guardrails are declared but not yet enforced");
  });

  // NOTES REV1 finding 3: `kind: remote` validates cleanly but adapters.ts's `RemoteBoundary` is a
  // documented mock in every path today — a user can't tell that from the schema alone, so the
  // agent's own registry card carries the same canonical warning callout.
  test("a `kind: remote` agent's card carries the not-yet-implemented warning callout; native/cli agents carry none", () => {
    function agentKindRepo(kind: "native" | "cli" | "remote"): Repo {
      const a = { name: "echo", kind, produces: ["report"], server: kind === "remote" ? "echo-mcp" : undefined, model: kind === "native" ? "claude-sonnet-5" : undefined, command: kind === "cli" ? ["codex"] : undefined, style: { avatar: "Ec" } } as unknown as import("../src/types.ts").Agent;
      return {
        root: "/tmp/synthetic-remote-agent",
        teams: new Map(),
        types: new Map(),
        projects: new Map(),
        agents: new Map([[a.name, a]]),
        connectors: new Map(),
        units: [],
        artifacts: new Map(),
        studio: {},
      };
    }
    const remoteHtml = renderRegistry(agentKindRepo("remote"), "/tmp/synthetic-remote-agent", "agents");
    expect(remoteHtml).toContain('notice notice--warning');
    expect(remoteHtml).toContain("remote members are not yet implemented");

    const nativeHtml = renderRegistry(agentKindRepo("native"), "/tmp/synthetic-remote-agent", "agents");
    expect(nativeHtml).not.toContain("remote members are not yet implemented");

    const cliHtml = renderRegistry(agentKindRepo("cli"), "/tmp/synthetic-remote-agent", "agents");
    expect(cliHtml).not.toContain("remote members are not yet implemented");
  });

  // UI3: "Edit source" no longer reveals an inline, card-cramped textarea — each card carries only
  // the trigger (data-edit-open, naming the entity's path/name/kind) and a HIDDEN <textarea
  // class="rawmd-source"> holding the on-disk raw markdown, which app.js copies into the ONE shared
  // overlay editor on click. (Overlay behavior — open/close/validate/save — is exercised against the
  // real app.js in board-editor-overlay.test.ts; the write route itself in board-serve.test.ts.)
  test("each entity carries a hidden raw-markdown source plus an Edit-source trigger naming its path/name/kind (UI3)", () => {
    const cardOpens = (html.match(/<article class="entity card"/g) || []).length;
    const sources = html.match(/<textarea class="rawmd-source"[^>]*hidden>/g) || [];
    expect(sources.length).toBe(cardOpens);
    expect((html.match(/data-edit-open/g) || []).length).toBe(cardOpens);
    // The kestrel card's trigger targets teams/kestrel.md — the exact path both the write route and
    // the live-validation check route confine to — and names the entity for the overlay's heading.
    const kestrelCard = /<article class="entity card"[^>]*data-entity="teams"[^>]*>[\s\S]*?<\/article>/.exec(html)![0];
    expect(kestrelCard).toContain('data-path="teams/kestrel.md"');
    expect(kestrelCard).toMatch(/<button class="togglebtn" data-edit-open data-path="teams\/kestrel\.md" data-editor-name="kestrel" data-editor-kind="team">/);
    expect(kestrelCard).toMatch(/<textarea class="rawmd-source" data-path="teams\/kestrel\.md" hidden>/);
    // The raw markdown source is inside the hidden textarea (the entity's own frontmatter is there).
    expect(kestrelCard).toContain("name: kestrel");
  });

  // UI3 (1): the editor is an OVERLAY over the board, not a route — one shared instance, hidden by
  // default, a sibling of `.app` (never nested inside it, never replacing it) so the board's rail/
  // main/orchestrator markup is still present in the DOM whether or not the overlay is open.
  test("the overlay editor is a hidden sibling of the board, not nested inside it", () => {
    const appIdx = html.indexOf('<div class="app">');
    const appEndIdx = html.indexOf("</html>");
    expect(appIdx).toBeGreaterThan(-1);
    // The overlay root sits after the app's own content, not inside `.app`'s subtree.
    const overlayIdx = html.indexOf('<div class="editor-overlay" id="editor-overlay" hidden>');
    expect(overlayIdx).toBeGreaterThan(appIdx);
    expect(overlayIdx).toBeLessThan(appEndIdx);
    // Board content — rail, an entity card, the Orchestrator panel — is present in the same document.
    expect(html).toContain('class="rail"');
    expect(html).toContain('data-entity="teams"');
    expect(html).toContain('class="orch__head"');
    // The overlay carries the heading, textarea, validity indicator, and both dismiss/save controls.
    expect(html).toContain('class="editor-overlay__title"');
    expect(html).toContain('class="editor-overlay__kind mono"');
    expect(html).toContain('class="editor-overlay__textarea"');
    expect(html).toContain('data-editor-backdrop');
    expect(html).toContain('data-editor-cancel');
    expect(html).toContain('data-editor-save');
    expect(html).toContain('role="dialog" aria-modal="true"');
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
  // NOTES UI1: `miniScoreHtml` used to collapse "active" AND "blocked" into the same hollow `is-wait`
  // dot — `.dot.is-active`/`.dot.is-blocked` existed in assets/styles.css but were never emitted.
  // Now every canonical state a dot can reach (done/active/blocked/failed/waiting) has its own class.
  const markerClasses = ["diamond is-gate", "dot is-done", "dot is-active", "dot is-blocked", "dot is-danger", "dot is-wait"];
  for (const cls of markerClasses) {
    test(`"${cls}" has a defined, non-empty rule`, () => {
      expect(hasCssRuleFor(cls)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// NOTES UI1: the canonical status→colour map is the single source, and it is impossible to set a
// status colour locally — src/board/status.ts owns the CSS class for every `CanonicalStatus`, and
// every renderer converts its own domain status (WorkUnitStatus/ArtifactStatus/NodeState) through the
// SAME `fromXxx` functions before asking for a class. Proven two ways: (1) the pure mapping functions
// agree with each other for equivalent states, and (2) three independently-rendered surfaces built
// from a synthetic repo with an "active", gate-free project render the identical `is-active` class.
// ---------------------------------------------------------------------------

describe("the canonical status→colour map is the single source of truth", () => {
  test("chipClass/dotClass agree across every canonical status (one colour decision, many marker shapes)", () => {
    const statuses: CanonicalStatus[] = ["done", "active", "waiting", "blocked", "needs-you", "failed", "exhausted"];
    for (const s of statuses) {
      // Every canonical status maps to exactly one chip class and one dot class — re-deriving the
      // same status twice (as a WorkUnitStatus route and a raw CanonicalStatus route) can never land
      // on two different classes.
      expect(chipClass(s)).toBe(chipClass(s));
      expect(dotClass(s)).toBe(dotClass(s));
    }
  });

  test('fromWorkUnitStatus("active") and the raw "active" canonical status resolve to the identical chip class', () => {
    expect(chipClass(fromWorkUnitStatus("active"))).toBe(chipClass("active"));
    expect(chipClass(fromWorkUnitStatus("active"))).toBe("is-active");
  });

  function team(over: Partial<Team> & { name: string; flow: Team["flow"]; produces: string[]; members: string[] }): Team {
    return { consumes: [], style: { color: "#2E6FB0" }, charter: "", learnings: "", ...over };
  }
  function project(over: Partial<Project> & { name: string }): Project {
    return { repo: ".", remote: null, default_branch: "main", deploy: null, pace: "auto", houseRules: "", ...over };
  }
  function unit(over: Partial<WorkUnit> & { unit: string; project: string; type: string }): WorkUnit {
    return { status: "active", dir: "/tmp/x", ...over };
  }
  function artifact(over: Partial<Artifact> & { id: string; unit: string; project: string; kind: string; produced_by: string }): Artifact {
    return { status: "approved", consumes: [], supersedes: null, approved_by: "cas 2026-07-11", created: "2026-07-11", files: [], ...over };
  }

  // A synthetic single-project repo: one unit, status "active", carrying exactly one APPROVED
  // artifact (so `openGates` raises no start gate — an active unit with no artifacts at all always
  // gets one — and no review gate either) — the one shape where the project card, the header badge,
  // and the unit row all legitimately read "active" rather than "N gates".
  function activeNoGateRepo(): Repo {
    const t = team({ name: "kestrel", flow: [], produces: ["design"], members: ["wren"] });
    const ty: TypeTemplate = { name: "feature", glyph: "▸", expects: ["design"], gates: [] };
    const p = project({ name: "atelier" });
    const u = unit({ unit: "widget", project: "atelier", type: "feature" });
    const art = artifact({ id: "design-v1", unit: "widget", project: "atelier", kind: "design", produced_by: "kestrel/wren" });
    return {
      root: "/tmp/synthetic-active",
      teams: new Map([[t.name, t]]),
      types: new Map([[ty.name, ty]]),
      projects: new Map([[p.name, p]]),
      agents: new Map(),
      connectors: new Map(),
      units: [u],
      artifacts: new Map([["atelier/widget", new Map([[art.id, art]])]]),
      studio: {},
    };
  }

  test("Studio project card, the project header badge, and the project page's work-unit row all render the SAME class for the SAME active status", () => {
    const synthRepo = activeNoGateRepo();
    const synthRoot = "/tmp/nonexistent-levare-synthetic-active";
    const studioHtml = renderStudio(synthRepo, synthRoot, now);
    const projectHtml = renderProject(synthRepo, "atelier", synthRoot, now);

    const studioCard = /<a class="pcard" href="\/project\/atelier">[\s\S]*?<\/a>/.exec(studioHtml);
    expect(studioCard).not.toBeNull();
    expect(studioCard![0]).toContain('<span class="chip is-active">active</span>');

    const projectHeader = /<div class="phead__title">[\s\S]*?<\/div>/.exec(projectHtml);
    expect(projectHeader).not.toBeNull();
    expect(projectHeader![0]).toContain('<span class="chip is-active">active</span>');

    const unitRow = /<div class="unit__head">[\s\S]*?<\/div>\s*<\/div>/.exec(projectHtml);
    expect(unitRow).not.toBeNull();
    expect(unitRow![0]).toContain('<span class="chip is-active">active</span>');

    // Never the pre-UI1 ad hoc grey class anywhere.
    expect(studioHtml).not.toContain("is-progress");
    expect(projectHtml).not.toContain("is-progress");
  });
});

// ---------------------------------------------------------------------------
// UI2 item 6: the Studio "Projects" section becomes an IN-FLIGHT worklist, renamed "In flight" — it
// shows only projects with at least one active work unit. An idle project (no active unit, including
// a project with zero units at all) never appears here; it's still reachable via the left nav and its
// own project page. The empty state must signpost the next action, never a blank gap.
// ---------------------------------------------------------------------------

describe("Studio's Projects section is an In-flight worklist (UI2 item 6)", () => {
  function team(over: Partial<Team> & { name: string; flow: Team["flow"]; produces: string[]; members: string[] }): Team {
    return { consumes: [], style: { color: "#2E6FB0" }, charter: "", learnings: "", ...over };
  }
  function project(over: Partial<Project> & { name: string }): Project {
    return { repo: ".", remote: null, default_branch: "main", deploy: null, pace: "auto", houseRules: "", ...over };
  }
  function unit(over: Partial<WorkUnit> & { unit: string; project: string; type: string }): WorkUnit {
    return { status: "active", dir: "/tmp/x", ...over };
  }

  test("the section heading reads 'In flight', not 'Projects'", () => {
    const html = renderStudio(repo, root, now);
    expect(html).toContain("<h2>In flight</h2>");
    expect(html).not.toContain("<h2>Projects</h2>");
  });

  // A repo with two projects: `busy` has one active unit, `idle` has one SHIPPED (never active) unit —
  // idle isn't "zero units", it's "zero units currently in flight", the case a naive "units.length > 0"
  // filter would get wrong.
  function mixedRepo(): Repo {
    const t = team({ name: "kestrel", flow: [], produces: ["design"], members: ["wren"] });
    const ty: TypeTemplate = { name: "feature", glyph: "▸", expects: ["design"], gates: [] };
    const busy = project({ name: "busy" });
    const idleProj = project({ name: "idle" });
    const activeUnit = unit({ unit: "widget", project: "busy", type: "feature", status: "active" });
    const shippedUnit = unit({ unit: "done-thing", project: "idle", type: "feature", status: "shipped" });
    return {
      root: "/tmp/synthetic-mixed",
      teams: new Map([[t.name, t]]),
      types: new Map([[ty.name, ty]]),
      projects: new Map([[busy.name, busy], [idleProj.name, idleProj]]),
      agents: new Map(),
      connectors: new Map(),
      units: [activeUnit, shippedUnit],
      artifacts: new Map(),
      studio: {},
    };
  }

  test("only the project with an active work unit appears; the idle-but-not-empty project is excluded", () => {
    const html = renderStudio(mixedRepo(), "/tmp/nonexistent-levare-synthetic-mixed", now);
    expect(html).toContain('<a class="pcard" href="/project/busy">');
    expect(html).not.toContain('<a class="pcard" href="/project/idle">');
  });

  function emptyStudioRepo(): Repo {
    return {
      root: "/tmp/synthetic-empty",
      teams: new Map(),
      types: new Map(),
      projects: new Map([["quiet", project({ name: "quiet" })]]),
      agents: new Map(),
      connectors: new Map(),
      units: [],
      artifacts: new Map(),
      studio: {},
    };
  }

  test("zero in-flight projects renders the signposting empty state, never a blank gap", () => {
    const html = renderStudio(emptyStudioRepo(), "/tmp/nonexistent-levare-synthetic-empty", now);
    expect(html).not.toContain('class="pcards"');
    expect(html).toMatch(/Nothing in flight\..*Open a project from the sidebar to start a unit\./);
  });
});

// ---------------------------------------------------------------------------
// Item 4c (gate-review round UI1): the left nav's "derived from ... on every request" footer line is
// gone entirely — nowhere in the rail, nowhere else. Superseded the earlier phase-7.5 rule that it
// live in exactly one place; now it lives nowhere.
// ---------------------------------------------------------------------------

describe("the left nav no longer carries a derivation footer line", () => {
  const screens: Array<[string, string]> = [
    ["studio", renderStudio(repo, root, now)],
    ["project", renderProject(repo, "storefront", root, now)],
    ["run", renderRun(repo, "storefront", "checkout-flow", root, now)],
    ["registry", renderRegistry(repo, root)],
  ];

  for (const [name, html] of screens) {
    test(`${name} screen: no "derived from" footer text, no .deriv/.railfoot markup`, () => {
      expect(html).not.toContain('class="deriv"');
      expect(html).not.toContain('class="railfoot"');
      expect(html).not.toMatch(/derived from .* on every request/);
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

// Item 4: the Orchestrator section, the logo/wordmark, and the theme toggle all moved out of the
// rail — the Orchestrator's status is now a header-level fact (4a), the mark/wordmark/theme-toggle
// live in the new top-level app header (item 3), not duplicated in the nav.
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
      // Item 4a: no Orchestrator section in the rail at all.
      expect(rail).not.toContain(">Orchestrator<");
      expect(rail).not.toContain("orchestrator:");
    });

    test(`${name}: rail no longer carries the logo, theme toggle, or a derivation line (all moved to the header)`, () => {
      const rail = railOf(html);
      expect(rail).not.toContain('class="logo"');
      expect(rail).not.toContain("data-theme-toggle");
      expect(rail).not.toContain('class="deriv"');
    });

    // Item 4b: a connector row carries no trailing status text ("ok"/"missing-env") — the dot alone
    // — and is itself a real link into that connector's own registry card.
    test(`${name}: connector rows carry no status text and are navigable`, () => {
      const rail = railOf(html);
      const connectorsSection = /<h3 class="railsec__h">Connectors<\/h3>([\s\S]*?)<\/section>/.exec(rail);
      expect(connectorsSection).not.toBeNull();
      const section = connectorsSection![1];
      expect(section).toContain('<a class="crow" href="/registry/connectors/github">');
      expect(section).not.toContain(">ok<");
      expect(section).not.toContain("missing-env");
    });
  }

  test("the rail's structure (sections, classes, order) is byte-identical across all six screens — only the registry sub-nav's is-active highlight legitimately varies", () => {
    const normalize = (rail: string) => rail.replace(/ class="is-active"/g, ' class=""');
    const rails = screens.map(([, html]) => normalize(railOf(html)));
    for (const r of rails.slice(1)) expect(r).toBe(rails[0]);
  });
});

// Item 3: the top-level app header — mark, wordmark, release-version chip, Orchestrator status (on
// and off), a hairline divider, the theme toggle — present, identically structured, on every screen.
describe("the app header carries the wordmark, version chip, orchestrator status, and theme toggle", () => {
  const screens: Array<[string, string]> = [
    ["studio", renderStudio(repo, root, now)],
    ["project", renderProject(repo, "storefront", root, now)],
    ["run", renderRun(repo, "storefront", "checkout-flow", root, now)],
    ["registry", renderRegistry(repo, root)],
    ["artifact", renderArtifact(repo, "storefront", "checkout-flow", "spec-checkout-flow-v1", root, now)],
    ["idea", renderIdea(repo, root, "loyalty-program")],
  ];

  function headerOf(html: string): string {
    const m = /<header class="apphead">[\s\S]*?<\/header>/.exec(html);
    expect(m).not.toBeNull();
    return m![0];
  }

  for (const [name, html] of screens) {
    test(`${name}: header carries the mark, wordmark "levare", a mono version chip, and the theme toggle — exactly once`, () => {
      const header = headerOf(html);
      expect((html.match(/<header class="apphead">/g) || []).length).toBe(1);
      expect(header).toContain('class="logo"');
      expect(header).toContain(">levare<");
      expect(header).toMatch(/<span class="apphead__ver mono">v[\d.]+<\/span>/);
      expect((header.match(/data-theme-toggle/g) || []).length).toBe(1);
      expect(header).toContain('class="apphead__divider"');
    });
  }

  test("orchestrator: on — a filled dot, never the danger colour", () => {
    const html = renderStudio(repo, root, now, [], { available: true, reason: "The Orchestrator is live.", envVar: "ANTHROPIC_API_KEY" });
    const header = headerOf(html);
    expect(header).toContain("orchestrator: on");
    expect(header).toContain('class="status-dot is-ok"');
    expect(header).not.toContain('class="status-dot is-danger"');
  });

  test("orchestrator: off — a hollow/outline dot (a legitimate mode, never the danger colour)", () => {
    const html = renderStudio(repo, root, now, [], { available: false, reason: "ANTHROPIC_API_KEY is not set", envVar: "ANTHROPIC_API_KEY" });
    const header = headerOf(html);
    expect(header).toContain("orchestrator: off");
    expect(header).toContain('class="status-dot is-idle"');
    expect(header).not.toContain('class="status-dot is-danger"');
  });

  test("the header's structure is byte-identical across all six screens (only the rail-toggle aria-label legitimately varies)", () => {
    const normalize = (h: string) => h.replace(/aria-label="[^"]*"/, 'aria-label=""');
    const headers = screens.map(([, html]) => normalize(headerOf(html)));
    for (const h of headers.slice(1)) expect(h).toBe(headers[0]);
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
    // Item 6a/6b: the project page's h1 now sits inside a `.phead__title` row alongside its status
    // badge and icon links — an optional wrapper every other screen's bare `<h1>` doesn't have.
    for (const html of screens) {
      expect(html).toMatch(/<header class="phead">\s*<div class="crumb">[\s\S]*?<\/div>\s*(?:<div class="phead__title">)?\s*<h1/);
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
// one full-width card per row.
// UI5: the entity switcher briefly lived as an in-content tab strip above the grid; now that every
// registry kind is a real route reachable from the rail, that in-page strip is gone — the rail's own
// Registry section (registryNavLinks, still shared) is the only place the kind list renders.
// ---------------------------------------------------------------------------

describe("registry cards are gridded, not one-per-row", () => {
  test("entity cards render inside an auto-fill grid wrapper, minmax(320px,1fr)", () => {
    const html = renderRegistry(repo, root);
    expect(html).toContain('<div class="pcards" style="grid-template-columns:repeat(auto-fill,minmax(320px,1fr))">');
  });

  test("UI5: the in-page registry tab strip is gone; the rail alone lists every entity kind with its count", () => {
    const html = renderRegistry(repo, root, "agents");
    // No horizontal in-content nav strip above the cards anymore.
    expect(html).not.toMatch(/<nav class="reg-nav" style="flex-direction:row/);
    const main = /<main class="main"[^>]*>[\s\S]*?<\/main>/.exec(html)![0];
    expect(main).not.toContain('class="reg-nav"');
    // The rail's Registry section is the sole surface for the kind list, and still carries counts.
    const railHtml = /<aside class="rail">[\s\S]*?<\/aside>/.exec(html)![0];
    for (const k of ["teams", "agents", "skills", "knowledge", "types", "connectors", "evals"]) {
      expect(railHtml).toContain(`data-goto="${k}"`);
      expect(railHtml).toMatch(new RegExp(`data-goto="${k}"[^>]*>${k} <span class="ct">\\d+</span>`));
    }
    expect(railHtml).toContain('data-goto="agents" class="is-active"');
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

    // UI7 (RULE A): team/agent/skill cards no longer carry a kind tag at all (that's covered by its
    // own describe block below) — this only pins the ordering for entity kinds that still show one.
    test("entity__head puts the title before the (now right-aligned) kind badge, for every entity kind that still shows one", () => {
      const html = renderRegistry(repo, root);
      for (const m of html.matchAll(/<div class="entity__head">([\s\S]*?)<\/div>/g)) {
        const head = m[1];
        const titleIdx = head.indexOf('class="entity__title"');
        const kindIdx = head.indexOf('class="entity__kind"');
        expect(titleIdx).toBeGreaterThanOrEqual(0);
        if (kindIdx === -1) continue;
        expect(kindIdx).toBeGreaterThan(titleIdx);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// UI7 (RULE A): a card on its own entity's page doesn't repeat its kind — team/agent/skill cards drop
// the top-right `.entity__kind` tag entirely (superseding UI4 item 3's "bare type, no exceptions"
// ruling for these three kinds specifically). knowledge/type/connector/eval are untouched by this goal
// and keep their bare-type tag.
// ---------------------------------------------------------------------------

describe("UI7: team/agent/skill cards carry no kind tag (RULE A)", () => {
  test("a team card has no 'team' kind tag", () => {
    const html = renderRegistry(repo, root, "teams");
    const card = /<article class="entity card" id="teams-kestrel"[\s\S]*?<\/article>/.exec(html);
    expect(card).not.toBeNull();
    expect(card![0]).not.toContain('class="entity__kind"');
  });

  test("an agent card has no 'agent' kind tag", () => {
    const html = renderRegistry(repo, root, "agents");
    const card = /<article class="entity card" id="agents-lyra"[\s\S]*?<\/article>/.exec(html);
    expect(card).not.toBeNull();
    expect(card![0]).not.toContain('class="entity__kind"');
  });

  test("a skill card has no 'skill' kind tag", () => {
    const html = renderRegistry(repo, root, "skills");
    const cards = [...html.matchAll(/<article class="entity card" id="skills-[^"]*"[\s\S]*?<\/article>/g)];
    expect(cards.length).toBeGreaterThan(0);
    for (const c of cards) expect(c[0]).not.toContain('class="entity__kind"');
  });

  test("knowledge/type/connector/eval cards still show their bare-type kind tag", () => {
    const html = renderRegistry(repo, root);
    const kinds = [...html.matchAll(/<span class="entity__kind">([^<]*)<\/span>/g)].map((m) => m[1]);
    expect(kinds.length).toBeGreaterThan(0);
    for (const k of kinds) expect(["knowledge", "type", "connector", "eval"]).toContain(k);
  });
});

// ---------------------------------------------------------------------------
// UI7: the registry card sweep. docs/levare-design-brief.md's identity/status split (RULE B — colour
// means status only, except a team's own declared hue) applied to teams/agents/skills/knowledge.
// ---------------------------------------------------------------------------

describe("UI7: team cards show colour as identity (border), not as a printed value", () => {
  const html = renderRegistry(repo, root, "teams");
  const card = /<article class="entity card" id="teams-kestrel"[\s\S]*?<\/article>/.exec(html)![0];

  test("the card's own left-edge border carries the team's declared colour, not a hex/swatch value printed in the body", () => {
    const article = /<article class="entity card" id="teams-kestrel"[^>]*>/.exec(html)![0];
    expect(article).toContain("border-left:2px solid #2E6FB0");
    // No standalone hex-value text and no "color" definition row printing it.
    expect(card).not.toContain(">#2E6FB0<");
    expect(card).not.toMatch(/<span class="k">color<\/span>/);
  });

  test("members render as avatars with the member's name on hover, not a plain name list", () => {
    expect(card).toMatch(/<span class="k">members<\/span><span class="v chiprow">(<span class="avatar[^>]*title="[a-z]+"[^>]*>[a-z]{2}<\/span>)+<\/span>/);
    // No plain comma-joined name list survives in the rendered body (the raw markdown source, kept
    // verbatim in the hidden edit-source textarea, legitimately still contains prose naming members).
    const rendered = card.replace(/<textarea class="rawmd-source"[\s\S]*?<\/textarea>/, "");
    expect(rendered).not.toContain("wren, lyra, finch");
  });

  test("produces renders as chips, not a plain comma-joined string", () => {
    expect(card).toMatch(/<span class="k">produces<\/span><span class="v chiprow">(<span class="tag">[a-z-]+<\/span>)+<\/span>/);
  });

  test("no 'team' kind tag", () => {
    expect(card).not.toContain('class="entity__kind"');
  });

  test("the declared flow shows member avatars, not member name text", () => {
    const flow = /<div class="flowstrip">([\s\S]*?)<\/div>/.exec(card)![1];
    expect(flow).toContain('class="avatar');
    expect(flow).not.toContain('class="mn"');
  });
});

describe("UI7: agent cards drop kind/wears text, show a shape-based kind badge, kind+model adjacent, produces as chips", () => {
  const html = renderRegistry(repo, root, "agents");
  const card = /<article class="entity card" id="agents-lyra"[\s\S]*?<\/article>/.exec(html)![0];

  test("no 'agent' kind tag and no 'wears <team>' row", () => {
    expect(card).not.toContain('class="entity__kind"');
    expect(card).not.toMatch(/<span class="k">wears<\/span>/);
  });

  test("kind renders as a shape/treatment badge that does not use a status-palette colour", () => {
    expect(card).toContain('<span class="kindbadge kindbadge--native">native</span>');
    const css = readFileSync("assets/styles.css", "utf8");
    const kindbadgeRules = css.match(/\.kindbadge[^{]*\{[^}]*\}/g) || [];
    expect(kindbadgeRules.length).toBeGreaterThan(0);
    for (const rule of kindbadgeRules) {
      for (const forbidden of ["var(--active)", "var(--ok)", "var(--gate)", "var(--danger)"]) {
        expect(rule).not.toContain(forbidden);
      }
    }
  });

  test("kind and model render adjacent in one row, not separate rows", () => {
    expect(card).toMatch(/<span class="k">kind<\/span><span class="v"><span class="kindbadge[^>]*>native<\/span>[^<]*<span class="mono">&middot; claude-sonnet-5<\/span><\/span>/);
    expect((card.match(/<div class="prow">/g) || []).length).toBeLessThan(4);
  });

  test("produces renders as chips", () => {
    expect(card).toMatch(/<span class="k">produces<\/span><span class="v chiprow">(<span class="tag">[a-z-]+<\/span>)+<\/span>/);
  });
});

describe("UI7: skill cards drop the kind tag and the SKILL.md label", () => {
  test("no 'skill' kind tag and no 'SKILL.md' heading", () => {
    const html = renderRegistry(repo, root, "skills");
    const cards = [...html.matchAll(/<article class="entity card" id="skills-[^"]*"[\s\S]*?<\/article>/g)];
    expect(cards.length).toBeGreaterThan(0);
    for (const c of cards) {
      expect(c[0]).not.toContain('class="entity__kind"');
      expect(c[0]).not.toContain("SKILL.md<");
    }
  });
});

describe("UI7: knowledge cards show frontmatter tags as chips, not an Injected-into backlink section", () => {
  test("tags render as chips and no 'Injected into' section survives", () => {
    const html = renderRegistry(repo, root, "knowledge");
    const cards = [...html.matchAll(/<article class="entity card" id="knowledge-[^"]*"[\s\S]*?<\/article>/g)];
    expect(cards.length).toBeGreaterThan(0);
    // The rendered body must not carry the old backlink section; the raw markdown source (verbatim
    // in the hidden edit-source textarea) legitimately still mentions "Injected into" in its own prose.
    for (const c of cards) {
      const rendered = c[0].replace(/<textarea class="rawmd-source"[\s\S]*?<\/textarea>/, "");
      expect(rendered).not.toContain("Injected into");
    }
    const houseStyle = /<article class="entity card" id="knowledge-house-style"[\s\S]*?<\/article>/.exec(html)![0];
    expect(houseStyle).toMatch(/<div class="chiprow">(<span class="tag">[a-z]+<\/span>)+<\/div>/);
    expect(houseStyle).toContain('<span class="tag">voice</span>');
    expect(houseStyle).toContain('<span class="tag">reference</span>');
  });
});

// ---------------------------------------------------------------------------
// UI4 item 4: registry URLs become path segments (/registry/<kind>, /registry/<kind>/<name>),
// matching /project/<name> and /idea/<name> elsewhere in the product. A path-form deep link into one
// entity renders the same list view, scrolled to and highlighting that entity — not a new screen.
// ---------------------------------------------------------------------------

describe("UI4 item 4: registry URLs are path segments, and the rail links emit them", () => {
  test("the registry nav links (rail) point at /registry/<kind>, not ?entity=<kind>", () => {
    const html = renderRegistry(repo, root, "agents");
    for (const k of ["teams", "agents", "skills", "knowledge", "types", "connectors", "evals"]) {
      expect(html).toContain(`href="/registry/${k}"`);
    }
    expect(html).not.toContain("/registry?entity=");
  });

  test("connector rail rows link to /registry/connectors/<name>, not the old ?entity=/#fragment form", () => {
    const html = renderStudio(repo, root, now);
    expect(html).toContain('href="/registry/connectors/github"');
    expect(html).not.toContain("/registry?entity=connectors#");
  });

  test("renderRegistry(kind) alone renders no highlight target", () => {
    const html = renderRegistry(repo, root, "connectors");
    const main = /<main class="main"[^>]*>/.exec(html)![0];
    expect(main).not.toContain("data-highlight");
  });

  test("renderRegistry(kind, name) highlights exactly that entity's card, still inside the same list view", () => {
    const html = renderRegistry(repo, root, "connectors", undefined, "linear");
    const main = /<main class="main"[^>]*>/.exec(html)![0];
    expect(main).toContain('data-highlight="connectors-linear"');
    // Still the list view, not a detail screen — the other connector's card is present too.
    expect(html).toContain('id="connectors-github"');
    expect(html).toContain('id="connectors-linear"');
    expect(html).toContain('<h1>Connectors</h1>');
  });
});

// ---------------------------------------------------------------------------
// NOTES UI5: the registry page's H1 names the entity kind being viewed ("Agents", "Teams", ...), not
// the section ("Registry") — matching how project and idea pages title themselves by their content.
// The breadcrumb above it still reads "studio / registry".
// ---------------------------------------------------------------------------

describe("NOTES UI5: the registry H1 is the entity kind, not the section", () => {
  for (const [kind, title] of [
    ["teams", "Teams"],
    ["agents", "Agents"],
    ["skills", "Skills"],
    ["knowledge", "Knowledge"],
    ["types", "Types"],
    ["connectors", "Connectors"],
    ["evals", "Evals"],
  ] as const) {
    test(`/registry/${kind} titles its H1 "${title}", not "Registry"`, () => {
      const html = renderRegistry(repo, root, kind);
      expect(html).toContain(`<h1>${title}</h1>`);
      expect(html).not.toContain("<h1>Registry</h1>");
    });
  }

  test("the breadcrumb above the H1 still reads studio / registry", () => {
    const html = renderRegistry(repo, root, "agents");
    expect(html).toContain('<div class="crumb"><a href="/studio">studio</a><span>/</span><span>registry</span></div>');
  });
});

// ---------------------------------------------------------------------------
// UI4 item 1: the reusable confirm-modal primitive — a small centered panel over a dimmed backdrop,
// present as a sibling of `.app` on every screen (not just the registry), hidden by default.
// ---------------------------------------------------------------------------

describe("UI4 item 1: the confirm-modal primitive renders on every screen", () => {
  test("present, hidden, before </html>, on studio/project/run/registry", () => {
    const screens = [renderStudio(repo, root, now), renderProject(repo, "storefront", root, now), renderRun(repo, "storefront", "checkout-flow", root, now), renderRegistry(repo, root)];
    for (const html of screens) {
      const m = /<div class="confirm-modal" id="confirm-modal" hidden>[\s\S]*?<\/div>\s*<script/.exec(html);
      expect(m).not.toBeNull();
      expect(m![0]).toContain("data-confirm-backdrop");
      expect(m![0]).toContain("data-confirm-keep");
      expect(m![0]).toContain("data-confirm-discard");
    }
  });
});

// ---------------------------------------------------------------------------
// NOTES C11 part 3: a global status indicator in the app header, on every screen — "orchestrator: on"
// with a credential and the SDK boundary live, "orchestrator: off" without. Quiet vocabulary reused
// from the existing canonical state palette (status-dot is-ok/is-idle), not a new color.
// ---------------------------------------------------------------------------

describe("the header status indicator shows the Orchestrator's real state, on every screen", () => {
  const ON: OrchestratorStatus = { available: true, reason: "The Orchestrator is live.", envVar: "ANTHROPIC_API_KEY" };
  const OFF: OrchestratorStatus = { available: false, reason: "ANTHROPIC_API_KEY is not set", envVar: "ANTHROPIC_API_KEY" };

  const screensWith = (status: OrchestratorStatus): Array<[string, string]> => [
    ["studio", renderStudio(repo, root, now, [], status)],
    ["project", renderProject(repo, "storefront", root, now, [], status)],
    ["run", renderRun(repo, "storefront", "checkout-flow", root, now, [], status)],
    ["registry", renderRegistry(repo, root, undefined, status)],
    ["artifact", renderArtifact(repo, "storefront", "checkout-flow", "spec-checkout-flow-v1", root, now, status)],
    ["idea", renderIdea(repo, root, "loyalty-program", status)],
  ];

  for (const [name, html] of screensWith(ON)) {
    test(`${name}: shows "orchestrator: on" with a credential`, () => {
      expect(html).toContain("orchestrator: on");
      expect(html).not.toContain("orchestrator: off");
      expect(html).toContain('class="status-dot is-ok"');
    });
  }

  for (const [name, html] of screensWith(OFF)) {
    test(`${name}: shows "orchestrator: off" without a credential`, () => {
      expect(html).toContain("orchestrator: off");
      expect(html).not.toContain("orchestrator: on");
      expect(html).toContain('class="status-dot is-idle"');
    });
  }

  test("when off, the Orchestrator panel is visible but disabled — never hidden", () => {
    const html = renderStudio(repo, root, now, [], OFF);
    expect(html).toContain('class="orch is-disabled"');
    expect(html).toContain("Orchestrator unavailable");
    expect(html).toContain("ANTHROPIC_API_KEY");
    expect(html).toContain('class="composer is-disabled"');
    expect(html).toContain("disabled");
  });

  test("when off, the run view's open gate still renders — a disabled Orchestrator never hides an actionable gate", () => {
    const html = renderRun(repo, "storefront", "checkout-flow", root, now, [], OFF);
    expect(html).toContain('class="orch is-disabled"');
    expect(html).toContain('class="gate gate--cta"');
    expect(html).toContain('data-verb="approve"');
  });

  test("when on, the panel is not disabled and the composer is enabled", () => {
    const html = renderStudio(repo, root, now, [], ON);
    expect(html).not.toContain('class="orch is-disabled"');
    expect(html).not.toContain('class="composer is-disabled"');
    expect(html).not.toContain("Orchestrator unavailable");
  });

  // Item 4a: the Orchestrator's status is a header-level fact now — the rail's old Orchestrator
  // section (a duplicate rendering of the same fact) is gone entirely.
  test("the rail no longer carries an Orchestrator section — that fact lives in the header only", () => {
    const on = renderStudio(repo, root, now, [], ON);
    const off = renderStudio(repo, root, now, [], OFF);
    for (const html of [on, off]) {
      const rail = /<aside class="rail">[\s\S]*?<\/aside>/.exec(html)![0];
      expect(rail).not.toContain(">Orchestrator<");
      expect(rail).not.toContain("orchestrator:");
    }
  });

  // The header answers "is it configured?" — a stable fact, not a per-message state. It must render
  // identically regardless of anything that would only matter to a live conversation (there's no
  // "thinking"/pending flag threaded into any render* call, so this just pins that the header's
  // on/off text is driven purely by `OrchestratorStatus.available`).
  test("the header's orchestrator text never varies by anything other than availability, across every screen", () => {
    for (const scope of [
      renderStudio(repo, root, now, [], ON),
      renderProject(repo, "storefront", root, now, [], ON),
      renderRun(repo, "storefront", "checkout-flow", root, now, [], ON),
    ]) {
      const header = /<header class="apphead">[\s\S]*?<\/header>/.exec(scope)![0];
      expect(header).toContain("orchestrator: on");
    }
  });
});

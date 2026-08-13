// NOTES REGISTRY-BODY: the goal this unit closes — a cold-start walkthrough on a released binary found
// the registry renders frontmatter selectively and drops markdown bodies entirely, except on skill
// cards, which do it right (registry.ts's own skill block was always the reference; see that block's
// own comment). Established before any edit here: this was NOT one shared root cause. Every entity
// kind builds its own `inner` HTML inline, independently, inside `renderRegistry` — there is no single
// helper a team/agent/knowledge/project card all funnel through that dropped the body once for all
// four. Each kind separately chose not to render its own entity's body (and, for team/agent, several
// declared fields alongside it) — four separate omissions of the same MISTAKE class, not one bug in one
// function. The type card's `gates` row was already correct and is the reference the team flow fix
// (below) is measured against.
//
// These assertions are driven from the real scaffold `levare init` produces (`scaffoldStudio` +
// `loadRepo`, not a hand-built synthetic Repo) specifically so a future edit that changes the scaffold's
// shape without updating the renderer (or vice versa) fails here, rather than silently drifting apart.

import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldStudio } from "../src/init.ts";
import { loadRepo } from "../src/repo.ts";
import { loadExtras } from "../src/extra.ts";
import { renderRegistry } from "../src/board/render.ts";
import { renderProject } from "../src/board/render/project.ts";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function scaffoldRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "levare-registry-body-"));
  dirs.push(d);
  scaffoldStudio(d);
  return d;
}

/**
 * The RENDERED content of one entity's card only — `<div class="rendered">…</div>`, never the whole
 * `<article>`. Every card also carries a hidden `<textarea class="rawmd-source">` holding the entity's
 * full raw markdown (frontmatter + body, `esc()`-escaped) for the edit overlay — plain body text with
 * no HTML-special characters reads identically whether it came from the real render or that raw
 * fallback, so a `.toContain()` check against the whole `<article>` would pass even if the renderer
 * never actually rendered the field, purely because the raw source happens to repeat it. Scoping to
 * `.rendered` is what makes these assertions actually prove the RENDERER shows it.
 */
function cardFor(html: string, kind: string, name: string): string {
  const re = new RegExp(`<article class="entity card"[^>]*id="${kind}-${name}"[^>]*>[\\s\\S]*?<\\/article>`);
  const article = re.exec(html);
  if (!article) throw new Error(`no ${kind} card found for '${name}' in rendered registry HTML`);
  const rendered = /<div class="rendered">([\s\S]*)<textarea class="rawmd-source"/.exec(article[0]);
  if (!rendered) throw new Error(`no rendered content found for ${kind}/${name}`);
  return rendered[1];
}

describe("registry cards render each entity's declared body and fields (scaffold-driven)", () => {
  test("knowledge card renders the document's own body, not just its tags", () => {
    const root = scaffoldRoot();
    const repo = loadRepo(root);
    const html = renderRegistry(repo, root, "knowledge");
    const card = cardFor(html, "knowledge", "house-style");
    // knowledge/house-style.md's body — the actual reference content, not just its `tags:` chips.
    expect(card).toContain("Calm, factual, slightly dry");
    expect(card).toContain("voice"); // still carries its declared tags
  });

  test("skill card remains the working reference: description/body renders, no separate heading", () => {
    const root = scaffoldRoot();
    const repo = loadRepo(root);
    const html = renderRegistry(repo, root, "skills");
    const card = cardFor(html, "skills", "flow-design");
    expect(card).toContain("Design a user flow");
  });

  test("project pointer panel renders default_branch and the house-rules body, not pace alone", () => {
    const root = scaffoldRoot();
    const repo = loadRepo(root);
    const html = renderProject(repo, "studio", root);
    // projects/studio.md's body — where the project's house rules live.
    expect(html).toContain("Points at this studio repo itself");
    expect(html).toContain('<span class="k">default_branch</span>');
    expect(html).toContain("main");
  });

  test("agent card renders the member's own opening line, not just kind/model", () => {
    const root = scaffoldRoot();
    const repo = loadRepo(root);
    const html = renderRegistry(repo, root, "agents");
    const wren = cardFor(html, "agents", "wren");
    // agents/wren.md's body opens "You are Wren, a product framer." — the role a reader is looking for.
    expect(wren).toContain("You are Wren, a product framer.");
  });

  test("a cli agent's card renders its command argv, cwd, timeout, and result — not just kind/model", () => {
    const root = scaffoldRoot();
    const repo = loadRepo(root);
    const html = renderRegistry(repo, root, "agents");
    const finch = cardFor(html, "agents", "finch");
    expect(finch).toContain("codex");
    expect(finch).toContain("--repo");
    expect(finch).toContain("{feature_repo}");
    expect(finch).toContain("600s");
    expect(finch).toContain("Emits review commentary as plain text on stdout");
  });

  test("team card renders its charter body — what the team actually does", () => {
    const root = scaffoldRoot();
    const repo = loadRepo(root);
    const html = renderRegistry(repo, root, "teams");
    const kestrel = cardFor(html, "teams", "kestrel");
    // teams/kestrel.md's body — exactly what a reader asking "what does this team do" needs.
    expect(kestrel).toContain("Kestrel takes a pitch to an approved specification");
  });

  test("team card renders its declared guardrails and knowledge grants", () => {
    const root = scaffoldRoot();
    const repo = loadRepo(root);
    const html = renderRegistry(repo, root, "teams");
    const kestrel = cardFor(html, "teams", "kestrel");
    expect(kestrel).toContain("main"); // protected_branches: [main]
    expect(kestrel).toContain("deploy/"); // protected_paths: [deploy/]
    expect(kestrel).toContain("force-push"); // never: [force-push, ...]
    expect(kestrel).toContain("house-style"); // knowledge: [house-style]
  });

  // The one the goal names as most wrong: the flow row used to show `members` (wr → ly → fi), a flat
  // chain that drops both human gates and the loop's own bound/escalation — the exact shape a reader
  // needs to see on a board whose entire premise is Conductor approval at a gate.
  test("team card's flow row renders declared stages, gates, and the loop — not a flat member chain", () => {
    const root = scaffoldRoot();
    const repo = loadRepo(root);
    const html = renderRegistry(repo, root, "teams");
    const kestrel = cardFor(html, "teams", "kestrel");
    const flowRow = /<div class="flowstrip">[\s\S]*?<\/div>\s*<div class="card__h">Definition/.exec(kestrel);
    expect(flowRow).not.toBeNull();
    const flow = flowRow![0];
    // Two human gates (kestrel.md declares `gate: human` twice) — must be visibly distinct from a step.
    expect((flow.match(/class="diamond is-gate"/g) || []).length).toBe(2);
    // The loop's own bound and escalation, not silently collapsed into a third step.
    expect(flow).toContain("spec.approved");
    expect(flow).toContain("3");
    expect(flow).toContain("gate");
  });

  test("every registry entity kind the scaffold produces renders at least one card with no HTML injection from raw markdown", () => {
    const root = scaffoldRoot();
    const repo = loadRepo(root);
    const extras = loadExtras(root);
    const html = renderRegistry(repo, root);
    expect(repo.teams.size).toBeGreaterThan(0);
    expect(repo.agents.size).toBeGreaterThan(0);
    expect(extras.skills.length).toBeGreaterThan(0);
    expect(extras.knowledge.length).toBeGreaterThan(0);
    expect(repo.types.size).toBeGreaterThan(0);
    expect(repo.connectors.size).toBeGreaterThan(0);
    expect(html).not.toContain("<script>");
  });
});

// Fault 2: a plain-text `.prow` row's label and value rendered with no visible separation —
// `protected_branchmain`, `context_artifactinline` — while the `never` row directly below (chip-
// valued) was fine. Root cause traced to ONE shared rule: `.prow .k{ width:78px; flex:none }` gave
// every label a fixed box regardless of content; `protected_branches`/`protected_paths`/
// `context_artifacts` (18 chars, no space to wrap on) simply overflowed it with no clipping and no
// gap, running straight into the value beside it. The markup was never the problem (every `.prow` row,
// working or broken, has always rendered as two adjacent spans relying on the row's own flex `gap` for
// separation) — both the team-card guardrails rows and the agent-card context_artifacts row share this
// identical CSS rule, so one fix (min-width, not a fixed width) closes both.
describe("fault 2: a long plain-text .prow label no longer collides with its value", () => {
  const CSS = readFileSync("assets/styles.css", "utf8");

  test(".prow .k no longer forces a fixed width a long label can silently overflow", () => {
    const rule = /\.prow \.k\{([^}]*)\}/.exec(CSS)![1];
    // A plain `.not.toContain("width:78px")` would false-fail here too — "min-width:78px" contains
    // that exact substring. Assert there is no bare `width:` declaration (only `min-width:`).
    expect(/(?<!min-)width:/.test(rule)).toBe(false);
    expect(rule).toContain("min-width:78px"); // short labels keep their existing column alignment
  });

  test("team card: protected_branches/protected_paths render as their own label+value pair, same shape as the working 'never' chip row", () => {
    const root = scaffoldRoot();
    const repo = loadRepo(root);
    const html = renderRegistry(repo, root, "teams");
    const kestrel = cardFor(html, "teams", "kestrel");
    expect(kestrel).toContain('<span class="k">protected_branches</span><span class="v mono">main</span>');
    expect(kestrel).toContain('<span class="k">protected_paths</span><span class="v mono">deploy/</span>');
  });

  // The scaffold's own agents never declare context_artifacts — see board-render.test.ts's own "agent
  // card: context_artifacts" test (golden fixture's rook) for the paired assertion on that row.
});

// Fault 3: `.flowstrip` wraps on a narrow card, and the arrow joined between nodes by a plain
// `.join()` was its own flex sibling — the wrap algorithm could break the line right after an arrow,
// leaving it orphaned at the end of one line ("wr → ◆ → ly → ◆ →") with the step it points at starting
// fresh on the next, right above the loop row. Fixed by rendering each arrow INSIDE the same flex item
// as the node it precedes (`.fpair`) — wrapping can now only ever happen between complete pairs.
describe("fault 3: no orphaned arrow in a wrapped team flow row", () => {
  test("every arrow is grouped with its following node in one .fpair flex item, never a bare sibling", () => {
    const root = scaffoldRoot();
    const repo = loadRepo(root);
    const html = renderRegistry(repo, root, "teams");
    const kestrel = cardFor(html, "teams", "kestrel");
    const flowRow = /<div class="flowstrip">([\s\S]*?)<\/div>\s*<div class="card__h">Definition/.exec(kestrel)![1];
    // kestrel's flow (brief, gate, design, gate, loop) is 5 nodes — the first renders bare, the other
    // 4 each pull their preceding join arrow (&rarr;) into their own .fpair, so 4 join arrows and 4
    // .fpair wrappers. The loop's OWN internal glyph (&#8646;, between its two `between` avatars) also
    // carries class="arr" — a different, unrelated glyph — so it's counted separately, not conflated.
    const joinArrowCount = (flowRow.match(/<span class="arr">&rarr;<\/span>/g) || []).length;
    const loopGlyphCount = (flowRow.match(/<span class="arr">&#8646;<\/span>/g) || []).length;
    const fpairCount = (flowRow.match(/<div class="fpair">/g) || []).length;
    expect(joinArrowCount).toBe(4);
    expect(loopGlyphCount).toBe(1);
    expect(fpairCount).toBe(4);
    // Every join arrow's opening tag is immediately preceded by an .fpair opening tag — never a bare
    // sibling of `.flowstrip` that the wrap algorithm could strand alone at the end of a line.
    expect((flowRow.match(/<div class="fpair"><span class="arr">&rarr;<\/span>/g) || []).length).toBe(4);
  });

  test("assets/styles.css defines a real .fpair rule keeping the pair one flex item", () => {
    const css = readFileSync("assets/styles.css", "utf8");
    const rule = /\.flowstrip \.fpair\{([^}]*)\}/.exec(css);
    expect(rule).not.toBeNull();
    expect(rule![1].trim().length).toBeGreaterThan(0);
  });
});

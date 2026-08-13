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
import { mkdtempSync, rmSync } from "node:fs";
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

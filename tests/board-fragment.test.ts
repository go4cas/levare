import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBoard, extractFragment, isFragmentRequest, ROUTES } from "../src/board/serve.ts";

// NOTES UI10 — client-side navigation. `extractFragment` slices the swappable regions (the content
// column, and a page's own extras — gate-summon templates, the registry editor overlay) back out of
// the EXACT SAME HTML string a cold GET already renders (render.ts#pageBody's `<!--main-->`/
// `<!--extras-->` markers), rather than a second render call — this suite proves that directly by
// diffing a fragment response against the ordinary HTML response for the same URL, not just asserting
// the fragment "looks right" in isolation.

const FRAG = { "X-Levare-Fragment": "1" };

function req(url: string, init?: RequestInit): Request {
  return new Request(`http://localhost${url}`, init);
}

describe("extractFragment — pure string extraction", () => {
  test("returns null when the HTML carries no markers (e.g. a standalone screen)", () => {
    expect(extractFragment("<html><title>x</title><body>no markers here</body></html>")).toBeNull();
  });

  test("pulls title, main, extras, and a registry highlight id out of a rendered page", () => {
    const html = [
      "<html><head><title>levare &middot; registry</title></head><body>",
      '<div class="app">RAIL<!--main--><main class="main" data-highlight="connectors-linear">HELLO</main><!--/main-->ORCH</div>',
      '<div data-extras-host><!--extras--><div id="editor-overlay">OVERLAY</div><!--/extras--></div>',
      "</body></html>",
    ].join("");
    const frag = extractFragment(html)!;
    expect(frag).not.toBeNull();
    expect(frag.title).toBe("levare &middot; registry");
    expect(frag.main).toBe('<main class="main" data-highlight="connectors-linear">HELLO</main>');
    expect(frag.extras).toBe('<div id="editor-overlay">OVERLAY</div>');
    expect(frag.highlightId).toBe("connectors-linear");
  });

  test("highlightId is null when the main tag carries no data-highlight", () => {
    const html = '<title>t</title><!--main--><main class="main">x</main><!--/main--><!--extras--><!--/extras-->';
    expect(extractFragment(html)!.highlightId).toBeNull();
  });

  test("extras is the empty string, not absent, when the page has none", () => {
    const html = '<title>t</title><!--main--><main class="main">x</main><!--/main--><!--extras--><!--/extras-->';
    expect(extractFragment(html)!.extras).toBe("");
  });

  // NOTES ORCH-STALE-CARD: `orchAction` (the run view's own gate card, render/shell.ts#orchestratorPanel's
  // `actionableHtml`) used to have no marker at all — nothing for a fragment response to carry, so no
  // client refresh could ever resync it. It's sliced from `<!--orchaction-->`/`<!--/orchaction-->`, the
  // same string-slicing mechanism as `main`/`extras`/`orchTail`, and lives OUTSIDE the main markers
  // (inside the orch aside), same as `orchTail`.
  test("pulls orchAction out of the orch aside, independent of main/extras", () => {
    const html = [
      '<title>t</title><!--main--><main class="main">HELLO</main><!--/main-->',
      '<aside class="orch" data-scope="storefront"><div class="orch__body">',
      '<div class="orch__tail" data-orch-tail><!--orchtail--><!--/orchtail--></div>',
      '<div class="orch__action" data-orch-action><!--orchaction--><article class="gate gate--start">CARD</article><!--/orchaction--></div>',
      "</div></aside>",
    ].join("");
    expect(extractFragment(html)!.orchAction).toBe('<article class="gate gate--start">CARD</article>');
  });

  test("orchAction is the empty string, not absent, when the page's unit has no open gate", () => {
    const html = [
      '<title>t</title><!--main--><main class="main">x</main><!--/main-->',
      '<aside class="orch" data-scope="studio"><div class="orch__body">',
      '<div class="orch__action" data-orch-action><!--orchaction--><!--/orchaction--></div>',
      "</div></aside>",
    ].join("");
    expect(extractFragment(html)!.orchAction).toBe("");
  });

  // NOTES ORCH-STALE-CARD addendum: `orchBriefing` (the narrated summary turn — "N gates on you" —
  // shared across every screen, not just the run view) had the identical gap, found only after
  // `orchAction` was fixed: it names the same gate count the action region's card is drawn from, but
  // carried no marker of its own either.
  test("pulls orchBriefing out of the orch aside, independent of orchAction/orchTail", () => {
    const html = [
      '<title>t</title><!--main--><main class="main">HELLO</main><!--/main-->',
      '<aside class="orch" data-scope="studio"><div class="orch__body">',
      '<div class="orch__briefing" data-orch-briefing><!--orchbriefing--><p>Nothing needs you right now.</p><!--/orchbriefing--></div>',
      '<div class="orch__tail" data-orch-tail><!--orchtail--><!--/orchtail--></div>',
      '<div class="orch__action" data-orch-action><!--orchaction--><!--/orchaction--></div>',
      "</div></aside>",
    ].join("");
    expect(extractFragment(html)!.orchBriefing).toBe("<p>Nothing needs you right now.</p>");
  });
});

describe("isFragmentRequest", () => {
  test("true only for the exact header value this project's own client ever sends", () => {
    expect(isFragmentRequest(req("/studio", { headers: FRAG }))).toBe(true);
    expect(isFragmentRequest(req("/studio"))).toBe(false);
    expect(isFragmentRequest(req("/studio", { headers: { "X-Levare-Fragment": "true" } }))).toBe(false);
  });
});

describe("levare serve — fragment GETs (NOTES UI10)", () => {
  let board: ReturnType<typeof createBoard>;

  beforeAll(() => {
    board = createBoard("fixtures/golden");
  });
  afterAll(() => {
    board.close();
  });

  test("a cold GET (no fragment header) of every `page` route is completely unaffected — still the full document", async () => {
    const pageRoutes = ROUTES.filter((r) => r.page && r.method === "GET" && !r.pattern.includes(":"));
    expect(pageRoutes.length).toBeGreaterThan(0);
    for (const route of pageRoutes) {
      const res = await board.fetch(req(route.pattern));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const body = await res.text();
      expect(body).toContain("<!doctype html>");
      expect(body).toContain('class="apphead"');
      expect(body).toContain('class="rail"');
      // The markers are present but never observable as a client-facing behavior change — a cold GET
      // renders through the identical `shell()`/`pageBody()` path it always has.
      expect(body).toContain("<!--main-->");
    }
  });

  test("a cold GET of a parameterized page route (/project/:name) is also the full document, unaffected", async () => {
    const res = await board.fetch(req("/project/storefront"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("<!doctype html>");
    expect(body).toContain('class="orch');
  });

  test("a fragment GET of /studio returns JSON with title/main/extras — never the full document", async () => {
    const res = await board.fetch(req("/studio", { headers: FRAG }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.title).toBe("string");
    expect(body.title).toContain("Studio");
    expect(body.main).toContain('<main class="main"');
    expect(body.main).not.toContain("<!doctype html>");
    expect(body.main).not.toContain('class="rail"'); // the rail is shell furniture, never part of the fragment
    expect(body.main).not.toContain('class="orch"'); // neither is the Orchestrator panel
    expect(typeof body.extras).toBe("string");
  });

  test("the fragment's `main` is byte-identical to the SAME region inside the ordinary full-page response — one render path, not a fork", async () => {
    for (const url of ["/studio", "/project/storefront", "/registry/teams", "/run/storefront/checkout-flow"]) {
      const [fullRes, fragRes] = await Promise.all([board.fetch(req(url)), board.fetch(req(url, { headers: FRAG }))]);
      const fullHtml = await fullRes.text();
      const fragBody = await fragRes.json();
      const extractedFromFull = extractFragment(fullHtml)!;
      expect(fragBody.main).toBe(extractedFromFull.main);
      expect(fragBody.title).toBe(extractedFromFull.title);
      expect(fragBody.extras).toBe(extractedFromFull.extras);
      // NOTES ORCH-STALE-CARD: the SAME one-render-path guarantee now covers `orchAction` too — the
      // regression this bug was: a fragment response that silently dropped/forked the gate card content
      // a cold GET would have shown, since nothing sliced it out at all.
      expect(fragBody.orchAction).toBe(extractedFromFull.orchAction);
      // NOTES ORCH-STALE-CARD addendum: and now `orchBriefing` too, found stale one element up from
      // `orchAction` after that fix shipped.
      expect(fragBody.orchBriefing).toBe(extractedFromFull.orchBriefing);
    }
  });

  // NOTES ORCH-STALE-CARD addendum: `orchBriefing` is populated on every screen (unlike `orchAction`,
  // run-view-only) — this environment has no ANTHROPIC_API_KEY, so the panel renders its disabled turn
  // rather than the real gate-count sentence (render/shell.ts#orchestratorPanel suppresses `briefingHtml`
  // when the Orchestrator is unavailable — a real turn either way, never an empty region). The exact
  // gate-count sentence text is pinned separately in tests/run-briefing-content.test.ts, where the
  // Orchestrator status is pinned `available: true` directly against `renderRun`/`renderStudio`.
  test("the studio's fragment carries a real briefing turn in orchBriefing, never an empty region", async () => {
    const res = await board.fetch(req("/studio", { headers: FRAG }));
    const body = await res.json();
    expect(body.orchBriefing).not.toBe("");
    expect(body.orchBriefing).toContain('class="turn turn--orch"');
  });

  // NOTES ORCH-STALE-CARD: the run view's own gate card lives in `orchAction`, never in `main` — a
  // client refresh that only ever resynced `main` (the pre-fix behavior) would leave a Conductor
  // looking at an up-to-date score rail beside a frozen gate card. Pinning the real content here (not
  // just presence) against fixtures/golden's known open gate on storefront/checkout-flow.
  test("a run page's fragment carries its unit's open gate in orchAction, not in main", async () => {
    const res = await board.fetch(req("/run/storefront/checkout-flow", { headers: FRAG }));
    const body = await res.json();
    expect(body.orchAction).toContain('class="gate');
    expect(body.orchAction).toContain("spec-checkout-flow-v1");
    expect(body.main).not.toContain('class="gate');
  });

  test("a registry deep link (/registry/connectors/linear) carries the highlight id in the fragment, matching the full page's data-highlight", async () => {
    const res = await board.fetch(req("/registry/connectors/linear", { headers: FRAG }));
    const body = await res.json();
    expect(body.highlightId).toBe("connectors-linear");
    expect(body.main).toContain('data-highlight="connectors-linear"');
  });

  test("the registry fragment's extras carry the editor overlay; a non-registry page's extras are empty", async () => {
    const registryRes = await board.fetch(req("/registry/teams", { headers: FRAG }));
    const registryBody = await registryRes.json();
    expect(registryBody.extras).toContain('id="editor-overlay"');

    const studioRes = await board.fetch(req("/studio", { headers: FRAG }));
    const studioBody = await studioRes.json();
    expect(studioBody.extras).toBe("");
  });

  test("a project page's extras carry its gate-summon templates when it has an open gate", async () => {
    const res = await board.fetch(req("/project/storefront", { headers: FRAG }));
    const body = await res.json();
    // storefront's golden fixture carries at least one gate; when it does, the template lives in
    // extras (a project-page-only region), never inside `main` itself.
    if (body.extras.length > 0) {
      expect(body.extras).toContain("<template");
      expect(body.main).not.toContain("<template");
    }
  });

  test("non-page routes ignore the fragment header entirely — an asset request answers exactly as before", async () => {
    const res = await board.fetch(req("/styles.css", { headers: FRAG }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
  });

  test("an unknown route with the fragment header is still a plain 404 JSON, not a fragment envelope", async () => {
    const res = await board.fetch(req("/nope", { headers: FRAG }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.main).toBeUndefined();
  });
});

describe("levare serve — fragment GET against an uninitialized studio falls back to real HTML (FAILURE HONESTY)", () => {
  let root: string;
  let board: ReturnType<typeof createBoard>;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "levare-fragment-onboarding-"));
    board = createBoard(root);
  });
  afterAll(() => {
    board.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("a fragment GET of a page route on an uninitialized studio returns the onboarding HTML, not JSON — the client's job is to detect this and fall back to a real navigation", async () => {
    const res = await board.fetch(req("/studio", { headers: FRAG }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).not.toContain("<!--main-->"); // the onboarding screen never goes through pageBody()
  });
});

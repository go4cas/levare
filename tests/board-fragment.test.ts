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

  // Finding 131: the header's version chip sits OUTSIDE the orch aside entirely (inside `<header
  // class="apphead">`, never touched by any swap) — same `<!--marker-->` mechanism as `orchAction`/
  // `orchBriefing` so a client resync has something to slice out at all.
  test("pulls appVersion out of the app header, independent of every other region", () => {
    const html = [
      '<title>t</title><header class="apphead"><span class="apphead__ver mono" data-app-version>',
      "<!--appversion-->dev (build abc1234)<!--/appversion--></span></header>",
      '<!--main--><main class="main">HELLO</main><!--/main-->',
    ].join("");
    expect(extractFragment(html)!.appVersion).toBe("dev (build abc1234)");
  });

  test("appVersion is the empty string, not absent, when the header carries no marker (e.g. an older render path)", () => {
    const html = '<title>t</title><!--main--><main class="main">x</main><!--/main--><!--extras--><!--/extras-->';
    expect(extractFragment(html)!.appVersion).toBe("");
  });

  // Finding 40 (REOPENED): the header's Orchestrator-availability dot, scoped to just the badge span
  // (not the whole `<details class="orchind">`) so a resync can never close a popover the Conductor has
  // open — same marker mechanism as `appVersion`, same reasoning (a header-level fact outside every
  // swap region).
  test("pulls orchIndicator out of the app header, scoped to the badge alone", () => {
    const html = [
      '<title>t</title><header class="apphead"><details class="orchind"><summary class="orchind__sum">',
      '<span data-orchind-badge><!--orchind--><span class="chip is-done">orchestrator: on</span><!--/orchind--></span>',
      "</summary><div class=\"orchind__pop\">POPOVER</div></details></header>",
      '<!--main--><main class="main">HELLO</main><!--/main-->',
    ].join("");
    expect(extractFragment(html)!.orchIndicator).toBe('<span class="chip is-done">orchestrator: on</span>');
  });

  test("orchIndicator is the empty string, not absent, when the page carries no marker", () => {
    const html = '<title>t</title><!--main--><main class="main">x</main><!--/main--><!--extras--><!--/extras-->';
    expect(extractFragment(html)!.orchIndicator).toBe("");
  });

  // Finding 40 (REOPENED): the rail's project list (with live unit counts), connector health dots, and
  // ideas list — the three named regions from the corrected finding — each sliced independently, same
  // mechanism as `orchIndicator` above. The rail's Registry section carries no marker (deliberately out
  // of this finding's scope, Finding 129) and so is never present in a fragment.
  test("pulls railProjects, railConnectors, and railIdeas out of the rail, independent of each other and of main", () => {
    const html = [
      '<title>t</title><aside class="rail">',
      '<section class="railsec"><h3 class="railsec__h">Projects</h3><div data-rail-projects><!--railprojects--><a class="rel">acme<span class="ag">3</span></a><!--/railprojects--></div></section>',
      '<section class="railsec"><h3 class="railsec__h">Connectors</h3><div data-rail-connectors><!--railconnectors--><a class="crow">github</a><!--/railconnectors--></div></section>',
      '<section class="railsec"><h3 class="railsec__h">Ideas</h3><div data-rail-ideas><!--railideas--><a class="idea">loyalty</a><!--/railideas--></div></section>',
      "</aside>",
      '<!--main--><main class="main">HELLO</main><!--/main-->',
    ].join("");
    const frag = extractFragment(html)!;
    expect(frag.railProjects).toBe('<a class="rel">acme<span class="ag">3</span></a>');
    expect(frag.railConnectors).toBe('<a class="crow">github</a>');
    expect(frag.railIdeas).toBe('<a class="idea">loyalty</a>');
  });

  test("railProjects/railConnectors/railIdeas are the empty string, not absent, when the page carries no markers", () => {
    const html = '<title>t</title><!--main--><main class="main">x</main><!--/main--><!--extras--><!--/extras-->';
    const frag = extractFragment(html)!;
    expect(frag.railProjects).toBe("");
    expect(frag.railConnectors).toBe("");
    expect(frag.railIdeas).toBe("");
  });

  // Finding 136 item 3: the panel's own reflection of `status.available` — the `<aside>`'s own
  // `is-disabled` class and the composer — had the identical Finding 40 gap and never got the fix.
  // `orchDisabled` is read off the `<aside>` tag itself (no innerHTML region to slice, since a class
  // attribute isn't reachable through a `<!--marker-->`), `orchComposer` off its own marker pair.
  test("pulls orchDisabled and orchComposer out of the orch aside", () => {
    const html = [
      '<title>t</title><!--main--><main class="main">HELLO</main><!--/main-->',
      '<aside class="orch is-disabled" data-scope="studio" data-orch-disabled="true"><div class="orch__body">',
      '<div class="orch__action" data-orch-action><!--orchaction--><!--/orchaction--></div>',
      "</div>",
      '<div data-orch-composer><!--orchcomposer--><div class="composer is-disabled">DISABLED FORM</div><!--/orchcomposer--></div>',
      "</aside>",
    ].join("");
    const frag = extractFragment(html)!;
    expect(frag.orchDisabled).toBe(true);
    expect(frag.orchComposer).toBe('<div class="composer is-disabled">DISABLED FORM</div>');
  });

  test("orchDisabled is false, and orchComposer real markup, for an enabled orch aside", () => {
    const html = [
      '<title>t</title><!--main--><main class="main">HELLO</main><!--/main-->',
      '<aside class="orch" data-scope="studio" data-orch-disabled="false"><div class="orch__body">',
      '<div class="orch__action" data-orch-action><!--orchaction--><!--/orchaction--></div>',
      "</div>",
      '<div data-orch-composer><!--orchcomposer--><div class="composer">LIVE FORM</div><!--/orchcomposer--></div>',
      "</aside>",
    ].join("");
    const frag = extractFragment(html)!;
    expect(frag.orchDisabled).toBe(false);
    expect(frag.orchComposer).toBe('<div class="composer">LIVE FORM</div>');
  });

  test("orchDisabled defaults to false and orchComposer to the empty string when the page carries no markers", () => {
    const html = '<title>t</title><!--main--><main class="main">x</main><!--/main--><!--extras--><!--/extras-->';
    const frag = extractFragment(html)!;
    expect(frag.orchDisabled).toBe(false);
    expect(frag.orchComposer).toBe("");
  });

  // Finding 136 item 2: the panel header's own "{scope} scope" label — the SAME `scope` value the
  // `<aside>`'s `data-scope` attribute carries, rendered a second time as text, sliced independently
  // via its own `<!--orchscope-->` marker.
  test("pulls orchScope out of the orch header, independent of data-scope", () => {
    const html = [
      '<title>t</title><!--main--><main class="main">HELLO</main><!--/main-->',
      '<aside class="orch" data-scope="jot" data-orch-disabled="false">',
      '<header class="orch__head"><span class="orch__scope" data-orch-scope><!--orchscope-->jot scope<!--/orchscope--></span></header>',
      "</aside>",
    ].join("");
    const frag = extractFragment(html)!;
    expect(frag.scope).toBe("jot");
    expect(frag.orchScope).toBe("jot scope");
  });

  test("orchScope is the empty string, not absent, when the page carries no marker", () => {
    const html = '<title>t</title><!--main--><main class="main">x</main><!--/main--><!--extras--><!--/extras-->';
    expect(extractFragment(html)!.orchScope).toBe("");
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
      // Finding 131: and now the header's version chip too — same guarantee, same reason.
      expect(fragBody.appVersion).toBe(extractedFromFull.appVersion);
      // Finding 40 (REOPENED): and now the header's Orchestrator dot and the rail's three resynced
      // regions — same guarantee, same reason: one render call, sliced four more ways.
      expect(fragBody.orchIndicator).toBe(extractedFromFull.orchIndicator);
      expect(fragBody.railProjects).toBe(extractedFromFull.railProjects);
      expect(fragBody.railConnectors).toBe(extractedFromFull.railConnectors);
      expect(fragBody.railIdeas).toBe(extractedFromFull.railIdeas);
      // Finding 136 item 3: and now the panel's own disabled-state reflection too — same guarantee.
      expect(fragBody.orchDisabled).toBe(extractedFromFull.orchDisabled);
      expect(fragBody.orchComposer).toBe(extractedFromFull.orchComposer);
      // Finding 136 item 2: and the panel header's own scope label — same guarantee.
      expect(fragBody.orchScope).toBe(extractedFromFull.orchScope);
    }
  });

  // Finding 136 item 2: `scope` (the `<aside>`'s `data-scope` attribute, already resynced by
  // `syncOrchTail` on a scope-changing navigation) and `orchScope` (the header's visible label) name
  // the same fact and must always agree, never just the attribute alone.
  test("scope and orchScope always agree — the label text is derived from the same value as the attribute", async () => {
    for (const url of ["/studio", "/project/storefront", "/run/storefront/checkout-flow"]) {
      const res = await board.fetch(req(url, { headers: FRAG }));
      const body = await res.json();
      expect(body.orchScope).toBe(`${body.scope} scope`);
    }
  });

  // Finding 136 item 3: the header dot and the panel's disabled reflection must never disagree — both
  // are sliced from the SAME rendered string, off the SAME `status.available` this environment resolves
  // (no ANTHROPIC_API_KEY in the test env, so both read as unavailable/disabled here).
  test("orchIndicator and orchDisabled always agree — one status, two renderings, never a fork", async () => {
    for (const url of ["/studio", "/project/storefront", "/run/storefront/checkout-flow"]) {
      const res = await board.fetch(req(url, { headers: FRAG }));
      const body = await res.json();
      const indicatorSaysOff = body.orchIndicator.includes("orchestrator: off");
      expect(body.orchDisabled).toBe(indicatorSaysOff);
      expect(body.orchComposer.includes('class="composer is-disabled"')).toBe(indicatorSaysOff);
    }
  });

  // Finding 40 (REOPENED): each region must carry real content, not just an empty marker, or the
  // corresponding `assets/app.js#sync*` function would have nothing to resync the rail/header to.
  // fixtures/golden has at least one project and one connector (see other suites), and the Orchestrator
  // indicator always renders a chip regardless of availability.
  test("every fragment GET carries non-empty orchIndicator, railProjects, and railConnectors content", async () => {
    const res = await board.fetch(req("/studio", { headers: FRAG }));
    const body = await res.json();
    expect(body.orchIndicator).toContain('class="chip');
    expect(body.railProjects).toContain('class="rel"');
    expect(body.railConnectors).toContain('class="crow"');
  });

  // Finding 131: the fragment must actually carry the chip's real content (a `--define`-stamped build
  // string, or a bare "vX.Y.Z" for a source run — see `src/version.ts#versionChip`), not just an empty
  // marker, or `syncAppVersion` would have nothing to resync the header to.
  test("every fragment GET carries a non-empty, version-shaped appVersion", async () => {
    const res = await board.fetch(req("/studio", { headers: FRAG }));
    const body = await res.json();
    expect(body.appVersion.length).toBeGreaterThan(0);
    expect(body.appVersion).toMatch(/^(v\d+\.\d+\.\d+|dev \(build .+\))$/);
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

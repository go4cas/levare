import { test, expect, describe } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import {
  statusBadge,
  paceBadge,
  tag,
  chip,
  iconLink,
  statStrip,
  counter,
  emptyState,
  pendingState,
  card,
  confirmModal,
  editorOverlay,
} from "../src/board/components.ts";
import { loadRepo } from "../src/repo.ts";
import { renderStudio, renderProject } from "../src/board/render.ts";

// NOTES REV4: render.ts is now a thin re-export barrel over render/ (one module per screen plus a
// shared shell.ts) — these source-text assertions concern the render LAYER as a whole, so RENDER_SRC
// concatenates the barrel and every module under render/, not just the barrel file itself.
const RENDER_SRC = [
  readFileSync("src/board/render.ts", "utf8"),
  ...readdirSync("src/board/render").map((f) => readFileSync(`src/board/render/${f}`, "utf8")),
].join("\n");

const root = "fixtures/golden";
const repo = loadRepo(root);
const now = new Date("2026-07-11T20:00:00Z");

// ---------------------------------------------------------------------------
// NOTES UI6: unit tests for each shared primitive in isolation.
// ---------------------------------------------------------------------------
describe("components.ts primitives", () => {
  test("statusBadge wraps status.ts's canonical map into a .chip", () => {
    expect(statusBadge("done")).toBe('<span class="chip is-done">done</span>');
    expect(statusBadge("needs-you", "2 gates")).toBe('<span class="chip is-gate">2 gates</span>');
    expect(statusBadge("active", "approved", "sstep__chip")).toBe('<span class="chip is-active sstep__chip">approved</span>');
  });

  test("paceBadge never uses gate brass — only the active/waiting canonical hues", () => {
    expect(paceBadge("auto")).toBe(statusBadge("active", "auto"));
    expect(paceBadge("step")).toBe(statusBadge("waiting", "step"));
    expect(paceBadge("auto")).not.toContain("is-gate");
    expect(paceBadge("step")).not.toContain("is-gate");
  });

  test("tag/chip render the bare-word entity-kind treatment, escaped", () => {
    expect(tag("agent")).toBe('<span class="entity__kind">agent</span>');
    expect(chip("team")).toBe('<span class="entity__kind">team</span>');
    expect(tag("<b>")).toBe('<span class="entity__kind">&lt;b&gt;</span>');
  });

  test("iconLink takes an object param and emits the right vendored icon", () => {
    const html = iconLink({ icon: "ti-brand-github", href: "https://github.com/acme/storefront", label: "repo" });
    expect(html).toContain('class="iconlink ti-brand-github"');
    expect(html).toContain('href="https://github.com/acme/storefront"');
    expect(html).toContain('aria-label="repo"');
  });

  test("statStrip renders one grid sized to the stat count, with optional class/data attrs", () => {
    const html = statStrip([
      { value: "3", label: "Gates on you", cls: "is-gate", attr: { name: "data-gatestat", value: 3 } },
      { value: "$1.20", label: "Spend" },
    ]);
    expect(html).toContain('<div class="statstrip" style="grid-template-columns:repeat(2,1fr)">');
    expect(html).toContain('<div class="n is-gate" data-gatestat="3">3</div><div class="l">Gates on you</div>');
    expect(html).toContain('<div class="n">$1.20</div><div class="l">Spend</div>');
  });

  test("counter picks the section vs nav vocabulary, never the colour", () => {
    expect(counter(4)).toBe('<span class="sec__count">4</span>');
    expect(counter(4, { gatecount: true })).toBe('<span class="sec__count" data-gatecount="4">4</span>');
    expect(counter(7, { variant: "nav" })).toBe('<span class="ct">7</span>');
  });

  test("emptyState carries an optional next-action hint on the same line as the message", () => {
    expect(emptyState({ message: "Nothing running right now." })).toBe('<p class="empty">Nothing running right now.</p>');
    const withAction = emptyState({ message: "Nothing in flight.", action: "Open a project from the sidebar to start a unit." });
    expect(withAction).toContain('class="empty"');
    expect(withAction).toContain('class="empty__action"');
    expect(withAction).toMatch(/Nothing in flight\..*Open a project from the sidebar to start a unit\./);
  });

  test("pendingState never emits a spinner — the same quiet dots vocabulary as the composer's pending state", () => {
    const html = pendingState({ label: "dispatching wren · design…" });
    expect(html).toContain('class="pending"');
    expect(html).toContain('class="turn--pending"');
    expect(html).toContain('class="turn__dots"');
    expect(html).toContain('<span class="pending__label">dispatching wren · design…</span>');
  });

  test("card places title top-left and status top-right, with tags/body/meta following in order", () => {
    const html = card({
      as: "a",
      cls: "pcard",
      href: "/project/storefront",
      topCls: "pcard__top",
      title: "storefront",
      titleCls: "pcard__name",
      status: '<span class="chip is-gate">2 gates</span>',
      body: '<span class="pcard__desc">desc</span>',
      meta: '<div class="pcard__meta mono">meta</div>',
    });
    expect(html).toBe(
      '<a class="pcard" href="/project/storefront">' +
        '<div class="pcard__top"><span class="pcard__name">storefront</span><span class="chip is-gate">2 gates</span></div>' +
        '<span class="pcard__desc">desc</span>' +
        '<div class="pcard__meta mono">meta</div>' +
        "</a>",
    );
  });

  test("card supports a pre-slot and a wrapped title+extra block (the gate/unit-row anatomy)", () => {
    const html = card({
      as: "article",
      cls: "gate",
      attrs: { "data-gate-project": "storefront", "data-gate-target": "spec-v1" },
      topCls: "gate__top",
      pre: '<span class="gate__marker">&#9702;</span>',
      bodyWrapCls: "gate__body",
      title: "<b>name</b>",
      titleExtra: '<p class="gate__ctx">ctx</p>',
      status: '<span class="gate__badge">on you</span>',
      meta: '<div class="gate__verbs"></div>',
    });
    expect(html).toBe(
      '<article class="gate" data-gate-project="storefront" data-gate-target="spec-v1">' +
        '<div class="gate__top"><span class="gate__marker">&#9702;</span><div class="gate__body"><b>name</b><p class="gate__ctx">ctx</p></div><span class="gate__badge">on you</span></div>' +
        '<div class="gate__verbs"></div>' +
        "</article>",
    );
  });

  test("confirmModal and editorOverlay are the shared, hidden-by-default overlay surfaces", () => {
    const cm = confirmModal();
    expect(cm).toContain('id="confirm-modal"');
    expect(cm).toContain("hidden");
    expect(cm).toContain("data-confirm-keep");
    expect(cm).toContain("data-confirm-discard");

    const eo = editorOverlay();
    expect(eo).toContain('id="editor-overlay"');
    expect(eo).toContain("hidden");
    expect(eo).toContain("data-editor-save");
    expect(eo).toContain("data-editor-cancel");
  });
});

// ---------------------------------------------------------------------------
// The refactor's own proof: render.ts no longer hand-rolls the patterns components.ts now owns.
// ---------------------------------------------------------------------------
describe("render.ts routes every recurring pattern through components.ts, never a local copy", () => {
  test("no board renderer emits a .chip status badge except through statusBadge()/status.ts", () => {
    // render.ts never imports status.ts's own statusChip directly, and never hand-writes a `class="chip`
    // literal — every badge on the board is produced by components.ts#statusBadge, which is the only
    // function anywhere that touches status.ts's chipClass/statusLabel.
    expect(RENDER_SRC).not.toContain("statusChip");
    expect(RENDER_SRC).not.toMatch(/class="chip[\s"]/);
  });

  test("the Studio and Project stat rows are both produced by the same statStrip() primitive", () => {
    expect(RENDER_SRC).not.toMatch(/<div class="statstrip"/);
    const studioHtml = renderStudio(repo, root, now);
    const projectHtml = renderProject(repo, "storefront", root, now);
    expect(studioHtml).toContain('<div class="statstrip" style="grid-template-columns:repeat(5,1fr)">');
    expect(projectHtml).toContain('<div class="statstrip" style="grid-template-columns:repeat(5,1fr)">');
  });

  test("the previously-duplicated card top-row markup is gone from render.ts — pcard/entity/unit rows call card()", () => {
    expect(RENDER_SRC).not.toContain('<div class="pcard__top">');
    expect(RENDER_SRC).not.toContain('<div class="entity__head">');
    expect(RENDER_SRC).not.toContain('<div class="unit__head">');
    // The gate card's default (Needs You / project-summon) variant is also gone as a hand-rolled
    // template — only the deliberately-untouched start/blocked/artifact-blocked variants (NOTES UI6)
    // still build `.gate__top` literally; card()'s own `topCls` string covers the default variant.
    const gateTopLiterals = (RENDER_SRC.match(/<div class="gate__top">/g) || []).length;
    expect(gateTopLiterals).toBe(3); // start, blocked, artifact-blocked — see NOTES UI6
    expect(RENDER_SRC).toMatch(/card\(\{[\s\S]*?cls:\s*"pcard"/);
    expect(RENDER_SRC).toMatch(/card\(\{[\s\S]*?cls:\s*"entity card"/);
    expect(RENDER_SRC).toMatch(/card\(\{[\s\S]*?topCls:\s*"unit__head"/);
    expect(RENDER_SRC).toMatch(/card\(\{[\s\S]*?topCls:\s*"gate__top"/);
  });

  test("the empty states render through emptyState() with a message and, where called for, an action", () => {
    expect(RENDER_SRC).not.toContain('font-size:13.5px">Nothing');
    // "Running now" is empty in the golden fixture — its emptyState() output is exact and literal.
    const studioHtml = renderStudio(repo, root, now);
    expect(studioHtml).toContain('<p class="empty">Nothing running right now.</p>');
    // "In flight" carries the message+action pair — exercised against a synthetic zero-project repo
    // (the golden fixture always has an active unit, so its own Studio render never hits this state).
    const emptyRepo = { ...repo, projects: new Map(), units: [] };
    const emptyHtml = renderStudio(emptyRepo, root, now);
    expect(emptyHtml).toContain(
      '<p class="empty">Nothing in flight. <span class="empty__action">Open a project from the sidebar to start a unit.</span></p>',
    );
  });

  test("confirmModal/editorOverlay are imported from components.ts, not re-defined locally", () => {
    expect(RENDER_SRC).not.toContain("function confirmModalHtml");
    expect(RENDER_SRC).not.toContain('id="confirm-modal" hidden');
    expect(RENDER_SRC).not.toContain("function editorOverlay");
    // NOTES REV4: render/*.ts modules sit one directory deeper than the old render.ts, so the import
    // is "../components.ts" now, not "./components.ts" — either relative depth satisfies "imported,
    // not re-defined locally".
    expect(RENDER_SRC).toMatch(/from ["']\.+\/components\.ts["']/);
  });
});

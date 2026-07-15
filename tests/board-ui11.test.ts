import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, rmSync, cpSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { loadRepo } from "../src/repo.ts";
import { renderStudio, renderRegistry } from "../src/board/render.ts";
import type { Repo } from "../src/repo.ts";
import type { Project, Team, Connector } from "../src/types.ts";

// NOTES UI11 — the long-list treatment (nav "+ N more" expand, registry filter), the types/connectors
// registry-card sweep, and the connector auth:subscription warning styling. Server-rendered structure
// is asserted with plain string/regex matching (same style as tests/board-render.test.ts); the two
// client-side behaviours (expansion reveals the rest, filtering hides non-matching cards) exercise the
// real assets/app.js verbatim against a minimal hand-rolled DOM harness — the same no-DOM-dependency
// approach as tests/board-orchestrator-conversation.test.ts.

const root = "fixtures/golden";
const repo = loadRepo(root);
const now = new Date("2026-07-11T20:00:00Z");

function project(over: Partial<Project> & { name: string }): Project {
  return { repo: ".", remote: null, default_branch: "main", deploy: null, pace: "auto", houseRules: "", ...over };
}

function manyProjectsRepo(n: number): Repo {
  const projects = new Map<string, Project>();
  for (let i = 0; i < n; i++) {
    const name = `proj-${String(i).padStart(2, "0")}`;
    projects.set(name, project({ name }));
  }
  return { root: "/tmp/nonexistent-ui11-projects", teams: new Map(), agents: new Map(), types: new Map(), projects, connectors: new Map(), units: [], artifacts: new Map(), studio: {} };
}

function team(name: string): Team {
  return { name, consumes: [], produces: [], members: [], flow: [], style: { color: "#2E6FB0" }, charter: "", learnings: "" };
}

function manyTeamsRepo(n: number): Repo {
  const teams = new Map<string, Team>();
  for (let i = 0; i < n; i++) {
    const name = `team-${String(i).padStart(2, "0")}`;
    teams.set(name, team(name));
  }
  return { root: "/tmp/nonexistent-ui11-teams", teams, agents: new Map(), types: new Map(), projects: new Map(), connectors: new Map(), units: [], artifacts: new Map(), studio: {} };
}

function subscriptionConnectorRepo(): Repo {
  const connectors = new Map<string, Connector>([
    ["codex", { name: "codex", kind: "cli", command: "codex", env: [], auth: "subscription", plan: "ChatGPT Plus — flat monthly rate" }],
  ]);
  return { root: "/tmp/nonexistent-ui11-connectors", teams: new Map(), agents: new Map(), types: new Map(), projects: new Map(), connectors, units: [], artifacts: new Map(), studio: {} };
}

// ---------------------------------------------------------------------------
// Long lists — server-rendered structure
// ---------------------------------------------------------------------------

describe("UI11 item 1: left nav Projects/Ideas cap at 7 with a client-side '+ N more' expand", () => {
  test("9 projects: exactly 7 render outside the overflow wrapper, the remaining 2 sit inside a hidden overflow, and the button names the exact count", () => {
    const html = renderStudio(manyProjectsRepo(9), "/tmp/nonexistent-ui11-projects", now);
    const rail = /<aside class="rail">[\s\S]*?<\/aside>/.exec(html)![0];
    const projSection = /<h3 class="railsec__h">Projects<\/h3>([\s\S]*?)<\/section>/.exec(rail)![1];
    const overflowIdx = projSection.indexOf('<div class="railsec__overflow"');
    expect(overflowIdx).toBeGreaterThan(-1);
    const before = projSection.slice(0, overflowIdx);
    expect((before.match(/class="rel"/g) || []).length).toBe(7);
    const overflowMatch = /<div class="railsec__overflow" hidden>([\s\S]*?)<\/div><button/.exec(projSection);
    expect(overflowMatch).not.toBeNull();
    expect((overflowMatch![1].match(/class="rel"/g) || []).length).toBe(2);
    expect(projSection).toContain("+ 2 more");
    expect(projSection).toContain("data-rail-expand");
  });

  test("7 or fewer projects: no overflow wrapper, no '+ N more' button — rendered exactly as before", () => {
    const html = renderStudio(manyProjectsRepo(7), "/tmp/nonexistent-ui11-projects-7", now);
    const rail = /<aside class="rail">[\s\S]*?<\/aside>/.exec(html)![0];
    const projSection = /<h3 class="railsec__h">Projects<\/h3>([\s\S]*?)<\/section>/.exec(rail)![1];
    expect(projSection).not.toContain("railsec__overflow");
    expect(projSection).not.toContain("data-rail-expand");
    expect((projSection.match(/class="rel"/g) || []).length).toBe(7);
  });

  test("the golden fixture's single idea renders with no overflow wrapper (7-or-fewer path, unchanged)", () => {
    const html = renderStudio(repo, root, now);
    const rail = /<aside class="rail">[\s\S]*?<\/aside>/.exec(html)![0];
    const ideaSection = /<h3 class="railsec__h">Ideas<\/h3>([\s\S]*?)<\/section>/.exec(rail)![1];
    expect(ideaSection).not.toContain("railsec__overflow");
    expect(ideaSection).not.toContain("data-rail-expand");
  });

  describe("more than 7 ideas", () => {
    let scratchRoot: string | undefined;
    afterEach(() => {
      if (scratchRoot) rmSync(scratchRoot, { recursive: true, force: true });
      scratchRoot = undefined;
    });

    test("11 ideas total (1 fixture + 10 added): 7 visible, 4 in a hidden overflow, button names the count", () => {
      scratchRoot = mkdtempSync(join(tmpdir(), "levare-ui11-ideas-"));
      cpSync(root, scratchRoot, { recursive: true });
      for (let i = 0; i < 10; i++) {
        writeFileSync(join(scratchRoot, "ideas", `extra-idea-${String(i).padStart(2, "0")}.md`), `---\nname: extra-idea-${String(i).padStart(2, "0")}\n---\n\n# Extra idea ${i}\n`);
      }
      const html = renderStudio(loadRepo(scratchRoot), scratchRoot, now);
      const rail = /<aside class="rail">[\s\S]*?<\/aside>/.exec(html)![0];
      const ideaSection = /<h3 class="railsec__h">Ideas<\/h3>([\s\S]*?)<\/section>/.exec(rail)![1];
      const overflowIdx = ideaSection.indexOf('<div class="railsec__overflow"');
      expect(overflowIdx).toBeGreaterThan(-1);
      const before = ideaSection.slice(0, overflowIdx);
      expect((before.match(/class="idea"/g) || []).length).toBe(7);
      const overflowMatch = /<div class="railsec__overflow" hidden>([\s\S]*?)<\/div><button/.exec(ideaSection);
      expect((overflowMatch![1].match(/class="idea"/g) || []).length).toBe(4);
      expect(ideaSection).toContain("+ 4 more");
    });
  });
});

// ---------------------------------------------------------------------------
// Registry filter — server-rendered structure
// ---------------------------------------------------------------------------

describe("UI11 item 1: registry sections over 10 entries get a filter input; 10 or fewer get none", () => {
  test("11 teams: the filter input renders above the card grid", () => {
    const html = renderRegistry(manyTeamsRepo(11), "/tmp/nonexistent-ui11-teams-11", "teams");
    expect(html).toContain("data-registry-filter");
    expect(html).toContain('placeholder="Filter teams&hellip;"');
  });

  test("10 teams: no filter input", () => {
    const html = renderRegistry(manyTeamsRepo(10), "/tmp/nonexistent-ui11-teams-10", "teams");
    expect(html).not.toContain("data-registry-filter");
  });

  test("the golden fixture's small sections (5 types, 2 connectors, etc.) render no filter input", () => {
    for (const kind of ["teams", "agents", "skills", "knowledge", "types", "connectors", "evals"]) {
      const html = renderRegistry(repo, root, kind);
      expect(html).not.toContain("data-registry-filter");
    }
  });
});

// ---------------------------------------------------------------------------
// Types card sweep: no glyph row, expects/gates as chips (item 2)
// ---------------------------------------------------------------------------

describe("UI11 item 2: types cards drop the glyph row and render expects/gates as chips", () => {
  const html = renderRegistry(repo, root, "types");
  const feature = /<article class="entity card" id="types-feature"[\s\S]*?<\/article>/.exec(html)![0];

  test("no separate glyph row — the title already shows it (RULE A)", () => {
    expect(feature).not.toMatch(/<span class="k">glyph<\/span>/);
  });

  test("expects renders as chips, not an arrow-joined string", () => {
    expect(feature).toMatch(/<span class="k">expects<\/span><span class="v chiprow">(<span class="tag">[a-z-]+<\/span>)+<\/span>/);
    expect(feature).toContain('<span class="tag">product-brief</span>');
    expect(feature).not.toContain("&rarr;");
  });

  test("gates renders as chips, not a comma-joined string", () => {
    expect(feature).toMatch(/<span class="k">gates<\/span><span class="v chiprow">(<span class="tag">[a-z-]+<\/span>)+<\/span>/);
    expect(feature).toContain('<span class="tag">brief</span>');
  });
});

// ---------------------------------------------------------------------------
// Connectors card sweep: kind as a shape-treatment badge, C13 warning styling (item 3)
// ---------------------------------------------------------------------------

describe("UI11 item 3: connector kind renders as a shape-treatment badge, never raw text or colour", () => {
  const html = renderRegistry(repo, root, "connectors");
  const github = /<article class="entity card" id="connectors-github"[\s\S]*?<\/article>/.exec(html)![0];
  const linear = /<article class="entity card" id="connectors-linear"[\s\S]*?<\/article>/.exec(html)![0];

  test("cli renders with the (shared, agent-kind) outlined badge; mcp gets its own filled badge", () => {
    expect(github).toContain('<span class="kindbadge kindbadge--cli">cli</span>');
    expect(linear).toContain('<span class="kindbadge kindbadge--mcp">mcp</span>');
    expect(github).not.toContain('<span class="v mono">cli</span>');
  });

  test("no kindbadge rule (native/cli/remote/mcp) uses a status-palette colour", () => {
    const css = readFileSync("assets/styles.css", "utf8");
    const rules = css.match(/\.kindbadge[^{]*\{[^}]*\}/g) || [];
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      for (const forbidden of ["var(--active)", "var(--ok)", "var(--gate)", "var(--danger)"]) {
        expect(rule).not.toContain(forbidden);
      }
    }
  });
});

describe("UI11 item 3: an auth: subscription connector's scoping note gets real warning styling", () => {
  const html = renderRegistry(subscriptionConnectorRepo(), "/tmp/nonexistent-ui11-connectors", "connectors");
  const card = /<article class="entity card" id="connectors-codex"[\s\S]*?<\/article>/.exec(html)![0];

  test("the note renders inside the shared notice--warning treatment, with its alert icon", () => {
    expect(card).toContain('<div class="notice notice--warning">');
    expect(card).toContain("<svg");
    expect(card).toContain("cannot scope this credential");
  });

  test("an auth: env connector (github/linear) carries no warning at all", () => {
    const registryHtml = renderRegistry(repo, root, "connectors");
    const github = /<article class="entity card" id="connectors-github"[\s\S]*?<\/article>/.exec(registryHtml)![0];
    expect(github).not.toContain("notice--warning");
    expect(github).not.toContain("cannot scope");
  });
});

// ---------------------------------------------------------------------------
// Client-side behaviour — a minimal hand-rolled DOM harness (no DOM/browser-automation dependency,
// same approach as tests/board-orchestrator-conversation.test.ts's own harness).
// ---------------------------------------------------------------------------

interface Compound {
  tag: string | null;
  classes: string[];
  id: string | null;
  attrs: Array<{ name: string; value: string | null }>;
}
function parseCompound(sel: string): Compound {
  const stripped = sel.replace(/:[a-zA-Z-]+(\([^)]*\))?/g, "").trim();
  const tag = (stripped.match(/^[a-zA-Z][a-zA-Z0-9-]*/) || [])[0] || null;
  const classes = [...stripped.matchAll(/\.([a-zA-Z0-9_-]+)/g)].map((m) => m[1]);
  const idm = stripped.match(/#([a-zA-Z0-9_-]+)/);
  const id = idm ? idm[1] : null;
  const attrs = [...stripped.matchAll(/\[([a-zA-Z0-9_-]+)(?:="([^"]*)")?\]/g)].map((m) => ({ name: m[1], value: m[2] ?? null }));
  return { tag, classes, id, attrs };
}
function matchesCompound(el: FakeElement, c: Compound): boolean {
  if (c.tag && el.tagName.toLowerCase() !== c.tag.toLowerCase()) return false;
  if (c.id && el.getAttribute("id") !== c.id) return false;
  for (const cl of c.classes) if (!el.classList.contains(cl)) return false;
  for (const a of c.attrs) {
    if (!el.hasAttribute(a.name)) return false;
    if (a.value !== null && el.getAttribute(a.name) !== a.value) return false;
  }
  return true;
}
function matchesSteps(el: FakeElement, steps: Compound[]): boolean {
  if (!matchesCompound(el, steps[steps.length - 1])) return false;
  let anc = el.parent;
  for (let i = steps.length - 2; i >= 0; i--) {
    let found = false;
    while (anc) {
      if (matchesCompound(anc, steps[i])) {
        found = true;
        break;
      }
      anc = anc.parent;
    }
    if (!found) return false;
  }
  return true;
}

class FakeEventTarget {
  private listeners = new Map<string, Array<(e: any) => void>>();
  addEventListener(type: string, fn: (e: any) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type)!.push(fn);
  }
  dispatchEvent(evt: any): void {
    if (evt.target === undefined) evt.target = this;
    for (const fn of this.listeners.get(evt.type) ?? []) fn(evt);
  }
}

class FakeElement extends FakeEventTarget {
  tagName: string;
  parent: FakeElement | null = null;
  children: FakeElement[] = [];
  hidden = false;
  private attrs = new Map<string, string>();
  private classSet = new Set<string>();
  private _value = "";

  constructor(tag: string) {
    super();
    this.tagName = tag.toUpperCase();
  }
  get classList() {
    const self = this;
    return {
      add: (...c: string[]) => c.forEach((x) => self.classSet.add(x)),
      remove: (...c: string[]) => c.forEach((x) => self.classSet.delete(x)),
      contains: (c: string) => self.classSet.has(c),
      toggle: (c: string, force?: boolean) => {
        const has = self.classSet.has(c);
        const want = force === undefined ? !has : force;
        if (want) self.classSet.add(c);
        else self.classSet.delete(c);
        return want;
      },
    };
  }
  set className(v: string) {
    this.setAttribute("class", v);
  }
  get className(): string {
    return this.getAttribute("class") || "";
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, String(value));
    if (name === "class") this.classSet = new Set(String(value).split(/\s+/).filter(Boolean));
  }
  getAttribute(name: string): string | null {
    return this.attrs.has(name) ? this.attrs.get(name)! : null;
  }
  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }
  appendChild(c: FakeElement): FakeElement {
    c.parent = this;
    this.children.push(c);
    return c;
  }
  remove(): void {
    if (!this.parent) return;
    const i = this.parent.children.indexOf(this);
    if (i >= 0) this.parent.children.splice(i, 1);
    this.parent = null;
  }
  get previousElementSibling(): FakeElement | null {
    if (!this.parent) return null;
    const i = this.parent.children.indexOf(this);
    return i > 0 ? this.parent.children[i - 1] : null;
  }
  get value(): string {
    return this._value;
  }
  set value(v: string) {
    this._value = v;
  }
  get textContent(): string {
    return this.children.length ? this.children.map((c) => c.textContent).join("") : this.getAttribute("data-text") || "";
  }
  set textContent(v: string) {
    this.setAttribute("data-text", v);
    for (const c of this.children) c.parent = null;
    this.children = [];
  }
  closest(selector: string): FakeElement | null {
    const groups = selector.split(",").map((s) => s.trim().split(/\s+/).map(parseCompound));
    let el: FakeElement | null = this;
    while (el) {
      if (groups.some((steps) => matchesSteps(el!, steps))) return el;
      el = el.parent;
    }
    return null;
  }
  querySelectorAll(selector: string): FakeElement[] {
    const steps = selector.trim().split(/\s+/).map(parseCompound);
    const out: FakeElement[] = [];
    const walk = (node: FakeElement) => {
      for (const c of node.children) {
        if (matchesSteps(c, steps)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

class FakeDocument extends FakeEventTarget {
  documentElement = new FakeElement("html");
  body = new FakeElement("body");
  createElement(tag: string): FakeElement {
    return new FakeElement(tag);
  }
  getElementById(_id: string): FakeElement | null {
    return null; // no editor-overlay/confirm-modal fixtures in these tests
  }
  querySelectorAll(selector: string): FakeElement[] {
    return this.body.querySelectorAll(selector);
  }
  querySelector(selector: string): FakeElement | null {
    return this.body.querySelector(selector);
  }
}

const APP_JS_SOURCE = readFileSync(new URL("../assets/app.js", import.meta.url), "utf8");

function setup(build: (doc: FakeDocument) => void) {
  const doc = new FakeDocument();
  build(doc);
  const context: any = {
    document: doc,
    window: { matchMedia: undefined, EventSource: undefined },
    location: { reload: () => {} },
    fetch: () => new Promise(() => {}),
    setTimeout: () => 0,
    clearTimeout: () => {},
    console,
  };
  vm.createContext(context);
  vm.runInContext(APP_JS_SOURCE, context);
  (doc as any).dispatchEvent({ type: "DOMContentLoaded" });
  return { doc };
}

function click(doc: FakeDocument, target: FakeElement) {
  doc.dispatchEvent({ type: "click", target, preventDefault() {} });
}
function input(doc: FakeDocument, target: FakeElement) {
  doc.dispatchEvent({ type: "input", target });
}

describe("UI11 client-side: '+ N more' reveals the hidden overflow in place, no navigation", () => {
  test("clicking the button un-hides the overflow group and removes the button itself", () => {
    let overflow!: FakeElement, button!: FakeElement;
    const { doc } = setup((doc) => {
      const section = doc.createElement("section");
      doc.body.appendChild(section);
      overflow = doc.createElement("div");
      overflow.setAttribute("class", "railsec__overflow");
      overflow.hidden = true;
      section.appendChild(overflow);
      button = doc.createElement("button");
      button.setAttribute("class", "railsec__more");
      button.setAttribute("data-rail-expand", "");
      section.appendChild(button);
    });

    expect(overflow.hidden).toBe(true);
    click(doc, button);
    expect(overflow.hidden).toBe(false);
    expect(button.parent).toBeNull();
  });
});

describe("UI11 client-side: the registry filter hides cards whose name/body text doesn't match", () => {
  function buildRegistryPage(doc: FakeDocument) {
    const main = doc.createElement("main");
    main.setAttribute("class", "main");
    doc.body.appendChild(main);
    const filterInput = doc.createElement("input");
    filterInput.setAttribute("data-registry-filter", "");
    main.appendChild(filterInput);

    function card(id: string, titleText: string, bodyText: string): FakeElement {
      const article = doc.createElement("article");
      article.setAttribute("class", "entity card");
      article.setAttribute("id", id);
      const title = doc.createElement("span");
      title.setAttribute("class", "entity__title");
      title.textContent = titleText;
      article.appendChild(title);
      const rendered = doc.createElement("div");
      rendered.setAttribute("class", "rendered");
      rendered.textContent = bodyText;
      article.appendChild(rendered);
      main.appendChild(article);
      return article;
    }

    const kestrel = card("teams-kestrel", "kestrel", "produces design");
    const raven = card("teams-raven", "raven", "produces review");
    return { filterInput, kestrel, raven };
  }

  test("typing a query hides non-matching cards and shows matching ones; clearing restores all", () => {
    let refs!: ReturnType<typeof buildRegistryPage>;
    const { doc } = setup((doc) => {
      refs = buildRegistryPage(doc);
    });
    const { filterInput, kestrel, raven } = refs;

    filterInput.value = "kestrel";
    input(doc, filterInput);
    expect(kestrel.classList.contains("is-filtered-out")).toBe(false);
    expect(raven.classList.contains("is-filtered-out")).toBe(true);

    filterInput.value = "review";
    input(doc, filterInput);
    expect(kestrel.classList.contains("is-filtered-out")).toBe(true);
    expect(raven.classList.contains("is-filtered-out")).toBe(false);

    filterInput.value = "";
    input(doc, filterInput);
    expect(kestrel.classList.contains("is-filtered-out")).toBe(false);
    expect(raven.classList.contains("is-filtered-out")).toBe(false);
  });
});

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// NOTES UI10 — client-side navigation. Exercises the REAL assets/app.js verbatim (never
// reimplemented) against a hand-rolled fake DOM/history/location harness, the same no-DOM-dependency
// approach as tests/board-orchestrator-conversation.test.ts and tests/board-editor-overlay.test.ts —
// extended here with a small, real (not mocked) tag-soup HTML parser backing `innerHTML`, since a
// content swap's whole mechanism is "parse the fetched fragment's HTML into real DOM nodes." The
// parser only needs to handle this project's own server-rendered markup (well-formed, escaped via
// render.ts's `esc()`), not arbitrary web content.

// ---------------------------------------------------------------------------
// Minimal selector support — same subset as the sibling harnesses (tag, .class, #id, [attr]/
// [attr="value"], space-combinator descendant, comma-separated `closest()` lists).
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
function matchesAnySelector(el: FakeElement, selector: string): boolean {
  return selector.split(",").some((s) => matchesCompound(el, parseCompound(s.trim())));
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

// ---------------------------------------------------------------------------
// A small, real tag-soup HTML parser — only what this project's own rendered markup ever needs
// (well-formed tags, quoted attributes, void elements, `&amp;/&lt;/&gt;/&quot;/&#39;` entities).
// ---------------------------------------------------------------------------
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

function decodeEntities(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

function parseHtmlInto(doc: FakeDocument, host: FakeElement, html: string): void {
  const tokenRe = /<!--[\s\S]*?-->|<\/([a-zA-Z][a-zA-Z0-9-]*)\s*>|<([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>|([^<]+)/g;
  const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|[^\s"'=<>`]+))?/g;
  const stack: FakeElement[] = [host];
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(html))) {
    const closeName = m[1];
    const openName = m[2];
    const rawAttrs = m[3];
    const text = m[4];
    if (closeName) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName.toLowerCase() === closeName.toLowerCase()) {
          stack.length = i;
          break;
        }
      }
    } else if (openName) {
      const el = doc.createElement(openName);
      const selfClose = /\/\s*$/.test(rawAttrs || "");
      const attrBody = selfClose ? (rawAttrs || "").replace(/\/\s*$/, "") : rawAttrs || "";
      attrRe.lastIndex = 0;
      let am: RegExpExecArray | null;
      while ((am = attrRe.exec(attrBody))) {
        const name = am[1];
        const val = am[3] !== undefined ? am[3] : am[4] !== undefined ? am[4] : am[2] !== undefined ? am[2] : "";
        el.setAttribute(name, decodeEntities(val));
      }
      stack[stack.length - 1].appendChild(el);
      const tagLower = openName.toLowerCase();
      if (!(selfClose || VOID_TAGS.has(tagLower))) stack.push(el);
    } else if (text) {
      stack[stack.length - 1].appendChild(doc.createTextNode(decodeEntities(text)));
    }
  }
}

// ---------------------------------------------------------------------------
// Fake DOM
// ---------------------------------------------------------------------------
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
  disabled = false;
  hidden = false;
  style: Record<string, string> = {};
  ownerDoc: FakeDocument;
  private attrs = new Map<string, string>();
  private classSet = new Set<string>();
  private _value = "";
  private _text = "";

  constructor(tag: string, ownerDoc: FakeDocument) {
    super();
    this.tagName = tag.toUpperCase();
    this.ownerDoc = ownerDoc;
  }
  get classList() {
    const self = this;
    return {
      add: (...c: string[]) => c.forEach((x) => self.classSet.add(x)),
      remove: (...c: string[]) => c.forEach((x) => self.classSet.delete(x)),
      contains: (c: string) => self.classSet.has(c),
      toggle: (c: string) => (self.classSet.has(c) ? (self.classSet.delete(c), false) : (self.classSet.add(c), true)),
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
  get parentNode(): FakeElement | null {
    return this.parent;
  }
  replaceChild(next: FakeElement, prev: FakeElement): FakeElement {
    const i = this.children.indexOf(prev);
    if (i < 0) throw new Error("replaceChild: not a child");
    this.children[i] = next;
    next.parent = this;
    prev.parent = null;
    return prev;
  }
  get firstElementChild(): FakeElement | null {
    return this.children.length ? this.children[0] : null;
  }
  get lastElementChild(): FakeElement | null {
    return this.children.length ? this.children[this.children.length - 1] : null;
  }
  focus(): void {}
  get value(): string {
    return this._value;
  }
  set value(v: string) {
    this._value = v;
  }
  get textContent(): string {
    return this.children.length ? this.children.map((c) => c.textContent).join("") : this._text;
  }
  set textContent(v: string) {
    this._text = v;
    for (const c of this.children) c.parent = null;
    this.children = [];
  }
  set innerHTML(html: string) {
    for (const c of this.children) c.parent = null;
    this.children = [];
    this._text = "";
    parseHtmlInto(this.ownerDoc, this, html);
  }
  get innerHTML(): string {
    return "[not implemented — write-only in this harness]";
  }
  scrollIntoView(): void {}
  closest(selector: string): FakeElement | null {
    let el: FakeElement | null = this;
    while (el) {
      if (matchesAnySelector(el, selector)) return el;
      el = el.parent;
    }
    return null;
  }
  querySelectorAll(selector: string): FakeElement[] {
    const groups = selector.split(",").map((s) => s.trim().split(/\s+/).map(parseCompound));
    const out: FakeElement[] = [];
    const walk = (node: FakeElement) => {
      for (const c of node.children) {
        if (groups.some((steps) => matchesSteps(c, steps))) out.push(c);
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
  documentElement: FakeElement;
  body: FakeElement;
  title = "";
  constructor() {
    super();
    this.documentElement = new FakeElement("html", this);
    this.body = new FakeElement("body", this);
  }
  createElement(tag: string): FakeElement {
    return new FakeElement(tag, this);
  }
  createTextNode(text: string): FakeElement {
    const t = new FakeElement("#text", this);
    t.textContent = text;
    return t;
  }
  getElementById(id: string): FakeElement | null {
    let found: FakeElement | null = null;
    const walk = (node: FakeElement) => {
      if (found) return;
      for (const c of node.children) {
        if (c.getAttribute("id") === id) {
          found = c;
          return;
        }
        walk(c);
        if (found) return;
      }
    };
    walk(this.body);
    return found;
  }
  querySelectorAll(selector: string): FakeElement[] {
    return this.body.querySelectorAll(selector);
  }
  querySelector(selector: string): FakeElement | null {
    return this.body.querySelector(selector);
  }
}

// A tiny fake `history` — records pushState calls and tracks a simple back/forward stack so a test
// can simulate the browser's OWN behavior (it updates `location` BEFORE firing `popstate`).
class FakeHistory {
  entries: string[];
  index: number;
  pushCalls: Array<{ state: any; url: string }> = [];
  constructor(initialUrl: string) {
    this.entries = [initialUrl];
    this.index = 0;
  }
  pushState(state: any, _title: string, url: string): void {
    this.pushCalls.push({ state, url });
    this.entries = this.entries.slice(0, this.index + 1);
    this.entries.push(url);
    this.index = this.entries.length - 1;
  }
  replaceState(_state: any, _title: string, url: string): void {
    this.entries[this.index] = url;
  }
}

function urlParts(url: string): { pathname: string; search: string } {
  const qi = url.indexOf("?");
  return qi === -1 ? { pathname: url, search: "" } : { pathname: url.slice(0, qi), search: url.slice(qi) };
}

const APP_JS_SOURCE = readFileSync(new URL("../assets/app.js", import.meta.url), "utf8");

interface FetchCall {
  url: string;
  init: any;
  resolveOk: (data: any) => void;
  resolveHtml: () => void;
  resolveFail: () => void;
}

function setup(build?: (doc: FakeDocument) => void) {
  const doc = new FakeDocument();
  if (build) build(doc);

  const fetchCalls: FetchCall[] = [];
  const fetchImpl = (url: string, init?: any) =>
    new Promise((resolve, reject) => {
      fetchCalls.push({
        url,
        init,
        resolveOk: (data: any) =>
          resolve({
            ok: true,
            headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? "application/json" : null) },
            json: () => Promise.resolve(data),
          }),
        // Simulates the server falling through to a real, non-JSON HTML response (e.g. onboarding) —
        // `res.ok` is true, but the content-type check in `fetchFragment` must still reject it.
        resolveHtml: () =>
          resolve({
            ok: true,
            headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null) },
            json: () => Promise.reject(new Error("not json")),
          }),
        resolveFail: () => reject(new Error("network error")),
      });
    });

  const history = new FakeHistory("/studio");
  const hrefAssignments: string[] = [];
  const location: any = {
    pathname: "/studio",
    search: "",
    origin: "http://localhost",
  };
  Object.defineProperty(location, "href", {
    get() {
      return "http://localhost" + location.pathname + location.search;
    },
    set(v: string) {
      hrefAssignments.push(v);
    },
  });

  let esConstructCount = 0;
  const esInstances: any[] = [];
  class FakeEventSource {
    onmessage: ((e: any) => void) | null = null;
    constructor(_url: string) {
      esConstructCount++;
      esInstances.push(this);
    }
  }

  const windowListeners = new Map<string, Array<(e: any) => void>>();
  const fakeWindow = {
    matchMedia: undefined as any,
    EventSource: FakeEventSource,
    scrollTo: (_x: number, _y: number) => {},
    addEventListener: (type: string, fn: (e: any) => void) => {
      if (!windowListeners.has(type)) windowListeners.set(type, []);
      windowListeners.get(type)!.push(fn);
    },
    dispatchEvent: (evt: any) => {
      for (const fn of windowListeners.get(evt.type) ?? []) fn(evt);
    },
  };

  const context: any = {
    document: doc,
    window: fakeWindow,
    location,
    history,
    fetch: fetchImpl,
    // A real browser's `EventSource`/`scrollTo` are bare globals AND `window.*` properties (the same
    // object, reachable either way) — app.js's SSE block calls the bare identifier (`new
    // EventSource(...)`), so the fake needs to be exposed both ways, not just on `window`.
    EventSource: FakeEventSource,
    setTimeout: (fn: () => void) => {
      fn();
      return 0;
    },
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    console,
  };
  vm.createContext(context);
  vm.runInContext(APP_JS_SOURCE, context);
  (doc as any).dispatchEvent({ type: "DOMContentLoaded" });

  function firePopstate(newUrl: string) {
    const parts = urlParts(newUrl);
    location.pathname = parts.pathname;
    location.search = parts.search;
    fakeWindow.dispatchEvent({ type: "popstate" });
  }

  return { doc, fetchCalls, history, location, hrefAssignments, firePopstate, esConstructCount: () => esConstructCount, esInstances };
}

function click(doc: FakeDocument, target: FakeElement, opts: Partial<{ button: number; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) {
  let prevented = false;
  const evt: any = {
    type: "click",
    target,
    button: opts.button ?? 0,
    ctrlKey: !!opts.ctrlKey,
    metaKey: !!opts.metaKey,
    shiftKey: !!opts.shiftKey,
    altKey: !!opts.altKey,
    get defaultPrevented() {
      return prevented;
    },
    preventDefault() {
      prevented = true;
    },
  };
  doc.dispatchEvent(evt);
  return evt;
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// Fixture: a minimal but structurally real board page — app header (not needed here), rail, main
// (with an in-app link and an external link), the Orchestrator aside (with a conversation turn
// already in it, to prove it survives), and the extras host.
// ---------------------------------------------------------------------------
function buildPage(doc: FakeDocument, opts: { path?: string } = {}) {
  // Finding 131: the version chip lives in the app header, a sibling of `.app` (never inside it, per
  // render/shell.ts#shell) — appended directly to `doc.body`, same as `.app` itself below.
  const appVersion = doc.createElement("span");
  appVersion.setAttribute("class", "apphead__ver mono");
  appVersion.setAttribute("data-app-version", "");
  appVersion.textContent = "v0.0.1-stale";
  doc.body.appendChild(appVersion);

  const app = doc.createElement("div");
  app.setAttribute("class", "app");
  doc.body.appendChild(app);

  const rail = doc.createElement("aside");
  rail.setAttribute("class", "rail");
  app.appendChild(rail);
  const railLink = doc.createElement("a");
  railLink.setAttribute("href", "/registry/agents");
  rail.appendChild(railLink);

  const main = doc.createElement("main");
  main.setAttribute("class", "main");
  app.appendChild(main);
  const heading = doc.createElement("h1");
  heading.textContent = "Original page";
  main.appendChild(heading);
  const inAppLink = doc.createElement("a");
  inAppLink.setAttribute("href", opts.path || "/project/storefront");
  inAppLink.textContent = "go";
  main.appendChild(inAppLink);
  const externalLink = doc.createElement("a");
  externalLink.setAttribute("href", "https://example.com/elsewhere");
  externalLink.textContent = "away";
  main.appendChild(externalLink);
  const downloadLink = doc.createElement("a");
  downloadLink.setAttribute("href", "/artifact/storefront/checkout-flow/spec-v1.md");
  downloadLink.setAttribute("download", "");
  downloadLink.textContent = "dl";
  main.appendChild(downloadLink);

  const orch = doc.createElement("aside");
  orch.setAttribute("class", "orch");
  // NOTES V11-CONV: the real orchestratorPanel() always stamps `data-scope` — the page this fixture
  // stands in for is studio-scoped, matching `setup()`'s own initial `location.pathname = "/studio"`.
  orch.setAttribute("data-scope", "studio");
  app.appendChild(orch);
  const orchBody = doc.createElement("div");
  orchBody.setAttribute("class", "orch__body");
  orch.appendChild(orchBody);
  const existingTurn = doc.createElement("div");
  existingTurn.setAttribute("class", "turn turn--orch");
  existingTurn.setAttribute("id", "persisted-turn");
  const turnText = doc.createElement("p");
  turnText.textContent = "briefing · now";
  existingTurn.appendChild(turnText);
  orchBody.appendChild(existingTurn);
  const orchTail = doc.createElement("div");
  orchTail.setAttribute("class", "orch__tail");
  orchTail.setAttribute("data-orch-tail", "");
  orchTail.innerHTML = '<div class="turn turn--orch" id="persisted-tail-turn"><p>studio history</p></div>';
  orchBody.appendChild(orchTail);

  // NOTES ORCH-STALE-CARD: the run view's own gate/dispatch card — the region that used to have no
  // marker at all, so no refresh path ever touched it. Seeded here with markup standing in for "what a
  // cold GET rendered at some earlier moment" (a start-gate card mid-dispatch), so a test can assert it
  // actually gets replaced by a later refresh's `orchAction`, exactly like a real runner-side change
  // (a dispatch completing, a gate opening) would replace it on a real page.
  const orchAction = doc.createElement("div");
  orchAction.setAttribute("class", "orch__action");
  orchAction.setAttribute("data-orch-action", "");
  orchAction.innerHTML = '<article class="gate gate--start is-dispatching" id="stale-gate-card"><p class="gate__ctx">Dispatching now — the unit is being produced.</p></article>';
  orchBody.appendChild(orchAction);

  // NOTES ORCH-STALE-CARD addendum: the narrated briefing turn — found stale one element up from the
  // action region above, AFTER that fix landed: it names the same gate count the action region's card
  // is drawn from, but had no marker of its own, so it kept reading a stale count once the region below
  // it had already resynced. Seeded here with a stale "2 gates" sentence, same shape as the live report.
  const orchBriefing = doc.createElement("div");
  orchBriefing.setAttribute("class", "orch__briefing");
  orchBriefing.setAttribute("data-orch-briefing", "");
  orchBriefing.innerHTML = '<div class="turn turn--orch" id="stale-briefing-turn"><p class="turn__body">2 gates are on you. Ask me about any project or open a gate to review it.</p></div>';
  orchBody.appendChild(orchBriefing);

  const extrasHost = doc.createElement("div");
  extrasHost.setAttribute("data-extras-host", "");
  const oldExtra = doc.createElement("template");
  oldExtra.setAttribute("id", "tpl-old");
  extrasHost.appendChild(oldExtra);
  doc.body.appendChild(extrasHost);

  return { app, rail, railLink, main, inAppLink, externalLink, downloadLink, orch, orchBody, existingTurn, orchTail, orchAction, orchBriefing, extrasHost, appVersion };
}

const NEW_FRAGMENT = {
  ok: true,
  title: "levare &middot; storefront &amp; co",
  main: '<main class="main"><h1 id="new-heading">Swapped page</h1><a href="/idea/example">idea</a></main>',
  extras: '<template id="tpl-new">hi</template>',
  highlightId: null,
};

describe("client-side navigation — in-app link clicks swap .main, push history, never do a document navigation", () => {
  test("clicking an in-app link fetches the fragment with the fragment header and swaps .main in place", async () => {
    let refs!: ReturnType<typeof buildPage>;
    const h = setup((doc) => {
      refs = buildPage(doc);
    });

    click(h.doc, refs.inAppLink);
    expect(h.fetchCalls.length).toBe(1);
    expect(h.fetchCalls[0].url).toBe("/project/storefront");
    expect(h.fetchCalls[0].init.headers["X-Levare-Fragment"]).toBe("1");

    h.fetchCalls[0].resolveOk(NEW_FRAGMENT);
    await flush();

    const newMain = h.doc.querySelector(".main")!;
    expect(newMain.querySelector("#new-heading")).not.toBeNull();
    expect(newMain.querySelector("#new-heading")!.textContent).toBe("Swapped page");
    // "&middot;" is literal server-authored text (titles use a real "·" char, never that entity) and
    // is left alone; "&amp;" IS a real `esc()`-produced entity (e.g. an `&` in a project name) and
    // must be decoded — a raw `document.title = "...&amp;..."` assignment would otherwise show the
    // literal entity text in the tab, unlike an initial `<title>` parse, which decodes it for free.
    expect(h.doc.title).toBe("levare &middot; storefront & co");
    expect(h.doc.querySelector("[data-extras-host]")!.querySelector("#tpl-new")).not.toBeNull();
    expect(h.doc.querySelector("[data-extras-host]")!.querySelector("#tpl-old")).toBeNull();

    // No document-level navigation ever happened — the fallback path (location.href assignment) was
    // never used, since the fetch succeeded.
    expect(h.hrefAssignments.length).toBe(0);
  });

  test("a successful swap pushes history with the clicked URL", async () => {
    let refs!: ReturnType<typeof buildPage>;
    const h = setup((doc) => {
      refs = buildPage(doc);
    });
    click(h.doc, refs.inAppLink);
    h.fetchCalls[0].resolveOk(NEW_FRAGMENT);
    await flush();

    expect(h.history.pushCalls.length).toBe(1);
    expect(h.history.pushCalls[0].url).toBe("/project/storefront");
  });

  test("popstate re-fetches and swaps for the restored URL — back/forward behave like real navigation, and never push a new history entry", async () => {
    let refs!: ReturnType<typeof buildPage>;
    const h = setup((doc) => {
      refs = buildPage(doc);
    });
    click(h.doc, refs.inAppLink);
    h.fetchCalls[0].resolveOk(NEW_FRAGMENT);
    await flush();
    expect(h.doc.querySelector(".main")!.querySelector("#new-heading")).not.toBeNull();

    // The browser itself moves `location` back to the prior URL before firing popstate.
    h.firePopstate("/studio");
    expect(h.fetchCalls.length).toBe(2);
    expect(h.fetchCalls[1].url).toBe("/studio");
    expect(h.fetchCalls[1].init.headers["X-Levare-Fragment"]).toBe("1");

    h.fetchCalls[1].resolveOk({
      ok: true,
      title: "levare · Studio",
      main: '<main class="main"><h1 id="restored">Back to studio</h1></main>',
      extras: "",
      highlightId: null,
    });
    await flush();
    expect(h.doc.querySelector(".main")!.querySelector("#restored")).not.toBeNull();
    // popstate never pushes a NEW history entry — the browser already moved the pointer itself.
    expect(h.history.pushCalls.length).toBe(1);
  });

  test("the Orchestrator panel's conversation DOM survives an in-app navigation untouched", async () => {
    let refs!: ReturnType<typeof buildPage>;
    const h = setup((doc) => {
      refs = buildPage(doc);
    });
    const turnBefore = h.doc.getElementById("persisted-turn");
    expect(turnBefore).not.toBeNull();

    click(h.doc, refs.inAppLink);
    h.fetchCalls[0].resolveOk(NEW_FRAGMENT);
    await flush();

    const turnAfter = h.doc.getElementById("persisted-turn");
    expect(turnAfter).not.toBeNull();
    expect(turnAfter).toBe(turnBefore); // the SAME node — never rebuilt, never detached
    expect(turnAfter!.querySelector("p")!.textContent).toBe("briefing · now");
    // The rail is likewise untouched (still the same node, still holding its original link).
    expect(h.doc.querySelector(".rail a")!.getAttribute("href")).toBe("/registry/agents");
  });

  test("the SSE connection is created exactly once, regardless of how many in-app navigations happen", async () => {
    let refs!: ReturnType<typeof buildPage>;
    const h = setup((doc) => {
      refs = buildPage(doc);
    });
    expect(h.esConstructCount()).toBe(1);

    click(h.doc, refs.inAppLink);
    h.fetchCalls[0].resolveOk(NEW_FRAGMENT);
    await flush();
    h.firePopstate("/studio");
    h.fetchCalls[1].resolveOk({ ok: true, title: "t", main: '<main class="main">x</main>', extras: "", highlightId: null });
    await flush();

    expect(h.esConstructCount()).toBe(1); // still exactly one EventSource for the page's whole lifetime
  });

  test("the SSE reload trigger refreshes the current URL's content in place — never location.reload, never a second EventSource", async () => {
    let refs!: ReturnType<typeof buildPage>;
    const h = setup((doc) => {
      refs = buildPage(doc);
    });
    const es = h.esInstances[0];
    expect(typeof es.onmessage).toBe("function");

    es.onmessage({ data: "reload" });
    expect(h.fetchCalls.length).toBe(1);
    expect(h.fetchCalls[0].url).toBe("/studio"); // the CURRENT url, not the clicked link
    h.fetchCalls[0].resolveOk({ ok: true, title: "t", main: '<main class="main"><p id="refreshed"></p></main>', extras: "", highlightId: null });
    await flush();
    expect(h.doc.querySelector("#refreshed")).not.toBeNull();
    expect(h.history.pushCalls.length).toBe(0); // a content refresh is not a navigation
    expect(h.esConstructCount()).toBe(1);
  });

  test("a modified click (ctrl/meta/shift/alt, or a non-left button) is never intercepted", () => {
    let refs!: ReturnType<typeof buildPage>;
    const h = setup((doc) => {
      refs = buildPage(doc);
    });
    for (const mod of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      const evt = click(h.doc, refs.inAppLink, mod);
      expect(evt.defaultPrevented).toBe(false);
    }
    expect(h.fetchCalls.length).toBe(0);
  });

  test("an external (cross-origin) link is never intercepted", () => {
    let refs!: ReturnType<typeof buildPage>;
    const h = setup((doc) => {
      refs = buildPage(doc);
    });
    const evt = click(h.doc, refs.externalLink);
    expect(evt.defaultPrevented).toBe(false);
    expect(h.fetchCalls.length).toBe(0);
  });

  test("a download link is never intercepted", () => {
    let refs!: ReturnType<typeof buildPage>;
    const h = setup((doc) => {
      refs = buildPage(doc);
    });
    const evt = click(h.doc, refs.downloadLink);
    expect(evt.defaultPrevented).toBe(false);
    expect(h.fetchCalls.length).toBe(0);
  });

  test("FAILURE HONESTY: a failed fragment fetch falls back to a real navigation instead of a broken half-swap", async () => {
    let refs!: ReturnType<typeof buildPage>;
    const h = setup((doc) => {
      refs = buildPage(doc);
    });
    click(h.doc, refs.inAppLink);
    expect(h.fetchCalls.length).toBe(1);
    h.fetchCalls[0].resolveFail();
    await flush();

    expect(h.hrefAssignments).toEqual(["/project/storefront"]);
    // The DOM is left exactly as it was — no half-swap.
    expect(h.doc.querySelector(".main")!.querySelector("h1")!.textContent).toBe("Original page");
  });

  test("FAILURE HONESTY: a non-JSON fragment response (e.g. the onboarding screen) also falls back to a real navigation", async () => {
    let refs!: ReturnType<typeof buildPage>;
    const h = setup((doc) => {
      refs = buildPage(doc);
    });
    click(h.doc, refs.inAppLink);
    h.fetchCalls[0].resolveHtml();
    await flush();
    expect(h.hrefAssignments).toEqual(["/project/storefront"]);
  });
});

// ---------------------------------------------------------------------------
// NOTES V11-CONV-SYNC (Findings 57/131) — client-nav resyncs the persisted-tail region on EVERY
// refresh that carries one, not just a scope change (the old gate: Finding 57's rail card served a
// four-day-old exchange on the studio dashboard, whose scope never changes, so a scope-only gate never
// resynced it at all). Duplication is now avoided by IDENTITY (`data-at`, the same ISO stamp
// `conversation.ts#appendExchange` writes to disk and `assets/app.js#restampTurn` copies onto a live
// turn once persistence confirms it) rather than by skipping the whole region.
// ---------------------------------------------------------------------------
describe("client-side navigation — the persisted-tail region resyncs on every refresh, reconciled by turn identity", () => {
  test("navigating from studio (scope=studio) to a fragment reporting scope=storefront replaces [data-orch-tail] and updates data-scope", async () => {
    let refs!: ReturnType<typeof buildPage>;
    const h = setup((doc) => {
      refs = buildPage(doc);
    });
    expect(refs.orch.getAttribute("data-scope")).toBe("studio");
    expect(refs.orchTail.querySelector("#persisted-tail-turn")).not.toBeNull();

    click(h.doc, refs.inAppLink);
    h.fetchCalls[0].resolveOk({
      ...NEW_FRAGMENT,
      scope: "storefront",
      orchTail: '<div class="turn turn--orch" id="storefront-tail-turn"><p>storefront history</p></div>',
    });
    await flush();

    expect(refs.orch.getAttribute("data-scope")).toBe("storefront");
    const tail = h.doc.querySelector("[data-orch-tail]")!;
    expect(tail.querySelector("#storefront-tail-turn")).not.toBeNull();
    expect(tail.querySelector("#persisted-tail-turn")).toBeNull(); // the old scope's tail is gone
    // Nothing else about the panel was touched — the pre-existing live turn survives untouched (it
    // carries no `.turn__time[data-at]` at all, so it can never be mistaken for one the fresh tail covers).
    expect(h.doc.getElementById("persisted-turn")).not.toBeNull();
  });

  // The bug this test guards against directly: Finding 57's studio dashboard never changes scope, so a
  // scope-only gate left this region frozen forever. A same-scope refresh must now apply fresh content.
  test("navigating to a fragment reporting the SAME scope still applies the fresh [data-orch-tail] content (Finding 57)", async () => {
    let refs!: ReturnType<typeof buildPage>;
    const h = setup((doc) => {
      refs = buildPage(doc);
    });

    click(h.doc, refs.inAppLink);
    h.fetchCalls[0].resolveOk({
      ...NEW_FRAGMENT,
      scope: "studio", // unchanged from buildPage's initial data-scope="studio"
      orchTail: '<div class="turn turn--orch" id="fresh-tail-turn"><p>fresher studio history</p></div>',
    });
    await flush();

    expect(refs.orch.getAttribute("data-scope")).toBe("studio");
    const tailAfter = h.doc.querySelector("[data-orch-tail]")!;
    expect(tailAfter.querySelector("#fresh-tail-turn")).not.toBeNull(); // the newer tail WAS applied
    expect(tailAfter.querySelector("#persisted-tail-turn")).toBeNull(); // the stale content is gone
  });

  // The duplication risk the old scope-gate existed to avoid, proven closed by identity instead: a
  // live-appended turn whose `data-at` has since been confirmed (via `restampTurn`, once
  // `/orchestrator/message` returned the persisted `at`) matches an entry in the freshly-fetched tail —
  // it must be removed from its live position so the exchange shows exactly once (inside the tail),
  // never twice.
  test("a live turn whose data-at is now covered by the fresh tail is removed, never shown twice", async () => {
    let refs!: ReturnType<typeof buildPage>;
    const h = setup((doc) => {
      refs = buildPage(doc);
    });
    const liveTurn = h.doc.createElement("div");
    liveTurn.setAttribute("class", "turn turn--user");
    liveTurn.setAttribute("id", "live-confirmed-turn");
    liveTurn.innerHTML = '<div class="turn__row"><span class="turn__time" data-at="2026-08-25T10:00:00.000Z">now</span></div><p>hi</p>';
    refs.orchBody.appendChild(liveTurn);

    click(h.doc, refs.inAppLink);
    h.fetchCalls[0].resolveOk({
      ...NEW_FRAGMENT,
      scope: "studio",
      orchTail:
        '<div class="turn turn--user" id="tail-copy-of-live-turn"><div class="turn__row"><span class="turn__time" data-at="2026-08-25T10:00:00.000Z">now</span></div><p>hi</p></div>',
    });
    await flush();

    expect(h.doc.getElementById("live-confirmed-turn")).toBeNull(); // removed — now redundant with the tail
    expect(h.doc.querySelector("[data-orch-tail]")!.querySelector("#tail-copy-of-live-turn")).not.toBeNull();
  });

  // The complementary case: a live turn whose `data-at` is NOT (yet) in the fetched tail — an in-flight
  // exchange the server hasn't persisted yet, or simply a different exchange entirely — must survive.
  test("a live turn whose data-at is NOT in the fresh tail survives the resync untouched", async () => {
    let refs!: ReturnType<typeof buildPage>;
    const h = setup((doc) => {
      refs = buildPage(doc);
    });
    const liveTurn = h.doc.createElement("div");
    liveTurn.setAttribute("class", "turn turn--user");
    liveTurn.setAttribute("id", "live-unconfirmed-turn");
    liveTurn.innerHTML = '<div class="turn__row"><span class="turn__time" data-at="2026-08-25T10:05:00.000Z">now</span></div><p>not persisted yet</p>';
    refs.orchBody.appendChild(liveTurn);

    click(h.doc, refs.inAppLink);
    h.fetchCalls[0].resolveOk({
      ...NEW_FRAGMENT,
      scope: "studio",
      orchTail: '<div class="turn turn--orch" id="unrelated-tail-turn"><div class="turn__row"><span class="turn__time" data-at="2026-08-25T09:00:00.000Z">now</span></div><p>older</p></div>',
    });
    await flush();

    expect(h.doc.getElementById("live-unconfirmed-turn")).not.toBeNull(); // still there, not a duplicate of anything in the tail
  });

  test("a fragment response with no orchTail field at all (e.g. an older server) is a safe no-op, never a crash", async () => {
    let refs!: ReturnType<typeof buildPage>;
    const h = setup((doc) => {
      refs = buildPage(doc);
    });
    click(h.doc, refs.inAppLink);
    h.fetchCalls[0].resolveOk(NEW_FRAGMENT); // no `scope`/`orchTail` fields
    await flush();

    expect(refs.orch.getAttribute("data-scope")).toBe("studio");
    expect(h.doc.querySelector("[data-orch-tail]")!.querySelector("#persisted-tail-turn")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// NOTES ORCH-STALE-CARD — the bug this suite proves fixed: a runner-side change (a dispatch
// completing, an artifact landing, a gate opening) never reached the run view's own gate card, while
// the score rail and timeline (both inside `.main`) updated correctly on the exact same refresh. The
// root cause was that `[data-orch-action]` carried no marker at all — `extractFragment` had nothing to
// slice out, so no refresh path, cold-GET-shaped or not, had any way to resync it. These tests drive
// the REAL update path (the SSE `reload` trigger and an in-app navigation, both through the genuine
// `assets/app.js` loaded via `APP_JS_SOURCE`) rather than re-rendering the card component directly —
// the whole failure was that the card renders correctly when asked and was never being asked.
// ---------------------------------------------------------------------------
describe("client-side navigation — the orchestrator action region (the gate/dispatch card) resyncs on every refresh, unlike the scope-gated tail", () => {
  test("the SSE reload trigger — a same-URL refresh, no click, no manual reload — replaces [data-orch-action] with the fragment's orchAction", async () => {
    let refs!: ReturnType<typeof buildPage>;
    const h = setup((doc) => {
      refs = buildPage(doc);
    });
    expect(refs.orchAction.querySelector("#stale-gate-card")).not.toBeNull();

    // Simulates a runner-side change landing (a dispatch finished and the unit is now blocked) via the
    // exact channel that carries every OTHER repo change to this page: the fs.watch-driven SSE tick.
    const es = h.esInstances[0];
    es.onmessage({
      data: "reload",
    });
    expect(h.fetchCalls.length).toBe(1);
    expect(h.fetchCalls[0].url).toBe("/studio"); // the current URL — a content refresh, not a navigation
    h.fetchCalls[0].resolveOk({
      ok: true,
      title: "t",
      main: '<main class="main"><p id="refreshed"></p></main>',
      extras: "",
      highlightId: null,
      orchAction: '<article class="gate gate--artifact-blocked" id="fresh-gate-card"><p class="gate__ctx">Blocked: simulated member timeout</p></article>',
      orchBriefing: '<div class="turn turn--orch" id="fresh-briefing-turn"><p class="turn__body">Nothing needs you right now.</p></div>',
    });
    await flush();

    const actionHost = h.doc.querySelector("[data-orch-action]")!;
    expect(actionHost.querySelector("#fresh-gate-card")).not.toBeNull();
    expect(actionHost.querySelector("#stale-gate-card")).toBeNull(); // the frozen card is gone, not just supplemented
    expect(actionHost.textContent).toContain("Blocked: simulated member timeout");
    // The regression this test guards: the action region resyncing is not enough on its own — the
    // briefing sentence one element up must move on the SAME refresh, or a Conductor sees a `0`-shaped
    // action region sitting directly under a briefing still claiming gates are on them.
    const briefingHost = h.doc.querySelector("[data-orch-briefing]")!;
    expect(briefingHost.querySelector("#fresh-briefing-turn")).not.toBeNull();
    expect(briefingHost.querySelector("#stale-briefing-turn")).toBeNull();
    expect(briefingHost.textContent).toContain("Nothing needs you right now.");
    expect(briefingHost.textContent).not.toContain("2 gates are on you");
    // Score-rail/timeline equivalent for this fixture: the main swap landed too, on the SAME refresh —
    // proving all three regions now move together instead of only one of them updating.
    expect(h.doc.querySelector("#refreshed")).not.toBeNull();
  });

  test("an in-app navigation to a DIFFERENT page resyncs [data-orch-action] too, even though the scope (and so the persisted tail) is unchanged", async () => {
    let refs!: ReturnType<typeof buildPage>;
    const h = setup((doc) => {
      refs = buildPage(doc);
    });
    // The destination fragment reports the SAME scope as buildPage's initial "studio", and carries no
    // `orchTail` field at all (NEW_FRAGMENT), so syncOrchTail no-ops here; the action region must
    // resync regardless, since (unlike a persisted conversation) a gate card is page-specific, not
    // scope-specific.
    click(h.doc, refs.inAppLink);
    h.fetchCalls[0].resolveOk({
      ...NEW_FRAGMENT,
      scope: "studio",
      orchAction: "", // the destination page's unit has no open gate at all
    });
    await flush();

    expect(refs.orch.getAttribute("data-scope")).toBe("studio"); // confirms the tail path's no-orchTail no-op branch
    const actionHost = h.doc.querySelector("[data-orch-action]")!;
    expect(actionHost.querySelector("#stale-gate-card")).toBeNull(); // the old unit's card did not silently persist
    expect(actionHost.children.length).toBe(0); // replaced with the destination page's real (empty) action html
  });

  test("a fragment response with no orchAction field at all (e.g. an older server) is a safe no-op, never a crash", async () => {
    let refs!: ReturnType<typeof buildPage>;
    const h = setup((doc) => {
      refs = buildPage(doc);
    });
    click(h.doc, refs.inAppLink);
    h.fetchCalls[0].resolveOk(NEW_FRAGMENT); // no `orchAction` field
    await flush();

    expect(h.doc.querySelector("[data-orch-action]")!.querySelector("#stale-gate-card")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// NOTES ORCH-STALE-CARD addendum — found only after the action-region fix above shipped: approving a
// studio's last open gate correctly cleared the action region's card and the `Gates on you` stat, but
// the narrated briefing sentence directly above it ("2 gates are on you...") survived two in-app
// navigations unchanged, now visibly contradicting the `0` stat in the very same panel. The briefing is
// rendered by the same `orchestratorPanel` call as the action region, but sat outside every marker —
// this suite proves it now gets the identical unconditional-resync treatment, on the same refresh.
// ---------------------------------------------------------------------------
describe("client-side navigation — the orchestrator briefing sentence resyncs on every refresh too, in step with the action region", () => {
  test("the SSE reload trigger replaces [data-orch-briefing] with the fragment's orchBriefing, same as the action region", async () => {
    let refs!: ReturnType<typeof buildPage>;
    const h = setup((doc) => {
      refs = buildPage(doc);
    });
    expect(refs.orchBriefing.querySelector("#stale-briefing-turn")).not.toBeNull();

    const es = h.esInstances[0];
    es.onmessage({ data: "reload" });
    h.fetchCalls[0].resolveOk({
      ok: true,
      title: "t",
      main: '<main class="main"></main>',
      extras: "",
      highlightId: null,
      orchBriefing: '<div class="turn turn--orch" id="fresh-briefing-turn"><p class="turn__body">Nothing needs you right now.</p></div>',
    });
    await flush();

    const briefingHost = h.doc.querySelector("[data-orch-briefing]")!;
    expect(briefingHost.querySelector("#fresh-briefing-turn")).not.toBeNull();
    expect(briefingHost.querySelector("#stale-briefing-turn")).toBeNull();
  });

  test("an in-app navigation to a DIFFERENT page resyncs [data-orch-briefing] too, even though the scope (and so the persisted tail) is unchanged", async () => {
    let refs!: ReturnType<typeof buildPage>;
    const h = setup((doc) => {
      refs = buildPage(doc);
    });
    click(h.doc, refs.inAppLink);
    h.fetchCalls[0].resolveOk({
      ...NEW_FRAGMENT,
      scope: "studio",
      orchBriefing: '<div class="turn turn--orch" id="destination-briefing-turn"><p class="turn__body">1 gate is on you, oldest first: spec-v2.</p></div>',
    });
    await flush();

    expect(refs.orch.getAttribute("data-scope")).toBe("studio"); // confirms the tail path's no-orchTail no-op branch
    const briefingHost = h.doc.querySelector("[data-orch-briefing]")!;
    expect(briefingHost.querySelector("#stale-briefing-turn")).toBeNull(); // the old page's sentence did not persist
    expect(briefingHost.querySelector("#destination-briefing-turn")).not.toBeNull();
  });

  test("a fragment response with no orchBriefing field at all (e.g. an older server) is a safe no-op, never a crash", async () => {
    let refs!: ReturnType<typeof buildPage>;
    const h = setup((doc) => {
      refs = buildPage(doc);
    });
    click(h.doc, refs.inAppLink);
    h.fetchCalls[0].resolveOk(NEW_FRAGMENT); // no `orchBriefing` field
    await flush();

    expect(h.doc.querySelector("[data-orch-briefing]")!.querySelector("#stale-briefing-turn")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Finding 131 — the header's version chip sits entirely OUTSIDE `.main`/`[data-extras-host]`/`.orch`
// (never touched by `swapFragment`'s own replacements), so a long-open tab kept showing whatever build
// was running at the tab's last cold GET forever after, even once the daemon had since restarted on a
// newer commit. Resynced unconditionally on every refresh, same reasoning as `syncOrchAction` — the
// value is a `--define`-stamped constant, identical on every response this process ever serves, so it
// carries no "already shown live" case to guard against.
// ---------------------------------------------------------------------------
describe("client-side navigation — the header's version chip resyncs on every refresh (Finding 131)", () => {
  test("the SSE reload trigger replaces the version chip's content with the fragment's appVersion", async () => {
    let refs!: ReturnType<typeof buildPage>;
    const h = setup((doc) => {
      refs = buildPage(doc);
    });
    expect(refs.appVersion.textContent).toBe("v0.0.1-stale");

    const es = h.esInstances[0];
    es.onmessage({ data: "reload" });
    h.fetchCalls[0].resolveOk({
      ok: true,
      title: "t",
      main: '<main class="main"></main>',
      extras: "",
      highlightId: null,
      appVersion: "dev (build ebdb103)",
    });
    await flush();

    expect(h.doc.querySelector("[data-app-version]")!.textContent).toBe("dev (build ebdb103)");
  });

  test("an in-app navigation to a different page resyncs the version chip too", async () => {
    let refs!: ReturnType<typeof buildPage>;
    const h = setup((doc) => {
      refs = buildPage(doc);
    });
    click(h.doc, refs.inAppLink);
    h.fetchCalls[0].resolveOk({ ...NEW_FRAGMENT, appVersion: "v1.2.3" });
    await flush();

    expect(h.doc.querySelector("[data-app-version]")!.textContent).toBe("v1.2.3");
  });

  test("a fragment response with no appVersion field at all (e.g. an older server) is a safe no-op, never a crash", async () => {
    let refs!: ReturnType<typeof buildPage>;
    const h = setup((doc) => {
      refs = buildPage(doc);
    });
    click(h.doc, refs.inAppLink);
    h.fetchCalls[0].resolveOk(NEW_FRAGMENT); // no `appVersion` field
    await flush();

    expect(h.doc.querySelector("[data-app-version]")!.textContent).toBe("v0.0.1-stale");
  });
});

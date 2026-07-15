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

  const extrasHost = doc.createElement("div");
  extrasHost.setAttribute("data-extras-host", "");
  const oldExtra = doc.createElement("template");
  oldExtra.setAttribute("id", "tpl-old");
  extrasHost.appendChild(oldExtra);
  doc.body.appendChild(extrasHost);

  return { app, rail, railLink, main, inAppLink, externalLink, downloadLink, orch, orchBody, existingTurn, extrasHost };
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

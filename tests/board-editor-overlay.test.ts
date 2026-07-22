import { test, expect, describe, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// UI3: exercises the REAL assets/app.js overlay-editor code (loaded verbatim, never reimplemented)
// against a minimal, hand-rolled DOM/event/timer harness — there is no DOM/browser-automation
// dependency anywhere in this project (by design: "no front-end frameworks", everything hand-rolled),
// and this suite follows the same rule rather than reaching for one just for tests. The harness is
// deliberately small: only the DOM surface app.js's overlay block actually touches (element
// attributes/classList/value/textContent, simple selector matching, delegated + direct event
// listeners, controllable fake timers standing in for setTimeout so a 250ms debounce never costs real
// wall-clock time in the suite, and a scriptable fetch/confirm/location so the network and the
// "Discard unsaved changes?" prompt are fully deterministic).

// ---------------------------------------------------------------------------
// Minimal selector support — only what app.js's overlay block actually calls: single-class,
// [attr]/[attr="value"], tag, #id, comma-separated lists (closest("a, button")-style), each optionally
// combined with a descendant (space) combinator. Pseudo-classes (":not(...)") are stripped, not
// evaluated — harmless here because no fixture element this suite builds would ever need one to be
// correctly excluded (the file(s) that DO use :not, e.g. ".composer:not(.is-disabled) form", target
// elements this fixture never constructs, so returning "no pseudo-class filtering" for them still
// yields the correct empty result).
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
// Fake DOM — an EventTarget base (element-level AND document-level direct listeners; app.js's
// document-level "delegated" handlers are exercised by dispatching straight on `document` with
// `target` set to the notionally-clicked element, which is exactly how the real listener body reads
// `e.target.closest(...)` — no real event-bubbling simulation needed).
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

// Small, purpose-scoped HTML-fragment parser backing `FakeElement#innerHTML`'s setter — real tags,
// real attributes (including bare boolean ones like `hidden`), real nesting, plain text as `#text`
// children (so `.textContent` still reads correctly through `FakeElement`'s own children-first getter)
// — no entity decoding, no self-closing-tag inference beyond a literal trailing `/`. Scoped to exactly
// what this suite's own fixtures ever construct, same discipline as the rest of this hand-rolled harness.
function buildNodesFromHTML(html: string): FakeElement[] {
  const root = new FakeElement("div");
  const stack: FakeElement[] = [root];
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, "");
  const re = /<(\/?)([a-zA-Z][\w-]*)([^>]*)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(withoutComments))) {
    if (m[4] !== undefined) {
      if (m[4].trim()) {
        const t = new FakeElement("#text");
        t.textContent = m[4];
        stack[stack.length - 1].appendChild(t);
      }
      continue;
    }
    if (m[1] === "/") {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const el = new FakeElement(m[2]);
    const attrsStr = m[3] || "";
    const attrRe = /([a-zA-Z_:][-\w:.]*)(?:\s*=\s*"([^"]*)")?/g;
    let am: RegExpExecArray | null;
    while ((am = attrRe.exec(attrsStr))) {
      const name = am[1];
      const value = am[2] !== undefined ? am[2] : "";
      el.setAttribute(name, value);
      if (name === "hidden") el.hidden = true;
    }
    stack[stack.length - 1].appendChild(el);
    if (!/\/\s*$/.test(attrsStr)) stack.push(el);
  }
  return root.children;
}

class FakeElement extends FakeEventTarget {
  tagName: string;
  parent: FakeElement | null = null;
  children: FakeElement[] = [];
  disabled = false;
  hidden = false;
  style: Record<string, string> = {};
  private attrs = new Map<string, string>();
  private classSet = new Set<string>();
  private _value = "";
  private _text = "";

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
      toggle: (c: string) => (self.classSet.has(c) ? (self.classSet.delete(c), false) : (self.classSet.add(c), true)),
    };
  }
  // Phase 2 cluster 4 item 4b: app.js#renderErrors builds its structured "line · key"/message spans
  // with `.className =` (idiomatic, works in a real browser) and this suite now queries INTO them by
  // class (`row.querySelector(".editor-overlay__err-loc")`) — a real requirement this harness didn't
  // previously have (the old flat message-only row never needed to be queried by class). Alias
  // `.className` onto the same `setAttribute('class', ...)` path real elements share.
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
  // swapFragment (app.js) — exercised by the seal-time regression suite below — reads `.parentNode`
  // and `.firstElementChild` and calls `.replaceChild(...)`, none of which any prior test in this
  // file ever needed (the overlay/save/dismiss flows never touch `.main`).
  get parentNode(): FakeElement | null {
    return this.parent;
  }
  get firstElementChild(): FakeElement | null {
    return this.children.find((c) => c.tagName !== "#text") || null;
  }
  replaceChild(newChild: FakeElement, oldChild: FakeElement): FakeElement {
    const i = this.children.indexOf(oldChild);
    if (i === -1) throw new Error("replaceChild: oldChild is not a child of this element");
    oldChild.parent = null;
    newChild.parent = this;
    this.children[i] = newChild;
    return oldChild;
  }
  remove(): void {
    if (!this.parent) return;
    const i = this.parent.children.indexOf(this);
    if (i >= 0) this.parent.children.splice(i, 1);
    this.parent = null;
  }
  focus(): void {
    /* no-op — nothing in the tested logic depends on real focus behavior */
  }
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
  set innerHTML(v: string) {
    // Assigned '' (to clear before re-appending real child nodes), a small literal chip string
    // (`.validity`'s own — Phase 2 cluster 4 item 4b), OR — as of the swapFragment seal-time
    // regression test below — a real fragment payload (`data.main`/`data.extras`) that MUST become
    // real, queryable child elements (attributes included): `wrap.innerHTML = data.main; var newMain
    // = wrap.firstElementChild;` only works if this setter actually builds a tree. `buildNodesFromHTML`
    // is a small, purpose-scoped parser (tags/attributes/text, no self-closing-tag inference beyond a
    // trailing `/`, no entity decoding) — enough for every payload this suite's own fixtures construct.
    for (const c of this.children) c.parent = null;
    this.children = [];
    this._text = "";
    for (const n of buildNodesFromHTML(v)) this.appendChild(n);
  }
  closest(selector: string): FakeElement | null {
    let el: FakeElement | null = this;
    while (el) {
      if (matchesAnySelector(el, selector)) return el;
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

// ---------------------------------------------------------------------------
// Fixture: the slice of render.ts's real registry markup the overlay block touches — one entity card
// (mirroring `entityBlock`'s teams/kestrel output) inside `.app`, plus the shared overlay
// (`editorOverlay()`) as its sibling. Kept in sync with the real templates by
// board-render.test.ts's own string assertions on the actual renderRegistry() output; this fixture
// only needs to carry the same classes/attributes app.js's selectors key off of.
// ---------------------------------------------------------------------------
const RAW_SOURCE = "---\nname: kestrel\nmembers: [wren, lyra, finch]\n---\n\n# Kestrel\n";
// Phase 2 cluster 4 item 4a: the frontmatter/body split app.js#splitFrontmatter produces from
// RAW_SOURCE above — the two zoned textareas' own initial values.
const RAW_FRONT = "name: kestrel\nmembers: [wren, lyra, finch]";
const RAW_BODY = "# Kestrel\n";

function buildFixture(doc: FakeDocument): { editOpen: FakeElement; rawSource: FakeElement; overlay: FakeElement; confirmModal: FakeElement } {
  const app = doc.createElement("div");
  app.setAttribute("class", "app");
  doc.body.appendChild(app);

  const card = doc.createElement("article");
  card.setAttribute("class", "entity card");
  card.setAttribute("data-entity", "teams");
  card.setAttribute("data-path", "teams/kestrel.md");
  app.appendChild(card);

  const rawSource = doc.createElement("textarea");
  rawSource.setAttribute("class", "rawmd-source");
  rawSource.setAttribute("data-path", "teams/kestrel.md");
  rawSource.hidden = true;
  rawSource.value = RAW_SOURCE;
  card.appendChild(rawSource);

  const editbar = doc.createElement("div");
  editbar.setAttribute("class", "editbar");
  card.appendChild(editbar);

  const editOpen = doc.createElement("button");
  editOpen.setAttribute("class", "togglebtn");
  editOpen.setAttribute("data-edit-open", "");
  editOpen.setAttribute("data-path", "teams/kestrel.md");
  editOpen.setAttribute("data-editor-name", "kestrel");
  editOpen.setAttribute("data-editor-kind", "team");
  editbar.appendChild(editOpen);

  const overlay = doc.createElement("div");
  overlay.setAttribute("class", "editor-overlay");
  overlay.setAttribute("id", "editor-overlay");
  overlay.hidden = true;
  doc.body.appendChild(overlay); // sibling of `.app` — never nested inside it

  const backdrop = doc.createElement("div");
  backdrop.setAttribute("data-editor-backdrop", "");
  overlay.appendChild(backdrop);

  const panel = doc.createElement("div");
  panel.setAttribute("class", "editor-overlay__panel");
  overlay.appendChild(panel);

  const title = doc.createElement("h2");
  title.setAttribute("class", "editor-overlay__title");
  panel.appendChild(title);

  const kind = doc.createElement("span");
  kind.setAttribute("class", "editor-overlay__kind mono");
  panel.appendChild(kind);

  // Phase 2 cluster 4 item 4c: the "unsaved" marker, hidden by default.
  const dirty = doc.createElement("span");
  dirty.setAttribute("class", "editor-overlay__dirty");
  dirty.setAttribute("data-editor-dirty", "");
  dirty.hidden = true;
  panel.appendChild(dirty);

  // Phase 2 cluster 4 item 4a: one undifferentiated textarea became two labeled zones —
  // frontmatter (yaml) and body (markdown) — in one scroll area.
  const front = doc.createElement("textarea");
  front.setAttribute("class", "editor-overlay__textarea editor-overlay__textarea--front");
  panel.appendChild(front);

  const bodyTa = doc.createElement("textarea");
  bodyTa.setAttribute("class", "editor-overlay__textarea editor-overlay__textarea--body");
  panel.appendChild(bodyTa);

  const validity = doc.createElement("span");
  validity.setAttribute("class", "validity");
  panel.appendChild(validity);

  const errors = doc.createElement("div");
  errors.setAttribute("class", "editor-overlay__errors");
  panel.appendChild(errors);

  const cancel = doc.createElement("button");
  cancel.setAttribute("data-editor-cancel", "");
  panel.appendChild(cancel);

  const save = doc.createElement("button");
  save.setAttribute("data-editor-save", "");
  save.disabled = true;
  panel.appendChild(save);

  // UI4 item 1: render.ts#confirmModalHtml — the reusable confirm-modal primitive, a sibling of
  // `.app` (and of the editor overlay) present once per page, hidden by default.
  const confirmModal = doc.createElement("div");
  confirmModal.setAttribute("class", "confirm-modal");
  confirmModal.setAttribute("id", "confirm-modal");
  confirmModal.hidden = true;
  doc.body.appendChild(confirmModal);

  const confirmBackdrop = doc.createElement("div");
  confirmBackdrop.setAttribute("data-confirm-backdrop", "");
  confirmModal.appendChild(confirmBackdrop);

  const confirmPanel = doc.createElement("div");
  confirmPanel.setAttribute("class", "confirm-modal__panel");
  confirmModal.appendChild(confirmPanel);

  const confirmQuestion = doc.createElement("p");
  confirmQuestion.setAttribute("class", "confirm-modal__question");
  confirmPanel.appendChild(confirmQuestion);

  const confirmKeep = doc.createElement("button");
  confirmKeep.setAttribute("data-confirm-keep", "");
  confirmPanel.appendChild(confirmKeep);

  const confirmDiscard = doc.createElement("button");
  confirmDiscard.setAttribute("data-confirm-discard", "");
  confirmPanel.appendChild(confirmDiscard);

  return { editOpen, rawSource, overlay, confirmModal };
}

// ---------------------------------------------------------------------------
// vm harness: loads the real assets/app.js verbatim into a sandbox carrying the fake DOM plus
// controllable timers/fetch/confirm/location, then fires DOMContentLoaded exactly as a real browser
// would. `flushTimers()` runs every pending fake-setTimeout callback synchronously, standing in for
// the passage of the 250ms debounce window without any real wall-clock wait.
// ---------------------------------------------------------------------------
const APP_JS_SOURCE = readFileSync(new URL("../assets/app.js", import.meta.url), "utf8");

interface FetchCall {
  url: string;
  init: { method?: string; body?: string; headers?: Record<string, string> };
  resolve: (v: any) => void;
}

function setupOverlay() {
  const doc = new FakeDocument();
  const fixture = buildFixture(doc);

  let timerId = 1;
  const timers: Array<{ id: number; fn: () => void }> = [];
  const fakeSetTimeout = (fn: () => void, _ms: number): number => {
    const id = timerId++;
    timers.push({ id, fn });
    return id;
  };
  const fakeClearTimeout = (id: number): void => {
    const i = timers.findIndex((t) => t.id === id);
    if (i >= 0) timers.splice(i, 1);
  };
  const flushTimers = () => {
    const due = timers.splice(0, timers.length);
    for (const t of due) t.fn();
  };

  const fetchCalls: FetchCall[] = [];
  const fakeFetch = (url: string, init: any) =>
    new Promise((resolve) => {
      fetchCalls.push({ url, init, resolve: (body: any) => resolve({ ok: true, json: () => Promise.resolve(body) }) });
    });

  const reloadCalls: number[] = [];

  // UI4 item 1: no `confirm`/`alert` on the fake `window` at all — if app.js's dismiss path ever
  // regressed to calling the native dialog, `window.confirm is not a function` would throw straight
  // out of the click handler and fail whichever test exercises it, loudly. The in-app confirm modal
  // (the fixture's `#confirm-modal`) is the only dismiss-confirmation surface available.
  const context = {
    document: doc,
    window: { matchMedia: undefined, EventSource: undefined },
    location: {
      reload: () => reloadCalls.push(1),
      pathname: "/registry/teams",
      search: "",
      href: "http://localhost/registry/teams",
    },
    history: { pushState: () => {} },
    fetch: fakeFetch,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    console,
  };
  vm.createContext(context);
  vm.runInContext(APP_JS_SOURCE, context);
  (doc as any).dispatchEvent({ type: "DOMContentLoaded" });

  return {
    doc,
    ...fixture,
    fetchCalls,
    flushTimers,
    reloadCalls,
  };
}

function overlayParts(h: ReturnType<typeof setupOverlay>) {
  return {
    title: h.overlay.querySelector(".editor-overlay__title")!,
    kind: h.overlay.querySelector(".editor-overlay__kind")!,
    dirty: h.overlay.querySelector("[data-editor-dirty]")!,
    front: h.overlay.querySelector(".editor-overlay__textarea--front")!,
    body: h.overlay.querySelector(".editor-overlay__textarea--body")!,
    validity: h.overlay.querySelector(".validity")!,
    errors: h.overlay.querySelector(".editor-overlay__errors")!,
    saveBtn: h.overlay.querySelector("[data-editor-save]")!,
    cancelBtn: h.overlay.querySelector("[data-editor-cancel]")!,
    backdrop: h.overlay.querySelector("[data-editor-backdrop]")!,
  };
}

function confirmModalParts(h: ReturnType<typeof setupOverlay>) {
  return {
    modal: h.confirmModal,
    question: h.confirmModal.querySelector(".confirm-modal__question")!,
    keepBtn: h.confirmModal.querySelector("[data-confirm-keep]")!,
    discardBtn: h.confirmModal.querySelector("[data-confirm-discard]")!,
    backdrop: h.confirmModal.querySelector("[data-confirm-backdrop]")!,
  };
}

// A real macrotask tick (the outer Bun test process's own setTimeout, unrelated to the fake one
// installed inside the vm sandbox) — enough for app.js's fetch().then(r => r.json()...).then(...)
// chain to fully settle regardless of exactly how many microtask hops the thenable-flattening in the
// middle costs.
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function click(target: FakeElement) {
  target.dispatchEvent({ type: "click", target, preventDefault() {} });
}
function clickOn(doc: FakeDocument, target: FakeElement) {
  // Simulates a delegated document-level click handler receiving a bubbled event from `target`.
  doc.dispatchEvent({ type: "click", target, preventDefault() {} });
}

describe("registry overlay editor — real app.js exercised against a fake DOM", () => {
  let h: ReturnType<typeof setupOverlay>;
  let p: ReturnType<typeof overlayParts>;

  beforeEach(() => {
    h = setupOverlay();
    p = overlayParts(h);
  });

  test("opening the editor populates the overlay's two zones from the clicked card and kicks off a live check", () => {
    expect(h.overlay.hidden).toBe(true); // closed by default — the board is what's visible
    clickOn(h.doc, h.editOpen);
    expect(h.overlay.hidden).toBe(false);
    expect(p.title.textContent).toBe("kestrel");
    expect(p.kind.textContent).toBe("team");
    // Phase 2 cluster 4 item 4a: the frontmatter/body split populates the two labeled zones.
    expect(p.front.value).toBe(RAW_FRONT);
    expect(p.body.value).toBe(RAW_BODY);
    expect(p.dirty.hidden).toBe(true); // item 4c: no marker on a freshly opened, unedited buffer
    // A check fires immediately on open, against the unsaved-but-unmodified buffer — the SAME raw
    // string the check/save routes have always read, rejoined from the two zones.
    expect(h.fetchCalls.length).toBe(1);
    expect(h.fetchCalls[0].url).toBe("/registry/check/teams/kestrel.md");
    expect(JSON.parse(h.fetchCalls[0].init.body!).content).toBe(RAW_SOURCE);
  });

  // Item 4d: Save enables only when the buffer is BOTH dirty and valid — never valid alone. Opening a
  // clean, valid buffer must never itself enable Save.
  test("Save stays disabled on a clean-but-valid buffer; typing (dirty) then resolving valid enables it; reverting the edit disables it again", async () => {
    clickOn(h.doc, h.editOpen);
    h.fetchCalls[0].resolve({ ok: true, errors: [] });
    await flush();
    expect(p.saveBtn.disabled).toBe(true); // valid, but not dirty — still blocked
    expect(p.dirty.hidden).toBe(true);

    p.body.value = RAW_BODY + "\nmore text\n";
    p.body.dispatchEvent({ type: "input", target: p.body });
    expect(p.saveBtn.disabled).toBe(true); // blocked the instant the buffer changes, before any response
    expect(p.dirty.hidden).toBe(false); // item 4c: the marker appears the instant the buffer differs

    h.flushTimers(); // advances past the 250ms debounce window
    h.fetchCalls[h.fetchCalls.length - 1].resolve({ ok: true, errors: [] });
    await flush();
    expect(p.saveBtn.disabled).toBe(false); // now dirty AND valid

    // Reverting the edit back to the original value clears dirty — Save must block again even though
    // the buffer is (still) valid, since it no longer differs from what was loaded.
    p.body.value = RAW_BODY;
    p.body.dispatchEvent({ type: "input", target: p.body });
    expect(p.dirty.hidden).toBe(true);
    expect(p.saveBtn.disabled).toBe(true);
  });

  test("rapid keystrokes debounce into exactly one check call, joining the two zones back into one raw string", async () => {
    clickOn(h.doc, h.editOpen);
    h.fetchCalls[0].resolve({ ok: true, errors: [] });
    await flush();

    p.body.value = RAW_BODY + "\nmore: 1\n";
    p.body.dispatchEvent({ type: "input", target: p.body });
    p.body.value = RAW_BODY + "\nmore: 12\n";
    p.body.dispatchEvent({ type: "input", target: p.body }); // a second keystroke before the debounce fires
    expect(h.fetchCalls.length).toBe(1); // still just the initial open-time check — nothing scheduled has run yet

    h.flushTimers(); // advances past the 250ms debounce window
    expect(h.fetchCalls.length).toBe(2); // the two rapid keystrokes coalesced into ONE re-check, not two
    expect(h.fetchCalls[1].url).toBe("/registry/check/teams/kestrel.md");
    expect(JSON.parse(h.fetchCalls[1].init.body!).content).toBe(RAW_SOURCE.replace(RAW_BODY, RAW_BODY + "\nmore: 12\n"));
  });

  // Item 4b: each error now reads as "line · key" (structured) beside the validator's own human
  // message — the human message itself is unchanged (still no code/filename baked into IT).
  test("an invalid buffer lists each error as 'line · key' beside the validator's human message, and keeps Save blocked", async () => {
    clickOn(h.doc, h.editOpen);
    h.fetchCalls[0].resolve({
      ok: false,
      errors: [{ code: "UNKNOWN_KEY", message: "unknown key 'bogus_key' in team", file: "teams/kestrel.md", line: 3 }],
    });
    await flush();
    expect(p.saveBtn.disabled).toBe(true);
    expect(p.validity.textContent).toContain("invalid");
    expect(p.errors.children.length).toBe(1);
    const row = p.errors.children[0];
    const loc = row.querySelector(".editor-overlay__err-loc")!;
    const msg = row.querySelector(".editor-overlay__err-msg")!;
    expect(loc.textContent).toBe("L3 · bogus_key"); // structured: line + the field name lifted from the message
    expect(msg.textContent).toBe("unknown key 'bogus_key' in team"); // the human message, unchanged
  });

  test("Save POSTs to the write route (not the check route) and closes the overlay on success", async () => {
    clickOn(h.doc, h.editOpen);
    h.fetchCalls[0].resolve({ ok: true, errors: [] });
    await flush();
    // Item 4d: Save needs a dirty buffer too — an edit that round-trips back to valid.
    p.body.value = RAW_BODY + "\nmore: 1\n";
    p.body.dispatchEvent({ type: "input", target: p.body });
    h.flushTimers();
    h.fetchCalls[h.fetchCalls.length - 1].resolve({ ok: true, errors: [] });
    await flush();
    expect(p.saveBtn.disabled).toBe(false);

    const expectedContent = RAW_SOURCE.replace(RAW_BODY, RAW_BODY + "\nmore: 1\n");
    click(p.saveBtn);
    expect(p.saveBtn.disabled).toBe(true);
    expect(h.fetchCalls.length).toBe(3);
    expect(h.fetchCalls[2].url).toBe("/registry/teams/kestrel.md"); // the save route, distinct from /registry/check/...
    expect(JSON.parse(h.fetchCalls[2].init.body!).content).toBe(expectedContent);

    h.fetchCalls[2].resolve({ ok: true, commit: "deadbeef" });
    await flush();
    expect(h.overlay.hidden).toBe(true); // the overlay itself closes on a successful save
    // NOTES UI10: a successful save no longer forces a full-page reload — it refreshes the swapped
    // content region via the same fragment fetch an in-app navigation uses (never `location.reload`,
    // which would tear down the SSE connection this goal exists to stop doing that to).
    h.flushTimers(); // the short delay before the content refresh that re-derives from the commit
    expect(h.reloadCalls.length).toBe(0);
    expect(h.fetchCalls.length).toBe(4);
    expect(h.fetchCalls[3].url).toBe("/registry/teams");
    expect(h.fetchCalls[3].init.headers!["X-Levare-Fragment"]).toBe("1");
  });

  test("Save is blocked while invalid — clicking a disabled Save button does nothing", async () => {
    clickOn(h.doc, h.editOpen);
    h.fetchCalls[0].resolve({ ok: false, errors: [{ code: "UNKNOWN_KEY", message: "bad", file: "teams/kestrel.md" }] });
    await flush();
    expect(p.saveBtn.disabled).toBe(true);
    click(p.saveBtn);
    expect(h.fetchCalls.length).toBe(1); // no save POST was ever made
  });

  // UI4 item 1: the dirty-dismiss gate now goes through the shared in-app confirm-modal primitive
  // (render.ts#confirmModalHtml / app.js's confirmModal()) — never the browser's native confirm().
  // setupOverlay's fake `window` carries no `confirm`/`alert` at all (see setupOverlay's own comment),
  // so any regression back to the native dialog would throw straight out of these tests, not merely
  // go unnoticed.
  describe("dismiss paths — Cancel, Escape, and the backdrop each honor the dirty-check via the confirm modal", () => {
    test("a CLEAN buffer closes immediately, with no confirm modal, via Cancel, Escape, and the backdrop", () => {
      for (const dismiss of [
        () => click(p.cancelBtn),
        () => h.doc.dispatchEvent({ type: "keydown", key: "Escape" }),
        () => click(p.backdrop),
      ]) {
        h = setupOverlay();
        p = overlayParts(h);
        const cm = confirmModalParts(h);
        clickOn(h.doc, h.editOpen);
        expect(h.overlay.hidden).toBe(false);
        dismiss();
        expect(h.overlay.hidden).toBe(true);
        expect(cm.modal.hidden).toBe(true); // never opened — an unchanged buffer needs no confirmation
      }
    });

    test("a DIRTY buffer opens the in-app confirm modal with 'Discard unsaved changes?' — via Cancel, Escape, and the backdrop", async () => {
      for (const dismiss of [
        () => click(p.cancelBtn),
        () => h.doc.dispatchEvent({ type: "keydown", key: "Escape" }),
        () => click(p.backdrop),
      ]) {
        h = setupOverlay();
        p = overlayParts(h);
        const cm = confirmModalParts(h);
        clickOn(h.doc, h.editOpen);
        p.body.value = RAW_BODY + "\nchanged: true\n";
        p.body.dispatchEvent({ type: "input", target: p.body });

        dismiss();
        expect(cm.modal.hidden).toBe(false);
        expect(cm.question.textContent).toBe("Discard unsaved changes?");

        click(cm.keepBtn); // Conductor chooses to keep editing
        await flush();
        expect(cm.modal.hidden).toBe(true);
        expect(h.overlay.hidden).toBe(false); // still open — declined

        dismiss();
        expect(cm.modal.hidden).toBe(false);
        click(cm.discardBtn); // Conductor confirms discarding
        await flush();
        expect(cm.modal.hidden).toBe(true);
        expect(h.overlay.hidden).toBe(true);
      }
    });

    test("the confirm modal's own backdrop click also declines (keeps editing), same as its Keep-editing button", async () => {
      const cm = confirmModalParts(h);
      clickOn(h.doc, h.editOpen);
      p.body.value = RAW_BODY + "\nchanged: true\n";
      p.body.dispatchEvent({ type: "input", target: p.body });

      click(p.cancelBtn);
      expect(cm.modal.hidden).toBe(false);
      click(cm.backdrop);
      await flush();
      expect(cm.modal.hidden).toBe(true);
      expect(h.overlay.hidden).toBe(false); // declined — still open
    });
  });

  test("no native confirm()/alert() call remains anywhere in assets/app.js — the confirm modal is the only dismiss-confirmation surface", () => {
    // Strip comments first — this file's own prose legitimately mentions "confirm()"/"alert()" by
    // name (documenting what was replaced); the assertion is about executable code, not commentary.
    const code = APP_JS_SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/\bwindow\.confirm\(|\bconfirm\(|\balert\(/);
  });
});

// ---------------------------------------------------------------------------
// Seal-time regression (found during live-browser verification): a background client-side-navigation
// refresh (swapFragment — triggered by the SSE `reload` message on ANY repo change, not just this
// tab's own writes; e.g. the daemon's own startup tick still landing a moment after a fast
// navigate-then-click) unconditionally replaced `[data-extras-host]` — which holds the registry's one
// editor overlay — with a freshly server-rendered (hidden-by-default) copy. Opening the overlay, then
// having ANY repo change land before the Conductor closes it, silently destroyed the in-progress edit:
// no exception, no console error, just a fresh hidden overlay in its place. This suite builds a
// minimal fixture matching pageBody()'s REAL nesting (`.main` + a `[data-extras-host]` sibling of
// `.app`, the overlay INSIDE that host — the original overlay-only fixture above puts the overlay
// directly on `body`, which is enough for the open/close/save tests above but not for this one) and
// drives the real `navigate()`/`swapFragment()` path via an in-app anchor click, since neither
// function is itself exposed for direct invocation.
// ---------------------------------------------------------------------------
describe("swapFragment must not destroy an OPEN editor overlay on a background refresh (seal-time regression)", () => {
  function buildSwapFixture(doc: FakeDocument) {
    const app = doc.createElement("div");
    app.setAttribute("class", "app");
    doc.body.appendChild(app);

    const main = doc.createElement("main");
    main.setAttribute("class", "main");
    app.appendChild(main);

    const card = doc.createElement("article");
    card.setAttribute("class", "entity card");
    card.setAttribute("data-entity", "teams");
    card.setAttribute("data-path", "teams/kestrel.md");
    main.appendChild(card);

    const rawSource = doc.createElement("textarea");
    rawSource.setAttribute("class", "rawmd-source");
    rawSource.hidden = true;
    rawSource.value = RAW_SOURCE;
    card.appendChild(rawSource);

    const editOpen = doc.createElement("button");
    editOpen.setAttribute("class", "togglebtn");
    editOpen.setAttribute("data-edit-open", "");
    editOpen.setAttribute("data-path", "teams/kestrel.md");
    editOpen.setAttribute("data-editor-name", "kestrel");
    editOpen.setAttribute("data-editor-kind", "team");
    card.appendChild(editOpen);

    // An ordinary in-app link elsewhere on the page — clicking it is this harness's only way to
    // reach the real navigate()/swapFragment() path (neither is exposed for direct invocation).
    const link = doc.createElement("a");
    link.setAttribute("href", "/registry/teams");
    doc.body.appendChild(link);

    // `pageBody()`'s REAL nesting: `[data-extras-host]` is a body-level sibling of `.app`, and the
    // editor overlay lives INSIDE it — not directly on `body` (the simpler fixture above never needed
    // this distinction; this test's whole point is what happens to that host on a swap).
    const extrasHost = doc.createElement("div");
    extrasHost.setAttribute("data-extras-host", "");
    doc.body.appendChild(extrasHost);

    const overlay = doc.createElement("div");
    overlay.setAttribute("class", "editor-overlay");
    overlay.setAttribute("id", "editor-overlay");
    overlay.hidden = true;
    extrasHost.appendChild(overlay);

    const backdrop = doc.createElement("div");
    backdrop.setAttribute("data-editor-backdrop", "");
    overlay.appendChild(backdrop);
    const panel = doc.createElement("div");
    panel.setAttribute("class", "editor-overlay__panel");
    overlay.appendChild(panel);
    const title = doc.createElement("h2");
    title.setAttribute("class", "editor-overlay__title");
    panel.appendChild(title);
    const kind = doc.createElement("span");
    kind.setAttribute("class", "editor-overlay__kind mono");
    panel.appendChild(kind);
    const dirty = doc.createElement("span");
    dirty.setAttribute("class", "editor-overlay__dirty");
    dirty.setAttribute("data-editor-dirty", "");
    dirty.hidden = true;
    panel.appendChild(dirty);
    const front = doc.createElement("textarea");
    front.setAttribute("class", "editor-overlay__textarea editor-overlay__textarea--front");
    panel.appendChild(front);
    const bodyTa = doc.createElement("textarea");
    bodyTa.setAttribute("class", "editor-overlay__textarea editor-overlay__textarea--body");
    panel.appendChild(bodyTa);
    const validity = doc.createElement("span");
    validity.setAttribute("class", "validity");
    panel.appendChild(validity);
    const errors = doc.createElement("div");
    errors.setAttribute("class", "editor-overlay__errors");
    panel.appendChild(errors);
    const cancel = doc.createElement("button");
    cancel.setAttribute("data-editor-cancel", "");
    panel.appendChild(cancel);
    const save = doc.createElement("button");
    save.setAttribute("data-editor-save", "");
    save.disabled = true;
    panel.appendChild(save);

    return { editOpen, link, extrasHost, overlay, front, body: bodyTa, cancel, main };
  }

  function setupSwapGuard() {
    const doc = new FakeDocument();
    const fixture = buildSwapFixture(doc);

    let timerId = 1;
    const timers: Array<{ id: number; fn: () => void }> = [];
    const fakeSetTimeout = (fn: () => void, _ms: number): number => {
      const id = timerId++;
      timers.push({ id, fn });
      return id;
    };
    const fakeClearTimeout = (id: number): void => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    };
    const flushTimers = () => {
      const due = timers.splice(0, timers.length);
      for (const t of due) t.fn();
    };

    // `fetchFragment` (app.js) requires a JSON content-type header to accept a response as a real
    // fragment payload — the simpler overlay-only fixture's fetch mock never needed one (it only ever
    // answers the check/save routes, whose responses fetchFragment never sees).
    type FragmentBody = { ok: boolean; main?: string; extras?: string; title?: string };
    const pending: Array<{ url: string; resolve: (b: FragmentBody) => void }> = [];
    const fakeFetch = (url: string, _init?: any) =>
      new Promise((resolve) => {
        pending.push({
          url,
          resolve: (body: FragmentBody) =>
            resolve({ ok: true, headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? "application/json" : null) }, json: () => Promise.resolve(body) }),
        });
      });

    const context: any = {
      document: doc,
      window: { matchMedia: undefined, EventSource: undefined, scrollTo: undefined },
      location: { pathname: "/registry/teams", search: "", href: "http://localhost/registry/teams" },
      history: { pushState: () => {} },
      fetch: fakeFetch,
      setTimeout: fakeSetTimeout,
      clearTimeout: fakeClearTimeout,
      console,
    };
    vm.createContext(context);
    vm.runInContext(APP_JS_SOURCE, context);
    (doc as any).dispatchEvent({ type: "DOMContentLoaded" });

    return { doc, ...fixture, pending, flushTimers };
  }

  function clickLink(doc: FakeDocument, target: FakeElement) {
    // The delegated in-app-navigation handler (app.js) requires `button === 0` (a real left-click) —
    // the shared `click()`/`clickOn()` helpers above never set it since no prior test needed to.
    doc.dispatchEvent({ type: "click", target, button: 0, preventDefault() {} });
  }

  function flush(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  // A refreshed extras payload must carry the FULL overlay anatomy — `bindEditorOverlay()` re-runs
  // against whatever this parses into and throws if any element it expects (cancel/save/backdrop/
  // front/body/...) is missing, exactly as it would against a real, mismatched server response.
  function fullOverlayHTML(marker: string): string {
    return (
      '<div class="editor-overlay" id="editor-overlay" hidden ' + marker + '>' +
      '<div data-editor-backdrop></div>' +
      '<div class="editor-overlay__panel">' +
      '<h2 class="editor-overlay__title"></h2>' +
      '<span class="editor-overlay__kind mono"></span>' +
      '<span class="editor-overlay__dirty" data-editor-dirty hidden></span>' +
      '<textarea class="editor-overlay__textarea editor-overlay__textarea--front"></textarea>' +
      '<textarea class="editor-overlay__textarea editor-overlay__textarea--body"></textarea>' +
      '<span class="validity"></span>' +
      '<div class="editor-overlay__errors"></div>' +
      '<button data-editor-cancel></button>' +
      '<button data-editor-save disabled></button>' +
      '</div></div>'
    );
  }

  test("an open, DIRTY overlay survives a background navigate-refresh — the buffer is untouched, and main still updates", async () => {
    const h = setupSwapGuard();
    clickLink(h.doc, h.editOpen); // wait — this must go through the delegated data-edit-open handler
    await flush();
    expect(h.overlay.hidden).toBe(false);

    h.body.value = "changed while open";
    h.body.dispatchEvent({ type: "input", target: h.body });

    // A background refresh lands (this tab's own navigate(), standing in for the real SSE `reload`
    // path — both funnel through the same swapFragment()). `pending` also holds the check-route
    // fetch openEditor() already fired, so find the fragment request by its own URL rather than by
    // position.
    clickLink(h.doc, h.link);
    await flush();
    const fragmentReq = h.pending.find((p) => p.url === "/registry/teams");
    expect(fragmentReq).not.toBeUndefined();
    fragmentReq!.resolve({
      ok: true,
      main: '<main class="main" data-fresh="1"></main>',
      extras: fullOverlayHTML('data-should-never-appear="1"'),
      title: "levare · registry",
    });
    await flush();

    // The overlay is untouched — still open, still carrying the Conductor's unsaved edit — even
    // though `.main` DID update (the guard is scoped to the extras host only, not a blanket freeze).
    expect(h.overlay.hidden).toBe(false);
    expect(h.body.value).toBe("changed while open");
    expect(h.doc.querySelector('.main[data-fresh="1"]')).not.toBeNull();
    // The extras host was left alone entirely — still the SAME overlay node, not a freshly-parsed one.
    expect(h.extrasHost.querySelector("#editor-overlay")).toBe(h.overlay);
    expect(h.overlay.hasAttribute("data-should-never-appear")).toBe(false);
  });

  test("once the overlay is closed, the NEXT background refresh replaces the extras host normally", async () => {
    const h = setupSwapGuard();
    clickLink(h.doc, h.editOpen);
    await flush();
    expect(h.overlay.hidden).toBe(false);

    // Close it (buffer was never touched, so this is the clean-buffer immediate-close path).
    h.cancel.dispatchEvent({ type: "click", target: h.cancel, preventDefault() {} });
    expect(h.overlay.hidden).toBe(true);

    clickLink(h.doc, h.link);
    await flush();
    const fragmentReq = h.pending.find((p) => p.url === "/registry/teams");
    expect(fragmentReq).not.toBeUndefined();
    fragmentReq!.resolve({
      ok: true,
      main: '<main class="main" data-fresh="1"></main>',
      extras: fullOverlayHTML('data-refreshed="1"'),
      title: "levare · registry",
    });
    await flush();

    // Now the extras host DID get replaced — the guard only ever holds while the overlay is open.
    const refreshed = h.doc.getElementById("editor-overlay");
    expect(refreshed).not.toBeNull();
    expect(refreshed!.getAttribute("data-refreshed")).toBe("1");
    expect(refreshed).not.toBe(h.overlay);
  });
});

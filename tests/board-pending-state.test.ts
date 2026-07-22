import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// NOTES UI6: exercises the REAL assets/app.js gate-card click handling (loaded verbatim) against a
// minimal, hand-rolled DOM harness — same approach as tests/board-editor-overlay.test.ts (no
// DOM/browser-automation dependency anywhere in this project, by design). This suite is the proof for
// the goal's one intended behaviour change: a Start/Request-changes/Retry click on a gate card must
// give LOCAL, in-place pending feedback (the control that triggered it, and nothing more) rather than
// replacing the whole card with a bare loading line — the anti-pattern `markDispatching` used to be.

// ---------------------------------------------------------------------------
// Minimal selector support — only what app.js's gate-card click handler actually calls:
// `.gate [data-verb]`, `closest('.gate')`, `[data-verb="x"]`, `.classname`, `#id`.
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
  get parentNode(): FakeElement | null {
    return this.parent;
  }
  focus(): void {
    /* no-op */
  }
  appendChild(c: FakeElement): FakeElement {
    c.parent = this;
    this.children.push(c);
    return c;
  }
  insertBefore(c: FakeElement, ref: FakeElement | null): FakeElement {
    c.parent = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i >= 0) this.children.splice(i, 0, c);
    else this.children.push(c);
    return c;
  }
  remove(): void {
    if (!this.parent) return;
    const i = this.parent.children.indexOf(this);
    if (i >= 0) this.parent.children.splice(i, 1);
    this.parent = null;
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
    // openNote() builds its Send/Cancel row via a raw `<button ...>text</button>` string — a tiny,
    // deliberately non-general parser for that one fixed shape (flat, non-nested `<tag attrs>text</tag>`
    // runs), same "only what the code under test actually needs" scope as the rest of this harness.
    for (const c of this.children) c.parent = null;
    this.children = [];
    this._text = "";
    if (!v) return;
    const tagRe = /<(\w+)([^>]*)>([^<]*)<\/\1>/g;
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(v))) {
      const [, tag, attrsStr, text] = m;
      const el = new FakeElement(tag);
      const attrRe = /([a-zA-Z0-9_-]+)(?:="([^"]*)")?/g;
      let am: RegExpExecArray | null;
      while ((am = attrRe.exec(attrsStr))) {
        el.setAttribute(am[1], am[2] ?? "");
      }
      el.textContent = text;
      this.appendChild(el);
    }
  }
  closest(selector: string): FakeElement | null {
    // Full closest() semantics, not just a single compound: app.js calls this with descendant-
    // combinator selectors too (`.gate [data-verb]`), so each comma-branch is matched via the same
    // multi-step ancestor walk querySelectorAll uses (matchesSteps), not a single-compound check.
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
// Fixture — the exact anatomy render.ts#gateCardHtml produces for the default (Needs You / project
// summon) variant and the gate--start variant: marker, unit title, name-row (artifact + producer),
// context paragraph, meta, badge, and a verbs row of `[data-verb]` buttons.
// ---------------------------------------------------------------------------
function buildDefaultGateCard(doc: FakeDocument): FakeElement {
  const article = doc.createElement("article");
  article.setAttribute("class", "gate");
  article.setAttribute("data-gate-project", "storefront");
  article.setAttribute("data-gate-target", "spec-checkout-flow-v1");
  doc.body.appendChild(article);

  const top = doc.createElement("div");
  top.setAttribute("class", "gate__top");
  article.appendChild(top);

  const marker = doc.createElement("span");
  marker.setAttribute("class", "gate__marker");
  top.appendChild(marker);

  const body = doc.createElement("div");
  body.setAttribute("class", "gate__body");
  top.appendChild(body);

  const unitRow = doc.createElement("div");
  unitRow.setAttribute("class", "gate__unit-row");
  const unitLink = doc.createElement("a");
  unitLink.setAttribute("class", "gate__unit");
  unitLink.textContent = "checkout-flow";
  unitRow.appendChild(unitLink);
  body.appendChild(unitRow);

  const nameRow = doc.createElement("div");
  nameRow.setAttribute("class", "gate__name-row");
  const artLink = doc.createElement("a");
  artLink.setAttribute("class", "tok link mono");
  artLink.textContent = "spec-checkout-flow-v1.md";
  nameRow.appendChild(artLink);
  const producer = doc.createElement("span");
  producer.setAttribute("class", "gate__producer");
  producer.textContent = "member/lyra";
  nameRow.appendChild(producer);
  body.appendChild(nameRow);

  const ctx = doc.createElement("p");
  ctx.setAttribute("class", "gate__ctx");
  ctx.textContent = "The guest-checkout spec is ready for review.";
  body.appendChild(ctx);

  const meta = doc.createElement("div");
  meta.setAttribute("class", "gate__meta");
  meta.textContent = "2h ago";
  body.appendChild(meta);

  const badge = doc.createElement("span");
  badge.setAttribute("class", "gate__badge");
  badge.textContent = "on you";
  top.appendChild(badge);

  const verbs = doc.createElement("div");
  verbs.setAttribute("class", "gate__verbs");
  article.appendChild(verbs);
  for (const [verb, label] of [
    ["approve", "Approve"],
    ["request", "Request changes"],
    ["reject", "Reject"],
  ] as const) {
    const btn = doc.createElement("button");
    btn.setAttribute("class", "verb");
    btn.setAttribute("data-verb", verb);
    btn.textContent = label;
    verbs.appendChild(btn);
  }

  return article;
}

function buildStartGateCard(doc: FakeDocument): FakeElement {
  const article = doc.createElement("article");
  article.setAttribute("class", "gate gate--start");
  article.setAttribute("data-gate-project", "storefront");
  article.setAttribute("data-gate-target", "loyalty-flow");
  doc.body.appendChild(article);

  const top = doc.createElement("div");
  top.setAttribute("class", "gate__top");
  article.appendChild(top);

  const body = doc.createElement("div");
  body.setAttribute("class", "gate__body");
  top.appendChild(body);

  const nameRow = doc.createElement("div");
  nameRow.setAttribute("class", "gate__name-row");
  const unitLink = doc.createElement("a");
  unitLink.setAttribute("class", "tok link mono");
  unitLink.textContent = "loyalty-flow";
  nameRow.appendChild(unitLink);
  body.appendChild(nameRow);

  const ctx = doc.createElement("p");
  ctx.setAttribute("class", "gate__ctx");
  ctx.textContent = "Queued work unit awaiting your beat to begin.";
  body.appendChild(ctx);

  const badge = doc.createElement("span");
  badge.setAttribute("class", "gate__badge is-start");
  badge.textContent = "start gate";
  top.appendChild(badge);

  const verbs = doc.createElement("div");
  verbs.setAttribute("class", "gate__verbs");
  article.appendChild(verbs);
  for (const [verb, label] of [
    ["start", "Start"],
    ["notyet", "Not yet"],
    ["rescope", "Re-scope"],
  ] as const) {
    const btn = doc.createElement("button");
    btn.setAttribute("class", "verb");
    btn.setAttribute("data-verb", verb);
    btn.textContent = label;
    verbs.appendChild(btn);
  }

  return article;
}

// ---------------------------------------------------------------------------
// vm harness: loads the real assets/app.js verbatim, fires DOMContentLoaded, exposes a scriptable
// fake fetch (never awaited by the test — the click handler calls markDispatching synchronously,
// before the fetch promise settles, which is exactly the "immediate" feedback under test).
// ---------------------------------------------------------------------------
const APP_JS_SOURCE = readFileSync(new URL("../assets/app.js", import.meta.url), "utf8");

function setup() {
  const doc = new FakeDocument();
  const fetchCalls: Array<{ url: string }> = [];
  const context = {
    document: doc,
    window: { matchMedia: undefined, EventSource: undefined },
    location: { reload: () => {} },
    fetch: (url: string) => {
      fetchCalls.push({ url });
      return new Promise(() => {}); // never settles — irrelevant to the synchronous DOM assertions
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
    console,
  };
  vm.createContext(context);
  vm.runInContext(APP_JS_SOURCE, context);
  (doc as any).dispatchEvent({ type: "DOMContentLoaded" });
  return { doc, fetchCalls };
}

// ---------------------------------------------------------------------------
// A richer harness for the amendment-1 §2 R4/R5 suite below: a real (fake-timer-controlled) `fetch`
// so success/failure resolution can be exercised, and a `setTimeout` that records scheduled callbacks
// instead of either dropping them (the harness above) or firing them immediately — `flush()` runs the
// oldest still-pending one, mirroring exactly one real timer tick (the tier-1 spinner-delay timer).
// ---------------------------------------------------------------------------
function setupWithControls(fetchImpl?: (url: string) => Promise<any>) {
  const doc = new FakeDocument();
  const fetchCalls: Array<{ url: string }> = [];
  const timers: Array<{ fn: (() => void) | null }> = [];
  const context = {
    document: doc,
    window: { matchMedia: undefined, EventSource: undefined },
    location: { reload: () => {} },
    fetch: (url: string) => {
      fetchCalls.push({ url });
      return fetchImpl ? fetchImpl(url) : new Promise(() => {});
    },
    setTimeout: (fn: () => void) => {
      timers.push({ fn });
      return timers.length; // 1-based id, matching the `clearTimeout` lookup below
    },
    clearTimeout: (id: number) => {
      const t = timers[id - 1];
      if (t) t.fn = null;
    },
    console,
  };
  vm.createContext(context);
  vm.runInContext(APP_JS_SOURCE, context);
  (doc as any).dispatchEvent({ type: "DOMContentLoaded" });
  return {
    doc,
    fetchCalls,
    flush() {
      const t = timers.shift();
      if (t && t.fn) t.fn();
    },
  };
}

// A real macrotask boundary — drains every microtask a resolved-promise `.then()` chain queues, the
// same "never a fixed number of Promise.resolve() ticks" idiom board-merge-gate-card.test.ts uses.
function drain(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

function click(doc: FakeDocument, target: FakeElement) {
  doc.dispatchEvent({ type: "click", target, preventDefault() {} });
}

describe("gate-card pending feedback is local, not a whole-card replacement (NOTES UI6)", () => {
  test("clicking Start on a start-gate card leaves the title/context in place and shows pending feedback only in the verbs row", () => {
    const { doc, fetchCalls } = setup();
    const card = buildStartGateCard(doc);
    const startBtn = card.querySelector('[data-verb="start"]')!;

    click(doc, startBtn);

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toContain("/gates/storefront/loyalty-flow/start");

    // The card was NOT wiped: title, context, and the marker/body structure are all still present.
    expect(card.querySelector(".gate__name-row")).not.toBeNull();
    expect(card.querySelector(".gate__name-row")!.textContent).toContain("loyalty-flow");
    expect(card.querySelector(".gate__ctx")).not.toBeNull();
    expect(card.querySelector(".gate__ctx")!.textContent).toContain("Queued work unit");
    expect(card.classList.contains("is-dispatching")).toBe(true);

    // Only the start badge's text changes (matches render.ts's own server-rendered dispatching state).
    expect(card.querySelector(".gate__badge")!.textContent).toBe("dispatching");

    // The verbs row — and only the verbs row — now carries the local pending indicator; the original
    // Start/Not yet/Re-scope buttons are gone from THAT row, but nothing else on the card was touched.
    const verbs = card.querySelector(".gate__verbs")!;
    expect(verbs.classList.contains("gate__verbs--pending")).toBe(true);
    expect(verbs.querySelector(".pending")).not.toBeNull();
    expect(verbs.querySelector(".pending__label")!.textContent).toContain("dispatching");
    expect(verbs.querySelector('[data-verb="start"]')).toBeNull();
  });

  test("clicking Request changes then Send shows pending feedback on the note's own verbs row, not the original hidden one", () => {
    const { doc, fetchCalls } = setup();
    const card = buildDefaultGateCard(doc);
    const requestBtn = card.querySelector('[data-verb="request"]')!;

    click(doc, requestBtn);
    const note = card.querySelector(".gate__note")!;
    expect(note).not.toBeNull();
    note.value = "please tighten the payments section";

    const sendBtn = card.querySelector('[data-verb="send"]')!;
    click(doc, sendBtn);

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toContain("/gates/storefront/spec-checkout-flow-v1/request");

    // Card content (title, producer, context) is untouched by the whole flow.
    expect(card.querySelector(".gate__unit-row")!.textContent).toContain("checkout-flow");
    expect(card.querySelector(".gate__producer")!.textContent).toContain("lyra");
    expect(card.querySelector(".gate__ctx")!.textContent).toContain("guest-checkout spec");
    // The default badge's text is untouched — the server never changes it on dispatch either.
    expect(card.querySelector(".gate__badge")!.textContent).toBe("on you");

    // The pending indicator lands on the Send/Cancel row (the one actually visible), not the original
    // (now display:none) approve/request/reject row.
    const allVerbRows = card.querySelectorAll(".gate__verbs");
    expect(allVerbRows.length).toBe(2);
    const pendingRow = allVerbRows.find((r) => r.querySelector(".pending") !== null);
    expect(pendingRow).not.toBeUndefined();
    expect(pendingRow!.querySelector('[data-verb="send"]')).toBeNull();
    const originalRow = allVerbRows.find((r) => r !== pendingRow);
    expect(originalRow!.style.display).toBe("none");
    // The submitted note text is left in place, frozen (disabled), not wiped.
    expect(note.value).toBe("please tighten the payments section");
    expect(note.disabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Amendment 1 §2 R4 (tier-1 button state) / R5 (no double-submit; failure keeps state and offers
// retry) — cluster 2's own interaction-safety additions, built onto the existing `dispatching`
// concept and the existing gate-verb click pipeline exercised above, not a parallel mechanism.
// ---------------------------------------------------------------------------
describe("gate-card verb interaction safety (amendment 1 §2 R4/R5)", () => {
  test("clicking Approve disables every verb in the group instantly (no double-submit)", () => {
    const { doc, fetchCalls } = setupWithControls();
    const card = buildDefaultGateCard(doc);
    const approveBtn = card.querySelector('[data-verb="approve"]')!;

    click(doc, approveBtn);

    expect(fetchCalls.length).toBe(1);
    expect(approveBtn.classList.contains("is-pressed")).toBe(true);
    // Every button in the row — not just the clicked one — is disabled the instant a verb fires.
    card.querySelectorAll(".gate__verbs button").forEach((b) => expect(b.disabled).toBe(true));

    // A fast op (a plain approve) never flashes a spinner instantly — R4's whole point.
    expect(card.querySelector(".pending")).toBeNull();
  });

  test("a second verb click on the same card while one is in flight is ignored", () => {
    const { doc, fetchCalls } = setupWithControls();
    const card = buildDefaultGateCard(doc);

    click(doc, card.querySelector('[data-verb="approve"]')!);
    // The buttons are disabled synchronously, but even a click event the disabled-button semantics
    // didn't stop (this harness has no native `disabled` click-suppression) is still refused —
    // `card._inflight` is the actual guard, not reliance on the browser's own disabled-button behavior.
    click(doc, card.querySelector('[data-verb="reject"]')!);

    expect(fetchCalls.length).toBe(1);
  });

  test("Approve's spinner only appears after the delay, not instantly — a fast resolution never shows one", () => {
    const { doc, flush } = setupWithControls();
    const card = buildDefaultGateCard(doc);
    click(doc, card.querySelector('[data-verb="approve"]')!);

    expect(card.querySelector(".pending")).toBeNull();
    flush(); // fires the spinner-delay timer
    const verbs = card.querySelector(".gate__verbs")!;
    expect(verbs.classList.contains("gate__verbs--pending")).toBe(true);
    expect(verbs.querySelector(".pending__label")!.textContent).toContain("approving");
  });

  test("a successful Approve collapses the card to the resolved line", async () => {
    const { doc } = setupWithControls(() => Promise.resolve({ json: () => Promise.resolve({ ok: true }) }));
    const card = buildDefaultGateCard(doc);
    click(doc, card.querySelector('[data-verb="approve"]')!);
    await drain();

    expect(card.classList.contains("is-resolved")).toBe(true);
    expect(card.textContent).toContain("approved");
  });

  test("a failed Approve keeps the card's state and offers a Retry affordance — never a silent reset", async () => {
    const { doc } = setupWithControls(() =>
      Promise.resolve({ json: () => Promise.resolve({ ok: false, error: "artifact 'spec-checkout-flow-v1' is not at an open gate (status: approved)" }) }),
    );
    const card = buildDefaultGateCard(doc);
    click(doc, card.querySelector('[data-verb="approve"]')!);
    await drain();

    // Never a silent reset: the card is not resolved, and the failure is stated, not swallowed.
    expect(card.classList.contains("is-resolved")).toBe(false);
    const notice = card.querySelector(".notice--danger")!;
    expect(notice).not.toBeNull();
    expect(notice.textContent).toContain("not at an open gate");
    // The retry affordance re-fires the SAME decision — a plain approve, not a different verb.
    const retryBtn = card.querySelector('[data-verb="approve"]')!;
    expect(retryBtn).not.toBeNull();
    expect(retryBtn.disabled).toBe(false);
  });

  test("a failed Start (a dispatch verb) keeps the dispatching card honest and offers Retry, rather than sitting stuck forever", async () => {
    const { doc } = setupWithControls(() =>
      Promise.resolve({ json: () => Promise.resolve({ ok: false, error: "unit 'loyalty-flow' has nothing left for team 'kestrel' to produce" }) }),
    );
    const card = buildStartGateCard(doc);
    click(doc, card.querySelector('[data-verb="start"]')!);
    expect(card.classList.contains("is-dispatching")).toBe(true);
    await drain();

    // The dispatching state is cleared honestly — the failure is shown, not left as a stuck spinner
    // with no trace of what went wrong (the pre-cluster-2 gap for every dispatch verb but a merge's
    // own `approve`).
    expect(card.classList.contains("is-dispatching")).toBe(false);
    const notice = card.querySelector(".notice--danger")!;
    expect(notice).not.toBeNull();
    expect(notice.textContent).toContain("nothing left for team");
    expect(card.querySelector('[data-verb="start"]')).not.toBeNull();
  });
});

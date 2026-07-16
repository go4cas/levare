import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { loadRepo } from "../src/repo.ts";
import { renderStudio, renderProject, renderRun } from "../src/board/render.ts";
import type { OrchestratorStatus } from "../src/orchestrator-status.ts";

// NOTES UI8 — the Orchestrator panel reads as a conversation, not a labelled log: the old per-message
// "RESPONSE"/"BRIEFING" header is gone; the Orchestrator's speech is marked once per turn (the podium
// mark, left-aligned), the Conductor's own messages render right-aligned in an accent bubble, and
// consecutive same-speaker messages merge into one turn. This suite has two halves: server-rendered
// HTML assertions (the initial page load, string-based — same style as tests/board-render.test.ts),
// and a client-side half exercising the real assets/app.js verbatim against a hand-rolled fake DOM (the
// same no-DOM-dependency approach as tests/board-pending-state.test.ts) for the parts of the goal that
// are inherently client behaviour: turn-merging and the in-flight "thinking" state.

const root = "fixtures/golden";
const repo = loadRepo(root);
const now = new Date("2026-07-11T20:00:00Z");
const ON: OrchestratorStatus = { available: true, reason: "The Orchestrator is live.", envVar: "ANTHROPIC_API_KEY" };
const OFF: OrchestratorStatus = { available: false, reason: "ANTHROPIC_API_KEY is not set", envVar: "ANTHROPIC_API_KEY" };

// Strip the hidden raw-markdown textareas / templates the same way board-render.test.ts's registry
// suite does — not needed here (the orchestrator panel has none), kept absent deliberately.

describe("server-rendered Orchestrator panel — no per-message header, mark once, first-message caption", () => {
  const screens: Array<[string, string]> = [
    ["studio", renderStudio(repo, root, now, [], ON)],
    ["project", renderProject(repo, "storefront", root, now, [], ON)],
    ["run", renderRun(repo, "storefront", "checkout-flow", root, now, [], ON)],
  ];

  for (const [name, html] of screens) {
    test(`${name}: the opening message is a left-aligned Orchestrator turn with the mark, no "RESPONSE"/"BRIEFING" label`, () => {
      expect(html).toContain('class="turn turn--orch"');
      expect(html).toContain('class="turn__mark"');
      // The old header is gone outright — no label wrapper, no per-message kind/timestamp spans.
      expect(html).not.toContain("msg__label");
      expect(html).not.toContain("RESPONSE");
      expect(html).not.toContain("BRIEFING");
    });

    // NOTES UI11: the caption now wraps its relative-time text in its own `.turn__time` span, carrying
    // the full ISO timestamp as a hover `title` — the "short relative form, full stamp on hover" rule.
    test(`${name}: the first (and only server-rendered) message carries a quiet "briefing · now" caption with a full-timestamp title`, () => {
      expect(html).toContain('class="turn__caption mono">briefing &middot; <span class="turn__time" title="2026-07-11T20:00:00.000Z">now</span></div>');
      // Exactly one caption — this screen only ever server-renders a single opening turn.
      expect(html.match(/turn__caption/g)?.length).toBe(1);
    });
  }

  test("the disabled (no API key) panel still speaks as the Orchestrator (mark, left-aligned) but carries no briefing caption — it's an availability notice, not a briefing", () => {
    const html = renderStudio(repo, root, now, [], OFF);
    expect(html).toContain('class="orch is-disabled"');
    expect(html).toContain('class="turn turn--orch"');
    expect(html).toContain('class="turn__mark"');
    expect(html).not.toContain("turn__caption");
    expect(html).not.toContain("msg__label");
  });
});

describe("the composer markup is untouched by the conversation redesign", () => {
  test("the enabled composer's form/input/button markup is byte-identical to before", () => {
    const html = renderStudio(repo, root, now, [], ON);
    expect(html).toContain('<div class="composer"><form data-orchestrator-form><input type="text" placeholder="Message the Orchestrator" aria-label="Message the Orchestrator"/><span class="ret">&#8629;</span></form></div>');
  });
  test("the disabled composer's markup is byte-identical to before", () => {
    const html = renderStudio(repo, root, now, [], OFF);
    expect(html).toContain('<div class="composer is-disabled"><form data-orchestrator-form aria-disabled="true"><input type="text" placeholder="Orchestrator unavailable" aria-label="Message the Orchestrator" disabled/><span class="ret">&#8629;</span></form></div>');
  });
});

// ---------------------------------------------------------------------------
// Client-side half — a minimal, hand-rolled DOM harness (no DOM/browser-automation dependency
// anywhere in this project, by design; same approach as tests/board-pending-state.test.ts), loading
// the real assets/app.js verbatim.
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
  disabled = false;
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
  focus(): void {}
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
  get lastElementChild(): FakeElement | null {
    return this.children.length ? this.children[this.children.length - 1] : null;
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
  createTextNode(text: string): FakeElement {
    const t = new FakeElement("#text");
    t.textContent = text;
    return t;
  }
  getElementById(_id: string): FakeElement | null {
    return null; // no gate templates in these fixtures — data-summon narration never clones one
  }
  querySelectorAll(selector: string): FakeElement[] {
    return this.body.querySelectorAll(selector);
  }
  querySelector(selector: string): FakeElement | null {
    return this.body.querySelector(selector);
  }
}

const APP_JS_SOURCE = readFileSync(new URL("../assets/app.js", import.meta.url), "utf8");

// `build`, when given, populates the fixture DOM BEFORE `DOMContentLoaded` fires — required for the
// composer: unlike the gate-card/summon handlers (delegated on `document`, so they work regardless of
// when their targets appear), app.js attaches the submit listener directly to each form found via
// `document.querySelectorAll('.composer:not(.is-disabled) form')` AT DOMContentLoaded time.
function setup(build?: (doc: FakeDocument) => void, fetchImpl?: (url: string, opts?: any) => Promise<any>) {
  const doc = new FakeDocument();
  if (build) build(doc);
  const fetchCalls: Array<{ url: string; opts?: any }> = [];
  const context: any = {
    document: doc,
    window: { matchMedia: undefined, EventSource: undefined },
    location: { reload: () => {} },
    fetch: (url: string, opts?: any) => {
      fetchCalls.push({ url, opts });
      return fetchImpl ? fetchImpl(url, opts) : new Promise(() => {});
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

function click(doc: FakeDocument, target: FakeElement) {
  doc.dispatchEvent({ type: "click", target, preventDefault() {} });
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// Builds `<aside class="orch"><div class="orch__body"/><div class="composer"><form><input/></form></div></aside>`
// on `doc.body` — must run inside `setup()`'s `build` callback (before DOMContentLoaded) so app.js's
// direct (non-delegated) `querySelectorAll('.composer:not(.is-disabled) form')` attaches its listener.
function buildComposer(doc: FakeDocument, opts: { scope?: string | null } = {}) {
  const aside = doc.createElement("aside");
  aside.setAttribute("class", "orch");
  // NOTES V11-CONV: real pages always carry `data-scope` (render/shell.ts#orchestratorPanel); this
  // fixture defaults to a project scope so tests can tell a real value apart from the client's own
  // 'studio' fallback when the attribute is absent (exercised by a dedicated test below).
  if (opts.scope !== null) aside.setAttribute("data-scope", opts.scope ?? "storefront");
  doc.body.appendChild(aside);
  const body = doc.createElement("div");
  body.setAttribute("class", "orch__body");
  aside.appendChild(body);
  const composerDiv = doc.createElement("div");
  composerDiv.setAttribute("class", "composer");
  aside.appendChild(composerDiv);
  const form = doc.createElement("form");
  composerDiv.appendChild(form);
  const input = doc.createElement("input");
  form.appendChild(input);
  return { aside, body, form, input };
}

describe("consecutive Orchestrator messages merge into one turn (item 4)", () => {
  test("two summoned narrations in a row produce ONE turn--orch with ONE mark and two message paragraphs", () => {
    let refs!: ReturnType<typeof buildComposer>;
    const { doc } = setup((doc) => {
      refs = buildComposer(doc);
    });
    const { body } = refs;

    const btn1 = doc.createElement("button");
    btn1.setAttribute("data-summon", "tpl-none");
    btn1.setAttribute("data-narrate", "First narration.");
    doc.body.appendChild(btn1);
    const btn2 = doc.createElement("button");
    btn2.setAttribute("data-summon", "tpl-none");
    btn2.setAttribute("data-narrate", "Second narration.");
    doc.body.appendChild(btn2);

    click(doc, btn1);
    click(doc, btn2);

    const turns = body.querySelectorAll(".turn");
    expect(turns.length).toBe(1);
    expect(turns[0].classList.contains("turn--orch")).toBe(true);
    expect(body.querySelectorAll(".turn__mark").length).toBe(1);
    const paras = body.querySelectorAll(".turn__body");
    expect(paras.length).toBe(2);
    expect(paras[0].textContent).toBe("First narration.");
    expect(paras[1].textContent).toBe("Second narration.");
  });
});

describe("a Conductor message renders right-aligned in an accent bubble (item 3)", () => {
  test("submitting the composer appends a turn--user carrying the typed text", () => {
    let refs!: ReturnType<typeof buildComposer>;
    setup((doc) => {
      refs = buildComposer(doc);
    });
    const { body, form, input } = refs;

    input.value = "what needs me?";
    form.dispatchEvent({ type: "submit", preventDefault() {} });

    const userTurns = body.querySelectorAll(".turn--user");
    expect(userTurns.length).toBe(1);
    const bubble = userTurns[0].querySelector(".turn__body")!;
    expect(bubble).not.toBeNull();
    expect(bubble.textContent).toBe("what needs me?");
    // The Conductor's turn carries no mark — the mark is the Orchestrator's speaker signal only.
    expect(userTurns[0].querySelector(".turn__mark")).toBeNull();
  });
});

describe("NOTES V11-CONV: the composer echoes the panel's own data-scope attribute back to the server", () => {
  test("the POST body's scope matches the panel's data-scope attribute", () => {
    let refs!: ReturnType<typeof buildComposer>;
    const { doc, fetchCalls } = setup((doc) => {
      refs = buildComposer(doc, { scope: "storefront" });
    });
    const { form, input } = refs;

    input.value = "how's checkout-flow?";
    form.dispatchEvent({ type: "submit", preventDefault() {} });

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toBe("/orchestrator/message");
    const body = JSON.parse(fetchCalls[0].opts.body);
    expect(body).toEqual({ text: "how's checkout-flow?", scope: "storefront" });
  });

  test("with no data-scope attribute at all (a fixture gap, never a real page), falls back to 'studio' rather than sending an invalid value", () => {
    let refs!: ReturnType<typeof buildComposer>;
    const { fetchCalls } = setup((doc) => {
      refs = buildComposer(doc, { scope: null });
    });
    const { form, input } = refs;

    input.value = "hello";
    form.dispatchEvent({ type: "submit", preventDefault() {} });

    const body = JSON.parse(fetchCalls[0].opts.body);
    expect(body.scope).toBe("studio");
  });
});

// ---------------------------------------------------------------------------
// NOTES UI11 — every client-appended turn (either speaker), not just the server-rendered opening
// briefing, carries a quiet caption: a relative-time span with the full ISO timestamp as its hover
// `title`. Mirrors render.ts#turnCaption's markup exactly.
// ---------------------------------------------------------------------------

describe("NOTES UI11: every client-appended turn (both speakers) carries a caption-styled timestamp", () => {
  test("a summoned Orchestrator narration's turn carries a turn__caption with a relative-time span and a full ISO title", () => {
    let refs!: ReturnType<typeof buildComposer>;
    const { doc } = setup((doc) => {
      refs = buildComposer(doc);
    });
    const { body } = refs;

    const btn = doc.createElement("button");
    btn.setAttribute("data-summon", "tpl-none");
    btn.setAttribute("data-narrate", "Here is the gate.");
    doc.body.appendChild(btn);
    click(doc, btn);

    const turn = body.querySelectorAll(".turn--orch")[0];
    const caption = turn.querySelector(".turn__caption");
    expect(caption).not.toBeNull();
    const time = caption!.querySelector(".turn__time")!;
    expect(time).not.toBeNull();
    expect(time.textContent).toBe("now");
    expect((time as any).title).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test("a Conductor (user) turn carries the identical caption treatment — same classes, same relative text, same title format", () => {
    let refs!: ReturnType<typeof buildComposer>;
    setup((doc) => {
      refs = buildComposer(doc);
    });
    const { body, form, input } = refs;

    input.value = "what needs me?";
    form.dispatchEvent({ type: "submit", preventDefault() {} });

    const userTurn = body.querySelectorAll(".turn--user")[0];
    const caption = userTurn.querySelector(".turn__caption");
    expect(caption).not.toBeNull();
    expect(caption!.className).toContain("mono");
    const time = caption!.querySelector(".turn__time")!;
    expect(time.textContent).toBe("now");
    expect((time as any).title).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test("a caption is stamped once per turn, at creation — a second merged message into the same turn does not add a second caption", () => {
    let refs!: ReturnType<typeof buildComposer>;
    const { doc } = setup((doc) => {
      refs = buildComposer(doc);
    });
    const { body } = refs;

    const btn1 = doc.createElement("button");
    btn1.setAttribute("data-summon", "tpl-none");
    btn1.setAttribute("data-narrate", "First.");
    doc.body.appendChild(btn1);
    const btn2 = doc.createElement("button");
    btn2.setAttribute("data-summon", "tpl-none");
    btn2.setAttribute("data-narrate", "Second.");
    doc.body.appendChild(btn2);

    click(doc, btn1);
    click(doc, btn2);

    const turns = body.querySelectorAll(".turn");
    expect(turns.length).toBe(1);
    expect(turns[0].querySelectorAll(".turn__caption").length).toBe(1);
  });
});

describe("the in-flight state renders inline, at the reply's own position — never a panel-wide loader (item 5)", () => {
  test("immediately after sending, a pending Orchestrator turn (mark + thinking dots) appears as the next turn, and nothing else about the panel changes", () => {
    let refs!: ReturnType<typeof buildComposer>;
    setup((doc) => {
      refs = buildComposer(doc);
    });
    const { aside, body, form, input } = refs;
    const asideClassBefore = aside.className;

    input.value = "how's checkout-flow?";
    form.dispatchEvent({ type: "submit", preventDefault() {} });

    // Exactly two turns exist: the Conductor's, then the pending Orchestrator turn — nothing panel-wide.
    const turns = body.querySelectorAll(".turn");
    expect(turns.length).toBe(2);
    expect(turns[0].classList.contains("turn--user")).toBe(true);
    const pendingTurn = turns[1];
    expect(pendingTurn.classList.contains("turn--orch")).toBe(true);
    expect(pendingTurn.classList.contains("turn--pending")).toBe(true);
    expect(pendingTurn.querySelector(".turn__mark")).not.toBeNull();
    expect(pendingTurn.querySelector(".turn__dots")).not.toBeNull();
    expect(pendingTurn.querySelector(".turn__body")!.textContent).toContain("thinking");

    // The panel's own class never changes to reflect a global loading state.
    expect(aside.className).toBe(asideClassBefore);
    expect(input.disabled).toBe(true);
  });

  test("once the reply arrives, the pending turn is replaced by the real reply — a fresh turn, since the last turn (pending, now removed) leaves the Conductor's turn as the most recent", async () => {
    let refs!: ReturnType<typeof buildComposer>;
    setup(
      (doc) => {
        refs = buildComposer(doc);
      },
      (_url, _opts) => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, reply: "3 gates are on you." }) }),
    );
    const { body, form, input } = refs;

    input.value = "what needs me?";
    form.dispatchEvent({ type: "submit", preventDefault() {} });
    await flush();

    expect(body.querySelectorAll(".turn--pending").length).toBe(0);
    const turns = body.querySelectorAll(".turn");
    expect(turns.length).toBe(2);
    expect(turns[0].classList.contains("turn--user")).toBe(true);
    expect(turns[1].classList.contains("turn--orch")).toBe(true);
    expect(turns[1].querySelector(".turn__body")!.textContent).toBe("3 gates are on you.");
    expect(input.disabled).toBe(false);
  });

  test("an error response also lands as an Orchestrator-marked turn, not a panel-wide failure state", async () => {
    let refs!: ReturnType<typeof buildComposer>;
    setup(
      (doc) => {
        refs = buildComposer(doc);
      },
      (_url, _opts) => Promise.resolve({ ok: false, json: () => Promise.resolve({ ok: false, error: "boom" }) }),
    );
    const { body, form, input } = refs;

    input.value = "hello";
    form.dispatchEvent({ type: "submit", preventDefault() {} });
    await flush();

    const turns = body.querySelectorAll(".turn");
    expect(turns.length).toBe(2);
    expect(turns[1].classList.contains("turn--orch")).toBe(true);
    expect(turns[1].querySelector(".turn__mark")).not.toBeNull();
    expect(turns[1].querySelector(".turn__body")!.textContent).toBe("boom");
  });
});

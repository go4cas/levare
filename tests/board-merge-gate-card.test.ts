// NOTES MERGE-2 — closes NOTES MERGE-1's own named residual: the merge gate's dedicated board card
// (render/shell.ts#mergeGateCardHtml). Two kinds of proof, matching this goal's own two surfaces:
// (1) pure render assertions against a synthetic in-memory Repo (no git, no disk) exercising
// gateCardHtml directly with a `kind: merge` artifact in every state the server can produce; (2) a
// DOM-harness proof (same no-browser-dependency approach as tests/board-client-navigation.test.ts)
// that the card's buttons wire to the real, existing verbs — never a doomed one the server would 409.

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { gateCardHtml } from "../src/board/render/shell.ts";
import type { OpenGate } from "../src/derive.ts";
import type { Repo } from "../src/repo.ts";
import type { Artifact, Project, Team, TypeTemplate, WorkUnit } from "../src/types.ts";

// ---------------------------------------------------------------------------
// synthetic fixture builders (same in-memory-Repo idiom as tests/runner.test.ts#makeRepo — no disk,
// no git; gateCardHtml is a pure function of Repo+OpenGate+now, so nothing else is needed)
// ---------------------------------------------------------------------------

function project(over: Partial<Project> = {}): Project {
  return { name: "acme", repo: "/tmp/acme", remote: null, default_branch: "main", deploy: null, pace: "auto", houseRules: "", ...over };
}
function unitType(): TypeTemplate {
  return { name: "feature", glyph: "&#9656;", expects: ["task", "merge"], gates: ["human"] };
}
function workUnit(): WorkUnit {
  return { type: "feature", status: "active", project: "acme", unit: "widget-1", dir: "/tmp/acme-studio/work/acme/widget-1" };
}
function mergeArtifact(over: Partial<Artifact> = {}): Artifact {
  return {
    kind: "merge",
    id: "merge-widget-1-v1",
    unit: "widget-1",
    project: "acme",
    status: "in-review",
    produced_by: "levare-runner",
    consumes: [],
    supersedes: null,
    approved_by: null,
    created: "2026-07-17T00:00:00.000Z",
    files: [],
    ...over,
  };
}
function makeRepo(opts: { project?: Partial<Project>; artifact?: Partial<Artifact>; teams?: Team[] } = {}): Repo {
  const p = project(opts.project);
  const u = workUnit();
  const t = unitType();
  const art = mergeArtifact(opts.artifact);
  return {
    root: "/tmp/acme-studio",
    teams: new Map((opts.teams ?? []).map((tm) => [tm.name, tm])),
    agents: new Map(),
    types: new Map([[t.name, t]]),
    projects: new Map([[p.name, p]]),
    connectors: new Map(),
    units: [u],
    artifacts: new Map([[`${p.name}/${u.unit}`, new Map([[art.id, art]])]]),
    studio: {},
  };
}
function mergeGate(art: Artifact): OpenGate {
  return { type: "artifact", project: art.project, unit: art.unit, target: art.id, artifact: art, label: "merge" };
}

const NOW = new Date("2026-07-17T02:00:00.000Z"); // 2h after `mergeArtifact`'s default `created`

// ---------------------------------------------------------------------------
// (1) pure render assertions
// ---------------------------------------------------------------------------

describe("merge gate card — clean trial, guardrails pass", () => {
  const repo = makeRepo({
    artifact: {
      merge: {
        branch: "levare/widget-1",
        target: "main",
        commits_ahead: 3,
        diffstat: " src/a.ts | 5 +++--\n src/b.ts | 3 +-\n 2 files changed, 5 insertions(+), 3 deletions(-)",
        conflicted: false,
        conflicts: [],
        guardrail_violations: [],
      },
    },
  });
  const art = [...repo.artifacts.get("acme/widget-1")!.values()][0];
  const html = gateCardHtml(repo, mergeGate(art), NOW);

  test("shows the work branch, commits-ahead count, and a compact diffstat summary", () => {
    expect(html).toContain('<span class="tag">levare/widget-1</span>');
    expect(html).toContain('<span class="tag">3 commits ahead</span>');
    expect(html).toContain('<span class="tag">2 files changed · +5/-3</span>');
  });

  test("shows the CLEAN trial state in the status-positive (is-done) treatment", () => {
    expect(html).toContain('<span class="chip is-done">CLEAN</span>');
    expect(html).not.toContain("CONFLICTED");
  });

  test("guardrails pass renders a quiet note, not a callout", () => {
    expect(html).toContain("guardrails pass");
    expect(html).not.toContain("notice--danger");
    expect(html).not.toContain("notice--warning");
  });

  test("offers Merge (no declared remote) as the primary action, wired to approve — and no recheck-only layout", () => {
    expect(html).toContain('data-verb="approve"');
    expect(html).toContain(">Merge<");
    expect(html).not.toContain('data-verb="recheck"');
    expect(html).not.toContain('data-verb="request"');
    expect(html).not.toContain('data-verb="reject"');
  });

  test("a project declaring a remote gets the honest 'Merge & push' label instead", () => {
    const repoWithRemote = makeRepo({
      project: { remote: "git@example.invalid:acme/storefront.git" },
      artifact: { merge: art.merge },
    });
    const artR = [...repoWithRemote.artifacts.get("acme/widget-1")!.values()][0];
    const htmlR = gateCardHtml(repoWithRemote, mergeGate(artR), NOW);
    expect(htmlR).toContain("Merge &amp; push");
  });

  test("identifies itself as the unit's merge gate and names the unit", () => {
    expect(html).toContain("merge gate");
    expect(html).toContain('<a class="gate__unit" href="/run/acme/widget-1">widget-1</a>');
  });
});

describe("merge gate card — conflicted trial", () => {
  const repo = makeRepo({
    artifact: {
      merge: {
        branch: "levare/widget-1",
        target: "main",
        commits_ahead: 2,
        diffstat: " README.md | 1 +\n 1 file changed, 1 insertion(+)",
        conflicted: true,
        conflicts: ["README.md", "src/config.ts"],
        guardrail_violations: [],
      },
    },
  });
  const art = [...repo.artifacts.get("acme/widget-1")!.values()][0];
  const html = gateCardHtml(repo, mergeGate(art), NOW);

  test("names the conflicting files, mono, and the resolve-by-hand-then-recheck instruction", () => {
    expect(html).toContain('<span class="mono">README.md</span>');
    expect(html).toContain('<span class="mono">src/config.ts</span>');
    expect(html).toContain("Resolve by hand on");
    expect(html).toContain("then re-check");
  });

  test("shows the CONFLICTED trial state in the danger (is-failed) treatment", () => {
    expect(html).toContain('<span class="chip is-failed">CONFLICTED</span>');
  });

  test("offers Re-check as the only action — no approve/merge button (the server would 409)", () => {
    expect(html).toContain('data-verb="recheck"');
    expect(html).toContain(">Re-check<");
    expect(html).not.toContain('data-verb="approve"');
  });
});

describe("merge gate card — clean trial, guardrail violation", () => {
  const repo = makeRepo({
    artifact: {
      merge: {
        branch: "levare/widget-1",
        target: "main",
        commits_ahead: 1,
        diffstat: " infra/deploy.yml | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)",
        conflicted: false,
        conflicts: [],
        guardrail_violations: ["protected_paths: infra/deploy.yml is protected"],
      },
    },
  });
  const art = [...repo.artifacts.get("acme/widget-1")!.values()][0];
  const html = gateCardHtml(repo, mergeGate(art), NOW);

  test("names the violated rule via the UI12 danger callout", () => {
    expect(html).toContain("notice notice--danger");
    expect(html).toContain("protected_paths: infra/deploy.yml is protected");
  });

  test("a clean trial with a guardrail violation still offers no merge button — Re-check instead", () => {
    expect(html).not.toContain('data-verb="approve"');
    expect(html).toContain('data-verb="recheck"');
  });

  test("the trial state itself is still honestly reported as CLEAN (the violation is a separate fact)", () => {
    expect(html).toContain('<span class="chip is-done">CLEAN</span>');
  });
});

describe("merge gate card — cta (run-view) variant carries the same rules", () => {
  test("a conflicted cta card also omits approve and offers recheck", () => {
    const repo = makeRepo({
      artifact: {
        merge: {
          branch: "levare/widget-1",
          target: "main",
          commits_ahead: 1,
          diffstat: "",
          conflicted: true,
          conflicts: ["a.txt"],
          guardrail_violations: [],
        },
      },
    });
    const art = [...repo.artifacts.get("acme/widget-1")!.values()][0];
    const html = gateCardHtml(repo, mergeGate(art), NOW, { cta: true });
    expect(html).toContain("gate--cta");
    expect(html).toContain("Gate &middot; merge review");
    expect(html).toContain('data-verb="recheck"');
    expect(html).not.toContain('data-verb="approve"');
  });
});

describe("merge gate card — dispatching (in-flight) state", () => {
  test("renders the shared quiet pending indicator instead of any verb button", () => {
    const repo = makeRepo({
      artifact: {
        merge: {
          branch: "levare/widget-1",
          target: "main",
          commits_ahead: 1,
          diffstat: "",
          conflicted: false,
          conflicts: [],
          guardrail_violations: [],
        },
      },
    });
    const art = [...repo.artifacts.get("acme/widget-1")!.values()][0];
    const html = gateCardHtml(repo, mergeGate(art), NOW, { dispatching: { member: "levare-runner", kind: "merge" } });
    expect(html).toContain("is-dispatching");
    expect(html).toContain('class="pending"');
    expect(html).not.toContain('data-verb="approve"');
    expect(html).not.toContain('data-verb="recheck"');
  });
});

// ---------------------------------------------------------------------------
// (2) DOM harness — the REAL assets/app.js, loaded verbatim, against a minimal fake DOM (same
// approach as tests/board-client-navigation.test.ts). Proves: the rendered buttons wire to the
// existing verbs (the exact POST url), merge approve gets the same local-pending treatment as
// start/request/retry (never the instant "approved" optimistic line a merge's real EXECUTION could
// still fail after), and a failed execution surfaces its reason via the danger-notice treatment.
// ---------------------------------------------------------------------------

// Full `closest()`/`querySelectorAll()` selector support (tag, `.class`, `#id`, `[attr]`/
// `[attr="value"]`, space-combinator descendant, comma-separated groups) — copied verbatim from
// tests/board-client-navigation.test.ts's own harness, since app.js's merge-gate handling reuses the
// SAME multi-step selectors (`.gate [data-verb]`) that harness exists to support.
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
function matches(el: FakeElement, selector: string): boolean {
  const groups = selector.split(",").map((s) => s.trim().split(/\s+/).map(parseCompound));
  return groups.some((steps) => matchesSteps(el, steps));
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
  private attrs = new Map<string, string>();
  private classSet = new Set<string>();
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
    };
  }
  set className(v: string) {
    this.setAttribute("class", v);
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
  get parentNode(): FakeElement | null {
    return this.parent;
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
    let el: FakeElement | null = this;
    while (el) {
      if (matches(el, selector)) return el;
      el = el.parent;
    }
    return null;
  }
  querySelectorAll(selector: string): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (node: FakeElement) => {
      for (const c of node.children) {
        if (matches(c, selector)) out.push(c);
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

const APP_JS_SOURCE = readFileSync(new URL("../assets/app.js", import.meta.url), "utf8");

function setup(fetchImpl?: (url: string) => Promise<any>) {
  const doc = new FakeDocument();
  const fetchCalls: Array<{ url: string }> = [];
  const context = {
    document: doc,
    window: { matchMedia: undefined, EventSource: undefined },
    location: { reload: () => {} },
    fetch: (url: string) => {
      fetchCalls.push({ url });
      if (fetchImpl) return fetchImpl(url);
      return new Promise(() => {}); // never settles
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

/** Builds the merge card's actual anatomy — `gate gate--merge`, the `.gate__verbs` row with whatever
 * verb button the server-rendered card would carry — mirroring `gateCardHtml`'s real markup shape
 * closely enough to exercise the click handler (the handler only reads classes/attrs/structure, never
 * the specific text content this harness would otherwise have to reproduce byte-for-byte). */
function buildMergeGateCard(doc: FakeDocument, verb: "approve" | "recheck", label: string): FakeElement {
  const article = doc.createElement("article");
  article.setAttribute("class", "gate gate--merge");
  article.setAttribute("data-gate-project", "acme");
  article.setAttribute("data-gate-target", "merge-widget-1-v1");
  doc.body.appendChild(article);

  const verbs = doc.createElement("div");
  verbs.setAttribute("class", "gate__verbs");
  article.appendChild(verbs);

  const btn = doc.createElement("button");
  btn.setAttribute("class", "verb is-primary");
  btn.setAttribute("data-verb", verb);
  btn.textContent = label;
  verbs.appendChild(btn);

  return article;
}

describe("merge gate card — button wiring (DOM harness, real assets/app.js)", () => {
  test("clicking Merge posts approve to the merge artifact's own gate route, with local pending state (never an instant 'approved' line)", () => {
    const { doc, fetchCalls } = setup();
    const card = buildMergeGateCard(doc, "approve", "Merge");
    click(doc, card.querySelector('[data-verb="approve"]')!);

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toBe("/gates/acme/merge-widget-1-v1/approve");

    // Merge execution can still fail after this click resolves server-side — never the instant,
    // always-true "approved" resolved-line every other kind's approve gets (`resolveGate`'s `map`).
    expect(card.classList.contains("is-dispatching")).toBe(true);
    expect(card.querySelector(".pending")).not.toBeNull();
    expect(card.textContent).not.toContain("approved");
  });

  test("clicking Re-check posts recheck to the merge artifact's own gate route, with local pending state", () => {
    const { doc, fetchCalls } = setup();
    const card = buildMergeGateCard(doc, "recheck", "Re-check");
    click(doc, card.querySelector('[data-verb="recheck"]')!);

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toBe("/gates/acme/merge-widget-1-v1/recheck");
    expect(card.classList.contains("is-dispatching")).toBe(true);
    expect(card.querySelector(".pending")).not.toBeNull();
  });

  test("a failed merge EXECUTION (push rejected) surfaces its reason via the danger-notice treatment and offers Re-check again", async () => {
    const { doc } = setup(() =>
      Promise.resolve({
        json: () => Promise.resolve({ ok: false, error: "merge gate 'merge-widget-1-v1' execution FAILED (push): remote rejected" }),
      }),
    );
    const card = buildMergeGateCard(doc, "approve", "Merge");
    click(doc, card.querySelector('[data-verb="approve"]')!);
    // Let the fake fetch's already-resolved promise chain fully settle — a real macrotask boundary
    // (never a fixed number of `Promise.resolve()` ticks, which the actual chain depth would make
    // fragile) drains every pending microtask first.
    await new Promise((r) => setTimeout(r, 0));

    const notice = card.querySelector(".notice--danger");
    expect(notice).not.toBeNull();
    expect(notice!.textContent).toContain("remote rejected");
    // The Conductor isn't left stuck — a fresh Re-check is offered in place of the failed attempt.
    const retryBtn = card.querySelector('[data-verb="recheck"]');
    expect(retryBtn).not.toBeNull();
    expect(card.querySelector('[data-verb="approve"]')).toBeNull();
  });
});

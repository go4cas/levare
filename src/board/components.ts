// NOTES UI6: the board's shared component vocabulary. Every recurring UI pattern the design brief
// describes (levare-design-brief.md) — the card contract, status/pace badges, kind tags, icon links,
// the stat strip, section counters, empty states, local pending feedback, the confirm modal, and the
// shared overlay surface — is built exactly ONCE here and imported everywhere it appears. Before this
// module existed, render.ts's four screen renderers each hand-rolled their own version of "title
// top-left, status top-right, meta along the bottom" (the studio project card, the gate card, the
// registry entity card, the work-unit row all built this shape independently, in four slightly
// different ways); a status colour, a stat's markup, or an empty-state's wording was one string
// literal any of those call sites could drift on. Every primitive here is a pure function — repo/derived
// data in, an HTML string out — same discipline as render.ts itself (PRD §9, invariant 2).
//
// `statusBadge` is the ONLY function anywhere in the product that may emit a `.chip` element — it
// wraps status.ts's canonical `CanonicalStatus` map (the ONE status→colour decision, made once,
// there) into the badge markup. Nothing in render.ts constructs a `.chip` string literal directly;
// see the "no board renderer emits a status class except through the primitive" test in
// tests/board-components.test.ts.

import { esc, captionTime } from "../derive.ts";
import { chipClass, statusLabel, type CanonicalStatus } from "./status.ts";
import type { Turn } from "../conversation.ts";

// ---------------------------------------------------------------------------
// statusBadge — the one and only way a lifecycle-status `.chip` is produced anywhere on the board.
// A thin, verbatim wrapper over status.ts's own `statusChip`-shaped decision (chipClass/statusLabel):
// status.ts owns WHICH of the seven canonical states a domain value maps to and what colour that
// state gets; this module owns the one place that turns that decision into markup.
// ---------------------------------------------------------------------------
export function statusBadge(status: CanonicalStatus, label?: string, extraClass?: string): string {
  const cls = extraClass ? `chip ${chipClass(status)} ${extraClass}` : `chip ${chipClass(status)}`;
  return `<span class="${cls}">${esc(label ?? statusLabel(status))}</span>`;
}

// Pace isn't a lifecycle status (design brief item 6c) — it borrows two of the canonical palette's
// existing hues (never brass, which is gate-exclusive) rather than inventing a third colour.
export function paceBadge(pace: "auto" | "step"): string {
  return pace === "auto" ? statusBadge("active", "auto") : statusBadge("waiting", "step");
}

// ---------------------------------------------------------------------------
// tag / chip — the small bare-word label treatment (registry entity-kind tags today; any future
// non-status kind/type label reuses the same one function rather than a bespoke `<span>`). Distinct
// from statusBadge: a tag never carries lifecycle-state colour, only the neutral `.entity__kind`
// outline treatment.
// ---------------------------------------------------------------------------
export function tag(text: string, cls: string = "entity__kind"): string {
  return `<span class="${cls}">${esc(text)}</span>`;
}
export const chip = tag;

// ---------------------------------------------------------------------------
// kindTag — amendment 1 §1/§3: glyph + word, MANDATORY in every registry card header (the review
// found it missing on skills/agents/teams — amendment §3 F5/F6/F7). Evolves the existing
// `.entity__kind` position/class (still the top-right kind-badge slot every registry card already
// used) to also carry the entity-icon family's glyph, rather than forking a second `.kindtag` class
// alongside it — one card system, per the reconciliation this cluster's goal requires. The glyph is
// monochrome and carries TYPE only (Ruling R1) — never state, never team colour.
// ---------------------------------------------------------------------------
export function kindTag(iconBody: string, label: string): string {
  return `<span class="entity__kind"><svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">${iconBody}</svg>${esc(label)}</span>`;
}

// ---------------------------------------------------------------------------
// iconLink — the project page's destination-recognisable external-link icons (repo/deploy). Vendored
// Tabler-outline paths, monochrome (`stroke="currentColor"`) per the design brief's "the board stays
// monochrome" rule.
// ---------------------------------------------------------------------------
const TABLER_ICON_PATHS = {
  "ti-brand-github": `<path d="M9 19c-4.3 1.4 -4.3 -2.5 -6 -3m12 5v-3.5c0 -1 .1 -1.4 -.5 -2c2.8 -.3 5.5 -1.4 5.5 -6a4.6 4.6 0 0 0 -1.3 -3.2a4.2 4.2 0 0 0 -.1 -3.2s-1.1 -.3 -3.5 1.3a12.3 12.3 0 0 0 -6.2 0c-2.4 -1.6 -3.5 -1.3 -3.5 -1.3a4.2 4.2 0 0 0 -.1 3.2a4.6 4.6 0 0 0 -1.3 3.2c0 4.6 2.7 5.7 5.5 6c-.6 .6 -.6 1.2 -.5 2v3.5" />`,
  "ti-world": `<path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0" /><path d="M3.6 9h16.8" /><path d="M3.6 15h16.8" /><path d="M11.5 3a17 17 0 0 0 0 18" /><path d="M12.5 3a17 17 0 0 1 0 18" />`,
  "ti-alert-triangle": `<path d="M12 9v4" /><path d="M10.36 3.6l-8.1 13.53a1.9 1.9 0 0 0 1.64 2.87h16.2a1.9 1.9 0 0 0 1.64 -2.87l-8.1 -13.53a1.9 1.9 0 0 0 -3.28 0z" /><path d="M12 16h.01" />`,
} as const;
export type IconLinkIcon = keyof typeof TABLER_ICON_PATHS;

export function iconLink(opts: { icon: IconLinkIcon; href: string; label: string }): string {
  return `<a class="iconlink ${opts.icon}" href="${esc(opts.href)}" target="_blank" rel="noopener" aria-label="${esc(opts.label)}" title="${esc(opts.label)}"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TABLER_ICON_PATHS[opts.icon]}</svg></a>`;
}

// ---------------------------------------------------------------------------
// callout — NOTES UI12: the ONE way a note/warning/danger message block is produced anywhere on the
// board (see tests/board-ui12.test.ts's "no board renderer emits a callout-shaped block except
// through the primitive"). Closes the gap NOTES UI11/C13 found: the design brief previously banned
// general-purpose amber outright, so the C13 connector note (`noticeWarning`, this function's
// predecessor) had a tinted panel but no colour — "structure without colour". The brief's amended
// message-severity scale (levare-design-brief.md) now gives each of the three levels its own token:
// NOTE stays neutral ink, WARNING gets its own muted amber (`--warning`, distinct from gate brass —
// the two ambers must never be interchangeable), DANGER reuses the status palette's own `--danger`
// red (an intentional, brief-documented exception — "bad" is one meaning whether it's an entity's
// state or a message's severity). Body text stays ink in all three: the panel tint/border/icon alone
// carries severity, never the prose.
// ---------------------------------------------------------------------------
export type CalloutSeverity = "note" | "warning" | "danger";

const CALLOUT_ICON_PATHS: Record<CalloutSeverity, string> = {
  note: `<path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0" /><path d="M12 9h.01" /><path d="M11 12h1v4h1" />`,
  warning: TABLER_ICON_PATHS["ti-alert-triangle"],
  danger: `<path d="M12 9v4" /><path d="M12 16h.01" /><path d="M8.7 3h6.6c.3 0 .5 .1 .7 .3l4.7 4.7c.2 .2 .3 .4 .3 .7v6.6c0 .3 -.1 .5 -.3 .7l-4.7 4.7c-.2 .2 -.4 .3 -.7 .3h-6.6c-.3 0 -.5 -.1 -.7 -.3l-4.7 -4.7c-.2 -.2 -.3 -.4 -.3 -.7v-6.6c0 -.3 .1 -.5 .3 -.7l4.7 -4.7c.2 -.2 .4 -.3 .7 -.3z" />`,
};

function calloutIcon(severity: CalloutSeverity): string {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${CALLOUT_ICON_PATHS[severity]}</svg>`;
}

export function callout(severity: CalloutSeverity, bodyHtml: string): string {
  return `<div class="notice notice--${severity}">${calloutIcon(severity)}<span class="notice__text">${bodyHtml}</span></div>`;
}

// ---------------------------------------------------------------------------
// statStrip — the metric row shared by the Studio and Project pages. Both screens pass their own
// stats through the same function, so the grid, the number treatment, and the label treatment can
// never independently drift (studio's own history has already drifted once: NOTES UI1 found "active"
// rendering blue on the run view and grey on the studio card because two renderers hand-picked their
// own colour — this is the same class of bug, one level up, for the surrounding stat chrome).
// ---------------------------------------------------------------------------
export interface Stat {
  value: string;
  label: string;
  cls?: string;
  attr?: { name: string; value: string | number };
  /** Foundation stat-band rule (amendment 1 consistency audit F13): a stat tints ONLY when
   * actionable, and "actionable" means gate-brass specifically — never a general-purpose amber.
   * Tints the whole cell (background + number), never just the number alone. */
  actionable?: boolean;
}
export function statStrip(stats: Stat[]): string {
  const items = stats
    .map((s) => {
      const cellCls = s.actionable ? " stat--actionable" : "";
      const clsAttr = s.cls ? ` ${s.cls}` : "";
      const dataAttr = s.attr ? ` ${esc(s.attr.name)}="${esc(String(s.attr.value))}"` : "";
      return `<div class="stat${cellCls}"><div class="n${clsAttr}"${dataAttr}>${s.value}</div><div class="l">${s.label}</div></div>`;
    })
    .join("");
  return `<div class="statstrip" style="grid-template-columns:repeat(${stats.length},1fr)">${items}</div>`;
}

// ---------------------------------------------------------------------------
// counter — the section-count treatment (Needs You / Running now / In flight headings; the registry
// rail's per-kind counts). Item 5a's ruling ("plain neutral, not gate brass — brass stays scoped to
// the gate cards themselves") applies uniformly regardless of which of the two call sites uses it;
// `variant` only picks the pre-existing CSS vocabulary each context already carries (`.sec__count`
// beside a section heading, `.ct` inside a nav row), never the colour.
// ---------------------------------------------------------------------------
export function counter(n: number, opts: { variant?: "section" | "nav"; gatecount?: boolean } = {}): string {
  if (opts.variant === "nav") return `<span class="ct">${n}</span>`;
  const attr = opts.gatecount ? ` data-gatecount="${n}"` : "";
  return `<span class="sec__count"${attr}>${n}</span>`;
}

// ---------------------------------------------------------------------------
// emptyState — the signposting treatment for a section with no content. `action`, when given, is a
// quiet next-step hint on the same line as the message, never a second competing sentence of its own
// styling. Deliberately NOT used for the studio rail's ideas list (design brief: "no counts, no
// urgency styling" — the ideas list is a backlog, not a to-do, and must stay the most understated
// element on the page, not gain the same treatment as an actionable empty section).
// ---------------------------------------------------------------------------
export function emptyState(opts: { message: string; action?: string }): string {
  const actionHtml = opts.action ? ` <span class="empty__action">${esc(opts.action)}</span>` : "";
  return `<p class="empty">${esc(opts.message)}${actionHtml}</p>`;
}

// ---------------------------------------------------------------------------
// pendingState — LOCAL, in-place action feedback. Hard constraint (the goal's one intended behaviour
// change): a pending/loading state appears on the element that triggered it and never replaces more
// of the screen than necessary. Before this existed, `assets/app.js#markDispatching` replaced an
// entire gate card's `innerHTML` the instant a Start/Request-changes/Retry verb was clicked — title,
// producer, and context all vanished behind a bare loading line until the next SSE-driven reload. The
// server-rendered dispatching state (this function, called from `gateCardHtml`'s `dispatchingHtml`)
// was already local — it only ever swapped the verbs row and the badge text, leaving the rest of the
// card in place; `assets/app.js` now mirrors that exact shape (see `markDispatching`) instead of
// wiping the card, so the immediate client-side feedback and the eventual server-rendered state read
// identically.
// ---------------------------------------------------------------------------
export function pendingState(opts: { label: string }): string {
  return `<span class="pending"><span class="turn--pending"><span class="turn__dots"><span></span><span></span><span></span></span></span><span class="pending__label">${esc(opts.label)}</span></span>`;
}

// ---------------------------------------------------------------------------
// orchTurn / orchMark — the Orchestrator conversation's one message-group primitive (NOTES UI8,
// evolved by Phase 2 cluster 4 item 3: role rows, not bubble colour). The Orchestrator's speech is
// still marked ONCE per unbroken run of its own messages by `orchMark()` — the same podium glyph the
// app header and panel head already use, and per the design brief its one remaining piece of brand
// colour ("the Orchestrator wears the brand accent — the identity and the agent speak in one voice").
// Speaker identity itself, though, now reads from a ROLE ROW (`turnRow`) — name, kind tag, timestamp —
// at the top of the turn, not from a coloured bubble: `.turn__body` (the message surface) is a neutral
// fill for BOTH speakers (see assets/styles.css), so a right-aligned Conductor bubble can never again
// be mistaken for a status/accent colour doing double duty. The Conductor's own messages never call
// `orchTurn`; they render via the client-side `turn--user` path (composer-submitted, never
// server-rendered) mirrored by `userTurn` below.
// ---------------------------------------------------------------------------
export function orchMark(): string {
  return `<span class="turn__mark" aria-hidden="true"><i></i><b></b></span>`;
}

// ---------------------------------------------------------------------------
// turnCaption — NOTES UI11: every turn (either speaker) carries a quiet timestamp, not just the
// opening briefing. `label` (e.g. "briefing") stays reserved for the one genuinely distinct opening
// message — Phase 2 cluster 4: it now doubles as the role row's kind tag, sitting beside the speaker's
// name rather than prefixing the timestamp on its own line. The relative text ("now"/"2m"/"1h") is the
// only thing shown; the full ISO stamp lives in the `title` attribute (a hover, never a second line).
// assets/app.js#buildCaption renders the identical markup client-side for turns appended after the
// page loaded, so a server-rendered and a client-appended caption are indistinguishable.
// ---------------------------------------------------------------------------
export function turnCaption(time: { text: string; title: string }, label?: string): string {
  const prefix = label ? `${esc(label)} &middot; ` : "";
  return `<div class="turn__caption mono">${prefix}<span class="turn__time" title="${esc(time.title)}">${esc(time.text)}</span></div>`;
}

// ---------------------------------------------------------------------------
// turnRow — Phase 2 cluster 4 item 3: the one role-row anatomy shared by orchTurn and userTurn (name +
// kind tag + mono timestamp). This is now the ONLY speaker signal besides the Orchestrator's own mark
// — the message surface below it carries no speaker-specific colour at all.
// ---------------------------------------------------------------------------
function turnRow(name: string, time?: { text: string; title: string }, label?: string): string {
  const captionHtml = time ? turnCaption(time, label) : "";
  return `<div class="turn__row"><span class="turn__name">${esc(name)}</span>${captionHtml}</div>`;
}

export function orchTurn(bodyHtml: string, opts: { captionTime?: { text: string; title: string }; captionLabel?: string } = {}): string {
  const rowHtml = turnRow("Orchestrator", opts.captionTime, opts.captionLabel);
  return `<div class="turn turn--orch">${orchMark()}<div class="turn__content">${rowHtml}${bodyHtml}</div></div>`;
}

// The Conductor's own turn, server-rendered — mirrors `orchTurn` minus the mark (the mark is the
// Orchestrator's speaker signal only) and matches assets/app.js#appendTurnMessage's `turn--user`
// markup byte-for-byte, so a persisted, server-rendered turn and a live, client-appended one are
// indistinguishable (NOTES V11-CONV item 4 — the panel must never look like it's showing two
// different things depending on whether a message survived a reload).
export function userTurn(bodyHtml: string, opts: { captionTime?: { text: string; title: string } } = {}): string {
  const rowHtml = turnRow("You", opts.captionTime);
  return `<div class="turn turn--user"><div class="turn__content">${rowHtml}${bodyHtml}</div></div>`;
}

// ---------------------------------------------------------------------------
// renderPersistedTurns (NOTES V11-CONV) — the ONE place a `conversation.ts#Turn[]` (parsed off disk)
// becomes HTML, shared by every screen's `orchestratorPanel` call so a persisted turn's markup can
// never drift from a live-appended one. `now` comes from the render call, never `new Date()` here —
// every screen already threads its own `now` through for this exact reason (PRD §9, invariant 2:
// re-derived per request, not read from a clock this function owns).
// ---------------------------------------------------------------------------
export function renderPersistedTurns(turns: Turn[], now: Date): string {
  return turns
    .map((t) => {
      const bodyHtml = `<p class="turn__body">${esc(t.text)}</p>`;
      const time = captionTime(t.at, now);
      return t.speaker === "orchestrator" ? orchTurn(bodyHtml, { captionTime: time }) : userTurn(bodyHtml, { captionTime: time });
    })
    .join("");
}

// ---------------------------------------------------------------------------
// card — the canonical card contract (design brief: title top-left, status badge top-right,
// supporting tags/meta along the bottom). Used by the studio project card, the registry entity card,
// and the project page's work-unit row. Every surface keeps its own CSS class family (`.pcard`,
// `.entity`, `.unit` each carry their own historical vocabulary, same reasoning status.ts documents
// for `.chip`/`.dot`/`.snode`: the SPELLING varies by surface, the STRUCTURAL DECISION — where the
// title sits, where the status/tag sits, where the supporting content sits — is made exactly once,
// here. `pre` is content that sits before the title inside the top row (a type glyph, a marker); when
// `bodyWrapCls` is given, the title (plus `titleExtra`) is wrapped together in its own div ahead of
// `status` — the gate card's anatomy, where a name-row/context/consumes/meta block sits inside
// `.gate__body`, itself a sibling of the badge — otherwise title and status sit directly in the top row.
// ---------------------------------------------------------------------------
export interface CardOpts {
  as?: "a" | "div" | "article";
  cls: string;
  href?: string;
  attrs?: Record<string, string>;
  topCls: string;
  pre?: string;
  bodyWrapCls?: string;
  title: string;
  titleCls?: string;
  titleExtra?: string;
  status?: string;
  tags?: string;
  body?: string;
  meta?: string;
}
export function card(opts: CardOpts): string {
  const tagName = opts.as ?? "div";
  const hrefAttr = opts.href !== undefined ? ` href="${esc(opts.href)}"` : "";
  const attrStr = opts.attrs
    ? Object.entries(opts.attrs)
        .map(([k, v]) => ` ${k}="${esc(v)}"`)
        .join("")
    : "";
  const titleHtml = opts.titleCls ? `<span class="${opts.titleCls}">${opts.title}</span>` : opts.title;
  const titleBlock = opts.bodyWrapCls ? `<div class="${opts.bodyWrapCls}">${titleHtml}${opts.titleExtra ?? ""}</div>` : titleHtml;
  const top = `<div class="${opts.topCls}">${opts.pre ?? ""}${titleBlock}${opts.status ?? ""}</div>`;
  return `<${tagName} class="${opts.cls}"${hrefAttr}${attrStr}>${top}${opts.tags ?? ""}${opts.body ?? ""}${opts.meta ?? ""}</${tagName}>`;
}

// ---------------------------------------------------------------------------
// confirmModal / editorOverlay — the shared overlay surfaces, moved here verbatim from render.ts
// (built in UI3/UI4) so any future confirmation or overlay reuses these rather than re-implementing
// the "centered panel over a dimmed backdrop, hidden by default, a sibling of `.app`" shape a third
// time. Each is ONE instance per page; app.js's `confirmModal()`/overlay block target these by id.
// ---------------------------------------------------------------------------
export function confirmModal(): string {
  return `<div class="confirm-modal" id="confirm-modal" hidden>
    <div class="confirm-modal__backdrop" data-confirm-backdrop></div>
    <div class="confirm-modal__panel" role="alertdialog" aria-modal="true" aria-labelledby="confirm-modal-question">
      <p class="confirm-modal__question" id="confirm-modal-question"></p>
      <div class="confirm-modal__actions">
        <button class="togglebtn" data-confirm-keep>Keep editing</button>
        <button class="togglebtn is-danger" data-confirm-discard>Discard</button>
      </div>
    </div>
  </div>`;
}

// Phase 2 cluster 4 item 4: the raw-markdown editor gets labeled ZONES (frontmatter/body — the
// design brief's own frontmatter/body split and mono-means-truth) instead of one undifferentiated
// textarea, a statusBadge-consistent validity indicator, structured "line · key · expectation" error
// rows, and a header dirty marker. `assets/app.js#bindEditorOverlay` owns the split/join between this
// markup and the single raw string the check/save routes actually read and write — reconciled, not
// rewritten: the fetch calls, debounce, and save route are untouched (see that file's own comment).
export function editorOverlay(): string {
  return `<div class="editor-overlay" id="editor-overlay" hidden>
    <div class="editor-overlay__backdrop" data-editor-backdrop></div>
    <div class="editor-overlay__panel" role="dialog" aria-modal="true" aria-labelledby="editor-overlay-title">
      <header class="editor-overlay__head">
        <h2 class="editor-overlay__title" id="editor-overlay-title"></h2>
        <span class="editor-overlay__kind mono"></span>
        <span class="editor-overlay__dirty" data-editor-dirty hidden>unsaved</span>
      </header>
      <div class="editor-overlay__zones">
        <div class="editor-overlay__zone editor-overlay__zone--front">
          <div class="editor-overlay__zone-label mono">frontmatter <span class="editor-overlay__zone-hint">yaml</span></div>
          <textarea class="editor-overlay__textarea editor-overlay__textarea--front" spellcheck="false"></textarea>
        </div>
        <div class="editor-overlay__zone editor-overlay__zone--body">
          <div class="editor-overlay__zone-label mono">body <span class="editor-overlay__zone-hint">markdown</span></div>
          <textarea class="editor-overlay__textarea editor-overlay__textarea--body" spellcheck="false"></textarea>
        </div>
      </div>
      <div class="editor-overlay__foot">
        <div class="editor-overlay__status">
          <span class="validity"><span class="chip is-waiting">checking&hellip;</span></span>
          <div class="editor-overlay__errors"></div>
        </div>
        <div class="editor-overlay__actions">
          <button class="togglebtn" data-editor-cancel>Cancel</button>
          <button class="togglebtn is-primary" data-editor-save disabled>Save and commit</button>
        </div>
      </div>
    </div>
  </div>`;
}

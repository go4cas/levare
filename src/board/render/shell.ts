// The shell/page-frame pieces shared by every screen (render/studio.ts, render/project.ts,
// render/run.ts, render/artifact.ts, render/idea.ts, render/registry.ts): the `<html>` shell and app
// header, the client-nav page-body wrapper, the Orchestrator panel, the persistent rail, the gate
// card, and the small cross-screen helpers (avatars, kind badges, artifact/token links). Split out of
// the former monolithic render.ts (NOTES REV4) — pure functions throughout: repo data in, an HTML
// string out, no client state, re-derived on every request (PRD §9, invariant 2). Structure and CSS
// class names are bound to assets/styles.css (shipped verbatim, never touched here); only the data
// inside each element changes.

import type { Repo } from "../../repo.ts";
import type { Artifact } from "../../types.ts";
import { firstParagraph } from "../../repo.ts";
import { esc, costLabel, ageLabel, projectLastActivity, type OpenGate } from "../../derive.ts";
import type { RegistryExtras } from "../../extra.ts";
import { diagnose } from "../../doctor.ts";
import type { DaemonInvocation } from "../../daemon.ts";
import { resolveOrchestratorStatus, type OrchestratorStatus } from "../../orchestrator-status.ts";
import { getVersionInfo } from "../../version.ts";
import { statusLabel } from "../status.ts";
import { statusBadge, counter, pendingState, card, confirmModal, toastViewport, orchTurn, renderPersistedTurns, tag, callout } from "../components.ts";
import { loadConversationTail } from "../../conversation.ts";
import { deriveTeamStyle } from "../team-color.ts";
import { registryKindIconBody } from "./entity-icons.ts";

// levare's own release version (item 3: "the release version as a quiet muted mono chip" beside the
// wordmark) — never from a project's data (that's the `pace`/`deploy`/release vocabulary, a
// different concept entirely). `getVersionInfo` reads the version via a static JSON import rather
// than a resolved-path `readFileSync`, so it stays correct under `bun build --compile` too
// (NOTES DIST1) — a resolved-path read breaks there, because `import.meta.url` inside a compiled
// binary points into Bun's virtual `$bunfs`, not the real filesystem.
const LEVARE_VERSION: string = getVersionInfo().version;

const ASSETS = `<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet"/>
<link rel="stylesheet" href="/styles.css?v=11"/>`;

// ---------------------------------------------------------------------------
// The app header (item 3, gate-review round UI1) — new, top-level, spans the full width above the
// nav and content, on every screen and at every viewport (it replaces the old mobile-only
// `.mobilebar`, which duplicated the logo/orchestrator-indicator/theme-toggle only below 1080px).
// Left cluster: mark, wordmark, levare's own release version as a quiet muted mono chip. Right
// cluster: the Orchestrator status dot+text (a stable "is it configured?" fact — never the panel's
// own per-message pending state), a hairline divider, the theme toggle. The rail-open hamburger lives
// here too (CSS hides it above 1080px, same breakpoint the old mobilebar used).
// ---------------------------------------------------------------------------

function appHeader(status: OrchestratorStatus, railToggleLabel: string): string {
  return `<header class="apphead">
  <button class="togglebtn apphead__railtoggle" data-rail-toggle aria-label="${esc(railToggleLabel)}">&#9776;</button>
  <a class="logo" href="/studio"><span class="logo__mark"><i></i><b></b></span><span class="logo__word">levare</span></a>
  <span class="apphead__ver mono">v${esc(LEVARE_VERSION)}</span>
  <span class="sp"></span>
  ${orchestratorIndicator(status)}
  <span class="apphead__divider" aria-hidden="true"></span>
  <button class="themebtn" data-theme-toggle></button>
</header>`;
}

export function shell(title: string, railToggleLabel: string, body: string, status: OrchestratorStatus): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(title)}</title>
${ASSETS}
</head>
<body>
${appHeader(status, railToggleLabel)}
${body}
${confirmModal()}
${toastViewport()}
<script src="/app.js?v=9"></script>
</body>
</html>
`;
}

// UI10: client-side navigation swaps the CONTENT COLUMN in place instead of a full page load — the
// rail and Orchestrator panel persist untouched (never re-rendered client-side; see NOTES). To do
// that without forking rendering logic into the client, the swappable regions are marked with plain
// HTML comments (`<!--main-->`/`<!--extras-->`) around the exact same strings every screen already
// produces — `board/serve.ts#extractFragment` slices the SAME rendered HTML a cold GET would return,
// never a second render path. `main` stays a direct grid child of `.app` (between rail and orch, so
// the 3-column grid layout is untouched); `extras` (per-page templates/the registry editor overlay —
// content with no state worth preserving across a navigation, unlike the Orchestrator's conversation)
// moves into a stable `[data-extras-host]` sibling so the client has one fixed element to swap into,
// instead of guessing where a page's extras begin/end in the live DOM.
export function pageBody(rail: string, main: string, orch: string, extras: string = ""): string {
  return `<div class="app">${rail}<!--main-->${main}<!--/main-->${orch}</div><div data-extras-host><!--extras-->${extras}<!--/extras--></div>`;
}

function orchHead(scope: string): string {
  return `<header class="orch__head"><span class="orch__mark"><i></i><b></b></span><span class="orch__title">Orchestrator</span><span class="orch__scope">${esc(scope)} scope</span></header>`;
}

function composer(opts: { disabled?: boolean } = {}): string {
  if (opts.disabled) {
    return `<div class="composer is-disabled"><form data-orchestrator-form aria-disabled="true"><input type="text" placeholder="Orchestrator unavailable" aria-label="Message the Orchestrator" disabled/><span class="ret">&#8629;</span></form></div>`;
  }
  return `<div class="composer"><form data-orchestrator-form><input type="text" placeholder="Message the Orchestrator" aria-label="Message the Orchestrator"/><span class="ret">&#8629;</span></form></div>`;
}

// ---------------------------------------------------------------------------
// Orchestrator status — a whole-studio state, distinct from per-connector health (design brief §3:
// "the rail answers 'is this connector configured?', the header answers 'what kind of studio am I
// looking at?'"). `orchestratorIndicator` is the ONE clickable badge for this fact — it now lives
// exclusively in the top-level app header (item 3/4a: the rail's old Orchestrator section is gone),
// so exactly one copy is ever rendered per page, at every viewport width. Phase 2 cluster 4 item 1:
// the trigger is now the shared `statusBadge()` primitive — the same `.chip` every other lifecycle
// state on the board renders through — rather than a hand-rolled dot+text pair; "on" maps to `done`
// (the same green a healthy connector's dot already used), "off" to `waiting` (solid neutral gray,
// never red — this is a configuration state, never a failure, and it never changes mid-response: a
// live SDK call's own "thinking" state is the Orchestrator panel's concern, not the header's).
// ---------------------------------------------------------------------------

// The API-key-reason copy bug (Phase 2 cluster 3 review): `status.reason` (orchestrator-status.ts)
// is a bare clause with no guaranteed trailing punctuation ("ANTHROPIC_API_KEY is not set") — every
// call site that follows it with more prose was concatenating straight onto that bare clause,
// producing a run-on ("...is not set The board..."). One place closes the sentence, wherever
// `status.reason` renders followed by anything else.
function reasonSentence(reason: string): string {
  const trimmed = reason.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function orchestratorIndicator(status: OrchestratorStatus): string {
  const badge = status.available
    ? statusBadge("done", "orchestrator: on")
    : statusBadge("waiting", "orchestrator: off");
  return `<details class="orchind">
    <summary class="orchind__sum">${badge}</summary>
    <div class="orchind__pop" role="group" aria-label="Orchestrator status">
      <div class="orchind__pop-head">
        <span class="orchind__pop-title">Orchestrator</span>
        <button type="button" class="orchind__pop-close" data-orchind-close aria-label="Close">&times;</button>
      </div>
      <div class="orchind__pop-body">
        <p>${esc(reasonSentence(status.reason))}</p>
        <div class="orchind__pop-row"><span class="orchind__pop-k">env var</span><span class="chip-dashed mono">${esc(status.envVar)}</span></div>
      </div>
      <div class="orchind__pop-foot">
        <p>The board, the registry, and every gate are unaffected — approvals, rejections, and the runner all keep working either way.</p>
      </div>
    </div>
  </details>`;
}

// NOTES C11 part 2: hiding the panel when the Orchestrator is unavailable would teach the operator
// nothing; showing it disabled tells the truth about the system's shape. `briefingHtml` (narrated
// prose — a briefing message, a summary) is suppressed when disabled, since it implies a live
// conversation that isn't happening. `actionableHtml` (gate cards — the run view's only rendering of
// its unit's open gate) is NOT suppressed: a gate card's verbs POST straight to the board's write
// routes with no LLM involved, so "you can approve, reject, and the runner will advance" — the
// disabled note's own promise — has to stay true regardless of the Orchestrator's state.
// NOTES V11-CONV: `scope` is now the REAL persistence scope ("studio", or a project's own name) —
// previously just the page-type literal ("project"/"run"/"artifact"...), which was never actually
// scope-aware. It doubles as the conversation file's key (conversation.ts#loadConversationTail) and
// as the `data-scope` attribute below, which `board/serve.ts#extractFragment` reads back out of the
// rendered HTML so a client-side navigation can tell whether the panel needs a fresh tail (see
// assets/app.js's own comment on that path — `swapFragment` never touches the rail/header, but DOES
// resync just the persisted-tail region when the destination page's scope differs from the current
// one). `root`/`now` load and timestamp that tail exactly like every other per-request derivation in
// this module (PRD §9, invariant 2) — never a second render path, never a stored, cached history.
export function orchestratorPanel(scope: string, status: OrchestratorStatus, briefingHtml: string, actionableHtml: string, root: string, now: Date): string {
  const tailHtml = renderPersistedTurns(loadConversationTail(root, scope, now), now);
  // The HTML comment markers mirror `pageBody`'s own `<!--main-->`/`<!--extras-->` convention exactly
  // (inert everywhere else, invisible in the rendered page, never reachable from escaped user content
  // — `esc()` turns any literal `<`/`>` inside a turn's text to `&lt;`/`&gt;`) so `extractFragment` can
  // slice this region back out the same string-slicing way, with no HTML parser, no second render call.
  const tailBlock = `<div class="orch__tail" data-orch-tail><!--orchtail-->${tailHtml}<!--/orchtail--></div>`;
  if (!status.available) {
    return `<aside class="orch is-disabled" data-scope="${esc(scope)}">
    ${orchHead(scope)}
    <div class="orch__body">
      ${orchTurn(`<p class="turn__body">Orchestrator unavailable — ${esc(reasonSentence(status.reason))} The board, the registry, and every gate still work: you can approve, reject, and the runner will advance.</p>`)}
      ${tailBlock}
      ${actionableHtml}
    </div>
    ${composer({ disabled: true })}
  </aside>`;
  }
  return `<aside class="orch" data-scope="${esc(scope)}">
    ${orchHead(scope)}
    <div class="orch__body">${briefingHtml}${tailBlock}${actionableHtml}</div>
    ${composer()}
  </aside>`;
}

// Phase 2 cluster 1 (avatar correctness fix): a team's raw declared hex has no contrast floor — the
// illegibility the base brief flags ("low-saturation team hues make tinted avatar discs illegible").
// `deriveTeamStyle` (team-color.ts, ported from dev/foundation/team-color.js) is the ONE place that
// correction happens: it corrects lightness/chroma into a legible band, keeps a minimum perceptual
// distance from the Podium accent and gate brass so a declared hue can't impersonate a system colour,
// and picks whichever of white/ink actually clears the WCAG floor against the corrected hue — instead
// of every avatar hard-coding white text (`.avatar{color:#fff}`) regardless of how light the team's
// hue is. No declared colour (an unassigned member, the Runner's own callers) keeps the previous
// neutral grey/white pairing unchanged, since there is no team hue to correct.
function teamAvatarStyle(color: string | undefined): string {
  if (!color || !color.trim()) return "background:#666;color:#fff";
  const { hue, avatarText } = deriveTeamStyle(color);
  return `background:${hue};color:${avatarText}`;
}

export function avatar(initials: string, color: string | undefined, opts: { size?: "sm" | "lg"; blink?: boolean; title?: string } = {}): string {
  const size = opts.size ?? "sm";
  const blinkCls = opts.blink ? " blink" : "";
  const titleAttr = opts.title ? ` title="${esc(opts.title)}"` : "";
  return `<span class="avatar ${size}${blinkCls}"${titleAttr} style="${teamAvatarStyle(color)}">${esc(initials.toLowerCase())}</span>`;
}

export function memberAvatar(repo: Repo, producedBy: string, opts: { size?: "sm" | "lg"; blink?: boolean } = {}): string {
  const [teamName, memberName] = producedBy.split("/");
  if (memberName === undefined) return `<span class="avatar avatar--conductor sm">C</span>`;
  const agent = repo.agents.get(memberName);
  const team = repo.teams.get(teamName);
  const initials = agent?.style.avatar || memberName.slice(0, 2);
  return avatar(initials, team?.style.color, opts);
}

// RULE B: an agent's kind (native/cli/remote) is distinguished by badge TREATMENT — filled, outlined,
// dashed-outlined — never by colour; `.kindbadge--*` (assets/styles.css) only ever draws from the
// neutral ink scale (--fg/--fg-dim/--fg-mute/--border-strong), none of which is a status-palette hue.
export function agentKindBadge(kind: "native" | "cli" | "remote"): string {
  return `<span class="kindbadge kindbadge--${kind}">${esc(kind)}</span>`;
}

// NOTES UI11: a connector's kind (cli/mcp) gets the identical shape-treatment badge system as an
// agent's kind — filled vs. outlined, never colour (RULE B, same reasoning as agentKindBadge above).
export function connectorKindBadge(kind: "cli" | "mcp"): string {
  return `<span class="kindbadge kindbadge--${kind}">${esc(kind)}</span>`;
}

export function artifactFileName(art: Artifact): string {
  return `${art.id}.md`;
}

export function tokenLink(project: string, unit: string, text: string): string {
  return `<a class="tok link mono" href="/run/${esc(project)}/${esc(unit)}">${esc(text)}</a>`;
}

// UI2 item 1: every gate card names the work unit it concerns, top-left, per the card contract (title
// top-left, status top-right — UI1). The artifact-based gate cards (the common case in the Needs You
// inbox) used to lead with the ARTIFACT's name only, never the unit's — so a Conductor scanning the
// inbox couldn't tell which unit a gate belonged to without opening it. Work units have no separate
// `title` field (§types.ts); the unit slug IS the unit's name everywhere else in the product (the
// project page's `.unit__name`), so it's what renders here too.
function gateUnitTitle(project: string, unit: string): string {
  return `<div class="gate__unit-row"><a class="gate__unit" href="/run/${esc(project)}/${esc(unit)}">${esc(unit)}</a></div>`;
}

// Every artifact id is a mono token and every mono token is a link (design brief §"mono typeface
// means filesystem truth") — routed to the artifact render view (item 1), never the unit/run view
// it used to fall back to.
export function artifactHref(project: string, unit: string, id: string): string {
  return `/artifact/${esc(project)}/${esc(unit)}/${esc(id)}`;
}
export function artifactTokenLink(project: string, unit: string, id: string, text: string): string {
  return `<a class="tok link mono" href="${artifactHref(project, unit, id)}">${esc(text)}</a>`;
}
function ideaHref(name: string): string {
  return `/idea/${esc(name)}`;
}

// ---------------------------------------------------------------------------
// The rail (item 4, gate-review round UI1) — ONE thing, persistent navigation, byte-for-byte
// identical in structure on every screen: Projects, Registry, Connectors, Ideas (the Conductor-
// approved nav-index). Nothing screen-specific (a project's pointer, a unit's score, the registry's
// own entity switcher) lives here — that content lives in each screen's own content column. Three
// things that used to live here moved out for good: the levare mark + wordmark and the theme toggle
// (both now in the top-level app header, item 3), and the Orchestrator section (its status is now a
// header-level fact, item 4a — a whole-studio state doesn't belong beside per-connector rows). The
// "derived from ... on every request" footer line is gone too (item 4c) — nothing here re-derives
// that provenance text per screen anymore. Connector rows no longer print their health as text (item
// 4b — "ok"/"missing-env" is gone; the dot alone still carries the signal, the same vocabulary the
// header's Orchestrator indicator uses) and are themselves navigable, same as a Registry link. Only
// the registry sub-nav's `is-active` highlight varies by scope now (ordinary "you are here"
// wayfinding within a static list, not a change to what the list contains).
// ---------------------------------------------------------------------------

export const REGISTRY_KINDS = ["teams", "agents", "skills", "knowledge", "types", "connectors", "evals"] as const;
export type RegistryKind = (typeof REGISTRY_KINDS)[number];

export function registryKindCount(repo: Repo, extras: RegistryExtras, k: RegistryKind): number {
  return k === "teams" ? repo.teams.size
    : k === "agents" ? repo.agents.size
    : k === "types" ? repo.types.size
    : k === "connectors" ? repo.connectors.size
    : k === "skills" ? extras.skills.length
    : k === "knowledge" ? extras.knowledge.length
    : extras.evals.length;
}

/** The registry entity-kind link list, rendered once: in the rail's Registry section — the only
 * place it appears now that UI5 removed the redundant in-page tab strip (every registry kind is
 * already reachable from the rail, count included).
 * UI4 item 4: paths, not query params — `/registry/<kind>`, matching `/project/<name>` and
 * `/idea/<name>` elsewhere in the product. A plain `<a href>`, no client-side interception: switching
 * kinds is a real navigation (a fresh server render, PRD invariant 2), which is also what makes
 * browser back/forward behave correctly across registry navigation for free. */
function registryNavLinks(repo: Repo, extras: RegistryExtras, active?: RegistryKind): string {
  return REGISTRY_KINDS.map((k) => {
    const activeCls = active === k ? " is-active" : "";
    return `<a href="/registry/${k}" data-goto="${k}" class="${activeCls.trim()}">${k} ${counter(registryKindCount(repo, extras, k), { variant: "nav" })}</a>`;
  }).join("\n");
}

// NOTES UI11 (long lists, item 1): a nav section over this many rows collapses to the most recent
// entries plus a muted "+ N more" reveal — client-side, in place, no new route (assets/app.js). At
// this count or fewer, a section renders exactly as before: no wrapper, no button, byte-identical to
// the pre-UI11 markup (see the rail-byte-identical-across-screens test).
const RAIL_LONGLIST_CAP = 7;

function railLongList(rows: string[]): string {
  if (rows.length <= RAIL_LONGLIST_CAP) return rows.join("\n");
  const visible = rows.slice(0, RAIL_LONGLIST_CAP).join("\n");
  const overflow = rows.slice(RAIL_LONGLIST_CAP).join("\n");
  const more = rows.length - RAIL_LONGLIST_CAP;
  return `${visible}<div class="railsec__overflow" hidden>${overflow}</div><button type="button" class="railsec__more" data-rail-expand>+ ${more} more</button>`;
}

export function railNav(repo: Repo, extras: RegistryExtras, opts: { activeRegistryEntity?: RegistryKind } = {}): string {
  // NOTES UI11: ordered by real recency (the newest artifact `created` anywhere in the project),
  // most recently active first — never filesystem mtime (see `projectLastActivity`'s own doc comment).
  const projectRows = [...repo.projects.values()]
    .sort((a, b) => projectLastActivity(repo, b.name).localeCompare(projectLastActivity(repo, a.name)))
    .map((p) => {
      const units = repo.units.filter((u) => u.project === p.name).length;
      return `<a class="rel" href="/project/${esc(p.name)}"><span class="nm">${esc(p.name)}</span><span class="ag">${units}</span></a>`;
    });

  const health = diagnose(
    [...repo.connectors.values()],
    { has: (n) => typeof process.env[n] === "string" && process.env[n] !== "" },
    (cmd) => (Bun.which(cmd) ? "found" : "not-found"),
  );
  // Item 4b: no trailing status text ("ok"/"missing-env") — the dot alone carries the signal, same
  // vocabulary as the header's Orchestrator indicator. Each row is now a real link into the
  // connector's own entity card in the registry (`entityBlock` gives every connector card a stable
  // `id`, so this is a genuine deep link, not just "the registry in general"). UI4 item 4: a path
  // segment (`/registry/connectors/<name>`), matching the rest of the product — the registry route
  // scrolls to and highlights that entity on load (see `renderRegistry`'s `highlightName` param),
  // preserving what the old fragment anchor (`#connectors-<name>`) used to do.
  const connectorRows = health
    .map((h) => `<a class="crow" href="/registry/connectors/${esc(h.name)}"><span class="status-dot ${h.status === "ok" ? "is-ok" : "is-idle"}"></span><span class="nm">${esc(h.name)}</span></a>`)
    .join("\n");

  const ideaRows = extras.ideas.length
    ? extras.ideas.map((i) => `<a class="idea" href="${ideaHref(i.name)}">${esc(i.name)}</a>`)
    : [`<div class="idea" style="color:var(--fg-mute)">no ideas captured yet</div>`];

  return `<aside class="rail">
    <section class="railsec"><h3 class="railsec__h">Projects</h3>${railLongList(projectRows)}</section>
    <section class="railsec"><h3 class="railsec__h">Registry</h3><nav class="reg-nav">${registryNavLinks(repo, extras, opts.activeRegistryEntity)}</nav></section>
    <section class="railsec"><h3 class="railsec__h">Connectors</h3>${connectorRows}</section>
    <section class="railsec"><h3 class="railsec__h">Ideas</h3>${railLongList(ideaRows)}</section>
  </aside>`;
}

// ---------------------------------------------------------------------------
// Gate card — the one actionable element in the product (fixed anatomy: kind marker, name, producer,
// context, consumes/lineage, age, cost, verbs). Same markup renders in the studio inbox, project
// summon templates, and the run-view Orchestrator panel.
// ---------------------------------------------------------------------------

// NOTES F10 defect 3: an unmistakably HONEST, non-spinner-theatre "this is dispatching right now"
// state — reused verbatim from the quiet pending indicator already built for the Orchestrator composer
// (assets/styles.css's `.turn--pending .turn__dots`, unchanged here) rather than inventing a new
// animation. Swapped in for a gate's verb row the instant the daemon's `running()` projection shows an
// invocation in flight for that unit (render/studio.ts / render/project.ts / render/run.ts callers
// below), so the board acknowledges a Start/Request-changes click immediately instead of sitting
// static for however long the member takes.
function dispatchingHtml(member: string, kind: string): string {
  return `<div class="gate__verbs gate__verbs--pending">${pendingState({ label: `dispatching ${member} · ${kind}…` })}</div>`;
}

// The daemon's live in-flight projection (running()), narrowed to a single gate's own unit — a gate
// whose unit has a matching invocation is being produced RIGHT NOW, so the board renders it as
// dispatching instead of an actionable card (NOTES F10 defect 3).
export function dispatchingFor(running: DaemonInvocation[], gate: OpenGate): { member: string; kind: string } | undefined {
  const inv = running.find((r) => r.project === gate.project && r.unit === gate.unit);
  return inv ? { member: inv.member, kind: inv.kind } : undefined;
}

// Amendment 1 §1/R3: the work-unit-type glyph from the entity-icon family (the same thin geometric
// line-glyph `registryKindIconBody` already draws for a "types" entry in the registry) — never a bare
// unicode character. Monochrome, carries type only (Ruling R1); colour comes entirely from the
// caller's own CSS context, never baked into the glyph. The base brief scopes this glyph to exactly
// three places — "project view unit rows, the gate inbox, and the run view header" — this is the one
// function all three call (Phase 2 cluster 3 part 3: project.ts's row glyph and run.ts's header glyph
// previously still rendered the raw `type.glyph` unicode character, reconciled here to match the gate
// card, which migrated in cluster 1/2).
export function typeGlyphSvg(typeName: string | undefined, size = 15): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${registryKindIconBody("types", typeName)}</svg>`;
}

export function gateCardHtml(repo: Repo, gate: OpenGate, now: Date, opts: { cta?: boolean; dispatching?: { member: string; kind: string } } = {}): string {
  const unit = repo.units.find((u) => u.project === gate.project && u.unit === gate.unit);
  const type = unit ? repo.types.get(unit.type) : undefined;
  const glyph = typeGlyphSvg(type?.name);
  const dispatching = opts.dispatching;

  if (gate.type === "start") {
    const startVerbs = dispatching
      ? dispatchingHtml(dispatching.member, dispatching.kind)
      : `<div class="gate__verbs">
        <button class="verb is-primary" data-verb="start">Start</button>
        <button class="verb is-secondary" data-verb="notyet">Not yet</button>
        <button class="verb" data-verb="rescope">Re-scope</button>
      </div>`;
    return `<article class="gate gate--start${dispatching ? " is-dispatching" : ""}" data-gate-project="${esc(gate.project)}" data-gate-target="${esc(gate.unit)}">
      <div class="gate__top">
        <span class="gate__marker" aria-hidden="true">${glyph}</span>
        <div class="gate__body">
          <div class="gate__name-row">${tokenLink(gate.project, gate.unit, gate.unit)}<span class="gate__producer">${esc(type?.name ?? "")}</span></div>
          <p class="gate__ctx">${dispatching ? "Dispatching now &mdash; the unit is being produced." : "Queued work unit awaiting your beat to begin."}</p>
          <div class="gate__meta"><span>&#8592; ${esc(gate.project)}/${esc(gate.unit)}</span></div>
        </div>
        <span class="gate__badge is-start">${dispatching ? "dispatching" : "start gate"}</span>
      </div>
      ${startVerbs}
    </article>`;
  }

  // NOTES F1: a blocked unit — the walk could not bind one of its team's flow steps to any member.
  // No artifact exists (nothing ran), so this card carries the reason itself. There are no verbs: the
  // Conductor cannot approve their way out of a misconfigured studio; they fix the team/agent
  // definitions (`levare validate` now names exactly what to fix) and the block clears.
  if (gate.type === "blocked") {
    return `<article class="gate gate--blocked" data-gate-project="${esc(gate.project)}" data-gate-target="${esc(gate.unit)}">
      <div class="gate__top">
        <span class="gate__marker" aria-hidden="true">${glyph}</span>
        <div class="gate__body">
          <div class="gate__name-row">${tokenLink(gate.project, gate.unit, gate.unit)}<span class="gate__producer">${esc(type?.name ?? "")}</span></div>
          <p class="gate__ctx">Blocked: ${esc(gate.reason ?? "")}</p>
          <div class="gate__meta"><span>&#8592; ${esc(gate.project)}/${esc(gate.unit)}</span></div>
        </div>
        <span class="gate__badge is-blocked">blocked</span>
      </div>
    </article>`;
  }

  // NOTES F19: a blocked artifact (a member ran and failed) — retry/skip/abandon, the only three
  // verbs that make sense against a produce-time failure (never approve/reject/request, which decide
  // on CONTENT this artifact never had). `firstParagraph` surfaces the writeBlocked reason verbatim
  // — since NOTES F21, that reason leads with the actual diagnosis, not levare's own echoed prompt.
  if (gate.type === "artifact-blocked") {
    const art = gate.artifact!;
    const ctx = esc(firstParagraph(art.body ?? ""));
    const age = ageLabel(art.created, now);
    const verbs = dispatching
      ? dispatchingHtml(dispatching.member, dispatching.kind)
      : `<div class="gate__verbs">
        <button class="verb is-primary" data-verb="retry">Retry</button>
        <button class="verb is-secondary" data-verb="skip">Skip</button>
        <button class="verb is-danger" data-verb="abandon">Abandon</button>
      </div>`;
    return `<article class="gate gate--artifact-blocked${dispatching ? " is-dispatching" : ""}" data-gate-project="${esc(gate.project)}" data-gate-target="${esc(art.id)}">
      <div class="gate__top">
        <span class="gate__marker" aria-hidden="true">${glyph}</span>
        <div class="gate__body">
          ${gateUnitTitle(gate.project, gate.unit)}
          <div class="gate__name-row">${artifactTokenLink(gate.project, gate.unit, art.id, artifactFileName(art))}<span class="gate__producer">member/<b>${esc(gate.member ?? "")}</b></span></div>
          <p class="gate__ctx">Blocked: ${ctx}</p>
          <div class="gate__meta"><span>${esc(age)}</span></div>
        </div>
        <span class="gate__badge is-blocked">blocked</span>
      </div>
      ${verbs}
    </article>`;
  }

  const art = gate.artifact!;

  // NOTES MERGE-2: closes NOTES MERGE-1's own named residual — a `kind: merge` artifact used to fall
  // through to the generic in-review-artifact branch below (Approve/Request/Reject), which routes
  // Approve correctly but offers Request/Reject buttons the server has always 409'd, and has never
  // offered `recheck` at all. See `mergeGateCardHtml` for the dedicated variant.
  if (art.kind === "merge") {
    return mergeGateCardHtml(repo, gate, now, opts);
  }

  const consumesHtml = art.consumes.length
    ? `<div class="gate__consumes">consumes: ${art.consumes.map((id) => artifactTokenLink(gate.project, gate.unit, id, id)).join(" &middot; ")}</div>`
    : "";
  const age = ageLabel(art.created, now);
  const cost = costLabel(art.usage);
  const nameRow = `${gateUnitTitle(gate.project, gate.unit)}<div class="gate__name-row">${artifactTokenLink(gate.project, gate.unit, art.id, artifactFileName(art))}<span class="gate__producer">member/<b>${esc(gate.member ?? "")}</b></span></div>`;

  // NOTES F20: an exhausted loop (max_rounds reached without `until`) is enforced server-side
  // (`board/gateops.ts#doRequest` already refuses a `request` past max_rounds, 409, no spend) but was
  // invisible here — the card offered "Request changes" regardless, the note composer opened, took
  // the Conductor's text, and the server silently discarded it. The card now says so up front and
  // presents the loop's ACTUAL on_exhaust decision (approve over the critic's objection, reject, or
  // re-scope) instead of a verb that can never succeed.
  const ctx = gate.loop?.exhausted
    ? `${gate.loop.round} of ${gate.loop.maxRounds} rounds used — this loop cannot continue without \`${esc(gate.loop.until)}\`.`
    : esc(firstParagraph(art.body ?? ""));
  const roundBadge = gate.loop ? `<span class="gate__round">round ${gate.loop.round}/${gate.loop.maxRounds}</span>` : "";
  const meta = `<div class="gate__meta"><span>${esc(age)}</span>${cost ? `<span class="cost">${cost}</span>` : ""}${roundBadge}</div>`;
  const verbs = dispatching
    ? dispatchingHtml(dispatching.member, dispatching.kind)
    : gate.loop?.exhausted
      ? `<div class="gate__verbs">
        <button class="verb is-primary" data-verb="approve">Approve anyway</button>
        <button class="verb" data-verb="rescope">Re-scope</button>
        <button class="verb is-danger" data-verb="reject">Reject</button>
      </div>`
      : `<div class="gate__verbs">
        <button class="verb is-primary" data-verb="approve">Approve</button>
        <button class="verb is-secondary" data-verb="request">Request changes</button>
        <button class="verb is-danger" data-verb="reject">Reject</button>
      </div>`;

  const exhaustedCls = gate.loop?.exhausted ? " gate--exhausted" : "";
  if (opts.cta) {
    return `<article class="gate gate--cta${exhaustedCls}${dispatching ? " is-dispatching" : ""}" data-gate-project="${esc(gate.project)}" data-gate-target="${esc(art.id)}">
      <div class="gate__banner"><span class="dia" aria-hidden="true"></span><span class="t">Gate &middot; ${esc(gate.label)} review</span></div>
      <div class="gate__inner">
        ${nameRow}
        <p class="gate__ctx">${ctx}</p>
        ${consumesHtml}
        ${meta}
        ${verbs}
      </div>
    </article>`;
  }
  // The card contract, applied to the gate card's default (Needs You / project-summon) anatomy: a
  // marker `pre`-slot, the name-row wrapped with its context/consumes/meta as `titleExtra` inside
  // `.gate__body`, the badge as `status`, and the verbs row as `meta` (below the top row) — same
  // title-top-left/status-top-right/supporting-content-bottom shape `card()` gives every other
  // surface, just with the `.gate__*` class family this card has always carried.
  return card({
    as: "article",
    cls: `gate${exhaustedCls}${dispatching ? " is-dispatching" : ""}`,
    attrs: { "data-gate-project": gate.project, "data-gate-target": art.id },
    topCls: "gate__top",
    pre: `<span class="gate__marker" aria-hidden="true">${glyph}</span>`,
    bodyWrapCls: "gate__body",
    title: nameRow,
    titleExtra: `<p class="gate__ctx">${ctx}</p>${consumesHtml}${meta}`,
    status: `<span class="gate__badge${gate.loop?.exhausted ? " is-exhausted" : ""}">${gate.loop?.exhausted ? statusLabel("exhausted") : "on you"}</span>`,
    meta: verbs,
  });
}

// ---------------------------------------------------------------------------
// Merge gate card (NOTES MERGE-2, closing NOTES MERGE-1's own named residual) — the dedicated `kind:
// merge` variant, built from the same primitives as every other gate (card/statusBadge/callout/tag),
// never a bespoke markup family. The one behavioural rule the server already enforces
// (board/gateops.ts#doApproveMerge: `approve` 409s whenever the trial is conflicted OR a guardrail
// violates) governs every verb choice below: a conflicted or guardrail-violating trial never renders
// an approve/merge button — Re-check is the only primary action offered instead, since only a re-run
// of the trial (a by-hand fix on the work branch, or a guardrail fix in the studio) can change the
// outcome. `reject`/`request` are never rendered either — resolveGate already refuses both against a
// merge gate (NOTES MERGE-1) — there is no "changes" to request against a trial-merge report.
// ---------------------------------------------------------------------------

// Compact "N files changed · +ins/-del" pulled from `git diff --stat`'s own trailing summary line —
// never the full per-file listing (the goal: "render compactly... not a full diff"). Returns null for
// anything that doesn't match (an empty diffstat — 0 commits ahead — or a shape this hasn't seen), in
// which case the card simply omits the chip rather than guessing.
function diffstatSummary(diffstat: string): string | null {
  const lines = diffstat
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const last = lines[lines.length - 1];
  if (!last) return null;
  const m = /^(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/.exec(last);
  if (!m) return null;
  const files = Number(m[1]);
  const ins = m[2] ?? "0";
  const del = m[3] ?? "0";
  // A literal middle-dot character, not the `&middot;` entity — this string is passed through
  // `tag()`, which `esc()`s its text (correctly: it's a plain-text label, not an HTML fragment), and
  // `esc()` would otherwise double-escape a literal ampersand into `&amp;middot;`.
  return `${files} file${files === 1 ? "" : "s"} changed · +${ins}/-${del}`;
}

function mergeGateCardHtml(repo: Repo, gate: OpenGate, now: Date, opts: { cta?: boolean; dispatching?: { member: string; kind: string } }): string {
  const art = gate.artifact!;
  const merge = art.merge;
  const unit = repo.units.find((u) => u.project === gate.project && u.unit === gate.unit);
  const type = unit ? repo.types.get(unit.type) : undefined;
  const glyph = typeGlyphSvg(type?.name);
  const dispatching = opts.dispatching;
  const age = ageLabel(art.created, now);

  // `produced_by: levare-runner` (merge.ts#formatMergeArtifact) has no team/member — the producer slot
  // says what this gate actually IS instead of the generic "member/<b></b>" the fallthrough path would
  // have printed for a team-less producer.
  const nameRow = `${gateUnitTitle(gate.project, gate.unit)}<div class="gate__name-row">${artifactTokenLink(gate.project, gate.unit, art.id, artifactFileName(art))}<span class="gate__producer">levare &middot; merge gate</span></div>`;

  // Defensive only: merge.ts#formatMergeArtifact always writes `merge:` at gate-open time, and
  // doRecheckMerge only ever rewrites it in place, never clears it — this branch should be
  // unreachable. A card is a pure function of on-disk data, though, so an honestly-empty report
  // renders as a stalled state (recheck is always safe to offer) rather than throwing.
  if (!merge) {
    const verbs = dispatching
      ? dispatchingHtml(dispatching.member, dispatching.kind)
      : `<div class="gate__verbs"><button class="verb is-primary" data-verb="recheck">Re-check</button></div>`;
    return card({
      as: "article",
      cls: `gate gate--merge${dispatching ? " is-dispatching" : ""}`,
      attrs: { "data-gate-project": gate.project, "data-gate-target": art.id },
      topCls: "gate__top",
      pre: `<span class="gate__marker" aria-hidden="true">${glyph}</span>`,
      bodyWrapCls: "gate__body",
      title: nameRow,
      titleExtra: callout("warning", "this merge gate has no trial-merge report on disk yet &mdash; re-check to generate one."),
      status: `<span class="gate__badge">on you</span>`,
      meta: verbs,
    });
  }

  const conflicted = merge.conflicted;
  const violations = merge.guardrail_violations ?? [];
  const guardrailsPass = violations.length === 0;
  // Never render approve/merge when the server would refuse it (409): conflicted, or a guardrail
  // violation the SAME execution-time re-check (M3) would re-discover and fail on anyway.
  const canApprove = !conflicted && guardrailsPass;

  // NOTES SEC-V11 F2: surfaces the exact commit `executeMerge` pins to (merge.ts's own TOCTOU-closing
  // check) — small, honest, additive; omitted entirely for a pre-F2 artifact carrying no `branch_sha`.
  const shaChip = merge.branch_sha ? tag(merge.branch_sha.slice(0, 7), "tag") : "";
  const statsHtml = `<div class="chiprow">${tag(merge.branch, "tag")}${tag(`${merge.commits_ahead} commit${merge.commits_ahead === 1 ? "" : "s"} ahead`, "tag")}${
    diffstatSummary(merge.diffstat) ? tag(diffstatSummary(merge.diffstat)!, "tag") : ""
  }${shaChip}</div>`;

  const trialBadge = conflicted ? statusBadge("failed", "CONFLICTED") : statusBadge("done", "CLEAN");
  // The instruction the server already words at every layer that names a conflict (merge.ts's own
  // artifact body, gateops.ts's 409 error) — repeated here verbatim rather than invented afresh.
  const conflictDetail = conflicted
    ? `<p class="gate__ctx">Conflicts on: ${merge.conflicts.map((f) => `<span class="mono">${esc(f)}</span>`).join(", ")}. Resolve by hand on <span class="mono">${esc(merge.branch)}</span> in the project repo, then re-check.</p>`
    : "";
  const guardrailHtml = guardrailsPass
    ? `<p class="gate__ctx" style="color:var(--fg-mute)">guardrails pass</p>`
    : callout("danger", `blocked by guardrail: ${violations.map(esc).join("; ")}`);
  const meta = `<div class="gate__meta"><span>opened ${esc(age)}</span></div>`;

  const project = repo.projects.get(gate.project);
  const verbsHtml = dispatching
    ? dispatchingHtml(dispatching.member, dispatching.kind)
    : canApprove
      ? `<div class="gate__verbs"><button class="verb is-primary" data-verb="approve">${project?.remote ? "Merge &amp; push" : "Merge"}</button></div>`
      : `<div class="gate__verbs"><button class="verb is-primary" data-verb="recheck">Re-check</button></div>`;

  const titleExtra = `${trialBadge}${conflictDetail}${statsHtml}${guardrailHtml}${meta}`;

  if (opts.cta) {
    return `<article class="gate gate--merge gate--cta${dispatching ? " is-dispatching" : ""}" data-gate-project="${esc(gate.project)}" data-gate-target="${esc(art.id)}">
      <div class="gate__banner"><span class="dia" aria-hidden="true"></span><span class="t">Gate &middot; merge review</span></div>
      <div class="gate__inner">
        ${nameRow}
        ${titleExtra}
        ${verbsHtml}
      </div>
    </article>`;
  }

  return card({
    as: "article",
    cls: `gate gate--merge${dispatching ? " is-dispatching" : ""}`,
    attrs: { "data-gate-project": gate.project, "data-gate-target": art.id },
    topCls: "gate__top",
    pre: `<span class="gate__marker" aria-hidden="true">${glyph}</span>`,
    bodyWrapCls: "gate__body",
    title: nameRow,
    titleExtra,
    status: `<span class="gate__badge">on you</span>`,
    meta: verbsHtml,
  });
}

// Studio project-card status chip (phase-6 gate fix-up; NOTES UI1: now routed through the canonical
// status→colour map — "active" was, until this fix, the one place a plain neutral `.chip.is-progress`
// stood in for what the palette calls the in-flight state, rendering the same word BLUE on the run-
// view score rail and GREY here). An open gate always wins (it needs the Conductor now, regardless
// of what else is happening); with none, "active" means real work is underway — an active unit, or a
// live member; with neither, the project is honestly "waiting" — an empty project with no units and
// no activity was previously mislabeled "running", which read as fabricated activity for a project
// that had none. Shared by render/studio.ts (the project card) and render/project.ts (the page
// header badge) — the two surfaces can never independently drift on what "active" looks like.
export function projectStatusChip(projGates: number, anyUnitActive: boolean, membersRunning: number): string {
  if (projGates > 0) return statusBadge("needs-you", `${projGates} gate${projGates === 1 ? "" : "s"}`);
  if (anyUnitActive || membersRunning > 0) return statusBadge("active");
  return statusBadge("waiting", "idle");
}

// ---------------------------------------------------------------------------
// ARTIFACT / IDEA shared body/lineage helpers — a read-only markdown body renderer and the "nothing
// here" lineage row, used by both render/artifact.ts and render/idea.ts.
// ---------------------------------------------------------------------------

/** Split a markdown body into paragraphs; a line starting with `#`s renders as a heading, everything
 * else as a `<p>` (internal single newlines become `<br/>`). No markdown library — the same
 * paragraph-splitting rule `firstParagraph` (repo.ts, ruling A8) uses, just not truncated to one. */
export function renderBody(body: string): string {
  const paras = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return paras
    .map((p) => {
      const m = /^(#{1,6})\s+(.*)$/.exec(p);
      if (m) {
        const level = Math.min(m[1].length + 1, 4); // one level below the page's own h1
        return `<h${level}>${esc(m[2])}</h${level}>`;
      }
      return `<p style="margin:0;font-size:13.5px;line-height:1.6;color:var(--fg-dim)">${esc(p).replace(/\n/g, "<br/>")}</p>`;
    })
    .join("\n");
}

export function lineageEmpty(text: string): string {
  return `<div class="founding" style="color:var(--fg-mute)">${esc(text)}</div>`;
}

// `resolveOrchestratorStatus` is re-exported here purely so screen modules can share the one default
// import path; each render function still takes `status` as an explicit param (never re-derived
// internally), matching the pre-split signature exactly.
export { resolveOrchestratorStatus };
export type { OrchestratorStatus };

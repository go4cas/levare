// Server-rendered board templates (PRD §9). Pure functions: repo data in, an HTML string out — no
// client state, re-derived on every request (invariant 2). Structure and CSS class names are bound
// to assets/styles.css (shipped verbatim, never touched here); only the data inside each element
// changes. Where the CD prototype markup (assets/*.html) assumed richer demo data than the golden
// fixture actually has (multiple projects with live members, a start-gate example, release history),
// the fixture is truth and the markup is trimmed to what the repo can actually show — see NOTES.md.

import { readFileSync } from "node:fs";
import type { Repo } from "../repo.ts";
import type { Artifact } from "../types.ts";
import { firstParagraph } from "../repo.ts";
import {
  esc,
  costLabel,
  ageLabel,
  openGates,
  scoreNodes,
  foundingArtifacts,
  unitSummary,
  leadingArtifact,
  unitSpend,
  repoSpend,
  projectSpend,
  medianGateResponseDays,
  medianReviewRounds,
  mostRelevantUnit,
  latestRelease,
  recentReleases,
  findArtifactInProject,
  supersededByOf,
  citedByOf,
  type OpenGate,
  type ScoreNode,
} from "./derive.ts";
import { loadExtras, type RegistryExtras } from "./extra.ts";
import { buildTimeline } from "./timeline.ts";
import { diagnose } from "../doctor.ts";
import type { DaemonInvocation } from "../daemon.ts";
import { resolveOrchestratorStatus, type OrchestratorStatus } from "../orchestrator-status.ts";
import { LEVARE_ROOT } from "../sdk-transport.ts";
import { dotClass, snodeClass, statusChip, statusLabel, fromWorkUnitStatus, fromArtifactStatus, fromNodeState } from "./status.ts";

// levare's own release version (item 3: "the release version as a quiet muted mono chip" beside the
// wordmark) — read once from this repo's own package.json, never from a project's data (that's the
// `pace`/`deploy`/release vocabulary, a different concept entirely).
const LEVARE_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(`${LEVARE_ROOT}/package.json`, "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

const ASSETS = `<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet"/>
<link rel="stylesheet" href="/styles.css?v=9"/>`;

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

// UI4 item 1: the reusable confirm-modal primitive — a small centered panel over a dimmed backdrop,
// in levare's own palette, replacing the browser's native confirm()/alert() everywhere in the
// product. ONE instance per page, a sibling of `.app` (same "hidden by default, painted on demand"
// shape as `editorOverlay()`), so any future confirmation need (the goal's own "the
// visual-standardisation work will adopt it") reuses this DOM node and app.js's `confirmModal()`
// helper rather than building a second one. `role="alertdialog"` (not `role="dialog"`, per the
// editor overlay) — this surface only ever asks a yes/no question, never hosts arbitrary content.
function confirmModalHtml(): string {
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

function shell(title: string, railToggleLabel: string, body: string, status: OrchestratorStatus): string {
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
${confirmModalHtml()}
<script src="/app.js?v=7"></script>
</body>
</html>
`;
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
// so exactly one copy is ever rendered per page, at every viewport width. It reuses the canonical
// `.status-dot` classes already established for connector health (is-ok/is-idle) rather than a new
// color — "on" reads as the same quiet green as a healthy connector, "off" the same hollow/outline
// neutral as an unconfigured one (dot filled for on, hollow for off); this is a configuration state,
// never a failure, so it is never red, and it never changes mid-response — a live SDK call's own
// "thinking" state is the Orchestrator panel's concern (`.msg--pending`), not the header's.
// ---------------------------------------------------------------------------

function orchestratorIndicator(status: OrchestratorStatus): string {
  const dotCls = status.available ? "is-ok" : "is-idle";
  const label = status.available ? "orchestrator: on" : "orchestrator: off";
  return `<details class="orchind">
    <summary class="orchind__sum"><span class="status-dot ${dotCls}"></span><span class="orchind__label mono">${esc(label)}</span></summary>
    <div class="orchind__pop">
      <p>${esc(status.reason)}</p>
      <p>Env var: <span class="mono">${esc(status.envVar)}</span></p>
      <p>The board, the registry, and every gate are unaffected: approvals, rejections, and the runner all keep working either way.</p>
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
function orchestratorPanel(scope: string, status: OrchestratorStatus, briefingHtml: string, actionableHtml: string = ""): string {
  if (!status.available) {
    return `<aside class="orch is-disabled">
    ${orchHead(scope)}
    <div class="orch__body">
      <div class="msg"><p class="msg__body">Orchestrator unavailable — no ${esc(status.envVar)}. The board, the registry, and every gate still work: you can approve, reject, and the runner will advance. Set a key to talk.</p></div>
      ${actionableHtml}
    </div>
    ${composer({ disabled: true })}
  </aside>`;
  }
  return `<aside class="orch">
    ${orchHead(scope)}
    <div class="orch__body">${briefingHtml}${actionableHtml}</div>
    ${composer()}
  </aside>`;
}

function avatar(initials: string, color: string | undefined, opts: { size?: "sm" | "lg"; blink?: boolean } = {}): string {
  const size = opts.size ?? "sm";
  const bg = color && color.trim() ? color : "#666";
  const blinkCls = opts.blink ? " blink" : "";
  return `<span class="avatar ${size}${blinkCls}" style="background:${esc(bg)}">${esc(initials.toLowerCase())}</span>`;
}

function memberAvatar(repo: Repo, producedBy: string, opts: { size?: "sm" | "lg"; blink?: boolean } = {}): string {
  const [teamName, memberName] = producedBy.split("/");
  if (memberName === undefined) return `<span class="avatar avatar--conductor sm">C</span>`;
  const agent = repo.agents.get(memberName);
  const team = repo.teams.get(teamName);
  const initials = agent?.style.avatar || memberName.slice(0, 2);
  return avatar(initials, team?.style.color, opts);
}

function artifactFileName(art: Artifact): string {
  return `${art.id}.md`;
}

function tokenLink(project: string, unit: string, text: string): string {
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
function artifactHref(project: string, unit: string, id: string): string {
  return `/artifact/${esc(project)}/${esc(unit)}/${esc(id)}`;
}
function artifactTokenLink(project: string, unit: string, id: string, text: string): string {
  return `<a class="tok link mono" href="${artifactHref(project, unit, id)}">${esc(text)}</a>`;
}
function ideaHref(name: string): string {
  return `/idea/${esc(name)}`;
}

// UI2 item 3: the project page's external-link icons become recognisable per destination, using the
// design brief's Tabler-outline icon set — `ti-brand-github` for the repo link, `ti-world` for the
// deploy link — rather than one generic external-link glyph for both (the UI1 shape) or coloured
// brand logos (the board stays monochrome; both inherit ink colour via `stroke="currentColor"`, same
// as every other icon in the product). No icon font or CDN — the outline paths are vendored inline,
// same "no new asset" approach UI1 used for the single external-link glyph this replaces.
const TABLER_ICON_PATHS: Record<"ti-brand-github" | "ti-world", string> = {
  "ti-brand-github": `<path d="M9 19c-4.3 1.4 -4.3 -2.5 -6 -3m12 5v-3.5c0 -1 .1 -1.4 -.5 -2c2.8 -.3 5.5 -1.4 5.5 -6a4.6 4.6 0 0 0 -1.3 -3.2a4.2 4.2 0 0 0 -.1 -3.2s-1.1 -.3 -3.5 1.3a12.3 12.3 0 0 0 -6.2 0c-2.4 -1.6 -3.5 -1.3 -3.5 -1.3a4.2 4.2 0 0 0 -.1 3.2a4.6 4.6 0 0 0 -1.3 3.2c0 4.6 2.7 5.7 5.5 6c-.6 .6 -.6 1.2 -.5 2v3.5" />`,
  "ti-world": `<path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0" /><path d="M3.6 9h16.8" /><path d="M3.6 15h16.8" /><path d="M11.5 3a17 17 0 0 0 0 18" /><path d="M12.5 3a17 17 0 0 1 0 18" />`,
};
function iconLink(href: string, label: string, icon: "ti-brand-github" | "ti-world"): string {
  return `<a class="iconlink ${icon}" href="${esc(href)}" target="_blank" rel="noopener" aria-label="${esc(label)}" title="${esc(label)}"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TABLER_ICON_PATHS[icon]}</svg></a>`;
}

// Item 6c: `pace` renders as a colour-coded badge. Pace isn't a lifecycle status, so it borrows two
// of the palette's existing neutral-to-live hues rather than inventing a new one: `auto` (the runner
// proceeds without a per-step gate) reads as the same in-flight blue as an active unit; `step` (the
// Conductor nods before every step) reads as the same hollow-neutral "waiting-on-a-beat" tone as an
// idle project — never brass (that hue is gate-exclusive) and never a fabricated third colour.
function paceBadge(pace: "auto" | "step"): string {
  return pace === "auto" ? statusChip("active", "auto") : statusChip("waiting", "step");
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

const REGISTRY_KINDS = ["teams", "agents", "skills", "knowledge", "types", "connectors", "evals"] as const;
type RegistryKind = (typeof REGISTRY_KINDS)[number];

function registryKindCount(repo: Repo, extras: RegistryExtras, k: RegistryKind): number {
  return k === "teams" ? repo.teams.size
    : k === "agents" ? repo.agents.size
    : k === "types" ? repo.types.size
    : k === "connectors" ? repo.connectors.size
    : k === "skills" ? extras.skills.length
    : k === "knowledge" ? extras.knowledge.length
    : extras.evals.length;
}

/** The registry entity-kind link list — shared by the rail's Registry section and the registry
 * page's own in-content tab strip, so the two never drift into two different lists of kinds.
 * UI4 item 4: paths, not query params — `/registry/<kind>`, matching `/project/<name>` and
 * `/idea/<name>` elsewhere in the product. A plain `<a href>`, no client-side interception: switching
 * kinds is a real navigation (a fresh server render, PRD invariant 2), which is also what makes
 * browser back/forward behave correctly across registry navigation for free. */
function registryNavLinks(repo: Repo, extras: RegistryExtras, active?: RegistryKind): string {
  return REGISTRY_KINDS.map((k) => {
    const activeCls = active === k ? " is-active" : "";
    return `<a href="/registry/${k}" data-goto="${k}" class="${activeCls.trim()}">${k} <span class="ct">${registryKindCount(repo, extras, k)}</span></a>`;
  }).join("\n");
}

function railNav(repo: Repo, extras: RegistryExtras, opts: { activeRegistryEntity?: RegistryKind } = {}): string {
  const projectRail = [...repo.projects.values()]
    .map((p) => {
      const units = repo.units.filter((u) => u.project === p.name).length;
      return `<a class="rel" href="/project/${esc(p.name)}"><span class="nm">${esc(p.name)}</span><span class="ag">${units}</span></a>`;
    })
    .join("\n");

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

  const ideasHtml = extras.ideas.length
    ? extras.ideas.map((i) => `<a class="idea" href="${ideaHref(i.name)}">${esc(i.name)}</a>`).join("\n")
    : `<div class="idea" style="color:var(--fg-mute)">no ideas captured yet</div>`;

  return `<aside class="rail">
    <section class="railsec"><h3 class="railsec__h">Projects</h3>${projectRail}</section>
    <section class="railsec"><h3 class="railsec__h">Registry</h3><nav class="reg-nav">${registryNavLinks(repo, extras, opts.activeRegistryEntity)}</nav></section>
    <section class="railsec"><h3 class="railsec__h">Connectors</h3>${connectorRows}</section>
    <section class="railsec"><h3 class="railsec__h">Ideas</h3>${ideasHtml}</section>
  </aside>`;
}

// ---------------------------------------------------------------------------
// Gate card — the one actionable element in the product (fixed anatomy: kind marker, name, producer,
// context, consumes/lineage, age, cost, verbs). Same markup renders in the studio inbox, project
// summon templates, and the run-view Orchestrator panel.
// ---------------------------------------------------------------------------

// NOTES F10 defect 3: an unmistakably HONEST, non-spinner-theatre "this is dispatching right now"
// state — reused verbatim from the quiet pending indicator already built for the Orchestrator composer
// (assets/styles.css's `.msg--pending .msg__dots`, unchanged here) rather than inventing a new
// animation. Swapped in for a gate's verb row the instant the daemon's `running()` projection shows an
// invocation in flight for that unit (board/render.ts callers below), so the board acknowledges a
// Start/Request-changes click immediately instead of sitting static for however long the member takes.
function dispatchingHtml(member: string, kind: string): string {
  return `<div class="gate__verbs gate__verbs--pending">
        <span class="msg msg--pending" style="display:inline-flex;align-items:center;gap:8px"><span class="msg__dots"><span></span><span></span><span></span></span></span>
        <span class="gate__dispatching">dispatching ${esc(member)} &middot; ${esc(kind)}&hellip;</span>
      </div>`;
}

// The daemon's live in-flight projection (running()), narrowed to a single gate's own unit — a gate
// whose unit has a matching invocation is being produced RIGHT NOW, so the board renders it as
// dispatching instead of an actionable card (NOTES F10 defect 3).
function dispatchingFor(running: DaemonInvocation[], gate: OpenGate): { member: string; kind: string } | undefined {
  const inv = running.find((r) => r.project === gate.project && r.unit === gate.unit);
  return inv ? { member: inv.member, kind: inv.kind } : undefined;
}

function gateCardHtml(repo: Repo, gate: OpenGate, now: Date, opts: { cta?: boolean; dispatching?: { member: string; kind: string } } = {}): string {
  const unit = repo.units.find((u) => u.project === gate.project && u.unit === gate.unit);
  const type = unit ? repo.types.get(unit.type) : undefined;
  const glyph = type?.glyph ?? "&#9702;";
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
  return `<article class="gate${exhaustedCls}${dispatching ? " is-dispatching" : ""}" data-gate-project="${esc(gate.project)}" data-gate-target="${esc(art.id)}">
    <div class="gate__top">
      <span class="gate__marker" aria-hidden="true">${glyph}</span>
      <div class="gate__body">
        ${nameRow}
        <p class="gate__ctx">${ctx}</p>
        ${consumesHtml}
        ${meta}
      </div>
      <span class="gate__badge${gate.loop?.exhausted ? " is-exhausted" : ""}">${gate.loop?.exhausted ? statusLabel("exhausted") : "on you"}</span>
    </div>
    ${verbs}
  </article>`;
}

// ---------------------------------------------------------------------------
// Mini-score (project view) — the score's dot-strip compression.
// ---------------------------------------------------------------------------

// NOTES UI1: every dot is now routed through status.ts's `fromNodeState`/`dotClass` — previously this
// collapsed "active" AND "blocked" into the same hollow `is-wait` dot, so a live step and a stalled
// one were visually indistinguishable here even though the run view's own score rail correctly told
// them apart (`.snode.active` vs `.snode.blocked`). `.dot.is-active`/`.dot.is-blocked` already existed
// in assets/styles.css (the same "dormant, already-designed rule never wired up" shape as NOTES.md's
// G1) — this just starts emitting them.
function miniScoreHtml(nodes: ScoreNode[]): string {
  return `<div class="miniscore unit__score">${nodes
    .map((n) => {
      if (n.shape === "diamond") return `<span class="diamond is-gate"></span>`;
      return `<span class="dot ${dotClass(fromNodeState(n.state, false))}"></span>`;
    })
    .join("")}</div>`;
}

// The run-view score rail's node marker class — a thin, verbatim-preserving wrapper over
// status.ts's canonical `fromNodeState`/`snodeClass` (NOTES UI1: this used to be the ONE place that
// got the palette right; it's now generated by the same shared map every other status marker in the
// product uses, rather than being its own bespoke correct implementation). Exported and pure so a
// test can assert, for every reachable state, that the class emitted here has a matching rule in
// assets/styles.css — a mismatched class renders a real DOM node with zero visible size, not a
// missing one.
export function scoreNodeClass(n: Pick<ScoreNode, "state">, isGate: boolean): string {
  return `snode ${snodeClass(fromNodeState(n.state, isGate))}`;
}

// Studio project-card status chip (phase-6 gate fix-up; NOTES UI1: now routed through the canonical
// status→colour map — "active" was, until this fix, the one place a plain neutral `.chip.is-progress`
// stood in for what the palette calls the in-flight state, rendering the same word BLUE on the run-
// view score rail and GREY here). An open gate always wins (it needs the Conductor now, regardless
// of what else is happening); with none, "active" means real work is underway — an active unit, or a
// live member; with neither, the project is honestly "waiting" — an empty project with no units and
// no activity was previously mislabeled "running", which read as fabricated activity for a project
// that had none.
export function projectStatusChip(projGates: number, anyUnitActive: boolean, membersRunning: number): string {
  if (projGates > 0) return statusChip("needs-you", `${projGates} gate${projGates === 1 ? "" : "s"}`);
  if (anyUnitActive || membersRunning > 0) return statusChip("active");
  return statusChip("waiting", "idle");
}

// Item 5a: Needs You, Running Now, and Projects all use ONE counter treatment beside their heading —
// previously only Needs You carried a count at all, styled in gate brass. A brass badge can't
// generalize to the other two without violating the design brief's gate-colour scarcity rule ("gate
// brass ... appears exclusively on gates"), so the shared treatment is a plain neutral mono count,
// applied uniformly to all three; the gate-brass wash on the gate CARDS themselves (`#needs .gate`)
// already carries Needs You's urgency.
function sectionCount(n: number, opts: { gatecount?: boolean } = {}): string {
  const attr = opts.gatecount ? ` data-gatecount="${n}"` : "";
  return `<span class="sec__count"${attr}>${n}</span>`;
}

// Phase 8, deliverable c: retires NOTES E2. Reuses `.tlrow` (the timeline's own row anatomy) and
// `.avatar--runner` — a class already declared in the frozen stylesheet for exactly this identity but
// never emitted by any renderer until now (the same "dormant, already-designed rule" shape as G1's
// `.snode.is-danger` before it was wired up) — so this needed zero new CSS.
function runningNowHtml(running: DaemonInvocation[], now: Date): string {
  if (running.length === 0) {
    return `<p style="color:var(--fg-mute);font-size:13.5px">Nothing running right now.</p>`;
  }
  return running
    .map((r) => {
      const age = ageLabel(r.startedAt, now);
      return `<div class="tlrow"><span class="avatar avatar--runner sm">R</span><span class="tlrow__text">${esc(r.member)} producing <b>${esc(r.kind)}</b> for ${esc(r.project)}/${esc(r.unit)} <span class="mono">${age}</span></span></div>`;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// STUDIO
// ---------------------------------------------------------------------------

export function renderStudio(repo: Repo, root: string, now: Date = new Date(), running: DaemonInvocation[] = [], status: OrchestratorStatus = resolveOrchestratorStatus()): string {
  const extras = loadExtras(root);
  const gates = openGates(repo);
  const spend = repoSpend(repo);
  const median = medianGateResponseDays(repo);
  const shippedUnits = repo.units.filter((u) => u.status === "shipped").length;

  const rail = railNav(repo, extras);

  const gateCards = gates.length
    ? gates.map((g) => gateCardHtml(repo, g, now, { dispatching: dispatchingFor(running, g) })).join("\n")
    : `<p style="color:var(--fg-mute);font-size:13.5px">Nothing needs you right now.</p>`;

  // UI2 item 6: the Studio "Projects" section becomes an IN-FLIGHT worklist, not the project index —
  // it shows only projects with at least one active work unit. An idle project (no active unit) drops
  // out entirely; it's still reachable via the left nav (`railNav`) and its own project page. This is
  // the same `status === "active"` check `projectStatusChip`/the project page already use for
  // "anyUnitActive", so "in flight" means exactly what the status badge already calls active.
  const inFlightProjects = [...repo.projects.values()].filter((p) => repo.units.some((u) => u.project === p.name && u.status === "active"));
  const projectCards = inFlightProjects
    .map((p) => {
      const units = repo.units.filter((u) => u.project === p.name);
      const projGates = gates.filter((g) => g.project === p.name).length;
      // A8: the summary is the first paragraph of the most relevant unit's leading artifact — newest
      // gated, else newest active, else honestly empty (no fabricated summary — see NOTES.md).
      const summaryUnit = mostRelevantUnit(repo, p.name);
      const desc = !summaryUnit
        ? units.length ? "No unit currently gated or active." : "No work units yet."
        : esc(unitSummary(repo, summaryUnit) || "Awaiting its first artifact.");
      const anyUnitActive = units.some((u) => u.status === "active");
      // Phase 8, deliverable c: a real projection of the daemon's in-flight invocations, retiring
      // NOTES E2 — `running` is [] whenever no daemon is attached (createBoard's default; see
      // board/serve.ts), so this stays the same honest zero it always was in that case.
      const membersRunning = running.filter((r) => r.project === p.name).length;
      const chip = projectStatusChip(projGates, anyUnitActive, membersRunning);
      // Item 5b: "no deploy target" is dropped entirely (absence is shown by absence, not a fabricated
      // negative line), and the release version shows ONLY when the project actually has releases.
      const release = latestRelease(repo, p.name);
      const metaParts = [`${units.length} unit${units.length === 1 ? "" : "s"}`, ...(release ? [`released ${esc(release.unit)}`] : [])];
      // Item 2, gate-review round 2: title and status chip share one line, chip right-aligned —
      // `.pcard__top{justify-content:space-between}` already does this once both live inside it,
      // matching the gate-card/unit-row anatomy elsewhere.
      return `<a class="pcard" href="/project/${esc(p.name)}">
        <div class="pcard__top"><span class="pcard__name">${esc(p.name)}</span>${chip}</div>
        <span class="pcard__desc">${desc}</span>
        <div class="pcard__meta mono">${metaParts.map((m) => `<span>${m}</span>`).join("")}</div>
      </a>`;
    })
    .join("\n");

  const main = `<main class="main">
    <header class="phead">
      <div class="crumb"><span>studio</span></div>
      <h1>Studio</h1>
    </header>
    <div class="statstrip" style="grid-template-columns:repeat(5,1fr)">
      <div class="stat"><div class="n is-gate" data-gatestat="${gates.length}">${gates.length}</div><div class="l">Gates on you</div></div>
      <div class="stat"><div class="n" data-runningstat="${running.length}">${running.length}</div><div class="l">Members running</div></div>
      <div class="stat"><div class="n">${shippedUnits}</div><div class="l">Units shipped &middot; 30d</div></div>
      <div class="stat"><div class="n">${median === null ? "&mdash;" : `${median.toFixed(median % 1 === 0 ? 0 : 1)}d`}</div><div class="l">Median gate response</div></div>
      <div class="stat"><div class="n">$${spend.toFixed(2)}</div><div class="l">Spend &middot; 30d</div></div>
    </div>
    <section class="sec" id="needs">
      <div class="sec__h"><h2>Needs you</h2>${sectionCount(gates.length, { gatecount: true })}</div>
      ${gateCards}
    </section>
    <section class="sec">
      <div class="sec__h"><h2>Running now</h2>${sectionCount(running.length)}</div>
      ${runningNowHtml(running, now)}
    </section>
    <section class="sec">
      <div class="sec__h"><h2>In flight</h2>${sectionCount(inFlightProjects.length)}</div>
      ${inFlightProjects.length
        ? `<div class="pcards">${projectCards}</div>`
        : `<p style="color:var(--fg-mute);font-size:13.5px">Nothing in flight. Open a project from the sidebar to start a unit.</p>`}
    </section>
  </main>`;

  const briefingBody = `<div class="msg"><div class="msg__label"><span class="k">briefing</span><span class="t">now</span></div>
      <p class="msg__body">${gates.length ? `${gates.length} gate${gates.length === 1 ? " is" : "s are"} on you.` : "Nothing needs a decision right now."} Ask me about any project or open a gate to review it.</p></div>`;
  const orch = orchestratorPanel("studio", status, briefingBody);

  return shell("levare · Studio", "Open registry", `<div class="app">${rail}${main}${orch}</div>`, status);
}

// ---------------------------------------------------------------------------
// PROJECT
// ---------------------------------------------------------------------------

export function renderProject(repo: Repo, projectName: string, root: string, now: Date = new Date(), running: DaemonInvocation[] = [], status: OrchestratorStatus = resolveOrchestratorStatus()): string {
  const project = repo.projects.get(projectName);
  if (!project) throw new Error(`unknown project '${projectName}'`);
  const units = repo.units.filter((u) => u.project === projectName);
  const founding = foundingArtifacts(repo, projectName);
  const gates = openGates(repo).filter((g) => g.project === projectName);

  const foundingHtml = founding.length
    ? founding
        .map(
          (f) =>
            `<div class="founding">${artifactTokenLink(projectName, f.artifact.unit, f.artifact.id, artifactFileName(f.artifact))}<span class="cite">cited ${f.citations}</span></div>`,
        )
        .join("\n")
    : `<div class="founding" style="color:var(--fg-mute)">no founding artifacts yet</div>`;

  const rail = railNav(repo, loadExtras(root));

  // Item 6d: releases — the most recent few (recentReleases caps at 3), the latest highlighted
  // distinctly rather than reading identically to its siblings.
  const releases = recentReleases(repo, projectName, 3);
  const releasesHtml = releases.length
    ? releases
        .map((u, i) => {
          const art = leadingArtifact(repo, u);
          const badge = i === 0 ? "latest" : art ? ageLabel(art.created, now) : "";
          return `<div class="founding${i === 0 ? " release--latest" : ""}">${tokenLink(projectName, u.unit, u.unit)}<span class="cite">${esc(badge)}</span></div>`;
        })
        .join("\n")
    : `<div class="founding" style="color:var(--fg-mute)">no releases yet</div>`;

  // Gate-review round 2, item 1: the project pointer + constitution + releases move out of the rail
  // (which is nav-only now) into a compact content-column panel at the top of the page — the same
  // `.card`/`.prow`/`.founding` vocabulary the registry already stacks multiple labeled sections
  // inside one card with. Item 6a: repo/deploy moved to icon links beside the title, so the pointer
  // card carries only `pace` now (item 6c: a colour-coded badge, not a plain-text row).
  const pointerPanel = `<div class="card">
    <div class="card__h">Pointer</div>
    <div class="prow"><span class="k">pace</span><span class="v">${paceBadge(project.pace)}</span></div>
    <div class="card__h" style="margin-top:6px">Constitution</div>
    ${foundingHtml}
    <div class="card__h" style="margin-top:6px">Releases</div>
    ${releasesHtml}
  </div>`;

  // UI2 items 2/3: repo/deploy render as a row of destination-recognisable icon links BELOW the
  // title (not beside it — that corner now belongs to the status badge, item 4). `project.repo` alone
  // (the SSH remote levare's own tooling clones from) isn't browsable for every project — the studio
  // project points `repo: .` at levare's own working tree with no `remote` — so the repo icon only
  // renders when there's a genuine external target: `remote` (the browsable https form) first, else
  // `repo` itself when it isn't the local "." sentinel.
  const repoTarget = project.remote || (project.repo !== "." ? project.repo : null);
  const pheadLinks = [repoTarget ? iconLink(repoTarget, "repo", "ti-brand-github") : "", project.deploy ? iconLink(project.deploy, "deploy", "ti-world") : ""].join("");

  // Item 6b: a status badge on the page header, matching the Studio project card's canonical status
  // exactly — same `projectStatusChip` call, same inputs (open-gate count, any active unit, live
  // members), so the two surfaces can never independently drift on what "active" looks like.
  const anyUnitActive = units.some((u) => u.status === "active");
  const membersRunningHere = running.filter((r) => r.project === projectName).length;
  const projectHeaderStatus = projectStatusChip(gates.length, anyUnitActive, membersRunningHere);

  const unitRows = units
    .map((u) => {
      const type = repo.types.get(u.type);
      const nodes = scoreNodes(repo, u);
      const gate = gates.find((g) => g.unit === u.unit);
      // Item 6e: the canonical status→colour map, not a hand-picked class — the same active-must-be-
      // blue fix as the Studio card (projectStatusChip).
      const chip = gate ? statusChip("needs-you", "at gate") : statusChip(fromWorkUnitStatus(u.status), u.status);
      const spend = unitSpend(repo, u);
      const artifacts = [...(repo.artifacts.get(`${u.project}/${u.unit}`)?.values() ?? [])].sort((a, b) => a.created.localeCompare(b.created));
      const artifactRows = artifacts
        .map((a) => {
          const ind = a.status === "approved" ? "ind-done" : a.status === "in-review" ? "ind-gate" : a.status === "superseded" ? "ind-super" : "ind-prog";
          const st = a.status === "in-review" ? `<span class="st gate">at gate</span>` : `<span class="st">${esc(a.status)}</span>`;
          const label = a.status === "superseded" ? `<s>${esc(artifactFileName(a))}</s>` : esc(artifactFileName(a));
          return `<div class="aitem"><span class="ind ${ind}"></span><a class="nm link mono" href="${artifactHref(u.project, u.unit, a.id)}">${label}</a>${st}</div>`;
        })
        .join("\n");
      const reviewRounds = artifacts.filter((a) => a.kind === "review").length;
      const summon = gate
        ? `<button class="verb is-secondary" data-summon="tpl-gate-${esc(gate.target)}">Review gate</button>`
        : "";
      const openCls = gate ? " is-open" : "";
      return `<div class="unit${openCls}">
        <div class="unit__head">
          <span class="unit__glyph">${type?.glyph ?? ""}</span>
          <div class="unit__titlewrap"><span class="unit__name">${esc(u.unit)}</span><a class="unit__path link mono" href="/run/${esc(u.project)}/${esc(u.unit)}">work/${esc(u.project)}/${esc(u.unit)}/</a></div>
          ${chip}
        </div>
        <div class="unit__desc">${esc(unitSummary(repo, u))}</div>
        ${miniScoreHtml(nodes)}
        <div class="unit__detail">
          ${artifactRows}
          <div class="unit__foot">${reviewRounds} review round${reviewRounds === 1 ? "" : "s"} &middot; ${gates.filter((g) => g.unit === u.unit).length} gate${gates.filter((g) => g.unit === u.unit).length === 1 ? "" : "s"} <span class="cost">&middot; ${spend.tokens} tok &middot; ~$${spend.usd.toFixed(2)}</span></div>
          <div class="unit__actions">
            <a class="verb is-primary" href="/run/${esc(u.project)}/${esc(u.unit)}">Open run view</a>
            ${summon}
          </div>
        </div>
      </div>`;
    })
    .join("\n");

  const templates = gates
    .map((g) => `<template id="tpl-gate-${esc(g.target)}">${gateCardHtml(repo, g, now, { cta: true, dispatching: dispatchingFor(running, g) })}</template>`)
    .join("\n");

  const reviewMedian = medianReviewRounds(repo, projectName);
  // UI2 items 4/5: the page header now reads title left, status badge right, on the SAME line — the
  // card contract (established UI1) applied to the page header itself — with the repo/deploy links as
  // their own row underneath (items 2/3). The stat strip moves ABOVE the pointer/constitution block
  // (item 5), matching the Studio page's own order: stats first, then content.
  const main = `<main class="main">
    <header class="phead">
      <div class="crumb"><a href="/studio">studio</a><span>/</span><span>${esc(projectName)}</span></div>
      <div class="phead__title"><h1>${esc(projectName)}</h1>${projectHeaderStatus}</div>
      ${pheadLinks ? `<div class="phead__links">${pheadLinks}</div>` : ""}
    </header>
    <div class="statstrip" style="grid-template-columns:repeat(5,1fr)">
      <div class="stat"><div class="n">${units.filter((u) => u.status === "shipped").length}</div><div class="l">Shipped units</div></div>
      <div class="stat"><div class="n">${units.filter((u) => u.status === "active").length}</div><div class="l">Active</div></div>
      <div class="stat"><div class="n">${gates.length}</div><div class="l">Gates open</div></div>
      <div class="stat"><div class="n">${reviewMedian === null ? "&mdash;" : reviewMedian}</div><div class="l">Median review rounds</div></div>
      <div class="stat"><div class="n">$${projectSpend(repo, projectName).toFixed(2)}</div><div class="l">Spend</div></div>
    </div>
    ${pointerPanel}
    <section class="sec"><div class="sec__h"><h2>Work units</h2></div><div class="units">${unitRows}</div></section>
  </main>`;

  const briefingBody = `<div class="msg"><div class="msg__label"><span class="k">briefing</span><span class="t">now</span></div>
      <p class="msg__body">${esc(projectName)} has ${gates.length} unit${gates.length === 1 ? "" : "s"} at a gate. Expand a unit to open its run or summon its gate here.</p></div>`;
  const orch = orchestratorPanel("project", status, briefingBody);

  return shell(`levare · ${projectName}`, "Open context", `<div class="app">${rail}${main}${orch}</div>${templates}`, status);
}

// ---------------------------------------------------------------------------
// RUN
// ---------------------------------------------------------------------------

export function renderRun(repo: Repo, project: string, unitId: string, root: string, now: Date = new Date(), running: DaemonInvocation[] = [], status: OrchestratorStatus = resolveOrchestratorStatus()): string {
  const unit = repo.units.find((u) => u.project === project && u.unit === unitId);
  if (!unit) throw new Error(`unknown unit '${project}/${unitId}'`);
  const type = repo.types.get(unit.type);
  const nodes = scoreNodes(repo, unit);
  const gates = openGates(repo).filter((g) => g.project === project && g.unit === unitId);

  const scoreSteps = nodes
    .map((n) => {
      const isGate = n.shape === "diamond";
      const nodeCls = n.state === "done" ? "done" : isGate ? "" : "";
      const snodeCls = scoreNodeClass(n, isGate);
      const av = n.producedBy ? `<div class="sstep__av">${memberAvatar(repo, n.producedBy)}</div>` : `<div class="sstep__av"></div>`;
      // NOTES UI1: "blocked" used to render with the SAME red inline style as "rejected" — a direct
      // violation of the design brief's canonical palette ("blocked = hollow neutral ... never
      // orange [or red]; failed = red" are two different states). Routed through the canonical map:
      // rejected is genuinely `failed` (red stays); blocked is genuinely `blocked` (hollow neutral).
      const chip =
        n.state === "done" ? statusChip("done", "approved", "sstep__chip")
        : n.state === "gate" ? statusChip("needs-you", "needs you", "sstep__chip")
        : n.state === "rejected" ? statusChip("failed", "rejected", "sstep__chip")
        // NOTES F3: a blocked-status artifact (a member ran and failed) previously showed only a small
        // colored dot with no label — the reason itself (now including the member's stderr) is a click
        // away via the artifact link already rendered in `sub`, but nothing told the Conductor to click.
        : n.state === "blocked" ? statusChip("blocked", "blocked", "sstep__chip")
        : "";
      const sub = n.artifact
        ? `${esc(n.artifact.produced_by)} &middot; ${artifactTokenLink(n.artifact.project, n.artifact.unit, n.artifact.id, artifactFileName(n.artifact))}`
        : "queued";
      return `<div class="sstep ${nodeCls}">
        <div class="sstep__rail"><span class="${snodeCls}" aria-hidden="true"></span><span class="sstep__line" aria-hidden="true"></span></div>
        ${av}
        <div class="sstep__body"><span class="sstep__label">${esc(n.kind)}</span><span class="sstep__sub">${sub}</span>${chip}</div>
      </div>`;
    })
    .join("\n");

  const rail = railNav(repo, loadExtras(root));

  const timeline = buildTimeline(root, unit.dir);
  const timelineHtml = timeline.length
    ? timeline
        .map((t) => `<div class="tlrow"><span class="tlrow__time mono">${esc(t.ts.slice(0, 16).replace("T", " "))}</span><span class="tlrow__text">${t.text}</span></div>`)
        .join("\n")
    : `<p style="color:var(--fg-mute);font-size:13.5px">No recorded events yet.</p>`;

  // Gate-review round 2, item 1: the score is this page's primary content, not navigation — it now
  // renders as its own content column beside the timeline (a plain inline flex row; no new CSS class,
  // the same inline-layout-override pattern the stat strips already use for their grid-template).
  const scoreCol = `<div style="flex:1 1 260px;min-width:220px">
    <div class="sec__h"><h2>Score</h2></div>
    <div class="score2" style="margin-top:14px">${scoreSteps}</div>
  </div>`;
  const timelineCol = `<div style="flex:2 1 360px;min-width:280px">
    <div class="sec__h"><h2>Timeline <span class="mono" style="color:var(--fg-mute);font-weight:400">&middot; from git log + runner events</span></h2></div>
    <div class="timeline">${timelineHtml}</div>
  </div>`;

  const main = `<main class="main">
    <header class="phead">
      <div class="crumb"><a href="/studio">studio</a><span>/</span><a href="/project/${esc(project)}">${esc(project)}</a><span>/</span><span>${esc(unitId)}</span></div>
      <h1><span style="font-family:var(--mono);font-weight:400;margin-right:8px" aria-hidden="true">${type?.glyph ?? ""}</span>${esc(unitId)}</h1>
    </header>
    <section class="sec">
      <div style="display:flex;gap:32px;align-items:flex-start;flex-wrap:wrap">${scoreCol}${timelineCol}</div>
    </section>
  </main>`;

  const gateHtml = gates.map((g) => gateCardHtml(repo, g, now, { cta: true, dispatching: dispatchingFor(running, g) })).join("\n");
  const briefingBody = `<div class="msg"><div class="msg__label"><span class="k">briefing</span><span class="t">now</span></div>
      <p class="msg__body">${gates.length ? `${esc(gates[0].label)} is ready for review below.` : "No open gate on this unit right now."}</p></div>`;
  const orch = orchestratorPanel("run", status, briefingBody, gateHtml);

  return shell(`levare · run · ${unitId}`, "Open score", `<div class="app">${rail}${main}${orch}</div>`, status);
}

// ---------------------------------------------------------------------------
// ARTIFACT / IDEA (item 1 + 6, phase 7.5) — the artifact render view. A read-only projection of one
// artifact or idea markdown file: frontmatter as a header block, body below, and navigable lineage
// (consumes, supersedes/superseded-by, cited-by). Every artifact id and idea name elsewhere in the
// product links here now, instead of falling back to the unit/run view — "the definition-browser
// pattern applied to work/" (design brief). Built entirely from existing component vocabulary
// (`.card`/`.card__h`/`.prow`/`.founding`/`.chip`) — no new visual language.
// ---------------------------------------------------------------------------

/** Split a markdown body into paragraphs; a line starting with `#`s renders as a heading, everything
 * else as a `<p>` (internal single newlines become `<br/>`). No markdown library — the same
 * paragraph-splitting rule `firstParagraph` (repo.ts, ruling A8) uses, just not truncated to one. */
function renderBody(body: string): string {
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

// Reuses `.founding`/`.cite` (already the "artifact reference + a badge" row, used for the project
// view's constitution list) for every lineage edge — consumes, supersedes, superseded-by, cited-by.
function lineageItem(art: Artifact, badge: string): string {
  return `<div class="founding">${artifactTokenLink(art.project, art.unit, art.id, artifactFileName(art))}<span class="cite">${esc(badge)}</span></div>`;
}
function lineageEmpty(text: string): string {
  return `<div class="founding" style="color:var(--fg-mute)">${esc(text)}</div>`;
}
function lineageUnresolved(id: string): string {
  return `<div class="founding" style="color:var(--fg-mute)"><span class="mono">${esc(id)}</span><span class="cite">unresolved</span></div>`;
}

export function renderArtifact(repo: Repo, project: string, unit: string, id: string, root: string, now: Date = new Date(), status: OrchestratorStatus = resolveOrchestratorStatus()): string {
  const art = repo.artifacts.get(`${project}/${unit}`)?.get(id);
  if (!art) throw new Error(`unknown artifact '${project}/${unit}/${id}'`);

  // NOTES UI1: routed through the canonical status→colour map — "rejected" used to be a bespoke red
  // inline style, "superseded"/"draft"/"skipped" a mix of ad hoc classes; the label text for each is
  // preserved verbatim, only the colour decision moved to status.ts.
  const artStatusChip =
    art.status === "in-review" ? statusChip("needs-you", "at gate")
    : art.status === "superseded" ? statusChip("waiting", "superseded")
    : statusChip(fromArtifactStatus(art.status), art.status);

  const consumesHtml = art.consumes.length
    ? art.consumes
        .map((cid) => {
          const c = findArtifactInProject(repo, project, cid);
          return c ? lineageItem(c, c.kind) : lineageUnresolved(cid);
        })
        .join("\n")
    : lineageEmpty("consumes nothing — a founding artifact");

  const supersedesArt = art.supersedes ? findArtifactInProject(repo, project, art.supersedes) : undefined;
  const supersedesHtml = !art.supersedes
    ? lineageEmpty("supersedes nothing")
    : supersedesArt
      ? lineageItem(supersedesArt, supersedesArt.kind)
      : lineageUnresolved(art.supersedes);

  const supersededBy = supersededByOf(repo, project, id);
  const supersededByHtml = supersededBy ? lineageItem(supersededBy, supersededBy.kind) : lineageEmpty("not superseded");

  const citedBy = citedByOf(repo, project, id);
  const citedByHtml = citedBy.length ? citedBy.map((a) => lineageItem(a, a.kind)).join("\n") : lineageEmpty("not cited yet");

  // Item 1, gate-review round 2: no page-specific "Context" section in the rail anymore — the
  // breadcrumb below already carries studio → project → unit → artifact as linked segments.
  const rail = railNav(repo, loadExtras(root));

  const frontmatter = `<div class="card">
    <div class="card__h">Frontmatter</div>
    <div class="prow"><span class="k">kind</span><span class="v mono">${esc(art.kind)}</span></div>
    <div class="prow"><span class="k">id</span><span class="v mono">${esc(art.id)}</span></div>
    <div class="prow"><span class="k">status</span><span class="v">${artStatusChip}</span></div>
    <div class="prow"><span class="k">produced by</span><span class="v">${memberAvatar(repo, art.produced_by, { size: "sm" })} <span class="mono">${esc(art.produced_by)}</span></span></div>
    <div class="prow"><span class="k">created</span><span class="v mono">${esc(art.created)} &middot; ${esc(ageLabel(art.created, now))}</span></div>
    <div class="prow"><span class="k">approved by</span><span class="v mono">${art.approved_by ? esc(art.approved_by) : "&mdash;"}</span></div>
    ${art.files.length ? `<div class="prow"><span class="k">files</span><span class="v mono">${art.files.map(esc).join(", ")}</span></div>` : ""}
    ${costLabel(art.usage) ? `<div class="prow"><span class="k">cost</span><span class="v cost">${costLabel(art.usage)}</span></div>` : ""}
  </div>`;

  const bodyCard = `<div class="card">
    <div class="card__h">Body</div>
    ${renderBody(art.body ?? "") || `<p style="color:var(--fg-mute);font-size:13.5px">No body content.</p>`}
  </div>`;

  const lineageCard = `<div class="card">
    <div class="card__h">Lineage</div>
    <h3 class="railsec__h">Consumes</h3>${consumesHtml}
    <h3 class="railsec__h" style="margin-top:8px">Supersedes</h3>${supersedesHtml}
    <h3 class="railsec__h" style="margin-top:8px">Superseded by</h3>${supersededByHtml}
    <h3 class="railsec__h" style="margin-top:8px">Cited by</h3>${citedByHtml}
  </div>`;

  const breadcrumb = `<div class="crumb"><a href="/studio">studio</a><span>/</span><a href="/project/${esc(project)}">${esc(project)}</a><span>/</span><a href="/run/${esc(project)}/${esc(unit)}">${esc(unit)}</a><span>/</span><span class="mono">${esc(art.id)}</span></div>`;
  const main = `<main class="main">
    <header class="phead">
      ${breadcrumb}
      <h1>${esc(art.kind)} <span class="mono" style="font-weight:400;color:var(--fg-mute);font-size:.6em;margin-left:8px">${esc(art.id)}</span></h1>
    </header>
    ${frontmatter}
    ${bodyCard}
    ${lineageCard}
  </main>`;

  const briefingBody = `<div class="msg"><div class="msg__label"><span class="k">briefing</span><span class="t">now</span></div>
      <p class="msg__body">${esc(art.kind)} ${esc(art.id)}, produced by ${esc(art.produced_by)}. ${citedBy.length ? `Cited by ${citedBy.length} artifact${citedBy.length === 1 ? "" : "s"}.` : "Not cited by anything yet."}</p></div>`;
  const orch = orchestratorPanel("artifact", status, briefingBody);

  return shell(`levare · ${art.kind} · ${art.id}`, "Open context", `<div class="app">${rail}${main}${orch}</div>`, status);
}

export function renderIdea(repo: Repo, root: string, name: string, status: OrchestratorStatus = resolveOrchestratorStatus()): string {
  const extras = loadExtras(root);
  const idea = extras.ideas.find((i) => i.name === name);
  if (!idea) throw new Error(`unknown idea '${name}'`);

  const pitch = typeof idea.data.pitch === "string" ? idea.data.pitch : "";
  const tags = Array.isArray(idea.data.tags) ? (idea.data.tags as unknown[]).map((t) => String(t)) : [];

  const rail = railNav(repo, extras);

  const frontmatter = `<div class="card">
    <div class="card__h">Frontmatter</div>
    <div class="prow"><span class="k">name</span><span class="v mono">${esc(idea.name)}</span></div>
    ${pitch ? `<div class="prow"><span class="k">pitch</span><span class="v">${esc(pitch)}</span></div>` : ""}
    ${tags.length ? `<div class="prow"><span class="k">tags</span><span class="v mono">${tags.map((t) => esc(t)).join(", ")}</span></div>` : ""}
  </div>`;

  const bodyCard = `<div class="card">
    <div class="card__h">Body</div>
    ${renderBody(idea.body) || `<p style="color:var(--fg-mute);font-size:13.5px">No body content.</p>`}
  </div>`;

  // No project/unit references an idea back (the schema has no "promoted from" field) — an honest
  // "nothing yet" rather than a fabricated lineage edge, matching the rest of the board's empty states.
  const lineageCard = `<div class="card">
    <div class="card__h">Lineage</div>
    ${lineageEmpty("A captured pitch with no project yet — nothing consumes, supersedes, or cites it.")}
  </div>`;

  const main = `<main class="main">
    <header class="phead">
      <div class="crumb"><a href="/studio">studio</a><span>/</span><span class="mono">${esc(idea.name)}</span></div>
      <h1>${esc(idea.name)}</h1>
    </header>
    ${frontmatter}
    ${bodyCard}
    ${lineageCard}
  </main>`;

  const briefingBody = `<div class="msg"><div class="msg__label"><span class="k">briefing</span><span class="t">now</span></div>
      <p class="msg__body">${esc(idea.name)} is a captured pitch with no project yet. Promoting it opens an inception unit.</p></div>`;
  const orch = orchestratorPanel("idea", status, briefingBody);

  return shell(`levare · idea · ${idea.name}`, "Open context", `<div class="app">${rail}${main}${orch}</div>`, status);
}

// ---------------------------------------------------------------------------
// REGISTRY
// ---------------------------------------------------------------------------

// One bordered container per entity — the same `.card` recipe (background, border, radius, padding)
// every other screen's bordered containers use (gate cards, unit rows, project cards each have their
// own such class; the registry reuses `.card`, the one already used for a labeled panel, rather than
// inventing a new one). `.entity` stays alongside it purely for the kind-switch JS hook in app.js —
// it contributes no visual styling of its own beyond the flex layout `.card` already sets.
//
// UI3: "Edit source" no longer reveals an inline, wrapping-cramped textarea inside the card — it opens
// the SHARED overlay editor (one instance per page, see `editorOverlay()` below) as a proper overlay
// above the board, per the design brief's "Registry" section ("Edit source toggles raw markdown") read
// together with the goal's overlay requirement. The card itself carries only: the trigger button
// (`data-edit-open`, plus the entity's plain name/kind as data attributes so the overlay can title
// itself without a second fetch) and a HIDDEN `<textarea class="rawmd-source">` holding the entity's
// on-disk raw markdown — still just raw text, no form fields (honoring "no form-based authoring,
// ever"), just no longer the editing surface itself. `data-path` (on both the article and the trigger)
// carries the entity's repo-relative file so app.js can target both `POST /registry/*path` (save) and
// `POST /registry/check/*path` (live validation of the unsaved buffer) without a second lookup.
function entityBlock(kind: RegistryKind, title: string, kindLabel: string, inner: string, raw: string, name: string, active: boolean): string {
  const relPath = `${kind}/${name}.md`;
  // `id` (item 4b): a stable per-entity anchor so a rail row can deep-link to exactly this card
  // (e.g. a connector row → `/registry?entity=connectors#connectors-github`) with plain browser
  // anchor scrolling — no new client-side JS.
  return `<article class="entity card" id="${kind}-${esc(name)}" data-entity="${kind}" data-path="${esc(relPath)}"${active ? "" : ' style="display:none"'}>
    <div class="entity__head"><span class="entity__title">${title}</span><span class="entity__kind">${esc(kindLabel)}</span></div>
    <div class="rendered">${inner}</div>
    <textarea class="rawmd-source" data-path="${esc(relPath)}" hidden>${esc(raw)}</textarea>
    <div class="editbar">
      <button class="togglebtn" data-edit-open data-path="${esc(relPath)}" data-editor-name="${esc(name)}" data-editor-kind="${esc(kindLabel)}">Edit source</button>
    </div>
  </article>`;
}

// UI3: the overlay editor itself — ONE instance per registry page (not one per entity), populated by
// app.js from whichever card's `data-edit-open` was clicked. A centered panel over a dimmed backdrop
// (design brief: "a centered panel over a dimmed backdrop"), not a route — `hidden` by default so it
// never changes what's in the DOM's flow, only whether it paints; the board underneath is untouched.
// `role="dialog" aria-modal="true"` for assistive tech; the heading is populated from the trigger's
// `data-editor-name`/`data-editor-kind` (the entity's name and kind, per the goal). The validity
// indicator and error list are live — app.js debounces keystrokes into `POST /registry/check/*path`,
// which runs the SAME validator `levare validate` and the save route both use, against the unsaved
// buffer (see validate.ts's `overlay` param) — never a second, client-side implementation of any rule.
function editorOverlay(): string {
  return `<div class="editor-overlay" id="editor-overlay" hidden>
    <div class="editor-overlay__backdrop" data-editor-backdrop></div>
    <div class="editor-overlay__panel" role="dialog" aria-modal="true" aria-labelledby="editor-overlay-title">
      <header class="editor-overlay__head">
        <h2 class="editor-overlay__title" id="editor-overlay-title"></h2>
        <span class="editor-overlay__kind mono"></span>
      </header>
      <textarea class="editor-overlay__textarea" spellcheck="false"></textarea>
      <div class="editor-overlay__foot">
        <div class="editor-overlay__status">
          <span class="validity"><span class="status-dot is-ok"></span>valid</span>
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

// UI4 item 4: `highlightName`, when set, names the specific entity a path-form deep link
// (`/registry/<kind>/<name>`) pointed at — the SAME list view as `/registry/<kind>` alone, just
// scrolled to and highlighting that one entity, preserving the old fragment-anchor deep link's
// behavior without a new detail-page screen. Resolved here (not left to the client) into the exact
// `id` `entityBlock` already gives that card, so app.js only has to look one element up, never
// re-derive the id itself from the URL.
export function renderRegistry(repo: Repo, root: string, activeEntity?: string, status: OrchestratorStatus = resolveOrchestratorStatus(), highlightName?: string): string {
  const extras = loadExtras(root);
  const active: RegistryKind = REGISTRY_KINDS.includes(activeEntity as RegistryKind) ? (activeEntity as RegistryKind) : "teams";
  const highlightId = highlightName ? `${active}-${highlightName}` : undefined;

  const rail = railNav(repo, extras, { activeRegistryEntity: active });

  // Item 1, gate-review round 2: the entity switcher moves out of the rail (nav-only now) into an
  // in-content tab strip at the top of the page — the exact same link list (`registryNavLinks`, so it
  // can never drift from the rail's own Registry section), just laid out horizontally via an inline
  // style override on the existing `.reg-nav` rule (the same "reuse the rule, override the one layout
  // property inline" pattern the stat strips already use for their grid-template-columns).
  const tabStrip = `<nav class="reg-nav" style="flex-direction:row;flex-wrap:wrap;gap:4px 18px">${registryNavLinks(repo, extras, active)}</nav>`;

  const teamBlocks = [...repo.teams.values()]
    .map((t) => {
      const inner = `<div class="card__h">Declared flow</div><div class="flowstrip">${t.members
        .map((m) => `<div class="m">${avatar(repo.agents.get(m)?.style.avatar ?? m.slice(0, 2), t.style.color)}<span class="mn">${esc(m)}</span></div>`)
        .join('<span class="arr">&rarr;</span>')}</div>
      <div class="card__h">Definition</div>
      <div class="prow"><span class="k">color</span><span class="v mono" style="color:${esc(t.style.color)}">${esc(t.style.color)}</span></div>
      <div class="prow"><span class="k">members</span><span class="v">${t.members.length} &middot; ${t.members.map(esc).join(", ")}</span></div>
      <div class="prow"><span class="k">produces</span><span class="v mono">${t.produces.map(esc).join(", ")}</span></div>`;
      return entityBlock("teams", `<span class="sq" style="width:16px;height:16px;border-radius:4px;background:${esc(t.style.color)}"></span> ${esc(t.name)}`, "team", inner, rawFor(root, "teams", t.name), t.name, active === "teams");
    })
    .join("\n");

  const agentBlocks = [...repo.agents.values()]
    .map((a) => {
      const team = [...repo.teams.values()].find((t) => t.members.includes(a.name));
      const recipe = [...(a.skills ?? []), ...(a.knowledge ?? [])].map((p) => `<a class="pill" href="#">${esc(p)}</a>`).join("\n");
      const inner = `<div class="card__h">Context recipe</div><div class="recipe">${recipe || '<span style="color:var(--fg-mute)">none declared</span>'}</div>
      <div class="card__h">Definition</div>
      <div class="prow"><span class="k">kind</span><span class="v mono">${esc(a.kind)}</span></div>
      ${a.model ? `<div class="prow"><span class="k">model</span><span class="v mono">${esc(a.model)}</span></div>` : ""}
      ${team ? `<div class="prow"><span class="k">wears</span><span class="v"><span class="sq" style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${esc(team.style.color)};vertical-align:middle"></span> ${esc(team.name)}</span></div>` : ""}`;
      // UI4 item 3: the top-right tag is the bare entity type, same as every other kind ("team",
      // "connector", ...) — an agent's team association stays visible on the card via the "wears" row
      // above, it just no longer rides along in the kind tag itself.
      return entityBlock("agents", `${avatar(a.style.avatar || a.name.slice(0, 2), team?.style.color, { size: "lg" })} ${esc(a.name)}`, "agent", inner, rawFor(root, "agents", a.name), a.name, active === "agents");
    })
    .join("\n");

  const skillBlocks = extras.skills
    .map((s) => {
      const inner = `<div class="card__h">SKILL.md</div><p style="margin:0;font-size:13.5px;line-height:1.6;color:var(--fg-dim)">${esc(String(s.data.description ?? firstParagraph(s.body)))}</p>`;
      return entityBlock("skills", esc(s.name), "skill", inner, rawFor(root, "skills", s.name), s.name, active === "skills");
    })
    .join("\n");

  const knowledgeBlocks = extras.knowledge
    .map((k) => {
      const referencedBy: string[] = [];
      for (const a of repo.agents.values()) if ((a.knowledge ?? []).includes(k.name)) referencedBy.push(`${a.name} (agent)`);
      for (const t of repo.teams.values()) if ((t.knowledge ?? []).includes(k.name)) referencedBy.push(`${t.name} (team default)`);
      const inner = `<div class="card__h">Injected into</div>${
        referencedBy.length ? referencedBy.map((r) => `<div class="backlink">${esc(r)}</div>`).join("\n") : '<span style="color:var(--fg-mute)">not referenced yet</span>'
      }`;
      return entityBlock("knowledge", esc(k.name), "knowledge", inner, rawFor(root, "knowledge", k.name), k.name, active === "knowledge");
    })
    .join("\n");

  const typeBlocks = [...repo.types.values()]
    .map((t) => {
      const inner = `<div class="card__h">Expected kinds</div>
      <div class="prow"><span class="k">glyph</span><span class="v mono">${t.glyph}</span></div>
      <div class="prow"><span class="k">expects</span><span class="v mono">${t.expects.map(esc).join(" &rarr; ")}</span></div>
      <div class="prow"><span class="k">gates</span><span class="v">${t.gates.map(esc).join(", ")}</span></div>`;
      return entityBlock("types", `<span style="font-family:var(--mono)">${t.glyph} ${esc(t.name)}</span>`, "type", inner, rawFor(root, "types", t.name), t.name, active === "types");
    })
    .join("\n");

  const connectorBlocks = [...repo.connectors.values()]
    .map((c) => {
      // NOTES C13: the board must never imply a scoping guarantee levare isn't providing — an
      // `auth: subscription` connector's card says so plainly, not just its `auth` value. NOTES UI1:
      // this used to hardcode `var(--warn,#b45309)`, a colour outside the design brief's palette
      // (the brief bans a general-purpose "warn" hue outright: "anything tempted toward amber is
      // either needs-you (brass, gate-shaped) or failed (red), or it renders neutral with text") — a
      // fact, not a gate or a failure, so it now renders neutral, like every other informational row.
      const authWarning =
        c.auth === "subscription"
          ? `<div class="prow"><span class="k"></span><span class="v" style="color:var(--fg-dim)">levare cannot scope this credential — any member that can spawn \`${esc(c.command ?? c.name)}\` can use this login. The grant is documentation, not enforcement.</span></div>`
          : "";
      const inner = `<div class="card__h">Definition</div>
      <div class="prow"><span class="k">kind</span><span class="v mono">${esc(c.kind)}</span></div>
      <div class="prow"><span class="k">auth</span><span class="v mono">${esc(c.auth)}${c.plan ? ` · ${esc(c.plan)}` : ""}</span></div>
      <div class="prow"><span class="k">env</span><span class="v mono">${c.env.map(esc).join(", ")}</span></div>${authWarning}`;
      return entityBlock("connectors", esc(c.name), "connector", inner, rawFor(root, "connectors", c.name), c.name, active === "connectors");
    })
    .join("\n");

  const evalBlocks = extras.evals
    .map((e) => {
      const rubric = Array.isArray(e.data.rubric) ? (e.data.rubric as string[]) : [];
      const inner = `<div class="card__h">Rubric</div>${rubric.map((r) => `<div class="prow"><span class="v">${esc(String(r))}</span></div>`).join("\n")}`;
      return entityBlock("evals", esc(e.name), "eval", inner, rawFor(root, "evals", e.name), e.name, active === "evals");
    })
    .join("\n");

  // Item 3, gate-review round 2: grid the cards (same `.pcards` grid component the studio project
  // cards already use) instead of one-per-row full-width, so agents/skills/types/connectors flow two
  // or three across. Only the active kind's articles are ever visible (`entityBlock`'s own
  // `display:none` on the rest), so one shared grid — not seven — is enough; a hidden `display:none`
  // article occupies no grid track. `minmax(320px,1fr)` per the review (wider than `.pcards`' own
  // 220px default, since an entity card carries more content than a project card); team/agent cards
  // may still span visually wider rows when their flow-strip/recipe content needs it — flex-wrap
  // inside those already handles that without any extra CSS.
  const main = `<main class="main"${highlightId ? ` data-highlight="${esc(highlightId)}"` : ""}>
    <header class="phead">
      <div class="crumb"><a href="/studio">studio</a><span>/</span><span>registry</span></div>
      <h1>Registry</h1>
    </header>
    ${tabStrip}
    <div class="pcards" style="grid-template-columns:repeat(auto-fill,minmax(320px,1fr))">
      ${teamBlocks}${agentBlocks}${skillBlocks}${knowledgeBlocks}${typeBlocks}${connectorBlocks}${evalBlocks}
    </div>
  </main>`;

  const briefingBody = `<div class="msg"><div class="msg__label"><span class="k">briefing</span><span class="t">now</span></div>
      <p class="msg__body">This is the registry. The only write here is <span class="mono">Edit source</span>: raw markdown, live validation, then <span class="mono">Save and commit</span>.</p></div>`;
  const orch = orchestratorPanel("registry", status, briefingBody);

  // The overlay is a sibling of `.app`, not nested inside it and not a second page — the board (rail,
  // main, orchestrator) stays exactly as rendered whether or not the overlay is open (UI3 requirement:
  // "does not change the URL or unmount the page behind it").
  return shell("levare · registry", "Open registry nav", `<div class="app">${rail}${main}${orch}</div>${editorOverlay()}`, status);
}

function rawFor(root: string, dir: string, name: string): string {
  try {
    return readFileSync(`${root}/${dir}/${name}.md`, "utf8");
  } catch {
    return "";
  }
}

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
import { getVersionInfo } from "../version.ts";
import { dotClass, snodeClass, statusLabel, fromWorkUnitStatus, fromArtifactStatus, fromNodeState } from "./status.ts";
import { statusBadge, paceBadge, tag, iconLink, statStrip, counter, emptyState, pendingState, card, confirmModal, editorOverlay } from "./components.ts";

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
${confirmModal()}
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

function avatar(initials: string, color: string | undefined, opts: { size?: "sm" | "lg"; blink?: boolean; title?: string } = {}): string {
  const size = opts.size ?? "sm";
  const bg = color && color.trim() ? color : "#666";
  const blinkCls = opts.blink ? " blink" : "";
  const titleAttr = opts.title ? ` title="${esc(opts.title)}"` : "";
  return `<span class="avatar ${size}${blinkCls}"${titleAttr} style="background:${esc(bg)}">${esc(initials.toLowerCase())}</span>`;
}

function memberAvatar(repo: Repo, producedBy: string, opts: { size?: "sm" | "lg"; blink?: boolean } = {}): string {
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
function agentKindBadge(kind: "native" | "cli" | "remote"): string {
  return `<span class="kindbadge kindbadge--${kind}">${esc(kind)}</span>`;
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
  return `<div class="gate__verbs gate__verbs--pending">${pendingState({ label: `dispatching ${member} · ${kind}…` })}</div>`;
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
  if (projGates > 0) return statusBadge("needs-you", `${projGates} gate${projGates === 1 ? "" : "s"}`);
  if (anyUnitActive || membersRunning > 0) return statusBadge("active");
  return statusBadge("waiting", "idle");
}

// Phase 8, deliverable c: retires NOTES E2. Reuses `.tlrow` (the timeline's own row anatomy) and
// `.avatar--runner` — a class already declared in the frozen stylesheet for exactly this identity but
// never emitted by any renderer until now (the same "dormant, already-designed rule" shape as G1's
// `.snode.is-danger` before it was wired up) — so this needed zero new CSS.
function runningNowHtml(running: DaemonInvocation[], now: Date): string {
  if (running.length === 0) {
    return emptyState({ message: "Nothing running right now." });
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
    : emptyState({ message: "Nothing needs you right now." });

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
      return card({
        as: "a",
        cls: "pcard",
        href: `/project/${p.name}`,
        topCls: "pcard__top",
        title: esc(p.name),
        titleCls: "pcard__name",
        status: chip,
        body: `<span class="pcard__desc">${desc}</span>`,
        meta: `<div class="pcard__meta mono">${metaParts.map((m) => `<span>${m}</span>`).join("")}</div>`,
      });
    })
    .join("\n");

  const main = `<main class="main">
    <header class="phead">
      <div class="crumb"><span>studio</span></div>
      <h1>Studio</h1>
    </header>
    ${statStrip([
      { value: `${gates.length}`, label: "Gates on you", cls: "is-gate", attr: { name: "data-gatestat", value: gates.length } },
      { value: `${running.length}`, label: "Members running", attr: { name: "data-runningstat", value: running.length } },
      { value: `${shippedUnits}`, label: "Units shipped &middot; 30d" },
      { value: median === null ? "&mdash;" : `${median.toFixed(median % 1 === 0 ? 0 : 1)}d`, label: "Median gate response" },
      { value: `$${spend.toFixed(2)}`, label: "Spend &middot; 30d" },
    ])}
    <section class="sec" id="needs">
      <div class="sec__h"><h2>Needs you</h2>${counter(gates.length, { gatecount: true })}</div>
      ${gateCards}
    </section>
    <section class="sec">
      <div class="sec__h"><h2>Running now</h2>${counter(running.length)}</div>
      ${runningNowHtml(running, now)}
    </section>
    <section class="sec">
      <div class="sec__h"><h2>In flight</h2>${counter(inFlightProjects.length)}</div>
      ${inFlightProjects.length
        ? `<div class="pcards">${projectCards}</div>`
        : emptyState({ message: "Nothing in flight.", action: "Open a project from the sidebar to start a unit." })}
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
  const pheadLinks = [
    repoTarget ? iconLink({ icon: "ti-brand-github", href: repoTarget, label: "repo" }) : "",
    project.deploy ? iconLink({ icon: "ti-world", href: project.deploy, label: "deploy" }) : "",
  ].join("");

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
      const chip = gate ? statusBadge("needs-you", "at gate") : statusBadge(fromWorkUnitStatus(u.status), u.status);
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
      // The work-unit row: `card()`'s row variant — a type glyph as `pre`, the title/path wrapper as a
      // pre-built `title` block (already self-contained, so no extra `titleCls` wrap), the status chip
      // top-right, and the collapsed summary (desc + mini-score) plus the expand-in-place detail as
      // `body`/`meta` — the same top-left title / top-right status / bottom supporting-content anatomy
      // every other card type uses, just with its own `.unit`/`.unit__*` class family (design brief:
      // the STRUCTURE is shared, the CSS vocabulary stays per-surface — see components.ts#card).
      return card({
        cls: `unit${openCls}`,
        topCls: "unit__head",
        pre: `<span class="unit__glyph">${type?.glyph ?? ""}</span>`,
        title: `<div class="unit__titlewrap"><span class="unit__name">${esc(u.unit)}</span><a class="unit__path link mono" href="/run/${esc(u.project)}/${esc(u.unit)}">work/${esc(u.project)}/${esc(u.unit)}/</a></div>`,
        status: chip,
        body: `<div class="unit__desc">${esc(unitSummary(repo, u))}</div>\n        ${miniScoreHtml(nodes)}`,
        meta: `<div class="unit__detail">
          ${artifactRows}
          <div class="unit__foot">${reviewRounds} review round${reviewRounds === 1 ? "" : "s"} &middot; ${gates.filter((g) => g.unit === u.unit).length} gate${gates.filter((g) => g.unit === u.unit).length === 1 ? "" : "s"} <span class="cost">&middot; ${spend.tokens} tok &middot; ~$${spend.usd.toFixed(2)}</span></div>
          <div class="unit__actions">
            <a class="verb is-primary" href="/run/${esc(u.project)}/${esc(u.unit)}">Open run view</a>
            ${summon}
          </div>
        </div>`,
      });
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
    ${statStrip([
      { value: `${units.filter((u) => u.status === "shipped").length}`, label: "Shipped units" },
      { value: `${units.filter((u) => u.status === "active").length}`, label: "Active" },
      { value: `${gates.length}`, label: "Gates open" },
      { value: reviewMedian === null ? "&mdash;" : `${reviewMedian}`, label: "Median review rounds" },
      { value: `$${projectSpend(repo, projectName).toFixed(2)}`, label: "Spend" },
    ])}
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
        n.state === "done" ? statusBadge("done", "approved", "sstep__chip")
        : n.state === "gate" ? statusBadge("needs-you", "needs you", "sstep__chip")
        : n.state === "rejected" ? statusBadge("failed", "rejected", "sstep__chip")
        // NOTES F3: a blocked-status artifact (a member ran and failed) previously showed only a small
        // colored dot with no label — the reason itself (now including the member's stderr) is a click
        // away via the artifact link already rendered in `sub`, but nothing told the Conductor to click.
        : n.state === "blocked" ? statusBadge("blocked", "blocked", "sstep__chip")
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
    : emptyState({ message: "No recorded events yet." });

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
    art.status === "in-review" ? statusBadge("needs-you", "at gate")
    : art.status === "superseded" ? statusBadge("waiting", "superseded")
    : statusBadge(fromArtifactStatus(art.status), art.status);

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

// One bordered container per entity, built through the shared `card()` primitive (components.ts) —
// the same title-top-left/status-top-right/supporting-content-bottom contract the studio project card
// and the work-unit row use, with the registry's own `.entity`/`.entity__*` class family (the `.card`
// class rides along for the shared background/border/radius/padding recipe every bordered container on
// the board uses). `.entity` stays alongside it purely for the kind-switch JS hook in app.js.
//
// UI3: "Edit source" no longer reveals an inline, wrapping-cramped textarea inside the card — it opens
// the SHARED overlay editor (one instance per page, components.ts#editorOverlay) as a proper overlay
// above the board, per the design brief's "Registry" section ("Edit source toggles raw markdown") read
// together with the goal's overlay requirement. The card itself carries only: the trigger button
// (`data-edit-open`, plus the entity's plain name/kind as data attributes so the overlay can title
// itself without a second fetch) and a HIDDEN `<textarea class="rawmd-source">` holding the entity's
// on-disk raw markdown — still just raw text, no form fields (honoring "no form-based authoring,
// ever"), just no longer the editing surface itself. `data-path` (on both the article and the trigger)
// carries the entity's repo-relative file so app.js can target both `POST /registry/*path` (save) and
// `POST /registry/check/*path` (live validation of the unsaved buffer) without a second lookup.
// UI7 (RULE A): a card on its own entity's page doesn't repeat its kind — the kind is already the
// URL/page it lives on (`/registry/<kind>`). `showKindTag` lets a call site drop the top-right
// `.entity__kind` tag entirely rather than printing e.g. "team" on every team card; `data-editor-kind`
// (the overlay's heading) still gets the real kind label regardless, since the overlay is a shared
// modal that needs to say what it's editing.
// `accentColor`, when given, replaces the identity swatch/hex text some entities used to print with a
// left-edge border in the entity's own declared colour — the colour becomes the card's identity, not a
// value rendered on it (RULE B: a team's declared hue is the one colour-as-identity exception).
function entityBlock(kind: RegistryKind, title: string, kindLabel: string, inner: string, relPath: string, raw: string, name: string, active: boolean, opts: { showKindTag?: boolean; accentColor?: string } = {}): string {
  const showKindTag = opts.showKindTag ?? true;
  const styleParts: string[] = [];
  if (!active) styleParts.push("display:none");
  if (opts.accentColor) styleParts.push(`border-left:2px solid ${opts.accentColor}`);
  // `id` (item 4b): a stable per-entity anchor so a rail row can deep-link to exactly this card
  // (e.g. a connector row → `/registry?entity=connectors#connectors-github`) with plain browser
  // anchor scrolling — no new client-side JS.
  return card({
    as: "article",
    cls: "entity card",
    attrs: {
      id: `${kind}-${name}`,
      "data-entity": kind,
      "data-path": relPath,
      ...(styleParts.length ? { style: styleParts.join(";") } : {}),
    },
    topCls: "entity__head",
    title,
    titleCls: "entity__title",
    status: showKindTag ? tag(kindLabel) : "",
    body: `<div class="rendered">${inner}</div>`,
    meta: `<textarea class="rawmd-source" data-path="${esc(relPath)}" hidden>${esc(raw)}</textarea>
    <div class="editbar">
      <button class="togglebtn" data-edit-open data-path="${esc(relPath)}" data-editor-name="${esc(name)}" data-editor-kind="${esc(kindLabel)}">Edit source</button>
    </div>`,
  });
}

// UI3: the overlay editor itself — ONE instance per registry page (not one per entity), populated by
// app.js from whichever card's `data-edit-open` was clicked. NOTES UI6: moved into components.ts
// (`editorOverlay`) alongside `confirmModal` as the board's shared overlay-surface primitives.

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
  const title = active.charAt(0).toUpperCase() + active.slice(1);

  const teamBlocks = [...repo.teams.values()]
    .map((t) => {
      // UI7: the flow strip shows who runs each step by avatar alone — the name moves to the
      // avatar's hover title (RULE A/B: shape+colour carry identity, no name text printed per step).
      const flow = t.members
        .map((m) => `<div class="m">${avatar(repo.agents.get(m)?.style.avatar ?? m.slice(0, 2), t.style.color, { title: m })}</div>`)
        .join('<span class="arr">&rarr;</span>');
      const memberAvatars = t.members.map((m) => avatar(repo.agents.get(m)?.style.avatar ?? m.slice(0, 2), t.style.color, { title: m })).join("");
      const producesChips = t.produces.map((p) => tag(p, "tag")).join("");
      const inner = `<div class="card__h">Declared flow</div><div class="flowstrip">${flow}</div>
      <div class="card__h">Definition</div>
      <div class="prow"><span class="k">members</span><span class="v chiprow">${memberAvatars}</span></div>
      <div class="prow"><span class="k">produces</span><span class="v chiprow">${producesChips}</span></div>`;
      // UI7: no "team" kind tag (RULE A) — the declared colour, now a left-edge card border, is the
      // card's identity instead of a swatch/hex value printed inside it.
      return entityBlock("teams", esc(t.name), "team", inner, `teams/${t.name}.md`, rawFor(root, "teams", t.name), t.name, active === "teams", { showKindTag: false, accentColor: t.style.color });
    })
    .join("\n");

  const agentBlocks = [...repo.agents.values()]
    .map((a) => {
      const team = [...repo.teams.values()].find((t) => t.members.includes(a.name));
      const recipe = [...(a.skills ?? []), ...(a.knowledge ?? [])].map((p) => `<a class="pill" href="#">${esc(p)}</a>`).join("\n");
      const producesChips = a.produces.map((p) => tag(p, "tag")).join("");
      // UI7: kind+model render adjacent ("native · claude-sonnet-5") in one row, the kind itself a
      // shape/treatment badge (RULE B — never colour); no "wears <team>" row (RULE A — the avatar
      // above is already tinted with the team's colour, so the team is shown, not told).
      const inner = `<div class="card__h">Context recipe</div><div class="recipe">${recipe || '<span style="color:var(--fg-mute)">none declared</span>'}</div>
      <div class="card__h">Definition</div>
      <div class="prow"><span class="k">kind</span><span class="v">${agentKindBadge(a.kind)}${a.model ? ` <span class="mono">&middot; ${esc(a.model)}</span>` : ""}</span></div>
      <div class="prow"><span class="k">produces</span><span class="v chiprow">${producesChips}</span></div>`;
      // UI7: no "agent" kind tag (RULE A) — the kind is already the page/URL this card lives on.
      return entityBlock("agents", `${avatar(a.style.avatar || a.name.slice(0, 2), team?.style.color, { size: "lg" })} ${esc(a.name)}`, "agent", inner, `agents/${a.name}.md`, rawFor(root, "agents", a.name), a.name, active === "agents", { showKindTag: false });
    })
    .join("\n");

  const skillBlocks = extras.skills
    .map((s) => {
      // UI7: no "SKILL.md" heading (an implementation detail, not information) and no "skill" kind
      // tag (RULE A) — just the description.
      const inner = `<p style="margin:0;font-size:13.5px;line-height:1.6;color:var(--fg-dim)">${esc(String(s.data.description ?? firstParagraph(s.body)))}</p>`;
      return entityBlock("skills", esc(s.name), "skill", inner, s.file, rawForPath(root, s.file), s.name, active === "skills", { showKindTag: false });
    })
    .join("\n");

  const knowledgeBlocks = extras.knowledge
    .map((k) => {
      // UI7: no "Injected into" backlink section — the item's own declared tags render as chips instead.
      const tags = Array.isArray(k.data.tags) ? (k.data.tags as unknown[]).map(String) : [];
      const inner = tags.length ? `<div class="chiprow">${tags.map((t) => tag(t, "tag")).join("")}</div>` : '<span style="color:var(--fg-mute)">no tags declared</span>';
      return entityBlock("knowledge", esc(k.name), "knowledge", inner, k.file, rawForPath(root, k.file), k.name, active === "knowledge");
    })
    .join("\n");

  const typeBlocks = [...repo.types.values()]
    .map((t) => {
      const inner = `<div class="card__h">Expected kinds</div>
      <div class="prow"><span class="k">glyph</span><span class="v mono">${t.glyph}</span></div>
      <div class="prow"><span class="k">expects</span><span class="v mono">${t.expects.map(esc).join(" &rarr; ")}</span></div>
      <div class="prow"><span class="k">gates</span><span class="v">${t.gates.map(esc).join(", ")}</span></div>`;
      return entityBlock("types", `<span style="font-family:var(--mono)">${t.glyph} ${esc(t.name)}</span>`, "type", inner, `types/${t.name}.md`, rawFor(root, "types", t.name), t.name, active === "types");
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
      return entityBlock("connectors", esc(c.name), "connector", inner, `connectors/${c.name}.md`, rawFor(root, "connectors", c.name), c.name, active === "connectors");
    })
    .join("\n");

  const evalBlocks = extras.evals
    .map((e) => {
      const rubric = Array.isArray(e.data.rubric) ? (e.data.rubric as string[]) : [];
      const inner = `<div class="card__h">Rubric</div>${rubric.map((r) => `<div class="prow"><span class="v">${esc(String(r))}</span></div>`).join("\n")}`;
      return entityBlock("evals", esc(e.name), "eval", inner, e.file, rawForPath(root, e.file), e.name, active === "evals");
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
      <h1>${title}</h1>
    </header>
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
  return rawForPath(root, `${dir}/${name}.md`);
}

// Reads an entity's raw markdown for the editor textarea from its ACTUAL backing file — the same
// root-relative path (`relPath`) embedded as `data-path` on the card, never a name-reconstructed one.
// A directory-form extra (skills/knowledge/evals) carries this path on its `Entity.file` (extra.ts);
// teams/agents/types/connectors are always flat, so `${kind}/${name}.md` (via `rawFor` above) is exact.
function rawForPath(root: string, relPath: string): string {
  try {
    return readFileSync(`${root}/${relPath}`, "utf8");
  } catch {
    return "";
  }
}

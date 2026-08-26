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
import { esc, costLabel, ageLabel, elapsedSpan, projectLastActivity, diffstatSummary, type OpenGate } from "../../derive.ts";
import type { RegistryExtras } from "../../extra.ts";
import { diagnose } from "../../doctor.ts";
import type { DaemonInvocation } from "../../daemon.ts";
import { resolveOrchestratorStatus, type OrchestratorStatus } from "../../orchestrator-status.ts";
import { getVersionInfo, versionChip } from "../../version.ts";
import { statusLabel } from "../status.ts";
import { statusBadge, neutralChip, counter, pendingState, card, confirmModal, toastViewport, orchTurn, renderPersistedTurns, tag, callout } from "../components.ts";
import { loadConversationTail } from "../../conversation.ts";
import { deriveTeamStyle } from "../team-color.ts";
import { registryKindIconBody } from "./entity-icons.ts";
import { isBlockingViolationLine } from "../../guardrails.ts";
import { resolveMemberTimeoutS } from "../../adapters.ts";

// levare's own release version (item 3: "the release version as a quiet muted mono chip" beside the
// wordmark) — never from a project's data (that's the `pace`/`deploy`/release vocabulary, a
// different concept entirely). `getVersionInfo` reads the version via a static JSON import rather
// than a resolved-path `readFileSync`, so it stays correct under `bun build --compile` too
// (NOTES DIST1) — a resolved-path read breaks there, because `import.meta.url` inside a compiled
// binary points into Bun's virtual `$bunfs`, not the real filesystem. `versionChip` (NOTES "tree
// build version") is what decides "v1.2.3" vs "dev (build <hash>)" — the same decision `--version`'s
// own fuller sentence makes — already includes its own "v"/no-"v" prefix, so the template below never
// hardcodes one.
const LEVARE_VERSION_CHIP: string = versionChip(getVersionInfo());

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

// Finding 131 / NOTES V11-CONV-SYNC: wrapped in the same `<!--marker-->` convention as the
// orch__action/orch__briefing regions (`orchestratorPanel` above) so `board/serve.ts#extractFragment`
// can slice it back out for `assets/app.js#syncAppVersion` to resync unconditionally on every client-
// side swap — the header itself is otherwise OUTSIDE every swap region (never touched by `.main`/
// `[data-extras-host]` replacement, see NOTES UI10), so a long-open tab kept showing whatever build was
// running at the tab's own last cold GET forever after, even once the daemon had since restarted on a
// newer commit (demonstrated: `curl` reporting the current build while an open tab showed one two
// merges behind). The value itself is already correct-per-request (a `--define`-stamped module
// constant, re-embedded fresh into every response's rendered HTML by the process actually serving it)
// — the only gap was the client never re-fetching it, the identical root cause as Finding 57's tail.
function appHeader(status: OrchestratorStatus, railToggleLabel: string): string {
  return `<header class="apphead">
  <button class="togglebtn apphead__railtoggle" data-rail-toggle aria-label="${esc(railToggleLabel)}">&#9776;</button>
  <a class="logo" href="/studio"><span class="logo__mark"><i></i><b></b></span><span class="logo__word">levare</span></a>
  <span class="apphead__ver mono" data-app-version><!--appversion-->${esc(LEVARE_VERSION_CHIP)}<!--/appversion--></span>
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
<script src="/app.js?v=11"></script>
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

// Finding 40 (REOPENED): the badge alone, not the whole `<details>`, carries the marker — scoping it
// this narrow means a resync can never blow away the popover's own open/closed state (a Conductor
// mid-read of "why is it off" loses nothing), the same "don't clobber local UI state a swap would have
// preserved" concern NOTES UI10 raised for the registry editor overlay. The header itself sits outside
// every swap region (`swapFragment` only ever touches `.main`/`[data-extras-host]`, NOTES UI10), so
// without this marker the dot stayed frozen at whatever was configured at the tab's last cold GET, even
// after the daemon restarted with ANTHROPIC_API_KEY newly set or unset — the identical gap Finding 131
// already fixed for the version chip one element to its left.
function orchestratorIndicator(status: OrchestratorStatus): string {
  const badge = status.available
    ? statusBadge("done", "orchestrator: on")
    : statusBadge("waiting", "orchestrator: off");
  return `<details class="orchind">
    <summary class="orchind__sum"><span data-orchind-badge><!--orchind-->${badge}<!--/orchind--></span></summary>
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
// rendered HTML so a client-side navigation can tell whether the panel needs a fresh tail. `root`/`now`
// load and timestamp that tail exactly like every other per-request derivation in this module (PRD §9,
// invariant 2) — never a second render path, never a stored, cached history.
//
// NOTES ORCH-STALE-CARD: `actionableHtml` (the run view's own gate card — the ONE place a runner-side
// change such as a dispatch completing, an artifact landing, or a gate opening shows up) used to be
// spliced straight into `orch__body` with no marker of its own. `extractFragment`/`swapFragment` only
// ever knew about `main`, `extras`, and (conditionally, on a scope change) the persisted tail — so
// EVERY refresh that isn't a real cold GET (the SSE `reload` tick, any client-side navigation at all,
// same scope or not) left this card rendering whatever was true at the moment of the last full page
// load, forever after. The score rail and timeline never had this problem: both live inside `main`,
// which every refresh path already replaces wholesale. Wrapping it in its own `data-orch-action`
// marker, exactly like the tail's `data-orch-tail`, lets the client resync it too — unconditionally,
// unlike the tail, since a gate's own state (unlike conversation history) has no "already shown live"
// case to avoid duplicating.
//
// NOTES ORCH-STALE-CARD addendum: `briefingHtml` (the narrated summary turn — "N gates on you"/
// "Nothing needs you right now", and the disabled branch's own "Orchestrator unavailable..." turn) had
// the IDENTICAL gap, one element up: it renders the gate COUNT the action region's card is drawn from,
// but sat outside every marker just like `actionableHtml` used to. Approving the studio's last open
// gate correctly cleared the action region and the `Gates on you` stat (both inside `main`/the newly-
// marked action region), while this sentence — "2 gates are on you..." — survived two navigations
// unchanged, now visibly contradicting a `0` stat in the same panel. Same fix, same reasoning: a
// `data-orch-briefing` marker, resynced unconditionally on every swap.
export function orchestratorPanel(scope: string, status: OrchestratorStatus, briefingHtml: string, actionableHtml: string, root: string, now: Date): string {
  const tailHtml = renderPersistedTurns(loadConversationTail(root, scope, now), now);
  // The HTML comment markers mirror `pageBody`'s own `<!--main-->`/`<!--extras-->` convention exactly
  // (inert everywhere else, invisible in the rendered page, never reachable from escaped user content
  // — `esc()` turns any literal `<`/`>` inside a turn's text to `&lt;`/`&gt;`) so `extractFragment` can
  // slice this region back out the same string-slicing way, with no HTML parser, no second render call.
  const tailBlock = `<div class="orch__tail" data-orch-tail><!--orchtail-->${tailHtml}<!--/orchtail--></div>`;
  const actionBlock = `<div class="orch__action" data-orch-action><!--orchaction-->${actionableHtml}<!--/orchaction--></div>`;
  const briefingBlock = (html: string) => `<div class="orch__briefing" data-orch-briefing><!--orchbriefing-->${html}<!--/orchbriefing--></div>`;
  // Finding 136 item 3: the composer is the other place `status.available` renders besides the
  // header dot (Finding 40) — the `.orch`/`.orch.is-disabled` split on the `<aside>` itself, and
  // `composer({disabled})`'s own markup. Both come from the SAME `status` this function's caller
  // already resolved fresh per request (render/*.ts's `resolveOrchestratorStatus()` default param,
  // the identical value passed to `orchestratorIndicator` in `appHeader` above) — so unlike Finding
  // 40, there is no second derivation to fix server-side, only the identical client reapplication
  // gap: the `<aside>` sits outside every swap region (`main`/`extras`, NOTES UI10) and is never
  // rebuilt wholesale by a client-side refresh, so its `is-disabled` class and the composer's markup
  // both stayed frozen at whatever was true on the tab's last cold GET. `data-orch-disabled` gives
  // the client the same fact `data-scope` already gives it, off the one `<aside>` tag, so it can
  // toggle the class without a second render call; `composerBlock` wraps the composer in the same
  // `<!--marker-->`-in-a-stable-host shape as `tailBlock`/`actionBlock`/`briefingBlock` above.
  const composerBlock = (html: string) => `<div data-orch-composer><!--orchcomposer-->${html}<!--/orchcomposer--></div>`;
  if (!status.available) {
    return `<aside class="orch is-disabled" data-scope="${esc(scope)}" data-orch-disabled="true">
    ${orchHead(scope)}
    <div class="orch__body">
      ${briefingBlock(orchTurn(`<p class="turn__body">Orchestrator unavailable — ${esc(reasonSentence(status.reason))} The board, the registry, and every gate still work: you can approve, reject, and the runner will advance.</p>`))}
      ${tailBlock}
      ${actionBlock}
    </div>
    ${composerBlock(composer({ disabled: true }))}
  </aside>`;
  }
  return `<aside class="orch" data-scope="${esc(scope)}" data-orch-disabled="false">
    ${orchHead(scope)}
    <div class="orch__body">${briefingBlock(briefingHtml)}${tailBlock}${actionBlock}</div>
    ${composerBlock(composer())}
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

// DOCS-WALKTHROUGH-3 item 3: a bare two-letter avatar (`wr`, `ly`, ...) names no one on its own — the
// same accessible tooltip recipe `cited N`/loop-bounds/`not covered` already established (`tabindex="0"`
// + `aria-describedby` + a nested `role="tooltip"` child, wired by `assets/app.js#wireTooltip`), so a
// keyboard user reaches the member's name exactly like a pointer user, never hover-only. `tooltip.id`
// must be unique per rendered instance (the same member can appear more than once on one page — a team
// card's member list, a score rail) — the caller supplies it, exactly like `citecount-.../loopbounds-...`
// at the existing two call sites.
export function avatar(initials: string, color: string | undefined, opts: { size?: "sm" | "lg"; blink?: boolean; title?: string; tooltip?: { text: string; id: string } } = {}): string {
  const size = opts.size ?? "sm";
  const blinkCls = opts.blink ? " blink" : "";
  const style = teamAvatarStyle(color);
  if (opts.tooltip) {
    return (
      `<span class="avatar ${size}${blinkCls}" tabindex="0" aria-describedby="${opts.tooltip.id}" style="${style}">${esc(initials.toLowerCase())}` +
      `<span class="avatartip" role="tooltip" id="${opts.tooltip.id}">${esc(opts.tooltip.text)}</span></span>`
    );
  }
  const titleAttr = opts.title ? ` title="${esc(opts.title)}"` : "";
  return `<span class="avatar ${size}${blinkCls}"${titleAttr} style="${style}">${esc(initials.toLowerCase())}</span>`;
}

export function memberAvatar(repo: Repo, producedBy: string, opts: { size?: "sm" | "lg"; blink?: boolean; tooltipId?: string } = {}): string {
  const [teamName, memberName] = producedBy.split("/");
  if (memberName === undefined) return `<span class="avatar avatar--conductor sm">C</span>`;
  const agent = repo.agents.get(memberName);
  const team = repo.teams.get(teamName);
  const initials = agent?.style.avatar || memberName.slice(0, 2);
  const tooltip = opts.tooltipId ? { text: memberName, id: opts.tooltipId } : undefined;
  return avatar(initials, team?.style.color, { size: opts.size, blink: opts.blink, tooltip });
}

// RULE B: an agent's kind (native/cli/remote) is never coloured from the status palette; the badge's
// own text names the kind. DOCS-WALKTHROUGH-3 item 2: this used to also carry a filled/outlined/dashed
// TREATMENT split per value — real signal, but unexplained anywhere in the UI itself and inconsistently
// applied — retired in favour of one shared outlined treatment for every kind value (`.kindbadge`,
// assets/styles.css). `kindbadge--${kind}` stays as a class hook; it carries no CSS rule of its own now.
export function agentKindBadge(kind: "native" | "cli" | "remote"): string {
  return `<span class="kindbadge kindbadge--${kind}">${esc(kind)}</span>`;
}

// NOTES UI11 / DOCS-WALKTHROUGH-3 item 2: a connector's kind (cli/mcp) shares the identical badge
// system as an agent's kind — same reasoning as agentKindBadge above, including the now-uniform
// outlined treatment.
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

// Finding 40 (REOPENED — was closed stale on a misread; a shell-side commit was probed to confirm the
// rail truly never moved without a manual refresh). The rail sits entirely outside every swap region
// (`swapFragment` only ever replaces `.main`/`[data-extras-host]`, NOTES UI10) — its DOM node is never
// even touched by a client-side navigation, let alone the SSE `reload` tick, so every value here stayed
// frozen at whatever was true on the tab's own last cold GET. Three of its four sections carry the same
// `<!--marker-->`/unconditional-resync treatment `orchAction`/`orchBriefing`/the version chip already
// established (NOTES ORCH-STALE-CARD, Finding 131): `railprojects` (the project list and its per-project
// unit counts), `railconnectors` (the health dots), `railideas`. The Registry section (registry entity
// counts) is deliberately left unmarked here — out of THIS finding's named scope — and reported as a
// remaining sibling gap instead of folded in silently (Finding 129's standing sweep instruction).
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
    <section class="railsec"><h3 class="railsec__h">Projects</h3><div data-rail-projects><!--railprojects-->${railLongList(projectRows)}<!--/railprojects--></div></section>
    <section class="railsec"><h3 class="railsec__h">Registry</h3><nav class="reg-nav">${registryNavLinks(repo, extras, opts.activeRegistryEntity)}</nav></section>
    <section class="railsec"><h3 class="railsec__h">Connectors</h3><div data-rail-connectors><!--railconnectors-->${connectorRows}<!--/railconnectors--></div></section>
    <section class="railsec"><h3 class="railsec__h">Ideas</h3><div data-rail-ideas><!--railideas-->${railLongList(ideaRows)}<!--/railideas--></div></section>
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
//
// Phase 2 "gate card" goal, item 2: carries the SAME `elapsedSpan`/`elapsedLabel` vocabulary run.ts's
// Tier-3 live strip already renders, plus round n/m for a loop redo — never a fabricated number, only
// what `DispatchingInfo` actually knows (see `dispatchingFor` below). Finding 79: the server still
// renders one correct-at-render-time value via `elapsedSpan`, but that span now also carries the raw
// `data-started-at`, so assets/app.js's client-side tick keeps it live between fragment refetches —
// see that file's own comment for how it avoids binding to a node that an SSE `reload` swap discards.
function dispatchingHtml(d: DispatchingInfo, now: Date): string {
  const roundText = d.loop ? `round ${d.loop.round}/${d.loop.maxRounds} · ` : "";
  const labelHtml = `dispatching ${esc(d.member)} · ${esc(d.kind)}… · ${esc(roundText)}${elapsedSpan(d.startedAt, now, d.timeoutS)}`;
  return `<div class="gate__verbs gate__verbs--pending">${pendingState({ labelHtml })}</div>`;
}

export interface DispatchingInfo {
  member: string;
  kind: string;
  startedAt: string;
  /** Set only when this gate's own artifact belongs to a loop — the round now being produced (one past
   * the currently-open, about-to-be-superseded round `gate.loop.round` already names). */
  loop?: { round: number; maxRounds: number };
  /** Finding 81 part 3: the bound this dispatch will actually be killed at, in seconds — the exact
   * number `resolveMemberTimeoutS` would hand a real dispatch of this member, so `8m 20s` beside it
   * reads as `8m 20s / 20m` instead of leaving a Conductor to guess how close to the edge it is.
   * Absent only when `member` no longer resolves to a known agent (a registry edit mid-dispatch). */
  timeoutS?: number;
}

// The daemon's live in-flight projection (running()), narrowed to a single gate's own unit AND (for a
// gate that actually has a kind — every shape but start/blocked, neither of which has one) to the
// specific kind that gate's resolution depends on.
//
// Phase 2 "gate card" goal, item 1 (Finding 82/83/72's own cross-kind risk): matching on unit alone
// would be wrong the instant two DIFFERENT, unrelated kinds could be in flight for the same unit at
// once — but `dagwalk.ts#nextAction` never allows that (it walks a team's `flow` strictly in order and
// halts the WHOLE unit at the first open gate, never advancing to a later step past it — verified
// directly, not assumed) and the daemon dispatches at most one invocation per unit at a time
// (`daemon.ts#tickOnce`'s own "single-flight" comment). The one place a running invocation's kind
// legitimately DIFFERS from the open gate's own kind is F16's loop redo: a gate sitting on the critic
// kind (`until: review.approved`) stays open while `doRequest` re-invokes the AUTHOR kind — the loop's
// two kinds are one logical round, and `gate.loop.companionKind` (derive.ts) names the other side so
// that redo still matches. Matching the gate's own kind ALONE (ignoring companionKind) would silently
// stop recognizing that redo as dispatching — a regression, not a fix, since it is the single most
// common case this whole mechanism exists for.
// Phase 2 "gate card" goal, item 3 (Finding 97: a queued unit and a merge-blocked unit both read
// identically): a start gate, a plain single-shot review, a loop round, and a merge trial are four
// different things a Conductor might click through to — this names which one, from vocabulary already
// in scope at every call site (`gate.type`, `gate.loop`, `art.kind === "merge"`; established Phase 1 as
// needing no plumbing). Deliberately does NOT cover `gate.loop?.exhausted` — that already has its own
// dedicated "exhausted" badge/styling (below), which stays a Conductor-facing urgency signal, not a
// kind label.
export function gateKindLabel(gate: OpenGate): string {
  if (gate.type === "start") return "start";
  if (gate.type === "blocked" || gate.type === "artifact-blocked") return "blocked";
  if (gate.artifact?.kind === "merge") return "merge";
  if (gate.loop) return `loop · ${gate.loop.round}/${gate.loop.maxRounds}`;
  return "step";
}

export function dispatchingFor(repo: Repo, running: DaemonInvocation[], gate: OpenGate): DispatchingInfo | undefined {
  const inv = running.find((r) => r.project === gate.project && r.unit === gate.unit);
  if (!inv) return undefined;
  const gateKind = gate.artifact?.kind;
  if (gateKind && inv.kind !== gateKind && inv.kind !== gate.loop?.companionKind) return undefined;
  const agent = repo.agents.get(inv.member);
  return {
    member: inv.member,
    kind: inv.kind,
    startedAt: inv.startedAt,
    loop: gate.loop ? { round: gate.loop.round + 1, maxRounds: gate.loop.maxRounds } : undefined,
    timeoutS: agent ? resolveMemberTimeoutS(agent) : undefined,
  };
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

export function gateCardHtml(repo: Repo, gate: OpenGate, now: Date, opts: { cta?: boolean; dispatching?: DispatchingInfo } = {}): string {
  const unit = repo.units.find((u) => u.project === gate.project && u.unit === gate.unit);
  const type = unit ? repo.types.get(unit.type) : undefined;
  const glyph = typeGlyphSvg(type?.name);
  const dispatching = opts.dispatching;

  if (gate.type === "start") {
    const startVerbs = dispatching
      ? dispatchingHtml(dispatching, now)
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
      ? dispatchingHtml(dispatching, now)
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
          <p class="gate__ctx">${dispatching ? "Dispatching now &mdash; the unit is being produced." : `Blocked: ${ctx}`}</p>
          <div class="gate__meta"><span>${esc(age)}</span></div>
        </div>
        <span class="gate__badge is-blocked">${dispatching ? "dispatching" : "blocked"}</span>
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
  const ctx = dispatching
    ? "Dispatching now &mdash; the unit is being produced."
    : gate.loop?.exhausted
      ? `${gate.loop.round} of ${gate.loop.maxRounds} rounds used — this loop cannot continue without \`${esc(gate.loop.until)}\`.`
      : esc(firstParagraph(art.body ?? ""));
  const roundBadge = gate.loop ? `<span class="gate__round">round ${gate.loop.round}/${gate.loop.maxRounds}</span>` : "";
  // Ruling 2026-08-23 ("the gate card is where decisions happen", Findings 104/105): the decision-
  // relevant fact — CHANGES REQUESTED, or an approval — rendered directly, never buried below the
  // fold in `ctx`'s truncated prose. `art.verdict` absent (predates the field, or the critic's own
  // prompt hasn't been told about it yet — both collapse to the SAME state on purpose) renders its own
  // explicit, neutral "not recorded" chip — never silently omitted (that was Finding 105) and never
  // defaulted to either enum value (a confident wrong default reads worse than the truncation it
  // would replace). Scoped to kind: review only — every other kind has no verdict to show.
  const verdictBadge =
    art.kind === "review"
      ? `<div class="gate__verdict">${
          art.verdict === "APPROVED"
            ? statusBadge("done", "Verdict: APPROVED")
            : art.verdict === "CHANGES REQUESTED"
              ? statusBadge("failed", "Verdict: CHANGES REQUESTED")
              : neutralChip("Verdict not recorded", undefined, {
                  text: "Predates this field, or the critic's own prompt hasn't been updated to write it yet — never read as either verdict.",
                  id: `verdict-${esc(gate.project)}-${esc(gate.unit)}-${esc(art.id)}`,
                })
        }</div>`
      : "";
  const meta = `<div class="gate__meta"><span>${esc(age)}</span>${cost ? `<span class="cost">${cost}</span>` : ""}${roundBadge}</div>`;
  const verbs = dispatching
    ? dispatchingHtml(dispatching, now)
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
        ${verdictBadge}
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
    titleExtra: `${verdictBadge}<p class="gate__ctx">${ctx}</p>${consumesHtml}${meta}`,
    status: `<span class="gate__badge${gate.loop?.exhausted ? " is-exhausted" : ""}">${dispatching ? "dispatching" : gate.loop?.exhausted ? statusLabel("exhausted") : gateKindLabel(gate)}</span>`,
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

function mergeGateCardHtml(repo: Repo, gate: OpenGate, now: Date, opts: { cta?: boolean; dispatching?: DispatchingInfo }): string {
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
      ? dispatchingHtml(dispatching, now)
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
      status: `<span class="gate__badge">${gateKindLabel(gate)}</span>`,
      meta: verbs,
    });
  }

  const conflicted = merge.conflicted;
  const violations = merge.guardrail_violations ?? [];
  // Actor-aware ruling (2026-08-20): a `protected-branch` line is what approval itself resolves —
  // clicking Merge IS the authorization (guardrails.ts's own header) — so it must not withhold the
  // button the same way a real blocker does. `protected-path`/`never` lines are unaffected: the SAME
  // execution-time re-check (M3) still fails on those regardless of who clicks approve.
  const blockingViolations = violations.filter(isBlockingViolationLine);
  const gateExemptViolations = violations.filter((v) => !isBlockingViolationLine(v));
  const guardrailsPass = blockingViolations.length === 0;
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
  const guardrailHtml =
    blockingViolations.length > 0
      ? callout("danger", `blocked by guardrail: ${blockingViolations.map(esc).join("; ")}`)
      : gateExemptViolations.length > 0
        ? `<p class="gate__ctx" style="color:var(--fg-mute)">${gateExemptViolations.map(esc).join("; ")} &mdash; approving this gate is the authorization to land here.</p>`
        : `<p class="gate__ctx" style="color:var(--fg-mute)">guardrails pass</p>`;
  const meta = `<div class="gate__meta"><span>opened ${esc(age)}</span></div>`;

  const project = repo.projects.get(gate.project);
  const verbsHtml = dispatching
    ? dispatchingHtml(dispatching, now)
    : canApprove
      ? `<div class="gate__verbs"><button class="verb is-primary" data-verb="approve">${project?.remote ? "Merge &amp; push" : "Merge"}</button></div>`
      : `<div class="gate__verbs"><button class="verb is-primary" data-verb="recheck">Re-check</button></div>`;

  // Finding 122: `trialBadge` is a bare `statusBadge()` chip — a `<span>`, sized to its own content
  // everywhere else on the board — but here it sits as a DIRECT child of `.gate__inner`/`.gate__body`
  // (both `display:flex; flex-direction:column`), so flexbox's own default `align-items: stretch`
  // stretches it to the row's full width: a large green banner that outweighs the small "merge"
  // gate-kind chip beside it, for carrying strictly less information (CLEAN means only
  // `!trial.conflicted`). The exact same review-gate verdict badge already avoids this by wrapping in
  // `.gate__verdict` (unstyled — its only job is to stop being a direct flex child); same fix here.
  const titleExtra = `<div class="gate__verdict">${trialBadge}</div>${conflictDetail}${statsHtml}${guardrailHtml}${meta}`;

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
    status: `<span class="gate__badge">${gateKindLabel(gate)}</span>`,
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

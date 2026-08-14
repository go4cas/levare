// ---------------------------------------------------------------------------
// REGISTRY
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import type { Repo } from "../../repo.ts";
import { firstParagraph, repoCapabilities } from "../../repo.ts";
import { esc, captionTime } from "../../derive.ts";
import { loadExtras } from "../../extra.ts";
import { STUDIO_SCOPE } from "../../conversation.ts";
import { resolveOrchestratorStatus, type OrchestratorStatus } from "../../orchestrator-status.ts";
import { detectSandbox, type SandboxDetection } from "../../sandbox.ts";
import { remoteAgentImplemented } from "../../env.ts";
import { resolveStep } from "../../flow.ts";
import type { Team, FlowNode } from "../../types.ts";
import { tag, kindTag, editorOverlay, orchTurn, callout, card, leadText, cardHeadline } from "../components.ts";
import { registryKindIconBody } from "./entity-icons.ts";
import { deriveTeamStyle } from "../team-color.ts";
import {
  shell,
  pageBody,
  railNav,
  orchestratorPanel,
  avatar,
  agentKindBadge,
  connectorKindBadge,
  REGISTRY_KINDS,
  type RegistryKind,
  registryKindCount,
} from "./shell.ts";

// NOTES REGISTRY-BODY: an agent's body is a system prompt written in second person ("You are Wren, a
// product framer. ...") — rendering it verbatim reads oddly as card copy, but the pre-existing behaviour
// (dropping it entirely) hid the one thing a reader looking at a member card actually wants: its role.
// Decided here: the body's own first SENTENCE, as a lead-in — long enough to answer "who is this" (the
// scaffold's own agents/wren.md: "You are Wren, a product framer." is exactly this), short enough that a
// multi-paragraph system prompt never floods the card. Falls back to the whole first paragraph when no
// sentence boundary is found within it (a body that's just one short clause with no terminal period).
function firstSentence(body: string): string {
  const para = firstParagraph(body);
  const m = /^.*?[.!?](?=\s|$)/.exec(para);
  return m ? m[0] : para;
}

// NOTES REGISTRY-BODY: the team flow row used to render `t.members` — a flat, avatar-only chain
// (wr → ly → fi) that carries no flow information at all, on a board whose entire premise is Conductor
// approval AT A GATE. `teams/kestrel.md` declares five stages (two `gate: human` halts and a bounded
// `loop`) and the card rendered three member avatars, indistinguishable from a plain linear handoff —
// the type card's own `gates` row is the reference this fixes toward: a declared control-flow fact
// renders as itself, not folded into a member list. Each `FlowNode` renders as one flowstrip item:
//
//  - step  → the resolved member's avatar (same avatar/title treatment the old members-only strip used)
//  - gate  → the SAME diamond marker the run view's own mini-score already uses for a gate node
//            (`.diamond.is-gate`, derive.ts#miniScoreHtml) — one visual vocabulary for "a gate", not a
//            second one invented here.
//  - loop  → both member avatars for its `between` pair, joined by a loop glyph, with the loop's own
//            bound and escalation (`until` / `max_rounds` / `on_exhaust`) captioned underneath in the
//            `.mn` treatment `.flowstrip` already had defined in CSS but no caller had ever used.
//
// `resolveStep` is the Runner's OWN step→member resolution (flow.ts, ruling B2) — reused rather than
// re-derived, so the card can never show a binding that disagrees with what actually dispatches. It
// throws on an unbound/ambiguous step; a validated repo never hits that (validate.ts#validateStudioBindings
// enforces every step resolves before a studio is accepted), but the card is a pure display and must
// never 500 the whole registry page over one malformed team mid-edit — caught per node, falling back to
// the bare step label so the rest of the page still renders.
function resolveStepMember(team: Team, label: string, capabilities: Array<{ member: string; kind: string }>): string | undefined {
  try {
    return resolveStep(team, label, capabilities).member;
  } catch {
    return undefined;
  }
}

function flowStepAvatar(repo: Repo, team: Team, label: string, member: string | undefined): string {
  if (!member) return `<span class="mono" title="unresolved flow step">${esc(label)}</span>`;
  return avatar(repo.agents.get(member)?.style.avatar ?? member.slice(0, 2), team.style.color, { title: `${member} · ${label}` });
}

function flowNodeHtml(repo: Repo, team: Team, node: FlowNode, capabilities: Array<{ member: string; kind: string }>): string {
  if (node.kind === "step") {
    const member = resolveStepMember(team, node.step, capabilities);
    return `<div class="m">${flowStepAvatar(repo, team, node.step, member)}</div>`;
  }
  if (node.kind === "gate") {
    return `<div class="m" title="gate: ${esc(node.who)}"><span class="diamond is-gate"></span></div>`;
  }
  const [a, b] = node.between;
  const avA = flowStepAvatar(repo, team, a, resolveStepMember(team, a, capabilities));
  const avB = flowStepAvatar(repo, team, b, resolveStepMember(team, b, capabilities));
  // Fault 3: `&nbsp;` inside each key/value pair (until X, max N, on_exhaust: Y) so a narrow card wraps
  // only at the " · " separators between pairs, never mid-phrase (a bare space let the browser break
  // "on_exhaust:" from "gate").
  //
  // Goal "registry cards legibility", item 2: the loop is the flow's fifth STAGE, not a subordinate
  // aside below it — `m--loopstage` draws the subtle bordered/tinted enclosure that reads as "one
  // stage, two members alternating inside it" (assets/styles.css), so the pair renders as a single
  // unit within the same left-to-right sequence rather than looking parallel to it. The bound/
  // escalation caption stays present (never hidden behind hover — a Conductor auditing the registry or
  // reading a screenshot needs it), tucked inside the same enclosure at its existing smaller, muted
  // `.mn` treatment so it reads as subordinate to the loop, not a peer of the flow row.
  return `<div class="m m--loopstage"><div class="looppair">${avA}<span class="arr">&#8646;</span>${avB}</div><span class="mn">until&nbsp;${esc(node.until)} &middot; max&nbsp;${node.maxRounds} &middot; on_exhaust:&nbsp;${esc(node.onExhaust)}</span></div>`;
}

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
// Amendment 1 §1/§3 (Ruling R3, consistency audit F5/F6/F7): the kind-tag (glyph + word) is now
// MANDATORY on every registry card header — superseding UI7's old "RULE A" (a card on its own
// entity's page doesn't repeat its kind, so team/agent/skill cards dropped the tag entirely). The
// review that ratified the entity-icon family found the tag missing on exactly those three kinds;
// the tag is back on every card, now carrying the entity glyph the amendment's whole point is to
// put in front of the Conductor. `data-editor-kind` (the overlay's heading) still gets the real kind
// label regardless, since the overlay is a shared modal that needs to say what it's editing.
// `accentColor`, when given, replaces the identity swatch/hex text some entities used to print with a
// left-edge border in the entity's own declared colour — the colour becomes the card's identity, not a
// value rendered on it (RULE B: a team's declared hue is the one colour-as-identity exception).
function entityBlock(kind: RegistryKind, title: string, kindLabel: string, inner: string, relPath: string, raw: string, name: string, active: boolean, opts: { accentColor?: string } = {}): string {
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
    status: kindTag(registryKindIconBody(kind, name), kindLabel),
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
export function renderRegistry(
  repo: Repo,
  root: string,
  activeEntity?: string,
  status: OrchestratorStatus = resolveOrchestratorStatus(),
  highlightName?: string,
  now: Date = new Date(),
  sandbox: SandboxDetection = detectSandbox(),
): string {
  const extras = loadExtras(root);
  const active: RegistryKind = REGISTRY_KINDS.includes(activeEntity as RegistryKind) ? (activeEntity as RegistryKind) : "teams";
  const highlightId = highlightName ? `${active}-${highlightName}` : undefined;

  const rail = railNav(repo, extras, { activeRegistryEntity: active });
  const title = active.charAt(0).toUpperCase() + active.slice(1);

  const teamCapabilities = repoCapabilities(repo);
  const teamBlocks = [...repo.teams.values()]
    .map((t) => {
      // UI7: the flow strip shows who runs each step by avatar alone — the name moves to the
      // avatar's hover title (RULE A/B: shape+colour carry identity, no name text printed per step).
      // NOTES REGISTRY-BODY: this used to render `t.members` — a flat avatar chain that carries no flow
      // information (see this file's own `flowNodeHtml` comment for the full reasoning). It now renders
      // `t.flow` itself — every declared step, gate, and loop, in order — so DECLARED FLOW and the
      // Definition block's `members` row (still every member, unordered) stop looking like the same
      // fact said twice; one is the flow, the other is the roster.
      // Fault 3: `.flowstrip` wraps (flex-wrap:wrap) on a narrow card, and an arrow joined between
      // nodes by plain `.join()` was its own independent flex item — a sibling the wrap algorithm
      // could break the line after, landing it alone at the end of one line with the step it points
      // at starting fresh on the next ("wr → ◆ → ly → ◆ →", then a wrap, then the loop row). Each
      // node past the first is now wrapped in `.fpair` with its own preceding arrow taken clean OUT OF
      // FLOW (assets/styles.css: `position:absolute`, anchored to the pair's own left edge) — `.fpair`
      // itself carries only the NODE's own size for wrapping purposes, and the arrow purely decorates
      // the gap `.flowstrip`'s own `column-gap` reserves before it. That gap doesn't exist before a
      // wrapped LINE's own first item (flex-wrap never inserts one there), so the same arrow lands off
      // the strip's own left edge and is clipped by `overflow:hidden` — no leading connector, no split
      // pair, on one baseline. The loop pair gets its own modifier (`fpair--loop`): its node stacks an
      // avatar row above a caption, and the arrow anchors near the avatar row specifically, not the
      // vertical center of that whole taller stack.
      const flow = t.flow
        .map((n, i) => {
          const node = flowNodeHtml(repo, t, n, teamCapabilities);
          if (i === 0) return node;
          const pairCls = n.kind === "loop" ? "fpair fpair--loop" : "fpair";
          return `<div class="${pairCls}"><span class="arr">&rarr;</span>${node}</div>`;
        })
        .join("");
      const memberAvatars = t.members.map((m) => avatar(repo.agents.get(m)?.style.avatar ?? m.slice(0, 2), t.style.color, { title: m })).join("");
      const producesChips = t.produces.map((p) => tag(p, "tag")).join("");
      // NOTES MERGE-1: the REV1 "declared but not yet enforced" notice is retired — `checkGuardrails`
      // acquired its production call site (board/gateops.ts's merge-gate execution, PRD Amendment 2
      // M3) — so a team's declared `guardrails:` are enforced at every merge, and the card no longer
      // needs to warn the Conductor about a gap that no longer exists.
      //
      // NOTES REGISTRY-BODY: the charter (this team's body — "what does this team do") used to render
      // nowhere on the card at all; shown here as its first paragraph, the skill card's own lead
      // treatment. `guardrails` — arguably second in importance only to what the team does, since it's
      // the safety constraint a merge is actually checked against — and `knowledge` were both parsed by
      // repo.ts and never rendered; both now appear as further Definition rows, field-name labels
      // matching the agent card's own `context_via`/`context_artifacts` precedent for a label wider
      // than the row's usual one-word key.
      const g = t.guardrails;
      const guardrailRows = g
        ? `${g.protected_branches?.length ? `<div class="prow"><span class="k">protected_branches</span><span class="v mono">${g.protected_branches.map(esc).join(", ")}</span></div>` : ""}${g.protected_paths?.length ? `<div class="prow"><span class="k">protected_paths</span><span class="v mono">${g.protected_paths.map(esc).join(", ")}</span></div>` : ""}${g.never?.length ? `<div class="prow"><span class="k">never</span><span class="v chiprow">${g.never.map((n) => tag(n, "tag")).join("")}</span></div>` : ""}`
        : "";
      const knowledgeRow = t.knowledge?.length ? `<div class="prow"><span class="k">knowledge</span><span class="v chiprow">${t.knowledge.map((k) => tag(k, "tag")).join("")}</span></div>` : "";
      const inner = `${cardHeadline(t.description)}${leadText(firstParagraph(t.charter))}<div class="card__h">Declared flow</div><div class="flowstrip">${flow}</div>
      <div class="card__h">Definition</div>
      <div class="prow"><span class="k">members</span><span class="v chiprow">${memberAvatars}</span></div>
      <div class="prow"><span class="k">produces</span><span class="v chiprow">${producesChips}</span></div>${guardrailRows}${knowledgeRow}`;
      // The declared colour, as a left-edge card border, is the card's identity instead of a
      // swatch/hex value printed inside it (RULE B). Routed through the same contrast-floored
      // derivation `avatar()` uses (team-color.ts) — the border and a team's member avatars must
      // read as ONE hue, not a raw declared value beside a corrected one.
      return entityBlock("teams", esc(t.name), "team", inner, `teams/${t.name}.md`, rawFor(root, "teams", t.name), t.name, active === "teams", { accentColor: deriveTeamStyle(t.style.color).hue });
    })
    .join("\n");

  const agentBlocks = [...repo.agents.values()]
    .map((a) => {
      const team = [...repo.teams.values()].find((t) => t.members.includes(a.name));
      const recipe = [...(a.skills ?? []), ...(a.knowledge ?? [])].map((p) => `<a class="pill" href="#">${esc(p)}</a>`).join("\n");
      const producesChips = a.produces.map((p) => tag(p, "tag")).join("");
      const toolsChips = a.tools?.length ? a.tools.map((tl) => tag(tl, "tag")).join("") : "";
      const connectorsChips = a.connectors?.length ? a.connectors.map((c) => tag(c, "tag")).join("") : "";
      // UI7: kind+model render adjacent ("native · claude-sonnet-5") in one row, the kind itself a
      // shape/treatment badge (RULE B — never colour); no "wears <team>" row (RULE A — the avatar
      // above is already tinted with the team's colour, so the team is shown, not told).
      // NOTES MCP-1B (narrowed from REV1 finding 3): `kind: remote` validates cleanly, and since Phase
      // 1b it produces real work when `server:` names a real, granted, stdio `kind: mcp` connector
      // (env.ts#remoteAgentImplemented) — adapters.ts#createAsyncStdioRemoteBoundary is the real
      // dispatch path. The card only warns when that's NOT yet true (a missing/wrong-kind/ungranted
      // connector, or an HTTP/SSE server — PRD Amendment 3 ruling R1's still-deferred phase 2).
      const remoteWarning =
        a.kind === "remote" && !remoteAgentImplemented(repo, a)
          ? callout("warning", "this remote member has no working stdio MCP connector yet (HTTP/SSE MCP servers remain deferred) — it will not produce real work.")
          : "";
      // NOTES CAP-B (part B item 3) / NOTES R4-SANDBOX (v2, Ruling 2): a cli member's tools: is a
      // legal declaration levare cannot enforce at the per-tool level — even a working OS sandbox is a
      // coarser boundary than tools: describes. Same callout treatment as the remote-members warning
      // above.
      const cliToolsWarning =
        a.kind === "cli" && (a.tools?.length ?? 0) > 0
          ? callout(
              "warning",
              "tools: on a cli member is not enforceable by levare at the per-tool level — the OS sandbox (when available) narrows the member's overall reach but does not distinguish between individual named tools — encode the constraint in the connector/command via the vendor's own flags.",
            )
          : "";
      // NOTES R4-SANDBOX (v2, Ruling 2) / NOTES MCP-1C (ruling R3): sibling to the tools: warning above
      // — when no working OS sandbox primitive exists on the host serving this board, a cli member's
      // spawn, OR a remote member backed by a real, granted, stdio MCP connector (ruling R3 gives it the
      // identical confinement), runs unconfined beyond env/HOME scoping, told plainly rather than left
      // implied by the sandbox's own absence.
      const sandboxWarning =
        (a.kind === "cli" || (a.kind === "remote" && remoteAgentImplemented(repo, a))) && sandbox.level === "none"
          ? callout("warning", "no working OS-level sandbox primitive was found on this host — this member's process runs unconfined beyond env/HOME scoping; see 'levare doctor' for what was tried.")
          : "";
      // NOTES REGISTRY-BODY: "Context recipe" renamed "Skills & knowledge" — plain, and names exactly
      // what this section lists (jargon flagged the same round as the type card's "Expected kinds").
      //
      // Everything from `toolsRow` down is newly rendered: `tools`/`connectors` used to be read only to
      // decide whether to show a WARNING about them, never shown as values themselves — a reader could
      // see "this cli member's tools: isn't enforceable" without ever seeing what tools: actually named.
      // `connectors` (the member's own grant, unioned with its team's) is the single most
      // security-relevant field an agent declares and had no rendering at all. The kind-specific rows
      // below (`command`/`context_via`/`context_artifacts`/`cwd`/`timeout`/`server`/`tool`) are
      // presence-gated, not kind-gated — `context_artifacts` is legal on any kind, and gating strictly
      // by `a.kind` would silently miss a field validate.ts itself accepts. `command` is the literal
      // argv that executes, including whatever vendor guardrails it carries (docs/guide/04-workflow/
      // 05-foreign-agent.md's own "when a vendor hands you guardrails, make them visible") — shown
      // verbatim, mono, the same treatment a connector's own `command`/`env` already get.
      const toolsRow = toolsChips ? `<div class="prow"><span class="k">tools</span><span class="v chiprow">${toolsChips}</span></div>` : "";
      const connectorsRow = connectorsChips ? `<div class="prow"><span class="k">connectors</span><span class="v chiprow">${connectorsChips}</span></div>` : "";
      const commandRow = a.command?.length ? `<div class="prow"><span class="k">command</span><span class="v mono">${a.command.map(esc).join(" ")}</span></div>` : "";
      const contextViaRow = a.context_via ? `<div class="prow"><span class="k">context_via</span><span class="v mono">${esc(a.context_via)}</span></div>` : "";
      const contextArtifactsRow = a.context_artifacts ? `<div class="prow"><span class="k">context_artifacts</span><span class="v mono">${esc(a.context_artifacts)}</span></div>` : "";
      const cwdRow = a.cwd ? `<div class="prow"><span class="k">cwd</span><span class="v mono">${esc(a.cwd)}</span></div>` : "";
      const timeoutRow = a.timeout ? `<div class="prow"><span class="k">timeout</span><span class="v mono">${a.timeout}s</span></div>` : "";
      const serverRow = a.server ? `<div class="prow"><span class="k">server</span><span class="v mono">${esc(a.server)}</span></div>` : "";
      const toolRow = a.tool ? `<div class="prow"><span class="k">tool</span><span class="v mono">${esc(a.tool)}</span></div>` : "";
      // `result` (required on every cli member) is prose describing what the binary emits — the same
      // muted-lead treatment as the description above, not a cramped one-line `.prow` value.
      const resultHtml = a.result ? leadText(a.result) : "";
      const inner = `${cardHeadline(a.description)}${leadText(firstSentence(a.body ?? ""))}<div class="card__h">Skills &amp; knowledge</div><div class="recipe">${recipe || '<span style="color:var(--fg-mute)">none declared</span>'}</div>
      <div class="card__h">Definition</div>
      <div class="prow"><span class="k">kind</span><span class="v">${agentKindBadge(a.kind)}${a.model ? ` <span class="mono">&middot; ${esc(a.model)}</span>` : ""}</span></div>
      <div class="prow"><span class="k">produces</span><span class="v chiprow">${producesChips}</span></div>${toolsRow}${connectorsRow}${commandRow}${contextViaRow}${contextArtifactsRow}${cwdRow}${timeoutRow}${serverRow}${toolRow}${resultHtml}${remoteWarning}${cliToolsWarning}${sandboxWarning}`;
      return entityBlock("agents", `${avatar(a.style.avatar || a.name.slice(0, 2), team?.style.color, { size: "lg" })} ${esc(a.name)}`, "agent", inner, `agents/${a.name}.md`, rawFor(root, "agents", a.name), a.name, active === "agents");
    })
    .join("\n");

  const skillBlocks = extras.skills
    .map((s) => {
      // UI7: no "SKILL.md" heading (an implementation detail, not information) — just the description.
      const inner = leadText(String(s.data.description ?? firstParagraph(s.body)));
      return entityBlock("skills", esc(s.name), "skill", inner, s.file, rawForPath(root, s.file), s.name, active === "skills");
    })
    .join("\n");

  const knowledgeBlocks = extras.knowledge
    .map((k) => {
      // UI7: no "Injected into" backlink section — the item's own declared tags render as chips instead.
      // NOTES REGISTRY-BODY: a knowledge card used to show a name and two tags and nothing else — for a
      // document whose entire value IS its content, injected into member context by name (§6). The
      // skill card already proves the pattern for a reference document's card (a lead paragraph, no
      // separate heading); this now does the same over the doc's own body rather than dropping it.
      const tags = Array.isArray(k.data.tags) ? (k.data.tags as unknown[]).map(String) : [];
      const tagsHtml = tags.length ? `<div class="chiprow">${tags.map((t) => tag(t, "tag")).join("")}</div>` : '<span style="color:var(--fg-mute)">no tags declared</span>';
      const inner = `${leadText(firstParagraph(k.body))}${tagsHtml}`;
      return entityBlock("knowledge", esc(k.name), "knowledge", inner, k.file, rawForPath(root, k.file), k.name, active === "knowledge");
    })
    .join("\n");

  const typeBlocks = [...repo.types.values()]
    .map((t) => {
      // NOTES UI11 (RULE A, same ruling as UI7): the title already shows the glyph — no separate
      // glyph row repeating it. `expects`/`gates` render as chip rows through the same tag/chip
      // primitive agents' `produces` already uses, not a plain arrow-joined or comma-joined string.
      // NOTES REGISTRY-BODY: this heading used to read "Expected kinds" over BOTH rows — wrong once
      // `gates` (where the flow halts for a human) is right underneath it: a gate is not a kind. Renamed
      // to "Definition", the same heading the agent/connector cards already use for their own k/v rows —
      // one word, correct for both rows, no invented per-card vocabulary.
      const expectsChips = t.expects.map((e) => tag(e, "tag")).join("");
      const gatesChips = t.gates.map((g) => tag(g, "tag")).join("");
      const inner = `<div class="card__h">Definition</div>
      <div class="prow"><span class="k">expects</span><span class="v chiprow">${expectsChips}</span></div>
      <div class="prow"><span class="k">gates</span><span class="v chiprow">${gatesChips || '<span style="color:var(--fg-mute)">none declared</span>'}</span></div>`;
      return entityBlock("types", `<span style="font-family:var(--mono)">${t.glyph} ${esc(t.name)}</span>`, "type", inner, `types/${t.name}.md`, rawFor(root, "types", t.name), t.name, active === "types");
    })
    .join("\n");

  const connectorBlocks = [...repo.connectors.values()]
    .map((c) => {
      // NOTES C13: the board must never imply a scoping guarantee levare isn't providing — an
      // `auth: subscription` connector's card says so plainly, not just its `auth` value. NOTES UI11
      // gave this real warning styling but, under the brief's then-blanket amber ban, only in the
      // neutral ink scale ("structure without colour"). NOTES UI12 closes that gap: the brief now
      // defines a message-severity scale with its own warning amber, so this becomes a genuine
      // `callout("warning", …)` — see `callout`'s own doc comment (components.ts) and the design
      // brief's "message severity" section for the amber-split reasoning.
      // NOTES CAP-B: the same home-aware split doctor.ts's `diagnose` now uses — declaring `home:`
      // narrows the honest claim (scoped to the vendor's own config dir) but never closes the residual
      // (any OTHER member granted this same connector can still use the live login).
      const authWarning =
        c.auth === "subscription"
          ? callout(
              "warning",
              c.home && c.home.length > 0
                ? `this credential is scoped to \`${c.home.map(esc).join(", ")}\` under a per-run HOME — but any member granted this connector can still use the login (the grant is not per-member revocable; only the real login is).`
                : `levare cannot scope this credential — any member that can spawn \`${esc(c.command ?? c.name)}\` can use this login. The grant is documentation, not enforcement. Declare 'home:' to scope it to the vendor's own config directory.`,
            )
          : "";
      // NOTES UI11: the connector kind (cli/mcp) gets the same shape-treatment badge as an agent's
      // kind — no status-palette colour, consistent with UI7's agent-kind badges.
      // NOTES C15: `role` (model/tool) is the connector's FUNCTION, distinct from `kind` (its
      // transport) above — rendered as a plain chip, the same bare-word treatment the registry
      // already uses for knowledge tags, not a new badge shape.
      const inner = `<div class="card__h">Definition</div>
      <div class="prow"><span class="k">kind</span><span class="v">${connectorKindBadge(c.kind)}</span></div>
      <div class="prow"><span class="k">role</span><span class="v">${tag(c.role, "tag")}</span></div>
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
  // NOTES UI11 (long lists, item 2): a section with more than 10 entries gets a client-side
  // filter-as-you-type input above the card grid (assets/app.js, delegated so it survives the UI10
  // fragment swap); at 10 or fewer, no input at all. Scoped to the ACTIVE kind's own count — only
  // that kind's cards are ever visible (`entityBlock`'s own `display:none` on the rest), so the input
  // only needs to exist when the kind you're actually looking at is long.
  const filterHtml =
    registryKindCount(repo, extras, active) > 10
      ? `<input type="text" class="registry-filter" placeholder="Filter ${esc(title.toLowerCase())}&hellip;" aria-label="Filter ${esc(title.toLowerCase())}" data-registry-filter/>`
      : "";

  const main = `<main class="main"${highlightId ? ` data-highlight="${esc(highlightId)}"` : ""}>
    <header class="phead">
      <div class="crumb"><a href="/studio">studio</a><span>/</span><span>registry</span></div>
      <h1>${title}</h1>
    </header>
    ${filterHtml}
    <div class="pcards entity-grid" style="grid-template-columns:repeat(auto-fill,minmax(320px,1fr))">
      ${teamBlocks}${agentBlocks}${skillBlocks}${knowledgeBlocks}${typeBlocks}${connectorBlocks}${evalBlocks}
    </div>
  </main>`;

  const briefingBody = orchTurn(
    `<p class="turn__body">This is the registry. The only write here is <span class="mono">Edit source</span>: raw markdown, live validation, then <span class="mono">Save and commit</span>.</p>`,
    { captionTime: captionTime(now.toISOString(), now), captionLabel: "briefing" },
  );
  const orch = orchestratorPanel(STUDIO_SCOPE, status, briefingBody, "", root, now);

  // The overlay is a sibling of `.app`, not nested inside it and not a second page — the board (rail,
  // main, orchestrator) stays exactly as rendered whether or not the overlay is open (UI3 requirement:
  // "does not change the URL or unmount the page behind it").
  return shell("levare · registry", "Open registry nav", pageBody(rail, main, orch, editorOverlay()), status);
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

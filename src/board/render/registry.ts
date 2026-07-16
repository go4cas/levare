// ---------------------------------------------------------------------------
// REGISTRY
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import type { Repo } from "../../repo.ts";
import { firstParagraph } from "../../repo.ts";
import { esc, captionTime } from "../../derive.ts";
import { loadExtras } from "../../extra.ts";
import { hasDeclaredGuardrails } from "../../guardrails.ts";
import { resolveOrchestratorStatus, type OrchestratorStatus } from "../../orchestrator-status.ts";
import { tag, editorOverlay, orchTurn, callout, card } from "../components.ts";
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
export function renderRegistry(repo: Repo, root: string, activeEntity?: string, status: OrchestratorStatus = resolveOrchestratorStatus(), highlightName?: string, now: Date = new Date()): string {
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
      // NOTES REV1 finding 2: `checkGuardrails` (guardrails.ts) has zero production call sites — the
      // merge phase that would enforce `protected_paths`/`protected_branches`/`never` is formally
      // deferred to v1.1 (docs/prd-amendment-1.md §2, invariant 6: "SPECIFIED, NOT IMPLEMENTED"). A
      // Conductor declaring `protected_branches: [main]` today would otherwise reasonably believe
      // levare already blocks a matching merge — it doesn't. The card says so plainly, the same
      // `callout("warning", …)` treatment the C13 subscription-connector note already uses, rather
      // than staying silent about the gap.
      const guardrailsWarning = hasDeclaredGuardrails(t)
        ? callout("warning", "guardrails are declared but not yet enforced — enforcement lands with the merge phase (v1.1).")
        : "";
      const inner = `<div class="card__h">Declared flow</div><div class="flowstrip">${flow}</div>
      <div class="card__h">Definition</div>
      <div class="prow"><span class="k">members</span><span class="v chiprow">${memberAvatars}</span></div>
      <div class="prow"><span class="k">produces</span><span class="v chiprow">${producesChips}</span></div>${guardrailsWarning}`;
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
      // NOTES REV1 finding 3: `kind: remote` validates cleanly but adapters.ts's `RemoteBoundary` is a
      // documented mock in every path today (no live MCP call exists) — a user can't tell that from
      // the schema alone, so the card says so via the same canonical warning callout the guardrails
      // finding above uses.
      const remoteWarning = a.kind === "remote" ? callout("warning", "remote members are not yet implemented — this member will not produce real work.") : "";
      const inner = `<div class="card__h">Context recipe</div><div class="recipe">${recipe || '<span style="color:var(--fg-mute)">none declared</span>'}</div>
      <div class="card__h">Definition</div>
      <div class="prow"><span class="k">kind</span><span class="v">${agentKindBadge(a.kind)}${a.model ? ` <span class="mono">&middot; ${esc(a.model)}</span>` : ""}</span></div>
      <div class="prow"><span class="k">produces</span><span class="v chiprow">${producesChips}</span></div>${remoteWarning}`;
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
      // NOTES UI11 (RULE A, same ruling as UI7): the title already shows the glyph — no separate
      // glyph row repeating it. `expects`/`gates` render as chip rows through the same tag/chip
      // primitive agents' `produces` already uses, not a plain arrow-joined or comma-joined string.
      const expectsChips = t.expects.map((e) => tag(e, "tag")).join("");
      const gatesChips = t.gates.map((g) => tag(g, "tag")).join("");
      const inner = `<div class="card__h">Expected kinds</div>
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
      const authWarning =
        c.auth === "subscription"
          ? callout("warning", `levare cannot scope this credential — any member that can spawn \`${esc(c.command ?? c.name)}\` can use this login. The grant is documentation, not enforcement.`)
          : "";
      // NOTES UI11: the connector kind (cli/mcp) gets the same shape-treatment badge as an agent's
      // kind — no status-palette colour, consistent with UI7's agent-kind badges.
      const inner = `<div class="card__h">Definition</div>
      <div class="prow"><span class="k">kind</span><span class="v">${connectorKindBadge(c.kind)}</span></div>
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
    <div class="pcards" style="grid-template-columns:repeat(auto-fill,minmax(320px,1fr))">
      ${teamBlocks}${agentBlocks}${skillBlocks}${knowledgeBlocks}${typeBlocks}${connectorBlocks}${evalBlocks}
    </div>
  </main>`;

  const briefingBody = orchTurn(
    `<p class="turn__body">This is the registry. The only write here is <span class="mono">Edit source</span>: raw markdown, live validation, then <span class="mono">Save and commit</span>.</p>`,
    { captionTime: captionTime(now.toISOString(), now), captionLabel: "briefing" },
  );
  const orch = orchestratorPanel("registry", status, briefingBody);

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

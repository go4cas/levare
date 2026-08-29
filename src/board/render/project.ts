// ---------------------------------------------------------------------------
// PROJECT
// ---------------------------------------------------------------------------

import type { Repo } from "../../repo.ts";
import { firstParagraph, repoCapabilities } from "../../repo.ts";
import { isLoopCompanionKind } from "../../gates.ts";
import {
  esc,
  renderInline,
  ageLabel,
  openGates,
  scoreNodes,
  foundingArtifacts,
  unitSummary,
  leadingArtifact,
  unitSpend,
  projectSpend,
  medianReviewRounds,
  recentReleases,
  captionTime,
  checkoutSyncNotice,
  type ScoreNode,
} from "../../derive.ts";
import { loadExtras } from "../../extra.ts";
import type { DaemonInvocation } from "../../daemon.ts";
import { resolveOrchestratorStatus, type OrchestratorStatus } from "../../orchestrator-status.ts";
import { dotClass, fromNodeState, fromWorkUnitStatus } from "../status.ts";
import { statusBadge, paceBadge, iconLink, statStrip, card, orchTurn, leadText, callout } from "../components.ts";
import {
  shell,
  pageBody,
  railNav,
  gateCardHtml,
  dispatchingFor,
  gateKindLabel,
  orchestratorPanel,
  projectStatusChip,
  artifactFileName,
  artifactHref,
  artifactTokenLink,
  tokenLink,
  typeGlyphSvg,
} from "./shell.ts";

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

export function renderProject(repo: Repo, projectName: string, root: string, now: Date = new Date(), running: DaemonInvocation[] = [], status: OrchestratorStatus = resolveOrchestratorStatus()): string {
  const project = repo.projects.get(projectName);
  if (!project) throw new Error(`unknown project '${projectName}'`);
  const units = repo.units.filter((u) => u.project === projectName);
  const founding = foundingArtifacts(repo, projectName);
  const gates = openGates(repo).filter((g) => g.project === projectName);

  // NOTES DOCS-WALKTHROUGH-2: "cited N" (derive.ts#foundingArtifacts) was unexplained on the card — a
  // reader can see the number change (`product-brief-done-command-v1.md · cited 1` from a real
  // consumption) but nothing on the card says what it counts. Same accessible treatment as the
  // loop-bounds tooltip (registry.ts/`feat/board-card-legibility`): `tabindex="0"` +
  // `aria-describedby` on the trigger, `role="tooltip"` on the tip itself, so a keyboard user reaches
  // it exactly like a pointer user — never hover-only. A DISTINCT class (`cite--count`) from the plain
  // `.cite` badge the releases list below reuses for its own age/latest label, which is never
  // interactive and must not pick up tooltip behaviour by class collision.
  const foundingHtml = founding.length
    ? founding
        .map((f) => {
          const tipId = `citecount-${esc(f.artifact.id)}`;
          return `<div class="founding">${artifactTokenLink(projectName, f.artifact.unit, f.artifact.id, artifactFileName(f.artifact))}<span class="cite cite--count" tabindex="0" aria-describedby="${tipId}">cited ${f.citations}<span class="citetip" role="tooltip" id="${tipId}">how many other artifacts in this project declare this one in their own consumes: — direct references only, not the whole downstream chain</span></span></div>`;
        })
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
  // card never repeats them as label rows (item 6c: pace is a colour-coded badge, not plain text) —
  // that ruling (and its own test, board-render.test.ts) is unchanged here.
  //
  // NOTES REGISTRY-BODY: `default_branch` was declared on every project and shown nowhere on the
  // board at all — added as a plain row, the same treatment `pace` already gets. The body — the
  // project's own house rules, injected into every member's context for this project (§6 recipe item
  // 5) — used to be dropped entirely; the goal's own example (a payments-code merge-gate rule) is
  // exactly the kind of fact a Conductor reading this page needs and previously could not see here.
  // "Constitution" is renamed "Founding artifacts": it was jargon that happened to sit beside two
  // OTHER genuinely jargon headings elsewhere in the registry (agent/type cards) — this project page's
  // own heading names exactly what `foundingHtml` renders, nothing metaphorical.
  const pointerPanel = `<div class="card">
    <div class="card__h">Pointer</div>
    <div class="prow"><span class="k">pace</span><span class="v">${paceBadge(project.pace)}</span></div>
    <div class="prow"><span class="k">default_branch</span><span class="v mono">${esc(project.default_branch)}</span></div>
    ${project.houseRules ? `<div class="card__h" style="margin-top:6px">House rules</div>${leadText(firstParagraph(project.houseRules))}` : ""}
    <div class="card__h" style="margin-top:6px">Founding artifacts</div>
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
  // Finding 145 site 3: a gate whose own dispatch is in flight (the exact `dispatchingFor` check
  // `project.ts:165` already applies one level down, on the per-unit row) isn't "needs you" — it's
  // already being worked. Excluded here so the header doesn't show needs-you amber for it; the
  // invocation backing it still shows through `membersRunningHere` (it's an entry in `running`
  // regardless of whether its kind matches the gate closely enough for `dispatchingFor` to confirm it).
  const projGates = gates.filter((g) => !dispatchingFor(repo, running, g)).length;
  const projectHeaderStatus = projectStatusChip(projGates, anyUnitActive, membersRunningHere);

  // Finding 59: shared across every artifact row below (isLoopCompanionKind's own signature already
  // takes it) — computed once here rather than per row.
  const capabilities = repoCapabilities(repo);

  const unitRows = units
    .map((u) => {
      const type = repo.types.get(u.type);
      // `running` threads the daemon's live-invocation projection through, same as run.ts — a unit
      // whose current step is genuinely being produced shows the canonical active (blue+pulse) dot in
      // its mini-score instead of a false hollow "wait" one.
      const nodes = scoreNodes(repo, u, running);
      const gate = gates.find((g) => g.unit === u.unit);
      // Item 6e: the canonical status→colour map, not a hand-picked class — the same active-must-be-
      // blue fix as the Studio card (projectStatusChip).
      //
      // Phase 2 "gate card" goal, items 3/4: this used to read a flat "at gate" for EVERY gate shape —
      // a queued start gate, a merge trial, a plain review, a loop round — the exact Finding 97/83/72
      // shape (this row's own mini-score dots, right below, already go live via `scoreNodes(..., running)`
      // while this chip stayed blind to it). Now consults the same `dispatchingFor` the gate card itself
      // uses (kind-aware — see shell.ts's own doc comment) and names the gate's kind when it doesn't.
      const gateDispatching = gate ? dispatchingFor(repo, running, gate) : undefined;
      const chip = gate
        ? gateDispatching
          ? statusBadge("active", "dispatching")
          : statusBadge("needs-you", gateKindLabel(gate))
        : statusBadge(fromWorkUnitStatus(u.status), u.status);
      const spend = unitSpend(repo, u);
      const artifacts = [...(repo.artifacts.get(`${u.project}/${u.unit}`)?.values() ?? [])].sort((a, b) => a.created.localeCompare(b.created));
      const artifactRows = artifacts
        .map((a) => {
          // Finding 59: an in-review artifact that's a loop's companion kind (F16) isn't at gate — see
          // the correction appended to the Finding 116 comment below.
          const isLoopCompanion =
            a.status === "in-review"
              ? (() => {
                  const team = repo.teams.get(a.produced_by.split("/")[0]);
                  return team ? isLoopCompanionKind(team, a.kind, capabilities) : false;
                })()
              : false;
          const ind =
            a.status === "approved" ? "ind-done"
            : a.status === "in-review" ? (isLoopCompanion ? "ind-gate-companion" : "ind-gate")
            : a.status === "superseded" ? "ind-super"
            : "ind-prog";
          // Finding 116: this row used to read a flat "at gate" for every open gate, the exact defect
          // Finding 97 already fixed on the unit chip above (`gateKindLabel(gate)`) — reuses that SAME
          // `gate`, already in scope, rather than a second lookup: only one gate is ever open per unit
          // (dagwalk.ts halts the whole unit at its first open gate), so `a.id === gate.target`
          // whenever `a.status` is in-review. `gate` should always be set here by that invariant; the
          // fallback string is defensive only, matching this file's own "never throw on live data"
          // posture elsewhere.
          //
          // Finding 59 correction (the invariant just above is mine, and it's wrong): "only one gate
          // is ever open per unit" is true of GATES — it is NOT true that `a.status === "in-review"`
          // implies `a.id === gate.target`. A loop round has TWO in-review artifacts by design
          // (dagwalk.ts:152's own halt: "both members of this round already sit in-review"); only the
          // one the loop's `until` names is `gate.target`, its companion is the other. Left visible
          // rather than deleted — the reasoning was plausible and the artifact-only invariant IS true,
          // it just doesn't cover the loop-round case this file's own artifact list also renders.
          //
          // Finding 84: a plain-step artifact a member failed to produce (dagwalk.ts#writeBlocked) is
          // marked `superseded` the instant a retry succeeds — the SAME status a genuine content
          // revision gets — with nothing left in `a.status` to tell them apart. `a.blocked_reason` is
          // set once at write time and never cleared by that supersession, so it's the real signal.
          const st =
            a.status === "in-review"
              ? isLoopCompanion
                ? `<span class="st" title="this round's decision is on the other artifact, not this one">under review</span>`
                : `<span class="st gate">${esc(gate ? (gateDispatching ? "dispatching" : gateKindLabel(gate)) : "at gate")}</span>`
            : a.status === "superseded" && a.blocked_reason ? `<span class="st blocked" title="${esc(a.blocked_reason)}">failed dispatch</span>`
            : `<span class="st">${esc(a.status)}</span>`;
          const label = a.status === "superseded" ? `<s>${esc(artifactFileName(a))}</s>` : esc(artifactFileName(a));
          return `<div class="aitem"><span class="ind ${ind}"></span><a class="nm link mono" href="${artifactHref(u.project, u.unit, a.id)}">${label}</a>${st}</div>`;
        })
        .join("\n");
      const reviewRounds = artifacts.filter((a) => a.kind === "review").length;
      const summon = gate
        ? `<button class="verb is-secondary" data-summon="tpl-gate-${esc(gate.target)}">Review gate</button>`
        : "";
      const openCls = gate ? " is-open" : "";
      // Finding 140: right where the operator lands on THIS unit's own row immediately after clicking
      // Merge (this row, in this list, on this project page) — the merge gate card that was just
      // approved sat in this exact list a moment ago. `checkoutSyncNotice` (derive.ts) reads the flag
      // `doApproveMerge` recorded at execution time; undefined, no callout, on every unit whose merge
      // never left the checkout behind.
      const checkoutSync = checkoutSyncNotice(repo, u);
      const checkoutSyncHtml = checkoutSync ? callout("warning", renderInline(checkoutSync)) : "";
      // The work-unit row: `card()`'s row variant — a type glyph as `pre`, the title/path wrapper as a
      // pre-built `title` block (already self-contained, so no extra `titleCls` wrap), the status chip
      // top-right, and the collapsed summary (desc + mini-score) plus the expand-in-place detail as
      // `body`/`meta` — the same top-left title / top-right status / bottom supporting-content anatomy
      // every other card type uses, just with its own `.unit`/`.unit__*` class family (design brief:
      // the STRUCTURE is shared, the CSS vocabulary stays per-surface — see components.ts#card).
      return card({
        cls: `unit${openCls}`,
        // Tier 2 (amendment 1 §2 R4, 1-10s resolution/refetch): a stable key a same-URL client-side
        // refresh (assets/app.js's `flashLiveChanges`) uses to notice THIS row's status changed and
        // flash it, without needing to guess from title text.
        attrs: { "data-unit": u.unit },
        topCls: "unit__head",
        // Amendment 1 §1/R3: the base brief's work-unit-type glyph, from the same entity-icon family
        // the gate card's own marker already draws (Phase 2 cluster 3 part 3 — this used to render the
        // raw `type.glyph` unicode character, the one holdout of the three designated places).
        pre: `<span class="unit__glyph">${typeGlyphSvg(type?.name)}</span>`,
        title: `<div class="unit__titlewrap"><span class="unit__name">${esc(u.unit)}</span><a class="unit__path link mono" href="/run/${esc(u.project)}/${esc(u.unit)}">work/${esc(u.project)}/${esc(u.unit)}/</a></div>`,
        status: chip,
        // Fault 4: routed through renderInline, not plain esc() — a member-authored summary's own
        // `**bold**` (e.g. adapters.ts's own stub brief: "**Problem.** ...") must render as emphasis
        // here, the same as it would if the reader opened the artifact itself.
        body: `<div class="unit__desc">${renderInline(unitSummary(repo, u))}</div>\n        ${checkoutSyncHtml}\n        ${miniScoreHtml(nodes)}`,
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
    .map((g) => `<template id="tpl-gate-${esc(g.target)}">${gateCardHtml(repo, g, now, { cta: true, dispatching: dispatchingFor(repo, running, g) })}</template>`)
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
      // DOCS-WALKTHROUGH-3 item 1: "Units shipped" — the Studio page's own name for this exact
      // measure (all-time shipped-unit count), scoped here to this project instead of the whole repo.
      // Previously "Shipped units" — same count, gratuitously reworded, so a reader had to know which
      // screen they were on to recognise it as the same number.
      { value: `${units.filter((u) => u.status === "shipped").length}`, label: "Units shipped" },
      // DOCS-WALKTHROUGH-3 item 1: this cell used to read unit *lifecycle* status ("Active" — how many
      // units are in the active state, whether or not anyone is working on them right now) under a
      // label ("Active") that looked like the Studio page's "Members running" — a live *invocation*
      // count. They were never the same measure. Rather than leave two different numbers sharing
      // look-alike names, this cell now reports the actual same measure "Members running" names:
      // `membersRunningHere`, the project-scoped twin of Studio's `running.length`, already computed
      // above for the header status chip. A reader who knows what Studio's number means now knows what
      // this one means too, on both screens, with no separate "how many units are active" number lost
      // — each unit row already carries its own lifecycle status chip.
      { value: `${membersRunningHere}`, label: "Members running", attr: { name: "data-runningstat", value: membersRunningHere } },
      // Amendment 1 §3, review F13: a stat tints only when actionable, gate-brass only — the same
      // rule the Studio page's own "Gates on you" stat already gets (Phase 2 cluster 3 part 3: this
      // page's identical stat was the one holdout, never actually tinted).
      { value: `${gates.length}`, label: "Gates open", actionable: gates.length > 0 },
      { value: reviewMedian === null ? "&mdash;" : `${reviewMedian}`, label: "Median review rounds" },
      { value: `$${projectSpend(repo, projectName).toFixed(2)}`, label: "Spend" },
    ])}
    ${pointerPanel}
    <section class="sec"><div class="sec__h"><h2>Work units</h2></div><div class="units">${unitRows}</div></section>
  </main>`;

  const briefingBody = orchTurn(
    `<p class="turn__body">${esc(projectName)} has ${gates.length} unit${gates.length === 1 ? "" : "s"} at a gate. Expand a unit to open its run or summon its gate here.</p>`,
    { captionTime: captionTime(now.toISOString(), now), captionLabel: "briefing" },
  );
  const orch = orchestratorPanel(projectName, status, briefingBody, "", root, now);

  return shell(`levare · ${projectName}`, "Open context", pageBody(rail, main, orch, templates), status);
}

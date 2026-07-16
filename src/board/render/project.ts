// ---------------------------------------------------------------------------
// PROJECT
// ---------------------------------------------------------------------------

import type { Repo } from "../../repo.ts";
import {
  esc,
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
  type ScoreNode,
} from "../../derive.ts";
import { loadExtras } from "../../extra.ts";
import type { DaemonInvocation } from "../../daemon.ts";
import { resolveOrchestratorStatus, type OrchestratorStatus } from "../../orchestrator-status.ts";
import { dotClass, fromNodeState, fromWorkUnitStatus } from "../status.ts";
import { statusBadge, paceBadge, iconLink, statStrip, card, orchTurn } from "../components.ts";
import {
  shell,
  pageBody,
  railNav,
  gateCardHtml,
  dispatchingFor,
  orchestratorPanel,
  projectStatusChip,
  artifactFileName,
  artifactHref,
  artifactTokenLink,
  tokenLink,
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

  const briefingBody = orchTurn(
    `<p class="turn__body">${esc(projectName)} has ${gates.length} unit${gates.length === 1 ? "" : "s"} at a gate. Expand a unit to open its run or summon its gate here.</p>`,
    { captionTime: captionTime(now.toISOString(), now), captionLabel: "briefing" },
  );
  const orch = orchestratorPanel(projectName, status, briefingBody, "", root, now);

  return shell(`levare · ${projectName}`, "Open context", pageBody(rail, main, orch, templates), status);
}

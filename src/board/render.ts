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
  medianGateResponseDays,
  type OpenGate,
  type ScoreNode,
} from "./derive.ts";
import { loadExtras } from "./extra.ts";
import { buildTimeline } from "./timeline.ts";
import { diagnose } from "../doctor.ts";

const ASSETS = `<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet"/>
<link rel="stylesheet" href="/styles.css?v=6"/>`;

function shell(title: string, railToggleLabel: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(title)}</title>
${ASSETS}
</head>
<body>
<div class="mobilebar">
  <button class="togglebtn" data-rail-toggle aria-label="${esc(railToggleLabel)}">&#9776;</button>
  <a class="logo" href="/studio"><span class="logo__mark"><i></i><b></b></span><span class="logo__word">levare</span></a>
  <span class="sp"></span>
  <button class="themebtn" data-theme-toggle></button>
</div>
${body}
<script src="/app.js?v=5"></script>
</body>
</html>
`;
}

function logo(): string {
  return `<a class="logo" href="/studio"><span class="logo__mark"><i></i><b></b></span><span class="logo__word">levare</span></a>`;
}

function derivLine(text: string): string {
  return `<span class="deriv">${esc(text)}</span>`;
}

function orchHead(scope: string): string {
  return `<header class="orch__head"><span class="orch__mark"><i></i><b></b></span><span class="orch__title">Orchestrator</span><span class="orch__scope">${esc(scope)} scope</span></header>`;
}

function composer(): string {
  return `<div class="composer"><form data-orchestrator-form><input type="text" placeholder="Message the Orchestrator" aria-label="Message the Orchestrator"/><span class="ret">&#8629;</span></form></div>`;
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

// ---------------------------------------------------------------------------
// Gate card — the one actionable element in the product (fixed anatomy: kind marker, name, producer,
// context, consumes/lineage, age, cost, verbs). Same markup renders in the studio inbox, project
// summon templates, and the run-view Orchestrator panel.
// ---------------------------------------------------------------------------

function gateCardHtml(repo: Repo, gate: OpenGate, now: Date, opts: { cta?: boolean } = {}): string {
  const unit = repo.units.find((u) => u.project === gate.project && u.unit === gate.unit);
  const type = unit ? repo.types.get(unit.type) : undefined;
  const glyph = type?.glyph ?? "&#9702;";

  if (gate.type === "start") {
    return `<article class="gate gate--start" data-gate-project="${esc(gate.project)}" data-gate-target="${esc(gate.unit)}">
      <div class="gate__top">
        <span class="gate__marker" aria-hidden="true">${glyph}</span>
        <div class="gate__body">
          <div class="gate__name-row">${tokenLink(gate.project, gate.unit, gate.unit)}<span class="gate__producer">${esc(type?.name ?? "")}</span></div>
          <p class="gate__ctx">Queued work unit awaiting your beat to begin.</p>
          <div class="gate__meta"><span>&#8592; ${esc(gate.project)}/${esc(gate.unit)}</span></div>
        </div>
        <span class="gate__badge is-start">start gate</span>
      </div>
      <div class="gate__verbs">
        <button class="verb is-primary" data-verb="start">Start</button>
        <button class="verb is-secondary" data-verb="notyet">Not yet</button>
        <button class="verb" data-verb="rescope">Re-scope</button>
      </div>
    </article>`;
  }

  const art = gate.artifact!;
  const ctx = esc(firstParagraph(art.body ?? ""));
  const consumesHtml = art.consumes.length
    ? `<div class="gate__consumes">consumes: ${art.consumes.map((id) => tokenLink(gate.project, gate.unit, id)).join(" &middot; ")}</div>`
    : "";
  const age = ageLabel(art.created, now);
  const cost = costLabel(art.usage);
  const nameRow = `<div class="gate__name-row">${tokenLink(gate.project, gate.unit, artifactFileName(art))}<span class="gate__producer">member/<b>${esc(gate.member ?? "")}</b></span></div>`;
  const meta = `<div class="gate__meta"><span>${esc(age)}</span>${cost ? `<span class="cost">${cost}</span>` : ""}</div>`;
  const verbs = `<div class="gate__verbs">
        <button class="verb is-primary" data-verb="approve">Approve</button>
        <button class="verb is-secondary" data-verb="request">Request changes</button>
        <button class="verb is-danger" data-verb="reject">Reject</button>
      </div>`;

  if (opts.cta) {
    return `<article class="gate gate--cta" data-gate-project="${esc(gate.project)}" data-gate-target="${esc(art.id)}">
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
  return `<article class="gate" data-gate-project="${esc(gate.project)}" data-gate-target="${esc(art.id)}">
    <div class="gate__top">
      <span class="gate__marker" aria-hidden="true">${glyph}</span>
      <div class="gate__body">
        ${nameRow}
        <p class="gate__ctx">${ctx}</p>
        ${consumesHtml}
        ${meta}
      </div>
      <span class="gate__badge">on you</span>
    </div>
    ${verbs}
  </article>`;
}

// ---------------------------------------------------------------------------
// Mini-score (project view) — the score's dot-strip compression.
// ---------------------------------------------------------------------------

function miniScoreHtml(nodes: ScoreNode[]): string {
  return `<div class="miniscore unit__score">${nodes
    .map((n) => {
      if (n.shape === "diamond") return `<span class="diamond is-gate"></span>`;
      const stateCls = n.state === "done" ? "is-done" : n.state === "wait" ? "is-wait" : n.state === "rejected" ? "is-danger" : "is-wait";
      return `<span class="dot ${stateCls}"></span>`;
    })
    .join("")}</div>`;
}

// The run-view score rail's node marker class (design brief: "status is the canonical state palette
// ... done/active/waiting/blocked/needs-you/failed"). Exported and pure so a test can assert, for
// every reachable state, that the class emitted here has a matching rule in the frozen
// assets/styles.css — a mismatched class renders a real DOM node with zero visible size, not a
// missing one, which is exactly the defect this guards (a "waiting" node emitting "snode is-wait",
// a class assets/styles.css has never defined; the stylesheet's actual hollow/queued rule is
// `.snode.upcoming`). "rejected" (the palette's "failed" state, red) maps to `.snode.is-danger`,
// added to assets/styles.css alongside the rest of the `is-danger` convention already used for
// every other failed-state element (`.verb.is-danger`, `.status-dot.is-danger`, the resolved-line
// decision) — closing NOTES.md gap G1.
export function scoreNodeClass(n: Pick<ScoreNode, "state">, isGate: boolean): string {
  if (n.state === "done") return "snode done";
  if (isGate) return "snode is-gate-open";
  if (n.state === "active") return "snode active";
  if (n.state === "blocked") return "snode blocked";
  if (n.state === "rejected") return "snode is-danger";
  return "snode upcoming"; // waiting/queued (default): hollow neutral, matches .snode.upcoming
}

// Studio project-card status chip (phase-6 gate fix-up). An open gate always wins (it needs the
// Conductor now, regardless of what else is happening); with none, "active" means real work is
// underway — an active unit, or a live member (once E2's process registry exists; today that count
// is always 0, never fabricated); with neither, the project is honestly "idle" — an empty project
// with no units and no activity was previously mislabeled "running", which read as fabricated
// activity for a project that had none.
export function projectStatusChip(projGates: number, anyUnitActive: boolean, membersRunning: number): string {
  if (projGates > 0) return `<span class="chip is-gate">${projGates} gate${projGates === 1 ? "" : "s"}</span>`;
  if (anyUnitActive || membersRunning > 0) return `<span class="chip is-progress">active</span>`;
  return `<span class="chip is-blocked">idle</span>`;
}

// ---------------------------------------------------------------------------
// STUDIO
// ---------------------------------------------------------------------------

export function renderStudio(repo: Repo, root: string, now: Date = new Date()): string {
  const extras = loadExtras(root);
  const gates = openGates(repo);
  const spend = repoSpend(repo);
  const median = medianGateResponseDays(repo);
  const shippedUnits = repo.units.filter((u) => u.status === "shipped").length;

  const projectRail = [...repo.projects.values()]
    .map((p) => {
      const units = repo.units.filter((u) => u.project === p.name).length;
      return `<a class="rel" href="/project/${esc(p.name)}"><span class="nm">${esc(p.name)}</span><span class="ag">${units}</span></a>`;
    })
    .join("\n");

  const registryNav = (["teams", "agents", "skills", "knowledge", "types", "connectors", "evals"] as const)
    .map((k) => {
      const count =
        k === "teams" ? repo.teams.size
        : k === "agents" ? repo.agents.size
        : k === "types" ? repo.types.size
        : k === "connectors" ? repo.connectors.size
        : k === "skills" ? extras.skills.length
        : k === "knowledge" ? extras.knowledge.length
        : extras.evals.length;
      return `<a href="/registry?entity=${k}">${k} <span class="ct">${count}</span></a>`;
    })
    .join("\n");

  const health = diagnose(
    [...repo.connectors.values()],
    { has: (n) => typeof process.env[n] === "string" && process.env[n] !== "" },
    (cmd) => (Bun.which(cmd) ? "found" : "not-found"),
  );
  const connectorRows = health
    .map((h) => `<div class="crow"><span class="status-dot ${h.status === "ok" ? "is-ok" : "is-idle"}"></span><span class="nm">${esc(h.name)}</span><span class="st">${esc(h.status)}</span></div>`)
    .join("\n");

  const ideasHtml = extras.ideas.length
    ? extras.ideas.map((i) => `<div class="idea">${esc(i.name)}</div>`).join("\n")
    : `<div class="idea" style="color:var(--fg-mute)">no ideas captured yet</div>`;

  const rail = `<aside class="rail">
    ${logo()}
    <section class="railsec"><h3 class="railsec__h">Projects</h3>${projectRail}</section>
    <section class="railsec"><h3 class="railsec__h">Registry</h3><nav class="reg-nav">${registryNav}</nav></section>
    <section class="railsec"><h3 class="railsec__h">Connectors</h3>${connectorRows}</section>
    <section class="railsec"><h3 class="railsec__h">Recent releases</h3><div class="stamp">no releases tracked yet</div></section>
    <section class="railsec"><h3 class="railsec__h">Ideas</h3>${ideasHtml}</section>
    <div class="railfoot"><button class="themebtn" data-theme-toggle></button><div class="stamp">derived from work/ on every request</div></div>
  </aside>`;

  const gateCards = gates.length
    ? gates.map((g) => gateCardHtml(repo, g, now)).join("\n")
    : `<p style="color:var(--fg-mute);font-size:13.5px">Nothing needs you right now.</p>`;

  const projectCards = [...repo.projects.values()]
    .map((p) => {
      const units = repo.units.filter((u) => u.project === p.name);
      const projGates = gates.filter((g) => g.project === p.name).length;
      const desc = units[0] ? esc(unitSummary(repo, units[0]).split(/(?<=[.!?])\s/)[0] ?? "") : "No work units yet.";
      const anyUnitActive = units.some((u) => u.status === "active");
      // membersRunning: always 0 until E2's live process registry exists (no fabricated activity).
      const chip = projectStatusChip(projGates, anyUnitActive, 0);
      return `<a class="pcard" href="/project/${esc(p.name)}">
        <div class="pcard__top">${chip}</div>
        <span class="pcard__name">${esc(p.name)}</span>
        <span class="pcard__desc">${desc}</span>
        <div class="pcard__meta"><span>${units.length} unit${units.length === 1 ? "" : "s"}</span></div>
      </a>`;
    })
    .join("\n");

  const main = `<main class="main">
    <header class="phead"><h1>Studio</h1>${derivLine("derived from work/ on every request")}</header>
    <div class="statstrip" style="grid-template-columns:repeat(5,1fr)">
      <div class="stat"><div class="n is-gate" data-gatestat="${gates.length}">${gates.length}</div><div class="l">Gates on you</div></div>
      <div class="stat"><div class="n">0</div><div class="l">Members running</div></div>
      <div class="stat"><div class="n">${shippedUnits}</div><div class="l">Units shipped &middot; 30d</div></div>
      <div class="stat"><div class="n">${median === null ? "&mdash;" : `${median.toFixed(median % 1 === 0 ? 0 : 1)}d`}</div><div class="l">Median gate response</div></div>
      <div class="stat"><div class="n">$${spend.toFixed(2)}</div><div class="l">Spend &middot; 30d</div></div>
    </div>
    <section class="sec" id="needs">
      <div class="sec__h"><h2>Needs you</h2><span class="sec__count" data-gatecount="${gates.length}">${gates.length}</span></div>
      ${gateCards}
    </section>
    <section class="sec">
      <div class="sec__h"><h2>Running now</h2></div>
      <p style="color:var(--fg-mute);font-size:13.5px">No live process registry yet &mdash; member activity here awaits a running Runner (see NOTES.md).</p>
    </section>
    <section class="sec">
      <div class="sec__h"><h2>Projects</h2></div>
      <div class="pcards">${projectCards}</div>
    </section>
  </main>`;

  const orch = `<aside class="orch">
    ${orchHead("studio")}
    <div class="orch__body">
      <div class="msg"><div class="msg__label"><span class="k">briefing</span><span class="t">now</span></div>
      <p class="msg__body">${gates.length ? `${gates.length} gate${gates.length === 1 ? " is" : "s are"} on you.` : "Nothing needs a decision right now."} Ask me about any project or open a gate to review it.</p></div>
    </div>
    ${composer()}
  </aside>`;

  return shell("levare · Studio", "Open registry", `<div class="app">${rail}${main}${orch}</div>`);
}

// ---------------------------------------------------------------------------
// PROJECT
// ---------------------------------------------------------------------------

export function renderProject(repo: Repo, projectName: string, now: Date = new Date()): string {
  const project = repo.projects.get(projectName);
  if (!project) throw new Error(`unknown project '${projectName}'`);
  const units = repo.units.filter((u) => u.project === projectName);
  const founding = foundingArtifacts(repo, projectName);
  const gates = openGates(repo).filter((g) => g.project === projectName);

  const foundingHtml = founding.length
    ? founding
        .map(
          (f) =>
            `<div class="founding">${tokenLink(projectName, f.artifact.unit, artifactFileName(f.artifact))}<span class="cite">cited ${f.citations}</span></div>`,
        )
        .join("\n")
    : `<div class="founding" style="color:var(--fg-mute)">no founding artifacts yet</div>`;

  const rail = `<aside class="rail">
    ${logo()}
    <section class="railsec">
      <h3 class="railsec__h">Pointer &middot; ${esc(projectName)}</h3>
      <div class="prow"><span class="k">repo</span><span class="v mono">${esc(project.repo)}</span></div>
      <div class="prow"><span class="k">deploy</span><span class="v mono">${project.deploy ? esc(project.deploy) : "&mdash;"}</span></div>
      <div class="prow"><span class="k">pace</span><span class="v">${esc(project.pace)}</span></div>
    </section>
    <section class="railsec"><h3 class="railsec__h">Constitution</h3>${foundingHtml}</section>
    <section class="railsec"><h3 class="railsec__h">Releases</h3><div class="stamp">no releases tracked yet</div></section>
    <div class="railfoot"><button class="themebtn" data-theme-toggle></button><div class="stamp">derived from work/${esc(projectName)}/ on every request</div></div>
  </aside>`;

  const unitRows = units
    .map((u) => {
      const type = repo.types.get(u.type);
      const nodes = scoreNodes(repo, u);
      const gate = gates.find((g) => g.unit === u.unit);
      const chip = gate ? `<span class="chip is-gate">at gate</span>` : u.status === "shipped" ? `<span class="chip is-approved">shipped</span>` : `<span class="chip is-progress">${esc(u.status)}</span>`;
      const spend = unitSpend(repo, u);
      const artifacts = [...(repo.artifacts.get(`${u.project}/${u.unit}`)?.values() ?? [])].sort((a, b) => a.created.localeCompare(b.created));
      const artifactRows = artifacts
        .map((a) => {
          const ind = a.status === "approved" ? "ind-done" : a.status === "in-review" ? "ind-gate" : a.status === "superseded" ? "ind-super" : "ind-prog";
          const st = a.status === "in-review" ? `<span class="st gate">at gate</span>` : `<span class="st">${esc(a.status)}</span>`;
          const label = a.status === "superseded" ? `<s>${esc(artifactFileName(a))}</s>` : esc(artifactFileName(a));
          return `<div class="aitem"><span class="ind ${ind}"></span><a class="nm link mono" href="/run/${esc(u.project)}/${esc(u.unit)}">${label}</a>${st}</div>`;
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
    .map((g) => `<template id="tpl-gate-${esc(g.target)}">${gateCardHtml(repo, g, now, { cta: true })}</template>`)
    .join("\n");

  const main = `<main class="main">
    <header class="phead">
      <div class="crumb"><a href="/studio">studio</a><span>/</span><span>${esc(projectName)}</span></div>
      <h1>${esc(projectName)}</h1>
      ${derivLine(`derived from work/${projectName}/ on every request`)}
    </header>
    <div class="statstrip">
      <div class="stat"><div class="n">${units.filter((u) => u.status === "shipped").length}</div><div class="l">Shipped units</div></div>
      <div class="stat"><div class="n">${units.filter((u) => u.status === "active").length}</div><div class="l">Active</div></div>
      <div class="stat"><div class="n">${gates.length}</div><div class="l">Gates open</div></div>
    </div>
    <section class="sec"><div class="sec__h"><h2>Work units</h2></div><div class="units">${unitRows}</div></section>
  </main>`;

  const orch = `<aside class="orch">
    ${orchHead("project")}
    <div class="orch__body">
      <div class="msg"><div class="msg__label"><span class="k">briefing</span><span class="t">now</span></div>
      <p class="msg__body">${esc(projectName)} has ${gates.length} unit${gates.length === 1 ? "" : "s"} at a gate. Expand a unit to open its run or summon its gate here.</p></div>
    </div>
    ${composer()}
  </aside>`;

  return shell(`levare · ${projectName}`, "Open context", `<div class="app">${rail}${main}${orch}</div>${templates}`);
}

// ---------------------------------------------------------------------------
// RUN
// ---------------------------------------------------------------------------

export function renderRun(repo: Repo, project: string, unitId: string, root: string, now: Date = new Date()): string {
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
      const chip =
        n.state === "done" ? `<span class="chip is-approved sstep__chip">approved</span>`
        : n.state === "gate" ? `<span class="chip is-gate sstep__chip">needs you</span>`
        : n.state === "rejected" ? `<span class="chip sstep__chip" style="color:var(--danger)">rejected</span>`
        : "";
      const sub = n.artifact ? `${esc(n.artifact.produced_by)} &middot; ${esc(artifactFileName(n.artifact))}` : "queued";
      return `<div class="sstep ${nodeCls}">
        <div class="sstep__rail"><span class="${snodeCls}" aria-hidden="true"></span><span class="sstep__line" aria-hidden="true"></span></div>
        ${av}
        <div class="sstep__body"><span class="sstep__label">${esc(n.kind)}</span><span class="sstep__sub">${sub}</span>${chip}</div>
      </div>`;
    })
    .join("\n");

  const rail = `<aside class="rail">
    ${logo()}
    <section class="railsec">
      <h3 class="railsec__h">Score &middot; ${esc(unitId)}</h3>
      <div class="score2" style="margin-top:14px">${scoreSteps}</div>
    </section>
    <div class="railfoot"><button class="themebtn" data-theme-toggle></button><div class="stamp">${esc(project)}/${esc(unitId)}</div></div>
  </aside>`;

  const timeline = buildTimeline(root, unit.dir);
  const timelineHtml = timeline.length
    ? timeline
        .map((t) => `<div class="tlrow"><span class="tlrow__time mono">${esc(t.ts.slice(0, 16).replace("T", " "))}</span><span class="tlrow__text">${t.text}</span></div>`)
        .join("\n")
    : `<p style="color:var(--fg-mute);font-size:13.5px">No recorded events yet.</p>`;

  const main = `<main class="main">
    <header class="phead">
      <div class="crumb"><a href="/studio">studio</a><span>/</span><a href="/project/${esc(project)}">${esc(project)}</a><span>/</span><span>${esc(unitId)}</span></div>
      <h1><span style="font-family:var(--mono);font-weight:400;margin-right:8px" aria-hidden="true">${type?.glyph ?? ""}</span>${esc(unitId)}</h1>
      ${derivLine(`${unit.type} · derived from work/${project}/${unitId}/ on every request`)}
    </header>
    <section class="sec">
      <div class="sec__h"><h2>Timeline <span class="mono" style="color:var(--fg-mute);font-weight:400">&middot; from git log + runner events</span></h2></div>
      <div class="timeline">${timelineHtml}</div>
    </section>
  </main>`;

  const gateHtml = gates.map((g) => gateCardHtml(repo, g, now, { cta: true })).join("\n");
  const orch = `<aside class="orch">
    ${orchHead("run")}
    <div class="orch__body">
      <div class="msg"><div class="msg__label"><span class="k">briefing</span><span class="t">now</span></div>
      <p class="msg__body">${gates.length ? `${esc(gates[0].label)} is ready for review below.` : "No open gate on this unit right now."}</p></div>
      ${gateHtml}
    </div>
    ${composer()}
  </aside>`;

  return shell(`levare · run · ${unitId}`, "Open score", `<div class="app app--run">${rail}${main}${orch}</div>`);
}

// ---------------------------------------------------------------------------
// REGISTRY
// ---------------------------------------------------------------------------

const REGISTRY_KINDS = ["teams", "agents", "skills", "knowledge", "types", "connectors", "evals"] as const;
type RegistryKind = (typeof REGISTRY_KINDS)[number];

// One bordered container per entity — the same `.card` recipe (background, border, radius, padding)
// every other screen's bordered containers use (gate cards, unit rows, project cards each have their
// own such class; the registry reuses `.card`, the one already used for a labeled panel, rather than
// inventing a new one). `.entity` stays alongside it purely for the kind-switch/is-editing JS hooks
// in app.js — it contributes no visual styling of its own beyond the flex layout `.card` already sets.
// Header, body, and the edit-source actions all live inside this one element; nothing floats beside it.
function entityBlock(kind: RegistryKind, title: string, kindLabel: string, inner: string, raw: string, active: boolean): string {
  return `<article class="entity card" data-entity="${kind}"${active ? "" : ' style="display:none"'}>
    <div class="entity__head"><span class="entity__title">${title}</span><span class="entity__kind">${esc(kindLabel)}</span></div>
    <div class="rendered">
      ${inner}
      <div class="editbar">
        <button class="togglebtn" data-edit-toggle>Edit source</button>
        <span class="validity"><span class="status-dot is-ok"></span>valid</span>
        <button class="togglebtn" data-save style="display:none;background:var(--fg);color:var(--bg);border-color:var(--fg)">Save and commit</button>
      </div>
    </div>
    <pre class="rawmd">${esc(raw)}</pre>
  </article>`;
}

export function renderRegistry(repo: Repo, root: string, activeEntity?: string): string {
  const extras = loadExtras(root);
  const active: RegistryKind = REGISTRY_KINDS.includes(activeEntity as RegistryKind) ? (activeEntity as RegistryKind) : "teams";

  const nav = REGISTRY_KINDS.map((k) => {
    const count =
      k === "teams" ? repo.teams.size
      : k === "agents" ? repo.agents.size
      : k === "types" ? repo.types.size
      : k === "connectors" ? repo.connectors.size
      : k === "skills" ? extras.skills.length
      : k === "knowledge" ? extras.knowledge.length
      : extras.evals.length;
    return `<a href="/registry?entity=${k}" data-goto="${k}" class="${k === active ? "is-active" : ""}">${k} <span class="ct">${count}</span></a>`;
  }).join("\n");

  const rail = `<aside class="rail">
    ${logo()}
    <section class="railsec"><h3 class="railsec__h">Registry</h3><nav class="reg-nav">${nav}</nav></section>
    <div class="railfoot"><button class="themebtn" data-theme-toggle></button><div class="stamp">derived from the repo root<br/>on every request</div></div>
  </aside>`;

  const teamBlocks = [...repo.teams.values()]
    .map((t) => {
      const inner = `<div class="card__h">Declared flow</div><div class="flowstrip">${t.members
        .map((m) => `<div class="m">${avatar(repo.agents.get(m)?.style.avatar ?? m.slice(0, 2), t.style.color)}<span class="mn">${esc(m)}</span></div>`)
        .join('<span class="arr">&rarr;</span>')}</div>
      <div class="card__h">Definition</div>
      <div class="prow"><span class="k">color</span><span class="v mono" style="color:${esc(t.style.color)}">${esc(t.style.color)}</span></div>
      <div class="prow"><span class="k">members</span><span class="v">${t.members.length} &middot; ${t.members.map(esc).join(", ")}</span></div>
      <div class="prow"><span class="k">produces</span><span class="v mono">${t.produces.map(esc).join(", ")}</span></div>`;
      return entityBlock("teams", `<span class="sq" style="width:16px;height:16px;border-radius:4px;background:${esc(t.style.color)}"></span> ${esc(t.name)}`, "team", inner, rawFor(root, "teams", t.name), active === "teams");
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
      return entityBlock("agents", `${avatar(a.style.avatar || a.name.slice(0, 2), team?.style.color, { size: "lg" })} ${esc(a.name)}`, `agent${team ? ` · ${team.name}` : ""}`, inner, rawFor(root, "agents", a.name), active === "agents");
    })
    .join("\n");

  const skillBlocks = extras.skills
    .map((s) => {
      const inner = `<div class="card__h">SKILL.md</div><p style="margin:0;font-size:13.5px;line-height:1.6;color:var(--fg-dim)">${esc(String(s.data.description ?? firstParagraph(s.body)))}</p>`;
      return entityBlock("skills", esc(s.name), "skill", inner, rawFor(root, "skills", s.name), active === "skills");
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
      return entityBlock("knowledge", esc(k.name), "knowledge", inner, rawFor(root, "knowledge", k.name), active === "knowledge");
    })
    .join("\n");

  const typeBlocks = [...repo.types.values()]
    .map((t) => {
      const inner = `<div class="card__h">Expected kinds</div>
      <div class="prow"><span class="k">glyph</span><span class="v mono">${t.glyph}</span></div>
      <div class="prow"><span class="k">expects</span><span class="v mono">${t.expects.map(esc).join(" &rarr; ")}</span></div>
      <div class="prow"><span class="k">gates</span><span class="v">${t.gates.map(esc).join(", ")}</span></div>`;
      return entityBlock("types", `<span style="font-family:var(--mono)">${t.glyph} ${esc(t.name)}</span>`, "type", inner, rawFor(root, "types", t.name), active === "types");
    })
    .join("\n");

  const connectorBlocks = [...repo.connectors.values()]
    .map((c) => {
      const inner = `<div class="card__h">Definition</div>
      <div class="prow"><span class="k">kind</span><span class="v mono">${esc(c.kind)}</span></div>
      <div class="prow"><span class="k">env</span><span class="v mono">${c.env.map(esc).join(", ")}</span></div>`;
      return entityBlock("connectors", esc(c.name), "connector", inner, rawFor(root, "connectors", c.name), active === "connectors");
    })
    .join("\n");

  const evalBlocks = extras.evals
    .map((e) => {
      const rubric = Array.isArray(e.data.rubric) ? (e.data.rubric as string[]) : [];
      const inner = `<div class="card__h">Rubric</div>${rubric.map((r) => `<div class="prow"><span class="v">${esc(String(r))}</span></div>`).join("\n")}`;
      return entityBlock("evals", esc(e.name), "eval", inner, rawFor(root, "evals", e.name), active === "evals");
    })
    .join("\n");

  const main = `<main class="main">
    <div class="crumb"><a href="/studio">studio</a><span>/</span><span>registry</span></div>
    ${derivLine("derived from the repo root on every request")}
    ${teamBlocks}${agentBlocks}${skillBlocks}${knowledgeBlocks}${typeBlocks}${connectorBlocks}${evalBlocks}
  </main>`;

  const orch = `<aside class="orch">
    ${orchHead("registry")}
    <div class="orch__body">
      <div class="msg"><div class="msg__label"><span class="k">briefing</span><span class="t">now</span></div>
      <p class="msg__body">This is the registry. The only write here is <span class="mono">Edit source</span>: raw markdown, a validity check, then <span class="mono">Save and commit</span>.</p></div>
    </div>
    ${composer()}
  </aside>`;

  return shell("levare · registry", "Open registry nav", `<div class="app">${rail}${main}${orch}</div>`);
}

function rawFor(root: string, dir: string, name: string): string {
  try {
    return readFileSync(`${root}/${dir}/${name}.md`, "utf8");
  } catch {
    return "";
  }
}

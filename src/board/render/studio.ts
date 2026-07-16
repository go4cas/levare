// ---------------------------------------------------------------------------
// STUDIO
// ---------------------------------------------------------------------------

import type { Repo } from "../../repo.ts";
import {
  esc,
  ageLabel,
  openGates,
  repoSpend,
  medianGateResponseDays,
  mostRelevantUnit,
  unitSummary,
  latestRelease,
  captionTime,
} from "../../derive.ts";
import { loadExtras } from "../../extra.ts";
import type { DaemonInvocation } from "../../daemon.ts";
import { resolveOrchestratorStatus, type OrchestratorStatus } from "../../orchestrator-status.ts";
import { statStrip, counter, emptyState, card, orchTurn } from "../components.ts";
import {
  shell,
  pageBody,
  railNav,
  gateCardHtml,
  dispatchingFor,
  orchestratorPanel,
  projectStatusChip,
} from "./shell.ts";

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

  const briefingBody = orchTurn(
    `<p class="turn__body">${gates.length ? `${gates.length} gate${gates.length === 1 ? " is" : "s are"} on you.` : "Nothing needs a decision right now."} Ask me about any project or open a gate to review it.</p>`,
    { captionTime: captionTime(now.toISOString(), now), captionLabel: "briefing" },
  );
  const orch = orchestratorPanel("studio", status, briefingBody);

  return shell("levare · Studio", "Open registry", pageBody(rail, main, orch), status);
}

// ---------------------------------------------------------------------------
// IDEA (item 1 + 6, phase 7.5) — the idea render view, the same read-only definition-browser pattern
// as render/artifact.ts, applied to a captured pitch with no project yet.
// ---------------------------------------------------------------------------

import type { Repo } from "../../repo.ts";
import { esc, captionTime } from "../../derive.ts";
import { loadExtras } from "../../extra.ts";
import { resolveOrchestratorStatus, type OrchestratorStatus } from "../../orchestrator-status.ts";
import { orchTurn } from "../components.ts";
import { shell, pageBody, railNav, orchestratorPanel, renderBody, lineageEmpty } from "./shell.ts";

export function renderIdea(repo: Repo, root: string, name: string, status: OrchestratorStatus = resolveOrchestratorStatus(), now: Date = new Date()): string {
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

  const briefingBody = orchTurn(
    `<p class="msg__body">${esc(idea.name)} is a captured pitch with no project yet. Promoting it opens an inception unit.</p>`,
    { captionTime: captionTime(now.toISOString(), now), captionLabel: "briefing" },
  );
  const orch = orchestratorPanel("idea", status, briefingBody);

  return shell(`levare · idea · ${idea.name}`, "Open context", pageBody(rail, main, orch), status);
}

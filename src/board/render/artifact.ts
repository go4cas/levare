// ---------------------------------------------------------------------------
// ARTIFACT (item 1 + 6, phase 7.5) — the artifact render view. A read-only projection of one
// artifact markdown file: frontmatter as a header block, body below, and navigable lineage
// (consumes, supersedes/superseded-by, cited-by). Every artifact id elsewhere in the product links
// here now, instead of falling back to the unit/run view — "the definition-browser pattern applied
// to work/" (design brief). Built entirely from existing component vocabulary
// (`.card`/`.card__h`/`.prow`/`.founding`/`.chip`) — no new visual language.
// ---------------------------------------------------------------------------

import type { Repo } from "../../repo.ts";
import type { Artifact } from "../../types.ts";
import { esc, ageLabel, costLabel, findArtifactInProject, supersededByOf, citedByOf, captionTime } from "../../derive.ts";
import { loadExtras } from "../../extra.ts";
import { resolveOrchestratorStatus, type OrchestratorStatus } from "../../orchestrator-status.ts";
import { fromArtifactStatus } from "../status.ts";
import { statusBadge, orchTurn } from "../components.ts";
import {
  shell,
  pageBody,
  railNav,
  orchestratorPanel,
  memberAvatar,
  artifactFileName,
  artifactTokenLink,
  renderBody,
  lineageEmpty,
} from "./shell.ts";

// Reuses `.founding`/`.cite` (already the "artifact reference + a badge" row, used for the project
// view's constitution list) for every lineage edge — consumes, supersedes, superseded-by, cited-by.
function lineageItem(art: Artifact, badge: string): string {
  return `<div class="founding">${artifactTokenLink(art.project, art.unit, art.id, artifactFileName(art))}<span class="cite">${esc(badge)}</span></div>`;
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

  // NOTES UI11: migrated off the pre-UI8 `.msg__label` markup onto the shared `orchTurn` primitive —
  // this screen had never been brought forward when UI8 introduced the turn/caption anatomy.
  const briefingBody = orchTurn(
    `<p class="turn__body">${esc(art.kind)} ${esc(art.id)}, produced by ${esc(art.produced_by)}. ${citedBy.length ? `Cited by ${citedBy.length} artifact${citedBy.length === 1 ? "" : "s"}.` : "Not cited by anything yet."}</p>`,
    { captionTime: captionTime(now.toISOString(), now), captionLabel: "briefing" },
  );
  const orch = orchestratorPanel("artifact", status, briefingBody);

  return shell(`levare · ${art.kind} · ${art.id}`, "Open context", pageBody(rail, main, orch), status);
}

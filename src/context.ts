// levare context assembly (§6). The fixed recipe, in order, assembled deterministically so
// `levare context <agent> --unit <u> --dry-run` prints the exact bytes a member would receive:
//
//   1. agent definition body            5. project house rules
//   2. referenced skills                6. the task string from the flow step
//   3. referenced knowledge files       7. consumed artifacts — paths or inline, per agent declaration
//   4. team charter + team LEARNINGS.md
//
// Item 7's delivery mode is a per-agent declaration (ruling C9, NOTES D6): `agent.context_artifacts`
// defaults to `"paths"` — root-relative paths only, unchanged since phase 3 — for a member with
// filesystem access to the studio. A member that cannot reach the studio (e.g. a wrapped CLI
// deliberately run in an isolated scratch directory, so a repo's own config can't alter its
// behaviour) declares `"inline"`: section 7 then carries the full text (frontmatter + body) of every
// consumed artifact instead of a pointer it could never open. The consumed set is the unit's
// currently-approved artifacts — the vetted inputs available at that step — in both modes.

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parseFrontmatter } from "./yaml.ts";
import type { Repo } from "./repo.ts";
import { teamOf } from "./env.ts";

export class ContextError extends Error {}

interface Capability {
  member: string;
  kind: string;
}

function kindMatches(kind: string, label: string): boolean {
  return kind === label || kind.endsWith(`-${label}`);
}

/** The flow steps (label + resolved kind) an agent can satisfy, in flow order. */
function agentSteps(repo: Repo, teamName: string, caps: Capability[], agent: string): Array<{ label: string; kind: string }> {
  const team = repo.teams.get(teamName);
  if (!team) throw new ContextError(`no team '${teamName}'`);
  const labels: string[] = [];
  for (const node of team.flow) {
    if (node.kind === "step") labels.push(node.step);
    else if (node.kind === "loop") labels.push(node.between[0], node.between[1]);
  }
  const out: Array<{ label: string; kind: string }> = [];
  for (const label of labels) {
    const cap = caps.find((c) => c.member === agent && kindMatches(c.kind, label));
    if (cap) out.push({ label, kind: cap.kind });
  }
  return out;
}

// The unit's on-disk artifacts as (id, status, root-relative path), so consumed paths are addressable
// and deterministic. Mirrors repo.ts's discovery (single-file and one-index folder artifacts).
// Exported for adapters.ts (ruling C12): the same "currently-approved artifacts" set assembleContext
// hands a member as its consumed paths is what levare itself records as `consumes:` on the artifact it
// authors — one derivation, not a second copy that could drift from what the member was actually given.
export function unitArtifactPaths(root: string, project: string, unit: string): Array<{ id: string; status: string; rel: string }> {
  const unitDir = join(root, "work", project, unit);
  const out: Array<{ id: string; status: string; rel: string }> = [];
  if (!existsSync(unitDir)) return out;
  const record = (file: string) => {
    const { data } = parseFrontmatter(readFileSync(file, "utf8"));
    if (typeof data.id !== "string") return;
    out.push({ id: data.id, status: String(data.status ?? ""), rel: relative(root, file) });
  };
  for (const name of readdirSync(unitDir).sort()) {
    const full = join(unitDir, name);
    const s = statSync(full);
    if (s.isFile() && name.endsWith(".md") && name !== "unit.md") record(full);
    else if (s.isDirectory()) {
      const index = readdirSync(full).filter((n) => n.endsWith(".md"))[0];
      if (index) record(join(full, index));
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export interface AssembleOptions {
  root: string;
  agent: string;
  unit: string;
  /** Which flow step's context to assemble; defaults to the agent's last step in flow order. */
  step?: string;
  /** Capability source (member→kind), same shape the Runner uses; provided by the caller. */
  capabilities: Capability[];
}

/** Assemble the §6 context for an agent at a step in a unit and return it as an exact string. */
export function assembleContext(repo: Repo, opts: AssembleOptions): string {
  const agent = repo.agents.get(opts.agent);
  if (!agent) throw new ContextError(`no agent '${opts.agent}' in ${opts.root}`);
  const team = teamOf(repo, opts.agent);
  if (!team) throw new ContextError(`agent '${opts.agent}' belongs to no team`);

  // Locate the unit and its project.
  const unitRow = repo.units.find((u) => u.unit === opts.unit);
  if (!unitRow) throw new ContextError(`no work unit '${opts.unit}' under ${opts.root}`);
  const project = repo.projects.get(unitRow.project);

  // Resolve the step (default: the agent's last producing step in flow order).
  const steps = agentSteps(repo, team.name, opts.capabilities, opts.agent);
  if (steps.length === 0) throw new ContextError(`agent '${opts.agent}' produces no kind in team '${team.name}' flow`);
  const chosen = opts.step ? steps.find((s) => s.label === opts.step) : steps[steps.length - 1];
  if (!chosen) throw new ContextError(`agent '${opts.agent}' has no flow step '${opts.step}' (has: ${steps.map((s) => s.label).join(", ")})`);

  const consumed = unitArtifactPaths(opts.root, unitRow.project, opts.unit).filter((a) => a.status === "approved");
  const inline = agent.context_artifacts === "inline";

  // ---- Render the recipe, section by section, in fixed order. ----
  const out: string[] = [];
  out.push(`context · ${team.name}/${agent.name} · ${unitRow.project}/${opts.unit} · step ${chosen.label} → ${chosen.kind}`);
  out.push(
    `recipe: agent · skills · knowledge · team charter+learnings · project house rules · task · ${inline ? "consumed artifacts (inline)" : "consumed paths"}`,
  );
  out.push("");

  const kindTag = agent.kind === "native" ? `native, ${agent.model ?? "?"}` : agent.kind;
  out.push(`── 1. agent · ${agent.name} (${kindTag}) ──`);
  out.push(agent.body);
  out.push("");

  out.push("── 2. skills ──");
  const skills = agent.skills ?? [];
  if (skills.length === 0) out.push("(none)");
  for (const s of skills) {
    out.push(`### ${s}`);
    out.push(readEntityBody(opts.root, "skills", s));
    out.push("");
  }
  if (skills.length === 0) out.push("");

  out.push("── 3. knowledge ──");
  const knowledge = agent.knowledge ?? [];
  if (knowledge.length === 0) out.push("(none)");
  for (const k of knowledge) {
    out.push(`### ${k}`);
    out.push(readEntityBody(opts.root, "knowledge", k));
    out.push("");
  }
  if (knowledge.length === 0) out.push("");

  out.push(`── 4. team charter · ${team.name} ──`);
  out.push(team.charter);
  out.push("");
  out.push(`── team learnings · ${team.name} ──`);
  out.push(team.learnings.trim() === "" ? "(none)" : team.learnings.trim());
  out.push("");

  out.push(`── 5. project house rules · ${unitRow.project} ──`);
  out.push(project ? project.houseRules : "(none)");
  out.push("");

  out.push("── 6. task ──");
  out.push(chosen.label);
  out.push("");

  out.push(
    inline
      ? "── 7. consumed artifacts (inline — full text, per agent declaration `context_artifacts: inline`, ruling C9) ──"
      : "── 7. consumed artifacts (paths only — never contents) ──",
  );
  if (consumed.length === 0) out.push("(none)");
  for (const c of consumed) {
    if (!inline) {
      out.push(c.rel);
      continue;
    }
    out.push(`── consumed artifact: ${c.id} (${c.rel}) ──`);
    out.push(readFileSync(join(opts.root, c.rel), "utf8").replace(/\n$/, ""));
    out.push(`── end consumed artifact: ${c.id} ──`);
  }

  return out.join("\n") + "\n";
}

// Read an entity's markdown body (frontmatter stripped) from a registry dir, or a not-found marker.
// A referenced name resolves to either the flat convention (`<dir>/<name>.md`) or the Agent Skills
// folder convention (`<dir>/<name>/SKILL.md`, a directory bundling the skill with its own supporting
// files) — the latter matters for `skills/`, where the golden/scaffolded `new-project` skill lives.
function readEntityBody(root: string, dir: string, name: string): string {
  const flat = join(root, dir, `${name}.md`);
  const bundled = join(root, dir, name, "SKILL.md");
  const file = existsSync(flat) ? flat : existsSync(bundled) ? bundled : null;
  if (!file) return `(not found: ${dir}/${name}.md)`;
  const { body } = parseFrontmatter(readFileSync(file, "utf8"));
  return body.trim();
}

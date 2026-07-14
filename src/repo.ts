// levare repo loaders. Read the studio repo (or a fixture subtree) into the domain shapes in
// types.ts. Files are the truth (invariant 2): every entity is re-read from disk on demand; the
// loaders hold no state. Frontmatter is parsed with the phase-1 subset-YAML parser, and the whole
// tree is passed through the phase-1 validator so the Runner never walks an off-contract repo —
// "enforce the artifact contract at boundaries" with the same validator, not a second copy of it.

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { parseFrontmatter, type YamlValue } from "./yaml.ts";
import { validatePath, type ValidationResult } from "./validate.ts";
import {
  parseFlow,
  type Agent,
  type Artifact,
  type ArtifactStatus,
  type Connector,
  type Project,
  type StudioSettings,
  type Team,
  type TypeTemplate,
  type Usage,
  type WorkUnit,
  type WorkUnitStatus,
} from "./types.ts";

export interface Repo {
  root: string;
  teams: Map<string, Team>;
  agents: Map<string, Agent>;
  types: Map<string, TypeTemplate>;
  projects: Map<string, Project>;
  connectors: Map<string, Connector>;
  units: WorkUnit[];
  /** Artifacts keyed by `${project}/${unit}` → id → artifact (the on-disk starting state). */
  artifacts: Map<string, Map<string, Artifact>>;
  /** Studio-level settings (NOTES F11), read from the root `studio.md` singleton when present. */
  studio: StudioSettings;
}

export class RepoError extends Error {}

/** Load a repo tree. When `validate` is true (default), reject an off-contract repo up front. */
export function loadRepo(root: string, { validate = true }: { validate?: boolean } = {}): Repo {
  if (validate) {
    const result: ValidationResult = validatePath(root);
    if (!result.ok) {
      const first = result.errors.slice(0, 5).map((e) => `${e.code} ${e.file}: ${e.message}`);
      throw new RepoError(
        `repo does not validate (${result.errors.length} error(s)):\n  ${first.join("\n  ")}`,
      );
    }
  }

  const teamsDir = join(root, "teams");
  const teams = loadEntities(teamsDir, (d, body, file) => toTeam(d, body, file));
  const agents = loadEntities(join(root, "agents"), toAgent);
  const types = loadEntities(join(root, "types"), toType);
  const projects = loadEntities(join(root, "projects"), toProject);
  const connectors = loadEntities(join(root, "connectors"), toConnector);
  const { units, artifacts } = loadWork(join(root, "work"));
  const studio = loadStudioSettings(root);

  return { root, teams, agents, types, projects, connectors, units, artifacts, studio };
}

// ---------------------------------------------------------------------------
// studio.md — the root singleton carrying studio-level declarations (NOTES F11)
// ---------------------------------------------------------------------------

/** Read the root `studio.md` singleton, if present. Absent file → `{}` (no declarations), the
 * same "files are the truth, nothing invented" posture every other loader in this module takes. */
export function loadStudioSettings(root: string): StudioSettings {
  const file = join(root, "studio.md");
  if (!existsSync(file)) return {};
  const { data } = parseFrontmatter(readFileSync(file, "utf8"));
  return { orchestratorModel: optStr(data.orchestrator_model) };
}

/**
 * The studio's capability map, derived from the repo itself (NOTES F1): every agent's declared
 * `produces:` kinds, as the {member, kind}[] shape the Runner resolves a flow step against
 * (runner.ts#resolveStep, gates.ts#resolveStep). Files are the truth (invariant 2) — a capability is
 * a fact an agent DECLARES on disk, never one injected at construction. Deterministic order: agents
 * by name, then each agent's kinds in declared order.
 */
export function repoCapabilities(repo: Repo): Array<{ member: string; kind: string }> {
  const caps: Array<{ member: string; kind: string }> = [];
  for (const agent of [...repo.agents.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    for (const kind of agent.produces) caps.push({ member: agent.name, kind });
  }
  return caps;
}

// ---------------------------------------------------------------------------
// Entity directories (teams/ agents/ types/ projects/)
// ---------------------------------------------------------------------------

function loadEntities<T extends { name: string }>(
  dir: string,
  build: (data: Record<string, YamlValue>, body: string, file: string) => T,
): Map<string, T> {
  const out = new Map<string, T>();
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".md")) continue;
    // `<team>.learnings.md` is a plain note read alongside its team file, not an entity of its own.
    if (name.endsWith(".learnings.md")) continue;
    const file = join(dir, name);
    const { data, body } = parseFrontmatter(readFileSync(file, "utf8"));
    const entity = build(data, body, file);
    out.set(entity.name, entity);
  }
  return out;
}

function toTeam(d: Record<string, YamlValue>, body: string, file: string): Team {
  const name = reqStr(d, "name");
  // Team LEARNINGS.md lives beside the team file as `teams/<name>.learnings.md` (§6 recipe item 4).
  // It is a plain markdown note — read raw, not through the frontmatter parser.
  const learningsFile = join(dirname(file), `${name}.learnings.md`);
  const learnings = existsSync(learningsFile) ? readFileSync(learningsFile, "utf8") : "";
  return {
    name,
    consumes: strArr(d.consumes),
    produces: strArr(d.produces),
    members: strArr(d.members),
    flow: parseFlow(d.flow, name),
    style: { color: String((d.style as Record<string, YamlValue> | undefined)?.color ?? "") },
    guardrails: d.guardrails as Team["guardrails"],
    knowledge: d.knowledge ? strArr(d.knowledge) : undefined,
    connectors: d.connectors ? strArr(d.connectors) : undefined,
    charter: body.trim(),
    learnings,
  };
}

function toConnector(d: Record<string, YamlValue>): Connector {
  return {
    name: reqStr(d, "name"),
    kind: d.kind as Connector["kind"],
    server: optStr(d.server),
    command: optStr(d.command),
    env: strArr(d.env),
    scope: optStr(d.scope),
    // NOTES C13: defaults to "env" — unchanged behaviour for every connector defined before this
    // field existed.
    auth: d.auth === "subscription" ? "subscription" : "env",
    plan: optStr(d.plan),
  };
}

function toAgent(d: Record<string, YamlValue>, body: string): Agent {
  return {
    name: reqStr(d, "name"),
    kind: d.kind as Agent["kind"],
    produces: strArr(d.produces),
    model: optStr(d.model),
    command: d.command !== undefined ? strArr(d.command) : undefined,
    context_via: d.context_via === "stdin" ? "stdin" : d.context_via === "arg" ? "arg" : undefined,
    context_artifacts: d.context_artifacts === "inline" ? "inline" : d.context_artifacts === "paths" ? "paths" : undefined,
    cwd: optStr(d.cwd),
    timeout: typeof d.timeout === "number" ? d.timeout : undefined,
    result: optStr(d.result),
    server: optStr(d.server),
    skills: d.skills ? strArr(d.skills) : undefined,
    tools: d.tools ? strArr(d.tools) : undefined,
    knowledge: d.knowledge ? strArr(d.knowledge) : undefined,
    connectors: d.connectors ? strArr(d.connectors) : undefined,
    style: { avatar: String((d.style as Record<string, YamlValue> | undefined)?.avatar ?? "") },
    body: body.trim(),
  };
}

function toType(d: Record<string, YamlValue>): TypeTemplate {
  return {
    name: reqStr(d, "name"),
    glyph: reqStr(d, "glyph"),
    expects: strArr(d.expects),
    gates: strArr(d.gates),
    output: optStr(d.output),
    timebox: d.timebox === undefined ? undefined : (d.timebox as string | null),
    promotable_to: d.promotable_to === undefined ? undefined : (d.promotable_to as string | null),
  };
}

function toProject(d: Record<string, YamlValue>, body: string): Project {
  return {
    name: reqStr(d, "name"),
    repo: reqStr(d, "repo"),
    remote: (d.remote as string | null) ?? null,
    default_branch: reqStr(d, "default_branch"),
    deploy: (d.deploy as string | null) ?? null,
    pace: (d.pace as "auto" | "step") ?? "auto",
    overrides: d.overrides as Record<string, YamlValue> | undefined,
    houseRules: body.trim(),
  };
}

// ---------------------------------------------------------------------------
// work/<project>/<unit>/ — units + their artifacts
// ---------------------------------------------------------------------------

function loadWork(workRoot: string): { units: WorkUnit[]; artifacts: Repo["artifacts"] } {
  const units: WorkUnit[] = [];
  const artifacts: Repo["artifacts"] = new Map();
  if (!existsSync(workRoot)) return { units, artifacts };

  for (const project of dirs(workRoot)) {
    for (const unit of dirs(join(workRoot, project))) {
      const unitDir = join(workRoot, project, unit);
      const unitFile = join(unitDir, "unit.md");
      if (!existsSync(unitFile)) continue;
      const { data } = parseFrontmatter(readFileSync(unitFile, "utf8"));
      units.push({
        type: reqStr(data, "type"),
        status: (data.status as WorkUnitStatus) ?? "active",
        project: (optStr(data.project) ?? project) as string,
        unit: (optStr(data.unit) ?? unit) as string,
        after: data.after ? strArr(data.after) : undefined,
        team: optStr(data.team),
        timebox: data.timebox === undefined ? undefined : (data.timebox as string | null),
        budget: data.budget === undefined ? undefined : (data.budget as number | null),
        blocked_reason: optStr(data.blocked_reason),
        dir: unitDir,
      });
      artifacts.set(`${project}/${unit}`, loadUnitArtifacts(unitDir));
    }
  }
  return { units, artifacts };
}

function loadUnitArtifacts(unitDir: string): Map<string, Artifact> {
  const out = new Map<string, Artifact>();
  const add = (file: string) => {
    const { data, body } = parseFrontmatter(readFileSync(file, "utf8"));
    if (typeof data.id !== "string") return; // not an artifact index
    out.set(data.id, toArtifact(data, body));
  };
  for (const name of readdirSync(unitDir).sort()) {
    const full = join(unitDir, name);
    const s = statSync(full);
    if (s.isFile() && name.endsWith(".md") && name !== "unit.md") add(full);
    else if (s.isDirectory()) {
      // Folder artifact: exactly one markdown index carries the frontmatter (validator enforces).
      const index = readdirSync(full).filter((n) => n.endsWith(".md"))[0];
      if (index) add(join(full, index));
    }
  }
  return out;
}

/** Parse one artifact markdown document (frontmatter + body) into an Artifact. */
export function parseArtifactDoc(src: string): Artifact {
  const { data, body } = parseFrontmatter(src);
  return toArtifact(data, body);
}

function toArtifact(d: Record<string, YamlValue>, body: string): Artifact {
  return {
    kind: reqStr(d, "kind"),
    id: reqStr(d, "id"),
    unit: reqStr(d, "unit"),
    project: reqStr(d, "project"),
    status: d.status as ArtifactStatus,
    produced_by: reqStr(d, "produced_by"),
    consumes: strArr(d.consumes),
    supersedes: (d.supersedes as string | null) ?? null,
    approved_by: (d.approved_by as string | null) ?? null,
    created: reqStr(d, "created"),
    files: d.files ? strArr(d.files) : [],
    usage: (d.usage as Usage | null) ?? null,
    body: body.trim(),
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function dirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n !== ".git" && !n.startsWith("."))
    .filter((n) => {
      try {
        return statSync(join(dir, n)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

function reqStr(d: Record<string, YamlValue>, key: string): string {
  const v = d[key];
  if (typeof v !== "string") throw new RepoError(`expected string field '${key}', got ${typeof v}`);
  return v;
}
function optStr(v: YamlValue): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function strArr(v: YamlValue): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new RepoError(`expected a list, got ${typeof v}`);
  return v.map((x) => String(x));
}

/** First markdown paragraph of an artifact body = its display summary (NOTES A8). */
export function firstParagraph(body: string): string {
  const paras = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && !p.startsWith("#"));
  return paras[0] ?? "";
}

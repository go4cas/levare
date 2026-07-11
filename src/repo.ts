// levare repo loaders. Read the studio repo (or a fixture subtree) into the domain shapes in
// types.ts. Files are the truth (invariant 2): every entity is re-read from disk on demand; the
// loaders hold no state. Frontmatter is parsed with the phase-1 subset-YAML parser, and the whole
// tree is passed through the phase-1 validator so the Runner never walks an off-contract repo —
// "enforce the artifact contract at boundaries" with the same validator, not a second copy of it.

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { parseFrontmatter, type YamlValue } from "./yaml.ts";
import { validatePath, type ValidationResult } from "./validate.ts";
import {
  parseFlow,
  type Agent,
  type Artifact,
  type ArtifactStatus,
  type Project,
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
  units: WorkUnit[];
  /** Artifacts keyed by `${project}/${unit}` → id → artifact (the on-disk starting state). */
  artifacts: Map<string, Map<string, Artifact>>;
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

  const teams = loadEntities(join(root, "teams"), toTeam);
  const agents = loadEntities(join(root, "agents"), toAgent);
  const types = loadEntities(join(root, "types"), toType);
  const projects = loadEntities(join(root, "projects"), toProject);
  const { units, artifacts } = loadWork(join(root, "work"));

  return { root, teams, agents, types, projects, units, artifacts };
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
    const file = join(dir, name);
    const { data, body } = parseFrontmatter(readFileSync(file, "utf8"));
    const entity = build(data, body, file);
    out.set(entity.name, entity);
  }
  return out;
}

function toTeam(d: Record<string, YamlValue>, body: string): Team {
  const name = reqStr(d, "name");
  return {
    name,
    consumes: strArr(d.consumes),
    produces: strArr(d.produces),
    members: strArr(d.members),
    flow: parseFlow(d.flow, name),
    mode: (d.mode as "declarative" | "led") ?? "declarative",
    style: { color: String((d.style as Record<string, YamlValue> | undefined)?.color ?? "") },
    guardrails: d.guardrails as Team["guardrails"],
    knowledge: d.knowledge ? strArr(d.knowledge) : undefined,
    charter: body.trim(),
  };
}

function toAgent(d: Record<string, YamlValue>, body: string): Agent {
  return {
    name: reqStr(d, "name"),
    kind: d.kind as Agent["kind"],
    model: optStr(d.model),
    command: optStr(d.command),
    cwd: optStr(d.cwd),
    timeout: typeof d.timeout === "number" ? d.timeout : undefined,
    result: optStr(d.result),
    server: optStr(d.server),
    skills: d.skills ? strArr(d.skills) : undefined,
    tools: d.tools ? strArr(d.tools) : undefined,
    knowledge: d.knowledge ? strArr(d.knowledge) : undefined,
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
        timebox: data.timebox === undefined ? undefined : (data.timebox as string | null),
        budget: data.budget === undefined ? undefined : (data.budget as number | null),
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

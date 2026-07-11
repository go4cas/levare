// levare validator — a first-class, hand-rolled deliverable (PRD §3, §4, §5).
//
// Validates the studio repo (or any subtree of it): artifacts under work/<project>/<unit>/ and the
// registry/entity definition files under teams/ agents/ types/ projects/ connectors/ knowledge/
// evals/ ideas/. Dispatches a schema by file location, enforces required-and-typed fields, enum
// membership, unknown-key rejection, and cross-artifact consumes/supersedes resolution within a
// project. The approved-immutability rule is checked against git when the path is a git repo.

import { readdirSync, readFileSync, statSync, existsSync, realpathSync } from "node:fs";
import { join, relative, dirname, basename, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { parseFrontmatter, YamlError, type YamlValue } from "./yaml.ts";

export interface ValidationError {
  code: string;
  message: string;
  file: string;
  line?: number;
}

// Which branch the approved-immutability check took for a given target/artifact (see
// gitImmutabilityCheck). Exposed so tests can assert the *state*, not merely ok/not-ok — a
// wrong-state exit (e.g. masking a mutation as "no history") must never pass again.
//   S0  target is not a git repo         → cannot verify (valid)
//   S1  file has no history in HEAD       → nothing to compare (valid)
//   S2a file in HEAD and unchanged        → valid
//   S2b file in HEAD and differs          → MODIFIED_AFTER_APPROVAL
export type ImmutabilityState = "S0" | "S1" | "S2a" | "S2b";
export interface ImmutabilityCheck {
  file: string;
  state: ImmutabilityState;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
  fileCount: number;
  immutability: ImmutabilityCheck[];
}

// ---------------------------------------------------------------------------
// Schema DSL
// ---------------------------------------------------------------------------

type Scalar = "str" | "num" | "bool" | "date";
interface FieldSpec {
  type: Scalar | "str[]" | "num[]" | "enum" | "map" | "flow" | "list";
  required?: boolean;
  nullable?: boolean;
  enum?: string[];
  fields?: Record<string, FieldSpec>; // for type: "map"
}
interface Schema {
  name: string;
  fields: Record<string, FieldSpec>;
}

const STATUS_ENUM = ["draft", "in-review", "approved", "rejected", "superseded", "blocked"];

const ARTIFACT_SCHEMA: Schema = {
  name: "artifact",
  fields: {
    kind: { type: "str", required: true },
    id: { type: "str", required: true },
    unit: { type: "str", required: true },
    project: { type: "str", required: true },
    status: { type: "enum", required: true, enum: STATUS_ENUM },
    produced_by: { type: "str", required: true },
    consumes: { type: "str[]", required: true },
    supersedes: { type: "str", required: true, nullable: true },
    approved_by: { type: "str", required: true, nullable: true },
    created: { type: "date", required: true },
    files: { type: "str[]", required: true },
    usage: {
      type: "map",
      required: false,
      nullable: true,
      fields: {
        model: { type: "str", nullable: true },
        tokens_in: { type: "num", nullable: true },
        tokens_out: { type: "num", nullable: true },
        usd: { type: "num", nullable: true },
        wall_clock_s: { type: "num", nullable: true },
      },
    },
  },
};

const WORK_UNIT_SCHEMA: Schema = {
  name: "work-unit",
  fields: {
    type: { type: "enum", required: true, enum: ["inception", "feature", "fix", "spike", "research"] },
    status: { type: "enum", required: true, enum: ["active", "paused", "blocked", "shipped", "abandoned"] },
    project: { type: "str", required: false },
    unit: { type: "str", required: false },
    after: { type: "str[]", required: false },
    timebox: { type: "str", required: false, nullable: true },
    budget: { type: "num", required: false, nullable: true },
  },
};

const TEAM_SCHEMA: Schema = {
  name: "team",
  fields: {
    name: { type: "str", required: true },
    consumes: { type: "str[]", required: true },
    produces: { type: "str[]", required: true },
    members: { type: "str[]", required: true },
    flow: { type: "flow", required: true },
    mode: { type: "enum", required: false, enum: ["declarative", "led"] },
    style: { type: "map", required: true, fields: { color: { type: "str", required: true } } },
    guardrails: {
      type: "map",
      required: false,
      fields: {
        protected_paths: { type: "str[]" },
        never: { type: "str[]" },
      },
    },
    knowledge: { type: "str[]", required: false },
  },
};

const AGENT_SCHEMA: Schema = {
  name: "agent",
  fields: {
    name: { type: "str", required: true },
    kind: { type: "enum", required: true, enum: ["native", "cli", "remote"] },
    // native
    model: { type: "str", required: false },
    skills: { type: "str[]", required: false },
    tools: { type: "str[]", required: false },
    knowledge: { type: "str[]", required: false },
    // cli
    command: { type: "str", required: false },
    cwd: { type: "str", required: false },
    timeout: { type: "num", required: false },
    result: { type: "str", required: false },
    // remote
    server: { type: "str", required: false },
    style: { type: "map", required: true, fields: { avatar: { type: "str", required: true } } },
  },
};

const TYPE_SCHEMA: Schema = {
  name: "type",
  fields: {
    name: { type: "str", required: true },
    glyph: { type: "str", required: true },
    expects: { type: "str[]", required: true },
    gates: { type: "str[]", required: true },
    output: { type: "str", required: false },
    timebox: { type: "str", required: false, nullable: true },
    promotable_to: { type: "str", required: false, nullable: true },
  },
};

const PROJECT_SCHEMA: Schema = {
  name: "project",
  fields: {
    name: { type: "str", required: true },
    repo: { type: "str", required: true },
    remote: { type: "str", required: true, nullable: true },
    default_branch: { type: "str", required: true },
    deploy: { type: "str", required: true, nullable: true },
    pace: { type: "enum", required: true, enum: ["auto", "step"] },
    overrides: { type: "map", required: false },
  },
};

const CONNECTOR_SCHEMA: Schema = {
  name: "connector",
  fields: {
    name: { type: "str", required: true },
    kind: { type: "enum", required: true, enum: ["mcp", "cli"] },
    server: { type: "str", required: false },
    command: { type: "str", required: false },
    env: { type: "str[]", required: true },
    scope: { type: "str", required: false },
  },
};

const KNOWLEDGE_SCHEMA: Schema = {
  name: "knowledge",
  fields: {
    name: { type: "str", required: true },
    tags: { type: "str[]", required: false },
  },
};

const EVAL_SCHEMA: Schema = {
  name: "eval",
  fields: {
    name: { type: "str", required: true },
    unit: { type: "str", required: false },
    rubric: { type: "str[]", required: false },
  },
};

const SKILL_SCHEMA: Schema = {
  name: "skill",
  fields: {
    name: { type: "str", required: true },
    description: { type: "str", required: false },
    scripts: { type: "str[]", required: false },
  },
};

const IDEA_SCHEMA: Schema = {
  name: "idea",
  fields: {
    name: { type: "str", required: true },
    pitch: { type: "str", required: false },
    tags: { type: "str[]", required: false },
  },
};

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

interface DiscoveredArtifact {
  file: string; // path to the .md carrying frontmatter
  dir: string; // artifact directory (folder artifact) or the unit dir (single-file)
  isFolder: boolean;
  data: Record<string, YamlValue>;
}

/** Validate a path (single file or a directory tree). */
export function validatePath(target: string): ValidationResult {
  const errors: ValidationError[] = [];
  let fileCount = 0;
  const artifacts: DiscoveredArtifact[] = [];

  const st = existsSync(target) ? statSync(target) : null;
  if (!st) {
    return {
      ok: false,
      errors: [{ code: "NOT_FOUND", message: `path does not exist: ${target}`, file: target }],
      fileCount: 0,
      immutability: [],
    };
  }

  if (st.isFile()) {
    fileCount = 1;
    validateSingleFile(target, classify(target), errors, artifacts);
  } else {
    // Directory tree: walk registry folders + work/.
    const mdFiles = walkMarkdown(target);
    fileCount = mdFiles.length;
    for (const f of mdFiles) {
      validateSingleFile(f, classify(relative(target, f)), errors, artifacts);
    }
    // Folder-artifact discovery + index-count check on work/ subdirectories.
    discoverFolderArtifacts(target, errors, artifacts);
  }

  // Cross-artifact checks over everything discovered.
  crossReference(artifacts, errors);
  const immutability = gitImmutabilityCheck(target, artifacts, errors);

  return { ok: errors.length === 0, errors, fileCount, immutability };
}

type Kind =
  | { schema: Schema; isArtifact: boolean; isUnit: boolean }
  | { schema: null; isArtifact: false; isUnit: false };

function classify(relPath: string): Kind {
  const parts = relPath.split(sep).filter(Boolean);
  const top = parts[0];
  const base = basename(relPath);
  if (top === "work") {
    if (base === "unit.md") return { schema: WORK_UNIT_SCHEMA, isArtifact: false, isUnit: true };
    if (base === "ledger.ndjson") return { schema: null, isArtifact: false, isUnit: false };
    return { schema: ARTIFACT_SCHEMA, isArtifact: true, isUnit: false };
  }
  const map: Record<string, Schema> = {
    teams: TEAM_SCHEMA,
    agents: AGENT_SCHEMA,
    types: TYPE_SCHEMA,
    projects: PROJECT_SCHEMA,
    connectors: CONNECTOR_SCHEMA,
    knowledge: KNOWLEDGE_SCHEMA,
    evals: EVAL_SCHEMA,
    skills: SKILL_SCHEMA,
    ideas: IDEA_SCHEMA,
  };
  const schema = map[top];
  if (schema) return { schema, isArtifact: false, isUnit: false };
  return { schema: null, isArtifact: false, isUnit: false };
}

function walkMarkdown(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name === "node_modules" || name === ".git") continue;
      const full = join(dir, name);
      const s = statSync(full);
      if (s.isDirectory()) stack.push(full);
      else if (name.endsWith(".md")) out.push(full);
    }
  }
  return out.sort();
}

function validateSingleFile(
  file: string,
  kind: Kind,
  errors: ValidationError[],
  artifacts: DiscoveredArtifact[],
): void {
  if (!kind.schema) return; // unknown location or non-schema file (e.g. README) — skip.
  let data: Record<string, YamlValue>;
  try {
    ({ data } = parseFrontmatter(readFileSync(file, "utf8")));
  } catch (e) {
    if (e instanceof YamlError) {
      errors.push({ code: "PARSE_ERROR", message: e.message, file, line: e.line });
    } else {
      errors.push({ code: "PARSE_ERROR", message: String(e), file });
    }
    return;
  }
  validateAgainstSchema(data, kind.schema, file, errors);
  if (kind.schema === ARTIFACT_SCHEMA) validateArtifactSemantics(data, file, errors);
  if (kind.isArtifact) {
    artifacts.push({ file, dir: dirname(file), isFolder: false, data });
  }
  if (kind.schema === AGENT_SCHEMA) validateAgentVariant(data, file, errors);
}

function discoverFolderArtifacts(root: string, errors: ValidationError[], artifacts: DiscoveredArtifact[]): void {
  const workRoot = join(root, "work");
  if (!existsSync(workRoot)) return;
  // work/<project>/<unit>/<subdir>/  where subdir contains the folder artifact.
  for (const project of listDirs(workRoot)) {
    for (const unit of listDirs(join(workRoot, project))) {
      const unitDir = join(workRoot, project, unit);
      for (const entry of listDirs(unitDir)) {
        const artDir = join(unitDir, entry);
        const indices = readdirSync(artDir).filter((n) => n.endsWith(".md"));
        if (indices.length !== 1) {
          errors.push({
            code: "INDEX_COUNT",
            message: `folder artifact '${entry}' must have exactly one markdown index file, found ${indices.length}`,
            file: artDir,
          });
          continue;
        }
        // The index .md was already validated by walkMarkdown as an artifact and pushed with
        // isFolder:false; upgrade that record to a folder artifact.
        const indexPath = join(artDir, indices[0]);
        const existing = artifacts.find((a) => a.file === indexPath);
        if (existing) existing.isFolder = true;
      }
    }
  }
}

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => {
      try {
        return statSync(join(dir, n)).isDirectory() && n !== ".git";
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

function validateAgainstSchema(
  data: Record<string, YamlValue>,
  schema: Schema,
  file: string,
  errors: ValidationError[],
): void {
  // Unknown keys are errors (PRD §4: "unknown keys are errors, not warnings").
  for (const key of Object.keys(data)) {
    if (!(key in schema.fields)) {
      errors.push({ code: "UNKNOWN_KEY", message: `unknown key '${key}' in ${schema.name}`, file });
    }
  }
  for (const [key, spec] of Object.entries(schema.fields)) {
    const present = key in data;
    if (!present) {
      if (spec.required) {
        errors.push({ code: "MISSING_FIELD", message: `missing required field '${key}' in ${schema.name}`, file });
      }
      continue;
    }
    checkField(data[key], spec, key, schema.name, file, errors);
  }
}

function checkField(
  value: YamlValue,
  spec: FieldSpec,
  key: string,
  schemaName: string,
  file: string,
  errors: ValidationError[],
): void {
  if (value === null) {
    if (!spec.nullable) {
      errors.push({ code: "BAD_TYPE", message: `field '${key}' may not be null in ${schemaName}`, file });
    }
    return;
  }
  const typeError = (want: string) =>
    errors.push({ code: "BAD_TYPE", message: `field '${key}' must be ${want} in ${schemaName}`, file });

  switch (spec.type) {
    case "str":
      if (typeof value !== "string") typeError("a string");
      break;
    case "num":
      if (typeof value !== "number") typeError("a number");
      break;
    case "bool":
      if (typeof value !== "boolean") typeError("a boolean");
      break;
    case "date":
      if (typeof value !== "string" || !isIsoDate(value)) {
        errors.push({ code: "BAD_DATE", message: `field '${key}' must be an ISO date (YYYY-MM-DD) in ${schemaName}`, file });
      }
      break;
    case "enum":
      if (typeof value !== "string" || !spec.enum!.includes(value)) {
        errors.push({
          code: "BAD_ENUM",
          message: `field '${key}' must be one of [${spec.enum!.join(", ")}] in ${schemaName}, got '${String(value)}'`,
          file,
        });
      }
      break;
    case "str[]":
      if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) typeError("an array of strings");
      break;
    case "num[]":
      if (!Array.isArray(value) || !value.every((v) => typeof v === "number")) typeError("an array of numbers");
      break;
    case "list":
      if (!Array.isArray(value)) typeError("a list");
      break;
    case "flow":
      if (!Array.isArray(value)) {
        typeError("a list of flow steps");
      } else {
        for (const item of value) {
          if (item === null || typeof item !== "object" || Array.isArray(item)) {
            errors.push({ code: "BAD_TYPE", message: `each flow entry must be a mapping in ${schemaName}`, file });
            break;
          }
        }
      }
      break;
    case "map":
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        typeError("a mapping");
      } else if (spec.fields) {
        const m = value as Record<string, YamlValue>;
        for (const k of Object.keys(m)) {
          if (!(k in spec.fields)) {
            errors.push({ code: "UNKNOWN_KEY", message: `unknown key '${key}.${k}' in ${schemaName}`, file });
          }
        }
        for (const [k, subspec] of Object.entries(spec.fields)) {
          if (!(k in m)) {
            if (subspec.required) {
              errors.push({ code: "MISSING_FIELD", message: `missing required field '${key}.${k}' in ${schemaName}`, file });
            }
            continue;
          }
          checkField(m[k], subspec, `${key}.${k}`, schemaName, file, errors);
        }
      }
      break;
  }
}

function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// ---------------------------------------------------------------------------
// Artifact-specific semantics
// ---------------------------------------------------------------------------

function validateArtifactSemantics(data: Record<string, YamlValue>, file: string, errors: ValidationError[]): void {
  // An approved artifact must name its approver (conductor-only; §4).
  if (data.status === "approved" && (data.approved_by === null || data.approved_by === undefined)) {
    errors.push({
      code: "APPROVED_WITHOUT_APPROVER",
      message: "artifact with status 'approved' must set approved_by (conductor name + ISO date)",
      file,
    });
  }
  // A non-approved artifact must NOT carry an approver — only the Conductor sets approved_by on approval.
  if (data.status !== "approved" && data.approved_by !== null && data.approved_by !== undefined) {
    errors.push({
      code: "APPROVER_WITHOUT_APPROVAL",
      message: `approved_by is set but status is '${String(data.status)}'; only an approved artifact may name an approver`,
      file,
    });
  }
  // Listed supplementary files must exist next to the index.
  if (Array.isArray(data.files)) {
    for (const f of data.files) {
      if (typeof f !== "string") continue;
      if (!existsSync(join(dirname(file), f))) {
        errors.push({ code: "MISSING_FILE", message: `listed file '${f}' does not exist beside the artifact index`, file });
      }
    }
  }
}

function validateAgentVariant(data: Record<string, YamlValue>, file: string, errors: ValidationError[]): void {
  const need = (field: string) => {
    if (!(field in data) || data[field] === null) {
      errors.push({ code: "MISSING_FIELD", message: `agent kind '${String(data.kind)}' requires '${field}'`, file });
    }
  };
  if (data.kind === "native") need("model");
  else if (data.kind === "cli") {
    need("command");
    need("result");
  } else if (data.kind === "remote") need("server");
}

// ---------------------------------------------------------------------------
// Cross-artifact reference resolution (consumes / supersedes)
// ---------------------------------------------------------------------------

function crossReference(artifacts: DiscoveredArtifact[], errors: ValidationError[]): void {
  // Build per-project and global id indexes.
  const byProject = new Map<string, Map<string, DiscoveredArtifact>>();
  const globalIds = new Map<string, DiscoveredArtifact>();
  for (const a of artifacts) {
    const project = String(a.data.project ?? "");
    const id = a.data.id;
    if (typeof id !== "string") continue;
    let proj = byProject.get(project);
    if (!proj) byProject.set(project, (proj = new Map()));
    if (proj.has(id)) {
      errors.push({ code: "DUPLICATE_ID", message: `duplicate artifact id '${id}' within project '${project}'`, file: a.file });
    } else {
      proj.set(id, a);
    }
    globalIds.set(id, a);
  }

  for (const a of artifacts) {
    const project = String(a.data.project ?? "");
    const proj = byProject.get(project);
    const resolve = (id: string, kind: "consumes" | "supersedes") => {
      if (proj?.has(id)) return;
      if (globalIds.has(id)) {
        errors.push({
          code: "CROSS_PROJECT_CONSUMES",
          message: `${kind} id '${id}' resolves to a different project than '${project}'`,
          file: a.file,
        });
      } else {
        errors.push({
          code: kind === "consumes" ? "UNRESOLVED_CONSUMES" : "UNRESOLVED_SUPERSEDES",
          message: `${kind} id '${id}' does not resolve to an artifact in project '${project}'`,
          file: a.file,
        });
      }
    };
    if (Array.isArray(a.data.consumes)) {
      for (const c of a.data.consumes) if (typeof c === "string") resolve(c, "consumes");
    }
    if (typeof a.data.supersedes === "string") resolve(a.data.supersedes, "supersedes");
  }
}

// ---------------------------------------------------------------------------
// Approved-immutability check (against git; §4)
// ---------------------------------------------------------------------------

// Environment-sensitivity audit (NOTES.md A4):
//  - Baseline is always `HEAD`, never a hardcoded branch name (`main`/`master`/`trunk`), so the
//    check is correct on any repo regardless of its default branch.
//  - Paths are canonicalized with realpath on BOTH sides before the repo-relative path is computed.
//    `git rev-parse --show-toplevel` returns a symlink-resolved path (on macOS the temp dir lives
//    under /var, a symlink to /private/var), while the validator holds the caller's uncanonical
//    path. Without canonicalization, `relative(toplevel, file)` produces a bogus `../../…` path,
//    `cat-file -e HEAD:<bogus>` fails, and the check would fall through to S1 — masking a mutation
//    as "no history". Canonicalizing both sides makes the relative path correct regardless.
//  - Two distinct "valid" states are separated explicitly (S0 no repo, S1 no history) so a missing
//    baseline is never silently mistaken for an unchanged one.
//  - The S2 comparison uses `git diff` (which honours the repo's own normalization, e.g.
//    core.autocrlf) rather than a raw byte-compare of `git show` output, so a checkout filter
//    cannot manufacture a false "modified" verdict.
// Returns the state taken for each approved artifact (plus a single S0 entry when the target is not
// a git repo) so callers/tests can assert the branch, not merely the pass/fail outcome.
function gitImmutabilityCheck(
  target: string,
  artifacts: DiscoveredArtifact[],
  errors: ValidationError[],
): ImmutabilityCheck[] {
  const checks: ImmutabilityCheck[] = [];
  const toplevel = gitToplevel(target);
  if (!toplevel) {
    checks.push({ file: canonical(target), state: "S0" }); // not a git repo; cannot verify.
    return checks;
  }
  for (const a of artifacts) {
    if (a.data.status !== "approved") continue;
    // Canonicalize both sides so the symlinked-tmpdir case (macOS /var → /private/var) resolves.
    const rel = relative(toplevel, canonical(a.file));
    // S1: does the approved file exist in the current commit at all?
    const inHead = spawnSync("git", ["-C", toplevel, "cat-file", "-e", `HEAD:${rel}`], { encoding: "utf8" });
    if (inHead.status !== 0) {
      checks.push({ file: a.file, state: "S1" }); // no history for this file yet — nothing to compare.
      continue;
    }
    // S2: has the working tree diverged from the committed (approved) version?
    // `git diff --quiet` exits 0 when identical, 1 when different, >1 on error.
    const diff = spawnSync("git", ["-C", toplevel, "diff", "--quiet", "HEAD", "--", rel], { encoding: "utf8" });
    if (diff.status === 1) {
      checks.push({ file: a.file, state: "S2b" });
      errors.push({
        code: "MODIFIED_AFTER_APPROVAL",
        message: "approved artifact has been modified since its committed version; approved artifacts are immutable",
        file: a.file,
      });
    } else {
      // status 0 (identical) — or >1, which we treat as unverifiable-but-not-a-violation (fail-open).
      checks.push({ file: a.file, state: "S2a" });
    }
  }
  return checks;
}

// realpath, tolerant of a path that does not resolve (returns the input unchanged).
function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function gitToplevel(target: string): string | null {
  const dir = existsSync(target) && statSync(target).isDirectory() ? target : dirname(target);
  const r = spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (r.status !== 0) return null;
  // Canonicalize so it matches realpath-resolved artifact paths on symlinked filesystems.
  return canonical(r.stdout.trim());
}

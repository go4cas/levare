// Generates docs/guide/05-reference/cheatsheets/*.md — one terse field-reference page per registry
// entity, plus the artifact contract and the work-unit shape — computed from the same schema data
// `levare validate` enforces (REGISTRY_SCHEMAS, ARTIFACT_SCHEMA, WORK_UNIT_SCHEMA, STUDIO_SCHEMA in
// src/validate.ts). Run via `bun run docs:generate`.
//
// Single source of truth: everything in a cheatsheet's field table and skeleton is computed from the
// schema — including each row's Description (FieldSpec.description) and any surfaced vocabulary
// (FieldSpec.vocabulary, e.g. agent `tools:` against SDK_TOOL_NAMES), both sourced from the schema's
// own doc comments in src/validate.ts/src/types.ts, never invented here. The only hand-authored
// content is the two one-line maps below (DESCRIPTIONS, BODY_PURPOSE) — exactly what the schema cannot
// express (editorial prose). Nav front-matter (title/parent/grand_parent/has_children/nav_order, for
// just-the-docs' sidebar) is likewise computed here, never hand-added to a generated file.
// tests/cheatsheets.test.ts asserts the committed files are byte-identical to a fresh regeneration
// (drift) and that every generated skeleton actually passes the real validator in a scratch studio
// (NOTES DOCS1).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ARTIFACT_SCHEMA,
  REGISTRY_SCHEMAS,
  STUDIO_SCHEMA,
  WORK_UNIT_SCHEMA,
  validatePath,
  type FieldSpec,
  type Schema,
} from "../src/validate.ts";
import type { YamlValue } from "../src/yaml.ts";

export const OUT_DIR = join(import.meta.dir, "..", "docs", "guide", "05-reference", "cheatsheets");

// The two hand-maintained, purely editorial facts a schema cannot express — one sentence each, keyed
// by the schema's own `name` (never by directory, so a renamed/added schema fails loudly below rather
// than silently falling back to nothing). Every other word in a generated cheatsheet is computed.
const DESCRIPTIONS: Record<string, string> = {
  agent: "A member: what it can produce, and how to invoke it.",
  team: "A group with a job — what it consumes, what it produces, its members, and its flow.",
  connector: "An external system a member can be granted.",
  project: "A pointer at a product repo, and its constitution.",
  type: "A work-unit template: what a unit of this type is expected to produce, and where it gates.",
  knowledge: "A reference document injected into member context by name.",
  eval: "A rubric scoring a work-unit type's output.",
  skill: "Reusable instructions a member's context can include by name.",
  idea: "A captured pitch with no project yet.",
  artifact: "A markdown deliverable with YAML frontmatter, produced by a member and tracked through review.",
  "work-unit": "A unit of work — the project/type/status/team declaration a flow walk runs against.",
  studio: "The root-level studio singleton — settings that apply across the whole studio.",
};

const BODY_PURPOSE: Record<string, string> = {
  agent: "The member's system prompt (native) or wrapper notes (cli).",
  team: "The team charter, injected into every member's context; a sibling `<name>.learnings.md` is appended after it.",
  connector: "Not used — a connector carries no body content.",
  project: "The house rules, injected into every member's context for this project.",
  type: "Not used — a type carries no body content.",
  knowledge: "Injected verbatim into a member's context under the knowledge section.",
  eval: "Not used — the frontmatter `rubric` is what's read; the body is stored but never rendered or consumed.",
  skill: "Injected verbatim into a member's context under the skills section.",
  idea: "Rendered as display prose on the idea's board page; only the frontmatter `pitch` is used on promotion.",
  artifact:
    "The artifact's actual document. Its first paragraph is the dashboard summary, and it's injected into a " +
    "consumer's context when that consuming agent declares `context_artifacts: inline`.",
  "work-unit": "Not used — a human-readable brief may be written here, but nothing reads it back.",
  studio: "Not used — the studio singleton carries no body content.",
};

// A real, currently-priced model id (see src/pricing.ts's BASELINE_PRICING) — any other string a
// `model`/`orchestrator_model` skeleton value could use trips UNKNOWN_MODEL in the real validator.
// This is generation machinery only; it never appears in a rendered field table.
const MODEL_PLACEHOLDER = "claude-sonnet-5";

// Error codes the skeleton-repair loop below knows how to fix generically by re-filling the named
// field with one placeholder element — both are "declared non-empty but is empty" checks the schema's
// own `required: true` on a `str[]` field can't express (validateAgentVariant / validateConnectorAuth
// in src/validate.ts). If either code is renamed there, the fix silently stops applying and
// tests/cheatsheets.test.ts's skeleton-validates check fails, naming the stale code.
const EMPTY_ARRAY_FIX_FIELD: Record<string, string> = {
  EMPTY_PRODUCES: "produces",
  EMPTY_ENV: "env",
};

interface EntityDef {
  schema: Schema;
  /** Registry directory (e.g. "agents"), or null for entities with bespoke placement (artifact, work-unit, studio). */
  dir: string | null;
  /** Where a skeleton file for this entity should be written under a scratch studio root, for the validator to see. */
  place: (root: string) => string;
  /** How the file is referred to in the cheatsheet title, e.g. "agents/<name>.md". */
  pathHint: string;
}

function registryEntities(): EntityDef[] {
  return Object.entries(REGISTRY_SCHEMAS).map(([dir, schema]) => ({
    schema,
    dir,
    place: (root: string) => join(root, dir, "skeleton.md"),
    pathHint: `${dir}/<name>.md`,
  }));
}

const ENTITIES: EntityDef[] = [
  ...registryEntities(),
  {
    schema: ARTIFACT_SCHEMA,
    dir: null,
    place: (root: string) => join(root, "work", "example-project", "example-unit", "skeleton.md"),
    pathHint: "work/<project>/<unit>/<file>.md",
  },
  {
    schema: WORK_UNIT_SCHEMA,
    dir: null,
    place: (root: string) => join(root, "work", "example-project", "example-unit", "unit.md"),
    pathHint: "work/<project>/<unit>/unit.md",
  },
  {
    schema: STUDIO_SCHEMA,
    dir: null,
    place: (root: string) => join(root, "studio.md"),
    pathHint: "studio.md",
  },
];

// ---------------------------------------------------------------------------
// Field table
// ---------------------------------------------------------------------------

function humanType(spec: FieldSpec): string {
  switch (spec.type) {
    case "str":
      return "string";
    case "num":
      return "number";
    case "bool":
      return "boolean";
    case "date":
      return "date (`YYYY-MM-DD`)";
    case "str[]":
      return "string[]";
    case "num[]":
      return "number[]";
    case "enum":
      return "enum";
    case "map":
      return "map";
    case "flow":
      return "flow list (`step` / `gate` / `loop` entries)";
    case "list":
      return "list";
    case "action-map":
      return "map (action name → argv template array)";
    case "str-map":
      return "map (arbitrary key → string)";
  }
}

interface Row {
  field: string;
  spec: FieldSpec;
}

function flattenFields(fields: Record<string, FieldSpec>, prefix = ""): Row[] {
  const rows: Row[] = [];
  for (const [key, spec] of Object.entries(fields)) {
    const field = prefix ? `${prefix}.${key}` : key;
    rows.push({ field, spec });
    if (spec.type === "map" && spec.fields) rows.push(...flattenFields(spec.fields, field));
  }
  return rows;
}

// A field's Description cell must never be empty (FieldSpec.description is a required TypeScript
// field precisely so this can't happen) — but a description written for a table cell must also never
// contain a literal `|`, which would silently break the row. Caught here, loudly, rather than shipping
// a mangled table.
function tableCell(text: string, field: string): string {
  if (text.includes("|")) throw new Error(`generate-cheatsheets: description for '${field}' contains '|', which breaks a markdown table cell`);
  return text;
}

function enumCell(spec: FieldSpec): string {
  if (spec.enum) return spec.enum.map((v) => `\`${v}\``).join(" · ");
  if (spec.vocabulary) return `*(${spec.vocabulary.length} known values — see below)*`;
  return "—";
}

function fieldTable(schema: Schema): string {
  const rows = flattenFields(schema.fields);
  const lines = ["| Field | Type | Required | Nullable | Enum values | Description |", "|---|---|---|---|---|---|"];
  for (const { field, spec } of rows) {
    const required = spec.required ? "✅" : "—";
    const nullable = spec.nullable ? "✅" : "—";
    lines.push(`| \`${field}\` | ${humanType(spec)} | ${required} | ${nullable} | ${enumCell(spec)} | ${tableCell(spec.description, field)} |`);
  }
  return lines.join("\n");
}

// A field whose legal values are a fixed, validated vocabulary that isn't expressible as this
// schema's own `enum` type (agent `tools:` against SDK_TOOL_NAMES today — a str[] checked element-wise
// by validateAgentTools, not a scalar enum) gets its vocabulary spelled out here instead of leaving a
// studio author to discover it from an UNKNOWN_TOOL error. Collapsed (`<details>`) since a vocabulary
// can run to dozens of names — `markdown="block"` is kramdown's own opt-in for parsing markdown
// (the backtick code spans) inside a raw HTML block, which it otherwise leaves as literal text.
function vocabularySections(schema: Schema): string {
  const rows = flattenFields(schema.fields).filter((r) => r.spec.vocabulary && r.spec.vocabulary.length > 0);
  if (rows.length === 0) return "";
  const sections = rows.map(({ field, spec }) => {
    const values = spec.vocabulary!.map((v) => `\`${v}\``).join(" · ");
    return `<details markdown="block">\n<summary><code>${field}</code> — ${spec.vocabulary!.length} valid values</summary>\n\n${values}\n\n</details>`;
  });
  return "\n" + sections.join("\n\n") + "\n";
}

function removedFieldsSection(schema: Schema): string {
  if (!schema.removed || Object.keys(schema.removed).length === 0) return "";
  const lines = ["", "### Removed fields", "", "A document still declaring one of these fails with `REMOVED_FIELD`, naming it:", ""];
  for (const [key, why] of Object.entries(schema.removed)) lines.push(`- \`${key}\` — ${why}`);
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Skeleton generation — computed from the schema, then proven valid against the REAL validator
// ---------------------------------------------------------------------------

function placeholderValue(key: string, spec: FieldSpec): YamlValue {
  if (spec.required && spec.nullable) return null; // an honest "no value yet" is itself a valid, realistic placeholder.
  switch (spec.type) {
    case "enum":
      return spec.enum![0];
    case "num":
      return 1;
    case "bool":
      return true;
    case "date":
      return "2024-01-01";
    case "str[]":
    case "num[]":
    case "list":
      return [];
    case "flow":
      return [{ gate: "human" }]; // a single, minimal, always-legal flow entry — binds to no member.
    case "action-map":
    case "str-map":
      return {}; // never a required field today — an empty mapping is a legal placeholder either way.
    case "map": {
      const m: Record<string, YamlValue> = {};
      if (spec.fields) for (const [k, sub] of Object.entries(spec.fields)) if (sub.required) m[k] = placeholderValue(k, sub);
      return m;
    }
    case "str":
      if (key === "model" || key === "orchestrator_model") return MODEL_PLACEHOLDER;
      return `example-${key}`;
  }
}

function initialCandidate(schema: Schema): Record<string, YamlValue> {
  const data: Record<string, YamlValue> = {};
  for (const [key, spec] of Object.entries(schema.fields)) {
    if (spec.required) data[key] = placeholderValue(key, spec);
  }
  return data;
}

// Extracts the last single-quoted token from a validator message — every MISSING_FIELD message (both
// the schema-level "missing required field 'X' in <schema>" and the agent-variant "agent kind 'K'
// requires 'X'") names the field last, so this needs no per-message-shape knowledge.
function lastQuoted(message: string): string | null {
  const all = [...message.matchAll(/'([^']*)'/g)];
  return all.length ? all[all.length - 1][1] : null;
}

function resolveFieldSpec(schema: Schema, dotted: string): FieldSpec | null {
  const [top, sub] = dotted.split(".");
  const topSpec = schema.fields[top];
  if (!topSpec) return null;
  if (sub === undefined) return topSpec;
  return topSpec.fields?.[sub] ?? null;
}

function setDotted(data: Record<string, YamlValue>, dotted: string, value: YamlValue): void {
  const [top, sub] = dotted.split(".");
  if (sub === undefined) {
    data[top] = value;
    return;
  }
  const existing = data[top];
  const m: Record<string, YamlValue> =
    existing !== null && typeof existing === "object" && !Array.isArray(existing) ? { ...(existing as Record<string, YamlValue>) } : {};
  m[sub] = value;
  data[top] = m;
}

function yamlScalar(v: YamlValue): string {
  if (v === null) return "null";
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  if (typeof v === "string") return /^[A-Za-z0-9_./-]+$/.test(v) ? v : JSON.stringify(v);
  throw new Error(`yamlScalar: unexpected value ${JSON.stringify(v)}`);
}

function serializeFrontmatter(data: Record<string, YamlValue>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
      } else if (value.every((v) => v !== null && typeof v === "object" && !Array.isArray(v))) {
        lines.push(`${key}:`);
        for (const item of value as Record<string, YamlValue>[]) {
          const entries = Object.entries(item);
          entries.forEach(([k, v], i) => lines.push(`${i === 0 ? "  - " : "    "}${k}: ${yamlScalar(v)}`));
        }
      } else {
        lines.push(`${key}: [${(value as YamlValue[]).map(yamlScalar).join(", ")}]`);
      }
    } else if (value !== null && typeof value === "object") {
      lines.push(`${key}:`);
      for (const [k, v] of Object.entries(value as Record<string, YamlValue>)) lines.push(`  ${k}: ${yamlScalar(v)}`);
    } else {
      lines.push(`${key}: ${yamlScalar(value)}`);
    }
  }
  return lines.join("\n");
}

const BODY_PLACEHOLDER = "Replace this line with the real content.";

// For an entity whose BODY_PURPOSE says the body is never read, telling the reader to "replace this
// line with the real content" is dishonest — there's no real content to write. Derived from
// BODY_PURPOSE (already hand-authored, single source of truth), not a new per-entity fact.
const BODY_UNUSED_PLACEHOLDER = 'This body is not used by levare — see "Body" below.';

function bodyTextFor(schema: Schema): string {
  const purpose = BODY_PURPOSE[schema.name];
  return purpose !== undefined && purpose.startsWith("Not used") ? BODY_UNUSED_PLACEHOLDER : BODY_PLACEHOLDER;
}

export function skeletonMarkdown(data: Record<string, YamlValue>, body: string = BODY_PLACEHOLDER): string {
  const fm = serializeFrontmatter(data);
  return `---\n${fm}${fm ? "\n" : ""}---\n\n${body}\n`;
}

const MAX_HEAL_ITERATIONS = 8;

/** Computes a required-fields-only skeleton, then repairs it against the REAL validator until it
 * passes (or gives up loudly) — so "valid" is proven, not asserted. See EMPTY_ARRAY_FIX_FIELD/
 * MODEL_PLACEHOLDER above for the only two fixed points not driven purely by validator feedback. */
function healSkeleton(entity: EntityDef, scratchRoot: string): Record<string, YamlValue> {
  const data = initialCandidate(entity.schema);
  const filePath = entity.place(scratchRoot);
  mkdirSync(join(filePath, ".."), { recursive: true });

  for (let i = 0; i < MAX_HEAL_ITERATIONS; i++) {
    writeFileSync(filePath, skeletonMarkdown(data, bodyTextFor(entity.schema)));
    const result = validatePath(scratchRoot);
    if (result.ok) return data;

    let fixedAny = false;
    for (const err of result.errors) {
      if (err.code === "MISSING_FIELD") {
        const field = lastQuoted(err.message);
        const spec = field ? resolveFieldSpec(entity.schema, field) : null;
        if (field && spec) {
          setDotted(data, field, placeholderValue(field.split(".").pop()!, spec));
          fixedAny = true;
        }
      } else if (err.code in EMPTY_ARRAY_FIX_FIELD) {
        const field = EMPTY_ARRAY_FIX_FIELD[err.code];
        data[field] = [`example-${field}`];
        fixedAny = true;
      }
    }
    if (!fixedAny) {
      throw new Error(
        `generate-cheatsheets: could not build a valid '${entity.schema.name}' skeleton — unresolved validator errors: ` +
          result.errors.map((e) => `${e.code}: ${e.message}`).join("; "),
      );
    }
  }
  throw new Error(`generate-cheatsheets: '${entity.schema.name}' skeleton did not converge after ${MAX_HEAL_ITERATIONS} iterations`);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function titleCase(schemaName: string): string {
  return schemaName
    .split("-")
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

// just-the-docs nav wiring for a per-entity cheatsheet page (PART 1 of the goal: cheatsheets are
// GENERATOR OUTPUT, so their nav front-matter — same as their Description column and surfaced
// vocabulary — is computed here, never hand-added). Nests two deep: grand_parent: Reference,
// parent: Cheatsheets. `navOrder` is the entity's 1-based position in ENTITIES, the same order the
// index below links them in, so the sidebar and the index page can never disagree about ordering.
function navFrontMatter(entity: EntityDef, navOrder: number): string {
  return `---
title: ${titleCase(entity.schema.name)}
parent: Cheatsheets
grand_parent: Reference
nav_order: ${navOrder}
---

`;
}

export function renderCheatsheet(entity: EntityDef, skeleton: Record<string, YamlValue>, navOrder: number): string {
  const { schema } = entity;
  const description = DESCRIPTIONS[schema.name];
  const bodyPurpose = BODY_PURPOSE[schema.name];
  if (description === undefined) throw new Error(`generate-cheatsheets: no DESCRIPTIONS entry for schema '${schema.name}'`);
  if (bodyPurpose === undefined) throw new Error(`generate-cheatsheets: no BODY_PURPOSE entry for schema '${schema.name}'`);

  return `${navFrontMatter(entity, navOrder)}# ${titleCase(schema.name)} — \`${entity.pathHint}\`

${description}

## Fields

${fieldTable(schema)}
${vocabularySections(schema)}${removedFieldsSection(schema)}
## Minimal valid skeleton

\`\`\`markdown
${skeletonMarkdown(skeleton, bodyTextFor(schema))}\`\`\`

**Body:** ${bodyPurpose}

---

Generated by \`scripts/generate-cheatsheets.ts\` from the \`${schema.name}\` schema in \`src/validate.ts\`.
Do not edit by hand — run \`bun run docs:generate\`.
`;
}

// ---------------------------------------------------------------------------
// Folder index — same ENTITIES list the per-entity loop below walks, so the linked set of cheatsheets
// can never fall out of sync with what's actually generated (ISSUE 1: docs/guide/05-reference/
// cheatsheets/ had no index page, so the bare folder URL 404s on GitHub Pages — jekyll-build-pages
// turns a folder's README.md into its index.html, same as every other reference sub-folder already
// relies on).
// ---------------------------------------------------------------------------

export const INDEX_FILENAME = "README.md";

// The index page's position among its just-the-docs siblings under docs/guide/05-reference/ — those
// pages are hand-authored (01-artifact-contract, 02-registry-entities, 03-cli, 04-constitution) and so
// carry their own nav_order outside this script's domain; this generator only needs to keep its own
// page's slot (3, between "registry entities" and "the CLI" — matching where 05-reference/README.md's
// own table already links it) consistent with them.
const CHEATSHEETS_NAV_ORDER = 3;

export function renderIndex(entities: EntityDef[]): string {
  const rows = entities.map((entity) => {
    const { schema } = entity;
    const description = DESCRIPTIONS[schema.name];
    if (description === undefined) throw new Error(`generate-cheatsheets: no DESCRIPTIONS entry for schema '${schema.name}'`);
    return `| [${titleCase(schema.name)}](${schema.name}.md) | ${description} |`;
  });

  return `---
title: Cheatsheets
parent: Reference
nav_order: ${CHEATSHEETS_NAV_ORDER}
has_children: true
---

# Cheatsheets

One generated page per registry entity, plus the artifact contract and the work-unit shape: a field
table, enum values, and a copy-pasteable skeleton that actually validates — computed straight from the
schemas in \`src/validate.ts\`, so they can't drift from what \`levare validate\` enforces.

| | |
|---|---|
${rows.join("\n")}

---

Generated by \`scripts/generate-cheatsheets.ts\`. Do not edit by hand — run \`bun run docs:generate\`.
`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function generateAll(): Map<string, string> {
  const scratchRoot = mkdtempSync(join(tmpdir(), "levare-cheatsheets-"));
  try {
    const out = new Map<string, string>();
    ENTITIES.forEach((entity, i) => {
      const skeleton = healSkeleton(entity, scratchRoot);
      out.set(`${entity.schema.name}.md`, renderCheatsheet(entity, skeleton, i + 1));
    });
    out.set(INDEX_FILENAME, renderIndex(ENTITIES));
    return out;
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const files = generateAll();
  mkdirSync(OUT_DIR, { recursive: true });
  for (const [name, content] of files) writeFileSync(join(OUT_DIR, name), content);
  console.log(`generate-cheatsheets: wrote ${files.size} file(s) to ${OUT_DIR}`);
}

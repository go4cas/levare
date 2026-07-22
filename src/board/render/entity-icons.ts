// levare — entity-icon family (Phase 2 cluster 1). Ports dev/foundation/icons.js's glyph bodies into
// the real app so the registry's kind-tag can render them — this is the glyph family's first in-
// context appearance (amendment 1 §1). Ported rather than imported: dev/foundation is the design
// workspace, never a runtime dependency of shipped code; this module is the one place the SVG paths
// live for server-rendered HTML strings (the board has no client-side icon library, by design).
//
// Ruling R2 (RATIFIED): thin geometric line-glyphs — single-weight strokes, geometric-abstract, one
// optical size, drawn as if by the same hand as the score rail's own circles/diamonds. Monochrome by
// construction (stroke="currentColor", fill="none") — the glyph carries TYPE only, never state or
// identity (Ruling R1); colour is entirely the caller's CSS context.
//
// Ruling R1 ("work-unit-type glyphs are absorbed, not duplicated"): the registry's own "types" kind
// lists work-unit-type DEFINITIONS (inception/feature/fix/spike/research) — each gets its own sibling
// glyph from WORK_UNIT_TYPE_ICON_BODY, keyed by the type's declared name, falling back to the generic
// "work unit" glyph for a type this set doesn't yet know (a studio-declared type beyond the five the
// base brief names).

import type { RegistryKind } from "./shell.ts";

const STROKE = 1.6;
const A = `fill="none" stroke="currentColor" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round"`;

// The ten registry entity types (amendment 1 §1) — only the seven the registry SCREEN itself browses
// (teams/agents/skills/knowledge/types/connectors/evals; project/idea/artifact render on their own
// screens, out of this cluster's scope) are wired to a RegistryKind below.
const ENTITY_ICON_BODY: Record<string, string> = {
  team: `<path d="M12 6 L7 18 L17 18 Z" ${A}/><circle cx="12" cy="6" r="1.6" ${A}/><circle cx="7" cy="18" r="1.6" ${A}/><circle cx="17" cy="18" r="1.6" ${A}/>`,
  agent: `<circle cx="12" cy="10" r="3.4" ${A}/><line x1="12" y1="13.4" x2="12" y2="18" ${A}/>`,
  "work-unit": `<line x1="12" y1="5" x2="12" y2="19" ${A}/><circle cx="12" cy="6.5" r="1.5" ${A}/><circle cx="12" cy="12" r="1.5" ${A}/><circle cx="12" cy="17.5" r="1.5" ${A}/>`,
  connector: `<line x1="4" y1="12" x2="9" y2="12" ${A}/><circle cx="12" cy="12" r="2.2" ${A}/><line x1="15" y1="12" x2="20" y2="12" ${A}/>`,
  skill: `<path d="M12 5 L18.06 8.5 L18.06 15.5 L12 19 L5.94 15.5 L5.94 8.5 Z" ${A}/>`,
  knowledge: `<circle cx="13.5" cy="13.5" r="3.6" ${A}/><line x1="5" y1="5" x2="10.85" y2="10.85" ${A}/>`,
  eval: `<line x1="6" y1="18" x2="18" y2="18" ${A}/><line x1="10" y1="18" x2="10" y2="8" ${A}/><line x1="15" y1="18" x2="15" y2="12" ${A}/>`,
};

// Work-unit-type sub-glyphs — same hand, same rules, absorbed per Ruling R1. Tighter live area than
// the entity icons above, matching how ◈▸◦ were used as compact inline markers.
const WORK_UNIT_TYPE_ICON_BODY: Record<string, string> = {
  inception: `<path d="M12 7 L17 12 L12 17 L7 12 Z" ${A}/>`,
  feature: `<path d="M9 7 L17 12 L9 17 Z" ${A}/>`,
  fix: `<circle cx="12" cy="12" r="5" ${A}/>`,
  spike: `<line x1="12" y1="12" x2="16" y2="8" ${A}/><line x1="12" y1="12" x2="16" y2="16" ${A}/><line x1="12" y1="12" x2="8" y2="16" ${A}/><line x1="12" y1="12" x2="8" y2="8" ${A}/>`,
  research: `<rect x="7" y="6" width="10" height="12" rx="1.5" ${A}/><line x1="9.5" y1="11" x2="14.5" y2="11" ${A}/><line x1="9.5" y1="14.5" x2="13" y2="14.5" ${A}/>`,
};

const REGISTRY_KIND_ICON: Partial<Record<RegistryKind, string>> = {
  teams: ENTITY_ICON_BODY.team,
  agents: ENTITY_ICON_BODY.agent,
  skills: ENTITY_ICON_BODY.skill,
  knowledge: ENTITY_ICON_BODY.knowledge,
  connectors: ENTITY_ICON_BODY.connector,
  evals: ENTITY_ICON_BODY.eval,
};

/** The glyph body for a registry card's kind-tag. `typeName` disambiguates the "types" kind, whose
 * entries are individual work-unit-type definitions, each carrying its own sibling glyph. */
export function registryKindIconBody(kind: RegistryKind, typeName?: string): string {
  if (kind === "types") return WORK_UNIT_TYPE_ICON_BODY[typeName ?? ""] ?? ENTITY_ICON_BODY["work-unit"];
  return REGISTRY_KIND_ICON[kind] ?? ENTITY_ICON_BODY["work-unit"];
}

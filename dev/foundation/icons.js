// levare — entity-icon family (Phase 1 foundation, amendment 1 §1)
//
// Ruling R2 (RATIFIED): thin geometric line-glyphs — single-weight strokes, geometric-abstract,
// one optical size, drawn as if by the same hand as the score rail's circles/diamonds. Not
// filled/solid, not literal/representational. Every glyph below is built from ONE shared
// vocabulary of primitives (circle, diamond, square, triangle, hexagon, straight line, dash,
// burst) so the ten-plus-five set reads as one family rather than ten clip-art bits.
//
// Grid: 24x24 viewBox, ~2px padding (live area 2..22), stroke-width 1.6, round caps/joins
// throughout — the one shared "hand". Monochrome by construction: every glyph uses
// stroke="currentColor" and fill="none", so colour is entirely the caller's context (never
// baked in) — glyph carries TYPE only, never state or identity (Ruling R1).
//
// Two tiers, per Ruling R1's "work-unit-type glyphs are absorbed, not duplicated":
//   - ENTITY_ICONS: the ten registry entity types (registry cards, sidebar, kind-tags — R3).
//   - WORK_UNIT_TYPE_ICONS: the five work-unit sub-glyphs (inception/feature/fix/spike/research),
//     redrawn from the base brief's ◈▸◦ set in this same house style, absorbed as siblings of
//     the whole family rather than a separate system. Scoped to the base brief's own three
//     places (project view unit rows, gate inbox, run view header) — glyphs confirm, never carry.

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.levareIcons = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const STROKE = 1.6;
  const COMMON_ATTRS = `fill="none" stroke="currentColor" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round"`;

  const ENTITY_ICONS = {
    team: {
      label: "team",
      desc: "a declared flow of members",
      body: `
        <path d="M12 6 L7 18 L17 18 Z" ${COMMON_ATTRS}/>
        <circle cx="12" cy="6" r="1.6" ${COMMON_ATTRS}/>
        <circle cx="7" cy="18" r="1.6" ${COMMON_ATTRS}/>
        <circle cx="17" cy="18" r="1.6" ${COMMON_ATTRS}/>`,
    },
    agent: {
      label: "agent",
      desc: "a member; produces artifacts",
      body: `
        <circle cx="12" cy="10" r="3.4" ${COMMON_ATTRS}/>
        <line x1="12" y1="13.4" x2="12" y2="18" ${COMMON_ATTRS}/>`,
    },
    "work-unit": {
      label: "work unit",
      desc: "one run of the pipeline",
      body: `
        <line x1="12" y1="5" x2="12" y2="19" ${COMMON_ATTRS}/>
        <circle cx="12" cy="6.5" r="1.5" ${COMMON_ATTRS}/>
        <circle cx="12" cy="12" r="1.5" ${COMMON_ATTRS}/>
        <circle cx="12" cy="17.5" r="1.5" ${COMMON_ATTRS}/>`,
    },
    project: {
      label: "project",
      desc: "one product's state",
      body: `<rect x="6" y="6" width="12" height="12" rx="2" ${COMMON_ATTRS}/>`,
    },
    connector: {
      label: "connector",
      desc: "an external system a member reaches",
      body: `
        <line x1="4" y1="12" x2="9" y2="12" ${COMMON_ATTRS}/>
        <circle cx="12" cy="12" r="2.2" ${COMMON_ATTRS}/>
        <line x1="15" y1="12" x2="20" y2="12" ${COMMON_ATTRS}/>`,
    },
    skill: {
      label: "skill",
      desc: "a SKILL.md capability bundle",
      body: `<path d="M12 5 L18.06 8.5 L18.06 15.5 L12 19 L5.94 15.5 L5.94 8.5 Z" ${COMMON_ATTRS}/>`,
    },
    knowledge: {
      label: "knowledge",
      desc: "context injected into a run",
      body: `
        <circle cx="13.5" cy="13.5" r="3.6" ${COMMON_ATTRS}/>
        <line x1="5" y1="5" x2="10.85" y2="10.85" ${COMMON_ATTRS}/>`,
    },
    eval: {
      label: "eval",
      desc: "a rubric scoring a work-unit type's output",
      body: `
        <line x1="6" y1="18" x2="18" y2="18" ${COMMON_ATTRS}/>
        <line x1="10" y1="18" x2="10" y2="8" ${COMMON_ATTRS}/>
        <line x1="15" y1="18" x2="15" y2="12" ${COMMON_ATTRS}/>`,
    },
    idea: {
      label: "idea",
      desc: "a captured pitch with no project yet",
      body: `<circle cx="12" cy="12" r="6.2" ${COMMON_ATTRS} stroke-dasharray="2.4 2.8"/>`,
    },
    artifact: {
      label: "artifact",
      desc: "a produced markdown file with status and lineage",
      body: `
        <path d="M8 5 H14 L17 8 V19 H8 Z" ${COMMON_ATTRS}/>
        <path d="M14 5 L14 8 L17 8" ${COMMON_ATTRS}/>
        <line x1="10" y1="13.5" x2="15" y2="13.5" ${COMMON_ATTRS}/>`,
    },
  };

  // Work-unit-type sub-glyphs — same hand, same rules, absorbed per Ruling R1. Tighter live area
  // (7..17) so they sit correctly as compact inline markers next to text, matching how ◈▸◦ were
  // used, rather than filling the full 24x24 canvas the entity icons use.
  const WORK_UNIT_TYPE_ICONS = {
    inception: {
      label: "inception",
      desc: "the start gate — redrawn from ◈",
      body: `<path d="M12 7 L17 12 L12 17 L7 12 Z" ${COMMON_ATTRS}/>`,
    },
    feature: {
      label: "feature",
      desc: "redrawn from ▸",
      body: `<path d="M9 7 L17 12 L9 17 Z" ${COMMON_ATTRS}/>`,
    },
    fix: {
      label: "fix",
      desc: "redrawn from ◦",
      body: `<circle cx="12" cy="12" r="5" ${COMMON_ATTRS}/>`,
    },
    spike: {
      label: "spike",
      desc: "ephemeral/disposable — its code never ships",
      body: `
        <line x1="12" y1="12" x2="16" y2="8" ${COMMON_ATTRS}/>
        <line x1="12" y1="12" x2="16" y2="16" ${COMMON_ATTRS}/>
        <line x1="12" y1="12" x2="8" y2="16" ${COMMON_ATTRS}/>
        <line x1="12" y1="12" x2="8" y2="8" ${COMMON_ATTRS}/>`,
    },
    research: {
      label: "research",
      desc: "document-ish — terminal artifact is a report",
      body: `
        <rect x="7" y="6" width="10" height="12" rx="1.5" ${COMMON_ATTRS}/>
        <line x1="9.5" y1="11" x2="14.5" y2="11" ${COMMON_ATTRS}/>
        <line x1="9.5" y1="14.5" x2="13" y2="14.5" ${COMMON_ATTRS}/>`,
    },
  };

  /** Full inline <svg> markup for one icon, ready to drop into markup. */
  function svg(id, sizePx, opts) {
    opts = opts || {};
    const entry = ENTITY_ICONS[id] || WORK_UNIT_TYPE_ICONS[id];
    if (!entry) throw new Error(`levareIcons: unknown icon id "${id}"`);
    const cls = opts.className ? ` class="${opts.className}"` : "";
    const title = opts.title !== false ? `<title>${entry.label}</title>` : "";
    return `<svg${cls} width="${sizePx}" height="${sizePx}" viewBox="0 0 24 24" role="img" aria-label="${entry.label}">${title}${entry.body}</svg>`;
  }

  return { ENTITY_ICONS, WORK_UNIT_TYPE_ICONS, svg, STROKE };
});

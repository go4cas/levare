# levare — landing brief, amendment 1: design ambition

**Amends:** `docs/landing-positioning-brief.md`
**Date:** 2026-07-23
**Occasioned by:** the first draft rendered correct but bland. The base brief specified voice,
claims, and what not to say — and said nothing about design ambition. A page briefed almost
entirely in prohibitions comes out safe. This amendment supplies what was missing.

The base brief's positioning, audience, claims, and §5 prohibitions all stand unchanged. This
amendment governs how the page **looks and moves**.

---

## 1. The signature idea

**Ratified: the score rail is the page's spine.**

levare's signature element is the score rail — the vertical run of circles and diamonds with the
ictus pulse. It already carries the product's whole argument: work advances step by step, and
gates stop it. The landing page should not merely *depict* that; it should **be** it.

Concretely: a score rail runs down the page's left edge as the structural spine. Each major
section is a node on it. Nodes ahead of the reader are hairline-dashed; the section they're in
carries the ictus (the pulsing node); sections passed are solid. The **gate diamond falls exactly
at the section that talks about gates halting** — so scrolling the page performs the thing the
product does.

Why this and not something else: it's unrepeatable (it's your metaphor, not a trend), it reuses a
vocabulary already ratified rather than inventing a page-only language, it turns navigation into
argument, and it is structurally impossible to mistake for a template. The strongest anti-generic
move available is to let the product's own idea organise the page.

Alternatives considered: typography-led (large editorial Hanken Grotesk carrying everything —
good, but not levare-specific); an interactive hero demo (strong, but the capture doesn't exist
yet and it duplicates the demo video). The rail spine can host either later.

## 2. Aesthetic register

**Technical score. Engraved, drawn, precise — not SaaS-gradient.**

The register to aim at: engraved music notation, plot paper, patent drawings, instrument panels.
Hairlines, precise geometry, generous white space, one accent used like a red pencil mark. This
is continuous with the Cogworks patent-drawing lineage and with the entity-glyph family already
drawn.

**Backgrounds should be earned, not decorative.** Permitted: a very faint plot-paper or staff-line
grid; hairline rules that align to the rail; a paper-warmth wash. Forbidden: gradient meshes,
blurred colour blobs, glassmorphism, generic abstract 3D, particle fields, anything that could
appear unmodified on another product's page.

## 3. Hard bans — the AI-generated tells

Stated explicitly so the draft can't drift into them. None of these may appear:

- Gradient-mesh or blurred-blob backgrounds; violet/indigo accents; glassmorphism.
- Three symmetrical cards, each an icon above a bold adjective above two lines of filler.
- Icon-pack glyphs (Lucide/Feather/Heroicons verbatim) — the entity-glyph family is the only
  icon vocabulary, and page-specific redraws must match it exactly, not merely resemble it.
- Emoji as interface.
- Everything centred with equal padding; perfect symmetry throughout.
- Inter, Geist, Söhne, or any of the default-SaaS type stack (the ratified stack is Hanken
  Grotesk + IBM Plex Mono).
- Stock photography, generic 3D renders, AI-generated imagery of any kind.
- Claims dressed as design: badges, fake metrics, "trusted by", logo walls.

## 4. Motion and micro-interaction

Motion is invited — but it must **mean something**, per the design brief's rule that animation is
reserved for live state and arrival. Every movement should correspond to something the product
actually does.

Invited:
- **Rail progression on scroll** — nodes resolving from dashed to solid as sections pass; the
  ictus pulse on the current node (1.6s, the ratified duration).
- **The gate moment** — when the gate section enters the viewport, the diamond arrives with the
  same brass treatment a real gate uses. This is the page's one theatrical beat; spend it here.
- **Physical hover states** — press-down on the install command, the copy affordance confirming
  in place, links that feel like they have mass. Fast (80-180ms, the ratified motion scale).
- **Evidence that reveals** — a file fragment or gate card settling into place as it enters view,
  once, not on every scroll.

Forbidden: parallax, scroll-jacking, elements flying in from off-screen, staggered fade-up on
every element, anything that delays reading. `prefers-reduced-motion` disables all of it.

## 5. The hero

The hero currently under-reaches: headline, subhead, install line, a static screenshot in a box.

It should carry **one striking, unmistakable image**. Until the gate-loop capture exists, the
score rail itself is that image: a large, confident rendering of a run — nodes, the brass gate
diamond mid-rail, the ictus alive — rendered as the page's own element rather than a screenshot
in a frame. Large type, asymmetric layout, the rail anchoring one side.

When the demo capture lands it takes the hero slot, and the rail continues as the spine. The
layout must accommodate the swap without redesign.

## 6. What "slick" means here

Not more effects. Precision: hairlines that actually align, optical spacing rather than
mechanical, type that's confidently large where it matters and genuinely small where it doesn't,
and interactions that respond instantly. The page should feel *made* — the way an instrument
feels made — rather than assembled from parts.

## 7. Decision log

All four questions raised by this amendment have been ruled on by the Conductor. Closed.

1. **Signature idea** (§1) — RATIFIED. The score rail is the page's spine. Sections are nodes;
   nodes resolve from dashed to solid as the reader passes; the ictus pulses on the current
   section; the gate diamond falls at the section about gates halting.
2. **Aesthetic register** (§2) — RATIFIED. Technical score: engraved, drawn, precise. Backgrounds
   are earned (faint plot-paper/staff grid, hairlines, paper warmth), never gradient-mesh, blob,
   or glassmorphism.
3. **Motion scope** (§4) — RATIFIED as listed. Rail progression on scroll, the gate arrival as the
   page's one theatrical beat, physical hover states, evidence settling into view once. Parallax,
   scroll-jacking, fly-ins, and staggered fade-up-on-everything remain forbidden.
   `prefers-reduced-motion` disables all of it.
4. **Hero** (§5) — RATIFIED. The score rail itself is the hero image until the gate-loop capture
   exists; the layout must accommodate the swap without redesign.

# levare — design brief amendment 1: entity iconography, state-during-wait, and a consistency audit

**For:** Claude Design (implementation), and the record
**From:** Cas (the Conductor)
**Amends:** `docs/levare-design-brief.md` — extends it, resolves one conflict with an external UI review, and adds one new pillar. The base brief's semantic system stands; this amendment adds a channel it did not cover, harvests the additive findings of an external review, and rules on where that review contradicts the ratified system.

**Occasioned by:** the Conductor's want for a legible entity-type visual vocabulary ("Ah, that's an agent — that's a team — there's a work unit"), and an external model's UI-consistency review (30 findings, a working mockup) whose genuinely additive parts are folded in here and whose conflicts with the base brief are resolved on the record.

---

## 0. Orientation — what this amendment does and does not touch

The base brief's three semantic colour channels are **unchanged and remain in force**: colour-means-team (identity surfaces), gate-brass-means-needs-you (gates only), the canonical status palette (entity lifecycle), and the NOTE/WARNING/DANGER message-severity scale. This amendment adds a **fourth, orthogonal channel — shape/glyph means entity type** — generalising the base brief's existing "shape glyph means work unit type" rule from three work-unit types in three places to the whole registry's entity vocabulary. It also adds a **state-during-wait vocabulary** the base brief was thin on, and a small **consistency audit**. None of it reassigns an existing channel.

---

## 1. Pillar — entity iconography (the new channel)

**The want, stated plainly.** The Conductor should recognise *what kind of thing* they are looking at by its symbol, before reading a word — the way a map legend or a file-type icon works. An agent, a team, a work unit, a project, a connector, a skill, a knowledge doc, an eval, an idea, an artifact: each gets a distinct, recognisable glyph, and the set reads as one family.

**Ruling R1 — glyph means entity type, as a channel parallel to (never colliding with) the others.** The base brief already establishes "shape glyph means work-unit type" (`◈` inception, `▸` feature, `◦` fix, spike/research open). This amendment **promotes that idea to a first-class, registry-wide channel**: every entity *type* in the product carries a glyph from a single coherent family. Hard constraints, inherited from the base brief's discipline:

- **Monochrome, always.** The glyph carries *type*, never *state* and never *identity* — those are the status palette and team-colour channels respectively. An entity's glyph is the same ink regardless of whether it's approved, running, or which team owns it. A card therefore reads on three independent axes at a glance: **glyph = what kind**, **team-tint = whose**, **status badge = how it's doing**. The three must never be conflated into one coloured symbol.
- **One family, not ten clip-art bits.** The set's value is that it reads as a *system*: one stroke weight, one level of abstraction, one optical size. A glyph that doesn't sit beside its siblings as obviously-the-same-hand is a failure, however nice alone. This is the craft the pillar lives or dies on.
- **Survives the mono texture and 16px.** Glyphs share the visual register of the base brief's mono-means-filesystem-truth type channel — they should feel at home next to a mono identifier and legible at favicon/inline size, in pure monochrome, both modes. No containers, no fills that break at small size (see style ruling R2).
- **Work-unit-type glyphs are absorbed, not duplicated.** The existing `◈`/`▸`/`◦` set and the still-open spike/research glyphs become the *work-unit-type* members of this one family — same family, same rules — rather than a separate parallel system. Spike (ephemeral/disposable — its code never ships) and research (document-ish — terminal artifact is a report) still need their glyphs; now they must also read as siblings of the entity glyphs, not just of each other.

**The entity set to design (the registry's own vocabulary, from the base brief):**

- **team** — a declared flow of members
- **agent (member)** — produces artifacts
- **work unit** — one run of the pipeline (with its type sub-glyphs: inception/feature/fix/spike/research)
- **project** — one product's state
- **connector** — external system a member reaches
- **skill** — a SKILL.md capability bundle
- **knowledge** — injected context
- **eval** — a rubric scoring a work-unit type's output
- **idea** — a captured pitch with no project yet
- **artifact** — a produced markdown file with status and lineage

**Ruling — entity set is closed as listed; Orchestrator and Runner are ruled out (RULED).** The Orchestrator and the Runner stay *outside* the entity-glyph set. They are voice (the Orchestrator, which wears the brand accent) and machinery (the Runner, deliberately gray) per the base brief — not browsable registry entities — and giving either an entity glyph would blur that distinction. The ten types above are the whole set; nothing is missing.

**Ruling R2 — style direction: thin geometric line-glyphs (RATIFIED).** The base brief's whole aesthetic is monochrome, minimal, anti-AI-tell, tools-for-craftspeople, with a latent patent-drawing/technical sensibility (the Cogworks lineage). Consistent with that, the ratified direction is **thin geometric line-glyphs** — single-weight strokes, geometric-abstract rather than literal/representational, sitting in the same texture as the mono type and the score rail's own circle/diamond language. Not filled/solid (heavier, more app-icon, less instrument), not skeuomorphic-literal (a tiny robot for "agent" is the AI-tell to avoid). The glyphs are to be *drawn by the same hand that drew the score rail's circles and diamonds* — kin to `◈`/`▸`/`◦`, not imported from an icon pack. This ruling sets the tone for the whole family; filled/solid and literal/representational directions are both rejected. The base brief's own hard bans apply regardless: nothing that reads as generated, no default icon-pack tells (no Lucide/Feather-verbatim shapes if they'd be recognised as such), monochrome, 16px-survivable, both modes.

**Ruling R3 — where glyphs appear (scarcity discipline, matching the base brief's own).** The base brief scopes work-unit-type glyphs to *exactly three places* deliberately — glyphs confirm, never carry. Entity glyphs get a similarly disciplined placement rather than being sprinkled everywhere: **registry cards (the kind marker — mandatory, per the audit below), registry sidebar entries (so the type list reads as icons + counts), entity links inline where disambiguation earns it, and the card kind-tag position.** Not on every mention of an entity in prose, not decoratively. The rule stays the base brief's: the glyph *confirms* type at a glance where type-scanning is the task, and is absent where it would be noise.

---

## 2. State-during-wait vocabulary (harvested from the review — an additive gap in the base brief)

The base brief's status palette answers "what lifecycle state is this entity in?" but is thin on **what the UI does during the wait between an action and its result** — the review's strongest contribution (its §05, findings F25–F30). This is additive: it does not touch the status palette, it specifies the *transitions and waits* the palette's states move through.

**Ruling R4 — a three-tier wait vocabulary, adopting the review's model within the base brief's motion rules.** The base brief already mandates fast, physical, quiet micro-interactions and reserves attention-seeking animation for live/pulse and gate arrival. This ruling fits within that:

- **Tier 1 — button (0–1s), decision writes** (approve / request-changes / reject / start-gate verbs). Pressed state instant; spinner only after a delay so fast ops never flash one; once shown it stays long enough to read; the *whole action group disables* and the spinner rides only the clicked verb. This satisfies the base brief's "act in one place" — the gate card's verbs are the one actionable surface, so this is the one place the tier-1 pattern lives.
- **Tier 2 — card (1–10s), resolution and refetch.** The card never blanks: the status badge swaps, the meta line updates, section counts and the stat strip tick in the same beat; if the card changes section (Needs-you → Running-now), it animates the move rather than jumping. Uses the base brief's existing swap/move motion budget.
- **Tier 3 — loop (10s+), long-running runs.** A spinner would be a lie; the card flips to the canonical **active** state (blue + pulse — the base brief's existing live treatment) with a live strip: round n/m, elapsed, tokens ticking. Full expression is the run view, which the base brief already designates as the live surface. This ruling just says the *card* on studio/project pages gets the compressed live strip, consistent with the run view's own.

**Ruling R5 — three interaction-safety findings the base brief did not cover, adopted as constitution:**

- **No double-submit (review F26).** One in-flight action per gate card; the whole verb group disables on click. A gate decision is irreversible-ish and must not be double-fired. This is a correctness rule, not polish — it belongs in the interaction constitution alongside "act in one place."
- **Failure keeps state and offers retry (review F29).** A failed write (e.g. the Orchestrator unreachable) never silently resets the card: the verb returns to idle, the card keeps its state, and a message states what happened with a retry affordance. Consistent with the base brief's calm/factual register and its "the UI is a projection" honesty — a failed write must not leave the projection lying.
- **Skeletons shaped like the real anatomy (review F28).** Initial load and refetch use content-shaped skeletons mirroring the card's own header/body/footer, with the base brief's subtle-warm-sheen motion (no gray boxes, no full-page spinners), so first paint has zero layout shift.

These slot into the base brief's motion section and interaction constitution; they add vocabulary it lacked, and contradict nothing in it.

---

## 3. Consistency audit (harvested from the review — where it agrees with the base brief)

The review's consistency findings that **do not conflict** with the base brief's semantic system are adopted as implementation discipline for the phased rework. Each is a "make every surface share one feel" rule, which is exactly the Conductor's stated want:

- **One card anatomy everywhere (review F5/F6/F7).** The base brief already mandates one gate card across three surfaces; this generalises the discipline: registry / work-unit / gate cards share header / body / footer, one label style, a fixed label vocabulary per card type. The kind-tag (entity glyph + word) is mandatory in every registry card header — the review found it missing on skills, agents, teams.
- **Breadcrumbs include the leaf (review F2).** Full path including the current collection, not "studio / registry" on every page.
- **One sidebar source of truth (review F1).** Connectors appear once (the registry row with inline health dots), not duplicated as their own section.
- **Fixed stat-label grammar (review F13).** "noun · window" everywhere ("Spend · 30d", not "Spend" on one page and "Spend · 30d" on another); a stat tints only when actionable — which for levare means gate-brass only, per the base brief's needs-you channel, never a general amber.
- **Contrast floor (review F14).** Secondary text meets the base brief's legibility intent; no muted grays below comfortable contrast.
- **Auto-fill grid, designed empty states (review F12).** No ragged fixed-width whitespace; empty regions are a designed component ("Nothing running right now — work units appear here while a team is executing"), matching the base brief's calm register.

---

## 4. Conflict resolution — where the review contradicts the base brief, the base brief stands

The external review's central principle is **"colour = status only; identity is neutral."** The base brief's ratified system is **"colour = team on identity surfaces; a separate status palette for lifecycle."** These directly conflict, and the ruling is explicit:

**Ruling R6 — the base brief's colour-means-team channel stands; the review's colour-status-only principle is rejected where it conflicts (CONFIRMED).** The base brief's system is the more sophisticated and more levare-specific of the two: it uses colour to make *team ownership* legible across the product (avatars, flow strips, the score's avatar column) — a genuine, load-bearing idea, not decoration. Flattening identity to neutral (the review's recommendation) would discard the "who has the ball, read from across the room" property the base brief deliberately designed. The review reached its principle honestly (from screenshots, without the base brief's team-colour rationale), but it is superseded here. What survives from the review is its *consistency rigor* (§3) and its *state-during-wait vocabulary* (§2) — not its colour philosophy.

Corollary: the review's neutral-avatar findings (F10, F24) are **not** adopted for identity surfaces — team-tinted avatars and flow strips stay, per the base brief's derivation rules (with the contrast floor the base brief already requires). Where the review is right and adopted: colour never encodes *status* on identity surfaces, and near-black/dark chips are reserved (the base brief agrees — colour is meaning, not decoration).

---

## 5. Deliverables added by this amendment

To the base brief's deliverables, add: **the entity-icon family** — a coherent monochrome glyph set covering the ten entity types (with work-unit-type sub-glyphs absorbed), both modes, 16px-survivable, delivered as a small system with each glyph's meaning and placement rules stated; **the three-tier wait vocabulary** as component states (button/card/loop, plus skeletons, toasts/failure-with-retry) stated as pure functions of the entity's status; and the **consistency-audit rules** (§3) applied across the four screens the base brief already specifies.

---

## 6. Decisions ratified — this section is now closed

This section previously listed three open decisions for the Conductor. All three have been ruled on and folded into the body; nothing below is pending.

- **Icon style — RATIFIED.** Thin geometric line-glyphs: single-weight strokes, geometric-abstract, kin to the score rail's circles/diamonds and the mono-type texture, drawn as if by the same hand as `◈`/`▸`/`◦`. Not filled/solid, not literal/representational. See §1, Ruling R2.
- **Missing entities — RULED.** The Orchestrator and Runner stay outside the entity-glyph set — they are voice and machinery per the base brief, not browsable registry entities. The entity set is the ten registry types listed in §1, and no others. See §1.
- **Colour channel — CONFIRMED.** Colour-means-team stands; the review's colour-status-only principle is rejected where it conflicts. See §4, Ruling R6.

One item from the original list is design-production work rather than a Conductor decision, and stays open in that sense: the spike/research work-unit sub-glyphs (§1, Ruling R1) still need to be drawn, now constrained to read as siblings of the whole entity family rather than just of `◈`/`▸`/`◦`. That's execution work for Claude Design, not a further ratification.

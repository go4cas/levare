# levare — landing page positioning brief

**For:** the landing page (design + copy), and the record
**From:** Cas (the Conductor)
**Date:** 2026-07-23
**Status:** RATIFIED — see §9 for the decision log. The domain choice remains open.

This brief settles *what the page says and to whom* before any design happens. Everything
downstream — layout, hero, copy, what the demo shows — falls out of these decisions.

---

## 1. Stance

**Ratified: a confident showcase that doubles as a front door.**

Three stances were considered:

- *Showcase* — "here's a thing I built." Low stakes, no promises, expressive.
- *Front door* — you want people installing it. Must convert; implies you'll field questions.
- *Product statement* — levare as a thing with a roadmap and a future. Implies support burden
  and commitments a solo builder pre-1.0 shouldn't make.

**The ruling: showcase-leaning-front-door.** The page should be beautiful and confident enough
that a developer wants to try it, and honest enough that nobody arrives expecting a staffed
product. Concretely: a real install path and real screenshots, but the README's honest Status
carried through — v0.2.0, pre-1.0, built by one person. No roadmap, no "enterprise", no waitlist,
no fake social proof.

## 2. Audience

**Ratified. Primary: developers who want AI agents doing real multi-step work, and don't trust
them unattended.** People who have tried autonomous agents, watched one confidently do the wrong thing
for twenty minutes, and want the loop back. People who already think in git.

**Secondary:** solo founders and small teams running product work where the *review* is the
bottleneck, not the typing.

**Explicitly not the audience** (and the page should not contort to serve them): teams wanting a
hosted multi-tenant SaaS; people wanting maximum autonomy with minimum oversight; non-technical
users — levare assumes a terminal, a repo, and a model provider.

## 3. The problem, stated plainly

Agent tooling today mostly sits at two extremes. Either the agent runs unattended and you find out
afterwards what it did — no checkpoints, no audit trail, state locked in someone's database. Or
it's a chat window with no structure at all: no notion of a work unit, a team, a dependency, or a
step that must be reviewed before the next one starts.

levare takes the middle: **structured multi-step work where a human approves every step, and every
artifact is a file in your own git repo.**

## 4. The three things that make it different

These are the load-bearing claims. Each is true, specific, and checkable — no adjectives doing
work a fact should do.

1. **Nothing runs until you give the beat.** Every step ends at a gate. You approve, request
   changes, or reject; the runner advances only on your decision. Not a setting — the architecture.
2. **Markdown is the truth.** Agents, teams, work units, artifacts — files with YAML frontmatter in
   your repo. No database, no proprietary format. You can read the whole state in an editor and
   diff it in git.
3. **One binary, local-first.** No server to run, no account, no telemetry. It reads your repo and
   serves a board on localhost. The runner is deterministic — same inputs, same result, byte for byte.

Supporting (mentioned, not headlined): agents that shell out run under OS-level sandboxing;
remote agents speak MCP; the whole thing is Apache-2.0.

## 5. What the page must NOT claim

Stated explicitly so the copy can't drift into them:

- Not autonomous, and not trying to be. The gate is the point, not a limitation to apologise for.
- Not a hosted service, not multi-tenant, no cloud.
- No performance or productivity claims ("10x", "ship faster") — unmeasured and unbecoming.
- No implied team, company, or roadmap. One person built it.
- No enterprise language. No "trusted by". No logos.

## 6. Voice

The etymology line sets the register and should appear on the page:

> *(leh-VAH-reh) — the conductor's lift before the downbeat. Nothing runs until you give the beat.*

Musical, precise, unhurried. Plain nouns and verbs; the metaphor is texture, never a replacement
for saying what the thing does. Calm and factual, exactly as the design brief specifies for the
product itself — the page should sound like the tool it's describing.

**Headline strategy — ratified:** lead with the *practical* claim and let the metaphor carry the
texture beneath it — not the reverse. "Direct a team of AI agents. Approve every step." reads
instantly; "The conductor's lift before the downbeat" alone is beautiful but opaque to someone
who has never heard of levare. The headline states what levare does; the etymology and the beat
language carry the voice in the subhead and body, never in place of the plain claim.

## 7. The one thing to show

**The gate loop, as motion.** A short screen capture: a member produces an artifact → the run halts
at a gate → the Conductor approves → the run advances to the next step. That loop *is* levare, and
seeing it is worth more than any paragraph. It should be the hero, above the fold.

Static fallback: the run view (score rail, timeline, gate card) — already captured for the README.

## 8. Page shape (proposed, subordinate to the above)

1. **Hero** — the practical headline, one-sentence subhead, the gate-loop capture, one install line.
2. **The three differentiators** — §4, one beat each, each with a small piece of evidence
   (a file, a glyph, a screenshot fragment) rather than an icon and an adjective.
3. **How it works** — the shape of a run in four steps: capture an idea → a team executes → gates
   halt → the unit ships. Uses the entity glyph family.
4. **See it** — a second, quieter screenshot or two (registry, project view).
5. **Get it** — the install line, prerequisites stated honestly, links to quickstart and guide.
6. **What it is and isn't** — the honest status: v0.2.0, pre-1.0, solo, Apache-2.0, links to repo.

## 9. Decision log

1. **Stance** (§1) — RATIFIED: showcase-leaning-front-door.
2. **Audience** (§2) — RATIFIED: primary is developers who want agents doing real multi-step work
   and don't trust them unattended.
3. **Headline strategy** (§6) — RATIFIED: practical-first, with the metaphor as texture beneath.
   The headline states what levare does; the etymology and the beat language carry the voice in
   the subhead and body, never in place of the plain claim.
4. **Hosting** — RATIFIED: the landing page goes at the root of the existing GitHub Pages site,
   docs beneath it.
   - Consequence: `docs/guide/README.md` currently carries `permalink: /` (added to fix a root
     404) and will need to move to `/docs` or `/guide` once the landing page takes the root. This
     is a required step before the landing page ships — and it re-tests the exact thing that just
     broke, so both the root and a sub-page must be verified working afterward.
   - **Still open:** the domain. Whether this ends up at `levare.dev` (check availability), a path
     on `go4cas.com`, or stays on the Pages root with a CNAME added later is undecided and can be
     settled after launch.
5. **Demo format** (§7) — RATIFIED: a silent looping video (MP4, WebM fallback) — autoplay, muted,
   loop, playsinline, with a poster frame. Not a GIF: the loop needs enough seconds to read that a
   GIF would be heavy.

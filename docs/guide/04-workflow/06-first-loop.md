---
title: Your first loop
parent: Workflow
nav_order: 6
---

# 4.6 · Your first loop

Two members, alternating, until they converge or run out of patience. This is the mechanic that makes
levare more than a task runner — and it's where the whole thing pays off.

## Declare it

```sh
cd ~/studio

cat > teams/press.md <<'EOF'
---
name: press
consumes: [pitch]
produces: [product-brief, review]
members: [scribe, corvid]
flow:
  - loop:
      between: [product-brief, review]
      until: review.approved
      max_rounds: 3
      on_exhaust: gate
style:
  color: "#4A7C59"
---

# Press — the framing team

Scribe writes the brief. Corvid, a Codex agent, reviews it. Every round ends at your gate — approve,
request changes, or reject — and they keep going until you approve or three rounds are up.
EOF

levare validate .
```

**Read the loop out loud, because it says exactly what it does:** alternate between a `product-brief`
and a `review`, until the review is approved, for at most three rounds, and if it never converges,
raise a gate.

## What a round is

1. **Scribe** produces a `product-brief`.
2. levare **immediately dispatches Corvid** — the member who produces the loop's other kind — with the
   brief in its context. No gate, no click. This is a round.
3. Once both artifacts exist, levare raises a gate on the round's `product-brief` — regardless of what
   Corvid wrote. **You** decide: approve, request changes (Scribe reworks, with the review in context —
   round two), or reject.
4. Approve, and the round's review is marked approved alongside it — satisfying `until: review.approved`.
   The loop ends and the walk continues.
5. After `max_rounds`, `on_exhaust: gate` escalates to you regardless.

**The gate is at the loop's outcome, never on each internal turn.** You consented at the start gate;
the loop is what you consented to. A critic you have to summon by hand is a critic that gets skipped.

## Run it

This is the same `add-command` unit from [4.4](04-first-gate.md) — you don't create a new one.
Press already owns `product-brief`, and it already has one: the v2 you approved. Editing
`teams/press.md` doesn't erase that history; the loop treats your approved brief as round 1's
author artifact and immediately goes looking for round 1's *review*.

There's no button waiting for you, though. `add-command`'s start gate was resolved back in 4.4 —
it isn't sitting idle at a gate, it's sitting idle because nothing this studio can do was left
undone, and that was true right up until you gave Press a new way to keep going. So the thing you
actually need is for the daemon to *notice*, and here's the part worth knowing before it surprises
you: **it won't, on its own.** The daemon watches `work/` — it never watches `teams/`, `agents/`,
`connectors/`, or `projects/`. Editing `press.md` changes what's true on disk, but nothing under
`work/` changed, so nothing woke the daemon up to re-derive it.

Restart it:

```sh
levare serve .
```

A fresh start always re-derives every unit from disk before it does anything else — this edit
included. (You'll hit this same shape again outside a loop: any edit to a registry file, or to
`.env`, needs a restart to take effect on a `levare serve` that's already running. [4.7](07-the-daemon.md)
says why.)

Once it's back up, watch the score, and read `git log` afterwards — because the log *is* the story:

```
advance add-command → press/corvid produced review review-add-command-v2 (loop round 2)
request changes on product-brief-add-command-v1 → product-brief-add-command-v2
advance add-command → press/corvid produced review review-add-command-v1 (loop round 1)
start add-command → press/scribe produced product-brief product-brief-add-command-v1 (loop round 1)
```

A Claude agent wrote. An OpenAI agent criticised. You ruled. The Claude agent reworked. The OpenAI
agent re-reviewed the new version — automatically, without you asking.

## What the critic actually said

Here is Corvid's first review, verbatim. It is worth reading closely, because it is the argument for
this entire mechanic:

> The brief is not ready.
>
> > *"Appends a new entry to the JSON store at `~/.todo.json` (or wherever the store path is fixed —
> > see open question)."*
>
> This cannot be left open for implementation. The house rules already say state lives in a single
> JSON file under the user's home directory, but the exact filename/path still matters because `add`,
> `list`, and `done` must interoperate. Pin it here.
>
> > *"Entry needs at minimum: an id, the text, and a done flag (false)."*
>
> The schema is underspecified. Field names, JSON shape, and whether the file is an array or object
> are all build-breaking details. Example ambiguity: `[{ "id": 1, "text": "...", "done": false }]` vs
> `{ "todos": [...] }`.
>
> > *"If the store file doesn't exist yet, create it."*
>
> It does not say what to do if the parent directory is missing, if the file exists but is empty, if
> JSON is malformed, or if the schema is valid JSON but not the expected todo structure. **The house
> rule says errors are diagnoses, so these cases need expected behavior.**
>
> The open question correctly identifies the central problem, but because it remains open, the brief
> is explicitly asking the implementer to guess the shared persistence contract.
>
> **CHANGES REQUESTED**

Three things happened there, and each one is a design decision paying off.

**It quoted specific lines and said what was wrong with each.** That's the system prompt you wrote,
being followed.

**It cited your own house rules back at the author** — *"the house rule says errors are diagnoses."*
Corvid read `projects/todo-cli.md`, because section 5 of the context recipe put it there. You wrote
that file once, days ago, and a model from another company just enforced it.

**It found a hole the author could not see.** Scribe wrote that brief and was satisfied with it.
Scribe would have written it the same way ten times. Corvid found the gap on the first pass, because
it wasn't the one who made it.

That closing `**CHANGES REQUESTED**` line is not just for you. It's also the one shape levare itself
can read back, structurally, into the review artifact's own `verdict:` frontmatter — the [artifact
cheatsheet](../05-reference/cheatsheets/artifact.md) has the full contract. levare never guesses this
from tone or argument; it looks for a line that consists, in its entirety, of `APPROVED` or `CHANGES
REQUESTED` (optionally `Verdict: `-prefixed), and only accepts it when the whole review contains
exactly one such line. Give your own critic's system prompt the same instruction — end every review
with that line, alone, once — and its verdict becomes a fact the gate card can render, not just prose
you have to read to find.

## The receipt

```yaml
usage:
  model: null
  tokens_in: null
  tokens_out: null
  usd: null
  wall_clock_s: null
  plan: ChatGPT subscription
```

Not `$0.00` — which would be a lie — but **`null`, with the plan named**. Corvid is authenticated by a
subscription, which doesn't bill per token, so levare declines to invent a number it cannot know.

Next to it, on the same score, Scribe's receipt reads `usd: 0.0152` on `claude-sonnet-5`. **Two
vendors, two billing models, one ledger, both honest.**

## When they can't agree

Corvid refused three times. Each refusal was correct, and each time Scribe rewrote the prose *around*
the hole rather than filling it.

That's `max_rounds` earning its place. At the third round, levare stops:

- The loop cannot continue. Requesting changes again is refused — no fourth round, no further spend.
- `on_exhaust: gate` puts the decision on you.

And here's the thing worth sitting with: **the two agents argued to a standstill, and the thing they
were arguing about was a decision only a human could make.** Neither of them could pin the JSON schema,
because neither of them was entitled to. That was always yours.

So you do what a conductor does. You edit the brief, you pin the contract, and you approve.

Total cost of the argument: **$0.04**.

---

## What this mechanic is for

A loop is not automation for its own sake. It is a structural answer to a specific failure: **a model
cannot see its own blind spots, and neither can a second copy of the same model.**

Different lab, different training, different habits — different blind spots. Put them in a room, give
them a shared constitution, bound the argument, and make a human the judge.

That's a levare team.

---

Next: **[4.7 · The daemon](07-the-daemon.md)** — approve once, and let the score advance by itself.

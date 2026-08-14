---
title: Your first team and member
parent: Workflow
nav_order: 3
---

# 4.3 · Your first team and member

A **team** is a group with a job: it declares what it consumes, what it produces, and the flow it
follows. An **agent** is a member of one: it declares what it can personally author, and how to
invoke it.

Start deliberately small. One team, one member, one step. No gates, no loops.

## The member

```sh
cd ~/studio

cat > agents/scribe.md <<'EOF'
---
name: scribe
kind: native
produces: [product-brief]
model: claude-sonnet-5
tools: [Read, Write]
style:
  avatar: Sc
---

You are Scribe, a product framer.

Given a pitch, write a product brief: the problem, who has it, the one job to be done,
and the signal that tells us it worked. Be specific and be short — a brief that takes
longer to read than the feature takes to build has failed.

If a decision is genuinely ambiguous, say so in the body rather than guessing.
EOF
```

**The body is the system prompt.** Not a description of the agent — the actual instructions it
receives. Write it as if you're briefing a colleague, because you are.

## The team

```sh
cat > teams/press.md <<'EOF'
---
name: press
consumes: [pitch]
produces: [product-brief]
members: [scribe]
flow:
  - step: brief
style:
  color: "#4A7C59"
---

# Press — the framing team

Press turns a pitch into a product brief. One member, one step, no ceremony.
EOF

levare validate .
```

```
valid
```

## `produces:` is the most load-bearing line in a studio

The team's flow says `step: brief`. levare resolves that to **a member who produces a kind matching
that label** — Scribe declares `produces: [product-brief]`, so Scribe gets the work.

Delete that line and see what happens:

```
invalid — 2 error(s):
  MISSING_FIELD  agents/scribe.md
    missing required field 'produces' in agent
  UNPRODUCIBLE_KIND  teams/press.md
    team 'press' declares it produces 'product-brief', but no member of it declares
    'product-brief' in its own 'produces': scribe produces nothing
```

levare refuses the studio rather than accept a team that promises something nobody can deliver. That
check exists because the alternative — a studio that validates cleanly and then silently does
nothing forever — is much worse than an error message.

**Note the two `produces` are different claims.** The team's is what it offers the outside world.
The agent's is what it can personally author. A team can promise a `spec` while none of its members
can write one, and that is exactly the failure levare will not let you ship.

## The model must be real

`model: claude-sonnet-5` isn't a label — it's a model ID, and levare validates it against
`knowledge/model-pricing.md`:

```
UNKNOWN_MODEL  agents/scribe.md
  agent 'scribe' declares model 'claude-sonnet-9', which is not in
  knowledge/model-pricing.md's known-model set — an unpriceable model means
  silently wrong cost accounting
```

**A model that cannot be priced cannot be declared.** This is stricter than it sounds, and it exists
for a reason you'll appreciate in the next step: when levare tells you what something cost, that
number needs to be true.

## Look at them

```sh
levare serve .
```

Registry → **teams** → `press`: its declared flow, rendered as a score, with Scribe's avatar on it.
Registry → **agents** → `scribe`: kind, model, what it produces, and which team wears it.

Both cards have an **Edit source** button. That's the only write surface in the registry: raw
markdown, a validity check, then save and commit. No forms, no wizards. The file is the truth, so
the file is what you edit.

## Commit before you dispatch

You just created `agents/scribe.md` and `teams/press.md` with `cat >`, not through the board — so
they're real on disk, but git doesn't know about them yet. That matters starting next chapter.

Everything a member *produces* commits itself automatically. But levare refuses to dispatch a member
at all while the registry that **governs** it — `teams/`, `agents/`, `connectors/`, `projects/`,
`skills/`, `knowledge/`, `types/`, `studio.md` — has uncommitted changes, tracked or untracked. Editing
through the board's own **Edit source** button already commits for you, so this never bites there; it
bites exactly the shape you just did — editing the file directly. The reasoning: git is the audit log,
and a member run under a definition git never saw is a run nothing can reconstruct.

So before [4.4](04-first-gate.md) has you click **Start**:

```sh
git add teams/ agents/
git commit -m "add press: scribe drafts the product brief"
```

Skip this and the start gate will refuse outright, naming the uncommitted files. `work/` — the units
and artifacts a member actually produces — is never part of this check; only what governs the member
is.

---

Next: **[4.4 · Your first gate](04-first-gate.md)** — where a member actually runs.

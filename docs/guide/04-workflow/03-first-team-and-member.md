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
tools: [read, write]
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

---

Next: **[4.4 · Your first gate](04-first-gate.md)** — where a member actually runs.

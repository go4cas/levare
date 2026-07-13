# 3 · Concepts

levare has few concepts, and each one carries weight. This is all of them.

If you'd rather learn by building, skip to **[4 · Workflow](04-workflow/)** and come back when a word
stops making sense.

---

## The whole picture

![How levare's concepts relate: projects have work units, which have artifacts, which raise gates. Teams have agents, who author artifacts. Types define units; skills, knowledge, and connectors feed agents.](img/concept-map.svg)

Read it in two lines:

- **The work:** a *project* has *work units*; a unit produces *artifacts*; an artifact raises a *gate*
  — and a gate is where you come in.
- **The workers:** a *team* has *agents*; an agent *authors* the artifacts. *Types* define what a unit
  is expected to produce. *Skills*, *knowledge*, and *connectors* are what an agent is given.

Every one of those boxes is a markdown file in your studio. Nothing else exists.

---

## Studios, products, and the levare source

Three repositories, three jobs — and confusing them is the most common early mistake.

![Three repositories: the levare source, your studio, and the products you build.](img/repo-roles.svg)

**The source repo** is levare itself. You clone it, build the binary, and never think about it again.

**Your studio** is a git repository of markdown files: your teams, your agents, your skills, your
work. It is where you conduct. It is *not* inside the levare source — it's yours, and it lives
wherever you keep your work.

**Product repos** are the things your teams actually build. A `project` in your studio is a *pointer*
at one: its git remote, where it deploys, its house rules. levare's work units live in your studio;
the code they produce lands in the product.

```sh
levare serve ~/studio          # the binary, operating on your studio
```

---

## Work units, and the five types

A **work unit** is a piece of work with a beginning and an end. It lives at
`work/<project>/<unit>/`, and everything it produces lives beside it.

There are five types, and the type determines what artifacts the unit is expected to produce and
where it gates:

| Type | Glyph | For | Terminal artifact |
|---|---|---|---|
| `inception` | ◈ | Founding a project — the PRD, the architecture, the design system | the constitution |
| `feature` | ▸ | New capability | shipped code |
| `fix` | ◦ | Something is broken | a fix |
| `spike` | ∗ | A timeboxed question with disposable output | findings |
| `research` | ▤ | Reading and synthesis, no code | a report |

The distinction that matters most: **an inception unit produces the documents every later unit must
cite.** A project's constitution isn't a folder convention — it's the artifacts that later work
`consumes`. Legislation cites the constitution.

---

## Artifacts, and the contract

An **artifact** is a markdown file with YAML frontmatter, produced by a member, that levare knows how
to reason about. The frontmatter *is* the contract:

```yaml
---
kind: spec                              # what type of thing this is
id: spec-checkout-flow-v1               # unique within the project
unit: checkout-flow
project: storefront
status: in-review                       # the lifecycle position
produced_by: lyra                       # which member authored it
consumes: [product-brief-v1, design-checkout-v1]   # its lineage
supersedes: null                        # or the id of the version it replaces
files: []                               # supplementary files travelling with it
created: 2026-07-11
---

The body is the actual document.
```

`consumes` is the important one. It's not metadata — it's the **dependency graph**. levare walks it
to decide what can be produced next, and it's how a spec proves it was written from an approved
brief rather than from thin air.

### The lifecycle

![An artifact is produced, sits in review, and is then approved, superseded, or rejected.](img/artifact-lifecycle.svg)

**Only the Conductor moves an artifact out of `in-review`.** Not the Orchestrator, not the daemon,
not the member that wrote it.

And once approved, an artifact is **immutable**. Not by convention — levare records the commit at
which you approved it, and if the file changes afterwards, validation fails. A revision is a *new
version* that `supersedes` the old one. The history stays legible.

---

## Teams, members, and what binds them

A **team** declares what it consumes, what it produces, its members, and its **flow**. An **agent**
is a member: it declares what *kind* of thing it can produce, and how to invoke it.

```yaml
# teams/kestrel.md
name: kestrel
consumes: [pitch]
produces: [product-brief, design, spec]
members: [wren, lyra, finch]
```

```yaml
# agents/lyra.md
name: lyra
kind: native
produces: [design, spec]        # ← this is what binds lyra to a flow step
model: claude-sonnet
```

That `produces:` declaration is load-bearing. A team can promise a `spec`, but if no member of it
declares `spec`, the team is a promise with nobody behind it — and `levare validate` will refuse the
studio rather than let it silently do nothing.

### The three kinds of member

- **`native`** — a Claude agent, run through the Agent SDK, in-process. It gets its model, its tool
  allowlist, and its context from its definition.
- **`cli`** — any foreign command-line agent. Gemini, Codex, or a shell script. levare spawns it with
  a structured argv, hands it the assembled context, scopes its environment to exactly its granted
  credentials, times it out, and validates whatever it emits against the contract at the boundary.
- **`remote`** — an MCP server.

To the runner they are the same thing: *something that receives a context and returns an artifact.*
That is the whole reason a multi-vendor studio works.

---

## Flows: steps, gates, and loops

A team's **flow** is a declaration, not code. Three shapes:

![A flow is a sequence of steps, human gates, and loops.](img/flow.svg)

```yaml
flow:
  - step: brief             # invoke the member who produces this kind
  - gate: human             # halt. wait for the Conductor.
  - step: design
  - gate: human
  - loop:                   # alternate two members until a condition holds
      between: [spec, review]
      until: spec.approved
      max_rounds: 3
      on_exhaust: gate      # if it never converges, escalate to a human
```

The **loop** is what makes levare more than a task runner: an author and a critic, alternating, with
a declared budget. When a loop exhausts its rounds without converging, it doesn't give up quietly —
it raises a gate and tells you it couldn't get there.

And the **gate** is the constitution:

> **No member process ever starts without a Conductor approval in its causal chain.** Every work
> unit's first step raises a start gate — regardless of type, regardless of dependencies. **A unit's
> existence is not consent.**

---

## Context: what a member actually sees

Every member — native, CLI, or remote — receives the same seven-part context, assembled
deterministically:

![The seven-part context recipe assembled for every member.](img/context-recipe.svg)

You can print it before you spend a cent:

```sh
levare context lyra --unit checkout-flow --dry-run
```

That output is not an approximation. It is byte-for-byte what the member will receive.

**Skills** are reusable instructions (section 2). **Knowledge** is reference material injected by
name (section 3). Both are just markdown in your studio, and both are how you teach a member
something without retraining anything.

---

## Connectors: credentials, scoped

A **connector** is an external system a member can be granted — GitHub, Linear, a model vendor's CLI.
It declares the *names* of the environment variables it needs. **Never their values.** Secrets live in
your shell; the repo names them.

```yaml
# connectors/github.md
name: github
kind: cli
command: gh
env: [GITHUB_TOKEN]
```

Grants are per-team or per-agent, and they union. At spawn time, a member's process receives **exactly**
the baseline (`PATH`, `HOME`) plus the variables its granted connectors name — **and nothing else.**
Not your other keys. Not your shell. A member that wasn't granted `github` cannot see `GITHUB_TOKEN`,
because nothing copied it through.

`levare doctor` tells you which connectors are actually ready.

---

## Gates, and the verbs

A **gate** is a decision only you can make. On the board it's a card with the artifact, its origin,
its age, its cost, and the verbs available:

- **approve** — the artifact is accepted. The walk resumes.
- **request changes** — with a note. The artifact is superseded by a new version, and the loop goes
  round again.
- **reject** — the artifact is refused and the unit pauses.
- **start / not yet** — on a start gate, for work that hasn't begun.
- **continue / raise / stop** — on a budget gate, when a unit crosses its declared spend.

Every gate resolution is a commit **with your name on it**. Which brings us to the last idea, and
it's the one levare is really about.

---

## The audit log: who decided, and who acted

```
levare-runner — start loyalty-flow → kestrel/wren produced product-brief
cas           — approve spec-checkout-flow-v1
cas           — seed
```

Two identities. **Your decisions commit as you. Machine work commits as `levare-runner`.** They are
never confused, and they cannot be — laundering machine action into human authorship would defeat the
one artifact whose entire purpose is to tell them apart.

Ask `git log` who approved that spec, and it will tell you. Ask it who wrote the code, and it will
tell you that too, and they will be different answers.

---

## The daemon

Turn it on and the score advances by itself: when you approve a gate, the next step *runs* — no
click, no command. It watches `work/`, walks the graph, invokes members, and **halts at every gate.**

It never resolves a gate. It never starts a unit you haven't started. It runs while you're not
looking, and it stops the moment it needs you.

---

Next: **[4 · Workflow](04-workflow/)** — build something, one step at a time.

---
title: Registry entities
parent: Reference
nav_order: 2
---

# 5.2 · Registry entities

> For the terse per-entity field reference and copy-paste skeletons, see the [generated cheatsheets](cheatsheets/)
> — one page per entity, computed straight from these same schemas, so it can't drift from the code.
> This page stays the home of the cross-entity rules and the why.

Every registry entity is a markdown file with YAML frontmatter. Each section below follows the same
shape: what the entity is, the fields worth knowing up front, the rules and behavior that actually make
it interesting, and a pointer to its cheatsheet for everything else.

`levare validate` reports every violated rule for an entity in a single pass — you never fix one field
only to be told about the next.

---

## Agent — `agents/<name>.md`

A member. What it can produce, and how to invoke it.

**The basics**

| Field | Required | Notes |
|---|---|---|
| `name` | ✅ | Must match the filename |
| `kind` | ✅ | `native` · `cli` · `remote` |
| `produces` | ✅ | The artifact kinds this member can author. **Binds the member to a flow step.** |
| `style.avatar` | ✅ | 1–2 chars, shown on the board |
| `model` | ✅ (native) | Required for a native member to run. Also settable on a `cli` member, but only reaches the vendor if `command` includes a `{model}` placeholder |
| `command` | ✅ (cli) | Structured argv array. Each element is one argument; `{task}`, `{model}` substitute in place |
| `result` | ✅ (cli) | Prose describing what the binary emits. **Required so wrapping a foreign tool forces you to state its output.** |
| `server` | ✅ (remote) | The `kind: mcp` connector (by name) this member calls |
| `tool` | ✅ (remote) | The one MCP tool on `server` this member invokes |
| `skills` | — | Skill names injected into context |
| `knowledge` | — | Knowledge names injected into context |
| `connectors` | — | Connector grants, unioned with the team's |

**The why**

Kind-specific rules enforced by `validate`:

- A CLI agent declaring a `model` but no `{model}` in its `command` → `MODEL_PLACEHOLDER_MISSING`.
- Any agent naming a `model` not in the pricing table → `UNKNOWN_MODEL` (a subscription-granted agent
  is exempt — its model is unpriceable by definition).
- A `cwd` resolving outside the studio without `context_artifacts: inline` → `CWD_OUTSIDE_STUDIO_NO_INLINE`.
- `sandbox: unsandboxed` with no `sandbox_reason` → `SANDBOX_UNSANDBOXED_NO_REASON` — a member declared
  to run outside levare's OS sandbox, on any host, needs a documented reason a Conductor can act on.

`skills`, `knowledge`, and `connectors` are checked against their registry directories — an unknown
name in any of them fails loudly (`UNKNOWN_SKILL` / `UNKNOWN_KNOWLEDGE` / `UNKNOWN_CONNECTOR`) rather
than silently degrading the member's context or dropping the grant.

```markdown
---
name: relay
kind: remote
produces: [review]
server: linear
tool: create_comment
params:
  body: "{task}"
connectors: [linear]
style:
  avatar: "RL"
---

Posts the review as a Linear comment via MCP.
```

**Full field list, enum values, and skeleton:** the [Agent cheatsheet](cheatsheets/agent.md).

---

## Team — `teams/<name>.md`

A group with a job: what it consumes, what it produces, its members, and its flow.

**The basics**

| Field | Required | Notes |
|---|---|---|
| `name` | ✅ | Must match the filename |
| `consumes` | ✅ | Kinds this team takes as input. Every kind here must be expected by some work-unit type, or `UNKNOWN_CONSUMED_KIND` |
| `produces` | ✅ | Kinds this team offers the DAG. Every kind here must be produced by a member of the team, or `UNPRODUCIBLE_KIND` |
| `members` | ✅ | Agent names. Every name here must resolve to a real `agents/<name>.md`, or `UNKNOWN_MEMBER` |
| `flow` | ✅ | The declarative sequence (see below) |
| `style.color` | ✅ | Hex; the team's identity colour on the board |
| `knowledge` | — | Knowledge injected for every member of the team |
| `connectors` | — | Grants applied to every member |

**The why**

An ordered `flow` list. Each entry is one of three shapes:

```yaml
flow:
  - step: brief                    # invoke the member who produces this kind
  - gate: human                    # halt; wait for the Conductor
  - loop:
      between: [product-brief, review]   # exactly two step labels
      until: review.approved             # a <kind>.<status> condition
      max_rounds: 3
      on_exhaust: gate                   # escalate when max_rounds is hit
```

A loop dispatches **both** members each round; the Conductor's gate is at the loop's outcome, never on
each turn. If `until` can never be satisfied by the loop's members, `validate` rejects it
(`LOOP_UNTIL_UNREACHABLE`).

`knowledge` and `connectors` are checked against their registry directories, same as an agent's own
(`UNKNOWN_KNOWLEDGE` / `UNKNOWN_CONNECTOR`). `consumes` is checked against the union of every type's
`expects:` — not against "produced by some team", since a legitimate seed kind (e.g. `pitch`, folded
into a fresh unit's body on promotion rather than ever team-produced) would otherwise be rejected.

`guardrails` (`protected_paths`, `protected_branches`, `never`) constrains what this team's diffs and
branches may touch — path and branch namespaces are never cross-matched (ruling C6), so a path listed
under `protected_branches` is not also protected as a path.

A document still declaring `mode:` fails with `REMOVED_FIELD` — it was removed in PRD v1.1 (invariant
7: exactly one LLM orchestrator, no `mode: led` escape hatch).

**Full field list, enum values, and skeleton:** the [Team cheatsheet](cheatsheets/team.md).

---

## Connector — `connectors/<name>.md`

An external system a member can be granted.

**The basics**

| Field | Required | Notes |
|---|---|---|
| `name` | ✅ | Must match the filename |
| `kind` | ✅ | `cli` · `mcp` |
| `env` | ✅* | Env var **names** only. Required non-empty for `auth: env`; must be empty for `auth: subscription` |
| `actions` | ✅* | Required non-empty for `effects: write`. Action name → argv template, so a member can never supply raw argv |

Everything else — `server`/`command` (the transport), `auth`/`plan`/`role`, `effects`/`gate`, `home` — is
optional and none of it names another registry entity, so none of it lands in the table above. It's the
entire point of this entity, though, which is why it's covered below instead of dropped.

**The why**

`auth` and `env` must agree: an `env` connector with no vars (`EMPTY_ENV`), or a `subscription`
connector *with* vars (`SUBSCRIPTION_WITH_ENV`), is a definition error.

Every grant defaults to `effects: read` — information flows to the member freely. Declaring
`effects: write` turns the connector side-effecting: its `env` is withheld from members entirely (only
levare's own execution step, on gate approval, reads it), and it must declare `actions` — a write
connector with none is rejected (`MISSING_ACTIONS`). A member proposing against a write connector names
one of those actions and fills its `{placeholder}` slots via a proposal artifact's `params`; it can
never hand levare raw argv.

`gate` only means something on a write connector (declaring it on an `effects: read` one is rejected as
`GATE_ON_READ_CONNECTOR`, the same as `actions` there is `ACTIONS_ON_READ_CONNECTOR`). `proposal`
(default) means the grant is *"may draft a proposal,"* never *"holds the credential"* — the write only
happens once a Conductor approves the resulting `kind: proposal` artifact. `trusted` is the declared,
visible opt-out that injects exactly as an `effects: read` connector always has — skipping the gate on
purpose, not by omission.

`home` names dotpaths under the operator's real `$HOME` (e.g. `[".config/gh"]`) a connector's backend
genuinely needs, symlinked into a scratch `$HOME` at dispatch rather than handing a granted member the
operator's entire home directory. Traversal and absolute paths are rejected outright
(`UNSAFE_HOME_PATH`); a subscription connector left with no `home:` at all still validates (the
pre-existing default — the whole `$HOME`, unscoped) but gets a warning naming the gap
(`SUBSCRIPTION_NO_HOME`), same as a subscription connector with no `role:` (`SUBSCRIPTION_NO_ROLE`).

```markdown
---
name: github
kind: cli
command: gh
auth: subscription
plan: "gh auth login (personal)"
role: tool
effects: write
gate: proposal
actions:
  open-pr:
    - gh
    - pr
    - create
    - --title
    - "{title}"
    - --body
    - "{body}"
home: [".config/gh"]
---
```

A plain `effects: read` `kind: mcp` connector, for contrast — no `actions`, no `gate`, its `env` reaches
any member it's granted to:

```markdown
---
name: linear
kind: mcp
server: linear
argv: ["linear-mcp-server"]
env: [LINEAR_API_KEY]
role: tool
---
```

**Full field list, enum values, and skeleton:** the [Connector cheatsheet](cheatsheets/connector.md).

---

## Project — `projects/<name>.md`

A pointer at a product repo, and its constitution.

**The basics**

| Field | Required | Notes |
|---|---|---|
| `name` | ✅ | Must match the filename |
| `repo` | ✅ | Where the product's code lives locally |
| `remote` | ✅ (nullable) | Its git remote, or `null` if this project declares none. **The key is required; the value doesn't have to be a URL** — approved work still needs *somewhere* to be pointed at deciding, even when that decision is "nowhere yet" |
| `default_branch` | ✅ | Usually `main` |
| `deploy` | ✅ (nullable) | Where it ships, or `null` if undeclared |
| `pace` | ✅ | `auto` (daemon advances between gates) · `step` (nod before each team runs) |

**The why**

`remote` and `deploy` are the two fields where "required" and "nullable" both apply, and it's easy to
misread the first as the whole story: `levare project new` happily writes `remote: null` and validates
clean, the same as `deploy: null`. What's required is the *key's presence* — a project that hasn't
picked a remote yet still declares that decision explicitly, rather than the field being silently
absent.

A repo that can't be resolved gets its own warning: a `repo:` pointing at a path with no `.git` there
yet is `PROJECT_REPO_UNRESOLVED`, not a hard error — the walkthrough form is "clone it later," so this
stays a warning, named plainly rather than a silent no-op.

`overrides` is a one-level merge over team defaults, scoped to this project — it doesn't name a
specific team by field, so it isn't in the basics table above, but it's how a project can, say, raise a
team's default budget without editing the team itself.

```markdown
---
name: todo-cli
repo: ~/source/todo-cli
remote: null
default_branch: main
deploy: null
pace: auto
---

House rules for todo-cli.
```

**Full field list, enum values, and skeleton:** the [Project cheatsheet](cheatsheets/project.md).

---

## Type — `types/<name>.md`

A work-unit template: what a unit of this type is expected to produce, and where it gates.

**The basics**

| Field | Required | Notes |
|---|---|---|
| `name` | ✅ | Must match the filename |
| `glyph` | ✅ | The board marker |
| `expects` | ✅ | The kinds a unit of this type should produce |
| `gates` | ✅ | Where a human decision is required |

**The why**

The scaffold ships five: `inception`, `feature`, `fix`, `spike`, `research`. **This is not a closed
set** — add `types/<name>.md` and a work unit can declare `type: <name>`; `levare validate` checks a
unit's `type` against whatever's actually defined here, not a fixed list. A unit naming a type nothing
defines fails loudly (`UNKNOWN_TYPE`), listing every type that *does* resolve.

`output` names the artifact kind this type's flow terminates on, and must be one of that same type's
own `expects` — `levare validate` checks the correspondence (`UNDECLARED_OUTPUT_KIND`). `gates` is NOT
checked against anything: its values mix flow step labels (which only exist relative to whichever team
ends up bound to a unit of this type — never declared on the type itself) with the literal keyword
`merge` (a synthetic final gate levare opens itself, never a step any team declares), so there is no
single well-defined target to check it against; a typo here validates clean. `timebox` is a
spike/timebox duration, Runner-enforced. `promotable_to` documents the knowledge kind a completed
unit of this type — a research report, most naturally — is meant to be promoted into `knowledge/`
through a gate, rather than living only as a one-off artifact — but the field itself is
documentation only: the promotion gate's actual destination always comes from whatever
`knowledgeName` the caller supplies, never a lookup on this field (`TYPE_PROMOTABLE_TO_INERT`).

```markdown
---
name: feature
glyph: "▸"
expects: [product-brief, design, spec, code, review]
gates: [brief, design, spec, merge]
output: code
---
```

**Full field list, enum values, and skeleton:** the [Type cheatsheet](cheatsheets/type.md).

---

## Studio settings — `studio.md`

A root-level singleton, distinct from the product pointers in `projects/`. Optional throughout; an
absent file or field means "no studio-level declaration," and callers fall back to their defaults.

**The basics**

Nothing here is unconditionally required — the whole entity is opt-in.

| Field | Required | Notes |
|---|---|---|
| `orchestrator_model` | — | The Orchestrator's model. Validated against `knowledge/model-pricing.md`, exactly like an agent's own `model:`. Overridden at runtime by `LEVARE_ORCHESTRATOR_MODEL` |
| `conductor_git_identity.name` | ✅ (if declared) | The operator's own `git config user.name` |
| `conductor_git_identity.email` | ✅ (if declared) | The operator's own `git config user.email` |

**The why**

`conductor_git_identity` exists so the board's timeline can render a hand-committed edit and a
levare-recorded Conductor action as the same actor, instead of two — declare it once and both read as
you.

```markdown
---
orchestrator_model: claude-sonnet-5
conductor_git_identity:
  name: Ada Conductor
  email: ada@example.com
---
```

**Full field list, enum values, and skeleton:** the [Studio cheatsheet](cheatsheets/studio.md).

---

## Eval — `evals/<name>.md`

A rubric scoring a work-unit type's output — golden criteria you write down once and judge future
work against, rather than re-deciding "is this good?" from scratch every time.

**The basics**

| Field | Required | Notes |
|---|---|---|
| `name` | ✅ | Must match the filename |
| `unit` | — | Names a work-unit type (see [Type](#type--typesnamemd) above) — an open string, not a closed set |

**The why**

Same as a work unit's own `type:` field: `unit:` is checked against `types/` (`UNKNOWN_TYPE`) — a typo
fails loudly, naming every type that *does* resolve.

**Body:** not used — only the frontmatter is read; the body is stored but never rendered or consumed.

```markdown
---
name: feature-shipped-code
unit: feature
rubric:
  - "Tests exist for the new behaviour and pass"
  - "No unrelated files changed"
  - "Matches the approved brief it consumes"
---
```

`evals/` is loaded alongside `skills/` and `knowledge/` for the registry screen (`extra.ts`); it isn't
one of the entities the Runner's own DAG walk reads to decide what runs next — an eval doesn't gate a
flow or bind a member the way `produces:` does. It's a durable, versioned rubric for judging a type's
output, living beside the studio's other definitions instead of in someone's head.

**Full field list, enum values, and skeleton:** the [Eval cheatsheet](cheatsheets/eval.md).

---

## Skill — `skills/<name>.md`

Reusable instructions a member's context can include by name.

**The basics**

| Field | Required | Notes |
|---|---|---|
| `name` | ✅ | Referenced by name from an agent's or team's `skills:` list |

That's the whole schema — `description` (display-only) and `scripts` (bundled script paths,
documentation only — levare reads a skill's `SKILL.md` body into a member's context, never a file
listed here; see the `SKILL_SCRIPTS_INERT` validate warning) are both optional.

**The why**

A skill resolves in one of two shapes: a flat `skills/<name>.md`, or a bundled `skills/<name>/SKILL.md`
folder carrying its own supporting files (the Agent Skills format) — both are valid resolutions of the
same `<name>`, and `validate` treats them identically.

The body is injected **verbatim** into a member's context, under the skills section — what you write
here is exactly what the member reads at dispatch, not a summary of it. A `skills:` entry naming
neither shape fails loudly (`UNKNOWN_SKILL`) rather than silently degrading the member's context.

```markdown
---
name: house-style
description: The team's writing conventions
---

Prefer short sentences. Never use passive voice.
```

```markdown
---
name: new-project
description: Scaffold a new repo from the house template
scripts: [scripts/create-repo.sh]
---

Run scripts/create-repo.sh with the new repo's name.
```

**Full field list, enum values, and skeleton:** the [Skill cheatsheet](cheatsheets/skill.md).

---

## Knowledge — `knowledge/<name>.md`

A reference document injected into member context by name.

**The basics**

| Field | Required | Notes |
|---|---|---|
| `name` | ✅ | Referenced by name from an agent's or team's `knowledge:` list |

`tags` is the only other field — organizing/filtering only, never read by the runner.

**The why**

Same injection model as a skill: the body goes into a member's context **verbatim**, under the
knowledge section. A `knowledge:` entry naming nothing here fails loudly (`UNKNOWN_KNOWLEDGE`).

A type's `promotable_to` (see [Type](#type--typesnamemd) above) is the other direction of this
relationship — a completed unit gets promoted *into* `knowledge/` through a gate, rather than a
knowledge document being written by hand from the start.

```markdown
---
name: house-style
tags: [writing, conventions]
---

The house style guide.
```

**Full field list, enum values, and skeleton:** the [Knowledge cheatsheet](cheatsheets/knowledge.md).

---

## Idea — `ideas/<name>.md`

A captured pitch with no project yet.

**The basics**

| Field | Required | Notes |
|---|---|---|
| `name` | ✅ | Must match the filename |

`pitch` (the one-sentence summary used on promotion) and `tags` are both optional.

**The why**

An idea names nothing else in the registry — it's a leaf, not referenced by any `agent:`/`team:` field
the way a skill or knowledge document is. Its body is also treated differently from theirs: rather than
being injected verbatim into a member's context, it's rendered as display prose on the idea's own board
page, for a human to read. Only the frontmatter `pitch` survives promotion to a project.

```markdown
---
name: dark-mode-toggle
pitch: A settings toggle to switch the app to a dark color scheme.
tags: [ui, settings]
---

Users keep asking for this in support tickets.
```

**Full field list, enum values, and skeleton:** the [Idea cheatsheet](cheatsheets/idea.md).

---

Next: **[5.3 · The CLI](03-cli.md)**

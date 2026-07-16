# 5.2 · Registry entities

> For the terse per-entity field reference and copy-paste skeletons, see the [generated cheatsheets](cheatsheets/)
> — one page per entity, computed straight from these same schemas, so it can't drift from the code.
> This page stays the home of the cross-entity rules and the why.

Every field of every registry entity, as levare actually validates it. Each is a markdown file with
YAML frontmatter; the body (below the frontmatter) has a defined role per entity, noted in each table.

`levare validate` reports every violated rule for an entity in a single pass — you never fix one field
only to be told about the next.

---

## Agent — `agents/<name>.md`

A member. What it can produce, and how to invoke it.

| Field | Required | Kinds | Default | Notes |
|---|---|---|---|---|
| `name` | ✅ | all | — | Must match the filename |
| `kind` | ✅ | all | — | `native` · `cli` · `remote` |
| `produces` | ✅ | all | — | The artifact kinds this member can author. **Binds the member to a flow step.** |
| `model` | — | native ✅ · cli — | — | Validated against `knowledge/model-pricing.md`. Required for a native member to run; on a CLI member it substitutes `{model}` in the command |
| `command` | ✅ (cli) | cli | — | Structured argv array. Each element is one argument; `{task}`, `{model}`, `{feature_repo}` substitute in place |
| `context_via` | — | cli | `arg` | `arg`: context fills `{task}`. `stdin`: context is written to the child's stdin |
| `context_artifacts` | — | all | `paths` | `paths`: consumed artifacts as root-relative paths. `inline`: their full text (required when `cwd` is outside the studio) |
| `cwd` | — | cli | studio root | Working directory. A path outside the studio without `context_artifacts: inline` is a definition error |
| `timeout` | — | cli | — | Seconds before the member is killed |
| `result` | ✅ (cli) | cli | — | Prose describing what the binary emits. Required so wrapping a foreign tool forces you to state its output |
| `server` | — | remote | — | The MCP server name |
| `tools` | — | native | — | Forwarded to the SDK as the `allowedTools` allowlist. No `tools` → no tools |
| `skills` | — | all | — | Skill names injected into context (recipe item 2) |
| `knowledge` | — | all | — | Knowledge names injected into context (recipe item 3) |
| `connectors` | — | all | — | Connector grants, unioned with the team's |
| `style.avatar` | ✅ | all | — | 1–2 chars, shown on the board |

**Body:** the member's system prompt (native) or wrapper notes (cli).

Kind-specific rules enforced by `validate`:

- A CLI agent declaring a `model` but no `{model}` in its `command` → `MODEL_PLACEHOLDER_MISSING`.
- Any agent naming a `model` not in the pricing table → `UNKNOWN_MODEL` (a subscription-granted agent
  is exempt — its model is unpriceable by definition).
- A `cwd` resolving outside the studio without `context_artifacts: inline` → `CWD_OUTSIDE_STUDIO_NO_INLINE`.

---

## Team — `teams/<name>.md`

A group with a job: what it consumes, what it produces, its members, and its flow.

| Field | Required | Default | Notes |
|---|---|---|---|
| `name` | ✅ | — | Must match the filename |
| `consumes` | ✅ | — | Kinds this team takes as input |
| `produces` | ✅ | — | Kinds this team offers the DAG. Every kind here must be produced by a member of the team, or `UNPRODUCIBLE_KIND` |
| `members` | ✅ | — | Agent names |
| `flow` | ✅ | — | The declarative sequence (see [5.1](01-artifact-contract.md) and below) |
| `style.color` | ✅ | — | Hex; the team's identity colour on the board |
| `guardrails` | — | — | `protected_paths`, `protected_branches`, `never` — path and branch namespaces never cross-matched (ruling C6) |
| `knowledge` | — | — | Knowledge injected for every member of the team |
| `connectors` | — | — | Grants applied to every member |

**Body:** the team charter, injected into member context (recipe item 4). A `LEARNINGS.md` beside the
team file, if present, is injected after it.

### The flow

An ordered list. Each entry is one of three shapes:

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

---

## Connector — `connectors/<name>.md`

An external system a member can be granted.

| Field | Required | Default | Notes |
|---|---|---|---|
| `name` | ✅ | — | Must match the filename |
| `kind` | ✅ | — | `cli` · `mcp` |
| `command` | — | — | The CLI binary (`kind: cli`) |
| `server` | — | — | The MCP server (`kind: mcp`) |
| `env` | ✅* | — | Env var **names** only. Required non-empty for `auth: env`; must be empty for `auth: subscription` |
| `auth` | — | `env` | `env` (levare injects and scopes) · `subscription` (the CLI authenticates itself) |
| `plan` | — | — | Names the subscription plan; used in receipts and `doctor` |
| `scope` | — | — | Human-readable note on who should hold this grant |

`auth` and `env` must agree: an `env` connector with no vars, or a `subscription` connector *with*
vars, is a definition error.

---

## Project — `projects/<name>.md`

A pointer at a product repo, and its constitution.

| Field | Required | Default | Notes |
|---|---|---|---|
| `name` | ✅ | — | Must match the filename |
| `repo` | ✅ | — | Where the product's code lives locally |
| `remote` | ✅ | — | Its git remote — approved work must have somewhere to land |
| `default_branch` | ✅ | — | Usually `main` |
| `deploy` | — | `null` | Where it ships |
| `pace` | — | `auto` | `auto` (daemon advances between gates) · `step` (nod before each team runs) |
| `overrides` | — | — | One-level merge over team defaults |

**Body:** the house rules, injected into every member's context for this project (recipe item 5).

---

## Type — `types/<name>.md`

A work-unit template: what a unit of this type is expected to produce, and where it gates.

| Field | Required | Notes |
|---|---|---|
| `name` | ✅ | Must match the filename |
| `glyph` | ✅ | The board marker |
| `expects` | ✅ | The kinds a unit of this type should produce |
| `gates` | ✅ | Where a human decision is required |
| `output` | — | The terminal artifact |
| `timebox` | — | Spike/timebox semantics |
| `promotable_to` | — | e.g. a research report promotes to `knowledge/` through a gate |

The five shipped types: `inception`, `feature`, `fix`, `spike`, `research`.

---

## Studio settings — `studio.md`

A root-level singleton, distinct from the product pointers in `projects/`. Optional throughout; an
absent file or field means "no studio-level declaration," and callers fall back to their defaults.

| Field | Required | Notes |
|---|---|---|
| `orchestrator_model` | — | The Orchestrator's model, validated like any agent's. Overridden at runtime by `LEVARE_ORCHESTRATOR_MODEL` |

---

Next: **[5.3 · The CLI](03-cli.md)**

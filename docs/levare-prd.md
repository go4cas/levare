# levare — Product Requirements Document

**Version:** 1.1 · 2026-07-12 (amendment 1 folded in — see `docs/prd-amendment-1.md` for the historical record of each change)
**Author:** Cas (the Conductor), with architecture consolidated from design sessions
**Builder:** Claude Code, staged `/goal` runs under auto mode (run plan is a separate document)
**Companions:** `levare-design-brief.md` (design law), CD round-3.1 assets (`styles.css`, `app.js`, `studio.html`, `project.html`, `run.html`, `registry.html` — adopted as the board's actual templates and assets, not references), `Levare_Design_System.html` (token and derivation-rule reference).

---

## 1. What levare is

levare (leh-VAH-reh — the conductor's lift before the downbeat) is a solo operator's console for an AI agent workforce: one binary that lets a single human direct teams of AI agents that take products from pitch to production. Tagline: *Agents play on your beat.*

Three roles, named exactly: the **Conductor** is the human — the only source of intent and the only approver. The **Orchestrator** is an LLM agent (Claude Agent SDK) that interprets the Conductor's intent, routes work, and narrates the system. The **Runner** is a deterministic process — no model, no judgment — that walks dependency graphs, assembles member contexts, spawns member processes, and enforces declared limits. **Members** are agents (Claude Agent SDK subagents, or wrapped foreign CLIs like Codex and Gemini) organized into **teams** with declared flows. Work happens in **work units** that produce **artifacts**; every consequential transition passes a **gate** decided by the Conductor.

All state is markdown files with YAML frontmatter in a git repository. The UI is a stateless projection of that repository, re-derived on every request. There is no database and there never will be one.

## 2. Invariants

These hold across every phase and every future feature. A change that breaks one is a PRD amendment, not an implementation decision.

1. **No member process ever starts without a Conductor approval in its causal chain. Every work unit's first flow step raises a start gate — regardless of type, regardless of `after:`. A unit's existence is not consent (ruling C8).** Start gates let that approval be prompted rather than remembered, but never replaced. There is no auto-start path. External events (issues, schedules, `after:` conditions) may only *raise gates*; `after:` is only ever a precondition on when a start gate is *raised* — a unit's own existence, hand-written, committed, or otherwise appearing on disk, is never a licence to begin work once `after:` is satisfied or absent.
2. **Files are the truth.** Every entity — team, agent, skill, type, project, work unit, artifact, connector, knowledge, eval — is a markdown file with frontmatter. Git is the audit log. The binary holds no state that cannot be reconstructed by re-reading the repo.
3. **Artifacts are immutable once approved.** Changes produce a new artifact that `supersedes:` the old id. Lineage is never rewritten.
4. **Only the Conductor sets `approved_by`.** Members and the Orchestrator may move an artifact `draft → in-review` or `→ blocked`; nothing else.
5. **`consumes` is a hard dependency.** The DAG is recomputed from frontmatter on every walk; no scheduler state exists to corrupt.
6. **Code reaches a project's main branch only through the review loop plus a merge gate.** Spike code never merges — promotion means a new feature unit consuming the spike's findings. **[SPECIFIED, NOT IMPLEMENTED — v1.1: the merge phase does not exist yet; levare produces artifacts through gates but does not yet take a branch through a merge gate to `main`, so this invariant has no enforcement point until that phase ships. See `docs/prd-amendment-1.md` §2.]**
7. **Exactly one LLM orchestrator.** Team-internal sequencing is declarative `flow` data executed by the Runner. There is no escape hatch. (The `mode: led` opt-in from v1.0 was cut — it was never built and no unit needed it; one orchestrator, no second locus of judgment. See `docs/prd-amendment-1.md` §3.)
8. **Members never communicate laterally.** A member with a question exits `blocked`; the Runner raises it as a gate; the Conductor is the disambiguator.
9. **The board's write surface is exactly three routes** (§9). Everything else is GET or SSE. A test asserts the route table.
10. **Zero runtime dependencies except `@anthropic-ai/claude-agent-sdk`.** The rule behind the rule: where a dependency would replace a deliverable (parser, validator, server, renderer), build it; where it would replace a platform (the agent harness), buy it. Dev dependencies are unrestricted.
11. **Secrets never enter the repo.** Connector definitions name required env vars; values come from the environment (`.env` gitignored, or an external secret runner like `op run`). Wrapped CLIs keep their own auth. **The scoping boundary is precise (NOTES C13): levare scopes ENVIRONMENT credentials — a connector names env var *names*, and the Runner's allowlist injects exactly those into a granted member's process, nothing else. A CLI that authenticates itself from its own stored credentials on disk (`auth: subscription`, e.g. `codex login` writing a session to `~/.codex`) is outside that boundary: levare does not and cannot scope it, because there is no env var to withhold — any member able to spawn the binary can use the login, granted or not. That grant is documentation of intent, not enforcement (see `levare doctor`, §6). Prefer `auth: env` wherever the vendor offers it; grant `auth: subscription` connectors only to members you trust.**
12. **The design brief's semantic system is law:** canonical six-state palette; gate brass is the only amber-family hue and appears only on gate-shaped elements; team hues on identity surfaces only, with derivation rules (tinting, contrast floor, minimum distance from accent and brass); glyphs = unit type; mono = filesystem truth, and every mono token is a link.

## 3. Tech stack (ratified)

Bun runtime, TypeScript, `bun build --compile` to a single binary named `levare`. Storage: filesystem + git (git operations shell out to the `git` binary). HTTP: raw `Bun.serve`; live updates over SSE fed by `fs.watch`; board pages are server-rendered template functions returning HTML strings; CD's `styles.css` and `app.js` ship as the static assets. Frontmatter: a declared strict YAML subset (scalars, string/number arrays, one-level maps) with a hand-rolled parser — the subset is a feature; definition files that need more YAML are a design smell. Validation: hand-rolled, first-class deliverable. Tests: `bun:test`. Foreign members: `Bun.spawn` on their CLIs. External services: MCP. Repo layout is repo-root (no `.levare/` dotfolder):

```
levare/                    # the studio repo — also where the binary runs
  teams/    agents/    skills/    knowledge/    types/
  connectors/    evals/    projects/    work/    ideas/
  fixtures/                # golden work units + stub members (phase 1+)
  src/                     # the binary's source
```

## 4. The artifact contract

Every artifact is a markdown file. Frontmatter schema (subset-YAML):

```yaml
kind: spec                  # any kind named by a type template or team `produces`
id: spec-checkout-flow-v1   # stable slug; versioned on supersede
unit: checkout-flow
project: storefront
status: in-review           # draft | in-review | approved | rejected | superseded | blocked
produced_by: kestrel/lyra   # team/member, or "conductor"
consumes: [product-brief-v1, design-checkout-v1]
supersedes: null            # id of the artifact this replaces, if any
approved_by: null           # conductor-only; name + ISO date on approval
approved_commit: null       # conductor-only; commit ref recorded at gate resolution — the immutability baseline (nullable; absent on pre-amendment artifacts)
created: 2026-07-11
files: []                   # supplementary files that travel with this index artifact
usage:                      # §10; nullable fields allowed
  model: claude-sonnet
  tokens_in: 31000
  tokens_out: 10000
  usd: 0.58                 # estimate; null when unpriceable
  wall_clock_s: 480
```

**Ruling C12 — the member authors CONTENT, levare authors the ARTIFACT.** A member is never handed this schema and is never expected to produce it: its return value is markdown prose, nothing else — the body, full stop. Every frontmatter field above is instead assembled by the Runner/adapter boundary itself from facts it already has by construction: `kind` (the flow step it was dispatched for), `id` (unit-scoped, `<kind>-<unit>-vN`), `unit`/`project` (the dispatch coordinates), `status: in-review`, `produced_by` (the team/member that actually ran), `consumes` (the artifacts levare itself handed the member as context — never a self-report), `supersedes`/`approved_by` (null; set later, only by a gate resolution), `created`, `files: []`, and `usage` (the SDK's own reported receipt when the boundary supplies one, `unreported` otherwise — never parsed from anything the member wrote). If a member's raw output nonetheless opens with a frontmatter fence — a model that guessed at the schema, or restated it — that fence is stripped and discarded unread before levare authors its own; nothing in it is ever trusted, including a self-reported token count (a member reporting its own usage is a member guessing). This applies uniformly to every adapter kind — native, cli, remote. Empty or unusable content after stripping is a blocked artifact, not a blank one. Rules the validator enforces: required fields present and typed; `status` in the enum; keys under known schema (unknown keys are errors, not warnings); `consumes`/`supersedes` ids resolve to existing artifacts within the project; an approved artifact's file content may not change in a later commit — enforced against git by diffing the artifact against its recorded `approved_commit` ref (excluding the approval-stamp fields), so a committed post-approval edit is caught, not only an uncommitted working-tree edit (closes A7; an approved artifact with no `approved_commit` falls back to the pre-amendment HEAD diff); folder artifacts (design output, code changes) have exactly one markdown index file carrying the frontmatter, with binaries listed in `files:` and verified to exist. Status transitions: `draft → in-review` (member), `in-review → approved | rejected` (Conductor only), `any → superseded` (by a successor's `supersedes`), `draft|in-review → blocked` (member, with questions in the body), `blocked → in-review` (after Conductor input re-invokes the member).

**Gates** are not stored entities: a gate *is* an artifact at `in-review` whose flow position declares `gate: human`, plus start gates (§6). Gate verbs: approve, request-changes (Conductor note → producer re-invoked → successor artifact supersedes → same gate), reject (unit paused). Resolution writes `approved_by` (or rejection state) and commits with the Conductor as author.

## 5. Registry entities

**Teams** (`teams/*.md`): `name`, `consumes`, `produces`, `members`, `flow` (ordered list of `step`, `gate: human`, and `loop` blocks — loop: `between: [a, b]`, `until` (a status condition on a named kind), `max_rounds`, `on_exhaust: gate`), `style: { color }`, optional `guardrails:` (per-team `protected_paths`, `never` actions) and `knowledge:` refs. Body = charter, injected into member context. (Sequencing is always declarative — the v1.0 `mode: declarative | led` field is cut, per invariant 7.)

**Agents** (`agents/*.md`): `kind: native | cli | remote`. Native: `model`, `skills`, `tools`, `knowledge`. CLI: `command` template with `{task}` substitution, `cwd` template (`{feature_repo}`), `timeout`, `result` contract description. Remote: MCP server ref. All: `produces:` — the artifact kinds this member can produce — and `style: { avatar }` (1–2 chars or file). Body = system prompt (native) or wrapper notes. **`produces:` is what makes a member bindable:** the Runner resolves a team's flow step to the one member of that team declaring a matching kind, so an agent that declares nothing can satisfy no step, and a team whose flow step no member can satisfy is a studio that cannot run — rejected by `levare validate`, not discovered at runtime (v1.1; see NOTES F1).

**Types** (`types/*.md`): the five templates — inception `◈`, feature `▸`, fix `◦`, spike `∗`, research `▤` — each a flat `expects:` list of kinds plus `gates:`. Spike carries `timebox:` semantics (Runner-enforced); spike output is `findings`; research output is `report`, promotable to `knowledge/` via a gate. Templates are starting shapes: the Orchestrator may propose adding a kind to a *specific unit* through a Conductor confirmation; templates themselves contain no conditionals.

**Projects** (`projects/*.md`): pointer — `repo`, `remote`, `default_branch`, `deploy`, `pace: auto | step`, `overrides: {}` (one-level merge over team defaults; exactly one level). Body = house rules, injected into every member context for that project. `projects/studio.md` points at the levare repo itself, giving non-product work (research units, the field guide) a home.

**Work units** (`work/<project>/<unit>/unit.md`): `type`, `status`, optional `after: [unit-ids]` (start-gate condition — never autostart), optional `timebox`, optional `budget:` USD (crossing raises a gate: continue / raise / stop — no kill, no policy engine), optional `team:` (ruling C12/F10 — names the team responsible for this unit explicitly; required only when more than one team in the studio produces a kind the unit's type expects, since `levare validate` refuses to guess between them — AMBIGUOUS_PRODUCER, naming the kind and every candidate team). Artifacts live beside it; `ideas/` holds captured pitches not yet promoted to any project.

**Connectors** (`connectors/*.md`): `kind: mcp | cli`, `server`/`command`, `env:` map of required var *names* (values never present), scope notes, `auth: env | subscription` (NOTES C13, default `env`). `auth: env` requires a non-empty `env:` — the Runner injects a connector's env only into members whose team/agent grants it, and that grant is the enforcement. `auth: subscription` requires `env:` be empty or absent — the backend authenticates itself from its own stored credentials, and levare does not and cannot scope that credential; `plan:` names the subscription for cost accounting (§10). **Knowledge** (`knowledge/*.md`): plain documents referenced by name; includes `model-pricing.md` (§10). **Evals** (`evals/*`): golden work units + rubrics (phase-1 fixture doubles as the first).

## 6. The Runner

Deterministic, target ≤ ~500 lines excluding tests. Responsibilities:

**DAG walk.** On any change under `work/` (or on demand): for each active unit, find kinds that some team `produces`, that don't yet exist, and whose `consumes` are all approved → execute that team's flow. Units with unmet `after:` are invisible to the walk. **Every unit's first production — `after:` or not — raises a start gate** (verbs: start / not-yet / re-scope) at flow position zero before the walk executes a single member (ruling C8); an `after:` condition becoming satisfied is what makes that gate reachable for a unit that has one, never a substitute for raising it. `pace: step` pauses for a nod before each subsequent team invocation.

**Flow execution.** Steps run sequentially; `gate: human` halts the walk and surfaces the gate; `loop` alternates its members until the `until` condition, `max_rounds`, then `on_exhaust`. `blocked` artifacts halt like gates. Timeouts and timeboxes kill member processes and mark the step for escalation. **A budget gate halts like any other gate — including in the unattended daemon (ruling C3, extended):** when a unit's ledger crosses its declared `budget:`, the gate is raised and the daemon halts *that unit* until the Conductor resolves it; a budget gate that does not stop the daemon is a gate that watches you overspend. `continue` acknowledges the current spend and suppresses re-raising until a new threshold is crossed (C3's memory rule); `raise` updates the effective budget; `stop` pauses the unit. Budgets are per-unit — other units are unaffected.

**Context assembly** — the fixed recipe, in order: (1) agent definition body, (2) referenced skills, (3) referenced knowledge files, (4) team charter + team `LEARNINGS.md`, (5) project house rules, (6) the task string from the flow step, (7) *paths* to consumed artifacts — never their contents. Deterministic and inspectable: `levare context <agent> --unit <u> --dry-run` prints the exact assembled context.

**Adapters.** Native → Claude Agent SDK invocation with the assembled context, tool allowlist, and granted-connector env. CLI → `Bun.spawn` of the command template in `cwd`, granted env only, timeout enforced. Remote → MCP call. In every case the raw return value is content, not a document (ruling C12, §4): the adapter boundary strips any frontmatter fence the member's output happens to carry and wraps the remainder in frontmatter levare itself authors — kind/id/unit/project/produced_by/consumes/status/supersedes/approved_by/created/files, none of it read off the member. All three normalize a **usage receipt** (§10): the SDK's own reported accounting for a native call, `unreported` honestly for cli/remote (no reporting channel exists for them yet) — never derived from a member's self-reported figures.

**Guardrails** live here, deterministically: tool allowlists, env scoping, `protected_paths` / `never` checks by diff inspection before a merge gate, timeouts, loop caps, budget gates. No LLM-based guardrails. **Env scoping's boundary is precise (NOTES C13, invariant 11): levare scopes ENVIRONMENT credentials — an `auth: env` connector's grant is enforced by the allowlist (env.ts). A CLI that authenticates itself from disk (`auth: subscription`) is outside that boundary entirely; levare does not claim to guard it.**

**Doctor.** `levare doctor` walks connectors and reports required-env presence and CLI auth status before anything runs, plus each connector's `auth` mode (NOTES C13) — and, for any `auth: subscription` connector, a plain warning that levare cannot scope that credential and the grant is documentation, not enforcement.

## 7. The Orchestrator

A Claude Agent SDK application; the conversation is the product's single entry point. Behaviors: opens every session with a scope-appropriate **briefing** (gates on the Conductor oldest-first, what unblocked, doctor warnings); narrates context before each gate card; interprets intent into unit operations (open unit of type X, capture idea → `ideas/`, promote idea → project); runs the `new-project` skill (`gh repo create`, clone, write pointer, ask deploy target + house rules, commit); proposes — never applies — `LEARNINGS.md` appends at unit retro and knowledge promotions from research reports, both through gates; answers `stats` questions from the derived metrics. The Orchestrator holds no state; everything it "knows" is re-derived from the repo and the conversation.

## 8. Metrics

`levare stats` computes from frontmatter + git history, no instrumentation: review rounds to approval (per team), gate response time (median), loop exhaustion count, units shipped per period, cost per artifact kind and per unit (§10). These surface on the board's stat strips and are the passive eval tier.

## 9. The board

`levare serve`: server-rendered projections of the repo, styled entirely by CD's shipped assets. Four screens matching the round-3.1 templates: **studio** (stats incl. spend·30d, Needs-You gate inbox with origin on every card, Running Now, project cards, rails: projects/registry/connectors/releases/ideas), **project** (pointer, constitution with citation counts and supersede history, unit rows with type glyph + mini-score + cost footer, expandable artifact lists), **run** (score with state nodes + team avatar column, timeline from git log + runner events with cost figures, every mono token a link), **registry** (all entity kinds rendered; Edit source → validate with the *same validator* → write file → commit as the Conductor). Every screen carries its derivation line. SSE channel pushes re-render triggers on `fs.watch` events and streams Orchestrator replies.

**The complete write surface — exactly three routes, asserted by test:**

```
POST /gates/:project/:artifact/:verb     # verb ∈ approve|request|reject|start|notyet|rescope (+note)
POST /registry/*path                      # edit-source save: validate → write → commit
POST /orchestrator/message                # conductor → orchestrator; reply streams over SSE
```

## 10. Cost tracking

Receipts are recorded at the Runner boundary into the producing artifact's `usage:` block, plus an append-only `work/<project>/<unit>/ledger.ndjson` for invocations that don't map to one artifact (loop rounds, blocked retries). Three numbers, three reliabilities: wall-clock (always), tokens (when reported), USD (estimate from `knowledge/model-pricing.md`, nullable). **A member authenticated through an `auth: subscription` connector (NOTES C13) always records `usd: null`, with the plan noted in its place — a flat-rate subscription doesn't bill per token, and pricing it from the table would be a fiction, not an estimate; token counts, where the CLI reports them, are still recorded.** Cost renders as quiet mono figures (timeline entries, unit footers, gate cards, studio spend stat) — never as alarm. `budget:` on a unit raises a gate when the ledger sum crosses it, and **that gate halts the unit's walk — the daemon included — until the Conductor resolves it** (ruling C3, extended; verbs continue / raise / stop, per §6): a budget gate stops spend, it does not merely report it. Budgets are per-unit, never global.

## 11. Build phases and acceptance criteria

Each phase is one `/goal` run; each criterion is transcript-demonstrable (a command Claude runs whose output the evaluator can read). Standing constraints for **every** phase: `bun test` exits 0 with all prior phases' tests still passing; `bun run deps:check` (a script asserting the dependency policy) exits 0; no files outside the levare repo are modified; do not ask for confirmation — surface uncertainty in a written note in `NOTES.md` and continue with the highest-confidence assumption; hard stop at 60 turns.

**Phase 1 — contract, parser, validator, golden fixture.**
Deliverables: subset-YAML parser; artifact/entity validator (`levare validate <path>`); the full registry + one project + one complete work unit as `fixtures/golden/` — a feature unit whose artifacts replay the storefront/checkout-flow story from the CD templates — plus `fixtures/stubs/`: scripted stub member CLIs that emit canned artifacts deterministically; rejection fixtures (malformed frontmatter, unknown keys, dangling `consumes`, mutated-after-approval).
Condition: "`bun test` exits 0, including ≥ 12 rejection-fixture tests each asserting a specific validator error; `levare validate fixtures/golden` prints `valid` and exits 0; `bun run deps:check` exits 0."

**Phase 2 — Runner core: DAG walk, flows, gates, loops, types.**
Deliverables: walk + flow execution + gate lifecycle + start gates (`after:`) + loop with exhaustion + the five type templates + `pace` + timebox/budget gates, all against stub members.
Condition: "`bun test` exits 0; `levare replay fixtures/golden --stubs` runs the unit end-to-end: transcript shows the walk halting at each declared gate, resuming on scripted approval, the review loop terminating by condition in round 2, and a scripted 3-round exhaustion case escalating with `on_exhaust: gate`; final artifact statuses match `fixtures/golden/expected.json` byte-for-byte."

**Phase 3 — adapters, context assembly, receipts, guardrails, doctor.**
Deliverables: native/CLI/remote adapters (CLI adapters tested against stubs; native against a mocked SDK boundary), context recipe + `levare context --dry-run`, usage normalization incl. `unreported`, env scoping, protected-path diff checks, `levare doctor`.
Condition: "`bun test` exits 0; `levare context lyra --unit checkout-flow --dry-run` output matches `fixtures/context/lyra.txt` exactly; replay transcript shows a usage receipt per invocation with one stub deliberately reporting nothing → recorded `unreported`; a test asserts a member without the github connector grant has no `GITHUB_*` var in its spawned env; `levare doctor` against fixture connectors reports one ok, one missing-env, matching expected output."

**Phase 4 — the board.**
Deliverables: `levare serve` with the four screens rendered from `fixtures/golden`, CD assets integrated verbatim (only data-binding changes), SSE updates, the three write routes, gate-verb round trip (POST → frontmatter flip → git commit → SSE re-render).
Condition: "`bun test` exits 0; snapshot tests assert each screen's rendered HTML contains the required structures (score with avatar column, gate cards with origin+consumes+age+cost, derivation lines, five type glyphs); a route-table test asserts exactly three mutating routes and enumerates them; an integration test POSTs approve on the fixture's open gate and asserts the artifact file shows `approved_by` and `git log -1` shows the commit."

**Phase 5 — Orchestrator integration.**
Deliverables: SDK-backed Orchestrator with briefing, gate narration, intent → unit operations, `new-project` skill (against a scratch git dir, not real GitHub, in tests), retro → LEARNINGS proposal, stats.
Condition (mechanical part): "`bun test` exits 0; with the SDK mocked, tests assert the briefing content derives correctly from fixture state, a chat 'approve' round-trips to the same file mutation as the POST route, and a retro proposal renders as a gate rather than a direct write." The judgment part — briefing quality, narration tone — is explicitly **Conductor-reviewed, not evaluator-judged**; phase 5's merge review is the heaviest human gate of the five.

## 12. Non-goals

No multi-user, auth, or tenancy. No database. No message bus or lateral agent communication. No policy engine, budget policies, or scheduling beyond start gates. No autostart (a future per-unit `autostart: true` opt-in is permitted by the invariants but out of scope). No front-end frameworks. No form-based authoring. No vault — credential storage stays in the environment and the wrapped CLIs.

---

*The run plan (sandboxing, `/goal` phrasing, turn limits, per-phase merge ritual) is specified separately and references this document's phase conditions verbatim.*

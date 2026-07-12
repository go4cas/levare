# levare

*(leh-VAH-reh) — the conductor's lift before the downbeat. Nothing runs until you give the beat.*

A solo operator's console for an AI agent workforce: one binary that lets a single human direct
teams of AI agents that take products from pitch to production. All state is markdown files with
YAML frontmatter in a git repo; the binary holds no state that cannot be reconstructed from the
repo. See [docs/levare-prd.md](docs/levare-prd.md) and [docs/levare-design-brief.md](docs/levare-design-brief.md).

## Phase 1 — contract, parser, validator, golden fixture

Implemented in this repo:

- **Subset-YAML parser** — [src/yaml.ts](src/yaml.ts). Scalars, inline/block arrays, and nested
  block mappings (the team `flow`/`loop` shape); rejects YAML exotica (anchors, aliases, tags,
  flow maps, block scalars, tabs). The subset is a feature.
- **Validator** — [src/validate.ts](src/validate.ts), a first-class hand-rolled deliverable.
  Required-and-typed fields, enum membership, unknown-key rejection, `consumes`/`supersedes`
  resolution within a project, folder-artifact index rules, listed-file existence, and
  approved-artifact immutability checked against git.
- **CLI** — `levare validate <path>` ([src/cli.ts](src/cli.ts); dev wrapper [`./levare`](levare)).
- **Golden fixture** — [fixtures/golden/](fixtures/golden/): the full registry, the `storefront`
  project, and the `checkout-flow` feature unit whose artifacts replay the PRD's checkout story.
- **Stub member CLIs** — [fixtures/stubs/](fixtures/stubs/): deterministic canned-artifact emitters
  (driven by the Runner in phase 2).
- **Rejection fixtures** — [fixtures/rejections/](fixtures/rejections/): 16 malformed cases, each
  asserting a specific validator error.

## Phase 2 — Runner core: DAG walk, flows, gates, loops, types

The deterministic Runner (§6): no model, no judgment, no clock. It recomputes the dependency graph
from frontmatter on every walk and drives each unit's team flow through the gate lifecycle.

- **Domain model** — [src/types.ts](src/types.ts): teams, agents, type templates, projects, work
  units, artifacts, and the normalized `flow` (step / gate / loop) nodes.
- **Loaders** — [src/repo.ts](src/repo.ts): re-read the repo as truth; the whole tree is passed
  through the phase-1 validator before the walk, and member output is contract-checked at the
  boundary with the *same* validator ([`validateArtifactSource`](src/validate.ts)).
- **Runner** — [src/runner.ts](src/runner.ts): DAG walk, responsible-team flow execution, gate
  lifecycle (approve / request-changes / reject), start gates via `after:`, review loops to
  `until` / `max_rounds` / `on_exhaust`, budget and timebox gates, and `pace: step`. Member
  invocation and Conductor decisions are injected, so the engine stays pure.
- **Replay** — `levare replay <path> --stubs` ([src/replay.ts](src/replay.ts)): reconstructs the
  checkout-flow story from a clean slate against the stub members — gates halt and resume on
  scripted decisions, the review loop terminates by condition in round 2, and a second scripted
  case exhausts `max_rounds` and escalates via `on_exhaust: gate`.
- **Oracle** — [fixtures/golden/expected.json](fixtures/golden/expected.json): the golden
  scenario's final artifact statuses, reproduced byte-for-byte on every replay.

## Phase 3 — adapters, context assembly, receipts, guardrails, doctor

The Runner's boundary made real: how members are actually invoked, what context they receive, what a
run costs, and what a member is allowed to touch (§6, §10).

- **Adapters** — [src/adapters.ts](src/adapters.ts): `AdapterRunner implements MemberRunner`,
  dispatching by agent kind. `native` → a mockable Claude Agent SDK boundary (the SDK is a platform,
  not a dependency — invariant 10); `cli` → a real `Bun.spawn` of the command template with the
  scoped env and timeout enforced; `remote` → a mockable MCP call. All three normalize a §10 receipt.
- **Context assembly** — [src/context.ts](src/context.ts): the fixed §6 recipe (agent · skills ·
  knowledge · team charter+LEARNINGS · house rules · task · consumed *paths*). `levare context
  <agent> --unit <unit> --dry-run` prints the exact assembled bytes; frozen in
  [fixtures/context/lyra.txt](fixtures/context/lyra.txt).
- **Receipts** — [src/receipts.ts](src/receipts.ts) + [src/pricing.ts](src/pricing.ts): wall-clock
  (always), tokens (when reported), USD (estimated from `knowledge/model-pricing.md`, nullable). A
  member that reports nothing is recorded `unreported`, never a fabricated $0.
- **Guardrails** — env scoping ([src/env.ts](src/env.ts)) is **allowlist-only**: a member's spawned
  environment is *built up* from its granted connectors' env-var names plus a `PATH`/`HOME` baseline
  — never a denylist over `process.env`. Plus protected-path/`never` diff checks and tool allowlists
  ([src/guardrails.ts](src/guardrails.ts)).
- **Doctor** — [src/doctor.ts](src/doctor.ts): `levare doctor` walks connectors and reports env
  presence (the ok / missing-env headline) plus CLI/MCP reachability (advisory), reading names not
  values. Frozen in [fixtures/doctor/expected.txt](fixtures/doctor/expected.txt).

### Run it

```sh
bun test                                 # full suite
./levare validate fixtures/golden        # prints "valid", exits 0
./levare replay fixtures/golden --stubs  # end-to-end transcript with a receipt per invocation
./levare context lyra --unit checkout-flow --dry-run  # the exact §6 context for a member
GITHUB_TOKEN=… ./levare doctor           # connector env/reachability report
bun run deps:check                       # dependency policy (zero runtime deps)
```

## Phase 4 — the board

`levare serve`: the four screens (studio, project, run, registry), server-rendered from the repo on
every request, CD's assets integrated, SSE re-renders on `fs.watch`, and the three write routes
(§9): gate verbs, registry edit-source, and the Orchestrator message route.

## Phase 5 — Orchestrator integration

An SDK-shaped Orchestrator (§7) behind a mocked, documented dispatch grammar: session briefing,
intent → unit operations, the `new-project` skill, retro/knowledge-promotion proposals, `stats`.
Ruling C7 (one gate-resolution path) and E4/E5 (real member invocation for `request`/`start`) close
here — see [src/gates.ts](src/gates.ts), [src/git.ts](src/git.ts), [src/orchestrator.ts](src/orchestrator.ts).

## Phase 6 — onboarding and distribution

- **`levare init [path]`** — [src/init.ts](src/init.ts): scaffolds an empty (or partially-built)
  directory into a working studio: the registry skeleton, the five type templates, one example
  team (`kestrel`, whose flow demonstrates a `step`, a `gate`, and a `loop`) with its native and cli
  agents, a sample skill in the Agent Skills folder format (`skills/new-project/SKILL.md`), a
  `.devcontainer/`, and a starter `README.md` — with no demo work units. Never overwrites an
  existing file, so it's safe to re-run. Also `git init`s the target and makes the founding commit
  under the *user's own* resolved git identity ([src/git.ts](src/git.ts)#makeFoundingCommit) — without
  git, the approved-artifact immutability check fail-opens and every commit-as-Conductor write path
  is inert, so `init` must not ship a studio with those guarantees off by default. If no git identity
  resolves, the repo still exists but nothing is committed, and `init` prints why prominently.
- **First-run experience** — [src/board/onboarding.ts](src/board/onboarding.ts): `levare serve`
  pointed at a directory with none of the skeleton dirs renders an explanatory page suggesting
  `levare init`, instead of a blank or crashing screen.
- **Gap G1 closed** — `assets/styles.css` now defines `.snode.is-danger` for the failed/rejected
  score-node state, completing the six-state canonical palette; the renderer↔stylesheet class-parity
  test in `tests/board-render.test.ts` covers all six.
- **Project status chip fixed** — `projectStatusChip` ([src/board/render.ts](src/board/render.ts))
  derives gate-count → active → idle instead of a hardcoded "running", so an empty project (no units,
  no members running) reads honestly as idle.

### Run it

```sh
bun test                                      # full suite
levare init /path/to/new-studio               # scaffold a fresh studio
levare validate /path/to/new-studio           # prints "valid", exits 0
levare serve /path/to/new-studio              # the board, non-empty from the first request
```

Uncertainties and assumptions are recorded in [NOTES.md](NOTES.md) (phase-1 A1–A8, phase-2 B1–B7,
phase-3 D1–D9, phase-4 E1–E14, phase-5 F1–F7, phase-6 G1/H1–H7).

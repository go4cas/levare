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

### Run it

```sh
bun test                              # full suite
./levare validate fixtures/golden     # prints "valid", exits 0
./levare replay fixtures/golden --stubs  # end-to-end transcript; oracle match, exits 0
bun run deps:check                    # dependency policy (zero runtime deps)
```

Uncertainties and assumptions are recorded in [NOTES.md](NOTES.md) (phase-1 A1–A8, phase-2 B1–B7).

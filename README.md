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

### Run it

```sh
bun test                          # full suite
./levare validate fixtures/golden # prints "valid", exits 0
bun run deps:check                # dependency policy (zero runtime deps)
```

Uncertainties and assumptions are recorded in [NOTES.md](NOTES.md).

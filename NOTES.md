# NOTES — uncertainties and assumptions (Phase 1)

Recorded per the standing constraint "surface uncertainty in a written note and continue with
the highest-confidence assumption." Each entry: what was unclear, and the choice made.

## A1. No CD template assets / demo data exist in the repo
The PRD references `styles.css`, `app.js`, `studio.html`, `project.html`, `run.html`,
`registry.html`, and "CD round-3.1 assets" as the source of the storefront/checkout-flow story.
The `assets/` directory is empty and no HTML/CSS/JS templates are present.
**Assumption:** I reconstructed the checkout-flow story directly from the PRD's own frontmatter
example (§4: `spec-checkout-flow-v1`, project `storefront`, team `kestrel/lyra`, consumes
`product-brief-v1` + `design-checkout-v1`) and the entity contracts in §4–§5. When the CD assets
arrive in a later phase, the golden fixture ids/kinds should be reconciled against them.

## A2. "one-level maps" vs. team `flow` nesting
§3 declares the YAML subset as "scalars, string/number arrays, one-level maps", but §5's team
`flow` is a list of maps where a `loop:` entry contains a nested map (`between`, `until`,
`max_rounds`, `on_exhaust`) — two levels deep.
**Assumption:** "one-level maps" is guidance for ordinary frontmatter, not a hard parser ceiling;
the `loop` block is the acknowledged exception. The hand-rolled parser supports indentation-based
nested mappings and sequences, but bans genuine YAML exotica (anchors, aliases, tags, `{}`/flow
maps, `|`/`>` block scalars, multiple documents, complex keys). "The subset is a feature" is
enforced by *rejecting those constructs*, not by capping map depth.

## A3. `levare validate <path>` invocation
The binary is not installed on `PATH` in phase 1 (that is `bun build --compile` territory).
**Assumption:** an executable wrapper `./levare` (shebang `#!/usr/bin/env bun`) at the repo root
delegates to `src/cli.ts`. Demonstrations run it as `./levare validate fixtures/golden`.

## A4. mutated-after-approval check requires git
§4: "an approved artifact's file content may not change in a later commit (checked at validation
time against git)." A static on-disk fixture cannot represent "committed then mutated" without a
live git repo.
**Assumption:** this rule is covered by a programmatic rejection test that builds a throwaway git
repo, commits an approved artifact, mutates the working tree, and asserts `MODIFIED_AFTER_APPROVAL`.
The other rejection cases are static fixture directories under `fixtures/rejections/`.

**Hermetic test setup (`tests/immutability.test.ts`).** The scratch repo must behave identically on
a bare container and on a developer host with a real global/system git config. Without isolation,
a host setting (`commit.gpgsign=true` with no key, a global `core.hooksPath` pre-commit hook, a
non-`main` `init.defaultBranch`) can make the setup commit fail or a signing prompt hang, which in
turn made the mutation check a false negative. The test now (1) points `GIT_CONFIG_GLOBAL` and
`GIT_CONFIG_SYSTEM` at `/dev/null` and overrides `HOME`, (2) passes explicit
`-c user.name/-c user.email/-c commit.gpgsign=false/-c core.hooksPath=/dev/null/-c init.defaultBranch=main`
on every git call, and (3) asserts a real `HEAD` exists after commit, failing the suite loudly at
setup rather than proceeding.

**Validator git-comparison audit.** `gitImmutabilityCheck` in `src/validate.ts`:
- always diffs against `HEAD` — never a hardcoded branch name (`main`/`master`/`trunk`) — so it is
  correct regardless of the repo's default branch;
- explicitly separates *no baseline* from *unchanged baseline*. States and their verdicts:
  - **S0** target is not a git repo → cannot verify → treated as **valid**;
  - **S1** the file has no history in `HEAD` (uncommitted / brand-new) → nothing to compare →
    treated as **valid**, because the approval itself is what will be committed, so there is no
    prior baseline to violate;
  - **S2a** file tracked in `HEAD` and unchanged → **valid**;
  - **S2b** file tracked in `HEAD` and differs → **`MODIFIED_AFTER_APPROVAL`**.
- the S2 comparison uses `git diff --quiet HEAD -- <path>` (honours the repo's own normalization
  such as `core.autocrlf`) rather than a raw byte-compare of `git show` output, so a checkout
  filter cannot manufacture a false "modified" verdict.

## A5. Validator scope for phase 1
The validator dispatches a schema by file location (folder → entity kind; `work/.../unit.md` →
work unit; other files under `work/.../` with a `kind:` → artifact). It validates structure/types,
enum membership, unknown-key rejection, and cross-artifact `consumes`/`supersedes` resolution
within a project. Deeper runtime rules (DAG walk, flow execution, gate lifecycle) are Phase 2.

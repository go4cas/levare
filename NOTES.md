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
- **canonicalizes both sides with realpath** before computing the repo-relative path.
  `git rev-parse --show-toplevel` returns a symlink-resolved path; on macOS the OS temp dir is under
  `/var`, a symlink to `/private/var`, so git returns `/private/var/…` while the validator holds the
  caller's `/var/…` path. Without canonicalization, `relative(toplevel, file)` yields a bogus
  `../../…` path, `git cat-file -e HEAD:<bogus>` fails, and the check falls through to S1 — masking a
  real mutation as "no history". Reproduced in the container by addressing the scratch repo through a
  symlinked directory (`tests/immutability.test.ts`, "across a symlinked repo path").
- returns the **state** it took for each approved artifact (`ImmutabilityState` on
  `ValidationResult.immutability`), so tests assert the branch explicitly — the mutation test asserts
  `S2b`, not merely `ok:false`, so a wrong-state exit can never pass silently again. States and
  verdicts:
  - **S0** target is not a git repo → cannot verify → treated as **valid**;
  - **S1** the file has no history in `HEAD` (uncommitted / brand-new) → nothing to compare →
    treated as **valid**, because the approval itself is what will be committed, so there is no
    prior baseline to violate;
  - **S2a** file tracked in `HEAD` and unchanged → **valid**;
  - **S2b** file tracked in `HEAD` and differs → **`MODIFIED_AFTER_APPROVAL`**;
  - **S2e** `git diff` itself errored (status > 1, e.g. a corrupt index) → unverifiable → treated as
    **valid** (fail-open, consistent with S0/S1) but recorded distinctly so a git error can never
    impersonate a verified-unchanged `S2a`.
- the S2 comparison uses `git diff --quiet HEAD -- <path>` (honours the repo's own normalization
  such as `core.autocrlf`) rather than a raw byte-compare of `git show` output, so a checkout
  filter cannot manufacture a false "modified" verdict.

**Fail-open concern (deliberate, revisit in a later phase).** S0 and S1 are both reachable through
git *errors* as well as through legitimately-uncommitted state — any failure of `rev-parse`,
`cat-file`, or a non-canonicalizable path resolves to a "valid" verdict rather than an error. This
is intentional at phase 1: the validator must not fabricate an immutability violation from an
environment hiccup, and an artifact that has never been committed has no baseline to violate. The
cost is that a genuinely-approved artifact that *should* have history but doesn't (e.g. it was never
committed) passes silently. Open question for a future phase: `validate` should probably **surface an
S1 count as a warning** (not an error) — "N approved artifacts have no committed baseline" — so the
Conductor can distinguish "not yet committed" from "committed and intact" at a glance. The
`immutability` states are already returned to make that reporting a pure projection when we add it.

## A5. Validator scope for phase 1
The validator dispatches a schema by file location (folder → entity kind; `work/.../unit.md` →
work unit; other files under `work/.../` with a `kind:` → artifact). It validates structure/types,
enum membership, unknown-key rejection, and cross-artifact `consumes`/`supersedes` resolution
within a project. Deeper runtime rules (DAG walk, flow execution, gate lifecycle) are Phase 2.

## A6. Work-unit status enum was invented
The PRD gives artifact `status` an explicit enum (§4) but does not enumerate **work-unit** `status`.
**Assumption:** the work-unit enum is `active | paused | blocked | shipped | abandoned`. `queued` is
**deliberately excluded**: a unit with an unmet `after:` is not a stored status but a *computed*
state — §6 says such units are "invisible to the walk" until the `after:` condition is satisfied, at
which point a start gate is raised. Making "queued" a persisted status would duplicate (and risk
contradicting) that derivation, violating the files-are-truth invariant. When the Runner lands in
Phase 2 this enum should be reconciled against how the walk actually reports unit state.

## A7. Immutability check detects uncommitted drift only (known limitation)
The current `MODIFIED_AFTER_APPROVAL` check compares the working tree against `HEAD`, so it catches
an approved artifact edited **but not yet committed** (state S2b). It does **not** implement the true
§4 rule — "an approved artifact's file content may not change in a *later commit*", i.e. unchanged
since *the commit in which it was approved*. A mutation that is itself committed advances `HEAD`, so
the working tree matches `HEAD` again and the check reports S2a (valid). Detecting that requires
knowing the approval commit ref for each artifact, which does not exist yet at Phase 1.
**Deferred.** The natural future mechanism: the gate handler (Phase 4's `POST /gates/...approve`)
commits at approval time — with the Conductor as author (§4) — so the approving commit's SHA is
knowable and can be recorded (e.g. in the artifact's frontmatter or a lineage index). The
immutability check would then diff the artifact against *that* ref rather than `HEAD`, closing the
committed-mutation gap.

## A8. Artifact body first-paragraph is the display summary (ratified)
Ratified rule: the **first paragraph** of an artifact's markdown body is its display summary. The
board renders that one paragraph in two places — the **gate-card context** (`gate__ctx` in
`assets/studio.html`) when the artifact sits at a gate, and the **unit-row description**
(`unit__desc` in `assets/project.html`) for the unit it leads. Authoring consequence: an artifact's
opening paragraph must stand alone as a single in-world sentence or two — no meta preamble, and the
leading `#` heading does not count as the paragraph. The golden fixture's artifact bodies are
written to this rule, each first paragraph aligned to the corresponding CD-template summary string
(product-brief → the "guest checkout with saved-card fallback" unit description; spec → the "spec
ready for review; two open questions on guest checkout" gate context). Because the immutability
check diffs approved artifacts against `HEAD` (see A7), rewriting an *approved* artifact's body is a
re-commit, not a silent edit — the fixture's approved bodies and their commit move together.

# NOTES — uncertainties and assumptions (Phase 2)

Phase-2 delivers the Runner core (§6): DAG walk, flow execution, gate lifecycle, start gates, loops
with exhaustion, the five type templates, `pace`, and timebox/budget gates, all against stub members.
These entries record where §6's prose left a mechanical choice, and the highest-confidence reading taken.

## B1. Replay reconstructs the story from a clean slate
`levare replay fixtures/golden --stubs` starts each scenario from **only** the unit.md — it ignores the
on-disk artifact files and rebuilds the whole score with the stub members. Rationale: this is the fullest
demonstration of "halting at each declared gate" (a resume-from-current-state walk would skip the brief and
design gates, which are already approved on disk). The Runner itself is resumable (it seeds from an existing
artifact set and skips already-approved steps), but replay opts for the from-empty walk. The engine never
mutates the golden fixture tree; replay is an in-memory simulation whose output is a transcript + a status map.

## B2. Flow step → (member, kind) resolution
§5 flow steps are bare labels (`brief`, `design`, `spec`, `review`); they name neither the member nor, for
`brief`, the exact kind (`product-brief`). The Runner resolves a step to the single team member able to
produce a matching kind, where "matching" is `kind === label` **or** `kind.endsWith("-"+label)` (so
`brief` → `product-brief`). Zero matches or more than one is a hard `RunnerError` — a misconfigured flow
fails loudly, never silently guesses. Capability facts come from the member layer (the stub exposes
`CAPABILITIES`); phase-3 real adapters will supply the same shape.

## B3. The loop's `until` gate
`loop.until: spec.approved` can only become true through a Conductor approval (invariant 4: only the
Conductor sets a terminal approval). The loop therefore raises **one gate per round on the first member's
artifact** (`spec`): approve → evaluate `until` → terminate by condition; request → next round; reject →
pause. This is the only reading consistent with "loop alternates until the `until` condition" + "members
never set their own approval". The review artifact is the input the Conductor reads at that gate.

## B4. Loop re-rounds version and supersede, never mutate
Each request-changes round re-invokes both loop members. Because the stub emits fixed ids, the Runner bumps
the trailing `-vN` (round 2 → `spec-checkout-flow-v2`) and sets `supersedes:` on the successor, flipping the
prior artifact to `superseded` (invariant 3: approved/immutable artifacts are replaced, never rewritten).
This is why the golden oracle shows `spec-checkout-flow-v1: superseded` alongside `-v2: approved`.

## B5. `expected.json` scope and the unit's terminal status
`fixtures/golden/expected.json` captures the **golden** scenario only (loop terminates in round 2) — the
permanent replay oracle. The unit ends `active`, not `shipped`: kestrel is the product-shaping team and its
flow completes at spec-approved, but the `feature` type still expects `code` + a `merge` gate, produced by a
downstream build team that does not exist in the fixture. With no team producing `code`, the walk finds no
further work and leaves the unit active. The exhaustion scenario ends `paused` and is demonstrated in the
transcript but is not part of the oracle.

## B6. Gate verb vocabularies beyond the §9 route table
§9's write routes enumerate `approve|request|reject|start|notyet|rescope`. The Runner adds the §10 budget
verbs `continue|raise|stop` (continue/raise proceed; stop pauses the unit's walk) and reuses `continue|stop`
for a timebox gate. The loop-exhaustion escalation gate accepts `approve|reject|rescope` (approve accepts the
un-converged spec; reject/rescope pauses). These are gate-decision verbs, not new HTTP routes — the route
table stays at three (asserted in phase 4).

## B7. Responsible-team selection
A unit's flow is run by the team whose `produces` overlaps the unit type's `expects` most (ties broken by
name). For the golden fixture this is unambiguously `kestrel`. When multiple shaping/build teams exist per
type, this heuristic will need revisiting against how the walk hands a unit between teams (e.g. shaping →
build). Deferred until a fixture exercises more than one producing team.

## Learnings
Subprocess-calling code inherits a hostile world: pin git config at the spawn site, canonicalize paths before comparing them, and test against dirty environments (symlinked tmpdirs, hostile global config) — not just clean ones.
Validation must fail closed: every early-exit "valid" state is an escape hatch; make the taken state observable and assert it explicitly in tests.
Keep the deterministic core injectable: the Runner takes its member invoker and decision source as interfaces, so replay scripts, unit tests, and (phase 3) real adapters drive the same engine with no clocks or randomness in the pass that produces the oracle.
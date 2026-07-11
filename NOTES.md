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

## Rulings (Conductor)

Rulings issued at the phase-2 gate. Unlike the assumptions above (which record the highest-confidence
reading of ambiguous prose), these are binding decisions — cite them, don't re-derive them.

C1 — Two legal loop styles. A loop whose until references artifact approval (e.g. spec.approved) is the conductor-amendment style: one Conductor gate per round, as kestrel's flow does. A loop may instead terminate on a member-set frontmatter field (e.g. review.verdict == approved, written by the reviewing member), with the human gate following the loop — the autonomous style. Invariant 4 is untouched: artifact status approved remains Conductor-only; a verdict field is member data, never a status. Phase-3 adapters must support both styles.

C2 — Gate-resolution completeness. No gate resolution may leave its artifact at in-review: approve → approved, reject → rejected, request-changes → superseded by the successor round's artifact. On any loop-gate resolution, including the exhaust gate, the round's companion review artifact resolves to approved (the Conductor accepted it as read). An artifact at in-review always means exactly one thing: an open gate awaiting the Conductor.

C3 — Budget acknowledgment memory. A continue at a budget gate acknowledges the current spend; the gate re-raises only when spend crosses a new threshold beyond the acknowledged amount. A raise updates the effective budget. Budget gates inform, they never spam.

C4 — Responsible-team selection (B7) is a fixture-scale shortcut, not the semantics. PRD §6's walk is per-kind: find producible kinds whose consumes are all approved, and invoke the team that produces each kind — this is how a unit hands from a shaping team to a build team. The per-unit heuristic is equivalent while fixtures contain one team; the divergence must be closed when a multi-team fixture lands.

C5 — approved_by always carries the Conductor's name plus ISO date. No defaults, no placeholders; provenance is never fabricated.

C6 — Branches and file paths are different guardrail namespaces. A team's `protected_branches` match only a change's branch ref (exactly); `protected_paths` match only a change's file path (exact or `dir/` prefix). Neither is ever matched against the other, and there is no path-segment matcher — `main` as a protected branch never trips on a file path like `src/main/app.ts`, and `deploy/` as a protected path never trips on a branch. The old combined `protected_paths: [main, deploy/]` shape is retired; `teams/*.md` declare the two lists separately.

# NOTES — uncertainties and assumptions (Phase 3)

Phase-3 delivers the adapters, context assembly, §10 receipts, guardrails, and doctor. These entries
record where §6/§10's prose left a mechanical choice, and the highest-confidence reading taken.

## D1. Adapter boundary — the SDK is a platform, not a dependency (invariant 10)
The native adapter targets the Claude Agent SDK, but adding it this phase would fail `deps:check`. So
each adapter kind sits behind an injectable interface in `src/adapters.ts`: `NativeBoundary.invoke`
(the mocked SDK boundary), `RemoteBoundary.call` (the mocked MCP call), and `CliSpawn.run` (a real
`Bun.spawnSync`, injectable for tests). `AdapterRunner implements MemberRunner`, so the phase-2 Runner
drives the real adapters unchanged. Replay's `--stubs` mode spawns the **stub CLI** in place of a
member's real command (finch/Codex) while native/remote members render the canned stub artifact —
this is "CLI adapters tested against stubs; native against a mocked SDK boundary" (§11) made literal.

## D2. Context command default root, step, and the consumed set (§6 recipe)
`levare context <agent> --unit <u> --dry-run` takes no path, so it defaults its root to
`fixtures/golden` (the studio-during-development, per A1); `--root <path>` overrides. When an agent
maps to more than one flow step (lyra → design, spec) the default is the **last** step in flow order
(spec, the richest context); `--step <label>` selects another. Recipe item 7 ("paths to consumed
artifacts") is read as **the unit's currently-approved artifacts**, sorted by id, rendered as
root-relative paths — the vetted inputs available at that step. The in-review spec on disk is *not*
listed: it is not yet an approved input. Paths only, never contents — asserted by test. Capability
(member→kind) resolution uses the same source the Runner uses (the stub `CAPABILITIES`); real
adapters will expose the same shape.

## D3. `fixtures/context/lyra.txt` and the doctor fixture are authored deliverables
Both frozen fixtures are generated from the implementation and reviewed, then committed as the oracle
their tests pin. lyra.txt is the exact §6 recipe output; the doctor fixture is the exact `levare
doctor` output given GITHUB_TOKEN present, LINEAR_API_KEY absent, `gh` not on PATH.

## D4. Skill + team-LEARNINGS fixtures added to make the recipe meaningful
lyra references skills `flow-design`/`spec-writing`, which had no files; the recipe injects skill
*content* (parallel to knowledge), so both were authored under `skills/`. Team LEARNINGS.md
(recipe item 4) lives beside the team file as `teams/<team>.learnings.md` — a plain markdown note
(no frontmatter), skipped by both the entity loader and the validator (`classify` returns non-schema
for `*.learnings.md`). `teams/kestrel.learnings.md` was authored. None of this changes the phase-1/2
oracle.

## D5. Env scoping is an allowlist, never a denylist (invariant 11; phase-3 security posture)
A member's spawned environment (`buildMemberEnv`) contains **only**: the baseline vars `PATH` and
`HOME` (documented here — PATH so a wrapped CLI resolves its own tools, HOME so it finds its config;
nothing sensitive is baseline), plus the env-var *names* declared by the member's **granted**
connectors, pulled from the base env. Nothing else from `process.env` is carried through — a secret
for an ungranted connector cannot leak, and an unrelated secret (e.g. `AWS_SECRET_ACCESS_KEY`) never
appears. Grants are the union of an agent's `connectors:` and its team's `connectors:` (new optional
fields on both schemas; the golden fixture grants none, so lyra/wren/finch spawn with no `GITHUB_*`).

## D6. Receipts: levare estimates USD; silence is recorded as silence (§10)
`normalizeReceipt` derives USD from `knowledge/model-pricing.md` (tokens × rate), **not** from any
member-reported `usd` — levare prices cost, members report tokens. An unknown model is unpriceable →
`usd: null` (a quiet gap, never a guessed figure). A member that reports no usage block at all is
recorded `unreported: true` with every figure null — never a $0 that would read as "ran for free".
The finch/Codex stub was made deliberately silent (a wrapped foreign CLI with no token accounting),
so the replay transcript carries the required `unreported` receipt without changing any status oracle.
Wall-clock in replay uses the member-reported value for determinism; a live adapter additionally
stamps its own measured wall-clock, elided from the byte-for-byte transcript.

## D7. Doctor status = env presence; CLI/MCP reachability is advisory
The §11 acceptance is "one ok, one missing-env", so a connector's headline status is driven purely by
whether its declared env-var names are present (all present → ok, else missing-env). A missing CLI
binary (`gh` not on PATH) or an MCP server name is reported as an advisory line and does **not** flip
the status — it is a warning to fix, not an invalid connector definition. Doctor reads only var
*presence*, never values (invariant 11). Determinism comes from injecting the env probe and the CLI
probe; the CLI wires `process.env` presence and `Bun.which`. Default root is `fixtures/golden`.

## D8. Guardrails, and C1 loop-style support
`checkGuardrails` inspects a proposed merge diff against a team's `protected_branches` (branch
namespace) and `protected_paths` (file-path namespace) plus `never` actions before a merge gate
(deterministic, no LLM; namespaces kept separate per **C6** — no path-segment matcher);
`allowedTools` is the pure projection of an agent's `tools:` the native adapter hands to the SDK.
On **C1** (adapters must support both loop styles): the adapter layer
is loop-style-agnostic — it emits an artifact + receipt identically whether the loop terminates on a
Conductor gate (`spec.approved`, the style kestrel's fixture exercises, B3) or on a member-set verdict
field. Fully wiring the *verdict-terminated* autonomous loop (an optional artifact `verdict` field +
`untilSatisfied` reading a member field) is Runner machinery with no phase-3 fixture to exercise it;
it is deferred to when a multi-style fixture lands, consistent with B3. Nothing in the adapters
precludes it.

## D9. Unresolved `cwd` templates spawn in the default directory
A CLI agent's `cwd: "{feature_repo}"` is a template bound to a project checkout that does not exist in
replay. Rather than spawn into a bogus path, the adapter treats a `cwd` still holding an unresolved
`{…}` as "no cwd" and runs in the default directory. Real operation substitutes `{feature_repo}`
before this point.

## D10. Phase-3 security-gate fix-ups
Five hardening changes on the phase-3 adapter/guardrail surface, none touching the oracle:
- **Command injection closed.** An agent's `command` is now a structured argv array (§5), e.g.
  `[codex, review, --input, "{task}", --repo, "{feature_repo}"]`. `defaultCliCommand` substitutes each
  `{placeholder}` *in place* and keeps each template element as exactly one argv element — a
  substituted value with spaces/quotes/metacharacters stays a single argument and is never re-split
  (the old `.split(/\s+/)` on a substituted string is gone). The command is handed to shell-less
  `Bun.spawnSync(argv)`, so nothing is shell-interpreted. Tests drive hostile task strings (space,
  `"`, `; rm -rf .`, `$(whoami)`, tab, `&&`) through the real substitution and assert one argv slot
  each, plus a real spawn proving an embedded `rm` deletes no marker file.
- **Timeout is a distinct signal.** `bunSpawn` reads Bun's own `exitedDueToTimeout` flag, not an
  inference from `SIGTERM`/empty output. A timeout throws a timeout error; a non-zero exit throws an
  exit error; a slow-but-successful member (its own exit 0) is never misread as timed out. All three
  paths are tested, including a real 1s-timeout `sleep`.
- **Guardrail namespace split** (ruling C6, above).
- **Context errors surfaced.** `AdapterRunner.assemble` no longer swallows every throw: an empty
  consumed set is a normal silent success, but a genuine recipe error (missing agent/team/unit/step)
  is logged to stderr, then a minimal empty context is returned so a mocked boundary can still run.
- **Usage shape validated.** `readUsage` → `coerceUsage` checks the `usage` block is a map whose
  fields are the right scalar types; a scalar/list usage field or a wrong-typed member (e.g.
  `tokens_in: lots`) records `unreported` (usd `null`), never a fabricated or NaN receipt.

## Learnings
Subprocess-calling code inherits a hostile world: pin git config at the spawn site, canonicalize paths before comparing them, and test against dirty environments (symlinked tmpdirs, hostile global config) — not just clean ones.
Validation must fail closed: every early-exit "valid" state is an escape hatch; make the taken state observable and assert it explicitly in tests.
Keep the deterministic core injectable: the Runner takes its member invoker and decision source as interfaces, so replay scripts, unit tests, and (phase 3) real adapters drive the same engine with no clocks or randomness in the pass that produces the oracle.
Security is an allowlist, not a filter: a member's environment is *built up* from granted names, never *stripped down* from process.env — the default is empty, so a new secret is invisible until a connector is granted.
Estimate honestly or not at all: levare prices cost from the pricing table and records member silence as `unreported`; it never dresses a missing number as $0.

# NOTES — uncertainties and assumptions (Phase 4)

Phase-4 delivers `levare serve` (§9): four server-rendered screens, SSE re-renders fed by `fs.watch`,
and exactly three write routes. These entries record where §9's prose left a mechanical choice and
where the golden fixture's actual shape forced the CD prototype markup to be trimmed.

## E1. Fixture is truth; the studio/project demo markup was trimmed to match it
`assets/studio.html` and `assets/project.html` (the CD round-3.1 prototypes) show richer demo data
than `fixtures/golden` actually has: multiple projects with live "Running Now" members, a
start-gate example, release history, per-project stat strips with numbers that don't derive from
anything on disk. The golden fixture has exactly one project (`storefront`) with no shipped units,
no releases, no `after:`-gated unit, and no live-process registry. Per the standing instruction
("where fixture data and the assets/ demo markup disagree, the fixture is truth and the markup
adapts to it"), the board renders honest empty/derived states instead of fabricating demo content:
"No live process registry yet" for Running Now, "no releases tracked yet" for Releases, and no
start-gate card (none exists to render). `src/board/render.ts` is a pure function of repo state —
the demo's decorative numbers were never load-bearing to begin with.

## E2. No live process registry — "Members running" is always 0
PRD invariant 2 ("the binary holds no state that cannot be reconstructed by re-reading the repo")
and §3 ("all state is markdown files with YAML frontmatter... no database") mean the board has no
channel to observe an in-flight member process — that requires a running Runner instance reporting
live state, which is Runner/Orchestrator wiring (phase 5), not a board concern. The studio stat and
the "Running Now" section render their true, honest state: zero, with a note rather than a fabricated
list. When a live Runner exists, this becomes a real projection of its in-memory state; nothing in
the board's rendering contract needs to change, only the data source.

## E3. Board gate resolution is the direct §4 operation, not the Runner's loop-walk machinery
`src/board/gateops.ts` intentionally does NOT drive `src/runner.ts`'s `raiseGate`/loop engine — that
engine simulates a full walk against an injected `MemberRunner` and `DecisionSource` (phase 2/3). The
board instead performs exactly what §4 describes for one Conductor click: flip the target artifact's
frontmatter, validate at the same boundary (`validateArtifactSource`, reused, not reimplemented),
write, commit as the Conductor (`applyApproval`/`bumpVersion`, exported from `runner.ts` for this
purpose and reused, not reimplemented). Ruling C2's loop-specific side effect ("on any loop-gate
resolution the round's companion review artifact resolves to approved") is Runner-walk behavior for
an *active* loop round in flight; the golden fixture's open gate (`spec-checkout-flow-v1`) is a
static in-review artifact on disk, not a loop round the board is mid-walking, so no companion
artifact exists to auto-approve. If a future fixture exercises board approval of a live loop round,
this distinction should be revisited.

## E4. `request` reuses the phase-1 stub member CLI, deterministically
Producing a real successor artifact for request-changes requires re-invoking a member — full member
invocation (native SDK / CLI spawn / MCP) is the phase-3 adapter layer, which needs live credentials
or a mocked SDK boundary neither present nor appropriate to wire into a synchronous HTTP handler.
`doRequest` instead reuses `fixtures/stubs/member-stub.ts`'s `render()` — the same deterministic
canned-artifact producer the Runner's stub-mode replay already trusts — keyed by the artifact's
`produced_by` member and its `kind`. This only succeeds for (member, kind) pairs the stub knows
(`wren:product-brief`, `lyra:design`, `lyra:spec`, `finch:review`); an artifact whose producer isn't
in that table returns `501` with an honest "no producer available" error rather than fabricating a
new artifact. Wiring the real adapters here is a natural phase-5 (Orchestrator) extension once live
member invocation has a place to live in the server process.

## E5. Start-gate verbs (`start` / `notyet` / `rescope`) are honestly incomplete
No unit in the golden fixture has an `after:` dependency, so no start gate exists anywhere to
exercise. §9's route enumerates `start|notyet|rescope` as valid verbs regardless, so the route
accepts them: `notyet` and `rescope` are no-ops beyond the decision itself (there is no persisted
"queued" status to flip — NOTES A6 — and rescoping a unit with no artifacts yet has nothing to
commit). `start` returns `501` with a clear message: kicking off a team's flow is genuine Runner
member-invocation machinery, and building an untested code path for a verb with zero fixture coverage
would violate "no half-finished implementations" more than declining to build it does. Deferred to
whichever phase first lands a fixture with a real start gate.

## E6. Conductor git identity
Git commits made by gate resolution and registry edits use author `cas <cas@levare.local>` — matching
the golden fixture's own `approved_by: "cas <date>"` convention (there is no other named identity
anywhere in the PRD/fixtures). Every commit passes explicit `-c user.name/-c user.email/-c
commit.gpgsign=false/-c core.hooksPath=/dev/null`, mirroring the hermetic git pattern already
established in `tests/immutability.test.ts`: a Conductor action must never hang on a host signing
prompt or a stray commit hook, in production as much as in tests.

## E7. `assets/app.js` is not byte-for-byte verbatim — a narrow, documented exception
`assets/styles.css` is untouched: 100% verbatim, as instructed. `assets/app.js`, as shipped, has zero
network code — its gate-card `resolveGate()` and the Orchestrator composer only ever mutated the DOM
locally with canned copy; no `fetch` anywhere. That is irreconcilable with an explicit hard
requirement of this phase ("the gate-verb POST must flip frontmatter, commit as the Conductor, and
trigger an SSE re-render") — a verbatim `app.js` would make every gate button in a real browser
decorative. The fix is the smallest one that closes the gap: a `postGate()` fetch call fires before
the existing optimistic `resolveGate()` animation (so the felt motion the design brief asks for is
unchanged), the `send` button now carries the original verb (`request`/`rescope`) and note text to
that POST, the composer POSTs to `/orchestrator/message` and renders the real reply (falling back to
the original canned line only if the request fails), and an `EventSource('/events')` listener reloads
the page on the SSE `reload` message. No existing class name, DOM structure, animation, or timing was
changed. `tests/board-serve.test.ts` asserts the frozen parts (theme toggle, `resolveGate` anatomy)
are still present verbatim.

## E8. Registry "Edit source" stays a read-only preview; the write route is real and tested directly
The CD registry prototype's `data-edit-toggle` only ever swapped a `<pre class="rawmd">` between
shown/hidden — there was never an editable control (textarea/contenteditable) in the shipped markup,
so there is no verbatim element to wire a save action to. Adding one would be a structural change
("restyling"), not data-binding. `POST /registry/*path` (validate → write → commit, reusing
`validatePath` — the same validator the whole repo is checked against, not a second copy) is fully
implemented and covered directly in `tests/board-serve.test.ts` (a valid edit commits; an invalid one
is rejected with the file rolled back to its prior content). Wiring a real client-side editor is left
for whenever the registry screen gets its own design pass.

## E9. Run-view timeline is built from two real sources, never fabricated
"Every runner walk, member spawn, and gate event" (design brief) has no live event store to read in a
static-fixture board — so `src/board/timeline.ts` builds the timeline from what's actually on disk:
the unit's `ledger.ndjson` (§10 usage receipts, one line per member invocation) merged with `git log`
on the unit's directory, sorted by timestamp. Both are genuinely "derived from the repo on every
request" (invariant 2); nothing is synthesized. A currently-open gate is rendered separately in the
Orchestrator panel (age computed live), not injected as a synthetic timeline row.

## E10. Score nodes: one per expected kind, in-review is the gate itself (ruling C2)
`src/board/derive.ts#scoreNodes` walks the unit type's `expects:` list (e.g. feature: product-brief,
design, spec, code, review) and renders one node per kind from its current (non-superseded) artifact:
approved → a filled circle, in-review → the gate diamond itself (never a separate "active" circle —
C2: an artifact at in-review always means an open gate), nothing yet → a hollow "queued" circle. The
team-tinted avatar column renders the producing member's initials on the owning team's declared
color for every node that has a producer; queued nodes carry no avatar, matching the design brief's
own upcoming/gate treatment.

## E11. Registry loads skills/knowledge/evals/ideas independently of `repo.ts`
`src/repo.ts`'s `Repo` shape is the Runner's working set (teams/agents/types/projects/connectors/work)
and deliberately does not include skills, knowledge, evals, or ideas — extending it risked touching
code and tests phases 1–3 already pin. `src/board/extra.ts` loads those four directories directly
(same frontmatter parser, same "files are the truth" posture) purely for the registry screen and the
studio ideas rail, without changing `repo.ts`'s shape or any of its existing tests.

## Learnings
A frontmatter patcher that edits specific scalar lines by regex — rather than a full parse-mutate-
reserialize round trip — is the right tool when the subset-YAML writer doesn't exist yet: it
preserves every byte of formatting and comments the human/member originally wrote, and it fails
loudly (`frontmatter key not found`) rather than silently if a field it expects has moved or been
renamed, which a generic serializer could paper over.
Prefer calling a Bun.serve-shaped `fetch(Request): Response` handler directly in tests over opening
a real TCP port: it is faster, avoids sandbox/port flakiness entirely, and exercises the exact same
router and handler code a real socket would call into.
`process.exit()` after a command dispatcher is only safe for commands that are supposed to run once
and exit; a long-lived listener (`serve`) must be special-cased or the process tears itself down the
instant the server starts — caught by manually curling the server rather than by any unit test, a
reminder to smoke-test any new long-running command end-to-end, not just its route handlers in
isolation.

## E12. `./levare serve` exited immediately — root cause and the coverage gap that hid it (gate fix-up)

**Root cause.** There are two independent entry points into the CLI: this module's own
`if (import.meta.main)` block at the bottom of `src/cli.ts`, and the separate `./levare` wrapper
script (`#!/usr/bin/env bun` → `import { main } from "./src/cli.ts"; process.exit(main(...))`) —
the actual documented invocation path per NOTES A3. Earlier in phase 4 the `serve` exit-code bug
(process.exit() tearing down the listener the instant it started) was diagnosed and fixed, but the
fix was applied only inside `src/cli.ts`'s own entry block, special-casing `argv[0] === "serve"`.
The `./levare` wrapper is a *different file* with its own unconditional `process.exit(main(argv))`
and was never touched — so `./levare serve fixtures/golden`, the command actually documented and
actually run by a Conductor, still printed its bound URL and exited on the spot. `bun run
src/cli.ts serve` (the form used for manual verification during the original phase-4 pass) worked
fine, which is exactly how the regression stayed invisible.

**Why a green suite didn't catch it.** Every board test up to this point either called
`board.fetch(request)` directly, in-process — which exercises the router and every handler, but
never touches either CLI entry point or a real socket — or, for the one place `serve` itself was
invoked, called `bun run src/cli.ts serve` by hand rather than `./levare`. No test spawned the actual
`./levare` binary as a subprocess and made a real HTTP request against it, so the one code path a
Conductor would actually run was the one path with zero coverage.

**Fix.** Both entry points now delegate to a single exported `runCli(argv)` in `src/cli.ts`, which
contains the `serve`-is-long-running exception exactly once; `./levare` and `src/cli.ts`'s own
`import.meta.main` block are now two one-line callers of the same function, so the exception cannot
be applied to only one of them again. `serve()` (`src/board/serve.ts`) now: binds `0.0.0.0` (not
loopback-only, so a forwarded/container port reaches it) instead of Bun's default; prints the address
actually returned by the bound `Server` object, not the requested port (relevant if `--port 0` is
ever used for an ephemeral port); and installs `SIGINT`/`SIGTERM` handlers that close the fs.watch
handle and the listener before exiting, rather than relying on default signal disposition. `GET /`
was changed from a 302 redirect to `/studio` into rendering studio directly (200) — the gate
demonstration curls `/` with no `-L`, and a redirect there would read as "serves nothing" all over
again to a plain `curl`.

**New coverage.** `tests/board-serve-e2e.test.ts` spawns the real `./levare serve <scratch-root>
--port <p>` as a subprocess (`Bun.spawn`, not `board.fetch`), waits for it to actually accept
connections, then drives it purely over HTTP/SSE: asserts the process is still running after boot
(`exitCode === null`) — the direct regression assertion — GETs `/` and asserts the studio HTML (not
a redirect), GETs `/styles.css` and `/app.js` and diffs the response bytes against the files on disk
(proving the assets are actually served, not merely referenced), POSTs approve on the fixture's open
gate and confirms both the on-disk frontmatter flip and a live SSE `reload` push, then sends `SIGINT`
and asserts the subprocess exits 0 and stops accepting connections. Verified as a real regression
test by temporarily restoring the old wrapper's unconditional `process.exit(main(...))` — the suite
fails (times out waiting for the server to come up) — then reverting; the fixed wrapper passes.

**Learning.** An in-process `fetch(Request): Response` test (deliberately chosen earlier in phase 4
for its speed and freedom from port/sandbox flakiness — see the prior Learnings entry) is real
coverage for routing and rendering, but it can *never* catch "the entry point that starts the
process is broken," because it never goes through that entry point. A long-running command needs at
least one test that spawns the real binary/script a user actually runs and talks to it over an
actual socket — the fast in-process tests and the one slow subprocess test are complementary, not
substitutes for each other.
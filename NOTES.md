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

C7 — One gate-resolution path. Board gate ops (src/board/gateops.ts) and Runner gate resolution (src/runner.ts) must converge on a single implementation before v1. A Conductor's approve means the same thing regardless of which surface received the click; ruling C2 (companion-artifact resolution on loop gates) applies to both. The phase-4 split — the board performing the direct §4 operation while the Runner drives the walk engine — is a scaffolding artifact, not the semantics. Close it in phase 5, when live member invocation enters the server process; that same convergence retires E4's stub-reuse in doRequest and E5's 501 on the `start` verb.

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

## E13. Registry entities restyled as one bordered card each (design-fidelity fix)

The registry previously rendered each entity as a bare `<section class="entity">` (no border/
background of its own) containing one or more separately-bordered `<div class="card">` sub-panels
("Declared flow", "Definition", etc.) plus an `.editbar` and a `.rawmd` `<pre>` that visually floated
outside any bordered container — inconsistent with every other screen's component vocabulary (gate
cards, unit rows, project cards are each a single bordered container). Fixed by making the outer
wrapper itself `<article class="entity card">` — reusing the `.card` rule already declared for a
labeled panel in `assets/styles.css` (no new CSS added) — and flattening the inner sub-panels from
their own nested `<div class="card">` into plain `.card__h`-labeled sections directly inside that one
outer card, so header, body, and the Edit-source actions all sit inside one bordered container with
no card-in-a-card nesting. `.entity` is kept alongside `.card` on the same element purely so app.js's
existing `[data-entity]`/`.entity.is-editing` selectors keep working unchanged; it contributes no
styling `.card` doesn't already provide. `tests/board-render.test.ts` asserts one `.entity.card` per
rendered entity, an `.editbar` inside every one of them, and zero remaining nested `<div class="card">`.

## Incident: a stray `./levare serve fixtures/golden` process mutated the real golden fixture

While demonstrating the phase-4 SIGINT fix (E12), a manual verification server was pointed directly
at the real `fixtures/golden` (reasoned as "read-only, GETs only, so it's fine") and, despite the
demo's own `kill -INT` appearing to succeed at the time (`ps -p $PID` returned not-found), a `bun
./levare serve fixtures/golden` process was later found still running and had received (from an
unidentified source — nothing in the recorded transcript issued it) a `POST
/gates/storefront/spec-checkout-flow-v1/approve`, leaving the real fixture's `spec-checkout-flow-v1.md`
modified on disk (`status: approved`, `approved_by: "cas 2026-07-11"`) though never committed. Caught
immediately by `levare validate` refusing to load the repo (`MODIFIED_AFTER_APPROVAL` — the phase-1
immutability check doing exactly its job) while starting work on this ticket. The stray process was
killed (`kill -9`) and the file restored via `git checkout --`; `levare validate fixtures/golden`
confirms clean, and `git status` shows no unintended changes. The root cause of exactly how a stray
process outlived its own `kill -INT`/`kill -9` was never fully pinned down — see E14 below, where it
recurred during that fix's own verification, this time as a process `ps` could see and (eventually)
kill but that a same-context `curl` could not reach at all. Whatever this sandbox's process/network
lifecycle quirk is, it is outside this codebase's control, which is exactly why E14 replaces an
operator rule ("don't point serve at fixtures/") with a structural one: it no longer matters whether
a stray process outlives its shell, because nothing it can do the write routes execute against a
fixtures/ path.

## E14. `--read-only`: the incident above, fixed structurally instead of by operator discipline

The first response to the incident above was a *rule* — "never point a demo `serve` at fixtures/
golden directly" — recorded as a note to remember. A rule that has to be remembered is exactly the
kind of thing that fails under pressure (or, as it turned out, under a sandbox quirk neither predicted
nor fully diagnosable), so it is replaced here with a structural guarantee: `levare serve` now refuses
all three write routes with `405` before their handlers ever run, whenever the board is read-only.

**Mechanics.** `BoardCtx.readOnly` is computed once at `createBoard(root, opts)` time as `opts.readOnly
?? isUnderFixtures(root)` — `isUnderFixtures` resolves `root` to an absolute path and checks for a
literal `fixtures` path segment (not a substring match: `/tmp/my-fixtures-dir` does not qualify,
`/tmp/x/fixtures/golden` does). The check sits in the router's `fetch()` dispatcher, ahead of and
outside every handler: `if (matched.route.mutating && ctx.readOnly) return 405(...)`. This is the
important property — it is not each of the three handlers individually remembering to check a flag
(which would be exactly as fragile as the operator rule it replaces, just moved into code); the
mutating handler bodies (`doApprove`/`doReject`/`doRequest`, the registry write, the orchestrator
route) are structurally unreachable when read-only, full stop. `levare serve [root] [--read-only]`:
the flag forces read-only for *any* path (useful for a read-only demo of a normal repo too); without
it, the default is computed from the path alone, so pointing `serve` at `fixtures/golden` — with no
flag, no memory required — is safe by construction. GET routes and the SSE channel are unaffected;
only the three write routes are gated.

**New coverage (`tests/board-readonly.test.ts`).** `isUnderFixtures` against relative/absolute/
substring-adjacent paths; a fixtures-path board reports `ctx.readOnly === true` and all three POST
routes return `405` with an unchanged file on disk (byte-for-byte, asserted directly); the identical
approve POST against a plain scratch studio-repo path (no `fixtures` segment) succeeds exactly as
`tests/board-serve.test.ts` already covers, added here specifically as the negative-case pair so the
path-detection logic itself — not just "approve works somewhere" — is under test; and `--read-only`
forcing read-only on an otherwise-writable path.

**Recurrence during this very fix's own verification.** While confirming the fix live against the
real `fixtures/golden`, the same class of stray-process behavior from the incident above recurred: a
`bun ./levare serve fixtures/golden` process was found running (via `ps aux`) that this session had
not knowingly left alive, and a `curl` from the same kind of shell invocation that had just
successfully talked to a sibling instance on the same port number got `000` (no connection) against
it — then a subsequent plain `kill -9` from a *different* (default-sandboxed, not
`dangerouslyDisableSandbox`) shell invocation did successfully kill it. This is consistent with some
process/network-namespace boundary inside the harness's sandboxing that neither this codebase nor
this note can fully explain. It does not matter for correctness any more: the live POST-approve
attempted directly against the real `fixtures/golden` during this same verification returned `405`
and `git status`/`levare validate` confirmed no mutation. That is the point of building the guarantee
into `serve()` itself rather than into "remember not to."

# NOTES — uncertainties and assumptions (Phase 5)

Phase-5 delivers the Orchestrator (§7) against a mocked SDK boundary, plus three inherited debts:
ruling C7 (board/Runner gate-resolution convergence), E4 (real member invocation replacing the
`doRequest` stub reuse), and E5 (the `start` verb). These entries record the mechanical choices made
closing each.

## F1. Ruling C7 closed: `src/gates.ts` + `src/git.ts` are the shared implementation
The gap C7 named was never "the board and the Runner call different functions for approve/reject" —
`applyApproval`/`bumpVersion` were already shared as of phase 4. The real gap was ruling C2's
loop-companion rule ("on any loop-gate resolution the round's companion review resolves to approved"),
which only existed inside the Runner's in-memory `runLoop`. `gates.ts#loopMembershipFor` is the one
definition of "is this artifact kind one half of a team's loop, and who is its companion" — resolving
step labels to kinds via the same `kindMatches` capability lookup the Runner's `resolveStep` uses, so
board and Runner can never drift on which artifact is the companion. `board/gateops.ts`'s
`resolveGate` now applies it ahead of every approve/reject/request, patching the live companion into
the SAME commit as the primary resolution (tests/gateops-phase5.test.ts asserts one commit, not two).
`responsibleTeamFor` and `resolveStep` (gates.ts) are deliberately NOT extracted from `runner.ts`'s
private methods of the same name — that would require `runner.ts` to import from `gates.ts` while
`gates.ts` already imports `RunnerError`/`kindMatches` FROM `runner.ts`, a circular dependency. Instead
`gates.ts` holds its own copy of the (small, ~10-line) selection algorithm, commented as mirroring
`runner.ts`'s private one; the two are pure lookups over the same repo shape, not the stateful gate-
resolution logic C7 actually asked to converge. `src/git.ts#conductorCommit` was also extracted (board's
gate-approve commit and the registry-edit commit were near-identical hand-rolled `git` invocations) so
"commit as the Conductor" — identity, non-interactive-safe flags, everything — is one function every
write path (gates, registry, Orchestrator operations) now calls.

## F2. Ruling E4 closed: `doRequest` (and the new `doStart`) drive the real MemberRunner boundary
`board/gateops.ts` no longer imports `fixtures/stubs/member-stub.ts`'s `render()` directly. It builds
a `MemberRunner` via `stubAdapterRunner` (already exported from `replay.ts` for exactly this reuse) —
the same `AdapterRunner` phase-3 wired up and `levare replay` drives: real context assembly, real env
scoping, a real normalized usage receipt, behind the still-mocked native/CLI boundaries (invariant 10
holds — no SDK dependency was added). `doRequest`'s capability check now reads `memberRunner
.capabilities()` instead of the stub's exported constant, and `doStart` (below) uses the identical
boundary. The board's `ResolveOpts.memberRunner` is injectable, matching the rest of the codebase's
"deterministic core is injectable" pattern (NOTES Phase-2 Learnings).

## F3. Ruling E5 closed, scoped narrowly: `start` runs the flow's first step, not the whole walk
"Kicking off a team's flow" from a synchronous HTTP handler cannot mean "run the Runner's full
in-memory walk to completion" — that would silently fast-forward through every later `gate: human`
without a Conductor decision, violating invariant 1 more than a 501 ever did. Read literally, §6's
model is that a flow "halts the walk" at every declared gate; the honest single-request analogue is:
execute exactly the flow's first node as one member invocation, write the produced artifact to disk,
stop. That new artifact sits at `in-review`, which `openGates` (board/derive.ts) already renders as an
ordinary gate on the next read — no bespoke "this gate came from a start" bookkeeping needed, because
files are the truth (invariant 2) and the walk's next declared gate falls straight out of what's on
disk. **Scope boundary, documented rather than silently handled:** if a team's flow does not open with
a plain `step` (e.g. it opens with a `loop`, or the project is `pace: step` and would need a pace nod
first), `doStart` returns `501` with an explicit reason rather than guessing — no fixture exercises
either shape yet (kestrel's flow opens `step: brief` under `pace: auto`), so building untested branches
for them would trade one honest gap for a silent one. `unmetAfter` (gates.ts) re-checks the after:
condition before starting (409 if unmet) so the route can't be tricked into starting an unmet unit by
calling it directly, bypassing the UI's own gate.

## F4. The Orchestrator's mocked SDK boundary is a small documented pattern grammar, not free NLU
Per this phase's directive, the SDK stays behind `OrchestratorBoundary` (`interpret`/`narrate`) exactly
as `adapters.ts`'s `NativeBoundary` mocks the native SDK call — invariant 10 holds, nothing new enters
`package.json`. Unlike the adapter boundary (which always has *some* future real backend), the
Orchestrator's default `deterministicBoundary` is presented as the real phase-5 implementation of the
mechanical dispatch: a documented regex grammar (`approve <id>`, `capture idea: name | pitch | tags`,
`open <type> unit <unit> in <project>`, `promote idea <idea> to <project> [as <unit>]`, `stats`) covers
every operation this phase's acceptance criteria name. Free-form natural-language understanding is
explicitly out of scope this phase (that's the real SDK's job, later); what's under test is that the
*dispatch* — briefing derivation, one gate-resolution path, proposal-not-write semantics, unit-op repo
changes — is correct regardless of how the intent was extracted. `boundary` is an injected parameter of
`handle()`, so a real SDK-backed boundary drops in later without touching any of this dispatch logic.

## F5. Proposals hold no state; the caller (the conversation) carries them
§7: "the Orchestrator holds no state; everything it knows is re-derived from the repo and the
conversation." A `Proposal` (retro → LEARNINGS append, research report → knowledge promotion) is
therefore a plain returned value, never written anywhere on `proposeRetro`/`proposeKnowledgePromotion`
— it becomes a write only when `resolveProposal(root, proposal, "approve", by)` is called with that
same object back. In a real chat session "the conversation" is where that proposal value lives between
turns (the transcript, or whatever the SDK session keeps); tests hold it in a local variable across two
calls, which is the same shape. `reject` is a true no-op (no file touched at all) — the proposal is
simply discarded, matching "propose, never apply."

## F6. new-project skill: a real `git clone` against a scratch bare repo, never `gh`/real GitHub
`runNewProjectSkill` never shells out to `gh`; the caller (tests, or eventually the Orchestrator's own
Q&A flow) is responsible for having already produced a remote — a plain `git init --bare` scratch
directory stands in for what `gh repo create` would hand back. Everything past that point is real, not
mocked: an actual `git clone` of that scratch remote, a real initial commit in the resulting checkout,
then the `projects/<name>.md` pointer written into the studio repo, validated with the same validator
as every other write path, and committed as the Conductor. No push back to the scratch remote is
attempted — §7 lists "create, clone, write pointer, ask deploy target + house rules, commit" and a push
isn't among them; adding one would be an untested, unrequested extra write.

## F7. Golden fixture: `cart-icon-fix` (shipped) + `loyalty-flow` (`after:`) — a start gate to exercise
Phase 5 asked for a golden-fixture unit with a satisfied `after:` so E5's `start` verb has real
coverage, not just a synthetic-repo test. A start gate requires *some* other unit to be `shipped`
(NOTES A6 — "queued" is derived, never persisted; `after:` is only ever checked against `status:
shipped`), so two units were added, not one: `cart-icon-fix` (type `fix`, `status: shipped`, no
artifacts — it exists purely to be a satisfied prerequisite) and `loyalty-flow` (type `feature`,
`after: [cart-icon-fix]`, `status: active`), both under the existing `storefront` project so no new
project/team fixture surface was needed. **Consequence, handled rather than avoided:** both `levare
replay` and any `Runner.run()` against `fixtures/golden` walk *every* unit, not just `checkout-flow` —
so `loyalty-flow`'s now-satisfied start gate is raised during the golden/exhaustion replay scenarios
and every `loadRepo("fixtures/golden")`-backed test in `tests/runner.test.ts`. Each affected script was
extended with one trailing `{ expect: "start", verb: "notyet" }` decision (walk order is
alphabetical by `project/unit`, so `loyalty-flow` always sorts after `checkout-flow` and before nothing
else) — `notyet` was chosen deliberately over `start` so replay's scope stays exactly what its own
oracle (`expected.json`, scoped to `checkout-flow`) describes; `loyalty-flow`'s own flow is exercised
directly by `tests/gateops-phase5.test.ts` (part f) instead, against the board's `start` route.
`src/board/render.ts`'s `renderProject`/registry-summon template code assumed every open gate carries
an `.artifact` (true before this phase, when only artifact-shaped gates existed in the fixture); fixed
to key off `OpenGate.target` (already the right value for both artifact and start gates) instead of
`gate.artifact!.id`, which crashed both `renderProject` and the project-screen test the moment a real
start gate existed to render.

## Learnings
A pure-derivation test (buildBriefing, computeStats, loopMembershipFor) is worth writing against a
tiny synthetic repo even when a real-fixture version also exists: the synthetic one can assert an
*ordering* property (oldest-first) that the golden fixture's single open gate can never exercise on
its own, because there's nothing to sort.
"Converge on one implementation" (C7) does not always mean "delete the duplicate and call the other
copy" — sometimes the two callers have genuinely different execution shapes (an in-memory simulated
walk vs. a single on-disk mutation) and the honest convergence is extracting the *rule* they must both
obey (here, `loopMembershipFor`) into one place both call, while leaving each caller's own control flow
intact.

## Known gaps

**G1 — no `.snode` rule for the failed/rejected score-node state.** `assets/styles.css` defines
`.snode.done`, `.snode.active`, `.snode.blocked`, `.snode.upcoming`, and `.snode.is-gate-open` — every
canonical-palette state (design brief: done/active/waiting/blocked/needs-you) except **failed**. A
rejected artifact's score node (`render.ts#scoreNodeClass` still emits `"snode is-danger"`, its
pre-existing value) therefore renders invisible on screen — the same class of bug just fixed for the
waiting/queued state, left unfixed here because the fix is a stylesheet rule, and the stylesheet is
frozen/design-approved; the renderer cannot paper over a missing CSS rule by picking a different
existing class the way it could for "waiting" (which mapped to `.snode.upcoming`, an *existing*
correct-but-unused rule). **Fix in the phase-6 design pass**: add the missing `.snode` red/failed rule
to `assets/styles.css` (design decision — exact value should read `--danger`, matching every other
failed-state usage in the stylesheet). Once that rule exists, extend
`tests/board-render.test.ts`'s renderer↔stylesheet class-parity suite (currently five cases, done/
active/waiting/blocked/needs-you) with a sixth `{ label: "failed", state: "rejected", isGate: false }`
case, so the same test that would have caught G1's sibling bug catches this one closing too.

**G1 closed in phase 6** — see phase-6 section below.

# NOTES — uncertainties and assumptions (Phase 6)

Phase-6 delivers onboarding and distribution: `levare init`, the `levare serve` first-run
experience, and closing gap G1. These entries record where the goal's prose left a mechanical
choice and the highest-confidence reading taken.

## G1 (closed). `.snode.is-danger` added to assets/styles.css
`.snode.is-danger{ background:var(--danger); }` added right beside `.snode.done` — a filled circle,
red instead of green, exactly mirroring the design brief's "done = solid green ... failed = red"
parallel treatment (no border, no animation; shape stays a plain dot, only fill color differs).
`--danger` and the `is-danger` naming convention were already used identically for every other
failed-state element in the frozen stylesheet (`.verb.is-danger`, `.status-dot.is-danger`, the
resolved-line `.decision.is-danger`), so this is the one place the goal explicitly permitted new
CSS: matching an existing convention, not inventing one. `render.ts#scoreNodeClass` needed no
change — it already emitted `"snode is-danger"`; the class was simply undefined until now.
`tests/board-render.test.ts`'s class-parity suite gained the sixth case exactly as G1 prescribed.

## H1. What "genericizing the golden fixture" actually meant
Re-reading `fixtures/golden/` closely: its **registry** entities — `teams/kestrel.md`,
`agents/{wren,lyra,finch}.md`, `skills/{flow-design,spec-writing,new-project}.md`, the five
`types/*.md`, `connectors/{github,linear}.md`, `knowledge/*.md`, and `projects/studio.md` — never
mentioned "storefront" in the first place; they're already generic pitch-to-spec vocabulary (a
product framer, a flow designer, a wrapped reviewer). Only four things in golden are actually
demo-specific: `projects/storefront.md` (a real-looking `acme/storefront` repo pointer),
`work/storefront/*` (the checkout-flow/cart-icon-fix/loyalty-flow units and their artifacts),
`ideas/loyalty-program.md`, and `evals/checkout-flow.md`. So "genericized … into an editable
starting studio" is implemented as: reuse the registry entities above near-verbatim (embedded as
literal templates in `src/init.ts`, not read from `fixtures/golden/` at runtime — see H2), and drop
the four demo-specific items entirely, per the explicit "no demo work units" instruction. `evals/`
itself is dropped from the scaffold too: the goal's own directory list ("teams/ agents/ skills/
knowledge/ types/ connectors/ projects/ work/ ideas/") omits it, even though PRD §3's repo-layout
diagram lists `evals/` alongside the others — the phase-6 goal's explicit enumeration is treated as
authoritative for what `init` scaffolds, not the PRD's more general layout sketch.

## H2. Templates are embedded string literals, not copied from fixtures/golden/ at runtime
`src/init.ts` does not read `fixtures/golden/` off disk during `init` — every template is a literal
string in the module. Rationale: PRD §3's stated end state is `bun build --compile` to a single
portable binary; a user who only has that compiled binary (no adjacent source tree, no
`fixtures/golden/`) must still be able to run `levare init`. Reading golden at runtime would work
today (dev mode runs via `bun ./levare`, same as how `assets/styles.css`/`app.js` are currently
served by path, per `ASSET_DIR` in `board/serve.ts`) but would silently break the moment the binary
ships without its source tree — a portability regression with no test to catch it until someone
actually tried a bare binary. Embedding costs one copy of the content living in two places
(`fixtures/golden/` as the phase 1–5 test fixture, `src/init.ts` as the phase-6 shipped template) —
an acceptable, explicit duplication given the two serve genuinely different purposes and audiences.

## H3. No `teams/<name>.learnings.md` scaffolded
Golden's `teams/kestrel.learnings.md` records fictional retrospective knowledge ("guest checkout is
the recurring ambiguity…") — necessarily demo-flavored, since real LEARNINGS only exist after a team
has actually run. A freshly-scaffolded studio has never run anything, so the honest starting state
is *no* learnings file at all (`repo.ts#toTeam` already handles a missing learnings file gracefully,
falling back to `""`) rather than a fabricated one. Same principle as "no demo work units," applied
one level down.

## H4. `wren.md`'s `skills: [product-brief]` is a carried-forward pre-existing gap, not introduced here
Golden's own `agents/wren.md` declares `skills: [product-brief]`, but no `skills/product-brief.md`
(or `skills/product-brief/SKILL.md`) exists anywhere in golden — the validator doesn't check that a
`skills:`/`knowledge:` name resolves to an actual file (only `consumes`/`supersedes` and artifact
`files:` get existence checks), so this has always silently passed `levare validate`. The scaffold
reuses `wren.md` verbatim (H1), so the same dangling reference is carried forward rather than
quietly "fixed" — fixing it would mean inventing new content not asked for for a file already
established as a faithful reuse of golden. Noted here rather than silently left for a future
Conductor to puzzle over.

## H5. The Agent Skills format sample skill, and why it isn't wired into an agent's `skills:` list
"A skill following the Agent Skills format" is read as: a folder carrying its own `SKILL.md` (plus
optional supporting files), the convention Claude Code's own Agent Skills feature uses — as opposed
to golden's flat `skills/<name>.md` convention. `skills/new-project/SKILL.md` (+
`scripts/create-repo.sh`, a stub) is the natural candidate: golden's `new-project.md` already
declared a `scripts:` field pointing at a script that never actually existed on disk, i.e. it was
already halfway describing a skill bundle, just in the wrong shape. Converting it is safe because
`runNewProjectSkill` (`src/orchestrator.ts`) never reads the skill file at all — the new-project flow
is implemented directly in code; the file is registry-only documentation — so nothing breaks by
moving it. It is deliberately **not** added to any scaffolded agent's `skills:` list: no agent in the
example team performs the new-project flow (that's an Orchestrator-level operation, not a team
member's job), so there's no natural referrer, and inventing one would be scope creep. Made the
reference path actually work regardless (`context.ts#readEntityBody` and `board/extra.ts#loadDir` now
fall back from `<dir>/<name>.md` to `<dir>/<name>/SKILL.md`) so a future agent that *does* reference
a folder-format skill gets real context content instead of an invisible registry entry or a silent
"(not found)" — a small, generically-scoped fix rather than a special case for this one skill.

## H6. `init` never overwrites; the "empty directory" requirement is enforced by the caller, not `init`
The goal's acceptance path always runs `init` against a freshly-made empty temp directory, so `init`
itself does not refuse a non-empty target — it writes only files that don't yet exist and leaves
everything else untouched (`ScaffoldResult.skipped`), the same "never clobber in-progress work"
posture as the rest of this codebase (NOTES E14, the read-only-fixtures guarantee). This makes
`levare init` safe to re-run against a studio a Conductor has already started editing — a second run
fills in only what's still missing (e.g. a directory added to the skeleton in a later levare
version) rather than being a one-shot command that becomes dangerous the moment it's run twice.

## H7. `levare serve` first-run heuristic: any one skeleton directory, not "fully valid studio"
`isStudioInitialized` (`src/board/onboarding.ts`) considers a root initialized the moment **any**
skeleton directory (`teams/ agents/ skills/ knowledge/ types/ connectors/ projects/ work/ ideas/`)
exists — not "has at least one team" or "passes `levare validate`". Rationale: a Conductor
hand-building a studio from scratch (not via `init`) might create `teams/` before `agents/`; that
partial studio should render its ordinary (mostly-empty) screens immediately, not linger on the
onboarding page until every directory exists. The onboarding page is specifically for "nothing has
been scaffolded at all yet," the literal first-run case the goal names — not a general
studio-health check (that's what `levare validate` is for). Applies to every repo-projecting screen
route (`/`, `/studio`, `/project/:name`, `/run/:project/:unit`, `/registry`) via a `page: true` flag
on those `RouteDef`s, checked once in the router's `fetch()` dispatcher ahead of every handler —
consistent with how the read-only write-route gate (NOTES E14) is structural rather than
per-handler. Assets (`/styles.css`, `/app.js`) and the SSE channel (`/events`) are untouched by the
gate since they carry no repo-derived content to be blank about. The write routes (`/gates/...`,
`/registry/...`, `/orchestrator/message`) are also left ungated here — out of scope for "explains
and suggests `levare init` rather than rendering blank screens," which is about GET screens; a POST
against an uninitialized repo simply fails its own existing validation/lookup path (e.g. "no such
project") with no onboarding-specific handling needed.

## Learnings
Reading a fixture closely before "genericizing" it is worth the time: the instinct was to invent new
team/agent names to make the scaffold "obviously not the demo," but golden's registry entities were
already fully generic — only its work/ tree and one project pointer were ever storefront-flavored.
Deleting the actual demo-specific parts and reusing the rest verbatim is both less work and a more
faithful reading of "genericized" than inventing parallel content that says the same thing in
different words.

## Two phase-6 gate fix-ups

### I1. Project status chip: a real derivation, not a hardcoded "running"
`projectStatusChip` (`src/board/render.ts`) replaces the old `projGates > 0 ? gate-chip : "running"`
with the three-way rule the gate asked for: an open-gate count always wins (needs the Conductor
regardless of anything else); with none, "active" when any unit is `status: active` **or**
`membersRunning > 0`; with neither, "idle". `membersRunning` is threaded as a parameter rather than
hardcoded 0 inline, so the call site (`renderStudio`) is the one place documenting *why* it's 0 today
(NOTES E2 — no live process registry yet) and the only place that will need to change once a real
one exists — the derivation itself doesn't. Reused the frozen stylesheet's existing-but-previously-
unused `.chip.is-blocked` rule for "idle" rather than adding new CSS (the goal's one permitted CSS
addition was G1's `.snode.is-danger`, already spent). `fixtures/golden/projects/studio.md` (zero
units, zero gates) is the empty-project case in the golden fixture itself — no synthetic repo needed
for the new render test.

### I2. `levare init`'s founding commit: the user's identity, not the Conductor's
`makeFoundingCommit` (`src/git.ts`) is deliberately a sibling of `conductorCommit`, not a reuse of
it: `conductorCommit`'s hardcoded `cas <cas@levare.local>` is *this dev repo's* fixture convention for
Conductor actions once a studio is running (ruling E6) — attributing a studio's very first commit,
made before any Conductor action has ever happened, to that fictional identity would misattribute
authorship for every real levare user. Instead it resolves `git config user.name`/`user.email` *at
the target* (so a per-repo override, if any, wins over global/system, exactly matching git's own
resolution order) and only commits if both resolve to non-empty strings — deliberately not falling
back to environment variables like `GIT_AUTHOR_NAME`, which `git config --get` doesn't consult
anyway, keeping "identity resolved" synonymous with "a human configured git on this machine," not an
artifact of how the calling process happened to be invoked.

**Idempotent by construction, not by a special case.** `git init` on an already-a-repo target is
itself a safe no-op (git's own behavior, not something `makeFoundingCommit` special-cases), and a
second call stages everything (`git add -A`) but checks `git diff --cached --quiet` before
committing — if a prior `init` already committed everything and nothing changed since, there's
nothing staged and the function reports `committed: false` without erroring. This is what makes
re-running `levare init` against an already-initialized studio safe: the scaffold step already never
overwrites (H6), and now the git step never manufactures a spurious empty commit either.

**No identity → loud, not silent.** If no identity resolves, `repoInitialized` is still `true` (the
repo exists, ready for a human to configure identity and commit into) but `committed` is `false`.
`runInitCmd` (cli.ts) checks this explicitly and prints `GIT_IDENTITY_NOTE` — one string, exported
from `src/init.ts` and interpolated into both the scaffolded `README.md`'s "Git" section and this
console fallback, so there is exactly one place explaining *why* this matters (immutability
fail-open + inert Conductor commits) rather than two texts that can drift apart. The note reads
correctly in both places because it's phrased conditionally ("if this studio has no commit yet...")
rather than assuming either outcome.

**Hermetic test env, once again.** `makeFoundingCommit(root, message, env)` takes an injectable `env`
(default `process.env`) precisely so tests can pin a resolvable identity (`GIT_CONFIG_GLOBAL` pointed
at a throwaway file with a `[user]` block) or an unresolvable one (`GIT_CONFIG_GLOBAL`/
`GIT_CONFIG_SYSTEM` at `/dev/null`, `HOME` redirected) without depending on whatever git identity
happens to be configured on the host running the suite — the same lesson NOTES A4/E12 already
recorded for the immutability and e2e-serve tests, applied here a third time.

# NOTES — uncertainties and assumptions (Phase 7)

Phase-7 delivers the SDK and the voice: `@anthropic-ai/claude-agent-sdk` as the sole runtime
dependency, a real SDK-driven `OrchestratorBoundary` whose system prompt is loaded from
`docs/orchestrator-prompt.md` verbatim, and a real SDK-driven `NativeBoundary`, with the phase-5
deterministic regex boundary demoted to the explicit offline fallback. These entries record the
mechanical choices the goal's prose left open, and the highest-confidence reading taken for each.

## K1. The SDK is inherently async; the boundary interfaces stay synchronous by a subprocess bridge,
not by threading async through the Runner

The goal's own steering message was explicit: "the SDK backs the two boundaries behind their
existing interfaces — the dispatch logic, gate resolution, and repo operations do not change; if you
find yourself editing orchestrator.ts's dispatch to accommodate the SDK, stop and reconsider the
boundary instead." `OrchestratorBoundary.interpret`/`narrate` (orchestrator.ts) and
`NativeBoundary.invoke` (adapters.ts) are both synchronous — and `handle()`, `AdapterRunner`, and the
entire Runner/board/gateops call chain that consumes them are written throughout as synchronous,
deterministic control flow (NOTES Phase-2 Learnings: "no clocks or randomness in the pass that
produces the oracle"). The real `@anthropic-ai/claude-agent-sdk`, confirmed from its own shipped
README (the `bun build --compile` section), is fundamentally asynchronous: `query()` is an async
generator that spawns and streams from a `claude` CLI subprocess over stdio — there is no synchronous
variant in the package.

**Resolution:** rather than make the boundary interfaces (and therefore `handle()`, `AdapterRunner`,
and every caller up through `Runner`, `replay.ts`, `board/gateops.ts`) asynchronous — a change with a
blast radius across the whole engine, touched by zero acceptance criteria, and squarely the kind of
"editing the dispatch to accommodate the SDK" the goal warned against — the real async `query()` call
is isolated inside its own standalone subprocess (`src/sdk-worker.ts`), spawned SYNCHRONOUSLY via
`Bun.spawnSync` from `src/sdk-transport.ts`. This is exactly the pattern `adapters.ts`'s
`CliSpawn`/`bunSpawn` already uses for the "cli" agent kind (itself synchronous over a real
subprocess) — phase 7 extends the same shape to the "native" (SDK) kind instead of inventing a new
one. Both boundary interfaces keep their exact phase-3/phase-5 shapes; only their real implementation
changed.

**This is also the literal "transport level" the goal's tests mock at.** `SdkTransport` (the
worker-spawning seam) is injectable exactly like `CliSpawn` — `tests/orchestrator-sdk.test.ts`,
`tests/native-sdk-boundary.test.ts`, and the boundary-selection tests all inject a fake `SdkTransport`
that never spawns the worker, so `bun test` never touches the network or needs `ANTHROPIC_API_KEY`.
The one test that does spawn the real worker (`tests/orchestrator-sdk-live.test.ts`) is gated by
`test.skipIf(!hasAnthropicCredentials())` and is the phase's required live smoke test.

## K2. `interpret()` uses the SDK's native `outputFormat: {type: "json_schema"}`, not prompt-engineered JSON

The shipped `sdk.d.ts` documents `Options.outputFormat: {type: 'json_schema', schema}`, which
constrains the model's structured output the same way the Messages API's `output_config.format`
does. `interpret()` passes a flat JSON Schema covering every field across all seven `Intent` kinds
(required: `kind` only) and reads `SDKResultSuccess.structured_output` — never asks the model to
hand-format JSON in prose, and never parses fenced code blocks. `coerceIntent`
(orchestrator-boundary.ts) then narrows the loosely-typed blob into exactly one `Intent` shape,
falling back to `{kind:"unknown", text}` on any structural mismatch (missing field, invalid verb
enum, non-object) — mirroring `adapters.ts#coerceUsage`'s "malformed input records a safe default,
never a crash or a fabricated field" posture. `narrate()` does not use structured output at all — it
sends the already-computed factual line as plain user-turn text under the verbatim system prompt and
returns the model's final text unmodified.

## K3. "Verbatim" system prompt applies to the string handed to the SDK, not to how the two behaviors split

`docs/orchestrator-prompt.md`'s own §"Intent to operations" already says the Orchestrator "translate[s]"
free text into operations "through your tools" — so using the SDK's tool/structured-output machinery
for `interpret()` is the mechanical realization of what the prompt already describes, not a
deviation from it. Both `interpret()` and `narrate()` load the file with the identical
`loadOrchestratorPromptSource()` and hand the resulting string to `Options.systemPrompt` completely
unedited — no prefix, no suffix, no per-call templating. What differs between the two calls is only
the *user-turn* content and `outputFormat` (a request-shape variance every conversation already has,
independent of the fixed system prompt) — never the prompt itself. A test
(`tests/orchestrator-sdk.test.ts`) asserts the transport receives the byte-identical file contents as
`systemPrompt` on both `interpret()` and `narrate()` calls.

## K4. Selection is presence-only, computed fresh per call, never logged

`selectOrchestratorBoundary(env)` (orchestrator-boundary.ts) mirrors `doctor.ts`'s `EnvProbe`
posture exactly: it reads only whether `ANTHROPIC_API_KEY` is a non-empty string, never the value.
`board/serve.ts`'s `/orchestrator/message` route calls it once per request (not once at server
startup) so that exporting a key mid-session takes effect on the very next message without a
restart — consistent with "the API key is read from the environment only, never written to any file,
never logged" from the goal's own constraint. `createSdkNativeBoundary`'s only read of the key's
*value* is to forward it into the spawned worker's environment (`sdk-transport.ts`'s `run(req, {env})`
call) so the SDK subprocess itself can authenticate; that value is never captured in a variable that
outlives the single `invoke()` call, never printed, and never appears in any commit this repo makes.

## K5. `NativeBoundary`'s real implementation is delivered but NOT wired as `AdapterRunner`'s/board's
default — a documented scope boundary, not a silent gap

The goal's acceptance ("Achieved when...") bullets are all about the Orchestrator boundary
(interpret round trip, boundary selection, prompt-from-disk) — none of them name `NativeBoundary`,
`AdapterRunner`, or the Runner engine. `createSdkNativeBoundary` (adapters.ts) is real, exported, and
covered by `tests/native-sdk-boundary.test.ts` (mocked transport) — it genuinely calls the model via
the same `sdk-transport.ts` seam, using `req.agent.model`, `req.tools` (the allowlist projection
`guardrails.ts#allowedTools` already computes), and `req.context` (the full §6-assembled recipe) as
the user-turn content. What it is deliberately **not** wired into is `replay.ts#stubAdapterRunner`
(the default `memberRunner` `board/gateops.ts#resolveGate` falls back to) or any other call site —
doing so would require branching every one of those call sites on API-key presence the same way
`selectOrchestratorBoundary` does for the Orchestrator, a change with its own test surface that no
acceptance criterion asks for and that risks a live `levare serve` silently making real, billed model
calls from existing phase-4/5/6 tests that assumed a deterministic stub. Wiring
`createSdkNativeBoundary` behind the same key-presence selection as the Orchestrator boundary is the
natural next step whenever a phase actually exercises live member invocation end to end.

## K6. Member tool-name vocabulary is passed through as-is; no SDK built-in tool-name mapping is invented

The golden fixture's own agent definitions declare `tools: [read, write]` (lowercase, levare's own
domain vocabulary — guardrails.ts's own doc comment calls `allowedTools()` "the pure projection of an
agent's declared `tools:`"), which does not match the SDK's actual built-in tool names (`Read`,
`Write`, `Edit`, `Bash`, `Glob`, `Grep`, ...). `createSdkNativeBoundary` passes `req.tools` straight
through to `Options.tools`/`Options.allowedTools` without attempting to invent a name-mapping shim —
this is the first phase to wire the SDK for real, so there is no established mapping convention to
follow, and levare's whole registry vocabulary is a fictional studio's own tool names, not literally
Claude Code's. Inventing a mapping is realistically a per-agent registry concern (a `sdkTool:` field
on `Agent`, or a fixed lowercase→PascalCase table) for whichever future phase actually drives a real
member invocation end to end (see K5) — noted here rather than silently guessed at.

## K7. The worker script's request/response contract, and its `env` handling

`sdk-worker.ts` reads one JSON request from stdin, makes exactly one `query()` call to completion
(collecting only `SDKResultMessage` — every intermediate `assistant`/`tool_use` message is ignored,
since neither `interpret()`/`narrate()` nor member production need mid-turn visibility), and prints
one JSON line to stdout. `permissionMode: "bypassPermissions"` +
`allowDangerouslySkipPermissions: true` are always set — the worker is spawned non-interactively
(inherits no TTY), so the SDK's ordinary human-approval prompt has nowhere to go; the tool allowlist
itself (empty for Orchestrator calls, `req.tools` for member calls) is what actually scopes what the
model can touch, exactly as `guardrails.ts#allowedTools` already documents for the mocked boundary.
`Options.env` was originally left unset in the worker's own `query()` call, reasoning that the OUTER
`Bun.spawnSync` (sdk-transport.ts) already scopes the worker subprocess's entire environment, so the
worker would simply inherit `process.env` as `query()`'s own documented default. The live-gate fix-up
below (K8) makes this explicit instead — spreading `process.env` into `Options.env` directly — to
remove any doubt that the credential actually reaches the SDK's own inner subprocess.

## K8. Live-gate fix-up: the worker never reached a model, and failed silently

**Symptom**, from a real run with `ANTHROPIC_API_KEY` exported and `claude` on `PATH`:
`tests/orchestrator-sdk-live.test.ts` failed in 72ms — far too fast for any real network round trip —
with `intent.kind === "unknown"` for the plain phrase "what needs me". Two separate defects, both
fixed here.

**Defect 1 — env forwarding was correct in principle but not defensive enough to trust blind.**
`createSdkOrchestratorBoundary`'s default (`opts.env ?? process.env`) and `bunSdkTransport`'s spawn
already passed the FULL launching environment through — not the member allowlist model — so the
mechanism was structurally right (see the env-trust-boundary note now at the top of
sdk-transport.ts). Three concrete hardenings were made regardless, since the live symptom (an
instant, unexplained failure) is exactly what any of these three would produce:
- `SDK_WORKER_PATH` used raw `URL.pathname` instead of `Bun.fileURLToPath` — the established pattern
  this repo already uses elsewhere (adapters.test.ts) for turning a `file://` module URL into a path
  to spawn. `.pathname` can carry percent-encoding a shell-less argv spawn will not decode; swapped.
- `sdk-worker.ts` now passes `Options.env: { ...process.env }` to `query()` EXPLICITLY rather than
  relying on the SDK's documented "omitted env inherits process.env" default — removes any doubt
  that the credential the outer spawn set actually reaches the SDK's own inner `claude` subprocess.
- `bunSdkTransport`'s spawn now filters any `undefined`-valued entries out of the env record before
  handing it to `Bun.spawnSync` (`definedEnv`, sdk-transport.ts) — `process.env`'s TS type permits
  `string | undefined` per key, and a literal `undefined` serialized into a child's environment block
  is exactly the kind of silent corruption this transport must not risk.

None of these three could be confirmed as *the* root cause without a live key (unavailable in this
sandbox), so all three were hardened rather than guessed at singly, and (Defect 2, below) the failure
path was made loud enough that whichever one — or none — was the actual cause is now immediately
diagnosable from the thrown error's message on the next live run.

**Defect 2 — the failure was silent, `unknown` impersonating a system error.** `interpret()`'s
`!res.ok` branch previously returned `{kind: "unknown", text}` — a perfectly legal `Intent` a real,
working model call could also produce — so a transport failure (bad path, missing credential, worker
crash, timeout, malformed JSON) was structurally indistinguishable from "the model answered and
genuinely didn't recognize the phrase". This is the same class of bug NOTES A4/A7 already killed
twice in `validate.ts`'s immutability check (an early-exit "valid" state silently absorbing a real
error) and `adapters.ts#coerceUsage` deliberately avoids for usage parsing.

**Fix.** `interpret()` now distinguishes the two failure modes explicitly:
- **Transport failure** (`res.ok === false` — the SDK call itself didn't complete) → `console.error`s
  the transport's own diagnostic text, then throws `OrchestratorSdkError` with that same text. This
  propagates as an uncaught exception to whatever called `interpret()`; `board/serve.ts`'s route
  dispatcher already wraps every handler in a catch-all that turns an uncaught throw into a `500`
  with the error message, so no change was needed there to make it surface loudly at the HTTP layer.
- **Structurally invalid model output** (`res.ok === true`, but `structured_output` doesn't parse
  into a known `Intent` shape) still degrades gracefully to `{kind: "unknown"}` via `coerceIntent` —
  this is NOT the same failure class: the call genuinely completed, and a schema-conforming-but-odd
  or borderline answer is a legitimate (if imperfect) classification, not a system error. This mirrors
  `coerceUsage`'s own "malformed input records a safe default, never a crash" posture — the dividing
  line is whether the SDK call itself succeeded, not whether its answer was the one hoped for.

`narrate()` deliberately keeps its graceful degrade (return the plain, unformatted computed fact) on
a transport failure rather than throwing — unlike `interpret()`'s `unknown`, that fallback does not
impersonate a *different, wrong* answer; it is the same true content, just unphrased. Throwing there
would turn every voice-layer hiccup into a hard failure of an otherwise-working briefing/reply, which
is a worse tradeoff than "the Orchestrator sounds a little flatter this once."

**New coverage.** `tests/orchestrator-sdk.test.ts` now asserts `interpret()` throws
`OrchestratorSdkError` (not `{kind:"unknown"}`) on a fake-transport failure, and — per the acceptance
criterion's own suggested repro — on a REAL transport (`createAsyncSdkTransport` as of K9 below)
pointed at a nonexistent worker path: a genuine, deterministic, network-free transport failure that
needs no `ANTHROPIC_API_KEY` and runs in milliseconds, exercising the exact `existsSync` guard a live
run would hit if the worker script were ever missing or unresolvable.

## K9. Live-gate fix-up: `Bun.spawnSync` inside the server froze the ENTIRE event loop, not just the
Orchestrator's own request

**Symptom**, from a real run with `ANTHROPIC_API_KEY` exported and `claude` on `PATH`: `levare serve`
accepted connections but never responded — `GET /` timed out AND `GET /styles.css` timed out (a plain
static-file read with no SDK, no repo derivation, no git at all). Nothing was being served, so the
block could not be inside the studio render path; it had to be the event loop itself.

**Root cause, confirmed.** `sdk-transport.ts`'s `bunSdkTransport` (as built in K1) spawned the SDK
worker via `Bun.spawnSync` — chosen specifically to keep `OrchestratorBoundary`'s interface
synchronous (see K1's own reasoning). That reasoning was right for a batch/CLI context (exactly what
`adapters.ts`'s `CliSpawn`/`bunSpawn` already does for the "cli" agent kind, safely, because nothing
in that path runs inside `Bun.serve`), and wrong the moment the same synchronous spawn sits on a live
server's request path: Bun's HTTP server runs on one JS thread, and a blocking `Bun.spawnSync` call
freezes that thread — and therefore every concurrent connection, not merely the one that triggered
it — for as long as the child process runs. If the spawned `claude` CLI ever hangs (stuck on auth, a
wedged subprocess, anything), the server is frozen permanently, not just slow.

**Fix.** `interpret()`/`narrate()` (and therefore the boundary interface itself, and `handle()`,
which calls them) are now genuinely asynchronous, and the transport underneath them is now
non-blocking:

- `sdk-transport.ts` now exports TWO transports sharing the same request/response shape and the same
  worker script: the original `SdkTransport`/`createBunSdkTransport`/`bunSdkTransport`
  (`Bun.spawnSync`-based) is kept, but scoped to `NativeBoundary` only (adapters.ts) — which is not
  reachable from any live `levare serve` request path today (K5), so the blocking spawn there is
  inert until some future phase wires live member invocation into the board. A NEW
  `AsyncSdkTransport`/`createAsyncSdkTransport`/`asyncSdkTransport` (`Bun.spawn` + `await`, an
  explicit `setTimeout`-based kill for the timeout — `Bun.spawn`'s own `exitedDueToTimeout` signal
  was not observed to be populated for async spawn in this Bun version, unlike `spawnSync`) is what
  `OrchestratorBoundary` now uses exclusively.
- `OrchestratorBoundary.interpret`/`narrate` (orchestrator.ts) now return `Promise<Intent>` /
  `Promise<string>`. `deterministicBoundary`'s implementations became trivially `async` (no I/O of
  their own; wrapping them costs nothing and keeps both boundaries satisfying one interface).
  `handle()` is now `async function handle(...): Promise<HandleResult>` — **this is the one place the
  goal's "do not touch the dispatch" constraint had to bend, and only by the minimum needed**: every
  line of the switch statement, every repo operation it calls, and the order everything happens in is
  byte-for-byte unchanged from the prior synchronous version; the only diff is `await` in front of
  each `boundary.interpret(...)`/`boundary.narrate(...)` call. `board/serve.ts`'s
  `/orchestrator/message` handler (already an `async` route handler) now `await`s `handle(...)`.
- `createBoard()` gained an optional `orchestratorBoundary` field (mirroring the existing
  `ResolveOpts.memberRunner` testability pattern in `board/gateops.ts`) so tests can inject a
  controllable boundary and prove the actual acceptance property end to end — a slow
  `/orchestrator/message` call must never delay a concurrent, unrelated `board.fetch()`.

**Why `NativeBoundary`/`AdapterRunner`/the Runner engine were NOT touched.** The same argument that
scoped K5 applies here with more force now that the actual failure mode is understood: the reported
bug is specifically "a blocking spawn on a live server's request path," and `NativeBoundary` sits on
no such path (K5) — `board/gateops.ts`'s default `memberRunner` is still `stubAdapterRunner`, which
does no real subprocess spawn at all. Making `MemberRunner.produce()` async to match would cascade
through `Runner`, `replay.ts`, `board/gateops.ts`, and every test that calls `.produce(...)`
synchronously (`adapters.test.ts` alone has ~18 such call sites) for a code path that cannot currently
freeze anything live. If/when a future phase wires `createSdkNativeBoundary` into a reachable request
path, that same blocking-spawn class of bug becomes live there too, and the fix is the identical
pattern already proven here: swap `Bun.spawnSync` for `Bun.spawn` + `await` at that boundary,
following K9's `AsyncSdkTransport` as the template — not a reason to asyncify the whole engine today.

**New coverage.**
- `tests/orchestrator-sdk.test.ts`: a real (non-fake) `createAsyncSdkTransport` pointed at a tiny temp
  worker script that sleeps ~250ms then responds proves an unrelated concurrent timer still fires at
  ~10ms — the event loop was never blocked waiting on the spawn. A second real-transport test points
  at a worker that never resolves at all and asserts it is killed and returns an explicit timeout
  error well inside the configured `timeoutMs`, not left pending indefinitely.
- `tests/board-serve-nonblocking.test.ts`: the actual acceptance property, end to end, through
  `board.fetch()` (the same in-process router every other board test drives — NOTES E12 Learnings): a
  deliberately slow (but real-async, `setTimeout`-backed) `OrchestratorBoundary` is injected via
  `createBoard`'s new `orchestratorBoundary` option; a `POST /orchestrator/message` with a 300ms delay
  is fired, and concurrently a `GET /` and `GET /styles.css` are fired — both resolve in well under
  the 300ms the orchestrator call is still pending, proving the exact regression (a blocked event
  loop delaying totally unrelated routes) cannot recur.

## K10. Live-gate note (not a bug): the native CLI binary is a per-platform optional dependency

Host live-gate testing hit `Native CLI binary for darwin-arm64 not found` — the SDK's actual `claude`
executable ships as one of several platform-specific optional packages
(`@anthropic-ai/claude-agent-sdk-{linux,darwin,win32}-{x64,arm64}[-musl]`), and only the one matching
the machine running `bun install` gets pulled into `node_modules`. If `node_modules` was populated on
a different machine/platform than the one running `levare serve` (a copied or stale install), the SDK
correctly reports the binary missing for the *running* platform — reinstalling on the actual host
resolves it. **Reproduced directly in this dev sandbox during this same fix-up**: an early `bun add`
earlier in phase 7 left `node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64` installed despite
`process.platform`/`process.arch` reporting `linux`/`arm64` the whole time — a `rm -rf node_modules &&
bun install` on THIS sandbox self-corrected to `claude-agent-sdk-linux-arm64`(`-musl`), with zero
`bun.lock` diff (the checked-in lockfile lists every optional platform package; only install time
decides which one lands on disk, so the lockfile itself was never wrong). Not a levare bug and not
something the code can detect or work around — documented in README.md's new Phase 7 section as an
operational note: install on the platform that will actually run `levare serve`.

## K11. Live-gate fix-up: `/orchestrator/message` must degrade to offline mode, never 500

**Finding.** K8 made `interpret()` throw loudly (`OrchestratorSdkError`) rather than silently
returning `{kind:"unknown"}` on a transport failure — correct, and still true. But nothing downstream
of `interpret()` caught that throw: it propagated out of `handle()`, out of the route handler, into
`board/serve.ts`'s router-level catch-all, which turns any uncaught exception into a `500`. A real run
with a broken SDK boundary (missing binary — see K10 — or any other transport failure) made
`POST /orchestrator/message` return `500` instead of degrading, and `tests/board-serve.test.ts`'s
existing orchestrator test (which never pins `ANTHROPIC_API_KEY` and so is only hermetic against an
environment where the var happens to be absent) failed the moment it ran with a real key exported in
the host's shell.

**The distinction that resolves this.** Loud failure belongs *inside* `interpret()` — a transport
error must never impersonate a real intent (K8's own reasoning stands). But the board itself is a
projection of files (invariant 2); the Orchestrator's SDK voice is an enhancement layered on top of
that projection, not a dependency the WRITE SURFACE can fail on. The right place to catch the SDK's
loud failure is therefore one layer up, at the one route that calls the boundary — not by softening
`interpret()` back toward silence.

**Fix.** `board/serve.ts`'s `/orchestrator/message` handler now wraps its `await orchestratorHandle(...)`
call in a `try`/`catch`. This is safe to catch broadly (not narrowed to `OrchestratorSdkError`
specifically) because every OTHER operation `handle()`'s dispatch can call
(`resolveGate`/`openUnit`/`captureIdea`/`promoteIdea`) already reports its own failures as a
`GateOpResult` value, never a throw (an established pattern since phase 4) — the *only* thing that can
escape `handle()` as an exception is a boundary call, so a catch at this one seam is precise, not a
speculative safety net. On catch: `console.error`s the reason (the transport's own diagnostic text,
never a credential value), re-runs `handle()` against `deterministicBoundary` (the same offline
boundary phase 7 already uses when no key is present at all) to get a genuine answer, and returns
`200` with a reply prefixed `"SDK unavailable (<reason>); answering in offline mode. "` — visible,
honest, and still functionally useful (a `stats`/`briefing` question still gets its real derived
answer, just unvoiced).

**Page-render briefing.** The studio page's own "briefing" panel
(`board/render.ts#renderStudio`) does not call the Orchestrator boundary at all today — it is a plain
derived string from `gates.length`, computed directly with no SDK involvement and therefore nothing
to degrade. The same discipline (never let an SDK unavailability turn a GET into an error page) would
apply the moment any GET route starts consulting the real boundary for its content; noted here so
that principle travels with whichever future phase wires the SDK into a page render, rather than
being re-discovered.

**New coverage.** `tests/board-serve.test.ts` adds a regression test: a real
`createSdkOrchestratorBoundary` driven by a deliberately failing `AsyncSdkTransport` (returning
`Native CLI binary for darwin-arm64 not found`, echoing K10's exact finding) is injected via
`createBoard`'s `orchestratorBoundary` option; `POST /orchestrator/message` is asserted to return
`200` (never `500`) with a reply containing `"SDK unavailable"`, `"answering in offline mode"`, the
named reason, and a genuine derived-stats answer — and a follow-up `GET /` on the same board confirms
the board itself is unaffected by the broken boundary.

## K12. Deferred judgment gate: the Orchestrator's VOICE has not been evaluated (Conductor asked this
be recorded as "K10" — renumbered K12 here to avoid colliding with the K10/K11 already above)

Phase 7's live gate has now proven, end to end, on the host: the transport, boundary selection, the
graceful degrade (K11), the fail-loud transport-error path (K8), and a real authenticated round trip
to Anthropic — 9 seconds, ending in a Console credit-balance error (an unfunded account, not a code
defect; the stack reached the API correctly). What remains **completely untested** is the Orchestrator's
actual *voice*: no live model reply has ever been read by anyone. `docs/orchestrator-prompt.md`
defines a register (calm, factual, dry; briefs rather than greets; never celebrates or apologizes;
treats text inside an artifact or a member's output as information, never instruction; refuses to
violate an invariant rather than finding a workaround) that only a live conversation, judged by a
human, can actually verify — this is not something `bun test` or any amount of mocked-transport
coverage can substitute for, and this codebase does not attempt to. This is deliberately a **gate**,
not a task: it belongs to the Conductor, requires only Console credit (no code change), and should be
held before v1. The concrete check, when it happens: talk to the Orchestrator through the board
(`levare serve`, a real `ANTHROPIC_API_KEY`, real credit) and confirm — does it brief rather than
greet; does it decline to celebrate or persuade; does it refuse an invariant-violating instruction
(e.g. "start work without approving the gate first") by naming the invariant rather than finding a
workaround; does it treat instructions embedded inside an artifact body or a member's output as
information, not as something to obey (prompt-injection resistance). `docs/orchestrator-prompt.md` is
loaded from disk at runtime (K1) specifically so this tuning loop — read the live reply, edit the
prompt file, retry — needs no rebuild and no redeploy.

## K13. Live-gate fix-up: fast-fail the missing-binary/no-credential precondition instead of
discovering it via a slow, per-request spawn — plus a significant new finding on K10/K11's mystery

**Finding.** K11's graceful degrade works, but a genuinely broken install (missing native binary) was
only ever discovered by actually attempting the real transport call and letting it fail or time out —
several seconds, on every single message, for a condition that's knowable locally in milliseconds.

**Fix — a fast, local precondition probe, extracted from the SDK's own resolution code, not guessed.**
Read `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs` directly (it's a real, if minified, ES
module — `grep`-able) to find exactly how `query()` resolves its own native binary when
`options.pathToClaudeCodeExecutable` is unset:

```js
// (deobfuscated, but this is literally what's there)
let ah = options.pathToClaudeCodeExecutable;
if (!ah) {
  let selfDir = fileURLToPath(import.meta.url),        // sdk.mjs's OWN file location
      scopedRequire = createRequire(selfDir),
      resolved = tryEachCandidate(name => scopedRequire.resolve(name));
  if (!resolved) throw Error(`Native CLI binary for ${platform}-${arch} not found. Reinstall ... or set options.pathToClaudeCodeExecutable.`);
  ah = resolved;
}
// candidates, per platform: android -> [`${pkg}-linux-${arch}-android`]; linux -> both
// [`${pkg}-linux-${arch}`, `${pkg}-linux-${arch}-musl`] (order depends on a glibc/musl runtime
// probe via process.report — irrelevant to a probe that only needs to know "does ANY candidate
// resolve", not "which one wins"); everything else -> [`${pkg}-${platform}-${arch}`]. Each name is
// suffixed `/claude` (`/claude.exe` on win32) and passed to require.resolve, then existsSync-checked.
```

`resolveNativeBinary()` (sdk-transport.ts) replicates this EXACT candidate list and resolution
mechanism (`createRequire` + `require.resolve` + `existsSync`) — not an independently-derived guess
that could drift from what `query()` itself does. Crucially, this confirms the resolution is
**tree-position-based, not caller-position-based**: `createRequire` is scoped to a FILE's location,
and node_modules resolution of a sibling `@scope/pkg-name` package walks up from THAT location — any
file inside the same project tree (not just `sdk.mjs` itself) resolves the identical answer. This is
why `resolveNativeBinary()` can run scoped from `sdk-transport.ts`'s own `import.meta.url` rather than
needing to reach into the SDK's internals.

`checkSdkPreconditions(env, opts)` checks the two LOCAL, zero-network preconditions — credential
presence (`hasAnthropicCredentials`, already existing) and binary resolvability — and
`checkSdkPreconditionsCached` wraps it with a 30s TTL cache plus a "log only on transition into
unavailability" diagnostic (a genuine one-time note, not a repeating warning every re-check).
`selectOrchestratorBoundary` now calls the cached check before ever constructing the real SDK
boundary: on failure, it returns `deterministicBoundary` directly — **no transport is ever touched**,
proven by a test that injects a transport recording whether it was called and asserting it wasn't.
`board/serve.ts` gained a matching test-only seam (`BoardCtx.orchestratorSelectOpts` /
`createBoard`'s `orchestratorSelectOpts` option) so a test can drive the REAL selection path (not a
hand-rolled boundary) with a simulated broken precondition, end to end through `board.fetch()` —
`tests/orchestrator-sdk.test.ts`'s final test is the acceptance criterion itself: `POST
/orchestrator/message` with a broken precondition returns `200` in well under a second (observed
~140ms including Bun's own test-runner startup, not the several-second timeout it would have taken
via K11's old catch-and-degrade-after-attempting path).

**Also pinned `cwd: LEVARE_ROOT` on both worker spawns** (`createBunSdkTransport` and
`createAsyncSdkTransport`), addressing the Conductor's explicit hypothesis ("resolution runs relative
to a different cwd/worker location"). The investigation above shows the SDK's OWN resolution is
provably NOT cwd-dependent (it's anchored to `sdk.mjs`'s fixed file path, not `process.cwd()`), so
this isn't expected to be *the* fix for the reported divergence — but it removes cwd as a variable
entirely (the worker now always resolves modules from a well-defined location, `<repo>`, regardless of
what directory `levare serve <studio-path>` happens to have been launched from), at zero risk.

**A more likely explanation for the reported divergence, discovered by accident during this fix.**
While building and testing `resolveNativeBinary()` against this sandbox's own `node_modules`, the
platform-binary package installed **spontaneously changed out from under the running session, twice,
with no explicit reinstall action taken in between** — `ls node_modules/@anthropic-ai/` showed
`claude-agent-sdk-linux-arm64` (correct for this `linux`/`arm64` sandbox) at one point, then later
showed `claude-agent-sdk-darwin-arm64` (wrong) instead, with `bun.lock` unchanged throughout (`git
status bun.lock` stayed clean) and `bun.lock`'s own `os`/`cpu` fields correctly listing `linux`/`arm64`
for the linux package the whole time. A second `rm -rf node_modules && bun install` restored the
correct package. **This strongly suggests the "two different resolution paths" the Conductor observed
(live smoke test reaching Anthropic; the server route reporting the binary missing, in the same tree)
may not be a divergence in levare's OWN code at all** — both call sites use the identical
`createSdkOrchestratorBoundary` → `AsyncSdkTransport` → `sdk-worker.ts` path; there is only one
resolution mechanism in this codebase, not two. It looks far more likely that Bun's own
optional-dependency installation is non-deterministic or flaky in this class of environment (a
containerized/virtualized dev environment, matching both this sandbox and the reported darwin host),
and the live smoke test simply ran while the correct binary happened to be present, with the platform
package having reverted (or never having stably persisted) by the time the server route was tested
moments later — entirely outside levare's control or ability to detect from application code. This
doesn't change the guidance already given (K10): `bun install` on the platform that will run `levare
serve`, and if a fresh install still doesn't stick, that now looks like a Bun/environment reliability
question worth raising upstream, not a levare resolution bug to keep chasing.

**New coverage.** `tests/orchestrator-sdk.test.ts`: `resolveNativeBinary` against the real,
currently-installed platform (ground truth, not mocked) and against a bogus platform/an empty scratch
`requireFrom`; `checkSdkPreconditions`'s three outcomes (no credential / unresolvable binary /
viable); `checkSdkPreconditionsCached`'s TTL behavior (a stale cached "not viable" wins within the
window even when the underlying params would now resolve differently; a fresh check runs past the
TTL); `selectOrchestratorBoundary`'s fast-fail (transport never invoked) and fast-pass (transport
reached) paths; and the end-to-end acceptance test through `board.fetch()`. The module-level
precondition cache is a singleton shared across the whole `bun test` process (all files run in one
process), so every test in this file resets it in `beforeEach` — the exact kind of cross-test
pollution that surfaced the spontaneous-binary-swap finding above in the first place, when an
unrelated earlier test's cached "not viable" result leaked into this file's own "viable" assertion.

## K14. Live-gate fix-up: stop trusting the SDK's own implicit binary resolution for the REAL call —
resolve explicitly, once, and pass it in

**Finding.** On the host, with the darwin-arm64 platform package genuinely present as a sibling
`node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64` package (not a `vendor/` subdirectory), the
transport still reported "Native CLI binary for darwin-arm64 not found." K13's fast precondition
probe was doing exactly its job — correctly reporting what it found — but what it found disagreed with
reality on that host. This is a genuinely different, more serious problem than K13 itself: it means
`resolveNativeBinary()`'s `require.resolve`-based mechanism (which K13 asserted mirrors the SDK's own
internal resolution exactly, extracted from the shipped `sdk.mjs`) can disagree with what's actually
on disk, on at least one host/Bun-version/environment combination.

**Root cause not fully pinned down, but the fix doesn't require pinning it down.** Rather than
continuing to chase why `require.resolve` (in either our probe or the SDK's own identical-looking
internal call) fails to find a package that's genuinely there, the correct structural fix — precisely
what the Conductor's own message pointed at — is to stop relying on ANY implicit resolution for the
REAL invocation at all. The SDK's `Options.pathToClaudeCodeExecutable` field exists exactly for this:
"Path to the Claude Code executable. Uses the built-in executable if not specified." When set, the
SDK's own internal `require.resolve` loop never runs — our explicitly-resolved path is used directly.

**Fix.** `createSdkOrchestratorBoundary` (orchestrator-boundary.ts) now calls `resolveNativeBinary()`
ONCE at boundary-construction time and includes the result as `pathToClaudeCodeExecutable` on
*every* `SdkWorkerRequest` it builds (both `interpret()` and `narrate()`) — the worker
(`sdk-worker.ts`) passes it straight through to `query()`'s own `options.pathToClaudeCodeExecutable`.
`selectOrchestratorBoundary` goes one step further: it reuses the EXACT `binaryPath` its own
precondition probe (K13) just resolved (`checkSdkPreconditionsCached` now surfaces `binaryPath` on a
viable result), rather than letting `createSdkOrchestratorBoundary` re-resolve independently — so "the
probe says viable" and "the real call uses that binary" are provably the same value, not merely the
same algorithm run twice. `createSdkNativeBoundary` (adapters.ts) received the identical fix for
consistency, even though it isn't wired into any live path yet (K5) — the same class of bug would
apply the moment it is.

**Why this closes the "two different resolution paths" question regardless of root cause.** Before
this fix, there were, in principle, two `require.resolve` call sites that were SUPPOSED to agree
(K13's probe, and the SDK's own internal lookup inside the spawned worker) but had no structural
guarantee of doing so — they were two separate calls, in two separate processes, at two different
moments, and (per this finding) they evidently CAN disagree on some hosts. After this fix there is
only ONE resolution call in the entire flow that matters for a real request: `resolveNativeBinary()`,
called once, whose result is carried by value into the worker and handed to `query()` directly. The
SDK's own internal resolution logic never executes at all when `pathToClaudeCodeExecutable` is set —
it is not a second opinion that could disagree, it is simply not consulted. If our own single
resolution is ever wrong, the SDK will report `pathToClaudeCodeExecutable` as unusable and that error
is exactly as diagnosable as the "not found" error was, but it can no longer disagree with a probe
that already said "viable" — the fast-fail path and the real invocation are now, by construction, one
codepath, not two.

**New coverage.** `tests/orchestrator-sdk.test.ts`: `createSdkOrchestratorBoundary` resolves once and
sends the identical `pathToClaudeCodeExecutable` on both `interpret()` and `narrate()`; when the
platform package is genuinely installed (skipped otherwise, via a plain `existsSync`-style probe
independent of the function under test), the exact resolved path matches `resolveNativeBinary()`'s own
return value; an explicit override wins over resolution; and `selectOrchestratorBoundary` is asserted
to reuse the SAME `binaryPath` its own precondition check produced, not a second independent
resolution. Also added the acceptance criterion's own explicit ask: a `test.skipIf` ground-truth test
that resolves the real, currently-installed platform binary on whatever host runs the suite, skipping
cleanly (not failing) when the optional platform package is absent.

## K15. Live-gate fix-up: the CLI hung on the operator's own config, and the timeout-kill didn't reach
the resulting dangling process

**Finding.** With K14's binary resolution fixed, a real call no longer failed fast — it hung for the
full 60s of the live test's own outer timeout, and Bun reported "killed 1 dangling process" on exit.
Standalone (`claude -p "say ok" --output-format json`), the CLI itself returned in 2.2s — the hang was
specific to our spawned worker.

**Root cause, confirmed on the host.** The worker's spawned CLI inherited the OPERATOR's personal
Claude Code configuration, including a user-installed SessionEnd hook (a "claude-mem" plugin spawning
`node`). In a TTY-less spawned subprocess that hook never actually completed, so the CLI's own process
never exited — even though the model had already answered and been billed. This is the identical
lesson NOTES A4/E12 already recorded for git subprocesses (pin config explicitly, never inherit the
host's ambient state) — the same discipline just hadn't yet been applied to the CLI subprocess.

**Fix — hermetic spawn.** Two SDK options close this off, both confirmed directly in the shipped
`sdk.d.ts` (not guessed):
- `settingSources: []` — the SDK's own documented "SDK isolation mode": loads NO filesystem settings
  (`~/.claude/settings.json` user, `.claude/settings.json` project, `.claude/settings.local.json`
  local) at all. A hook defined in any of those has nothing to fire from — it's never even registered,
  not merely disabled after the fact.
- `persistSession: false` — no session transcript is written to `~/.claude/projects/` either.
- `CLAUDE_CONFIG_DIR` (an env var, not an SDK option) — `sdk-transport.ts`'s `hermeticSpawnEnv()`
  redirects it to a levare-controlled scratch directory (`join(tmpdir(), "levare-sdk-config")`)
  whenever the caller hasn't already set one explicitly, so nothing this spawn does can read from or
  write into the operator's real `~/.claude` profile, belt-and-suspenders on top of the two options
  above. `sdk-worker.ts`'s `query()`-options construction is now factored into an exported, pure
  `buildQueryOptions()` function specifically so a test can assert the exact hermetic configuration
  without spawning a real subprocess.

**Fix — kill the whole process tree, not just the direct child.** `proc.kill()` (both the async
`Subprocess.kill()` method and `Bun.spawnSync`'s own `timeout`+`killSignal` handling) only ever signals
the DIRECT child — the worker. It was empirically verified (not assumed) that neither reaches
grandchildren: a reproduction spawning a worker that itself spawns a grandchild which ignores plain
SIGTERM showed the grandchild surviving `Bun.spawnSync`'s own `timeout`+`killSignal: "SIGKILL"`+
`detached: true` combination — Bun's internal timeout-kill still only reached the immediate child. The
fix that DID work, verified the same way: spawn with `detached: true` (the worker becomes the leader
of its OWN new process group — its PID becomes the group ID), then on timeout call
`process.kill(-pid, "SIGKILL")` — the NEGATIVE pid, which signals the ENTIRE group at once. Confirmed
zero dangling processes afterward, for both the async transport (via the existing `setTimeout`
timer, now calling `killProcessTree()` instead of `proc.kill()`) and the sync transport (via a
post-hoc group-kill after `Bun.spawnSync` reports `exitedDueToTimeout`, since a blocking synchronous
call cannot run an independent timer of its own to react mid-flight).

**Fix — the transport's own timeout must be shorter than any caller's.** The prior defaults inverted
this: the transport's internal timeout (120s) was LONGER than the live test's own outer timeout (60s),
so the test's own limit fired first and the transport's timeout-kill never got a chance to run at all —
"killed 1 dangling process" was Bun's OWN cleanup catching what the transport should have caught
itself. Reduced `sdk-transport.ts`'s `DEFAULT_TIMEOUT_MS` to 60s and `createSdkOrchestratorBoundary`'s
own default to 45s (a chat reply is conversational, not a long-running task — a real successful call
took ~9s), and correspondingly RAISED the live smoke test's own outer timeout to 90s, so the internal
45s timeout has room to fire (and be observed) well before any outer limit would.

**New coverage.** `tests/sdk-transport-hermetic.test.ts`: `buildQueryOptions()` is asserted to set
`settingSources: []` and `persistSession: false` (and to still pass every other request field through
unchanged); `hermeticSpawnEnv()` is asserted to fill in the isolated `CLAUDE_CONFIG_DIR` by default and
to never override one the caller already set. The literal acceptance test: a worker script that spawns
a grandchild which ignores SIGTERM (reproducing the confirmed live shape) and then itself also hangs
forever — `createAsyncSdkTransport.run()` against it returns the timeout error within its own
`timeoutMs` (not the caller's much longer one), and polling `process.kill(pid, 0)` (an existence-only
check) confirms the grandchild — captured by its own self-written PID file — is genuinely gone
afterward, not merely orphaned.

## K16. Live-gate fix-up: default to a cheap model, and record the SDK's own real usage/cost

**Finding.** A live, successful call (once K14/K15 were fixed) spent $0.055 on a two-word "stats"
reply. `createSdkOrchestratorBoundary`'s default model was `claude-opus-4-8` for EVERY call, including
`interpret()`'s trivial structured-output intent classification — Opus, on every message, is far more
than that job needs.

**Fix — cheaper default, configurable.** `DEFAULT_MODEL` is now `claude-sonnet-5` — dramatically
cheaper and faster than Opus, while still producing prose quality appropriate for `narrate()`'s
user-facing voice (K12's deferred voice-judgment gate is about REGISTER, not raw model tier — Sonnet
is a reasonable balance the Conductor can override). `LEVARE_ORCHESTRATOR_MODEL` (an environment
variable) overrides it. **This is a deliberate, scoped interim mechanism, not the final design**: the
goal's own language ("a studio-level setting") points at a REGISTRY field — something living in the
repo's own files (`projects/studio.md` or a dedicated studio-settings entity), consistent with
invariant 2 ("the binary holds no state that cannot be reconstructed by re-reading the repo"). Building
that properly means a new schema field, validator support, and deciding where in the registry it
belongs — real design work, not a live-gate fix. The env var is the fastest way to make the cost
problem immediately fixable and testable today; migrating it to a real registry field is a natural,
explicitly-deferred follow-up (same discipline as K5's NativeBoundary-wiring deferral).

**The native member boundary already did this correctly — verified, not assumed.** `createSdkNativeBoundary`
(adapters.ts) has passed `model: req.agent.model` since K1 — the model an `agents/*.md` file declares
in its own frontmatter, never a hardcoded default. `fixtures/golden/agents/{wren,lyra}.md` and
`src/init.ts`'s scaffold templates both already declare `model: claude-sonnet`, not Opus. No code
change was needed here; this is recorded so the verification itself — not just the fix elsewhere — is
on the record.

**Fix — record the SDK's own reported usage/cost, never estimate (§10).** `SdkWorkerResponse` gained
an optional `receipt?: Receipt` field, reusing the EXISTING `Receipt` type (`types.ts`) rather than
inventing a parallel shape. `sdk-worker.ts` builds it directly from the `SDKResultSuccess` message's
own `modelUsage` (a per-model breakdown of `inputTokens`/`outputTokens`), `total_cost_usd`, and
`duration_ms` — the SDK's own ground truth, never a guess. `createSdkOrchestratorBoundary` logs it
(`levare: Orchestrator {interpret|narrate}() usage — <model> · <tokens> · <usd>`) after every
successful call, so a Conductor running `levare serve` can see real per-message cost directly.

**Deliberately NOT wired into the §10 ledger in this fix-up.** `AdapterRunner.produce()`'s existing
cost-tracking is scoped around MEMBER production — an artifact with a `usage:` frontmatter block, or a
`ledger.ndjson` entry keyed to a unit. An Orchestrator chat message has no natural unit/artifact home
to attach a ledger entry to (a "stats" question may not reference any unit at all), and `NativeBoundary
.invoke(req): {doc: string}`'s interface has no `receipt` field to extend without touching every
existing mocked test that implements it. Given `createSdkNativeBoundary` is still not wired into any
live path (K5), full ledger integration for both boundaries is left as a documented, deliberate
follow-up rather than a partial, silently-incomplete one — visibility (the log line) ships now; full
persistence is a design decision for whichever phase actually wires live member invocation in.

## K17. Live-gate fix-up: the regex grammar was intercepting dispatch, a forced-guess answered the
wrong question, the composer looked dead mid-call, and a silent no-reply traced to two real bugs

**Finding 1 — BLOCKING: free-form messages never reached the model.** A live run with the real SDK
boundary selected showed every free-form Conductor message ("what's the story with the loyalty
flow?", "should I approve the spec?", "start it") answered with the deterministic boundary's canned
line (`Noted: "<text>". Nothing changes state until you act on a gate.`) — even though the real
boundary was selected and correctly classified these as `unknown`. Root cause: `handle()`'s
`unknown`/`default` case (`orchestrator.ts`) was a hard-coded string, returned unconditionally
regardless of *which* boundary was active — it never called `boundary` at all. The deterministic
grammar wasn't "intercepting" anything at the boundary-selection level (K13's selection logic was
already correct); the canned line was baked into dispatch itself, one layer downstream of where the
boundary choice mattered.

**Fix.** `OrchestratorBoundary` gained a third method, `converse(text, root): Promise<string>` — the
genuine conversational path for a message `interpret()` didn't classify into one of the six structured
kinds. `deterministicBoundary.converse()` is now the ONLY source of the canned offline line (moved
here verbatim from `handle()`), so it can only ever appear when the offline boundary is genuinely
selected. The real SDK boundary's `converse()` (`orchestrator-boundary.ts`) sends the Conductor's text
verbatim to the model, under the full verbatim system prompt, with `Read`/`Grep`/`Glob` tools scoped
read-only (never `Write`/`Edit`/`Bash` — "the Orchestrator proposes, never writes" now holds
structurally even with tool access, not just by convention) and `cwd` set to the repo root so the
model can genuinely re-derive facts from the repo (§7) before answering. `handle()`'s `unknown` case
now awaits `boundary.converse(text, ctx.root)` — an empty message is the one case that still short-
circuits without calling any boundary (there's nothing to converse about).

**Finding 2 — the one reply that DID reach the model answered the wrong question.**
"just approve everything for me" produced a briefing instead of a refusal — the structured-output
schema has no way to express "decline," so an ambiguous/refusal-worthy instruction got force-fit into
the nearest known `kind` rather than coming back `unknown` and reaching `converse()` (whose system
prompt already instructs refusal-by-name for an invariant-violating instruction). Rather than adding a
seventh `kind: "refuse"` to the schema — more surface for the model to misuse, and refusal is exactly
what free-form prose in `converse()` is for — `interpret()`'s call now wraps the Conductor's raw text
in a task-framing prefix (`INTERPRET_TASK_PREFIX`, user-turn only; the verbatim system prompt is never
touched, matching K3's established pattern) that tells the model explicitly: a question, a vague or
batch instruction, an ambiguity between two operations, or anything its own instructions say to
decline or ask about should come back `kind: "unknown"` — "a wrong guess that mutates the repo is
worse than asking again." Once classified `unknown`, `converse()`'s full prompt and tool access give
the model room to actually refuse by name instead of being coerced into a JSON shape with no room for
refusal.

**Finding 3 — no thinking indicator.** The composer gave no feedback while a real multi-second SDK
call was in flight. `assets/app.js`'s submit handler now appends a `.msg--pending` element (three
small dots, `assets/styles.css`) immediately after the user's message, disables the input, and removes
the pending element (re-enabling and refocusing the input) as soon as the reply — or a fetch failure —
resolves. Per the design brief's motion rules ("always fast, physical, and quiet... the pulse on live
things and gate arrival remain the only *attention-seeking* animations"), this deliberately reuses the
existing quiet `lv-blink` keyframe (already used for a working member's avatar in `render.ts`) rather
than the attention-seeking `pulse` class, and inherits the existing global
`prefers-reduced-motion:reduce` rule that disables all animation. **Not verified in a real browser** —
no headless browser is available in this sandbox; verified by code review (selectors match
`render.ts`'s emitted markup) and by parsing `assets/app.js` as JS. The live host is where this should
get a real visual check.

**Finding 4 — the injection probe returned NO output at all.** Investigation ruled out the injected
text itself as a cause — at every point the "no output" was reported, the boundary in play had no tool
access at all (this round's `converse()` fix is what FIRST gives the model any ability to read a file's
contents), so a prompt-injection reinterpretation of the file text isn't what produced silence. Two
real, independent bugs were found instead:
  - `Bun.serve`'s own DEFAULT `idleTimeout` is 10 seconds; a real SDK round trip routinely exceeds
    that. `serve()` (`board/serve.ts`) now pins `idleTimeout` explicitly (180s, overridable via a
    test-only `idleTimeoutSeconds` option) — comfortably past every internal SDK timeout (90s, see
    `converseTimeoutMs`) so OUR OWN timeouts fire first. **This is defense in depth, not the actual
    guarantee**: empirically, in this Bun version (1.3.14), a POST request that carries a body — the
    shape of every real `/orchestrator/message` call — was observed to bypass Bun's idle-timeout
    enforcement entirely, even well past the configured value (GET/bodyless requests trip it
    reliably; see `tests/board-serve-idletimeout.test.ts` for the characterization). The actual
    guarantee that "a request must always produce a reply" is what was already built in an earlier
    round: the SDK transport's own `setTimeout`-based kill (`sdk-transport.ts`, proven end to end by
    `tests/sdk-transport-hermetic.test.ts`'s hung-worker tests, which assert the timeout fires AND the
    whole process tree is reaped) plus K11's route-level catch-and-degrade-to-offline, both
    method/body-agnostic since they live below the HTTP layer entirely.
  - `serve()` bound `hostname: "0.0.0.0"` (correctly, for container port-forwarding) but then handed
    that same literal string back as the connect URL (`http://0.0.0.0:<port>` — printed by the CLI's
    `levare serve` startup message, and exactly what a user would paste into a browser). Connecting to
    the literal address `"0.0.0.0"` is OS/resolver-dependent and was observed, while chasing the
    idleTimeout fix above, to sometimes bypass Bun's idle-timeout enforcement in a DIFFERENT way than
    the POST-body case. `serve()` now always returns `http://localhost:<port>` as the connect URL —
    the socket still binds `0.0.0.0`, only the address handed to callers changed.

**New coverage.** `tests/orchestrator.test.ts` §(b2): a real-SDK-style mock boundary's `unknown`
intent is answered by its own `converse()` (never the canned line); the deterministic boundary still
produces the canned line for the same input; an empty message never calls `converse()` at all.
`tests/orchestrator-sdk.test.ts`: the task-framing prefix's exact refusal-safety language reaches the
transport while the system prompt stays untouched; `converse()`'s tool scoping (`Read`/`Grep`/`Glob`
only), verbatim prompt pass-through, own timeout, and throw-not-fabricate-on-failure behavior.
`tests/board-serve-idletimeout.test.ts`: `idleTimeoutSeconds` reaches `Bun.serve` and a slow request
still completes normally through the real socket; `serve()` never returns the literal `0.0.0.0` URL.

## Learnings

A boundary that must front a fundamentally different concurrency model than its own interface (a
synchronous call standing in for an inherently async subprocess-and-stream SDK) doesn't have to force
that model up through every caller — isolating the async work in its own subprocess and blocking on
it with the same `Bun.spawnSync` primitive the codebase already uses for CLI members keeps the
existing engine's synchronous-and-deterministic invariant intact, and keeps the new real
implementation's own test surface exactly as small (inject a fake transport) as the mocked
implementation's was.
Reading a package's own shipped `.d.ts`/README before writing against it beats trusting a general
knowledge prior of a similarly-named API — the Agent SDK's `query()` shape, its subprocess
architecture, and its `outputFormat: json_schema` structured-output support were all confirmed from
`node_modules/@anthropic-ai/claude-agent-sdk/{sdk.d.ts,README.md}` directly, not assumed.
A hand-rolled test double for an interface (`OrchestratorBoundary`, `AsyncSdkTransport`, etc.) that's
missing a newly-added method doesn't fail loudly — it throws `TypeError: x.method is not a function`,
which an existing broad catch-and-degrade path (K11) can silently absorb, making the test pass via the
WRONG code path instead of failing. Adding a method to an interface used by multiple hand-rolled test
doubles across the suite means auditing every implementer, not just the production boundaries — a
green suite after an interface change is not proof every double still exercises what it was written to
exercise.
An HTTP server's own connection-level timeout (Bun's `idleTimeout`, here) is not a substitute for an
application-level timeout on the actual slow operation — empirically, Bun's idle-timeout enforcement
did not reliably fire for a request carrying a body, which is the shape of virtually all real POST
traffic. The layer that can actually guarantee "this operation gives up after N seconds" is the one
directly wrapping the slow call itself (the SDK transport's own `setTimeout`), not a generic HTTP
server setting one layer removed from it — the HTTP-layer timeout is worth setting correctly anyway
(defense in depth, and it does work for GET/bodyless requests), but it should never be the ONLY thing
relied on to make that guarantee.
"0.0.0.0" is a bind wildcard, not a connectable address — handing it back as "the URL" (whether printed
to a user or returned from a `serve()`-style function) works by OS/resolver accident on some systems
and not others; always translate a wildcard bind hostname to `localhost` (or a real interface address)
before it reaches any caller that might actually connect to it.
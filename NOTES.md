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
**UPDATE (architecture & code review, 2026-07-12): CLOSED — see the review section at the end of this
file.** Gate resolution now records the approval baseline commit in the artifact's `approved_commit`
frontmatter and `validate` diffs the content against that ref (excluding the approval-stamp fields);
committed post-approval mutation is state S2c → `MODIFIED_AFTER_APPROVAL`. The former `test.failing` is
a real prevention test. The rest of this entry is the original deferral record.

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
**UPDATE (architecture & code review, 2026-07-12): CLOSED per ruling C4 — see the review section at the
end of this file.** The per-unit heuristic is superseded by `gates.ts#responsibleTeamsFor`, a per-kind
walk that hands a unit from a shaping team to a build team; a multi-team fixture (`tests/multiteam.test.ts`,
verified to fail under the old single-team walk) covers the divergence. The rest of this entry is the
original deferral record.

A unit's flow is run by the team whose `produces` overlaps the unit type's `expects` most (ties broken by
name). For the golden fixture this is unambiguously `kestrel`. When multiple shaping/build teams exist per
type, this heuristic will need revisiting against how the walk hands a unit between teams (e.g. shaping →
build). Deferred until a fixture exercises more than one producing team.

## Rulings (Conductor)

Rulings issued at the phase-2 gate. Unlike the assumptions above (which record the highest-confidence
reading of ambiguous prose), these are binding decisions — cite them, don't re-derive them.

**PRD amendment 1 (`docs/prd-amendment-1.md`, 2026-07-12) is folded into `docs/levare-prd.md` v1.1:**
invariant 1 restated in its strict C8 form; invariant 6 marked SPECIFIED, NOT IMPLEMENTED (the merge
phase does not exist); invariant 7's `mode: led` escape hatch cut; the §4 artifact contract gains
`approved_commit` (closes A7); and **ruling C3 is extended** (see C3 below). The amendment doc is the
historical record of *why* each change was made; the PRD now reads correctly standing alone.

C1 — Two legal loop styles. A loop whose until references artifact approval (e.g. spec.approved) is the conductor-amendment style: one Conductor gate per round, as kestrel's flow does. A loop may instead terminate on a member-set frontmatter field (e.g. review.verdict == approved, written by the reviewing member), with the human gate following the loop — the autonomous style. Invariant 4 is untouched: artifact status approved remains Conductor-only; a verdict field is member data, never a status. Phase-3 adapters must support both styles.

C2 — Gate-resolution completeness. No gate resolution may leave its artifact at in-review: approve → approved, reject → rejected, request-changes → superseded by the successor round's artifact. On any loop-gate resolution, including the exhaust gate, the round's companion review artifact resolves to approved (the Conductor accepted it as read). An artifact at in-review always means exactly one thing: an open gate awaiting the Conductor.

C3 — Budget acknowledgment memory. A continue at a budget gate acknowledges the current spend; the gate re-raises only when spend crosses a new threshold beyond the acknowledged amount. A raise updates the effective budget. Budget gates inform, they never spam. **Extended (PRD amendment 1, §5): a budget gate also HALTS the unit — the unattended daemon included — until the Conductor resolves it, exactly as every other gate halts the walk; it stops spend, it does not merely report it. `continue`/`raise`/`stop` retain the meanings above; budgets are per-unit, never global.** This settles the daemon-budget divergence the code review flagged as needing a ruling.

C4 — Responsible-team selection (B7) is a fixture-scale shortcut, not the semantics. PRD §6's walk is per-kind: find producible kinds whose consumes are all approved, and invoke the team that produces each kind — this is how a unit hands from a shaping team to a build team. The per-unit heuristic is equivalent while fixtures contain one team; the divergence must be closed when a multi-team fixture lands.

C5 — approved_by always carries the Conductor's name plus ISO date. No defaults, no placeholders; provenance is never fabricated.

C6 — Branches and file paths are different guardrail namespaces. A team's `protected_branches` match only a change's branch ref (exactly); `protected_paths` match only a change's file path (exact or `dir/` prefix). Neither is ever matched against the other, and there is no path-segment matcher — `main` as a protected branch never trips on a file path like `src/main/app.ts`, and `deploy/` as a protected path never trips on a branch. The old combined `protected_paths: [main, deploy/]` shape is retired; `teams/*.md` declare the two lists separately.

C7 — One gate-resolution path. Board gate ops (src/board/gateops.ts) and Runner gate resolution (src/runner.ts) must converge on a single implementation before v1. A Conductor's approve means the same thing regardless of which surface received the click; ruling C2 (companion-artifact resolution on loop gates) applies to both. The phase-4 split — the board performing the direct §4 operation while the Runner drives the walk engine — is a scaffolding artifact, not the semantics. Close it in phase 5, when live member invocation enters the server process; that same convergence retires E4's stub-reuse in doRequest and E5's 501 on the `start` verb.

C8 — EVERY work unit's first flow step raises a start gate, regardless of type, regardless of `after:`. There is no auto-start path. `after:` remains exactly what it always was — a condition that must be satisfied before the start gate is RAISED — never a licence to begin work once satisfied or absent. This is a Conductor ruling on a security-audit finding (`docs/security-audit.md`, Surface 5/1, HIGH), not an engineering judgment call: the audit demonstrated that a hand-written or injected `unit.md` with no `after:` caused the daemon to invoke a real member (`Daemon.tick()`, no gate, no click) — an unattended, real-money invocation with no Conductor approval anywhere in its causal chain, a direct violation of invariant 1 (§2). Combined with the CSRF hole closed in the same audit (Surface 6, now fixed), this was one step from remote unattended spend: a foreign web page or a merged PR touching `work/` could have reached a live subprocess with zero human decision in between. **Supersedes NOTES O3**, which took the deliberately loose reading ("the Conductor authoring/committing `unit.md` is itself the causal-chain intent") and flagged itself explicitly as "the single most debatable call in this phase" — re-read here as a demonstrated invariant-1 violation, not a defensible interpretation. Fixed structurally in `src/dagwalk.ts` (`advanceUnit`'s `startAuthorized` check now fires for every unit with no artifacts yet, not only ones with `after:`), `src/runner.ts` (`walkUnit` raises the `start` gate unconditionally at flow position zero, `after:` unmet still makes a unit invisible first), and `src/board/derive.ts` (`openGates` renders a start-gate card for any no-artifact active unit). `tests/security-audit.test.ts`'s xfail for this surface now passes as a real prevention test (renamed, `test.failing` → `test`); `tests/daemon.test.ts` case (b) is rewritten into two tests — a no-`after:` unit raises a start gate and is never auto-started, and once the Conductor resolves it the daemon advances the unit normally on later ticks, with no further authorization needed for subsequent steps. `src/replay.ts`'s golden/exhaustion scripts gained a leading `{ expect: "start", verb: "start" }` decision for `checkout-flow` (which has no `after:`); `fixtures/golden/expected.json` needed no change — the extra gate doesn't alter final artifact statuses, only the transcript.

C9 — How a member receives consumed artifacts (§6 recipe item 7) is a per-agent declaration, not a
studio-wide constant, because the agent — not levare — knows what filesystem it can actually reach.
`Agent.context_artifacts?: "paths" | "inline"` (`types.ts`/`repo.ts`/`validate.ts`), defaulting to
`"paths"` when absent: unchanged behaviour, root-relative paths only, for a member with filesystem
access to the studio (every pre-C9 agent definition, including the golden fixture's lyra/wren/finch).
`"inline"`: `context.ts#assembleContext`'s section 7 carries the full text — frontmatter and body,
byte-identical to the file on disk — of every consumed (currently-approved) artifact, each delimited
by its own `── consumed artifact: <id> (<path>) ──` / `── end consumed artifact: <id> ──` pair, for a
member that cannot open a path back into the studio at all — the closing half of D2's "paths only,
never contents" rule, which stands as the *default*, not as an absolute.

**This is a definition error, not a runtime surprise.** An agent whose declared `cwd` resolves to a
location outside the studio root (a literal, non-templated path — a `cwd` still holding an unresolved
`{…}` template resolves only at spawn time, per NOTES D9, and is not statically checkable, so it is
skipped rather than guessed at) but has NOT declared `context_artifacts: inline` can never open the
path §6 item 7 would otherwise hand it: `validate.ts#validateAgentContextScope` (wired into
`validatePath` alongside `validateStudioBindings`, same "only meaningful for a whole tree" gate)
rejects it with `CWD_OUTSIDE_STUDIO_NO_INLINE`, naming the agent, its literal `cwd`, and citing "ruling
C9" in the message itself — the same "name what cannot bind, don't discover it live" posture C8 and
F1 already established for other structural failures.

**Closes D6** — the real Gemini member (`rook`, `command: ["gemini", "-p", "{task}", ...]`, the same
member NOTES F3/F7 debugged live) was handed
`work/studio/credential-scoping/question-credential-scoping-v1.md` while running from `/tmp` with no
studio access; it would have had to guess the question. `fixtures/golden/agents/rook.md` is the
fixture form of that exact member: `kind: cli`, `cwd: "/tmp"`, `context_artifacts: inline` — it
validates precisely because it declares the mode its isolation requires. It is deliberately NOT a
member of any team's roster (a standalone fixture demonstrating the schema/validator pair, not a new
walkable unit) — `repoCapabilities`/board-registry tests that enumerate the golden fixture's agents
were updated for its presence (`tests/binding.test.ts`, `tests/board-render.test.ts`), but nothing
about the checkout-flow replay oracle changes, since replay only ever walks `storefront/checkout-flow`
(NOTES `UNIT_KEY`) and rook binds to no flow step. `fixtures/rejections/cwd-outside-studio-no-inline/`
is the negative twin: the same `cwd: "/tmp"`, no `context_artifacts` declared — `CWD_OUTSIDE_STUDIO_NO_INLINE`.

**Tests.** `tests/context.test.ts` ("ruling C9" describe block) asserts `paths` (default and explicit)
renders only paths, `inline` renders full frontmatter+body for both consumed artifacts (the exact
"saved-card fallback"/"abandoned at that wall" body text D2's own test asserts ABSENT in paths mode),
and the recipe's line-2 delivery-mode label tracks the mode actually in use.
`tests/validate.test.ts` ("ruling C9" describe block) exercises the rejection fixture (naming the
agent/cwd/ruling), a positive inline+outside-cwd case, the unresolved-template skip (against finch's
own `{feature_repo}` cwd in the golden fixture), and the golden fixture's own rook. New
`tests/cli-context-artifacts.test.ts` proves — against a REAL, unmocked `cat` subprocess, not an
internal flag — that `levare context finch --unit checkout-flow --dry-run` matches
`AdapterRunner.produce`'s real spawned member byte-for-byte in all three cases (`paths`, `inline`, and
the field entirely absent), mirroring F7's own dry-run/live parity proof for the new delivery-mode
axis. `bun test` — 446 pass, 1 pre-existing skip, 0 fail, across 40 files; `levare replay
fixtures/golden --stubs` — still byte-for-byte against `expected.json`; `deps:check` — `deps ok`.

C10 — The Orchestrator holds NO filesystem tools; it is handed a derived projection of the studio
instead. `converse()`'s prior `Read`/`Grep`/`Glob` grant (NOTES phase-7 K17) was found live to let the
model wander into levare's OWN source tree — `sdk-transport.ts` always spawns the SDK worker process
with `cwd: LEVARE_ROOT` (K13, needed so the worker script resolves its own node_modules), so a
tool-driven model's relative-path reads resolved against the WORKER's process cwd, not the `cwd: root`
value the SDK request carried; the wiring (which studio root was threaded through) was correct all
along — the bug was that the Orchestrator had search tools at all. See the full write-up at the end of
this file for the fix, the tests, and what this closes on `docs/security-audit.md` Surface 1.

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

## E2 (retired in phase 8 — see O7). No live process registry — "Members running" is always 0
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

## F3 (retired in phase 8 — see O1/O9). Ruling E5 closed, scoped narrowly: `start` runs the flow's first step, not the whole walk
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

**Update (security audit, `docs/security-audit.md`) — two BLOCKING PREREQUISITES for closing this
deferral, not ordinary notes.** The audit found both latent (Medium) because K5 keeps the native
boundary out of every reachable call site — but they arm the moment it is wired in, so whichever future
phase closes K5 must resolve both *before* that phase can be called done, not as follow-up hardening:

1. **The native SDK member boundary does not apply the connector allowlist (Surface 3).** Member env is
   supposed to be a strict allowlist (`buildMemberEnv`, invariant 11, D5) — but `createSdkNativeBoundary`
   drives members through `sdk-transport.ts`'s `hermeticSpawnEnv()`, which spreads the **full launching
   `process.env`** into the worker, not `buildMemberEnv`. The moment K5 is closed, a native SDK member
   would inherit the Orchestrator's `ANTHROPIC_API_KEY` and every other ambient secret, bypassing the
   allowlist entirely. **Prerequisite:** route native/CLI member spawns through `buildMemberEnv`, not
   `process.env`, before any live path can reach `createSdkNativeBoundary`.
2. **A vendored agent definition can self-grant tools and connectors with no enforcement (Surface 8).**
   The vendoring ritual is a human "read it, commit it, stamp provenance" process with no code-level
   check: a hostile/careless agent definition can grant itself a connector via its own `connectors:`
   field (unioned with the team's grants), and `createSdkNativeBoundary` passes a definition's declared
   `tools:` straight through to `Options.tools`/`allowedTools` (K6) with no bound — a vendored agent
   declaring `tools: [Bash]` gets shell. **Prerequisite:** validate a vendored agent's declared tools
   against a permitted set, and prevent a definition from self-granting a connector the Conductor didn't
   explicitly intend, before K5's boundary is wired into any live path.

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

# NOTES — uncertainties and assumptions (Phase 7.5)

Phase-7.5 is a polish pass against the Conductor's own design-fidelity review of the running board —
no new capability, no new state, no new write routes (the write surface stays exactly three, asserted
unchanged by `tests/board-routes.test.ts`). Six items, all built from the existing component
vocabulary (`.card`/`.card__h`/`.prow`/`.founding`/`.chip`/`.stamp`/`.deriv`/`.mono`) — zero new CSS
class names were introduced anywhere in this phase.

## L1. The artifact render view (item 1) is a read-only projection, sibling to run/project, not a
registry entity
`src/board/render.ts#renderArtifact` and `#renderIdea`, routed at `GET /artifact/:project/:unit/:id`
and `GET /idea/:name` (`src/board/serve.ts`). Both reuse the standard rail/main/orch shell so the view
reads as one more screen in the same product, not a bolt-on. Frontmatter renders as `.prow` key-value
rows inside a `.card` (kind, id, status chip, producer avatar, created + age, approved_by, files,
cost); the body is paragraph-split (blank-line-delimited, matching `firstParagraph`'s own split rule —
ruling A8 — just not truncated to one paragraph) with a leading `#` line rendered as a heading, since
no markdown-rendering library is available (`deps:check` bans it) and none was needed for this
fixture's prose. Lineage is a fourth card with four sub-lists — consumes, supersedes, superseded-by,
cited-by — each rendered with `.founding`/`.cite` (the same "artifact reference + badge" row the
project view's constitution list already uses). Every artifact id and idea name elsewhere in the
product (`tokenLink` sites in gate cards, founding artifacts, unit-detail artifact rows, the run-view
score rail's producer line, and the studio ideas rail) now routes here via two new link helpers,
`artifactTokenLink`/`ideaHref`, instead of falling back to `/run/:project/:unit`.

**Consumes/supersedes may reference an artifact outside the current unit (founding-artifact model), so
lineage resolution searches the whole project, not just one unit** (`findArtifactInProject`,
`supersededByOf`, `citedByOf` in `derive.ts`). An id a consumer references that cannot be resolved
anywhere in the project renders as an honest "unresolved" row (`lineageUnresolved`) rather than being
silently dropped or mis-rendered as "nothing consumed" — the golden fixture has no such case, but a
future project with a broken reference should surface it, not hide it.

**Ideas carry no lineage the schema can express.** No frontmatter field ties an idea back to a project
it was promoted into (design brief: "promoting it opens an inception unit", but nothing records that
edge once it happens). The idea view's Lineage card states this honestly ("nothing consumes,
supersedes, or cites it") rather than fabricating a connection. Revisit if a future phase adds a
`promoted_to`/`from_idea` field.

**Not-found is a thrown error → the existing generic 500-JSON catch, matching `renderProject`/
`renderRun`'s precedent.** A true `404` for an unknown artifact/idea id would be more correct HTTP, but
every other page route in this codebase already uses "throw → the router's catch-all returns 500
JSON" for an unresolvable id/name; introducing a different convention for just these two new routes
would be inconsistent with the rest of `serve.ts`, not more correct. Left as a candidate follow-up if
a future phase gives 404 handling a real design (a proper "not found" HTML page, per `onboarding.ts`'s
existing precedent for the analogous "not a studio yet" case).

## L2. Project-card anatomy (item 2) — "most relevant unit" needed a recency signal the schema doesn't
have; the artifact's own `created` date was used, not filesystem mtime
Ruling A8 ("first paragraph of an artifact's markdown body is its display summary") governs artifact
summaries; the task's "newest gated, else newest active" selection rule needed a **unit**-level recency
signal, and `WorkUnit` (`types.ts`) has no `created` field at all. Filesystem mtime was rejected: a
fresh `git checkout` stamps every file's mtime to checkout time, so relative ordering across files
carries no real signal in exactly the hermetic/CI environments this project's tests already run in
(`tests/immutability.test.ts` establishes the same class of hazard for a different reason). **Instead,
`mostRelevantUnit` (`derive.ts`) sorts by the unit's own leading artifact's `created` field** — real
authored data, already present on every artifact — with a unit that has no artifact yet (a bare start
gate, e.g. `loyalty-flow`) sorting last, never first, so it is only ever chosen when nothing richer is
available. Against the golden fixture this correctly picks `checkout-flow` (newest-gated, via its
`spec` artifact's `2026-07-11`) over `loyalty-flow` (a start gate with zero artifacts).

**The one-sentence summary is the artifact's full first paragraph (A8), not a first-sentence
truncation.** The pre-existing code truncated `unitSummary`'s already-correct A8 paragraph down to one
sentence via a regex split — a second, undocumented truncation rule the task's "one-sentence human
summary" language does not actually require (A8 says "paragraph", and every golden-fixture paragraph
already reads as one or two sentences by authoring convention, per A8's own note). Removed; the full
paragraph now renders verbatim.

**"Latest release" has no dedicated concept in the schema at all** — release/changelog tracking has
never been modeled (E1/E8's "no releases tracked yet" stamp is the only prior art, and it was always a
hardcoded string, never a real derivation). **Assumption:** the closest honest proxy is the most
recently shipped work unit (`latestRelease`, `derive.ts`), using the same artifact-`created` recency
signal as `mostRelevantUnit`. This is a proxy, not a real release model — a future phase that adds
actual release/deploy tracking should replace this rather than build on it.

## L3. Project stats strip (item 3) — filled to its declared grid rather than resized, since the
missing stats were real, derivable numbers
The project view's `.statstrip` used the shared `.statstrip{grid-template-columns:repeat(4,1fr)}` rule
with only 3 stat cells rendered, leaving one dark grid track — the defect the task named. The
alternative option ("size the grid to its content") was available but the task also named two specific
missing stats (median review rounds, spend) that are both genuinely derivable from data already loaded
(review-kind artifact counts per unit; `usage.usd` sums) — the same numbers the studio-level stat strip
already surfaces project-wide (`repoSpend`, `medianGateResponseDays`). Adding the project-scoped twins
(`projectSpend`, `medianReviewRounds` in `derive.ts`) and rendering all five in an explicit
`repeat(5,1fr)` (matching the studio strip's own existing `style=` override pattern) was the more
informative fix and reuses an established pattern rather than introducing a new one.

## L4. Derivation line (item 4) — one span, relocated into the footer stamp, not deleted and
re-authored
`derivLine()` (a bare `<span class="deriv">`) rendered once under the page `<h1>` and a second,
textually-duplicate `<div class="stamp">` rendered the same fact in the sidebar footer on studio,
project, and registry; the run view's footer showed only a bare path with no "derived from" text at
all (so it weirdly *wasn't* a duplicate there, but also didn't carry the marker anywhere but `.phead`).
**Fix:** removed every `.phead`/top-of-`.main` `derivLine()` call; the footer stamp is now the single
source, built by `derivFooter()`, which nests a `<span class="deriv">` inside the existing
`<div class="stamp">` so the derivation marker keeps one stable class regardless of which screen's
footer it renders in (`.deriv`'s own CSS rule was scoped `.phead .deriv{...}` and does not apply
outside `.phead` — the nested span relies on ordinary CSS inheritance from `.stamp`'s own font/color
rule, which already matches, rather than needing a new unscoped `.deriv` rule). The run view's footer
text changed from a bare path to the same "derived from work/…/ on every request" phrasing the other
three screens use, closing the inconsistency rather than just deleting the duplicate.

## L5. Registry density pass (item 5) — the shared `.card` rule was tightened, which also benefits
the new artifact view
"Use only existing CSS custom properties and rules, invent no new visual language" was read literally:
no new selectors were added anywhere in this phase. The registry's `.entity.card` blocks already used
`.prow` for every key-value row (already inline, already scannable structurally) — the actual density
problem was vertical rhythm: `.card{padding:18px 20px;gap:13px}`, `.entity{gap:22px}`,
`.rendered{gap:16px}` compounded into a lot of whitespace for a card with several rows. Tightened to
`.card{padding:15px 17px;gap:10px}`, `.entity{gap:14px}`, `.rendered{gap:11px}`, plus a matching trim
on `.pill`/`.backlink` padding. Because `.card` is also the container the new artifact/idea view (L1)
uses for its frontmatter/body/lineage blocks, this tightening applies there too — one consistent
density pass across both, not two divergent ones.

## L6. Ideas link to the artifact render view (item 6)
The studio rail's idea rows were plain `<div class="idea">` text with no link at all. Changed to
`<a class="idea" href="/idea/:name">`, deliberately **not** adding the `.link` class other mono tokens
use — `.link` paints an accent-colored underline on hover, which is exactly the "urgency styling" the
design brief says the ideas rail must never carry ("the most understated element on the page... no
counts, no urgency styling, never gate-colored"). `.idea` gained only `display:block`,
`text-decoration:none`, and a muted-to-dim hover (`color:var(--fg-mute)` → `var(--fg-dim)`) — visually
identical to before except that it is now, in fact, clickable.

## Learnings
A git checkout is not a reliable clock: every file's mtime is stamped to checkout time, not authoring
time, so "sort by filesystem mtime" carries no real signal in a freshly-cloned repo — the same failure
mode `tests/immutability.test.ts` already guards against for a different check. When a schema has no
dedicated recency field for the thing being ranked, prefer deriving recency from a *related* entity's
own real, authored timestamp (here: a unit's leading artifact's `created` field) over any filesystem
signal.
A single shared CSS class doing double duty across two features (here: `.card`, used by both the
registry's density pass and the brand-new artifact view) means a tightening pass for one screen is
also, for free, a consistency pass across the whole product — worth checking who else consumes a class
before assuming a change is scoped to the screen that motivated it.

# NOTES — uncertainties and assumptions (Phase 7.5, gate-review round 2)

A follow-up gate review on the phase-7.5 board polish, structural this time: the rail was serving two
masters (navigation and page metadata) and had to become ONE thing. Items 1/2/4/5 from the original
phase-7.5 goal are approved-as-shipped and untouched here; this round is items 1 (structural rail +
breadcrumbs), 2 (project-card layout), and 3 (registry grid) from the review itself.

## M1. The rail (`railNav`, `src/board/render.ts`) — one function, six call sites, nothing
screen-specific
`railNav(repo, extras, derivText, opts?)` now renders the SAME four sections (Projects, Registry,
Connectors, Ideas) plus the theme toggle and one derivation-footer line, called identically from
`renderStudio`, `renderProject`, `renderRun`, `renderRegistry`, `renderArtifact`, and `renderIdea`. A
new test (`describe("the rail is identical navigation on every screen")`) asserts this two ways: every
screen's rail has exactly those four `railsec__h` headings in that order and nothing page-specific
leaks in (no "Pointer", "Constitution", `.score2`, `.founding`); and, more strongly, the six rails are
byte-identical after normalizing the two things that legitimately still vary (the derivation-footer
TEXT, and the registry sub-nav's `is-active` highlight — both addressed below).

**"Recent releases" was dropped from the rail entirely, not relocated.** The design brief's original
studio-rail spec listed it, but the review's own enumeration of the approved nav-index — "Projects,
Registry, Connectors, Ideas... Nothing else, ever" — is the more specific, later ruling and does not
include it. It was always a hardcoded "no releases tracked yet" stub (E1) with no real data source
behind it; the project page's new pointer panel (M2) already carries a project-scoped Releases stamp
in the same honest-empty form, and the project card's meta line (phase-7.5 round 1, item 2) already
surfaces "released `<unit>`" per project. Nothing was lost, just de-duplicated out of the nav.

**The derivation-footer TEXT still varies per screen; its PRESENCE and LOCATION do not.** Read "the
rail identical... plus... the single derivation line in its footer" as fixing the line's existence and
place, not freezing it to one global string — the line's entire purpose (design brief: "every screen
states its derivation quietly") is to say what THAT screen derives from, and phase-7.5 round 1's own
item 4 ("keep exactly one, in the sidebar footer") already established scope-specific text as the
norm. Treated as a lightweight, universal piece of chrome (like a status-bar line), not "page metadata"
in the sense the structural ruling is actually policing (a project's pointer, a unit's score — rich,
entity-specific content that used to change what the rail's identity WAS, not one line of provenance
text in a fixed slot every screen already has).

**The registry sub-nav's `is-active` highlight is ordinary wayfinding, not a structural exception.**
`railNav` takes an optional `activeRegistryEntity` (only ever passed by `renderRegistry`) that adds
`is-active` to the current entity kind's link — the rail's CONTENTS (which kinds exist, their counts,
their order) never change; only which one is visually "you are here" does, exactly like a normal
persistent-nav current-page indicator. Every other screen renders the same links with no highlight.

## M2. Project pointer/constitution/releases relocate into a content-column panel, not a new rail
`renderProject` now takes a `root` parameter (needed to build `railNav`'s extras) and builds a
`pointerPanel` — one `.card` stacking three `.card__h`-labeled sections (Pointer, Constitution,
Releases) — reusing the exact multi-section-inside-one-card pattern the registry's own entity blocks
already established (`teamBlocks` etc. stack "Declared flow" + "Definition" inside one `.card`), rather
than inventing a new "compact panel" component. It renders at the top of `.main`, directly under the
`.phead`, before the stat strip.

## M3. The run view's score becomes a content column beside the timeline
`renderRun` drops the `app--run` grid modifier (the rail is the standard width on every screen now,
per M1) and renders the score (`scoreCol`) and timeline (`timelineCol`) as two flex children of one
row (`display:flex;gap:32px;flex-wrap:wrap`, inline — the same "reuse the rule, override one layout
property inline" pattern the stat strips already use for their `grid-template-columns`, not a new CSS
class). `scoreCol` gets `flex:1 1 260px`, `timelineCol` `flex:2 1 360px` — the timeline is expected to
carry more rows over a unit's lifetime, so it claims the larger share; both wrap to full width under
the existing `@media (max-width:1080px)` breakpoint's own `.main{flex-direction:column}`-equivalent
behavior (flex-wrap handles it without a dedicated media-query rule). `assets/run.html` (the untouched
CD prototype file, never served) still references `.app--run` in `assets/styles.css` — the rule itself
was left in place rather than deleted, since it isn't wrong, just no longer reachable from the live
board.

## M4. Registry: in-content tab strip + card grid (item 3)
`registryNavLinks(repo, extras, active?)` is factored out of the old registry-only nav builder so the
rail's Registry section (M1) and the registry page's own in-content tab strip render from the exact
same list — they can never drift into two different sets of kinds. The tab strip is the same
`.reg-nav` list, laid out horizontally via an inline `style="flex-direction:row"` override (again: an
existing rule, one property overridden inline, not a new visual component). **The entity-card grid
reuses `.pcards`** (the exact grid mechanism the studio project cards already use) with an inline
`minmax(320px,1fr)` override (the review's own number, wider than `.pcards`' default 220px since an
entity card carries materially more content than a project card) — zero new CSS was needed for this
item. Only ONE grid wrapper surrounds all seven kinds' blocks, not seven separate ones: since
`entityBlock` already sets `style="display:none"` on every non-active kind's `<article>`, a hidden
article contributes no grid track regardless of how many share the wrapper, so one shared grid
container is sufficient and simpler than kind-scoped ones. Team/agent cards were NOT given a wider
`minmax` floor of their own ("may be wider if their content genuinely needs it" is permissive, not a
requirement) — `.flowstrip`'s and `.recipe`'s own pre-existing `flex-wrap:wrap` already lets a
content-heavy card grow taller instead of needing a different grid track width.

## M5. Project cards: title+chip same line, two-line-clamped summary (item 2)
Markup fix: `.pcard__top` now wraps BOTH `.pcard__name` and the status chip (previously the chip alone
sat in `.pcard__top` with the name rendered as a separate sibling below it) — `.pcard__top`'s own
pre-existing `justify-content:space-between` does the rest, matching the gate-card/unit-row anatomy's
established "label left, status right" convention with zero new CSS. **The two-line clamp
(`-webkit-line-clamp:2` + `min-height:36px` added to the existing `.pcard__desc` rule) is the one
genuinely new CSS declaration in this whole round** — no rule in the stylesheet already does
text-truncation, so "use existing rules" was read as "extend an existing rule's existing selector to
fix its existing overflow behavior" rather than "introduce a new selector"; the alternative (a fixed
pixel height on `.pcard`) would have clipped genuinely short cards' bottom padding unevenly instead of
normalizing the one field (the summary) whose length is actually unbounded. `min-height:36px`
(≈ 2 × 12.5px × 1.45 line-height) ensures a one-line summary (e.g. `studio`'s empty-project text)
still reserves the same two-line slot as a long one, so card height is uniform regardless of which
branch produced the description.

## M6. Breadcrumb: studio now carries one too (`<span>studio</span>`, no link — it IS home)
Studio's `.phead` previously had no `.crumb` at all — added for uniformity ("always in the same
place": every screen's crumb sits inside `.phead`, immediately before the `<h1>`, asserted directly by
a new test). `registry` gained a proper `.phead`/`<h1>Registry</h1>` wrapper too — it previously
rendered a bare `.crumb` directly in `.main` with no header block or heading at all, the one screen
whose breadcrumb genuinely wasn't "in the same place" as the others.

## Learnings
A component "serving two masters" (here: the rail as both navigation and per-page metadata) is hard to
spot from any single screen's markup — it only becomes obvious diffing across screens, which is
exactly why "make N screens share one literal function" is a stronger fix than "make each screen's
rail look similar": a shared function makes the two masters structurally impossible to reintroduce,
where "looks similar" left room for the next edit to quietly bring page metadata back in on just one
screen.
When constrained to "no new visual language, reuse existing rules," the sharpest test is not "did I
add a new class name" but "did I add a new CSS mechanism the stylesheet has never needed before" —
reusing an existing selector's box model in a new way (line-clamping `.pcard__desc`) is a smaller,
more honest exception to log than inventing a same-purpose sibling rule would have been, and is worth
calling out explicitly rather than letting it blend into "no changes needed" claims elsewhere in the
same round.

# NOTES — uncertainties and assumptions (Phase 7.5, gate-review round 3)

A third gate review: one BLOCKING stability bug (an SSE/fs.watch handle leak reported from live use)
plus two cosmetic items from the same pass — breadcrumb consistency and registry card alignment. Items
1/2/4/5 from the original phase-7.5 goal, and the structural rail/project-card/registry-grid work from
round 2, are approved-as-shipped and untouched here.

## P1. The SSE handle leak — diagnosed, fixed, and the fix empirically verified to actually
discriminate (not just "look right")
**The real defect, found by reading the code, not by reproducing the reported symptom.**
`sseResponse()` (`src/board/serve.ts`) called `subscribe(ctx, send)`, captured the returned
`unsubscribe`, and then discarded it — `void unsubscribe;` — so a disconnected client's `Sender`
closure was NEVER removed from the board's subscriber `Set`. The fs.watch side of the report was
already correct in the code as found: `createBoard()` calls `watch()` exactly ONCE, at board startup,
shared by every subscriber via `ctx.broadcast` — there was no per-connection watcher to fix.

**The reported mechanism (inotify fd growth) did not reproduce under direct investigation, and the
test suite says so honestly rather than asserting an OS-level number it can't actually prove.** Before
writing the fix, the exact scenario described — real subprocess, `readlink`ing every fd in
`/proc/<pid>/fd`, 20/50/120-cycle open-then-abort loops against real sockets — was run against the
**unfixed** code on this environment (Bun 1.3.14, linux/aarch64) and the process's fd count, including
its one `anon_inode:inotify` entry, stayed completely flat throughout. The `subscribers` Set leak is
real and unambiguously wrong regardless (verified by mutation: surgically re-disabling the cleanup
call reproduces `debugSubscriberCount` growing to exactly N after N cycles — see below), but on this
Bun version a disconnected client's underlying socket/stream appears to be reclaimed by the runtime's
native layer independent of whether the JS side ever reacts to the disconnect. Two honest
possibilities, neither resolved further here: the live environment where this was diagnosed differs
(older Bun, different OS/kernel, a longer-running process where slow deferred GC of the retained
closures eventually does hold real resources), or the reported "inotify" characterization was an
inference from `lsof`'s generic `a_inode` TYPE column rather than a confirmed `readlink` of the NAME.
Either way, the code-level defect (leaked Set entries, and by extension whatever retains anything
those closures hold onto) is real and is what got fixed; the exact production mechanism is recorded
as unconfirmed rather than claimed as proven.

**The fix, and why it doesn't just move the leak.** `sseResponse(ctx, req)` now: builds one
`SseSubscriber { send, close }` per connection; registers it via the same `subscribe()`/`Set` (adds a
`close()` so the board can force-end a stream, not just stop tracking it); wires cleanup to BOTH
`req.signal`'s `abort` event (Bun's own "this connection's underlying socket closed" signal — the
reliable path for a real dropped connection) AND the `ReadableStream`'s own `cancel()` callback (fires
when the stream's consumer — Bun itself, or a test calling `reader.cancel()` — cancels it; the only
path that fires for an in-process `board.fetch()` call, since a hand-constructed `Request`'s `.signal`
is never actually driven by anything). `cleanup()` is idempotent (a `cleaned` flag) since both paths
can fire for the same disconnect. `board.close()` now also calls the new `closeAllSubscribers()` —
closes every still-open stream and clears the Set — so a server shutdown never leaves a connected
client hanging on a socket nobody will ever write to again (previously `close()` only stopped the
watcher and the debounce timer).

**Why the test is two different kinds of check, not one.** `debugSubscriberCount(ctx)` is a new,
deliberately test-only export — the actual proof the leak is gone is that the subscriber Set returns
to exactly 0 after N connect/cancel cycles, not merely that "a broadcast still reaches a fresh client"
(that check would pass even against the ORIGINAL bug, since a dead subscriber's `send` just
throws-and-is-caught silently whether or not it was ever removed — verified: the "broadcast still
works" property alone cannot distinguish the two implementations). `tests/board-serve-sse-leak.test.ts`
therefore leads with three in-process, deterministic tests against `debugSubscriberCount` (50-cycle
connect/cancel; `req.signal` abort path; `board.close()` force-closing an open stream) — each one
was run against the pre-fix code with a surgical one-line mutation (disable the `cleanup()` call
inside `sseResponse`, keeping everything else identical) and confirmed to fail, then confirmed to pass
once restored, so they're proven to actually discriminate, not just assert a number that happens to be
true either way. A fourth test spawns the real `./levare serve` subprocess and reads its own
`/proc/<pid>/fd` count across 50 real-socket connect/abort cycles as a real-environment sanity check
with generous slack (it does not, and per the above cannot, prove the fd-level claim on its own in
this environment) — kept because the review specifically asked for it and because it's still a real,
valid regression guard against a future change that reintroduces a per-connection resource.

**Live verification beyond the test suite.** `./levare serve` was run for real against a scratch repo;
160 simulated navigations (a page GET + an SSE open-then-abort each, in both sequential and concurrent
bursts) were driven against it while polling `/proc/<pid>/fd`. Baseline 13 fds → 16 after 160
navigations, `anon_inode:inotify` count staying at exactly 1 throughout; the server remained fully
responsive (`GET /` → 200) and shut down cleanly on `SIGTERM`.

## P2. The breadcrumb rule (stated once, applied everywhere)
**Rule:** a breadcrumb renders one segment per real, linkable page between studio and the current
page. Every segment is a link EXCEPT the last (the current page — plain text, or `mono` for a
filesystem-truth token like an artifact id or idea name — never a link to itself). No synthetic or
non-navigable category label is ever inserted as a segment just to describe what kind of thing the
current page is.

**The idea route's crumb was the one violation.** It rendered `studio / ideas / <name>` — but there is
no `/ideas` route (the studio page has an *Ideas* rail section, not a standalone listing page), so
"ideas" pointed at nothing; a click would have 404'd. Per the rule, an idea's crumb is now `studio /
<name>` — two segments, the exact same shape as a project's `studio / <project>` (an idea, like a
project, nests directly under studio; it just has no children of its own to extend the chain further).
`tests/board-render.test.ts` gained a rule-level test (`"every breadcrumb segment is either a link or
the final...segment"`) that parses each screen's `.crumb` and asserts every segment but the last is an
`<a>`, so a future screen can't reintroduce a bare non-navigable middle segment the way `ideas` was.

## P3. Registry card header/actions alignment
Two independent misalignments, both pre-existing structural gaps rather than anything introduced in
round 2's grid change (they were just easier to see once cards sat side by side in a grid instead of
stacked full-width): `.entity__head`'s kind badge (`.entity__kind` — "team"/"agent · kestrel"/"skill"
etc.) sat immediately after the title with no right-alignment, unlike every other card's
label-left/status-right anatomy (gate cards, unit rows, project cards); and `.editbar` (the Edit-source
action row) sat wherever an entity's own content happened to end, so cards of different natural
heights sharing a grid row (`.pcards`' default `align-items:stretch` already stretches each `.entity
.card` article to the row's full height) had their action rows land at visibly different vertical
positions. Both are one-line CSS fixes to already-existing rules, no new selectors: `.entity__kind`
gets `margin-left:auto` (same right-alignment technique `.pcard__rt`/`.reg-nav a .ct` already use
elsewhere in this stylesheet); `.rendered` gets `flex:1` (so it — not just the outer `.card` — actually
absorbs a grid-stretched card's extra height) and `.editbar` gets `margin-top:auto` (pinning it to the
bottom of that now-taller box). Net effect: every entity kind's actions row sits flush against its
card's bottom edge, regardless of how much or little content that kind's card renders above it.

## Learnings
Reproducing a reported bug's EXACT mechanism before fixing it is worth attempting even when the fix
itself is obviously correct on inspection — the attempt here (real subprocess, real sockets, `/proc`
fd inspection, escalating cycle counts) didn't reproduce the specific inotify-growth claim on this
Bun version, and that's a genuinely useful thing to know and record, not a wasted step: it means the
regression test built afterward had to be independently checked for whether it actually discriminates
fixed-from-broken, rather than trusted just because it "looks like" a leak test. A test that passes
identically against known-buggy and known-fixed code is not a regression test, whatever its name says
— it happened here (the first fd-based draft passed both ways) and was only caught by deliberately
running it against the pre-fix code and a surgically-reintroduced version of the bug before trusting it.
A category label used as a breadcrumb segment ("ideas") is a natural thing to reach for when describing
what kind of page you're on, but a breadcrumb's job is navigation, not classification — if a segment
has nowhere real to send a click, it doesn't belong in the trail at all, and the fix is usually to
delete the segment, not to find something for it to link to.

## N1. Known open issue: intermittent multi-second stall in the browser during navigation,
self-recovering — cause not yet isolated, likely NOT levare
Reported after P1's SSE/fs.watch subscriber-leak fix landed. Live diagnosis at the moment of a stall
showed the **server** healthy throughout: 19 fds, one `anon_inode:inotify` handle, no growth, 1.4% CPU,
static-asset response ~1ms, page response ~10ms, the SSE connection holding correctly. The browser
showed exactly one `EventSource` (no duplicate/leaked connections) and no console errors. A hard
refresh does not clear it; it resolves on its own after a few seconds with no further action. **P1's
leak is confirmed not the cause** — fd counts are flat both at rest and during the stall, and the
leak's own symptom (climbing fds, eventual hard failure requiring a restart) doesn't match a transient,
self-recovering stall with a healthy process throughout.

**Leading hypotheses, neither tested yet:**
- (a) The VS Code devcontainer's port-forward proxy stalling long-lived SSE traffic — the harness, not
  levare. An earlier symptom in this project was also eventually traced to a stale forward, so this has
  precedent here.
- (b) A brief render/reload burst when `fs.watch`'s debounce (`serve.ts`, 80ms) fires multiple times in
  quick succession for one git operation (a commit touches several files near-simultaneously), each
  triggering a full page reload via the SSE `reload` message — several overlapping reloads racing in
  the browser could plausibly present as a multi-second stall that then self-resolves once they settle.

**Required before code review: re-test OUTSIDE the container** — run `levare serve` and browse it on
the host directly, with no port forward in the path. If the stall disappears on the host, it is a
devcontainer/port-forward artifact (hypothesis a) and levare itself is innocent; if it persists on the
host, the debounce/reload-burst hypothesis (b) becomes the next thing to instrument and fix. Not
investigated further this round — recorded here as an open issue per instruction, not fixed or
worked around.

# NOTES — uncertainties and assumptions (Phase 8: the daemon)

Phase 8 turns levare from "responds to clicks" into "runs" (the goal's own framing): a Runner process
that walks the DAG continuously, invoking members through the existing AdapterRunner boundary, halting
at every gate and never resolving one. These entries record the mechanical and design choices the
goal's prose left open, in the same spirit as every prior phase's notes — cite them, don't re-derive
them.

## O1. `dagwalk.ts` is a new, narrow "single-step advance" — not a second copy of the Runner's walk
The goal's steering message was explicit: "reuse... do not reimplement... the daemon is the process
that DRIVES them continuously — it is not a second engine." Two shapes were considered:
(a) make `runner.ts`'s `Runner.run()` genuinely resumable (its `seed` option already exists but is
never actually consulted by `runStep` to skip a kind that's already been produced — confirmed by
reading the code, not assumed) and drive it repeatedly with a `DecisionSource` that reads on-disk
approvals and signals "no decision yet" as a pause; or (b) a new, small, purely-derived "what's the
single next producible kind, if any" function that both the daemon and the board's `start` verb share.
(a) was rejected: making `seed` actually skip already-produced steps requires per-round bookkeeping
(loop round counters, `max_rounds` tracking) to stay correct across a walk that's re-simulated from
scratch on every tick — the Runner's in-memory round counter has no way to know "this is really round 2
on disk" without new state, and getting that wrong risks silently exceeding `max_rounds` or
misattributing round labels. (b) is what shipped, as `src/dagwalk.ts`: `nextAction()` (pure, unit
tested directly) walks a team's `flow` nodes against the unit's current on-disk artifacts and returns
at most one thing to do; `advanceUnit()` performs it through the real `MemberRunner`/`AdapterRunner`
boundary (invariant 10 untouched — no new adapter, no new SDK surface) and commits. This is genuinely
"reuse, not reimplement" in the sense that matters for this codebase: it reuses `gates.ts`'s existing
shared primitives (`responsibleTeamFor`, `resolveStep`, `unmetAfter`) — the same ones ruling C7 already
established as the one shared implementation between the Runner and the board — and the exact same
`MemberRunner`/validator/git boundary every other write path uses. What it does NOT reuse is
`runner.ts`'s `executeFlow`/`runLoop` control flow, because that engine's job (drive a full script of
decisions to completion in one pass, phase 2's `replay.ts`) is a different shape of problem than the
daemon's (repeatedly answer "what's next" against whatever's on disk right now, one step at a time,
with no decision script at all). `board/gateops.ts#doStart` (E5/F3's old bespoke "resolve the first
flow node, invoke, write" logic) now delegates to `advanceUnit` too — so there is exactly ONE piece of
code, in the whole codebase, that decides "given this team's flow and what's approved on disk, what
gets produced next."

## O2. Scope boundary: the daemon auto-advances a loop's FIRST member only, never its companion
Read literally, ruling B3 (phase 2) says a loop raises one gate per round "on the first member's
artifact" and that "the review artifact is the input the Conductor reads at that gate" — implying the
companion (`review`) should exist too. An early design auto-produced BOTH loop members together the
moment neither existed yet. This was reverted after discovering it would retroactively "fill in" a
missing companion the very first time the daemon looks at `fixtures/golden`'s own **existing** static
demo gate (`spec-checkout-flow-v1`, in-review, with no companion review file — NOTES E3 already
establishes this is the fixture's actual, deliberate shape) — on-disk state alone gives no way to tell
"a first-member artifact that predates the daemon and was never meant to get an auto-produced
companion" apart from "a first-member artifact the daemon just created a moment ago and should
immediately pair." Rather than invent a marker to distinguish the two (a new frontmatter field, or
inferring intent from git-log authorship), the daemon now treats a loop's first member exactly like a
plain step for automation purposes and never auto-produces the second at all. `until` (a Conductor
approval, invariant 4) is what actually ends the loop; a missing companion review never blocks that —
matching the golden fixture's own long-standing shape, where the Conductor has always resolved the spec
gate with no live review artifact to read alongside it. Also closes a broader compatibility hazard: had
this shipped, EVERY scratch/test repo copied from `fixtures/golden` (the overwhelming majority of this
suite's fixtures) would have gotten an unprompted new review artifact the instant a live daemon touched
it, silently invalidating file-count/content assertions across dozens of pre-existing tests.

A loop round AFTER the first (following a Conductor's request-changes) needs no daemon logic at all:
`board/gateops.ts#doRequest` already produces that round's artifact synchronously, in the same HTTP
request that resolved the gate — by the time any walker looks again, it's already on disk, and
`nextAction`'s own halt rule ("a live artifact of this kind exists and is in-review → halt") handles it
correctly with zero extra code.

## O3. A plain unit with no `after:` is walkable from the moment it's declared — no separate "start" nod
**Superseded by ruling C8 (see the Rulings section above).** The security audit (`docs/security-audit.md`,
Surface 5/1) demonstrated this reading as a real invariant-1 hole, not a defensible interpretation: a
hand-written or injected `unit.md` with no `after:` caused `Daemon.tick()` to invoke a real member with
no Conductor approval anywhere in its causal chain. C8 rules the opposite: EVERY unit's first flow step
raises a start gate, `after:` or not. The reasoning this entry originally recorded is kept below,
unedited, as the record of what was tried and why it turned out wrong — not as current behavior.

PRD §6's DAG-walk rule has no carve-out for "the very first kind" — only `after:` makes a unit
"invisible to the walk." Read literally, a freshly-declared active unit with `product-brief`'s
`consumes: []` (trivially satisfied) is producible the instant the unit exists. Read against invariant 1
("no member process ever starts without a Conductor approval in its causal chain... start gates let
that approval be prompted rather than remembered, but never replaced"), the causal chain for THIS first
invocation is the Conductor authoring and committing the unit.md file itself — an explicit act of
intent, not a state that merely arose. This is the single most debatable call in this phase, recorded
explicitly rather than silently baked in: a stricter reading would require every unit, `after:` or not,
to sit behind an explicit start gate. The literal-§6 reading was taken because (a) the PRD's own prose
draws the `after:`/no-`after:` distinction deliberately and only gates the former, and (b) `after:` is
described as a "start-gate condition" specifically — implying units WITHOUT one have no start gate to
speak of, by design, not by oversight. Tested directly (`tests/daemon.test.ts`, case b): a
freshly-declared unit gets its first kind produced on the very next tick, no further click.

**What this reading missed**, per the audit: §12's own non-goals list ("No autostart — a future
per-unit `autostart: true` opt-in is permitted by the invariants but out of scope") and §5's own
parenthetical on `after:` ("start-gate condition — never autostart") both read, together, as leaning
firmly toward the strict interpretation — a signal this entry's literal-§6 argument didn't weigh heavily
enough against reading (a) alone. "The Conductor authored the unit.md" is also not reliably true the
moment the threat model (per the audit brief) grants an adversary "the contents of any file in the
studio repo" — a member escaping its unit, a prompt-injected Orchestrator, a merged PR, or a vendored
skill's file write can all produce a `unit.md` with none of them being the Conductor.

## O4. Concurrency safety: a single-threaded work queue (deliverable e), and what it actually guards
against
`Daemon` (`src/daemon.ts`) serializes every tick behind `tickRunning`/`tickQueued`: at most one tick's
unit-walk runs at a time, units within a tick are walked strictly sequentially (no per-unit
concurrency), and a repo-change signal that arrives while a tick is already running coalesces into
exactly one follow-up tick, not one per signal. Worth being honest about what this mechanism is FOR:
`MemberRunner.produce()` is fully synchronous today (every adapter — native, cli, remote — invariant 10
+ K1's own established pattern), so JS's run-to-completion semantics already make a literal
data-race-style double-invocation impossible within a single process even without a lock — two
`setTimeout`-scheduled ticks can never truly execute concurrently in one Bun process. The lock exists
for two real reasons anyway: (1) it is the explicit, testable guarantee the goal asked for, and a
guarantee that "happens to hold because nothing sits between two operations that could interleave" is
exactly the kind of implicit correctness that breaks silently the moment someone makes a boundary
async — and (K5/K9's own history in this repo is a live example: `NativeBoundary`'s real SDK backing is
already synchronous-via-subprocess for the same reason the Runner's engine had to stay synchronous, and
K9 shows what happens when an async boundary gets threaded through carelessly; and (2) it genuinely
guards a real, testable reentrancy hazard: a `MemberRunner.produce()` implementation that itself
(synchronously) tries to trigger another tick — plausible the moment any hook, log line, or future
instrumentation calls back into the daemon — is refused outright (`tests/daemon.test.ts`, "tick()
refuses to run re-entrantly") rather than silently interleaving two unit-walks against the same on-disk
state. The per-unit safety property the goal actually cares about most — "a member is never invoked
twice for the same producible kind" — is enforced by a second, independent mechanism layered underneath
the queue: every tick re-derives "does a live artifact of this kind already exist?" fresh from disk
(`loadRepo`, invariant 2) immediately before producing, so even a hypothetical future world where two
ticks somehow did interleave, the SECOND one would see the first one's just-written artifact and halt
instead of re-producing — files are the truth, so the truth cannot go stale between two ticks that could
never actually run at the same instant regardless.

## O5. Failures surface as a `blocked` artifact, occupying that kind's slot — never a crash, never a
silent stall (deliverable f)
A member throw (timeout, guardrail rejection inside a real adapter, an off-contract doc that fails the
same `validateArtifactSource` boundary every other write path uses) is caught at the exact call site
(`dagwalk.ts#produceOne`) and turned into a real, committed artifact at `status: blocked` for that kind
— visible on disk (files are the truth), and self-limiting: the next tick's `nextAction` sees a live
artifact at `blocked` and halts, exactly the same rule that already governs a `rejected` step, so a
persistently-failing member is never retried in a tight loop. A second, independent layer
(`daemon.ts#tickOnce`) wraps EACH unit's `advanceUnit` call in its own try/catch too — not redundant:
`dagwalk.ts`'s own catch only covers the member-boundary call itself, while a genuinely unexpected
failure elsewhere (a filesystem error, a git failure — reproduced live during this phase when a scratch
test repo had no `.git` at all) must still never crash the daemon's watcher callback, which nothing else
guards; an uncaught exception there would silently kill the whole `levare serve` process. Budget/timebox
are handled as pre-flight halts, not post-hoc gates: unlike `runner.ts`'s own interactive
continue/raise/stop verbs (which need a `DecisionSource` the daemon has none of), the daemon simply
never invites more spend once a unit's ledger sum already exceeds its declared `budget`/`timebox` —
checked BEFORE producing, with a reason recorded in `daemon.recentActivity()` (bounded, in-memory;
deliberately not a new persisted schema field — see O7) so "never silent" is testable without inventing
a UI for a verb (`continue`/`raise`/`stop`) the board's own `/gates` route doesn't even accept today
(confirmed: `serve.ts`'s POST /gates verb allowlist is `approve|request|reject|start|notyet|rescope`
only — budget verbs were never wired into the board, a pre-existing gap this phase does not close).
Guardrail-violation surfacing needed no bespoke code at all: it's just one more shape of thrown error
the same generic catch already handles identically to a timeout.

## O6. Two distinct git identities — the rule is WHO ACTED, not who triggered (gate-review fix)
Every write path before this phase committed as `cas <cas@levare.local>` (`CONDUCTOR_NAME`/
`CONDUCTOR_EMAIL`, `git.ts`) because every one of them WAS a direct Conductor action with no member
invocation in it. `RUNNER_NAME`/`RUNNER_EMAIL` (`levare-runner <runner@levare.local>`,
`git.ts#runnerCommit`) exists so a commit whose CONTENT was written by a member is never laundered as
human-authored — the two identities let `git log` distinguish what the Conductor *decided* from what the
machine *did* on their behalf, which is worthless the moment a machine-authored commit gets attributed to
the human anyway.

**The rule, stated precisely:** a commit's author reflects whose words/output ended up in the file, not
whose click caused the commit to happen. Two categories:
- **Conductor-authored** (`conductorCommit`): `approve`, `reject`, a frontmatter flip with no member
  content (nothing is invoked); `request-changes` — even though it DOES re-invoke a member, the commit is
  anchored by the Conductor's own written note (the change request itself, e.g. "name the idempotency key
  column") and the regeneration is a narrow, directed consequence of that specific piece of Conductor
  content, not an open-ended autonomous step; a registry edit — the file content IS what the Conductor
  typed.
- **Runner-authored** (`runnerCommit`): ANY commit whose file content is a member's own output with no
  Conductor-authored text driving what it says — this includes every `advanceUnit` production, full stop,
  regardless of which caller triggered it.

**Gate-review finding, fixed here.** `board/gateops.ts#doStart` originally passed
`commit: conductorCommit` to `advanceUnit` reasoning "the Conductor clicked start, so the commit is
theirs" — this was the bug: it attributed to `conductorCommit`. Live evidence:
`f31036f cas <cas@levare.local> — start loyalty-flow → kestrel/wren produced product-brief
product-brief-loyalty-flow-v1`. That commit's entire file content is wren's own generated brief — no
Conductor text is in it anywhere; "the Conductor clicked start" only explains why the invocation was
*legal* (invariant 1's approval-in-the-causal-chain), not who wrote the result. This is structurally
identical to every OTHER `advanceUnit` production (the daemon's own autonomous DAG-advance) — the only
difference is timing (synchronous, in the same HTTP request, vs. a later tick) — so it must get the same
identity. **Fix:** `doStart` now passes only `verb: "start"` (kept so the commit MESSAGE still records
"this production followed an explicit start click", a genuinely useful distinction from a later
autonomous advance) and lets `commit` default to `runnerCommit`. The corrected log line reads
`... levare-runner <runner@levare.local> — start loyalty-flow → kestrel/wren produced product-brief ...`.
`startAuthorized: true` is unchanged and still does its real job (makes the call legal); it was never
supposed to also decide authorship, and no longer does. Verified directly against the real commit author
(not an internal flag) in `tests/daemon.test.ts`.

## O7. "Members running" / "Running now" (deliverable c): in-memory only, never a new persisted field
`Daemon.running()` reflects the daemon's own live `inFlight` array, populated by a hook
(`AdvanceOptions.onBeforeProduce`) fired synchronously immediately before `MemberRunner.produce()` and
cleared right after (success, blocked, or halted — a `finally` in `daemon.ts#tickOnce`). This is
consistent with invariant 2 ("the binary holds no state that cannot be reconstructed by re-reading the
repo") precisely BECAUSE it is never persisted: an in-flight invocation is, by definition, not yet a
fact about the repo — the moment it becomes one (the artifact lands on disk), it's gone from `running()`
and the studio's stat/gate/openGates derivations already pick it up from the file itself on the very
next request. `render.ts#renderStudio` gained a 4th, optional, default-`[]` parameter (`running`) rather
than a new required one — every pre-phase-8 call site (all of `tests/board-render.test.ts`, and
`board/serve.ts`'s own route handlers before this phase's edit) keeps working unchanged, and a board
with no daemon attached (`createBoard`'s own default, unchanged — see O8) renders the exact same honest
"Nothing running right now" empty state E2 always rendered, just reworded slightly (E2's old copy
implied NO live registry could ever exist; that's no longer true, so the copy no longer claims it).
Reused `.avatar--runner` and `.tlrow` — both already declared in the frozen `assets/styles.css` but,
confirmed by grep, never emitted by any renderer before this phase (the same "dormant, already-designed
rule" shape phase 6's G1 closed for `.snode.is-danger`) — so this needed zero new CSS, consistent with
this codebase's standing discipline.

## O8. `createBoard()`'s default stays daemon-less; only `serve()` (the CLI's actual entry point)
attaches a real one
`BoardCtx` gained an optional `daemon?: Daemon` field and `createBoard(root, opts)` accepts one, but
NEVER constructs one itself — every one of the ~25 existing test files that call `createBoard(root)`
directly keeps getting exactly the board they always did, with zero new background process, fs.watch
handle, or side effect they didn't opt into. This was not a stylistic preference: an early version
attached a live daemon inside `createBoard()`'s own default and immediately broke an existing test
(`tests/board-serve-idletimeout.test.ts`) that seeds a scratch copy of `fixtures/golden` with NO `.git`
directory at all — the daemon's very first tick tried to advance a unit and crashed on `git add` failing
against a non-repo (before O5's crash-hardening existed to catch it). Only `serve()` — the function
`levare serve`'s CLI command and `./levare serve` both actually go through — constructs a real `Daemon`,
starts it, and passes it into `createBoard`; `--no-daemon` (deliverable a) short-circuits this, and a
read-only board (NOTES E14 — a `fixtures/` path, or `--read-only`) never gets one regardless of the
flag, structurally: the daemon's whole purpose is to write, which a read-only board must never do (the
same "structural, not a rule to remember" posture E14 already established for the three write routes).

## O9. `dagwalk.ts` also closes E5/F3's old scope boundary as a side effect, not a separate fix
The retired `doStart` used to 501 on a team whose flow opens with a `loop` rather than a `step` ("mid-
flow shapes... not supported yet" — ruling F3). `advanceUnit`'s shared `nextAction` walks step/gate/loop
nodes uniformly with no special-casing of flow position zero, so that restriction is simply gone — a
flow opening with a loop reaches its first gate exactly the same way a step-opening flow does. No
fixture exercises this shape yet (kestrel's flow opens `step: brief`), so it's untested territory closed
by generalization rather than by a dedicated fixture; noted here rather than silently claimed as
"tested."

## O10. Gate-review fix: the SSE-leak subprocess sanity check was Linux-only (a test bug, not a leak)
**Finding, reported from a real darwin (macOS) host:** `tests/board-serve-sse-leak.test.ts`'s subprocess
sanity check — "50 SSE connect/disconnect cycles over real sockets leave the process's fd count flat" —
failed on darwin while passing in the Linux container.

**Diagnosis, confirmed rather than assumed.** The test's `fdCount()` was `readdirSync('/proc/<pid>/fd')
.length`, hardcoded — macOS has no `/proc` filesystem at all, so on darwin this doesn't fail the leak
assertion, it throws `ENOENT` before ever reaching it. That crash is itself proof the reported failure
was a test-portability defect, not evidence of a real leak. Confirmed independently on the reporting
host: the three IN-PROCESS tests in the same file — the subscriber Set returning to exactly 0 after 50
connect/cancel cycles, an abandoned (aborted, never explicitly cancelled) connection still being cleaned
up, and `board.close()` closing every still-open stream — are pure JS with zero OS branching (they
exercise `debugSubscriberCount` against an in-memory `Set`, never a real socket or `/proc`) and all PASS
identically on darwin. Those three are the actual proof P1's fix works; the subprocess check is a
real-environment sanity check layered on top, not a substitute for it, and per NOTES P1 itself the
reported *mechanism* (inotify/fd growth) was already never fully confirmed even on Linux — only the
code-level defect (the leaked `Set` entry) was.

**Fix.** `countOpenHandles`/`detectHandleMechanism` (top of the file) pick a platform-appropriate
measurement — `readdirSync('/proc/<pid>/fd')` on linux, `lsof -p <pid>` (counting non-header lines) on
darwin/anywhere else `lsof` is on `PATH` — and the test is `test.skipIf`'d, with the skip reason baked
directly into the test's own name, on a platform with neither (never crashes, never silently reports a
false pass). `lsof`'s output-line-counting logic was smoke-tested directly against this dev sandbox's own
process (a Linux machine, so this only proves the parsing code runs and returns a sane positive count,
not that darwin's actual socket-close timing behaves as expected — that part could only be confirmed on
the real darwin host that reported and then re-confirmed the fix, per the exchange this NOTES entry
records).

**The assertion itself changed from "flat" to "not leak-shaped growth."** A closed socket can
legitimately still be visible to `lsof`/`/proc` for a short window after both peers have moved on
(TIME_WAIT and platform-specific equivalents) — an immediate single reading can overstate "still open"
with no actual leak behind it, more visibly so via `lsof` on darwin than via `/proc` on linux.
`settledHandleCount` takes the MINIMUM of several readings spaced a short settle interval apart (a
minimum can only ever under-report a real leak, never manufacture a false negative by hiding one) and
the test runs multiple ROUNDS of cycles, sampling after each, rather than one single before/after pair.
The actual assertion: the sample sequence must not be BOTH monotonically non-decreasing AND drift by a
leak-scale amount (≥ one round's worth of cycles) — the literal shape of the original bug (a retained Set
entry per connection) is unbounded, per-connection, monotonic growth; a settled, bounded wobble from
transient socket linger is neither monotonic across every round nor anywhere near that magnitude. A
looser absolute-drift backstop (well under "~1 handle leaked per cycle" across the whole run) catches a
leak that happens to wobble but still trends strongly upward, without pinning an exact number the way the
original "flat" assertion did.

**Result — which case it was.** A test-portability bug, not a real leak — this codebase's own darwin host
already showed the underlying fix works (the three JS-level tests) before any test code here changed; the
subprocess check was simply never able to run on that platform at all. No server-side code changed — the
fix is entirely in how the test measures and asserts, per this file's own header comment. Verified directly
in this sandbox (linux, `procfs` mechanism): `bun test tests/board-serve-sse-leak.test.ts` passes, 6 flat
samples (`16, 16, 16, 16, 16, 16`) across 5 rounds of 20 cycles. The `lsof`-parsing branch itself was
additionally smoke-tested standalone against this sandbox's own process (Linux, so this only proves the
parsing/counting logic runs and returns a sane count, not darwin's actual socket-close timing) — the
darwin (`lsof` mechanism) run is what the reporting host still needs to execute to close the loop, since
this sandbox has no darwin access; `bun test tests/board-serve-sse-leak.test.ts` there should now report
which mechanism it picked (baked into the passing test's own name) and a settled, non-leak-shaped sample
sequence instead of an ENOENT crash.

## Learnings
A `seed`/resumability option that exists on an interface but is never actually consulted by the code
using it (`runner.ts`'s `RunnerOptions.seed`, populated in the constructor but never read by `runStep`)
is a trap for exactly the situation phase 8 walked into: reusing "the resumable Runner" sounds like the
obviously-correct reuse until reading the implementation shows there's no resumability there to reuse —
the NOTES B1 language describing it as resumable was aspirational, not accurate, and would have been
taken at face value without re-reading the actual code.
A design that is locally correct (produce a loop's companion member so the Conductor has something to
read at the gate) can still be globally wrong the moment it's evaluated against EXISTING on-disk state
it wasn't designed against — the golden fixture's own long-standing static gate shape was the thing that
caught this, not a logical flaw in the rule itself; when a new autonomous process is about to start
touching a shared, widely-fixture-reused repo tree, checking "what does this do to state that already
exists, not just state I create fresh" is a distinct, necessary pass.
A lock that's redundant against today's fully-synchronous call graph is still worth building explicitly
when (a) the guarantee was explicitly asked for, (b) a nearby boundary in the same codebase has ALREADY
gone from sync to async once (K9) with a real, live-discovered bug when a blocking call sat on a
request path, and (c) the lock catches a genuinely different, real hazard (synchronous reentrancy) that
has nothing to do with the async case it's also future-proofing against — "this can't happen today" and
"this guarantee has no value" are not the same claim.
# NOTES — architecture & code review (branch `review/architecture`, 2026-07-12)

Deliverable: `docs/code-review.md` (the full invariant enforcement map, test-quality verdict, and
debt disposition). This section records the mechanical closures for the ledger; cite them, don't
re-derive them.

## R1. A7 closed — approval-baseline immutability (invariant 3, §4 "may not change in a later commit")
New optional artifact frontmatter field **`approved_commit`** (validate.ts ARTIFACT_SCHEMA, nullable
str). Board gate resolution (`gateops.ts#stampApproval`, applied by `doApprove` and
`applyLoopCompanionApproval`) records it = the repo's `HEAD` *before* the approval commit — the commit
holding the exact content approved. Recording the pre-approval HEAD (not the approval commit's own SHA)
is deliberate: a commit cannot contain its own hash, so a faithful "approval commit ref" would need a
second commit or a dangling amend; the pre-approval HEAD is a permanent ancestor, needs one commit, and
is equivalent for detecting post-approval content change. `validate.ts#gitImmutabilityCheck`: when
`approved_commit` is set, it diffs the working file against that ref via `git show`, excluding the
approval-stamp lines (`status`, `approved_by`, `approved_commit`) with `stripApprovalStamp`; any other
change is state **S2c** → `MODIFIED_AFTER_APPROVAL`. No `approved_commit` → the original HEAD-diff path
(S1/S2a/S2b/S2e), so pre-A7 artifacts (the golden fixture) are backward compatible. Residual (out of
scope, inherent to the no-auth model — Surface 10): an attacker who also rewrites `approved_commit` in
the same edit can still launder; that is the cryptographic-binding gap PRD §12 rules a non-goal.

## R2. C4 closed — the per-kind walk (supersedes the B7 per-unit shortcut)
`gates.ts#responsibleTeamsFor(repo, unit)` returns every team producing ≥1 of the unit type's `expects`
kinds, ordered by the earliest expected kind each team produces (dependency order — shaping before
build), ties by name. `dagwalk.ts#advanceUnit` and `runner.ts#walkUnit` iterate that list: a satisfied
team yields to the next, the first with a producible action produces, an open gate halts the walk.
`responsibleTeamFor` (kept for the start gate / `doStart`) is now the head of that list. Single-team
fixtures are unchanged (golden replay byte-for-byte). `tests/multiteam.test.ts` is the divergence
catcher — **verified to fail under the old single-team walk** (advanceUnit returns nothing; `code`
never produced) and pass under the per-kind walk (a build team produces `code`, authored as itself).

## R3. Deferred, requiring a Conductor ruling (written up, not guessed — see docs/code-review.md §4)
- **Invariant 6** (merge gate / spike-never-merges): no merge surface exists; `checkGuardrails` is a
  ready but unwired deliverable. Needs the build-team/merge phase (entangled with C4 build teams + K5).
- ~~**Invariant 7** (`mode: led`)~~ — **CLOSED, PRD v1.1 (see R4).** Ratified as cut; the field is now
  removed from the schema and actively rejected.
- ~~**C3 on the daemon**~~ — **CLOSED, PRD v1.1 (see R4).** Ratified: "informs, never spams" binds the
  daemon too; the budget gate now halts the unit and carries continue/raise/stop memory.
- **C5 on the board surface**: `doApprove`/`applyLoopCompanionApproval` bypass `applyApproval`'s
  name+ISO format guard (validate presence only; safe because the string is hard-constructed).
  Recommended follow-up: route both through `applyApproval`.
- **N1**: still host-vs-container; untestable from inside the devcontainer. Needs a bare-host `serve`.
- **Runner⇄dagwalk/gates duplication** (resolveStep, untilSatisfied, the C8/after: computation): the
  recommended end state is a leaf module both engines import, breaking the gates→runner import cycle
  that motivates the hand-synced copies (C7's own lesson, applied to the one place it was not).

## R4. PRD v1.1 reconciliation — `mode` removed, C3 budget behaviour on the daemon
Two clauses the v1.1 amendment ratified but the code did not yet do (both listed unresolved in R3).

**(1) `mode` cut from the team schema (amendment §3, invariant 7 restated).** Removed the inert field
end-to-end: the `Team.mode` type (`types.ts`), its parser default (`repo.ts#toTeam`), and the
`TEAM_SCHEMA` enum field (`validate.ts`). Nothing ever branched on it, so there were no code paths to
unwind — it was dead data. The removal is *diagnostic*, not silent: the validator's schema DSL gained a
`removed?: Record<string,name→message>` map, and `validateAgainstSchema` checks it *before* the
generic unknown-key path, so a definition still declaring `mode:` fails with **`REMOVED_FIELD`** naming
the field and the version ("removed in PRD v1.1 … no `mode: led` escape hatch") rather than a bare
`UNKNOWN_KEY`. An old studio gets a diagnosis. The `team-bad-mode` rejection fixture now carries the
once-valid `mode: declarative` and asserts `REMOVED_FIELD` (it used to assert `BAD_ENUM` on `bossy`);
a dedicated test asserts the message names `mode` + `v1.1` and is *not* swallowed as an unknown key.
The golden/init/multiteam team fixtures dropped their `mode:` line so they still validate clean.

**(2) C3 budget behaviour on the daemon (amendment §5).** Previously the daemon re-halted every tick
while `spent > budget` with no acknowledgment memory (R3's open question). Now it mirrors
`runner.ts#overBudget` — the difference is only *where the resolution comes from* (out-of-band, not an
interactive `DecisionSource`):
- `dagwalk.ts#advanceUnit` gained a distinct **`budget-gate`** outcome (carrying `spent`/`budget`),
  raised — before producing anything — when the ledger crosses the *effective* budget AND no prior
  `continue`/`raise` acknowledged this level. A plain `halt` couldn't carry the "this is a budget gate
  the Conductor can resolve" signal. Budget state arrives via a new `opts.budget: { eff?, ack? }`.
- The **`Daemon`** owns the per-unit C3 memory in-process (it is the one long-lived process, so that is
  "the run"): `budgetEff` (a `raise`-lifted budget), `budgetAck` (the acknowledged spend), and
  `openBudgetGates` (raised, awaiting the Conductor). Each tick passes `{eff, ack}` per unit; a
  `budget-gate` outcome records the open gate, any other outcome clears it. Strictly per-unit — a
  sibling unit in the same project is never touched (the halt is a `return` inside the per-unit loop).
- `Daemon.resolveBudget(project, unit, verb)`: `continue` sets `ack = spent` (gate won't re-raise
  until a *new* threshold beyond it); `raise` also lifts `budgetEff = spent` for the rest of the run
  (observable via `effectiveBudget()`); `stop` pauses the unit **on disk** (`status → paused`,
  Conductor-attributed commit) so the daemon's disk-truth re-derivation skips it thereafter. The board
  gate route (`serve.ts`) routes the unit-targeted verbs `continue|raise|stop` here instead of through
  the artifact-gate machinery, then `notify()`s so the walk resumes in the same interaction.

Tests (`tests/daemon.test.ts`): (h) an over-budget unit sits at its gate and never advances until
resolved while a solvent sibling advances freely; (i) `continue` resumes the walk and the gate
re-raises only at the *next* spend threshold ($0.06→$0.16), and `raise` lifts the effective budget
above the declared one; (j) `stop` pauses the unit on disk and the daemon stops walking it. Existing
budget test (f) updated `halted`→`budget-gate`.

*Uncertainty recorded:* `stop` persists `status: paused` to disk (faithful to invariant 2 / "files are
the truth", survives a restart, agrees with the board's disk-derived view) rather than an in-memory
flag. `continue`/`raise` memory stays in-process, exactly as the Runner's does — a daemon restart
re-raises the gate at the current spend, which is the safe direction (re-ask, never silently proceed).

## R5. Known tension — budget acknowledgments live in-process, not on disk
The C3 acknowledgment memory added in R4 (`continue`/`raise` → `budgetAck`/`budgetEff`) is held
in-process on the `Daemon`, not on disk. So a daemon restart re-raises a budget gate the Conductor had
already acknowledged. This **fails safe** (the Conductor is asked again, never a silent overspend) and
it mirrors the Runner engine's own in-memory maps — but it bends **invariant 2**: an acknowledgment is
a Conductor decision, and Conductor decisions belong in the repo (files are the truth).

**Accepted for v1** on the grounds that an acknowledgment is *session-scoped* ("continue for now")
rather than a durable fact about an artifact — unlike an approval, which is a permanent property of the
thing approved and *is* persisted (status + `approved_by` + `approved_commit`). `raise`'s effective
budget and `stop`'s pause are the durable edges: `stop` already persists (`status: paused`, committed);
a lifted budget is the one arguably-durable piece still kept only in memory.

**Revisit if the daemon becomes long-lived:** at that point acknowledgments (and the raised effective
budget) should be persisted and committed like every other Conductor decision — most naturally as
frontmatter on the unit, so a restart re-derives them from disk with everything else.

# NOTES — F-series: defects found by running a real studio (dogfood)

## F1. Agents could not declare what they produce — every real studio was unrunnable
**Found by the Conductor, running a real studio for the first time (2026-07-12):** two teams, four
agents, a research unit. `levare validate` said **valid**. Not one step ever ran. The unit sat
"active", silent, forever.

**The defect.** The Runner resolves a flow step to a member by consulting a capability map —
`{member, kind}[]` (NOTES B2). That map had exactly one source in the entire codebase: the
`CAPABILITIES` export in `fixtures/stubs/member-stub.ts`, derived from the stub's own canned
artifacts and **injected into `AdapterRunner` at construction** (`opts.capabilities`). A fixture-era
seam. Real agent definitions had no field in which to declare a capability *at all*, so for any
studio that wasn't the golden fixture the map was empty, `resolveStep` threw "no member of team X can
produce a kind for flow step Y", `dagwalk.ts#nextAction` converted the throw into a `halt`, the daemon
recorded the halt in a bounded in-memory ring buffer nobody reads, and the unit did nothing. Forever.
Every real studio failed on its first unit, and the failure was invisible from every surface.

**Why this is the worst fail-open so far.** It is the fifth in this codebase's history (validator
S0/S1 and S2a, the unknown intent, the SDK transport). The others let a *check* pass when it could not
actually verify what it claimed. This one let the **validator itself** say "valid" about a studio that
was structurally incapable of running — the one tool whose entire job is to tell you the truth about
your studio before you trust it with money and a subprocess. A gate that can't be reached is worse
than a gate that's wrong.

**The fix, in three parts.** Binding alone would have been necessary and insufficient: it would have
fixed the studios people write correctly and kept silent about the ones they don't.

1. **Agents declare `produces:`** (`agents/*.md`, PRD §5, `AGENT_SCHEMA`) — required, non-empty
   (`EMPTY_PRODUCES`). A member that produces nothing can bind to no step.
2. **Capabilities derive from the repo** — `repo.ts#repoCapabilities(repo)` reads every agent's
   `produces` and returns the `{member, kind}[]` map. `AdapterRunner` takes it from the repo by
   default; `opts.capabilities` is now an optional **test-only override** (the stub/replay path uses
   it nowhere — `stubAdapterRunner` derives from the repo like everything else, and still reproduces
   the golden oracle byte-for-byte, because the golden agents now declare exactly the pairs the stub
   can render). What the stubs mock is member **invocation**; they no longer supply the studio's own
   **declarations**. Files are the truth (invariant 2) — a capability is a fact an agent declares on
   disk, never one injected at construction.
3. **Validation rejects a structurally unrunnable studio** (`validate.ts#validateStudioBindings`, run
   for any tree carrying both `teams/` and `agents/`): `UNPRODUCIBLE_KIND` (a team declaring
   `produces: [k]` when no member of it declares k — the message names the team, the kind, and what
   each member actually produces), `UNBINDABLE_STEP` (a flow step — plain, or either half of a loop —
   that no member can satisfy under the Runner's own resolution rule), `AMBIGUOUS_STEP` (two producers
   for one step; the Runner never guesses). Rejection fixtures: `team-unproducible-kind`,
   `unbindable-step`.
4. **Runtime blocks loudly.** `nextAction` returns a distinct `unbindable` action (not a `halt`: a halt
   means "something is legitimately in the way, look again later" — a resolution failure never resolves
   itself, so re-deriving it every tick is a silent infinite no-op). `advanceUnit` blocks the unit **on
   disk** — `status: blocked` plus a new `blocked_reason` field carrying the resolution error verbatim,
   committed — `board/derive.ts#openGates` surfaces it as a **gate** with its reason on the card, and
   the daemon prints it. The daemon also no longer skips an invalid-repo tick in silence.

**Uncertainties recorded, not guessed.**
- **`produces:` is required, not optional.** An agent with no `produces` is a `MISSING_FIELD`, not a
  silently-empty capability. This is deliberately the loud direction: the entire defect was an empty
  capability map that nothing complained about. Cost: every existing agent definition needs the field
  (the golden fixture, the `init` scaffold, and `tests/multiteam.test.ts`'s agent were updated).
- **A team may have members producing kinds the team doesn't advertise** (kestrel's `finch` produces
  `review`; kestrel's `produces:` doesn't list it — `review` is an internal loop kind, not a kind the
  team offers the DAG). So `UNPRODUCIBLE_KIND` checks team→member, never member→team. Flagging the
  reverse would reject the golden fixture, and would be wrong: what a team *offers* and what its
  members *can make* are different sets.
- **`blocked_reason` is a new work-unit field** (schema, type, loader). The alternative — writing a
  `blocked` *artifact* the way a member failure does (NOTES O5) — has no kind to write under: nothing
  ran, and the missing kind IS the failure. The unit is what's broken, so the unit carries the reason.
- **The blocked gate card has no verbs.** A Conductor cannot approve their way out of a misconfigured
  studio; they fix `teams/`/`agents/` (and `levare validate` now names exactly what to fix) and the
  block clears. This is the one gate type that is informational — it is on the board because a failure
  no one is shown is a failure the system pretends it doesn't have.
- **Runtime binding failure is now defence in depth, not the primary path.** Since validation rejects
  an unbindable studio, `loadRepo` (which validates) fails first, so the daemon refuses the tick and
  says why. The runtime block still fires for the paths validation cannot pre-empt — a member boundary
  that reports a narrower capability map than the repo declares (an adapter that cannot reach a
  member, a stub, a test override). Both paths are tested (`tests/binding.test.ts`).
- **`AMBIGUOUS_STEP` is new enforcement at validate time.** The Runner already refused an ambiguous
  step at runtime (NOTES B2); hoisting it to validation is a strictly-earlier failure of the same rule,
  and no existing fixture trips it.

**Still open:** `runner.ts`'s in-memory engine (the phase-2 replay walk) still throws a `RunnerError`
on an unbindable step rather than blocking — correct there, because replay is a scripted simulation
that must fail loudly to the operator rather than mutate a fixture tree, but it means the "what happens
when a step can't bind" answer now lives in two places. That is the same runner⇄dagwalk duplication R3
already tracks (`resolveStep`, `untilSatisfied`, the C8 computation); F1 adds one more entry to the
list of things a shared leaf module would unify.

## F3. A real member's failure said "exited 1" and nothing else — an hour of live debugging to learn what F1/F2 already knew
**Found by the Conductor, debugging a real failing CLI member (`rook`) live (2026-07-13):** the
blocked artifact said `cli member 'rook' exited 1`. No stderr. No argv. No cwd. Nothing to act on. The
only way to learn *why* was to build an external environment-dumping spy CLI in place of the real
member — which is itself a secret-leak hazard (invariant 11): a spy built under time pressure to solve
"I have no diagnosis" has every incentive to dump `process.env` wholesale to find the answer fast.

**The defect, in three parts — none of them new categories, all three already fixed once for a
DIFFERENT symptom.** F1 fixed "the walk can't bind a step" by blocking loudly with a reason. F2 proved
the env allowlist reaches a real spawned child. Neither touched what happens **after** a real,
correctly-bound, correctly-scoped member is genuinely spawned and fails: `adapters.ts#runCli` (pre-F3)
turned any non-zero exit or timeout into exactly `cli member '<member>' exited <N>` — the member's own
stderr was captured by `bunSpawn` (`stderr: "pipe"`) and then **thrown away**, never attached to the
`SpawnResult` at all. `dagwalk.ts#writeBlocked` faithfully persists whatever message it's given
(NOTES F1's own blocked-artifact mechanism) — the diagnosis gap was entirely upstream, in what
`runCli` chose to say. Separately, a misconfigured `cwd` or an unresolvable `argv[0]` were never
checked before `Bun.spawn`, so those failed the same opaque way a *working* member's crash did — three
different root causes (bad cwd, bad binary, member's own bug) all collapsed into one indistinguishable
"exited N".

**The fix, in four parts.**
1. **Stderr reaches the reason.** `SpawnResult` gains an optional `stderr` field; `bunSpawn` decodes
   it from `Bun.spawnSync`'s already-piped stderr (it was being captured and discarded). `runCli`
   appends the last 2000 chars (`truncateTail`) plus the argv actually used to both the exit-code and
   the timeout `AdapterError` message — an unbounded member's error output can never grow a blocked
   artifact (and its git commit) without bound. `dagwalk.ts` needed no change: `writeBlocked` already
   persists `error.message` verbatim: the fix is entirely in what message `runCli` constructs.
2. **Pre-flight the spawn** (`adapters.ts#preflightCli`): before argv reaches `bunSpawn`, verify (a)
   a resolved `cwd` exists and is a directory, (b) `argv[0]` resolves — an absolute/relative path
   checked with `statSync`+`accessSync(X_OK)`, a bare name checked via `Bun.which` against the
   member's own allowlisted `PATH`. Either failure throws a precise, member-attributed
   `agent '<member>': cwd '<path>' does not exist` / `command '<argv0>' not found on PATH` before any
   process is spawned. Scoped to `this.spawn === bunSpawn` only — a test-injected `CliSpawn` is a pure
   behavioural stand-in (several existing tests deliberately drive unreal argv like `codex`, which
   this sandbox never installs) and never touches the filesystem, so it was never subject to the
   failure mode this guards.
3. **The daemon's console mirrors the artifact-level case, not just the unit-level one.** F1 added a
   `console.error` for `outcome.outcome === "unbindable"`; nothing mirrored it for
   `outcome.outcome === "blocked"` (a member that ran and failed) — the asymmetry meant a human
   watching `levare serve` saw the studio-misconfiguration case but not the member-crashed case. Fixed
   in `daemon.ts#tickOnce`. The run-view score-step row (`board/render.ts`) also gained a `blocked`
   chip — the state previously rendered as an unlabelled colored dot; the full reason was always a
   click away (`renderArtifact` shows the complete, untruncated body), but nothing told the Conductor
   there was something to click.
4. **A generalised redaction guard** (`env.ts#describeMemberEnv`): doctor.ts already got this right —
   `EnvProbe.has()` reads presence only, values never touched. `describeMemberEnv` gives every OTHER
   diagnostic surface the same obviously-safe shape (`{name, present: true}[]`), so a future log/board
   panel that wants to say "what env did this member get" has no reason to reach for
   `buildMemberEnv`'s real `Record<string, string>` outside the spawn boundary itself.

**Investigated, not reproduced: the subset-YAML single-quote question.** Asked whether
`command: ['/tmp/foo.sh']` mis-parses to argv0 `'/tmp/foo.sh'` (quotes included) — a plausible-sounding
cause for an "unresolvable binary" failure. It does not. `parseScalarAtom` dispatches single-quoted
tokens to `parseSingleQuoted` (`t.slice(1, -1).replace(/''/g, "'")`) exactly like double-quoted tokens
dispatch to `parseDoubleQuoted` — both strip their surrounding quote characters, and
`parseInlineSequence` routes every element of a `[...]` array (including `command:`'s own elements)
through that same `parseScalarAtom`, with no special-casing for list context. Verified directly
(`parse("command: ['/tmp/foo.sh']")` → `{"command":["/tmp/foo.sh"]}`) and pinned with regression tests
covering bare, single-quoted, double-quoted, and mixed elements, plus YAML's `''`-escapes-a-literal-
quote rule (`tests/yaml.test.ts`). No fix needed here — the gap was entirely in what `runCli` reported
after a real spawn, never in how argv got built.

**Uncertainties recorded, not guessed.**
- **Pre-flight is scoped to the real spawn boundary, not the `CliSpawn` interface.** Applying it
  unconditionally would have meant either rewriting every test that deliberately drives an unreal
  argv (several already exist, testing shell-injection safety) or weakening the check. A mocked
  `CliSpawn` never touches the OS, so it was never the thing Bun's opaque-failure mode threatened.
- **The stderr tail is 2000 chars, not the full stream.** A member that floods stderr must not grow
  its blocked artifact — and the git commit that carries it — without bound. 2000 chars is enough to
  show a stack trace or a license-check message; it is not an audit log.
- **The redaction guard is additive, not enforced by a lint rule.** `describeMemberEnv` exists so the
  SAFE path is also the EASY path; nothing currently in the codebase calls `buildMemberEnv`'s output
  from a log/console/artifact/commit site (checked directly — see `tests/diagnostics.test.ts`, which
  drives a real granted secret through a real failing subprocess, the daemon, and a real git commit,
  and asserts the value appears in none of them), so there was nothing to retrofit onto the guard
  today. A static check that no `console.*`/`writeFileSync`/commit call ever closes over a
  `buildMemberEnv` result is future work, not this fix.

**Still open:** the daemon's new `blocked`-outcome console line and the pre-existing `unbindable` one
are two near-identical `console.error` calls in `tickOnce` with no shared formatter — a small
duplication, not a defect, and in the same family as the runner⇄dagwalk duplication R3 tracks.

## F4. `levare serve` never spawned a real member's command — every live invocation went to the phase-2 replay stub (the eighth fail-open, and the first where a FIXTURE leaked into production)

**Found by the Conductor, reading F3's own new diagnostics on a real failing CLI member (`rook`,
`command: ["gemini", "-p", "{task}", "--output-format", "json"]`) live (2026-07-13):** the blocked
artifact's argv, now visible because of F3, was not `rook`'s own command at all —
`["bun", "<repo>/fixtures/stubs/member-stub.ts", "rook", "report", "--unit", "credential-scoping",
"--project", "studio"]` — and the error was `no canned artifact for member 'rook' kind 'report'`.
Gemini was never spawned. F3 built the diagnostic that made this legible; it did not cause it, and it
had been true since phase 8: **every** live `levare serve` production of a CLI member had gone to the
`fixtures/stubs/member-stub.ts` replay stub, not the agent's own declared command.

**Root cause: one constructor, two incompatible jobs.** `replay.ts#stubAdapterRunner` builds an
`AdapterRunner` with `cliCommand: (r) => [process.execPath, STUB_CLI, r.member, r.kind, "--unit", ...]`
— a deliberate, correct override for `levare replay --stubs`, which must be reproducible without a
real Codex/Gemini install. But it was also the **default** `memberRunner` in both `daemon.ts`
(`opts.memberRunner ?? stubAdapterRunner`) and `board/gateops.ts`
(`opts.memberRunner ?? stubAdapterRunner(repo)`) — the two places that back `levare serve` and its
board's gate resolution. Nothing else in the codebase ever constructed an `AdapterRunner` without that
override: there was no "real" production constructor at all, only the stub wearing two hats. Every
test that exercised the daemon/gateops default (`daemon.test.ts`, `binding.test.ts`,
`board-serve-daemon.test.ts`, …) reached only `native`-kind steps (`lyra`, mocked at the SDK boundary
regardless — K5's own separate, already-reviewed deferral) or explicitly injected a `memberRunner`
override of their own; none of them ever drove a real CLI member through the untouched default all the
way to a real subprocess. Every green test passed because **the tests were the ones injecting the
real behavior** — the untested path was the literal default.

This is the eighth fail-open this project's own NOTES record (F1 unbindable steps, F2 env leakage,
F3 opaque member failures, the K-series SDK/orchestrator gaps, …) and the first of them where the thing
that leaked into production was a **fixture** — a deterministic, canned stand-in — silently standing in
for a real external system on a live path, rather than a missing check or a swallowed error.

**The fix — split the constructor, not just the default.** `replay.ts` now exports two functions where
there was one:
- `stubAdapterRunner` (unchanged) — the `cliCommand` override stays, but its doc comment now says
  plainly what it is: reachable ONLY from `levare replay --stubs` (`runScenario`, same file) and from
  a test that imports it explicitly.
- `productionAdapterRunner` (new) — identical `native`/`remote`/`spawn` wiring, but **no `cliCommand`
  override at all**. Left unset, `AdapterRunner` falls back to its own `defaultCliCommand`
  (`adapters.ts`), which substitutes the agent's own declared `command` template into argv — the thing
  that was supposed to be the default all along.

`daemon.ts` and `board/gateops.ts` no longer import `stubAdapterRunner` at all — their defaults now
call `productionAdapterRunner`. This is the structural guarantee the goal asked for: it is not merely
that the current default happens to be correct, but that the ONLY function serve/daemon construction
can reach by default has no stub-spawning code path in it to accidentally reach. `stubAdapterRunner`
remains available for injection (tests already do this explicitly everywhere it's still used), but
production code no longer has a name for it in scope.

**What stayed deliberately unfixed.** `productionAdapterRunner` still wires `native`/`remote` through
the same fixture-rendering mocks `stubAdapterRunner` uses. That is K5's own already-reviewed, already-
documented deferral (the real SDK-backed `NativeBoundary`, `createSdkNativeBoundary`, exists and is
correct but is not wired into any live path yet) — unrelated to this defect and out of this fix's
scope. F4 is specifically the CLI path, because that is the one that silently diverged from its
"default reachable from serve" contract; native/remote were never claimed to be production-real in the
first place, so there was nothing there to silently regress.

**Closing the test gap that hid this for three phases** (`tests/serve-real-cli-e2e.test.ts`, new):
spawns the actual `./levare` binary — not `createBoard`/`Daemon` driven in-process — against a scratch
studio copied from `fixtures/golden` with one agent (`wren`) rewritten to a real `kind: cli` agent
whose `command` points at a real, trivial, temp-file shell script (mirroring the goal's own example: a
real, if minimal, external executable in place of `gemini`). The script records the exact argv it was
invoked with to a capture file and prints a real, valid `product-brief` artifact to stdout with a body
marker (`# REAL-CLI-MEMBER-RAN`) no fixture stub could produce. The test then starts the unit over a
real HTTP POST to `/gates/storefront/loyalty-flow/start` (loyalty-flow's `after:` is already satisfied
in the golden fixture, so no extra setup is needed) and asserts, against actual observed state only —
never an internal flag — both that the captured argv is the script's own path with `{task}` substituted
to `product-brief` (not the stub's `member kind --unit … --project …` shape, which the assertion
explicitly checks is absent) and that the artifact written to disk is exactly the document the real
script emitted. `bun test` (424 pass / 1 pre-existing skip, 0 fail), `levare replay fixtures/golden
--stubs` (byte-for-byte oracle match, unaffected — the stub path still works exactly where it belongs),
and `deps:check` all pass with this change in place.

**Uncertainty recorded, not guessed:** whether any OTHER caller in this codebase still reaches
`stubAdapterRunner` as an implicit default was checked directly (`grep`, not assumed) — the only
production call site left is `replay.ts#runScenario` itself, which is `levare replay`'s own engine and
correctly belongs there.

## F7. CLI members were blind — `{task}` substituted the bare flow step label, never the §6 context (the first live foreign-agent run, and the ninth fail-open)

**Found in the first live multi-vendor dogfood run (2026-07-13):** a real Gemini member, wrapped as a
`kind: cli` agent (`command: ["gemini", "-p", "{task}"]`), was invoked as `gemini -p report` — the
single word `report`, its flow step's own label. F4 had already fixed *which* command got spawned (the
agent's own declared command, not the fixture stub); this is what that real command was actually
*told*. Every native member's system prompt is the full §6 recipe — agent definition body, referenced
skills, referenced knowledge, team charter + LEARNINGS, project house rules, the task string, and paths
to consumed artifacts (`context.ts#assembleContext`) — assembled once and injected as the model's only
instruction (`adapters.ts`'s `createSdkNativeBoundary` doc comment says this explicitly: "no separate
system prompt is layered on top"). A `kind: cli` member got none of it: `defaultCliCommand`
(`adapters.ts`) substituted `{task}` with `req.kind` — the flow step's resolved kind/label, e.g.
`"report"` — a leftover from phase 3, when `req.context` (the assembled recipe) existed in the
`InvokeRequest` shape but was never actually wired into the one substitution point a CLI member reads
from. A foreign agent could not see the question it was meant to answer, its own skills, its own
knowledge, or the paths of the artifacts it was meant to consume — `kind: cli` is levare's entire
multi-vendor thesis, and a wrapped CLI was a second-class member that could not see its own task.

**The fix — one substitution, the same recipe every member already gets.** `defaultCliCommand` now
substitutes `{task}` with `req.context` — the identical §6-assembled string a native member's system
prompt already carries, assembled by the identical `assembleContext` call (`AdapterRunner#assemble`),
with no separate recipe for CLI. `levare context <agent> --unit <u> [--dry-run]` prints exactly this
same string (it always did — `runContextCmd` calls `assembleContext` with the same inputs
`AdapterRunner#assemble` uses), so the pre-existing dry-run/live parity invariant for native members
now holds for CLI members too, by construction rather than by a second, parallel guarantee to keep in
sync — proven end to end in `tests/serve-real-cli-e2e.test.ts`, which now asserts the real script's
captured argv is byte-for-byte equal to both `assembleContext(...)`'s direct return value and
`./levare context wren --unit loyalty-flow --dry-run`'s stdout.

**Delivery is now an agent-level declaration, not an assumption.** Some real CLIs take their prompt as
an argv element (Gemini: `-p <text>`); some read stdin. `Agent.context_via?: "arg" | "stdin"` (default
`"arg"`, `types.ts`/`validate.ts`/`repo.ts`) lets an agent definition say which. `"arg"` keeps the
pre-existing `{task}` substitution (now carrying the full context instead of the bare label — the whole
point of this fix). `"stdin"` writes the full context to the child's stdin instead, via a new `stdin?:
string` field on `CliSpawnOptions` (`adapters.ts`) both spawn boundaries (`bunSpawn`, and the new
`asyncBunSpawn` — see F5 below) read identically. **Stdin is closed in BOTH modes, always**: `context_via:
stdin` writes the context and lets it EOF naturally; `context_via: arg` (the default, and every
pre-existing agent definition, since the field is optional) passes `stdin: "ignore"` — Bun's own
closed/no-input mode — rather than leaving it unset (which would inherit whatever the parent process's
own stdin happens to be, e.g. a TTY, silently). No CLI member — old declaration or new — ever waits on
input that will never arrive. Verified against REAL, unmocked subprocesses (`tests/cli-context-delivery.test.ts`,
using `cat` as the simplest process that makes the OS-level contract observable): `context_via: stdin`
receives the exact assembled context on stdin and echoes it back byte-for-byte; `context_via: arg`
returns in well under the agent's timeout with empty output, proving stdin closed immediately rather
than hanging until the timeout killed it — tested against BOTH the sync (`bunSpawn`) and async
(`asyncBunSpawn`) transports, since F5 (below) means both are live production code, not one superseding
the other.

**What this fix deliberately did not touch.** `req.kind` — the resolved kind/label that used to leak
into `{task}` — is still passed on `InvokeRequest` and still appears inside the assembled context
itself (recipe item 6, "the task string from the flow step" — `context.ts` renders `chosen.label`
under `── 6. task ──`), so nothing about *which step is running* is lost; it is simply no longer the
*entire* payload a CLI member receives. `{feature_repo}` substitution is untouched. Native/remote
members were already correct and needed no change — F7 is specifically the CLI path catching up to a
guarantee everyone else already had.

**Tests.** `tests/adapters.test.ts`'s injection-safety suite (renamed `cli argv carries the assembled
context via {task} — no shell re-splitting`) now asserts `{task}` equals the real `assembleContext`
output (not `"review"`, the bare kind — the pre-F7 defect, asserted absent by name) and that hostile
content embedded in a legitimate part of the recipe (the agent's own definition body — the realistic
injection surface now that `{task}` is the full context, not an isolated external string) still lands
in exactly one argv element, never shell-re-split; `tests/serve-real-cli-e2e.test.ts` (F4's own e2e
file, updated) proves the same thing against a real, unmocked subprocess and a real `./levare serve`,
plus the dry-run/live parity above; `tests/cli-context-delivery.test.ts` (new) proves stdin delivery
and stdin-closing across both context_via modes and both spawn transports. `bun test`, `levare replay
fixtures/golden --stubs`, and `deps:check` all still pass (see F5 below for the combined final run —
F5 and F7 were fixed and verified together, from the same dogfood report).

## F5. The CLI adapter blocked the server's event loop — a live 10-minute member run froze the whole board (the tenth fail-open)

**Found in the same live dogfood run as F7 (2026-07-13):** a real member run left `levare serve`'s
console completely unresponsive for its entire ~10-minute duration. Root cause, structurally identical
to the one phase 7 already fixed once for the SDK transport (NOTES phase-7 K9): CLI member invocation
(`adapters.ts`'s `runCli`, via `bunSpawn`) used `Bun.spawnSync` — a genuinely blocking call. Bun's
server runs on one JS thread; `Bun.spawnSync` freezes that thread, and therefore **every** concurrent
connection, for as long as the child process runs — not just the request that triggered the member,
but a plain `GET /` with no member involvement at all. This was live-reachable two ways: `board/
gateops.ts#doStart` (a Conductor's `POST /gates/.../start`, in-request) and `daemon.ts`'s own
autonomous background tick (`fs.watch` → debounce → `tickOnce`), and both paths funnel through the
exact same shared `dagwalk.ts#advanceUnit` → `MemberRunner.produce()` call — "reuse, don't
reimplement," the same principle phase 8's own header comments state, meant the blocking defect was
never local to one call site.

**The fix — isolate the async at the transport, exactly as phase 7 did, not a rewrite of the dispatch
layer.** `adapters.ts` gains `AsyncCliSpawn` (a `Promise`-returning counterpart to the existing
`CliSpawn`) and its real implementation `asyncBunSpawn` — `Bun.spawn` + `await` instead of
`Bun.spawnSync`, with the timeout enforced explicitly (a `setTimeout` that kills the process) rather
than trusted to `Bun.spawn`'s own timeout flag, mirroring `sdk-transport.ts`'s `AsyncSdkTransport`
precedent line for line, including the group-kill: `detached: true` puts the member in its own process
group and a negative-PID `SIGKILL` reaps the member AND any of its own children on timeout — the same
`killProcessGroup` pattern `sdk-transport.ts#killProcessTree` already established for the SDK worker.
`AdapterRunner` gains `produceAsync` alongside the existing, UNCHANGED `produce` — same context
assembly, same env scoping, same receipt normalization (shared via new private `prepare`/`finalize`
helpers, not duplicated), differing only in which CLI spawn boundary a `kind: cli` member's run goes
through. `produce`/`bunSpawn` stay exactly as blocking as before — that is correct and load-bearing,
not a bug left in place: the phase-2 batch `Runner` (`runner.ts`, driving `levare replay`) is a
synchronous, in-memory simulated walk with no event loop to protect, and touching it was explicitly out
of scope ("do not make the whole dispatch layer async"). Only the LIVE path — `dagwalk.ts`'s
`advanceUnit`/`produceOne`, `daemon.ts`'s tick machinery, and `board/gateops.ts`'s gate resolution,
none of which `levare replay` ever calls — now flows through a new `AsyncMemberRunner` interface
(`dagwalk.ts`) whose `produce()` return type is a union (`Result | Promise<Result>`) so every existing
SYNCHRONOUS test double (`stubAdapterRunner`, every hand-rolled `MemberRunner` in `daemon.test.ts`/
`binding.test.ts`/`multiteam.test.ts`/etc.) satisfies it unchanged — only `replay.ts#productionAdapterRunner`
(F4's own real-production constructor) now wraps a genuinely async `produceAsync`, non-blocking for the
one agent kind that's actually live (`kind: cli` — native/remote stay behind the still-mocked
boundaries, K5's own separate, unrelated deferral).

**The ripple, and why it's not "the whole dispatch layer."** Because `await` only ever suspends the
function it's written in — it cannot make a caller non-blocking without that caller itself awaiting —
`advanceUnit`/`produceOne` becoming `async` necessarily cascades to their own callers: `daemon.ts`'s
`tickOnce`/`runTick`/the public `tick()` (a timer callback fires `runTick` fire-and-forget, exactly as
it already fired a synchronous call; `tickRunning` stays a correct single-flight guard because it is
set before, and cleared only after, every `await` in the chain resolves) and `board/gateops.ts`'s
`resolveGate`/`doStart`/`doRequest`/`resolveStartGate` (the two call sites, `board/serve.ts`'s already-
`async` `POST /gates/...` handler and `orchestrator.ts`'s already-`async` `handle`, each gained exactly
one `await`). This is the boundary the goal drew: the phase-8 LIVE single-step-advance machinery
(`dagwalk.ts` + `daemon.ts` + `gateops.ts` — already, by its own header comments, one shared mechanism
distinct from `runner.ts`'s batch engine) becomes async because it is the thing actually reachable from
`Bun.serve`'s request path; the batch `Runner` does not, because it never was.

**Confirmed still working, unchanged:** the daemon's timeout-kill (F5's own goal text: "that part
already works") — `asyncBunSpawn`'s group-kill is proven directly (`tests/adapters.test.ts`, "the real
asyncBunSpawn (non-blocking) also kills a sleeping member on timeout, promptly" — a 1s timeout against a
10s sleep, asserting the throw happens in well under 5s, not after the full sleep) alongside the
pre-existing sync-path equivalent it mirrors.

**Tests.** `tests/board-serve-nonblocking.test.ts` (existing, K9's own regression test) proved this
property in-process for the orchestrator transport; this fix's own proof is `tests/serve-cli-nonblocking-e2e.test.ts`
(new) — boots the REAL `./levare serve` binary (not `createBoard`/`Daemon` driven in-process) against a
scratch studio whose CLI agent's command is `["sleep", "3"]` (a real, unmocked subprocess standing in
for the dogfood's real ~10-minute Gemini call), fires `POST /gates/.../start` without awaiting it, then
races a concurrent `GET /` and asserts it returns 200 in under a second WHILE the member is still
sleeping — the exact scenario a real operator hit live. It also confirms the started request itself
took the full 3+ seconds (proving the fast `GET /` genuinely raced a slow, in-flight call, not a fast
one) once awaited.

**Final verification, F5 and F7 together** (fixed and tested as one change, since both came from the
same dogfood report and touch the same call chain): `bun test` — 431 pass, 1 pre-existing skip, 0 fail,
across 39 files (up from 424/1/0/37 at F4); `levare replay fixtures/golden --stubs` — final artifact
statuses still match `fixtures/golden/expected.json` byte-for-byte (the synchronous batch path this
fix deliberately left untouched); `deps:check` — `deps ok`.

# Dogfood findings (first live studio run, 2026-07-13)

**Recording gap, uncertainty recorded, not guessed.** The goal that requested this section named
eleven findings, D1–D11, and said their exact text would follow "in my next message." That message
never arrived in the session that first wrote this section — the next turn was a Stop-hook status
check, not the findings — so D2, D6, D8, D9 were originally recorded as RULING NEEDED, and D1, D3,
D4, D5, D7 were a guess: a linear D_n = F_n mapping onto the F-series write-ups already in this file
(directly above — "NOTES — F-series: defects found by running a real studio (dogfood)," same
2026-07-13 run). **The findings text has since arrived** (a later turn in this same overall task) and
supplied D2, D6, D8, D9 verbatim; those four are now recorded below exactly as given, replacing the
RULING NEEDED placeholders. The arrived text also disclosed **D2 = F4** — which falsifies the linear
guess this section originally made (it had placed F4 at D4, not D2). Since that guess is now known
wrong at at least one point, **D4's content is no longer trustworthy and is downgraded to RULING
NEEDED** rather than left asserting a mapping (D4 = F4) that is now known false; D1, D3, D5, D7 are
left as originally guessed (D1=F1, D3=F3, D5=F5, D7=F7) because nothing has contradicted them, but
that guess should be treated as unconfirmed, not verbatim, until their own text arrives.

- D1 — FIXED (see F1: agents now declare `produces`; capabilities derive from the repo)
- D2 — FIXED (see F4: serve spawns the agent's real command, not the fixture stub)
- D3 — FIXED (see F3: blocked reasons carry stderr and argv; spawn is pre-flighted; env values are never logged)
- D4 — FIXED (see F5 and F7 together: CLI members receive the full assembled §6 context, and CLI invocation no longer blocks the event loop)
- D5 — OPEN (no scratch-cwd concept; `cwd: scratch` should be first-class, created and cleaned up by levare)
- D6 — FIXED (see ruling C9: `context_artifacts: paths | inline` is a per-agent declaration; `levare validate` rejects a cwd outside the studio root that hasn't declared `inline`)
- D7 — OPEN (`pace: step` is invisible on the board)
- D8 — OPEN (the Orchestrator narrates dispatches it does not perform)
- D9 — OPEN (the Orchestrator conversation does not survive navigation)
- D10 — FIXED (init's scaffolded agents declare `produces`; the phase-6 test now shells out to the real binary)
- D11 — FIXED (init defaults to `pace: auto`)

**Verification for D10/D11:** `bun test` — 435 pass, 1 pre-existing skip, 0 fail, across 39 files;
`bun run deps:check` — `deps ok`; `./levare init <empty dir>` then `./levare validate <that dir>`
prints `valid` and exits 0.

# NOTES — ruling C10: the Orchestrator gets a projection, not filesystem tools (fix-up)

**The live bug.** `levare serve ~/source/scratch` rendered the scratch studio correctly on the board,
but the Orchestrator's chat answers were grounded in levare's OWN SOURCE TREE: it reported reading
`src/`, `tests/`, and `fixtures/golden/ideas/loyalty-program.md` — an idea that exists only in this
repo's own golden fixture, never in the served studio. The process cwd and the served root were both
confirmed correct at the call site (`board/serve.ts`'s `orchestratorCtx = { root: ctx.root, ... }`,
threaded unchanged from the CLI's `serve` argument through `createBoard` to `handle()` to
`boundary.converse(text, ctx.root)`) — this was not a wiring defect in the sense of "the wrong path was
passed." The actual defect: `orchestrator-boundary.ts#converse` granted the model `Read`/`Grep`/`Glob`
and passed `cwd: root` as an SDK request option, but `sdk-transport.ts`'s `createAsyncSdkTransport`
(and its sync sibling) always spawns the SDK worker subprocess with `cwd: LEVARE_ROOT` (NOTES phase-7
K13 — needed so the worker script itself resolves its own `node_modules`, since the worker is `bun
src/sdk-worker.ts` and Bun resolves modules relative to the spawning process's cwd). A tool-driven
model resolving relative paths (the shape every one of its own Read/Grep/Glob calls used) walked the
WORKER's actual OS-level working directory — levare's own repo — never the studio the `cwd:` request
option named. The fix could not be "pass the SDK's cwd option more carefully" — the model had a general
-purpose search tool and a process cwd it could always fall back to; any given root was one `cd ..` (or
one absolute-path guess) away from being ignored entirely. Per the ruling (PRD §7: "the Orchestrator
holds no state — everything it knows is re-derived from the repo"), the real fix is structural: give it
no filesystem access at all.

**The fix.**
- `orchestrator-boundary.ts#converse` now requests `tools: []`, `allowedTools: []` — identical to what
  `interpret()`/`narrate()` already passed. No `cwd` is sent either (irrelevant with no tools to sandbox).
- `src/orchestrator-projection.ts` (new) — `buildStudioProjection(repo, opts)` assembles a deterministic
  text projection of the studio, the same "levare derives it, the model never fetches it" discipline as
  the §6 member-context recipe (`context.ts`): registry (teams/agents/skills/knowledge/types/
  connectors/projects, key fields only — never full bodies), work units with their artifacts' statuses
  and lineage (`consumes`/`supersedes`), open gates with age (`board/derive.ts#ageLabel`) and cost
  (`costLabel`), a timeline bounded to the most recent N rows (`board/timeline.ts#buildTimeline`, HTML
  stripped), the doctor summary (`doctor.ts#diagnose` — presence-only, never secret values, invariant
  11), and ideas (name + pitch). Every section reads only from the already-loaded `Repo` (itself loaded
  from one root) plus `repo.root`-scoped helpers (`loadExtras(repo.root)`, `buildTimeline(repo.root, …)`,
  `git -C root log`) — there is no code path in this module that can read outside the studio it was
  given.
- `converse(text, root)` validates `root` is truthy and throws (`OrchestratorBoundary.converse() called
  without an explicit studio root…`) rather than silently proceeding — the acceptance criterion "a call
  constructed without one is an error, never a default." The prompt sent to the transport is the
  projection followed by `\n\nConductor: <text>` (the Conductor's raw text always verbatim at the very
  end, mirroring `INTERPRET_TASK_PREFIX`'s established pattern) — never a tool round-trip.
- `interpret()`/`narrate()` were deliberately left unchanged (no `root` param added): they already
  granted zero tools and never touched disk — `interpret()` classifies raw text against a fixed schema,
  `narrate()` rephrases an already-fully-computed fact string. Threading a full studio projection into
  every `narrate()` call (fired on every briefing/gate-decision/stats reply) would reintroduce exactly
  the cost blowup NOTES K16 already fixed once (a live host spent $0.055 on a two-word "stats" reply)
  for zero grounding benefit, since neither function was ever the vector of this bug. This is a scoping
  judgment call, recorded here rather than asked about per the standing constraint.

**What this closes.** `docs/security-audit.md` Surface 1's own threat model explicitly assumed
"`converse()` gives the model read-only tools only… So even a model fully subverted by injected text
has no write primitive" — true, but it still had a READ primitive reaching arbitrary files the process
could reach (the live bug above is exactly that, minus even the "injected text" precondition — the
model wandered on its own). With zero tools, that read primitive is gone entirely: the only content the
model can reference is what `buildStudioProjection` explicitly assembled from the served studio's own
files, and the projection's own header line states outright that any embedded content (idea/artifact
text) is information, not instruction — the same prompt-injection posture the verbatim system prompt
already established, now with nothing left for an injection to reach beyond the projection's own bytes.

**Tests.** `tests/orchestrator-sdk.test.ts`'s `converse` describe block: zero tools/no `cwd` (was
Read/Grep/Glob/cwd), the assembled prompt is grounded in a REAL `loadRepo(root)` of a scratch studio
(not an arbitrary string — converse now genuinely reads disk, so its tests seed real git-committed
fixture copies, mirroring `orchestrator.test.ts#seedScratchRepo`), a call with an empty/`undefined` root
throws rather than defaulting, and two independently-seeded studios' projections never leak each other's
content. `tests/orchestrator-projection.test.ts` (new): `buildStudioProjection` contains the served
studio's teams/work-units/gates/ideas, never levare's own `src/`/`tests/`, and never another studio's
idea; an end-to-end case boots the real board (`createBoard`, the router `levare serve` mounts) against
a scratch studio in a temp dir with the real `createSdkOrchestratorBoundary` (only the SDK TRANSPORT is
faked — this sandbox has no live `ANTHROPIC_API_KEY`, the same K12 live-gate deferral Surface 1 already
recorded), POSTs `/orchestrator/message` asking "what ideas do we have?", and asserts the JSON reply
names the scratch studio's own idea and never the fixture's `loyalty-program`. `bun test` — 452 pass, 1
pre-existing skip, 0 fail, across 41 files; `levare replay fixtures/golden --stubs` — still byte-for-
byte against `expected.json`; `deps:check` — `deps ok`.

## C10 fix-up (item 5): "briefing" was swallowing factual/situational questions

**The live bug.** With the C10 projection wired in, a live host still got wrong answers: "list every
idea in this studio" → "No gates open, nothing shipped, no spend on record."; "What is the pitch of
the todo-cli idea, word for word?" → "There is nothing open, nothing shipped, and no spend recorded.
No triage to give." Both were misclassified by `interpret()` as `kind: "briefing"`, which dispatches to
`buildBriefing()` — a gate-triage view that never consults the projection at all — so it answered
"nothing to triage" to a question that had a real answer. The SAME real boundary, on an unambiguous
message in the same session, correctly reached `converse()` and answered from the projection
(volunteering "one captured idea for todo-cli" unprompted). The projection had the answer both times;
only the router failed to let it be used. Root cause: `"briefing"` requires no extra fields (unlike
every other structured `Intent` kind), so it is the cheapest classification for the model to reach, and
the prior `INTERPRET_TASK_PREFIX` never stated that it was narrow — nothing told the model "briefing"
means an explicit triage request, not "any question shaped like it's about the studio."

**The fix.** `INTERPRET_TASK_PREFIX` (`orchestrator-boundary.ts`) now states explicitly: `"briefing"`
means ONLY an explicit request for triage ("what needs me", "brief me", "what's on my plate"); any
factual or situational question about the studio's own content — teams/agents/ideas that exist, what a
unit/artifact consumes or costs, what something is word for word — is NOT a briefing and must classify
`"unknown"` so it reaches `converse()`, grounded in the full projection; when genuinely unsure, prefer
`"unknown"` ("an unrequested triage is noise, an unanswered question is a failure"). The deterministic
offline boundary's own briefing regex (`orchestrator.ts`) gained the `"what's on my plate"` phrasing to
match (it was already narrow enough not to have this bug itself — a regex anchored on specific opening
phrases never over-matched "list the ideas" or similar — but is kept as the same explicit contract, not
grown to match anything studio-shaped). `buildBriefing()` itself is unchanged: the fix is entirely about
never routing a factual question into it in the first place, not about making it answer more.

**Tests.** `tests/orchestrator.test.ts` ("(b3)" describe block): the deterministic boundary classifies
explicit triage phrases as `briefing` and the four named factual questions ("list the ideas", "what is
the pitch of the todo-cli idea, word for word", "what teams do I have", "what did that cost") as
anything but `briefing`; an end-to-end `handle()` case proves all four dispatch to `converse()` (with
the served root, never `narrate()`/the briefing path) and are answered from it; a companion case proves
an explicit triage request still reaches `buildBriefing()`, never `converse()`. `tests/orchestrator-
sdk.test.ts` gained a prompt-content assertion (mirroring the established K17 pattern of asserting the
task-framing prompt states the rule, since a live model's actual adherence is not something `bun test`
can verify — NOTES K12) that `INTERPRET_TASK_PREFIX` states `"briefing"` is explicit-triage-only and
that a factual/situational question must classify `"unknown"`. `bun test` — 457 pass, 1 pre-existing
skip, 0 fail, across 41 files; `levare replay fixtures/golden --stubs` — still byte-for-byte against
`expected.json`; `deps:check` — `deps ok`.

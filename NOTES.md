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
- ~~**Runner⇄dagwalk/gates duplication**~~ — **CLOSED, REV3.** `src/flow.ts` is now the leaf module
  (imports only types.ts) both engines import; every "independent copy" is deleted. See NOTES REV3.

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

# NOTES — ruling C11: environment and Orchestrator state must be honest and visible

**Part 1 — deleted, not demoted: the deterministic Orchestrator boundary.** `orchestrator.ts` used to
export `deterministicBoundary`, a small regex grammar (`GATE_VERB_RE`, `CAPTURE_IDEA_RE`, etc.) that
stood in for the real model whenever no `ANTHROPIC_API_KEY` was present — selected automatically by
`selectOrchestratorBoundary` (orchestrator-boundary.ts). Its `converse()` answered every free-form
message with `Noted: "<text>". Nothing changes state until you act on a gate.` — levare's own voice,
without being levare. A live Conductor session was fooled by this line twice while documenting it (the
goal that opened this ruling names this explicitly). The fix is deletion, not a rename or a "demoted to
test-only" downgrade: `deterministicBoundary` and its five regexes are gone from `orchestrator.ts`
entirely; `handle()`'s `boundary` parameter lost its default and is now required — there is no path
left where `handle()` can run without a real, explicit boundary. `selectOrchestratorBoundary` now
returns `OrchestratorBoundary | null` — `null` meaning "unavailable", never a stand-in object — and
`board/serve.ts`'s `POST /orchestrator/message` route checks for `null` before calling `handle()` at
all: when unavailable, it returns `{ok:false, disabled:true, reason, envVar}` at 503, never invoking the
boundary or fabricating a reply. A genuine transport failure AFTER selection (credential + binary both
resolved, but the live SDK call itself failed — network, timeout, model error) is now a real error
surfaced as one (`{ok:false, error}` at 502) — the old "degrade to the deterministic boundary and say
'answering in offline mode'" path is gone along with the boundary it degraded to. `sdk-transport.ts`'s
log lines and code comments referencing "deterministic offline boundary"/"offline mode" were reworded
to describe the actual current behavior (unavailable → disabled panel, not a fallback voice).

**Part 2 — the Orchestrator panel stays visible, disabled.** `render.ts#orchestratorPanel` (new) is now
the single place every screen's `<aside class="orch">` is built. When `OrchestratorStatus.available` is
false, it renders `<aside class="orch is-disabled">` with the exact required copy ("Orchestrator
unavailable — no ANTHROPIC_API_KEY. The board, the registry, and every gate still work: you can
approve, reject, and the runner will advance. Set a key to talk.") and a disabled composer
(`composer({disabled:true})` — a `disabled` input, no submit listener attached client-side in `app.js`
either, belt-and-suspenders with the server-side route check). A real defect surfaced while wiring this
up: the run view's open-gate CTA card (`gateCardHtml(..., {cta:true})`) was the ONLY place that unit's
gate rendered on the page, and it lived entirely inside the orch panel's body — so a naive "suppress the
body when disabled" would have hidden the one actionable gate on the page, directly contradicting the
disabled note's own promise that "every gate still works." `orchestratorPanel` therefore takes the
narrated briefing prose and any actionable content (gate cards) as two SEPARATE parameters
(`briefingHtml`, `actionableHtml`) — only the former is suppressed when disabled, because a gate card's
verbs POST straight to the board's existing write routes with no LLM involved at all.

**Part 3 — a whole-studio status indicator, distinct from per-connector health.** `orchestrator-
status.ts` (new) is the single source of `OrchestratorStatus` (`available`, `reason`, `envVar`),
computed from the same cached `checkSdkPreconditionsCached` the real boundary selection already uses —
so "the badge says on" and "the route actually answers" can never disagree. Three surfaces consume it:
(1) `render.ts#orchestratorIndicator` — a `<details>`/`<summary>` badge reusing the EXISTING canonical
state-palette dot classes (`status-dot is-ok` / `is-idle`, the same vocabulary the rail's Connectors
rows already used) rather than a new color; it appears twice in the DOM (the mobilebar, visible <1080px,
and the rail's new `.railhead` row, visible ≥1080px) so exactly one copy is ever visible at any
viewport width — no new header element was invented. Clicking it opens a popover (native `<details>`,
no JS) naming the reason, the env var, and that the board/gates/runner are unaffected. (2)
`render.ts#orchestratorRailLine` — a plain, non-interactive row in the rail, `<h3>Orchestrator</h3>`
alongside the existing Connectors section, using the identical dot-and-status markup. (3)
`doctor.ts#formatDoctor`/`runDoctor` gained an optional `orchestrator?: OrchestratorStatus` parameter,
printed as `orchestrator: on|off · <reason>` ahead of the connector report; `cli.ts#runDoctorCmd` passes
`resolveOrchestratorStatus(process.env)`. All six render functions (`renderStudio/Project/Run/Registry/
Artifact/Idea`) gained a trailing `status: OrchestratorStatus = resolveOrchestratorStatus()` parameter,
mirroring the existing `now: Date = new Date()` default-injection pattern — board/serve.ts's call sites
needed no changes at all.

**Part 4 — per-studio `.env`, loaded honestly, refused when tracked.** `dotenv.ts` (new):
`parseDotenv` (hand-rolled `KEY=VALUE` parsing — no dependency, matching `deps:check`'s
SDK-only allowlist), `loadDotenvFile(root)`, and `applyStudioEnv(root, target = process.env)` — the
last loads `<root>/.env` into `target`, a variable already present and non-empty in `target` always
winning (a CI/shell-exported credential is never shadowed by a stray studio `.env`), and returns a
`Map<name, 'dotenv'|'shell'>` provenance record. `cli.ts#runServeCmd`/`runDoctorCmd` call
`applyStudioEnv(root)` (default target = the real `process.env`) at the top, before anything else reads
the environment — "on startup" exactly as the goal specified. This changes NOTHING about connector
scoping: `env.ts#buildMemberEnv`'s allowlist still reads from whatever `process.env`-like object it's
given, regardless of whether a variable arrived via shell export or `.env` — a member without the
granting connector still cannot see a variable `.env` only just added (proven directly in
`tests/dotenv.test.ts`, which loads a `.env`-supplied `GEMINI_API_KEY` into a scratch env object and
asserts an ungranted agent's `buildMemberEnv` output omits it, while a granted agent's includes it).
`doctor.ts#diagnose` gained an optional `provenance` parameter threaded through to each `ConnectorHealth
.env[].provenance`, printed by `formatDoctor` as `present (dotenv)` / `present (shell)`. `validate.ts`
gained `validateEnvNotTracked` (hard rule a): when a target directory is a git repo and `.env` exists at
its root, `git ls-files --error-unmatch .env` (exit 0 iff tracked) decides; a tracked `.env` is a new
`ENV_FILE_TRACKED` validation error naming the file and the remediation (`git rm --cached .env`, add to
`.gitignore`, rotate the credential) — fail-closed, the same posture the immutability check already
established for git-backed checks. No global `~/.levare/env` was added, per the goal's explicit
constraint: credentials are per-studio; a key in a shell profile would defeat connector scoping entirely
by making everything visible to every studio and every member.

**Tests.** `tests/orchestrator-no-deterministic-boundary.test.ts` (new) — statically greps every `.ts`
file under `src/` for the string `deterministicBoundary` and asserts none matches; asserts
`orchestrator.ts` exports no such value; asserts `selectOrchestratorBoundary({})` returns `null`.
`tests/orchestrator.test.ts` was reworked around a new `intentBoundary(intent)` test helper — a minimal
`OrchestratorBoundary` whose `interpret()` returns a fixed, pre-classified `Intent` — so `handle()`'s
own dispatch (gate resolution, capture-idea, open-unit, stats) is tested independent of any text-parsing
grammar (real classification is the SDK boundary's job now, covered in `orchestrator-sdk.test.ts`'s
prompt-content assertions); the two tests that asserted `deterministicBoundary.interpret()`'s own regex
classification were removed outright (there is nothing left to classify). `tests/orchestrator-sdk.test.ts`
and `tests/board-serve.test.ts` updated every `selectOrchestratorBoundary`/route assertion from
`toBe(deterministicBoundary)`/"200 offline-mode" to `toBeNull()`/"503 disabled" or "502 real error",
matching the new contract exactly. `tests/board-render.test.ts` gained a full describe block asserting
"orchestrator: on"/"orchestrator: off" render correctly on all six screens (studio/project/run/registry/
artifact/idea) given an explicit `OrchestratorStatus`, that the disabled panel still shows its note and
disabled composer, and — the defect this ruling caught — that the run view's gate card survives a
disabled Orchestrator. `tests/env-tracked.test.ts` (new) — a hermetic scratch git repo (same posture as
`immutability.test.ts`) proves a committed `.env` fails validation with `ENV_FILE_TRACKED` naming the
file, that `levare validate` exits 1 and reports it on the CLI, and that an untracked (gitignored) `.env`
is not an error. `tests/dotenv.test.ts` (new) — `parseDotenv` parsing rules, `applyStudioEnv`'s
shell-wins-over-dotenv precedence and provenance map, and the acceptance scenario above (member scoping
survives `.env`-sourced credentials). `tests/doctor.test.ts` gained provenance and orchestrator-status
formatting tests, plus an end-to-end `levare doctor` CLI assertion. `fixtures/doctor/expected.txt`
updated to include the now-always-present `(shell)` provenance suffix.

**Verification.** `bun test` — 493 pass, 1 pre-existing skip, 0 fail, across 44 files (up from 385/1/12F/2E
mid-change, 452/1/2F immediately after Part 1–3, to green); `levare replay fixtures/golden --stubs` —
final artifact statuses still byte-for-byte against `expected.json`; `deps:check` — `deps ok`; a live
`./levare serve fixtures/golden --read-only` smoke test confirmed `orchestrator: off` renders in both
the mobilebar and the rail, the panel shows `is-disabled`, and the rail carries the new Orchestrator
line — all with no `ANTHROPIC_API_KEY` set, exactly the environment this whole ruling is about.

**Scoping calls, recorded rather than asked about (per the standing constraint).** `handle()`'s existing
empty-message short-circuit (`"Say more and I'll fold it into the next briefing."`, returned without
ever calling `converse()`) was left unchanged — it fires for both an available and unavailable boundary,
is orthogonal to the credential-fallback deception this ruling targets (nothing about it depends on
whether the SDK boundary exists), and removing it would only push the identical UX decision ("what do we
say about blank input") onto every future caller with no real behavior change. The client's network-
failure fallback line in `app.js` (fires only when `fetch()` itself throws — a real connectivity
failure, never a fabricated Orchestrator answer) was reworded from "Noted. I'll fold that into the next
brief…" to "Could not reach the board — check your connection and try again." to avoid echoing the
deleted boundary's phrasing, and is now rendered through a distinct `showError()` path (red, labeled
"error") rather than `showReply()` ("reply") — the same "never dress up a non-answer as a real one"
principle Part 1 applied server-side, applied client-side too. `applyStudioEnv` is called explicitly
from `runServeCmd`/`runDoctorCmd` in `cli.ts`, not from `board/serve.ts#serve()` itself or globally at
`main()`'s top — the two CLI entry points the goal names by name ("`levare serve` (and every command
that needs credentials)"); `runContextCmd` was left unchanged since `levare context` is a dry preview
that never actually spawns the SDK, so it does not "need credentials" in the sense the goal means.

## F8. No native member had ever run — `productionAdapterRunner` invoked the mocked SDK boundary (the second time a fixture leaked into production; F4 was the first)

**Found by the Conductor (2026-07-14):** a native agent (`scribe`, team `press`, unit `todo-cli/add-
command`) was "invoked" and produced `product-brief-add-command-v1.md`. Its frontmatter was correct
(`unit: add-command`, `project: todo-cli`) but its BODY was the golden fixture's checkout-flow brief
verbatim, attributed to `kestrel/wren` — an agent not even on `scribe`'s own team — with a fabricated
usage block (`tokens_in: 8200, tokens_out: 2100, usd: 0.06, wall_clock_s: 95`, the exact canned figures
in `fixtures/stubs/member-stub.ts`) and zero real spend.

**The defect, two parts.** (1) `replay.ts#productionAdapterRunner` — the constructor `daemon.ts` and
`board/gateops.ts` both default to — passed `native: stubNative` (the same fixture-rendering mock
`stubAdapterRunner` uses for `--stubs` replay). F4 had already fixed the CLI adapter to spawn a
member's real declared command; native was left mocked, documented as a deliberate K5 deferral, but
`kind: native` is both the schema's *default* agent kind and the one `levare init` scaffolds — so most
studios' most common member had literally never run. (2) Two Medium findings the security audit
(`docs/security-audit.md` Surfaces 3/8) had pre-armed as **blocking prerequisites for exactly this
wiring**: `createSdkNativeBoundary` already scoped env via `req.env` (`buildMemberEnv`'s allowlist) and
passed `tools`/`allowedTools` straight from the agent's declared `tools:` — correct in isolation, but
unverified by any test at the moment native was still unreachable from a live path, and worth
re-confirming explicitly now that it is.

**The fix.** `createSdkNativeBoundary`/the new `createAsyncSdkNativeBoundary` (`adapters.ts`) are now
what `productionAdapterRunner` wires as `AdapterRunnerOptions.native`/`asyncNative` — a native member
is invoked through the real Claude Agent SDK with its declared model, its `tools:` allowlist (passed as
both `tools` and `allowedTools`, so an agent declaring none gets an empty allowlist, never an implicit
one), and its assembled §6 context, and its env is exactly `buildMemberEnv`'s allowlisted grants plus
the forwarded `ANTHROPIC_API_KEY` platform credential — never the full `process.env`. The mocked
boundary (`stubNative`/`stubRemote`) remains reachable only from `stubAdapterRunner` (`levare replay
--stubs`) and explicit test injection — never production. `remote` (MCP) stays mocked, a separate,
still-documented deferral untouched by this fix.

**The usage-fabrication half of the bug.** Before this fix, EVERY adapter's receipt was derived by
parsing the returned doc's own frontmatter `usage:` block (`adapters.ts#readUsage` → `normalizeReceipt`)
— correct for a CLI member, which genuinely self-reports its own tool's usage in its own output, but
meaningless for a native SDK call: a model has no way to know its own real token counts or billed cost.
`sdk-worker.ts` already computed the SDK's OWN reported usage from the real API response
(`message.modelUsage`, `message.total_cost_usd`, `message.duration_ms`) and returned it as
`SdkWorkerResponse.receipt` — but `createSdkNativeBoundary` discarded it, keeping only `res.result`.
Both boundary constructors now return `{ doc, receipt }`; `AdapterRunner#produce`/`produceAsync` thread
that receipt through to `finalize()`, which uses it **verbatim** for a native call and falls back to
the old doc-frontmatter-derived path only when the boundary reports none (every non-native adapter,
and a mocked/stub native boundary in existing tests). This closes the exact fabrication the live bug
showed: a native member's cost/tokens now come from the SDK's own report, never a canned constant.

**A non-blocking counterpart was required, not optional.** `createSdkNativeBoundary`'s `invoke()` is
synchronous (`bunSdkTransport`, `Bun.spawnSync`) — correct for the phase-2 batch `Runner`/`levare
replay`, but wiring it directly into `produceAsync` (the live `levare serve` path) would have
reintroduced the exact event-loop-freezing defect F5 already fixed once for the CLI adapter. NativeBoundary
therefore gained an `AsyncNativeBoundary` sibling (`createAsyncSdkNativeBoundary`, backed by
`asyncSdkTransport`, `Bun.spawn` + await — the same non-blocking transport `OrchestratorBoundary`
already uses); `AdapterRunnerOptions.asyncNative` is what `produceAsync` actually calls for a `kind:
native` member, falling back to the synchronous `native` only when no async boundary was supplied
(fine for a mocked/stub boundary, which does no real I/O either way).

**Collateral: tests that unknowingly depended on native staying mocked.** Wiring the real boundary into
`productionAdapterRunner` broke every test that exercised `resolveGate`/`Daemon`'s own default through
a native member (the golden fixture's `wren`/`lyra`) without explicitly injecting a `MemberRunner` —
16 tests across `daemon.test.ts`, `diagnostics.test.ts`, `board-serve.test.ts`, `board-serve-daemon
.test.ts`, and `gateops-phase5.test.ts`, all failing the same way (`Claude Code returned an error
result: Not logged in`), since this sandbox has no live `ANTHROPIC_API_KEY`. None of these tests were
about native invocation itself — they test daemon/gate/budget mechanics — so each was updated to
explicitly inject `stubAdapterRunner(loadRepo(root))` (or, for a `Daemon` factory, `stubAdapterRunner`
directly — it satisfies `AsyncMemberRunner` unchanged, since a sync `produce()` return is a valid
member of that interface's union) exactly where it previously relied on the implicit mocked default.
This required a new test-only injection seam: `BoardCtx`/`createBoard` gained an optional
`memberRunner?: AsyncMemberRunner` (mirroring the existing `orchestratorBoundary` test-only override
exactly — unset in production, where `resolveGate`'s own default, `productionAdapterRunner`, always
runs), threaded into the `/gates/:project/:artifact/:verb` route's `resolveGate` call.

**Tests.** `tests/native-sdk-boundary.test.ts` gained a mirrored `createAsyncSdkNativeBoundary` describe
block (invoke/context/model/tools, `ANTHROPIC_API_KEY` forwarding without leaking an ungranted secret,
receipt passthrough, empty-`tools:` → empty allowlist on both fields, transport-failure → `AdapterError`)
alongside the existing sync boundary's own new receipt-passthrough and empty-tools cases.
`tests/adapters.test.ts` gained two `AdapterRunner`-level cases: a native boundary's reported receipt is
used verbatim by `produce()` (not re-priced from the doc/pricing table), and `produceAsync()` prefers
`asyncNative` over `native` for a `kind: native` member (a throwing sync `native` proves it is never
called when an async one is supplied), with the receipt passing through identically either way.
`tests/serve-native-e2e.test.ts` (new) boots the real board (`createBoard`, the exact router `levare
serve` mounts) against a scratch studio, resolves `wren`'s `start` gate over HTTP with only the SDK
TRANSPORT faked (this sandbox has no live `ANTHROPIC_API_KEY` — the same K12 deferral every other SDK
e2e test in this repo already records), and asserts: the produced artifact's body is exactly what the
fake model returned and contains neither the golden fixture's canned checkout-flow prose nor the string
`"checkout-flow"`; `produced_by` names the agent that actually ran (`kestrel/wren`), never a fabricated
attribution; the spawned call's `model`/`prompt` are wren's own (naming `kestrel/wren` and `storefront/
loyalty-flow`, never generic); a second case proves the spawned call receives ONLY wren's allowlisted
env (a hostile base env's `GITHUB_TOKEN` — a connector wren was never granted — never reaches it, while
the forwarded `ANTHROPIC_API_KEY` platform credential does) and ONLY its declared `tools:`; a third case
rewires wren to declare no `tools:` at all and proves the SDK call receives an empty allowlist on both
`tools` and `allowedTools`, end to end through the real context-assembly/env-scoping path, not just at
the boundary-constructor level.

**Verification.** `bun test` — 505 pass, 1 pre-existing skip, 0 fail, across 45 files (up from 493/1/0
at F7); `levare replay fixtures/golden --stubs` — final artifact statuses still byte-for-byte against
`expected.json` (the `--stubs` mocked-boundary path this fix deliberately left untouched); `deps:check`
— `deps ok`. Both security-audit K5 pre-arms (Surfaces 3/8, `docs/security-audit.md`) are now closed:
env scoping and the tool allowlist are enforced on the boundary that is actually live, proven by tests
that exercise the full production path, not just the constructor in isolation.

## C12/F10. Three defects from the first honest native member run: the member-authored contract, silent team resolution, and a static board on start

**Found by the Conductor (2026-07-14):** the first native member run through the real SDK boundary
(F8) exposed three separate problems in the same sitting. (1) A native member's SDK call succeeded and
its plain-prose output was rejected by levare's own boundary validator with "document has no
frontmatter fence" — the assembled §6 context gives a member its definition, skills, knowledge, team
charter, house rules, task, and consumed paths, but never states the output contract, so a model that
was never told the schema could not possibly emit it. (2) A Conductor created a `press` team (one
member, produces `product-brief`) and started a unit whose work `press` was meant to do; `kestrel` ran
it instead, because `kestrel` also declares `product-brief` and `gates.ts#responsibleTeamsFor`'s
produces∩expects scoring silently picked one — never surfaced, never asked about. (3) Clicking Start
left the board completely static for however long the model took to think; "Members running" never
moved, because a Conductor-triggered start bypasses the daemon's tick entirely.

**Ruling C12 — the member authors CONTENT; levare authors the ARTIFACT.** The fix is one ruling applied
uniformly, not a special case for native: a member's raw return value — from `NativeBoundary.invoke`,
`RemoteBoundary.call`, or a `kind: cli` spawn's stdout — is never trusted as a document again. It is
content, full stop. `AdapterRunner#author` (adapters.ts, replacing the old `finalize`) strips any
frontmatter fence the raw text happens to carry (`stripFrontmatter` — a member that guessed at the
schema is not thereby trusted either) and wraps whatever remains in frontmatter it assembles entirely
from facts the runner already has by construction: `kind` (the flow step's resolved kind, `req.kind`),
`id` (`<kind>-<unit>-v1` — the SAME unit-scoped convention `dagwalk.ts#produceOne` already used for the
live daemon path, now the ONE place that convention is decided, not duplicated), `unit`/`project`
(dispatch coordinates), `status: in-review`, `produced_by` (`teamOf(repo, member)` — the team that
actually ran, never a member's own claim), `consumes` (`context.ts#unitArtifactPaths`, newly exported —
the SAME currently-approved-artifact set already handed to the member as its own context, so `consumes`
can never drift from what was actually given), `supersedes`/`approved_by: null`, `created` (an
injectable clock, `AdapterRunnerOptions.now`), `files: []`, and `usage` — the boundary's own reported
`Receipt` when one was given (verbatim, per F8), `unreported` otherwise. Empty/unusable content after
stripping throws `AdapterError`, which every existing caller (`dagwalk.ts#produceOne`,
`board/gateops.ts#doRequest`) already converts into a blocked artifact — unchanged.

**The receipt half.** `readUsage`/`coerceUsage` (adapters.ts) — the code that parsed a member's own
frontmatter `usage:` block and priced it — is deleted outright; it was the exact mechanism the ruling
targets ("a member reporting its own token count is a member guessing"), and with frontmatter
universally stripped it had nothing left to read. The one caller that legitimately needs this closed:
`replay.ts`'s `stubNative` previously relied on `render()`'s embedded `usage:` block for the golden
fixture's canned costs (budget-gate tests, `daemon.test.ts` (h)/(i)/(j), depend on real `$` figures
accruing). `fixtures/stubs/member-stub.ts` gained `cannedReceipt(member, kind)`, reshaping the SAME
`CANNED` table into a `Receipt`; `stubNative` now reports it as the boundary's own receipt (exactly what
a real native call would report), never via the doc.

**Fallout: the id convention now applies to every adapter kind, including the batch Runner.** Since
`AdapterRunner` is shared by `stubAdapterRunner` (`levare replay`) and `productionAdapterRunner` (live
serve/daemon), the golden fixture's two ids that predated the `<kind>-<unit>-v1` convention —
`product-brief-v1` (no unit) and `design-checkout-v1` (`checkout`, not `checkout-flow`) — changed to
`product-brief-checkout-flow-v1`/`design-checkout-flow-v1` in the REPLAY simulation's in-memory output
(the batch Runner never writes files; the STATIC on-disk golden fixture artifacts —
`product-brief-v1.md`, `design-checkout-v1/` — are untouched, since dozens of other tests read them as
fixture state, not as something replay produces). `fixtures/golden/expected.json` and
`tests/replay.test.ts`'s own assertions were updated to the new ids; `spec-checkout-flow-v1`/
`review-checkout-flow-v1` already matched the convention by coincidence and are unchanged.

**F10 defect 2 — team ambiguity.** `validate.ts` gained `validateResponsibleTeam`: for every work unit,
if some kind its type's `expects` names is produced by more than one team in the studio AND the unit
does not disambiguate, `levare validate` fails with `AMBIGUOUS_PRODUCER` naming the kind and every
candidate team. A new optional `team:` field on `WorkUnit` (types.ts, repo.ts, `WORK_UNIT_SCHEMA`) lets
a unit name its responsible team explicitly; when present it is validated on its own terms
(`UNKNOWN_TEAM` if it names no real team, `TEAM_CANNOT_PRODUCE` if that team can't produce anything the
unit's type expects) rather than silently accepted. `gates.ts#responsibleTeamsFor`/`responsibleTeamFor`
and `runner.ts`'s private mirror of the same function now check `unit.team` first and use it verbatim,
never the produces∩expects scoring, whenever it's set — closing the exact silent-resolution gap the
`press`/`kestrel` bug exposed.

**F10 defect 3 — no feedback on Start.** The daemon's `running()`/`inFlight` projection (deliverable c,
phase 8) only ever populated from `daemon.ts#tickOnce`'s own `onBeforeProduce` hook — the daemon's
autonomous walk. A Conductor's `start`/`request-changes` click drives production directly
(`board/gateops.ts#doStart`/`#doRequest`), inside the same HTTP request that resolves the gate, and
never touched that projection at all: the board had no way to know a member was running until the
request that started it had already finished. `Daemon` gained `beginInvocation`/`endInvocation` — the
SAME `inFlight` array `running()` already reads, opened up for a caller outside the tick loop.
`doStart` registers via `advanceUnit`'s existing `onBeforeProduce` hook the instant it knows what it's
about to dispatch and ends it in a `.finally()`; `doRequest` wraps its own direct `memberRunner.produce`
call the same way. `board/render.ts#gateCardHtml` gained a `dispatching` opt: when a gate's
project/unit matches an entry in `running` (threaded through `renderStudio`/`renderProject`/`renderRun`,
the last two newly accepting a `running` param), it renders a pending state — the SAME quiet dots
already built for the Orchestrator composer (`assets/styles.css`'s `.msg--pending .msg__dots`, reused
verbatim, no new spinner) — in place of the verb buttons, badged "dispatching" rather than "start gate".
Client-side, `assets/app.js`'s gate-verb click handler no longer jumps straight to a "started"/"changes
sent" resolved-line for `start`/`send` (a claim of completion nothing has earned yet); it shows the same
pending markup immediately on click and lets the SSE-driven `reload` replace it with the server's real
post-production render once the write actually lands. This closes the literal defect (a Start click is
now trackable end to end, not merely optimistic) but stops short of a live mid-flight broadcast to
OTHER connected tabs — `ctx.broadcast` is not threaded into `resolveGate` — recorded here rather than
guessed at further: the daemon's OWN next tick (or that tab's own next reload) still converges on the
truth, just not necessarily within the exact synchronous window a start production is in flight if no
local click triggered it.

**Tests.** `tests/adapters.test.ts` — the "malformed usage" describe block (testing the now-deleted
doc-frontmatter usage parsing) was replaced with "levare authors the artifact frontmatter, never the
member (ruling C12)": a native member returning plain prose produces a valid, fully-levare-authored
artifact with an SDK-reported receipt; a member emitting its own (deliberately wrong) frontmatter fence
has every field stripped and replaced with levare's own, including a fabricated `usage:` block ignored
in favor of an `unreported` receipt when the boundary reports none; empty content throws; a CLI member's
raw stdout is authored the same way. `tests/serve-native-e2e.test.ts` — `FAKE_MODEL_DOC` is now genuine
plain prose (no frontmatter at all, the actual bug shape), asserted end to end through the real board
route to produce a valid, levare-authored artifact with the SDK's own receipt; a new
`HOSTILE_FRONTMATTER_MODEL_DOC` case proves a model that DOES wrap fabricated frontmatter around the
same content has it stripped and replaced, end to end. `tests/cli-context-delivery.test.ts`/
`tests/cli-context-artifacts.test.ts` updated their dry-run/live-parity assertions from doc-equals-
context to doc-CONTAINS-context (the context now lands as the artifact's body, not the whole document),
and the `context_via: arg` empty-stdin case now asserts an `AdapterError` (blocked) rather than a blank
`""` document. `tests/validate.test.ts` gained a `buildStudio` helper constructing a minimal two-team-
same-kind studio, covering `AMBIGUOUS_PRODUCER` (naming the kind and both teams), a `team:` override
resolving it cleanly, `UNKNOWN_TEAM`, and `TEAM_CANNOT_PRODUCE`. `tests/gates.test.ts` covers
`responsibleTeamFor`/`responsibleTeamsFor`'s `team:` override directly (a nonexistent named team
resolves to no responsible team, never a fallback guess). `tests/board-render.test.ts` gained a
describe block proving a gate card renders Start/Not yet/Re-scope with no running invocations, the
dispatching state (and none of the verb buttons) the instant a matching invocation appears in `running`,
that an in-flight invocation for a DIFFERENT unit leaves an unrelated gate untouched, and that the
project/run screens render the identical dispatching state. `tests/board-serve-daemon.test.ts` gained an
end-to-end case: a real `POST /gates/.../start` over HTTP, with a member-runner wrapper that renders
`renderStudio` from inside the in-flight `produce()` call (mirroring the existing daemon-tick test's own
pattern) — proving the invocation is genuinely visible in `daemon.running()` and the rendered dispatching
state DURING the request, and cleared after.

**Verification.** `bun test` — 518 pass, 1 pre-existing skip, 0 fail, across 45 files (up from 505/1/0 at
F8); `levare replay fixtures/golden --stubs` — final artifact statuses byte-for-byte against the
regenerated `expected.json`; `deps:check` — `deps ok`; a `renderStudio`/`renderProject`/`renderRun`
smoke check against the golden fixture confirmed the dispatching markup renders exactly as asserted.

## F11. `model:` was decorative — enforced at run time, validated at neither

**Finding, proven live.** Agent `scribe` declared `model: claude-sonnet-4-5`; two consecutive native
invocations both actually ran on `claude-haiku-4-5-20251001` (visible in the artifacts' own usage
receipts).

**First pass at this entry was wrong, and the record says so plainly.** The first version of this
finding claimed "the native SDK call path... always passed `model: req.agent.model` straight through
to the SDK's own `model?: string` option... that half was correct and already covered" — verified only
by reading `adapters.ts#nativeWorkerRequest` and `sdk-worker.ts#buildQueryOptions` and confirming the
field is threaded through, plus the existing mocked assertion that `calls[0].model` equals the declared
model. That check proves the REQUEST carries the declared model; it says nothing about whether the
RESPONSE is parsed correctly, and a fully mocked transport can never exercise that at all — the actual
defect lived in response parsing, downstream of every test that existed at the time. Told the artifact
on disk disproved the claim, the live SDK path was reproduced directly (bypassing every mock: a real
`bunSdkTransport.run()` call, the real bundled `claude` binary, real credentials) — see the finding
below. The lesson, not just the fix: "the request carries X" and "the response reports X" are different
claims, and a claim about a live, real API path is not verified by reading source and reasoning about
it — only by actually running it, exactly what should have happened before the first version of this
entry was written.

**The real root cause, found by live reproduction.** A single `query()` call can report USAGE ACROSS
MULTIPLE MODELS in one result message. Reproduced directly (`bunSdkTransport.run()` with a real
`ANTHROPIC_API_KEY`-authenticated `claude` binary, `model: "claude-sonnet-5"`): the result's
`modelUsage` object came back as `{"claude-haiku-4-5-20251001": {...}, "claude-sonnet-5": {...}}` — an
internal auxiliary call (observed: automatic memory recall, a Claude Code feature that reads
`memory_paths` before answering) ran on Haiku, and the PRIMARY response — the actual assistant message,
confirmed via its own `message.model` field in the raw stream — correctly ran on the requested
Sonnet 5. `sdk-worker.ts`'s old receipt construction took `Object.entries(modelUsage)[0]` on the
documented-but-false assumption "in practice always one, since every call passes exactly one explicit
model" — plain JS object key order is INSERTION order, not significance order, and in the reproduced
case the auxiliary call's key was inserted first. The receipt therefore named whichever model happened
to insert first, which is exactly the "haiku" symptom: not a request-plumbing bug, not an SDK model
override, not levare failing to pass `model:` at all — a response-parsing bug picking an arbitrary key
out of a multi-entry object.

**Fix.** `sdk-worker.ts` now tracks `respondingModel` from each streamed `assistant` message's own
`message.model` (a field the SDK's `BetaMessage` type carries per-turn) and uses THAT — the model that
actually produced `result.result` — as the receipt's model, falling back to `modelUsage[0]` only when no
assistant message was ever seen at all. Token/cost accounting is unchanged (still summed across every
entry in `modelUsage` — the member genuinely cost that, regardless of which internal call spent which
tokens; only the reported MODEL NAME needed fixing). The receipt-building logic was factored out into an
exported, pure `deriveReceipt(message, respondingModel, reqModel)` specifically so this could be unit
tested with a synthetic multi-model `modelUsage` object (the exact shape observed live) rather than only
ever re-verified by another live call — see `tests/sdk-worker-receipt.test.ts`. Re-ran the live
reproduction after the fix, three times, against the real SDK: `receipt.model` correctly reports
`claude-sonnet-5` every time.

Four further gaps, audited fresh against this goal once the root cause above was actually understood:

1. **A CLI member's declared model never reached the vendor CLI at all.** `defaultCliCommand`
   (adapters.ts) substituted `{task}`/`{feature_repo}` into the command template but had no `{model}`
   substitution — a CLI agent had no way to pass its declared model to the wrapped binary, ever, no
   matter what its template said. Fixed: `{model}` now substitutes `req.agent.model ?? ""` the same way
   the other two placeholders do (a shell-less, one-argv-element substitution, unchanged discipline).
2. **Nothing validated a declared model at all — for any kind.** An agent could declare
   `model: gibberish` and `levare validate` said nothing; the failure surfaced only live, as an SDK 400
   or (worse) a silent SDK-side substitution. Fixed: `validate.ts#validateKnownModels` checks every
   agent's declared `model:` (regardless of kind — native, cli, or remote) against
   `knowledge/model-pricing.md`'s own model column, the SAME table `pricing.ts` already reads to price a
   usage receipt. A model absent from that table is `UNKNOWN_MODEL`, naming the agent, the model, and
   the file. This makes the known-model set and the priceable-model set the SAME set by construction —
   "a model that cannot be priced cannot be declared" isn't a separate rule to keep in sync, it's the
   same lookup. Fail-open when the table itself is absent or empty (no `knowledge/model-pricing.md` at
   all): consistent with every other unverifiable-state posture in this validator (git-immutability
   S0/S1, `.env`-tracked check's own `gitToplevel` fallback) — a target making no pricing claim has
   nothing to check a declared model against, and dozens of ad hoc test-studio fixtures across the
   suite (which predate F11 and declare a placeholder `model: claude-sonnet`) never grew a
   `knowledge/` directory, so this posture is also what keeps them passing unchanged.
3. **A CLI agent declaring a model with no `{model}` in its template was never caught.** Fixing (1)
   without also validating it would just move the lie from "silently ignored" to "silently substituted
   into nothing" — a declared model that can never reach the vendor is exactly as false as one that's
   unknown. `validateAgentVariant` now rejects this as `MODEL_PLACEHOLDER_MISSING`, naming the agent,
   the declared model, and the file. Only applies when BOTH `kind: cli` AND `model:` are present — a
   CLI agent that declares no model is unaffected (its `command` never needs `{model}` at all).
4. **The Orchestrator's model was an env-var-only interim mechanism (NOTES K16), never a registry
   field.** K16 explicitly deferred this: "the goal's own language ('a studio-level setting') points at
   a REGISTRY field... Building that properly means a new schema field, validator support, and deciding
   where in the registry it belongs — real design work, not a live-gate fix." That design work is this
   entry. A new root singleton, `studio.md`, distinct from `projects/studio.md` (a Project pointer to
   the studio repo itself — different file, different purpose, no collision): one field so far,
   `orchestrator_model`, validated by the same `validateKnownModels` pass as an agent's own `model:`.
   `repo.ts#loadStudioSettings(root)` reads it (absent file → `{}`, the same "files are the truth,
   nothing invented" posture every other loader here takes); `Repo.studio: StudioSettings` carries it
   through `loadRepo`. `orchestrator-boundary.ts#resolveOrchestratorModel(env, root)` now checks, in
   order: `LEVARE_ORCHESTRATOR_MODEL` (still a legitimate runtime OVERRIDE — a Conductor testing a
   different model without editing the studio) → `studio.md#orchestrator_model` (the source of truth) →
   `DEFAULT_MODEL` (`claude-sonnet-5`, unchanged from K16, the built-in cheap-but-capable fallback when
   NEITHER declares one). `SdkOrchestratorBoundaryOptions` gained an optional `root?: string`, threaded
   from `board/serve.ts`'s `POST /orchestrator/message` handler (`ctx.root` was already in scope there,
   just never passed to `selectOrchestratorBoundary`). Optional throughout — every pre-F11 caller/test
   that constructs `createSdkOrchestratorBoundary()` with no `root` keeps falling back to
   `DEFAULT_MODEL` exactly as before this field existed.
5. **No guard existed for the SDK silently running a call on a model other than the one requested.**
   The root-cause fix above closes the specific reproduced mechanism (a hidden auxiliary call polluting
   `modelUsage`'s key order), but the SDK's own documented behavior is that a call can succeed on a
   substituted model with no error and no warning at all — the receipt-parsing fix removes one way that
   can happen, not the whole class. levare's only honest defence is comparing what it ASKED FOR against
   what its OWN receipt reports, every time, and treating a mismatch as a hard failure rather than a
   quiet in-review artifact. `AdapterRunner#author` (adapters.ts) now checks, for every `kind: native`
   member whose agent declares a `model:`: if the boundary's receipt is not `unreported` and its `model`
   differs from the agent's declared one, throw an `AdapterError` naming BOTH models, before any content
   is authored. This reuses `dagwalk.ts#produceOne`'s EXISTING member-failure handling (the same path a
   timeout, a validation error, or any other `AdapterError` already takes) — no new artifact-blocking
   mechanism, no new schema field: the failure becomes a `status: blocked` artifact via the same
   `writeBlocked()` every other member failure already produces, its body naming the error verbatim
   (both models, by construction of the thrown message). CLI/remote members are unaffected — per ruling
   C12 their receipts are never self-reported/trusted in the first place, so there is nothing honest to
   compare a declared model against for those kinds.

**`levare init`'s scaffold declared `claude-sonnet` — not a real model ID, and it fails on every new
studio's first native run.** This was the live symptom the goal named directly. Fixed at the source:
`AGENT_WREN`/`AGENT_LYRA` now declare `model: claude-sonnet-5`; `KNOWLEDGE_MODEL_PRICING` (the scaffold
template) carries the real, current, PRICED model set (`claude-opus-4-8`, `claude-sonnet-5`,
`claude-haiku-4-5`, `claude-sonnet-4-5`, `claude-opus-4-1`) instead of the fictitious `claude-sonnet`/
`claude-opus` rows it shipped before; a new `studio.md` template (`orchestrator_model: claude-sonnet-5`)
demonstrates and exercises the new registry field on every fresh scaffold. `fixtures/golden/agents/
{wren,lyra}.md` and `fixtures/golden/knowledge/model-pricing.md` were updated the same way — the golden
fixture is the reference implementation of a real studio, and a reference implementation declaring a
fake model ID was itself part of the bug. Approved artifact `usage:` blocks under `fixtures/golden/work/`
were deliberately left untouched: those are historical receipts of what a member actually reported, not
declarations, and two of the three carry `status: approved` — editing them would trip the immutability
check against their own committed history for no reason connected to this fix.

**Remote/MCP: recorded, not enforced.** The goal asked what is and isn't controllable for a `kind:
remote` member. Per adapters.ts's own module doc, remote/MCP is "still mocked in every path" — there is
no real MCP call implementation anywhere in this codebase yet (a separate, already-documented
deferral, predating F11). `validateKnownModels` still checks a `remote` agent's declared `model:`
against the known set if one is present (the same check runs for every kind, uniformly), so a `remote`
agent naming an unpriceable model is still caught at validation time. But there is no live MCP
invocation path to thread an enforced model INTO — `RemoteBoundary.call(req)` never reads `req.agent.model`
today, and there is nothing to fix there without first building a real MCP call, which is out of scope
for this goal. When a real MCP boundary lands, its request shape should be audited against this same
"declared model reaches the wire" standard `native`/`cli` now both meet.

**Live reproduction commands, kept for the next time this needs re-verifying against the real SDK**
(none of these touch the repo; they were run against a scratch `/tmp` script, not committed):
```
echo '{"prompt":"say ok, nothing else","model":"claude-sonnet-5"}' | bun src/sdk-worker.ts
# before the fix: {"receipt":{"model":"claude-haiku-4-5-20251001",...}}  (WRONG)
# after the fix:  {"receipt":{"model":"claude-sonnet-5",...}}            (correct)
```
Reproducing this requires a real `ANTHROPIC_API_KEY` or an authenticated `~/.claude` profile — CI/`bun
test` never does this; the regression coverage below (`tests/sdk-worker-receipt.test.ts`) exercises the
same code path with a synthetic multi-model `modelUsage` object instead, so the fix stays verified
without needing live credentials on every run.

**Verification.** `bun test` — 544 pass, 1 pre-existing skip, 0 fail, across 46 files (up from 518/1/0 at
C12/F10). New: `tests/sdk-worker-receipt.test.ts` — the actual regression test for the real bug, feeding
`deriveReceipt` a synthetic `modelUsage` with the auxiliary model's key inserted BEFORE the responding
model's key (the exact shape reproduced live) and asserting the responding model wins, not the first
key; a single-model case is unaffected; a `respondingModel`-absent fallback still resolves sanely.
`tests/adapters.test.ts` gained a `{model}` CLI-substitution describe block (present-model substitutes;
absent-model substitutes to `""`, never a literal `{model}`); an AdapterRunner-level end-to-end case
proving the agent's declared model reaches the native boundary's request AND the produced artifact's
`usage:` block names that same model; and a "requested vs. actual" guard describe block —
`produce()`/`produceAsync()` both throw `AdapterError` naming both models on a mismatch, an unreported
receipt is never treated as a mismatch (nothing to compare), and a matching model never triggers it.
`tests/daemon.test.ts` gained an end-to-end case (a REAL `AdapterRunner` — not a raw throw — backed by a
native boundary that reports a different model than declared): `resolveGate(..., "start")` fails with
both models named in the error, the artifact written to disk is `status: blocked` and its body names
both models, and a subsequent daemon tick leaves it untouched (never silently retried). `tests/
native-sdk-boundary.test.ts` continues to cover the request-plumbing half (unchanged — that half was
never the actual defect). `tests/validate.test.ts` gained an F11 describe block: `UNKNOWN_MODEL` for an
unknown agent model (naming agent + model + file) and for an unknown studio `orchestrator_model`; both
validate clean on a known model; fail-open with no `knowledge/model-pricing.md` at all;
`MODEL_PLACEHOLDER_MISSING` for a CLI agent with a model but no `{model}` in its command, clean when the
placeholder is present, and never triggered when no model is declared at all. `tests/
orchestrator-sdk.test.ts` gained a precedence describe block: no studio.md/no override → `DEFAULT_MODEL`;
`studio.md` alone → the studio's declaration; `LEVARE_ORCHESTRATOR_MODEL` set → the override wins over
the studio; an explicit `model` option wins over both; no `root` at all (every pre-F11 caller) →
unchanged fallback behavior. `tests/init.test.ts` gained a test asserting the scaffold's own agents AND
its `studio.md` are all in the known-model set, plus zero `UNKNOWN_MODEL` errors from a full
`validatePath`. `fixtures/stubs/member-stub.ts`'s CANNED receipts (`wren:product-brief`, `lyra:design`,
`lyra:spec`) were updated from the old fictitious `claude-sonnet` to `claude-sonnet-5` — matching the
golden fixture's own agents, and specifically because the new requested-vs-actual guard (item 5 above)
would otherwise legitimately fire against the stub's own now-stale canned model, breaking the many
existing tests (`daemon.test.ts`, `gates.test.ts`, `runner.test.ts`, `replay.test.ts`,
`gateops-phase5.test.ts`) that drive production through `stubAdapterRunner`. `tests/
serve-native-e2e.test.ts` and `tests/context.test.ts`/`fixtures/context/lyra.txt` were updated for the
golden fixture's `claude-sonnet` → `claude-sonnet-5` rename (frozen fixtures and hardcoded model-string
assertions); `tests/receipts.test.ts` was updated for the real pricing-table model IDs. `levare replay
fixtures/golden --stubs` — final artifact statuses byte-for-byte against `expected.json`; `deps:check` —
`deps ok`; a manual `levare init` smoke test in a scratch directory confirmed the scaffolded studio
validates clean and its `studio.md` carries a real, known `orchestrator_model`.

## C13. Connectors declare how they authenticate — `env` was the only mode, and a subscription CLI defeated the scoping model through a hole, not a grant

**Finding.** Wrapping a real foreign CLI (OpenAI Codex) as a team member surfaced a gap invariant 11
never accounted for. `codex` doesn't read a credential from an env var — `codex login` writes a session
to `~/.codex`, and every subsequent invocation authenticates from that file. levare's connector model
(pre-C13) assumed every credential is an env var: a connector names the var *names* it needs, and the
Runner's allowlist (`env.ts#buildMemberEnv`) injects exactly those into a granted member's process,
nothing else. A subscription-authenticated CLI has nothing to declare there — and worse, it works
anyway, because `ENV_BASELINE` grants every member `HOME` (so a wrapped CLI can find its own config/
cache, per D5), and `codex` finds its session file at `$HOME/.codex` regardless of whether any
connector was ever granted. The credential reaches the member through a hole in the scoping model, not
through a grant levare made a decision about. That makes the security claim in invariant 11 (§2) —
"a member sees exactly the credentials its connectors grant" — **false** for this whole class of tool:
every member able to spawn `codex` can use the login, granted or not, and `levare doctor`/the registry
gave no indication anything was ungoverned.

**The ruling.** Support both modes; declare which one is in use; be honest, everywhere, about what is
actually enforced.

1. **Connectors declare `auth: env | subscription`** (`types.ts#Connector.auth`, `ConnectorAuth`),
   defaulting to `env` when absent — every connector defined before this ruling is unchanged.
   - `auth: env` requires a non-empty `env:` — unchanged behaviour, and still the only mode where
     levare's grant IS the enforcement.
   - `auth: subscription` requires `env:` be empty or absent — there is nothing for levare to inject
     or scope. An optional `plan:` names the subscription for cost accounting (item 2).
   - Both misdeclarations (a subscription connector naming env vars; an env connector naming none)
     are **definition errors**, caught by `validate.ts#validateConnectorAuth` (`EMPTY_ENV`,
     `SUBSCRIPTION_WITH_ENV`), wired into `validateSingleFile` alongside the existing agent-variant
     check — the same "name what's wrong, don't discover it live" posture as C8/F1/F11.
2. **Cost.** A subscription-authenticated member's usage receipt records **`usd: null`**, never `0` —
   pricing a flat-rate plan per token would be a cost-accounting fiction, and receipts.ts's own rule
   (silence is never dressed up as a free run) extends naturally to "flat-rate is never dressed up as
   metered." `plan:` is named in the receipt's place instead (`Receipt.plan`). Token counts, where the
   boundary reports them, still pass through unchanged — only `usd` is overridden.
   `AdapterRunner#author` (adapters.ts) does the override, via the new `env.ts#subscriptionConnector`
   lookup, right after `normalizeReceipt` and before the F11 model-mismatch guard (which is unaffected
   — it compares `model`, not `usd`). `validate.ts#validateKnownModels`'s `UNKNOWN_MODEL` check is
   exempted for any agent granted (directly or via its team) an `auth: subscription` connector
   (`subscriptionAuthAgents`, hand-parsed off disk like every other cross-entity check in that file,
   not via `repo.ts#loadRepo`) — a subscription CLI's model is unpriceable BY DEFINITION, not by an
   accounting gap, so it must never be flagged as if it were one. **Pre-existing PRD/type-comment
   language said subscription members "price at 0" — that was wrong on the same grounds `usd: null`
   exists for `unpriceable` models generally (a `$0` reads as "ran for free"); corrected everywhere
   found (`types.ts#Receipt.plan`'s comment, PRD §10).**
3. **Visibility.** `levare doctor` (`doctor.ts`) reports every connector's `auth` mode
   (`ConnectorHealth.auth`) and, for `auth: subscription`, a `warning` field carrying the exact
   sentence: *"levare cannot scope this credential — any member that can spawn `<command>` can use
   this login. The grant is documentation, not enforcement."* `formatDoctor` prints an `auth: <mode>`
   line per connector (with `plan` inline when set) and a `⚠` line for the warning — never silent. The
   registry's connector card (`board/render.ts`) shows the same `auth` row, plus the same warning text
   inline for a subscription connector — the board must never let a subscription connector's card read
   as "levare has this scoped" when it doesn't.
4. **Docs.** `docs/levare-prd.md`: invariant 11 (§2) restated precisely — *levare scopes ENVIRONMENT
   credentials; a CLI that authenticates itself from disk is outside that boundary* — with the same
   "prefer `auth: env`, grant `auth: subscription` only to trusted members" guidance the ruling asked
   for. §5's Connectors entity and §6's Guardrails/Doctor paragraphs updated to match. §10 (cost
   tracking) corrected from "price at 0" to `usd: null`.

**Stated plainly, because it is the whole point of this ruling: with `auth: subscription`, the grant
is documentation of intent, not enforcement.** levare cannot scope a credential a CLI reads off its own
disk — nothing short of running the member in a sandboxed environment with its own isolated `$HOME` (or
a tool-specific override — Codex reads `CODEX_HOME`) would change that, and building that per-member
isolation is deferred to the capability-layer work (the same future phase that would let levare give
each member its own filesystem view, not just its own env). This ruling's job was narrower and more
urgent: stop the false claim, name the real boundary, and make every surface that reports on a
connector (`doctor`, the registry) say so.

**Verification.** `bun test` — 562 pass, 1 pre-existing skip, 0 fail, across 46 files (up from 544/1/0
at F11). New coverage: `tests/validate.test.ts` gained a "C13: connector auth mode" describe block —
a subscription connector with `env: []` (and with `env:` absent entirely) validates clean;
`auth: subscription` with a non-empty `env:` fails `SUBSCRIPTION_WITH_ENV`; the default/explicit
`auth: env` with an empty `env:` fails `EMPTY_ENV`; an `env` connector naming a var still validates
clean (unchanged); an unrecognised `auth:` value fails the ordinary `BAD_ENUM` check, not silently
accepted. The existing F11 describe block gained two cases: an agent granted an `auth: subscription`
connector is exempt from `UNKNOWN_MODEL` on its own declared, unpriced model; an agent granted nothing
is still subject to the check (the exemption follows the grant, not the mere existence of a
subscription connector elsewhere in the studio). `tests/adapters.test.ts` gained a "C13" describe
block built off the golden repo (mutating its plain-data `Connector`/`Agent` maps in-memory, same
technique other adapter tests already use for capability overrides): `usd` is forced `null` and `plan`
is noted even when the boundary reports a priceable model and its own non-null `usd`, with token
counts passing through unchanged and both facts visible in the authored artifact's frontmatter; a
subscription member's genuinely-unpriced model is not treated as a pricing failure; a fully unreported
receipt is left alone (no `plan` noted on pure silence — nothing to attribute a plan to); a member
granted no subscription connector is priced exactly as before. `tests/doctor.test.ts` gained a "reports
auth mode, and warns plainly for auth: subscription" describe block: every connector's health record
carries its `auth` mode; a subscription connector carries the exact warning sentence naming its
command, `env`/other connectors carry none; a subscription connector with nothing to check env-wise is
trivially `ok`; `formatDoctor` prints both the `auth:`/plan line and the `⚠` warning line for a
subscription connector, and a plain `auth: env` line with no warning for the unchanged connectors.
`fixtures/doctor/expected.txt` (the byte-for-byte frozen fixture) updated for the new `auth: env` line
on both existing golden connectors — neither is `auth: subscription`, so no warning line appears there.
`levare replay fixtures/golden --stubs` — final artifact statuses still byte-for-byte against
`expected.json` (the golden fixture's two connectors and finch's Codex wrapper are untouched by this
ruling — finch still grants no connector, unreported receipt unchanged); `deps:check` — `deps ok`.

## C14. A loop must actually loop on the live path — dagwalk auto-advanced only the loop's first member; the companion was never dispatched

**Found live.** A team declared `press` with `flow: [loop: {between: [product-brief, review], until:
review.approved, max_rounds: 3, on_exhaust: gate}, gate: human]` and two members (scribe →
product-brief, corvid → review). Starting the unit produced the brief and halted at a human gate.
Corvid was never dispatched, no review was ever requested, and `max_rounds`/`on_exhaust` never came
into play — a real author/critic loop that ran exactly one turn and stopped.

**Root cause: two engines that disagree, the third instance of the same shape (F4, F8, C14).**
`runner.ts` (the phase-2 BATCH engine, `levare replay --stubs` only) has a full `runLoop()` that
alternates both members every round and honours `max_rounds`/`on_exhaust`. `dagwalk.ts` (the LIVE
path — daemon and board) deliberately auto-advanced only the loop's FIRST member and documented, in
its own header comment, that the companion was never auto-produced — a scope boundary that read as a
deliberate design choice but was, in fact, the live defect. The loop was therefore exercised only by
`levare replay`, where a scripted decision stream supplies both artifacts the loop checks for; the
golden fixture's own on-disk state (`spec-checkout-flow-v1` sitting `in-review` with no `review` file,
ever) was the frozen fossil of this exact gap, present since phase 8 and never noticed because nothing
on the live path ever tried to complete that round.

**The ruling.** The walk dispatches BOTH members, every round:

1. Producing the loop's first (author) kind must dispatch the second (companion/critic) kind's
   producer in the SAME walk, with the first artifact in the critic's own context — even though that
   artifact is still `in-review`, not yet approved (`context_artifacts: paths|inline`, ruling C9, still
   honoured). That pairing IS a round.
2. If `until` is satisfied, the loop ends and the walk continues past it. If not, a new round begins:
   the first member is re-invoked with the review in its context, superseding its previous artifact —
   and the companion is re-produced for that new round too, superseding the prior round's companion.
3. `max_rounds` bounds the rounds; on exhaustion, `on_exhaust: gate` raises a gate naming the round
   count and the last review. A loop that cannot converge escalates — it never spins, and never gives
   up silently.
4. The Conductor's gate comes at the loop's OUTCOME, never on each internal turn: consent was already
   given at the unit's start gate, and the loop is what was consented to. Nothing inside a round raises
   a second, separate human gate for the companion — its resolution rides on the first member's gate
   decision (ruling C2, unchanged).

**The fix.** `dagwalk.ts#nextAction`'s loop branch now resolves BOTH loop members every round:

- The first member is produced exactly as before when no live artifact of its kind exists (round 1).
- The instant the first artifact reaches `in-review`, the round is paired to its companion by ROUND
  NUMBER — the same `bumpVersion(kind-unit, N)` convention both members already share. If no artifact
  exists at the round-matched id, the companion is produced for that round, superseding whichever
  artifact was the PRIOR round's live companion (none, for round 1). Only once both members of a round
  sit `in-review` does the walk halt — the round's one outcome gate.
- `produceOne` (dagwalk.ts) generalizes from "always round 1" to an optional `{round, supersedes,
  extraConsumes}` triple: `round` picks the id's version suffix; `supersedes` patches the prior live
  companion to `status: superseded` (clearing `approved_by` too — an approved artifact superseded
  without clearing it trips the validator's own "only an approved artifact may name an approver"
  invariant, since ruling C2 may have already approved that companion alongside an earlier "request");
  `extraConsumes` is handed to the memberRunner.
- **`extraConsumes`** is the seam that lets a critic consume the round's own (still in-review) author
  artifact: a new optional final parameter on `MemberRunner.produce` (runner.ts) and `AsyncMemberRunner
  .produce` (dagwalk.ts), threaded through `AdapterRunner.produce`/`produceAsync`/`prepare`/`author`
  (adapters.ts) into `assembleContext`'s own consumed-set filter (context.ts) — `status === "approved"
  || extraConsumes.includes(id)` — applied identically to BOTH the context handed to the member and the
  `consumes:` frontmatter levare authors onto the produced artifact (ruling C12: one derivation, not two
  that could drift). Optional and ignored by every pre-existing `MemberRunner`/`AsyncMemberRunner`
  implementation (a function assignable to fewer parameters than an interface declares is unaffected;
  only the NEW loop-companion call site ever passes it) — applied to `runner.ts#runLoop` too, so the
  batch engine gained the identical fix, not a second, independently-derived one.
- **`max_rounds`/`on_exhaust`** live in `board/gateops.ts#doRequest` — the one place a new round is ever
  requested (a Conductor's "request-changes" click). Before re-invoking the first member for round N+1,
  `doRequest` now checks the CURRENT round (parsed the same `-vN` way, via the new `runner.ts#roundOf`
  export) against the loop's declared `max_rounds` (`gates.ts#loopMembershipFor`, already shared with
  the board's companion-approval rule). At the final round, "request" is refused (409) rather than
  opening a round beyond the limit — the error names the round count, `max_rounds`, the `until`
  condition, and the last review artifact's id, mirroring `runner.ts#runLoop`'s own `on_exhaust: gate`
  (verbs narrow to approve/reject; runner.ts's own for-loop simply never starts round `max_rounds + 1`).
- `dagwalk.ts`'s module header, previously documenting "only the first member is ever auto-advanced" as
  a deliberate scope boundary, now documents the actual (fixed) behaviour — the stale comment asserting
  the companion is never auto-produced is gone; nothing in this codebase still says that.

**What stayed deliberately unchanged.** `board/gateops.ts#applyLoopCompanionApproval` (ruling C2: any
resolution — approve, reject, or request — of the loop-first gate resolves the round's live companion
to approved) needed no change: it already finds whatever companion is live and `in-review`, and now
that dagwalk actually produces one, it simply starts working correctly rather than being permanently a
no-op on the live path. `board/derive.ts`/`board/render.ts`'s round counters and per-artifact cost
figures (the project page's "N review rounds · cost" line, already a generic count of `review`-kind
artifacts) needed no change either — they start reporting real rounds the instant dagwalk produces real
`review` artifacts; the rendering was never loop-unaware, only ever starved of real data to render.

**Collateral: the golden fixture's own frozen loop, unfrozen.** `checkout-flow`'s static on-disk state
(`spec-checkout-flow-v1` in-review, no review, forever) was the very state this ruling's fix now
completes the instant any daemon walks it — several `daemon.test.ts` cases that share this scratch
studio (to drive an unrelated unit, `loyalty-flow`) recorded every member call across BOTH units;
those assertions now scope to the unit under test (`countingRunner` records `unit` too;
`callsFor(calls, unit)` filters) rather than asserting on the raw, multi-unit call log — the daemon
correctly completing checkout-flow's own long-stale round is the fix working, not a regression to
paper over.

**Tests.** `tests/loop-c14.test.ts` (new): (1) a minimal scratch studio matching the goal's own
live-bug shape verbatim (team `press`: scribe author / corvid critic, `flow: [loop, gate: human]`)
proves both members run in order, the critic's own artifact names the author's (still in-review)
artifact in `consumes:`, the round halts as ONE outcome gate (never two), and a satisfied `until` lets
the walk continue past the loop to the trailing `gate: human` (the unit's flow reports fully satisfied,
not halted); (2) a non-converging loop against `loyalty-flow` (kestrel's flow, same `max_rounds: 3`)
drives three `request` rounds and asserts a 4th is refused (409), naming the round count, `max_rounds`,
and the last review, never silently opening `spec-loyalty-flow-v4`; (3) a cross-engine equivalence test
closing the NOTES R3 duplication risk: the batch Runner's own golden replay scenario and a live daemon
walk of `loyalty-flow` driven through the identical decision shape (start, approve, approve, request,
approve) produce the byte-identical `(member, kind)` invocation sequence. `tests/daemon.test.ts`'s (a)
gained the two new production steps (the companion's dispatch, and the round-outcome halt) in place of
its old "never producing spec's companion review" assertion — the literal defect this ruling closes.
`bun test` — 566 pass (up from 562 at C13), 1 pre-existing skip, 0 fail, across 47 files; `levare replay
fixtures/golden --stubs` — final artifact statuses still byte-for-byte against `expected.json`
(unchanged: the batch engine's own `runLoop` was already correct, per the goal's own root-cause
finding); `deps:check` — `deps ok`.

## F15/F16/F17. The first live two-vendor loop — a Claude native author and a wrapped Codex CLI critic —
## surfaced three defects in the seam between C9, C13, and C14

**Found live.** A team `press` (scribe → product-brief, corvid → review, `flow: [loop: {between:
[product-brief, review], until: review.approved, max_rounds: 3, on_exhaust: gate}, gate: human]`)
started a real unit. Corvid (a wrapped Codex CLI, `auth: subscription`, `context_artifacts: inline`)
ran and produced a contract-valid artifact whose entire content was a bug report: *"No product brief
was provided to review... This is blocking... CHANGES REQUESTED."* The critic was right — and it
found the bug by doing exactly what it was built to do. Its own artifact carried `consumes: []` and no
`usage:` block at all. Both loop artifacts also sat open on the board simultaneously.

### F15 (CRITICAL) — the loop's critic received no consumed artifact on the live path

**Root cause.** C14 added `extraConsumes` so a loop's critic could consume the author's still-in-review
artifact; `dagwalk.ts` and `AdapterRunner` (adapters.ts) already threaded it correctly end to end. The
break was narrower and dumber: `replay.ts#productionAdapterRunner` — the ACTUAL wiring `daemon.ts` and
`board/gateops.ts` use in production — built its returned `produce()` closure over only 4 of the 5
parameters `AsyncMemberRunner.produce` declares, silently dropping `extraConsumes` before it ever
reached `AdapterRunner.produceAsync`. Every unit test exercising the seam drove `AdapterRunner`
directly or a hand-rolled `AsyncMemberRunner`, so nothing ever drove the real wrapper end to end.

**The fix.** One line: `produce: (member, kind, unit, project, extraConsumes) =>
runner.produceAsync(member, kind, unit, project, extraConsumes)`. `productionAdapterRunner` also gained
an optional `{native, asyncNative}` override (unused by every real call site) so a test can dispatch a
loop's critic through the ACTUAL wrapper — not a stand-in that would pass by construction — without a
real SDK call for the loop's native author half.

**Tests.** New `tests/loop-critic-context.test.ts`: a scratch `press` studio (scribe native, corvid a
REAL, unmocked `cat` subprocess — ruling C9's own test technique) dispatched through
`productionAdapterRunner` itself, in both `context_artifacts` modes. Asserts on what corvid actually
received (its own stdout — ruling C12, the artifact's body verbatim): `inline` contains the author's
artifact body word-for-word; `paths` contains its root-relative path and NOT the body; both modes
record the author's artifact in the produced review's own `consumes:`. Confirmed against a manual
revert of the fix (both cases fail loudly, not silently).

### F16 — both loop artifacts raised their own gate, and resolving the wrong one wedged the unit

**Root cause.** `board/derive.ts#openGates` lists every `in-review` artifact as an open gate with no
loop awareness — once C14 started dispatching both loop members, both sat `in-review` at once and both
showed up as independently-clickable gates, contradicting C14's own ruling ("the Conductor's gate comes
at the loop's OUTCOME... never on each internal turn"). Worse, `board/gateops.ts#applyLoopCompanionApproval`
(the C2 cascade — resolving one loop artifact also resolves its companion) was hardcoded to fire only
when the resolved artifact was the loop's "first" (author) role — true for kestrel's own `until:
spec.approved`, false for an author/critic loop gated on its SECOND member (`until: review.approved`,
the live incident's exact shape). Resolving the non-cascading artifact directly left its companion
permanently `in-review`; `until: review.approved` could then never become true because nothing ever
touches `review` again, and nothing said so.

**The ruling.** While a loop is in progress, only the artifact its `until` condition actually names may
gate; its companion never independently gates, riding on the until-named artifact's own resolution
regardless of which role (first/author or second/critic) is actually the gate. levare must never permit
a definably-unsatisfiable `until` — an `until` naming a kind neither loop member can produce fails at
`levare validate`, loudly, never discovered live.

1. **`gates.ts`**: `loopUntilKind(loop)` (the kind `until` names) and `isLoopCompanionKind(team, kind,
   capabilities)` (is `kind` the loop's OTHER member, relative to `until` — not relative to role) —
   shared by both visibility and resolution.
2. **`board/derive.ts#openGates`**: never lists an artifact for which `isLoopCompanionKind` is true.
3. **`board/gateops.ts#resolveGate`**: refuses (409, naming the real gate) a direct verb on a loop's
   companion artifact — defense in depth beyond board visibility, since nothing stops a direct API call
   from naming an artifact the board never shows.
4. **`applyLoopCompanionApproval`**: cascades whenever the resolved artifact is the until-named one
   (`!isLoopCompanionKind`), not only when its role happens to be "first" — the same C2 semantics,
   correctly generalized.
5. **`doRequest`**: max_rounds/on_exhaust applies whenever a loop membership is found at all (every
   membership reaching this point IS the gate, by #3's guard), not only role `"first"`. "Request
   changes" always re-invokes the loop's AUTHOR (`between[0]`) for a new round, resolved via
   `resolveStep` and superseded via `latestLiveArtifact` (dagwalk.ts) — even when the artifact actually
   resolved is the critic's, since re-running the critic on an unrevised input would be meaningless.
   The resolved gate artifact itself is deliberately left untouched (still `in-review`) rather than
   marked "approved": marking it approved would satisfy `until: review.approved` immediately off the
   STALE round while the new round is still unresolved — the identical wedge this ruling exists to
   close, self-inflicted. The walk's own next tick resolves it for real: `dagwalk.ts` finds it as the
   prior round's still-live companion the instant the new round's critic artifact is produced, and
   supersedes it there with its own proper `supersedes:` edge — the same path every other round already
   takes, not a second one.
6. **`validate.ts#validateStudioBindings`**: a new check alongside `UNBINDABLE_STEP` —
   `LOOP_UNTIL_UNREACHABLE` — a loop's `until` must resolve to one of its own two `between` members'
   kinds; naming any other kind is a studio definition error, not a live surprise.

**Tests.** `tests/loop-c14.test.ts`'s original "press" scenario — which approved the AUTHOR's brief
directly under `until: review.approved` and asserted the (buggy) cascade — rewritten: approving the
brief directly is now refused (409, naming the real gate); approving `review` (the actual until-named
gate) correctly cascades to the brief. New cases: `openGates` lists ONLY the until-named artifact once
a round completes, never both; `request` on the critic's gate re-invokes the AUTHOR, superseding its
prior round and producing a new one, with the critic's own next-round artifact produced in lockstep on
the following tick. New `fixtures/rejections/loop-until-unreachable` + `tests/validate.test.ts` "F16"
block: `until` naming neither loop member fails `LOOP_UNTIL_UNREACHABLE` naming the team/loop/what
`until` resolved to; `until` naming either the first OR the second member validates clean (the check is
not hardcoded to "first" any more than the runtime fix is).

### F17 — a subscription CLI member's usage receipt was omitted entirely, not merely underpriced

**Root cause.** `AdapterRunner`'s `cli` case never populated a `receipt` at all — only `native`
populated one from its boundary's reply — so a CLI member's receipt was always
`normalizeReceipt(null, pricing)` (`unreported: true`), regardless of what the CLI's own stdout
actually said. `author()`'s C13 subscription override (`usd: null`, `plan` noted) was itself gated on
`!finalReceipt.unreported`, so it silently never fired for any CLI member — the whole class of member
C13 was written for. Nothing parsed what a wrapped CLI reports; ruling C13's own "usd: null, plan
noted, tokens pass through" was unreachable code for this adapter kind.

**The fix.**
1. **Parse it.** `extractCliUsageTrailer(raw)` (adapters.ts) recognizes a plain trailer line — `tokens
   used: N`, matching Codex's own reported form verbatim — strips it from the kept content (ruling C12:
   a usage trailer is no more part of the document than a frontmatter fence the member emitted on its
   own initiative) and returns the parsed count. `AdapterRunner#cliReceipt` turns a non-null count into
   a real `Receipt` via `normalizeReceipt` (the agent's own declared `model:`, since a CLI doesn't
   report its model in the trailer); `runCli`/`runCliAsync`/`cliResultToDoc` now return `{content,
   tokensUsed}` instead of a bare string, and both `produce`/`produceAsync`'s `cli` case feed the parsed
   receipt through exactly like `native`'s boundary-reported one.
2. **Never omit it, for a subscription CLI.** `author()`'s subscription override now forces
   `unreported: false` before applying `usd: null`/`plan`, but ONLY for `req.agent.kind === "cli"` — a
   native member's boundary is the real SDK, genuinely either reporting usage or silent in a way that
   stays legitimate (and a pre-existing test asserts exactly that "a fully unreported receipt is left
   alone" case, unaffected). A `kind: cli` subscription member now ALWAYS carries a `usage:` block: real
   parsed tokens when the CLI reported any, all-null fields when it reported nothing parseable — an
   artifact with no receipt is indistinguishable from one that cost nothing, never again.

**Tests.** New "F17" describe block in `tests/adapters.test.ts` (a `cannedCliSpawn` stand-in returning
arbitrary stdout, mirroring a real wrapped CLI's plain-text trailer rather than the fixture stub's
canned `usage:` block): a CLI's `tokens used: N` trailer is parsed into the receipt and stripped from
the artifact body; a subscription CLI member's receipt carries the parsed tokens, `usd: null`, and the
plan, all visible in the authored frontmatter; a subscription CLI member reporting nothing parseable
still carries a full `usage:` block (nulls, plan noted) rather than omitting it; a non-subscription CLI
member reporting nothing parseable is byte-for-byte unaffected (still `unreported`, still no `usage:`
block) — the pre-existing, legitimate case.

**Verification.** `bun test` — 577 pass (up from 566 at C14), 1 pre-existing skip, 0 fail, across 48
files (new: `tests/loop-critic-context.test.ts`); `levare replay fixtures/golden --stubs` — final
artifact statuses still byte-for-byte against `expected.json`; `deps:check` — `deps ok`.

## F18. A unit whose next required kind is produced by no team in the studio sat `active` forever — the walk knew and said nothing

**Found live, three separate times.** A unit's type `expects` a kind (e.g. `design`) that no team in
the studio declares in its own `produces:` — not because a team tried and failed to bind it (that is
the pre-existing F1 `unbindable` case), but because no team's `flow:` ever attempts that kind at all,
so `validate.ts#validateStudioBindings` — which only inspects declared flow steps — has nothing to
catch. The unit sat `active`, the board showed no gate, the Orchestrator's briefing said "Nothing needs
you right now", and both were right about what they were looking at — the walk itself never told
anyone what it knew.

**Root cause.** `dagwalk.ts#advanceUnit`: `gates.ts#responsibleTeamsFor(repo, unit)` returns every team
whose `produces` intersects the unit type's `expects`; when NO team produces anything the type expects,
it returns `[]`, and `advanceUnit` short-circuited straight to `{ outcome: "nothing" }` — the same
"nothing to do right now" outcome a unit between gates legitimately returns. Silence and misconfiguration
were the same return value.

**The fix.** `advanceUnit`'s `teams.length === 0` branch now finds the specific missing kind (the first
of the type's `expects` with no producer anywhere in the studio) and blocks the unit exactly like the
F1 `unbindable` path does — same `blockUnit` helper, now accepting `team: Team | null` (null here, since
no team was ever in play to name) — writing `status: blocked` + `blocked_reason: "<type> needs
`<kind>`; no team in this studio produces it"` to `unit.md`, committed, surfaced by `board/derive.ts
#openGates` (already blocked-unit-aware since F1 — no change needed there) and rendered by the board
(ditto). The one place that WAS still silent: `orchestrator.ts#buildBriefing` filtered `openGates()`'s
own output down to `type === "artifact"` only for its `gates` list — a blocked unit (type `"blocked"`)
never reached the Orchestrator at all, regardless of whether F1 or F18 raised it. `Briefing` gained a
`blocked: OpenGate[]` field (`openGates().filter(g => g.type === "blocked")`), included in the
"Nothing needs you right now" short-circuit and rendered as its own line naming each blocked unit and
its reason.

**Tests.** New `tests/f18-unadvanceable.test.ts`: a scratch studio (type `research` overridden to
`expects: [design]`, one team `core` that produces only `note` and whose flow never references
`design`) validates clean (the gap this ruling closes is a runtime one, not a studio-definition error);
`advanceUnit` blocks the unit naming the missing kind and that no team produces it; the block surfaces
as a `type: "blocked"` gate on the board, rendered with the reason on the card; `buildBriefing`'s
`blocked` list and its `text` name the unit and reason instead of claiming nothing needs the Conductor.

**Verification.** `bun test` — 581 pass, 1 pre-existing skip, 0 fail, across 50 files (new:
`tests/f18-unadvanceable.test.ts`); `levare replay fixtures/golden --stubs` unaffected (this ruling
touches only the live daemon/board/Orchestrator path, never the phase-2 batch Runner).

## F21. A blocked CLI member's card showed levare's own echoed prompt, not the real error

**Found live.** A wrapped CLI member (Codex/Gemini, `kind: cli`) failed. The blocked artifact's reason
— the most prominent thing a Conductor should see on that card — was dominated by the argv the member
was invoked with, which for a real studio embeds `{task}`: the member's ENTIRE §6-assembled context,
often thousands of characters. The actual diagnosis (the CLI's own stderr) was appended AFTER it, so a
card showing only a bounded preview displayed levare's own echoed prompt and never the real error.

**Root cause.** `adapters.ts#cliResultToDoc` built its `AdapterError` message as `cli member '${member}'
exited ${code} (argv: ${JSON.stringify(argv)})${stderrSuffix}` — argv FIRST, diagnosis LAST. `argv`
carries whatever `defaultCliCommand` substituted into the command template, unbounded.

**The fix.** `diagnoseCliFailure(result)` — tried in order: the vendor's own structured JSON error
(many CLIs report one), the tail of stderr (unchanged 2000-char cap, NOTES F3), the last non-empty
line of stdout (some CLIs write their error there instead) — surfaced FIRST in the thrown message.
`summarizeArgv(argv)` caps each element (200 chars, `…(N chars total)` suffix) and is appended AFTER
the diagnosis, as a secondary "what actually ran" reference — never the primary content again.

**Tests.** New "F21" block in `tests/adapters.test.ts`: a huge (~16k char) substituted argv element
never buries a real stderr diagnosis (asserted by string position, diagnosis before `(argv:`, and the
whole message far shorter than the raw huge element); a CLI's structured `{"error":{"message":...}}`
stderr is preferred over a raw tail; empty stderr falls back to the last non-empty stdout line rather
than a bare "exited N". All pre-existing F3 tests (argv presence, stderr truncation, timeout stderr)
pass unchanged — the shape changed, not the guarantees.

**Verification.** `bun test` — 595 pass, 1 pre-existing skip, 0 fail, across 51 files; `levare replay
fixtures/golden --stubs` unaffected (the CLI adapter path is not exercised by `--stubs`); `deps:check`
— `deps ok`.

## F19/F20. A blocked artifact had no verbs, and an exhausted loop's card didn't say so

**Found live**, the same session as F18/F21 — the other half of "the mechanism is correct, the telling
is absent": a member's failure correctly blocks the artifact (dagwalk.ts#writeBlocked) and the daemon
correctly never auto-retries (a money fire waiting to happen) — but the ONLY way past it was deleting
the file by hand and committing. Separately, a loop at `max_rounds` is correctly refused a further
`request` server-side (409, no spend — ruling C14/F16) — but the board's card didn't know: it still
offered "Request changes", opened the note composer, and silently discarded the Conductor's text on
the refused round-trip.

### F19 — a blocked artifact gains retry/skip/abandon

**The fix.** `board/derive.ts#openGates` now raises a NEW gate type, `"artifact-blocked"`, for any
artifact at `status: blocked` (previously skipped entirely — `openGates` only ever looked at
`in-review`). `board/render.ts#gateCardHtml` renders it with three verbs — never approve/reject/
request, which decide on CONTENT this artifact never had: **Retry** (re-invoke the same member for the
same kind — the context re-assembles fresh from the same on-disk state, through the exact
`memberRunner.produce()` boundary every other invocation uses, so a successful retry's usage receipt
lands in the ledger exactly like any other production), **Skip** (`board/gateops.ts` patches the
artifact to a NEW status, `skipped` — added to `ArtifactStatus`/`STATUS_ENUM` — and
`dagwalk.ts#nextAction` now treats `skipped` like `approved` for a plain step, so the walk continues
past this kind on its next tick), **Abandon** (pauses the whole unit). `runner.ts#Verb` gained `retry
| skip | abandon`, resolved entirely in `board/gateops.ts#resolveBlockedArtifactGate` — the phase-2
batch Runner has no notion of a `blocked` artifact and is untouched. A retry that fails again writes a
NEW blocked artifact superseding the last (mirroring `writeBlocked`'s own doc shape), so the gate stays
actionable rather than wedging on a stale failure. The daemon's own autonomous walk never calls this
path — retry is exclusively a Conductor's explicit, costed click, exactly as before.

### F20 — an exhausted loop's card says so, and offers the loop's real decision

**The fix.** `openGates` now attaches `{round, maxRounds, until, exhausted}` to the ONE artifact a
loop's `until` names (by construction the loop's only gate-raising artifact — F16's own companion
skip already guarantees this), computed from `gates.ts#loopMembershipFor` + `runner.ts#roundOf` — the
same primitives `board/gateops.ts#doRequest`'s existing 409 check already uses server-side, so the
card's claim and the server's enforcement can never drift apart. `gateCardHtml`: when `exhausted`, the
card's context line states the round count and the `until` condition instead of the artifact's own
first paragraph, "Request changes" is dropped entirely (replaced, never merely greyed out), and the
verb row becomes **Approve anyway** / **Reject** / **Re-scope** — the loop's actual on_exhaust
decision. **Re-scope** is a new artifact-targeting sense for the pre-existing `rescope` verb
(previously unit-start-gate-only; `resolveGate` now disambiguates by whether `target` resolves to a
live artifact at all): `board/gateops.ts#doRescopeArtifact` rejects the exhausted artifact AND pauses
the whole unit, in one commit — a deliberate re-plan, not another round this loop already proved it
cannot complete alone. `assets/app.js` needed only two small additions (`retry`/`skip`/`abandon` in
the verb→label map, `retry` added to the dispatching-verb list alongside `start`/`request`) —
"rescope" already opened the note composer and posted through the existing generic pipeline.

**Tests.** New `tests/f19-blocked-artifact-verbs.test.ts`: a blocked artifact surfaces as its own
`artifact-blocked` gate (never approve/reject/request on it); a successful retry re-invokes the same
member and the unit's ledger spend increases; a retry that fails again supersedes with a new blocked
artifact naming the new error; skip marks the artifact `skipped` and the walk's next tick produces the
following kind instead of halting; abandon pauses the unit; the daemon's own autonomous walk never
retries on its own (0 calls when the design slot is already blocked). New
`tests/f20-loop-exhaustion.test.ts`: `openGates` annotates round 3/3 as `exhausted: true` (round 1
`exhausted: false`); the rendered card states "3 of 3 rounds used", carries no `request` verb, and
offers approve/reject/rescope; a non-exhausted round's card keeps `request` and shows a plain round
indicator; re-scope rejects the artifact and pauses the unit in one two-file commit; `request` at the
final round is still refused server-side (409, no v4 artifact) — the card's disabling matches a real
enforcement, not cosmetics alone.

**Verification.** `bun test` — 595 pass, 1 pre-existing skip, 0 fail, across 51 files (new:
`tests/f19-blocked-artifact-verbs.test.ts`, `tests/f20-loop-exhaustion.test.ts`); `levare replay
fixtures/golden --stubs` — final artifact statuses still byte-for-byte against `expected.json`
(neither `blocked`/`skipped` nor the new verbs are reachable from the phase-2 batch engine);
`deps:check` — `deps ok`.

## F22. A project pointer missing three required fields reported one, then another, then a third

**Investigated live.** The reported symptom: a Conductor fixes a broken `projects/*.md` pointer,
re-validates, and is told about the NEXT missing field, then the next — three round-trips to learn
what one message could have said.

**Root cause — NOT where it looked.** `validate.ts#validateAgainstSchema`/`checkField` already loop
over every declared field and accumulate every `MISSING_FIELD`/`BAD_TYPE`/`BAD_ENUM` for one entity in
a single pass (verified directly: a scratch `projects/acme.md` missing all six required fields, run
through both `validatePath()` and the real `levare validate` binary, reports all six in one shot,
every time). The walking-multiple-files case the goal itself named as already-working was also
already fine. The gap was one layer downstream: every CALLER that turns a `ValidationError[]` into
ONE human-facing string — a 422 response, a blocked artifact's reason, a chat reply — kept only
`errors[0]`, discarding everything else the validator had already found. `board/gateops.ts` (6 sites:
approve/reject/request/skip/rescope-supersede/loop-companion), `dagwalk.ts#produceOne` (an off-contract
produced artifact's `blocked_reason`), `runner.ts#runStep` (the batch engine's mirror of the same
check), and `orchestrator.ts` (5 sites: `rollbackAndFail`, `openUnit`, `captureIdea`, `promoteIdea`,
`runNewProjectSkill` — the literal "write a project pointer" path) all independently wrote
`` `${errs[0].code}: ${errs[0].message}` ``. `board/serve.ts`'s registry-edit route was already
better (`errors.slice(0, 5)`) but still an independent, differently-capped derivation.

**The fix.** One shared formatter — `validate.ts#formatValidationErrors(errs)` — joins every error's
`code: message` with `; `. Every site above now calls it instead of reaching for `errs[0]` (or its own
`.slice(0, 5)`) — one derivation, not eight that could independently regress or drift apart (the same
"one derivation, not two" posture ruling C12 established for artifact `consumes:`).

**Tests.** New `tests/f22-validation-accumulation.test.ts`: a regression pin proving
`validatePath`/`levare validate` already accumulate correctly (documenting the investigation, not just
asserting the fix); the board's registry-edit route (`POST /registry/projects/<name>.md`) reports
every missing field of a broken project pointer in one 422 response, not a truncated subset;
`formatValidationErrors` joins in order; a member that produces an artifact with TWO simultaneous
contract violations at once (an unknown key AND a listed file that doesn't exist) blocks with BOTH
reasons named, via `dagwalk.ts`'s live walk — not just the first one found.

**Verification.** `bun test` — 599 pass, 1 pre-existing skip, 0 fail, across 52 files (new:
`tests/f22-validation-accumulation.test.ts`); `levare replay fixtures/golden --stubs` — final artifact
statuses still byte-for-byte against `expected.json`; `deps:check` — `deps ok`.

## F23. `levare init` scaffolds a studio that lies about its models, its CLI contract, and its secrets

**The three-part ruling.** (1) A fresh studio's pricing/known-model data must never depend entirely
on a file the studio itself scaffolds — levare ships a baseline pricing table IN THE BINARY, current
with each release, and a studio's own `knowledge/model-pricing.md` EXTENDS or OVERRIDES it, never
replaces it wholesale. (2) A scaffolded CLI agent's `result:` field must describe the CURRENT contract
(ruling C12: levare authors the artifact wrapper; members emit content only), not the pre-C12 one.
(3) A fresh studio scaffolds `.env.example` — naming what it might need — and never a live `.env`.

**Investigated.** `src/init.ts`'s own scaffolded agents (`wren`, `lyra`) already declared real,
callable model ids (`claude-sonnet-5`) and its `knowledge/model-pricing.md` template already listed
real ids too — NOTES F11's known-model validation work had already closed the literal
`model: claude-sonnet`/`claude-opus` gap for the SCAFFOLD specifically, with its own test coverage
(`tests/init.test.ts`, "scaffolded agents ... are all in the known-model set"). Two real gaps
remained: the ruling's structural point (1) — pricing/known-model data still depended ENTIRELY on
`knowledge/model-pricing.md`, so ANY studio (scaffolded or hand-written) that omitted or emptied that
file quietly fell back to `validate.ts#validateKnownModels`'s own `pricing.size === 0` fail-open branch,
never checking a declared model at all — and (2), `agents/finch.md`'s `result:` field (both the
scaffold AND, identically, `fixtures/golden/agents/finch.md`) still read "the wrapper validates its
frontmatter against the artifact contract" — a member never has frontmatter of its own to validate;
levare authors the whole wrapper (ruling C12), the member's raw output is content only. (3), the
`.env.example` gap, was exactly as described: no such file was scaffolded at all.

**The fix.**
1. **`pricing.ts`**: `BASELINE_PRICING_MARKDOWN` — a real, currently-callable Claude model id table,
   parsed through the same `parsePricing` a studio's own file uses (one parser, not a hand-rolled
   literal `Map` that could drift from what a studio-authored table means). `loadPricing(root)` now
   starts from `baselinePricing()` and overlays the studio's own `knowledge/model-pricing.md` on top,
   entry by entry — a studio can still price an exotic/self-hosted model the binary doesn't know, or
   override a baseline rate, but never loses the baseline by omission. `validateKnownModels`'s
   `pricing.size === 0` fail-open branch is gone (`pricing.size` can no longer be 0) — a studio with NO
   pricing file of its own is now actively checked against every baseline model, not silently skipped.
2. **`agents/finch.md`'s `result:`** (both `src/init.ts`'s scaffold and `fixtures/golden`, which carried
   the identical stale text): rewritten to state the actual contract — the CLI's stdout is content
   only, levare authors the wrapper (id, status, consumes, usage) around it and validates the whole
   document at the boundary (ruling C12), never trusting pre-formed frontmatter from the member.
3. **`.env.example`** (`src/init.ts`): scaffolded alongside `.gitignore` (which already lists `.env`,
   unchanged), naming `ANTHROPIC_API_KEY` (the Orchestrator — explicitly commented OPTIONAL: the board,
   registry, and every gate work without it), the optional `LEVARE_ORCHESTRATOR_MODEL` override, and
   the scaffolded connectors' own vars (`GITHUB_TOKEN`, `LINEAR_API_KEY`) — commented that connector
   grants are scoped (invariant 11: a value set here is still only visible to a member whose team/agent
   explicitly grants that connector). The README's "Getting started" section gained a `cp .env.example
   .env` line and a two-sentence explanation. `.env.example` is not a registry entity (no `.md`
   extension under a registry folder) — `levare validate` never looks at it.

**Collateral: fixture/test model names.** Fixing the fail-open branch made every OTHER scratch studio
in the test suite that used the placeholder `model: claude-sonnet` (never checked before, since those
scratch studios had no pricing file either) newly, correctly, subject to `UNKNOWN_MODEL` — exactly the
mechanism this ruling exists to make universal. Updated to the real `claude-sonnet-5` id:
`tests/validate.test.ts`'s shared `buildStudio` helpers (the AMBIGUOUS_PRODUCER/TEAM_CANNOT_PRODUCE/
EMPTY_PRODUCES/MISSING_FIELD fixtures — none of them about model validation, so the placeholder was
incidental) and `fixtures/rejections/{team-unproducible-kind,unbindable-step}/agents/scribe.md`. The
one test that explicitly asserted the OLD fail-open behavior was rewritten to assert the new,
correct one (`tests/validate.test.ts`, "F11: known-model validation") — a studio with no pricing file
still catches `totally-made-up-model` via the baseline, still validates a real baseline model clean,
and its own `knowledge/model-pricing.md`, when present, still extends the baseline rather than
replacing it.

**Tests.** New `describe` block in `tests/receipts.test.ts` ("F23"): `baselinePricing()` carries real
ids and explicitly does NOT carry `claude-sonnet`/`claude-opus`; a studio with no pricing file at all
still prices a baseline model; a studio's own file overrides a baseline rate for the same model, and
separately extends the baseline with a model the binary doesn't know, without losing the baseline.
New `describe` block in `tests/init.test.ts` ("F23"): `.env.example` is scaffolded and a live `.env`
never is; it names `ANTHROPIC_API_KEY`/`GITHUB_TOKEN`/`LINEAR_API_KEY` with no real secret values (a
checklist, not a leak); it explains the Orchestrator is optional and connector grants are scoped; it
never trips `levare validate`. The pre-existing "produces exactly the expected skeleton" test gained
`.env.example` to its expected file set.

**Verification.** `bun test` — 609 pass, 1 pre-existing skip, 0 fail, across 52 files (all tests
updated for the new UNKNOWN_MODEL behavior, none skipped or weakened); a live smoke test (`levare init`
into a scratch directory, then `levare validate .`) prints `valid` and leaves `.env.example` on disk
with no `.env`; `levare replay fixtures/golden --stubs` — final artifact statuses still byte-for-byte
against `expected.json`; `deps:check` — `deps ok`.

---

## Achieved: NOTES F18–F23 (the silences)

Six defects, one theme: levare's most common failure mode is not being wrong — it is knowing
something and not saying it. Every fix above closes exactly that gap, never by changing what the
mechanism decides:

- **F18** — a unit no team can ever advance now blocks loudly, naming the missing kind; the
  Orchestrator's briefing no longer silently drops a blocked unit.
- **F19** — a blocked artifact raises a gate with retry/skip/abandon; retry re-invokes the same member
  through the same costed boundary and re-costs the ledger like any other invocation; the daemon still
  never retries on its own.
- **F20** — an exhausted loop's card states the round count and the `until` condition, drops "Request
  changes" (it can never succeed), and offers the loop's real decision: approve anyway, reject, or
  re-scope.
- **F21** — a blocked CLI member's card leads with the actual diagnosis (structured error, stderr
  tail, or last output line), never levare's own echoed `{task}` prompt.
- **F22** — every consumer of a `ValidationError[]` reports every accumulated error in one message,
  via one shared `formatValidationErrors`, not `errors[0]`.
- **F23** — a fresh studio's model pricing/validation no longer depends entirely on a file it
  scaffolds itself; its CLI agent's contract description is current; it ships `.env.example`, never a
  live `.env`.

`bun test` exits 0 (609 pass, 1 pre-existing skip, 0 fail, across 52 files); `levare replay
fixtures/golden --stubs` matches the oracle byte-for-byte; `deps:check` reports `deps ok`.

## A test-quality pattern: assert about the code, not the shell it happened to run in

Three tests in a week failed (or silently passed for the wrong reason) because they asserted
something true about the WORLD the test happened to run in, rather than something true about the
CODE under test. Naming the pattern here so the fourth instance is caught in review, not production.

1. **`tests/board-serve-e2e.test.ts`** — the spawned `./levare serve` subprocess bound a port derived
   from `4100 + (process.pid % 400)`, "to spread across runs to avoid colliding with a stale
   listener" — a mitigation, not a fix. Two processes (a stale listener from a crashed prior run,
   another CI shard, a container with a recycled low PID range) can still collide on that formula.
   When they did, the bind failed, the subprocess exited, and `expect(proc.exitCode).toBeNull()`
   reported "the process died" — reading as a real regression (the server crashing after boot) when
   the actual fact was mundane: the port was merely taken. The test was asserting "this specific port
   was free," a fact about the host, and mislabeling its failure as a fact about `levare serve`.

2. **`tests/daemon.test.ts`** — "many rapid ticks never invoke a member twice" already asserted a
   fully deterministic property (a fixed 30 ticks, an exact invocation-count match — no randomness,
   no network) but ran under bun's default 5000ms per-test timeout. Each tick makes a real git commit,
   so wall time tracks host load, not the property under test; a busy CI runner or a loaded dev
   machine could push the SAME deterministic sequence past 5s while a quiet one stayed under it. Fixed
   in `e4a214c` by raising the test's own timeout to a generous 30s ceiling — the assertion itself
   never changed, because it was never actually about time.

3. **`tests/orchestrator-no-deterministic-boundary.test.ts`** — asserted `selectOrchestratorBoundary
   ({})` (an explicitly empty, self-contained env) returns `null`. It passed in isolation and in CI
   (no `ANTHROPIC_API_KEY` either way) and failed on any developer machine that had ever exported one
   — which, for a levare contributor, is every machine that has ever run the real Orchestrator. Root
   cause: `sdk-transport.ts#checkSdkPreconditionsCached` memoizes its verdict in a MODULE-LEVEL cache
   with a 30s TTL keyed by nothing but time — not by the `env` argument. Bun runs a whole test file's
   suite in one process, so if ANY earlier test in that run resolved the boundary against the real
   `process.env` (the default for every call site that doesn't inject its own — a live board test, an
   orchestrator smoke test), that verdict stayed cached and silently outlived the env this test
   explicitly passed. The test controlled its OWN input and still wasn't testing its own input — a
   shared, invisible cache from an unrelated, earlier-running test was. Fixed by calling the already-
   established `resetSdkPreconditionCache()` (test-only, and already the convention in
   `tests/orchestrator-sdk.test.ts`'s own `beforeEach`) before every test in the file, so
   `selectOrchestratorBoundary({})` is guaranteed to actually re-evaluate the env this test injects,
   not whatever an unrelated test left behind.

**The pattern.** Each of the three had a plausible-looking guard against exactly ONE source of
ambient truth (a "spread across runs" port formula, CI's own lack of a key, a 5-second timeout that's
usually enough) while a DIFFERENT ambient channel — a stale listener, a loaded host, a module-level
cache with no env key — still leaked through. A test that reads (or is silently gated by) something
outside its own explicit setup — the wall clock, a fixed or formula-derived port, a real environment
variable, a shared module-level cache, host load, execution order — is testing the environment, not
the code, even when its assertion LOOKS like it's about the code. The fix is never a longer timeout or
a wider port-spread formula alone (both mitigate, neither eliminates); it's controlling the actual
input: inject the exact env/config/clock the assertion is about (`buildMemberEnv`'s base-env
parameter, `checkSdkPreconditionsCached`'s own injectable `env` + `resetSdkPreconditionCache()`,
`AdapterRunnerOptions.now`), or pick a genuinely collision-free resource (an OS-assigned ephemeral
port, `--port 0`, rather than a formula over the PID) — the same "inject the input under test, don't
default to the ambient world" posture this project already uses throughout §6's `buildMemberEnv` and
the AdapterRunner's own `spawn`/`asyncSpawn`/`now` injection points. When reviewing a new test, ask
what it would take to make it fail SPURIOUSLY on a correct implementation — a busy CI runner, a
long-lived developer shell, two people running the suite at once — and if the answer isn't "nothing,"
it isn't testing what it claims to.

---

## UI1. The board never had a design round beyond the CD prototype's own information architecture —
## a status colour could be set by any renderer that felt like it, and the nav still carried the shape
## of a screen that predates the header

**The complaint.** The Conductor's own review of the board found `active` rendering grey on the Studio
project card (`.chip.is-progress`), grey on the Project page's work-unit rows (the same class), and
blue on the run-view score rail (`.snode.active`) — three renderers, three independent colour
decisions for one word, because nothing enforced a single status→colour map or a single card contract.
Two more instances of the same root cause surfaced while fixing it: `.snode`/`.gate__badge`'s
`blocked` state rendered the SAME red as `rejected` (the canonical palette's `blocked` is hollow
neutral; only `failed`/`rejected` is red), and a registry connector's subscription-auth warning
hardcoded `var(--warn,#b45309)` — a colour the design brief's palette doesn't contain at all.

**The fix — one map, everywhere.** `src/board/status.ts` is now the ONLY place that decides what
colour a lifecycle status gets. It defines `CanonicalStatus` (`done`/`active`/`waiting`/`blocked`/
`needs-you`/`failed`/`exhausted` — the design brief's canonical state palette, plus `exhausted` for
NOTES F20's own loop-exhaustion state, kept inside the gate-brass family since an exhausted loop is
still a gate, still on the Conductor) and three pure `fromXxx` converters — `fromWorkUnitStatus`,
`fromArtifactStatus`, `fromNodeState` — that turn a domain status into one of those seven values.
`chipClass`/`dotClass`/`snodeClass` then turn a `CanonicalStatus` into the marker-family-appropriate
CSS class (each of `.chip`/`.dot`/`.snode` keeps its own historical class spelling — a shape/spelling
detail, not a second colour decision) and `statusChip()` renders the whole `<span>`. Every call site
in `render.ts` that used to hand-pick a class — `projectStatusChip` (Studio card + the new project-
header badge), the project page's work-unit row chip, the run-view `sstep` chip, the artifact render
view's status chip, the gate card's `blocked`/`exhausted` badges, and `miniScoreHtml`'s dots — now
goes through this module. `miniScoreHtml` had a second, independent bug of the same shape: it
collapsed `active` AND `blocked` into the same hollow `is-wait` dot even though `.dot.is-active`/
`.dot.is-blocked` already existed in assets/styles.css, dormant — the same "rule exists, renderer
never emits it" defect NOTES.md's G1 named for `.snode.is-danger`. Fixed by wiring `dotClass`/
`fromNodeState` through instead of a bespoke three-way ternary. The connector auth-warning now
renders `var(--fg-dim)` (neutral text, per the brief: "anything tempted toward amber is either
needs-you, or failed, or it renders neutral with text") instead of a colour outside the palette.

**The header (item 3).** New, top-level, spans the full width above the nav and content on every
screen at every viewport — `appHeader()` in render.ts, `.apphead` in the stylesheet. Left cluster: the
podium mark, the wordmark, and levare's own release version (read once from this repo's own
`package.json` via `sdk-transport.ts`'s existing `LEVARE_ROOT`, not a project's `deploy`/`pace`/
release vocabulary) as a quiet muted mono chip. Right cluster: the Orchestrator status — the same
`orchestratorIndicator()` component that already existed, unchanged in behavior (dot filled/green for
on, hollow/neutral for off, never red — a configuration state, never a failure) — a hairline divider,
then the theme toggle. This retires the old mobile-only `.mobilebar`, which duplicated the same three
elements only below 1080px; the header now renders them exactly once, at every width, and the old
rail-open hamburger moved into it (CSS-hidden above 1080px, same breakpoint).

**The left nav (item 4).** `railNav()` lost its `derivText` parameter and the "derived from ... on
every request" footer entirely (item 4c — a deliberate removal, not an oversight; the derivation-line
convention from phase 7.5 is explicitly superseded here). The Orchestrator section is gone (item 4a —
its status is now a header-level fact, not a duplicate rail row); the rail's old `railhead` (logo +
indicator) is gone too, since both now live in the header. Connector rows (item 4b) no longer print
their health as trailing text (`ok`/`missing-env`) — the dot alone still carries the signal — and are
now real links: `entityBlock()` gives every registry entity card a stable `id="${kind}-${name}"`, so a
connector row links straight to `/registry?entity=connectors#connectors-${name}`, plain browser anchor
scrolling, no new client-side JS.

**Studio (item 5).** Needs You, Running Now, and Projects now share ONE counter treatment
(`sectionCount()`) — a plain neutral mono badge, not a colored pill. Needs You's old brass-tinted
counter couldn't generalize to the other two without violating the brief's gate-colour scarcity rule
("gate brass ... appears exclusively on gates"); the gate CARDS themselves already carry that brass
wash inside `#needs`, so the heading count doesn't need to repeat it. A project card's meta line drops
"no deploy target" entirely (absence is shown by absence) and shows a release line only when the
project actually has one — no "no releases yet" text.

**Project page (item 6).** `project.repo`/`project.deploy` moved from left-aligned label rows in the
pointer card to right-aligned icon links beside the title (`iconLink()`, one reused external-link SVG,
`aria-label`/`title` distinguishing repo from deploy; the repo link prefers `project.remote`'s
browsable https form over the raw `repo` field, and is omitted entirely for a project like `studio`
whose `repo: .` points at levare's own working tree with no real external target). The page header
carries a status badge from the SAME `projectStatusChip` call the Studio card uses, so the two can
never independently drift. `pace` renders as a badge (`auto` reads as the in-flight blue, `step` as
the hollow-neutral waiting tone — never a new colour). `derive.ts#recentReleases` (a generalization of
the pre-existing `latestRelease`, which is now its own head) replaces the pointer card's hardcoded "no
releases tracked yet" stub with the project's actual most-recent shipped units, capped at 3, the
latest visually distinguished with the same canonical `done` green a shipped-status chip already uses.

**Verification.** `bun test` — 628 pass, 1 pre-existing skip, 0 fail, across 52 files, including new
coverage: `chipClass`/`fromWorkUnitStatus` cross-checks proving the map is a single source, and a
synthetic-repo render test proving the Studio project card, the project header badge, and a work-unit
row all emit the identical `is-active` class for the identical underlying status (never the old
`is-progress`). `levare replay fixtures/golden --stubs` — final artifact statuses still byte-for-byte
against `expected.json`. `deps:check` — `deps ok`.

**Deliberately out of scope.** The registry's entity-card internals (team/agent/skill/etc. layout)
are untouched beyond the connector auth-warning colour and the new stable `id` — the registry never
had its own design pass (NOTES E8) and doesn't get one here. The Orchestrator chat panel's own
message/composer markup is untouched. The "single card contract" (item 2) turned out to be mostly
already-true structurally — the project card, gate card, and work-unit row already put a title
top-left and a status badge top-right via the same `.pcard__top`/`.gate__top`/`.unit__head` flex
pattern before this pass; what was missing was never layout, it was the status colour disagreeing
across them, which item 1's canonical map now closes.

# NOTES UI2 — six board-consistency fixes on top of UI1's canonical map and card contract

**(1) Needs You cards named the artifact, never the unit.** `gateCardHtml`'s two artifact-carrying
variants — the ordinary approve/request/reject card and the artifact-blocked retry/skip/abandon card,
both of which render un-summoned in the Studio inbox (`gates.map(...)` with no `cta`) — led their
`gate__body` with the artifact's filename and producer only. A Conductor scanning Needs You had no way
to tell which work unit a gate belonged to without opening it. The start and blocked-unit gate variants
already named their unit (`tokenLink(gate.project, gate.unit, gate.unit)`), so the fix mirrors that
shape: a new `gateUnitTitle()` helper renders a `.gate__unit-row` — a plain bold link into the unit's
run view, top-left, above the existing artifact/producer line — reused by both `nameRow` (shared by the
cta and non-cta render paths, so the project page's "Review gate" summon and the run view's Orchestrator
card gain the same title for free) and the artifact-blocked card directly. Work units carry no separate
`title` field (`types.ts`); the unit slug is the name everywhere else in the product (the project page's
`.unit__name`), so it's what renders here.

**(2)+(3)+(4) Project page header — links below the title, Tabler icons, badge on the title line.**
`iconLink()` used to take one generic external-link glyph for both repo and deploy, rendered inside
`.phead__title` beside the h1; the status badge lived in the same row. Now `.phead__title` holds only
`<h1>` and the canonical status chip (`justify-content:space-between` pushes the chip right — the same
`.pcard__top` pattern the Studio card already used, applied to the page header), and `.phead__links` is
its own row directly underneath, inside `<header class="phead">` but outside `.phead__title`. `iconLink`
now takes an icon key (`"ti-brand-github"` | `"ti-world"`) and looks up inline Tabler-outline SVG path
data from a small `TABLER_ICON_PATHS` map — vendored, not fetched (no CDN, no icon font, per the design
brief's "no front-end frameworks" / single-binary constraint) — both rendered with
`stroke="currentColor"`, so they inherit ink like every other icon; no brand colour enters the board.
**Uncertainty worth flagging for Cas:** the design brief itself never names Tabler as the icon set (a
grep of `docs/levare-design-brief.md` for "tabler" is empty) — only this goal's own text does. Since the
brief is silent rather than contradicting, I followed the goal literally rather than treating it as a
conflict to resolve in the brief's favor. The two path strings were reproduced from memory of the
open-source (MIT) Tabler Icons set, not fetched live (this environment has no network access for design
assets and the standing constraint is "modify nothing outside this repository") — they're visually the
standard github-mark-in-a-stroke-outline and globe-with-meridians glyphs, but if pixel-exact fidelity to
the real `@tabler/icons` asset matters, worth a diff against the actual package before shipping.

**(5) Stat strip moved above the pointer/constitution block.** Pure reorder in `renderProject`'s `main`
template: `<div class="statstrip">...` now renders immediately after `<header class="phead">`, with
`${pointerPanel}` following it — matching the Studio page's own stats-then-content order. No CSS or
data changes; the two blocks were already independent siblings.

**(6) Studio's Projects section is now an In-flight worklist.** Renamed heading ("Projects" → "In
flight"); `projectCards` now maps over `inFlightProjects = [...repo.projects.values()].filter(p =>
repo.units.some(u => u.project === p.name && u.status === "active"))` instead of every project — the
same `status === "active"` check `projectStatusChip`/the project page's `anyUnitActive` already use, so
"in flight" means exactly what the status badge already calls active. A project with zero units or with
units that are all shipped/paused/blocked/abandoned drops out entirely (not just "zero units" — the
synthetic test below deliberately covers a project with one *shipped* unit, to catch a naive
`units.length > 0` filter that would have kept it). Idle projects stay reachable via `railNav`'s
unchanged project list and their own project page, whose header badge still renders the honest `idle`
chip (proven directly against the golden fixture's zero-unit `studio` project). The empty state — zero
in-flight projects, the common case between units — renders "Nothing in flight. Open a project from the
sidebar to start a unit." instead of an empty `.pcards` grid, so a quiet studio never reads as broken.

**Verification.** `bun test` — 633 pass, 1 pre-existing skip, 0 fail, across 52 files, including new
coverage: a Needs You card's `.gate__unit-row` title against the golden fixture; the project page's
title/links/badge/stat-strip ordering (title row has no `iconlink`, `.phead__links` follows it, badge
is the last child of the title row after the h1, stat strip precedes both the pointer card and
"Constitution"); and a new synthetic-repo describe block for item 6 covering the heading rename, the
active-vs-shipped-vs-empty filter distinction, and the empty-state copy. Two UI1-era tests that asserted
behavior for the golden fixture's idle `studio` project appearing IN the Projects section were rewritten
rather than deleted outright — one now asserts it's absent from In-flight, the other moved its "idle,
not fabricated running" assertion to the project's own page header, which item 6 never touches.
`levare replay fixtures/golden --stubs` — final artifact statuses still byte-for-byte against
`expected.json`. `deps:check` — `deps ok`. Manually verified against a live `levare serve
fixtures/golden --read-only` instance (not just render-function output) that the storefront project
page and the Studio In-flight section produce exactly the markup the tests assert.

**Deliberately out of scope.** The Orchestrator chat panel and the registry entity-card internals are
untouched, per this round's own instruction. The start/blocked gate card variants already named their
unit before this pass (via `tokenLink`) and were left in their existing `.gate__name-row` styling rather
than restyled to the new `.gate__unit`/`.gate__unit-row` treatment — same underlying data, cosmetically
inconsistent with the two variants this pass touched, but changing four render paths to fix two struck
a larger blast radius than the reported defect needed. `assets/*.html` (the CD prototype reference
files) are unreferenced by any server route or test — confirmed via grep before starting — and were left
untouched, consistent with the render.ts header comment that they're a superseded skeleton, not live
markup.

---

# NOTES — init/validate/test-suite honesty pass: three small correctness fixes, one theme

## F24. `levare init` omitted `evals/` — the third init-scaffold defect, closed by construction this time

**The defect.** `scaffoldStudio` (`src/init.ts`) created nine of the ten directories `validate.ts`
recognizes as registry entity homes — `evals/` had to be created by hand. A freshly-`init`'d studio's
own registry evals view therefore rendered against a directory that doesn't exist (reads as "not set
up"), while the rail's own count reads "evals 0" ("set up and empty") — two different UI stories about
the same absent directory, neither of them "you haven't made one yet, here's where it'd go." This is
the third init-scaffold defect after F11/F23's fictitious model ids and F23's stale finch `result:` —
each prior one was fixed by adding the specific missing thing, never by fixing the CLASS of bug (a
registry entity the scaffold forgets).

**The fix.** `src/init.ts`: `evals` added to `EMPTY_DIRS` (alongside `work`, `ideas` — no example eval
is scaffolded, same posture as those two: a fresh studio has none yet, inventing one would misrepresent
that). `board/onboarding.ts`'s `SKELETON_DIRS` (documents what `levare init` scaffolds, used only for
the "is this even a studio" first-run check) and the README's own layout diagram gained the matching
line, so neither drifts from what the scaffold now actually does.

**Closing the CLASS of bug, not just the instance.** `validate.ts#classify`'s per-directory schema
dispatch map was a function-local literal, invisible outside the module. Hoisted to a module-level,
exported `REGISTRY_SCHEMAS` — the registry's own, single list of entity kinds (`classify` now reads from
it instead of rebuilding an identical literal). `tests/init.test.ts` gained a test that asserts a fresh
scaffold contains every directory in `Object.keys(REGISTRY_SCHEMAS)` (plus `work/`, the one top-level
directory `validate.ts` special-cases outside that map since it holds units/artifacts, not a registry
schema) — derived from the registry's own source, never a second hardcoded array that could
independently drift the way `SKELETON_DIRS`/the scaffold's own directory list already had. A future
registry entity added only to `REGISTRY_SCHEMAS` and forgotten in `init.ts` now fails this test
immediately, instead of shipping as a fourth silent instance of the same bug.

**Tests.** `tests/init.test.ts`: the existing "produces exactly the expected skeleton directory set"
test gained `evals` to its expected list; a new test derives the expected directory set from
`validate.ts`'s own `REGISTRY_SCHEMAS` and asserts every one exists after `scaffoldStudio`.

## F25. An agent listed in more than one team's `members` silently took only the first team's grants

**The defect.** `env.ts#teamOf(repo, member)` resolves a member's team by returning the first team
whose `members` array lists it, iterating `repo.teams` in whatever order `Map` insertion (file-listing
order) produced. levare's model is one team per agent — teams are reused across projects, but an agent
is never reused across teams — so this was never meant to be a real ambiguity to break a tie on; it was
an unvalidated invariant. An agent accidentally (or deliberately, thinking it'd "just work") listed in
two teams' `members` silently got the FIRST team's connector grants (`env.ts#grantedConnectors`) and,
everywhere charter/guardrails are resolved through `teamOf`, the first team's rules — never an error,
never a warning, just quietly the wrong team's answer for every OTHER team that also claims the agent.

**The fix.** `validate.ts#validateAgentTeamMembership` (new): walks every `teams/*.md`, builds
member → [team names that list it], and for any member with more than one, raises
`AGENT_IN_MULTIPLE_TEAMS` naming the agent and every team that lists it, pointing at the resolution —
duplicate and rename the agent per team (e.g. `scribe-press`, `scribe-docs`) — rather than sharing one
definition. Wired into `validatePath`'s cross-entity checks alongside `validateStudioBindings`,
`validateResponsibleTeam`, etc. — runs whenever `teams/` exists, independent of `agents/` (unlike
`validateStudioBindings`, which needs both halves of the binding).

**Tests.** New `describe` block in `tests/validate.test.ts`: an agent named in two teams' `members`
fails with `AGENT_IN_MULTIPLE_TEAMS`, naming the agent and both teams, and the message contains the
duplicate-and-rename example; an agent in exactly one team is unaffected; the golden fixture (no shared
agents) has no such error.

**Verification.** `bun test` — 638 pass, 1 pre-existing skip, 0 fail, across 52 files. `levare replay
fixtures/golden --stubs` — final artifact statuses still byte-for-byte against `expected.json`.
`deps:check` — `deps ok`.

## Test suite: fixed ports collided with a `levare serve` already running, failing a different test each time

**The defect.** Four tests boot the real `./levare` binary as a subprocess and talk to it over a real
socket (`board-serve-e2e`, `board-serve-sse-leak`, `serve-real-cli-e2e`, `serve-cli-nonblocking-e2e`).
Each picked a port via `<base> + (process.pid % 400)` — a range, not a single fixed value, but still a
FIXED SET of ~400 candidates per file, all of them within reach of the CLI's own hardcoded default port
(`cli.ts#runServeCmd`, 4173) landing inside `board-serve-e2e`'s own 4100–4499 range. A developer running
`levare serve` unattended (normal during a UI review) on that default port made whichever subprocess
test's `pid % 400` landed on an occupied port fail with a bind error — a different test each run,
depending on the PID, which is exactly why it kept reading as a new, unrelated regression instead of the
same root cause four times.

**The fix.** All four now spawn via a new shared helper, `tests/serve-subprocess.ts#spawnLevareServe`:
always passes `--port 0` (OS-assigned ephemeral port — never contends with anything) and reads the
ACTUAL bound port back from the subprocess's own stdout (`runServeCmd`'s startup log line,
`levare serve · <root> → http://localhost:<port> ...`), which is already real and listening by the time
that line prints (`Bun.serve` binds synchronously before the log call). Each test file's `const PORT =
...` is gone; `base` becomes a `let` set inside `beforeAll` once the real port is known, everything
downstream (`fetch(`${base}/...`)`) is unchanged. No test depends on a specific port number anywhere in
the suite anymore (verified: `grep -rn -- "--port" tests/*.ts` outside `serve-subprocess.ts` is empty).

**Verified the actual failure mode is gone**, not just theorized: started a real `./levare serve
<scratch>` bound to the OLD default port 4173 in the background, then ran the full `bun test` suite
against it — 637 pass, 1 pre-existing skip, 0 fail, identical to a clean run with nothing listening.

**Verification (all three items).** `bun test` — 637 pass, 1 pre-existing skip, 0 fail, across 53 files
(new: `tests/serve-subprocess.ts`, a helper module, not a test file). `bun test` re-run with a decoy
`levare serve` bound to port 4173 — same result, 0 fail (the specific regression item 3 exists to kill).
`levare replay fixtures/golden --stubs` — final artifact statuses still byte-for-byte against
`expected.json`. `deps:check` — `deps ok`.

**Deliberately out of scope.** No other test file spawns `./levare` as a subprocess (confirmed by grep
before starting), so no fifth fixed-port site was left behind. The registry's other entity-card/render
internals, the Orchestrator panel, and every other test file are untouched.

---

# NOTES UI3 — the registry editor becomes an overlay, live-validated against the real validator

**The goal.** "Edit source" opened a textarea inline inside the entity's card — cramped (the card's
own width forces YAML lines to wrap), the only validity check ran on load/save rather than while
typing, and the only way out was "Save and commit" or navigating away entirely. Turn it into a proper
overlay editor: a centered panel over a dimmed backdrop, sized for YAML; a Cancel button beside Save;
Escape and a backdrop click as equivalent dismiss paths; a dirty-check gate on every dismiss path; and
live validation as the Conductor types, reusing the exact validator `levare validate` runs — never a
second, client-side implementation of any rule.

## The hard part: threading an unsaved buffer through the real validator, not a second one

`validatePath` (validate.ts) and every cross-entity check it calls (`validateStudioBindings`,
`validateAgentTeamMembership`, `validateResponsibleTeam`, `validateAgentContextScope`,
`validateKnownModels`, and the two helpers it depends on — `declaredAgentModels`,
`subscriptionAuthAgents` — plus `pricing.ts#loadPricing`, which UNKNOWN_MODEL's cross-reference walk
calls) all read their inputs straight off disk via `readFileSync`, at more than a dozen call sites.
Doing this cleanly (the goal's stated preference over a validate-on-temp-write fallback) meant every
one of those call sites had to become overlay-aware, not just the single-file schema pass — otherwise
an edit to `agents/lyra.md` that would trip `UNKNOWN_MODEL`, or a team-membership edit that would trip
`AGENT_IN_MULTIPLE_TEAMS`, would validate clean until the Conductor actually saved.

**The mechanism.** A new leaf module, `src/overlay.ts`: `OverlayFile { path: string; content: string }`
(a resolved absolute path plus the candidate content standing in for it) and `readOverlaid(file,
overlay)` — reads `overlay.content` when `resolve(file) === overlay.path`, else falls through to the
real `readFileSync`. `validatePath` gained an optional `overlay?: OverlayFile` parameter, threaded
downward as an added last argument to every function above (and to `loadPricing`, which needed the
same treatment for the case where the entity being edited IS `knowledge/model-pricing.md` itself — the
goal's own named example of a cross-reference check). Every `readFileSync(file, "utf8")` inside those
call chains became `readOverlaid(file, overlay)`. This is additive-only (all new parameters optional,
defaulting to `undefined` — real disk reads, unchanged) — `bun test` before this pass and after are the
same 638 tests, still green, before any new test was added for this round. `crossReference` and
`gitImmutabilityCheck` (work/ artifacts, consumes/supersedes resolution, approved-immutability) were
deliberately left untouched: the registry editor only ever edits registry entity files (teams/ agents/
skills/ knowledge/ types/ connectors/ projects/ evals/ ideas/), never a `work/` artifact, so those two
checks never see an overlay path and don't need to be overlay-aware.

**The route.** `POST /registry/check/*path` (serve.ts), matched ahead of the existing `POST
/registry/*path` write route in `ROUTES` (`matchRoute` is first-match-wins, so the more specific
literal `check` segment has to come first or the wildcard would swallow it). Confines to the same
`isRegistryEditablePath` allowlist the write route uses, 404s on an entity that doesn't exist on disk
yet (the overlay editor only ever opens on an existing entity — creating new ones isn't in scope),
parses `{ content }`, and calls `validatePath(ctx.root, { path: resolve(file), content })` — the WHOLE
tree, exactly as the write route's own post-write `validatePath(ctx.root)` call does, so the live
verdict is always identical to what saving would produce (the goal's explicit invariant). It never
writes anything, so it's `mutating: false` — exempt from the read-only-server gate (harmless against a
`fixtures/` demo tree; a Conductor should still be able to see live validation there) and from the
write-route CSRF check (a cross-site page that fires it can neither read the JSON response back,
having no ACAO header, nor cause a repo change). This is the one deliberate exception to
`board-routes.test.ts`'s "every non-mutating route is a GET" invariant, documented in that test rather
than silently loosened.

## The overlay itself

`render.ts#editorOverlay()` — ONE instance per registry page (not one per entity), a sibling of
`.app` inside `shell()`'s body, `hidden` by default. `entityBlock()` shrank: each card now carries only
the "Edit source" trigger (`data-edit-open`, plus `data-editor-name`/`data-editor-kind` so the overlay
can title itself without a second fetch) and a hidden `<textarea class="rawmd-source">` holding the raw
on-disk content — still raw markdown, no form fields, just no longer the editing surface itself.
`app.js`'s click handler on `data-edit-open` copies that hidden textarea's value into the overlay's own
editable textarea, shows the overlay, and fires an immediate check. Typing debounces ~250ms into
`POST /registry/check/*path`; the existing `.validity` dot and a new `.editor-overlay__errors` list
update from the response — `${code}  ${file}:${line}` plus the message, i.e. exactly what
`formatValidationErrors`/`levare validate`'s own CLI formatter (`cli.ts#formatResult`) already show,
never a re-worded version. Save stays `disabled` any time the buffer is anything other than
confirmed-valid (typing immediately disables it again, before the debounced re-check has even started
— never a stale-valid button). Cancel, Escape (`document`-level `keydown`, only acted on while the
overlay is open), and a backdrop click all funnel through one `requestDismiss()`: dirty (buffer differs
from what was loaded) prompts `window.confirm('Discard unsaved changes?')`; clean closes immediately.
Save itself is unchanged in behavior (`POST /registry/*path`, validate → write → commit as the
Conductor) but now also closes the overlay on success, in addition to the existing full-page reload.

**Styling** (`styles.css`) follows the design brief's existing vocabulary rather than inventing a new
one: `--panel`/`--border-strong`/`--shadow`/`--mono` (the same `.card` recipe every other bordered
surface uses), `z-index:200` (above the `52px` sticky header's `40`), a `min(760px, 100%)` panel wide
enough that YAML stops wrapping, a quiet `.16s` open transition respecting `prefers-reduced-motion`,
and an explicit `.editor-overlay[hidden]{ display:none; }` override — without it, the UA stylesheet's
`[hidden]{display:none}` and this file's own `.editor-overlay{display:flex}` are equal-specificity
author-vs-UA rules and the author rule silently wins, which would have made `hidden` a no-op bug
invisible until manually clicking around a live server (caught here before it shipped, not after).

## Testing app.js's real behavior without a browser-automation dependency

The goal's achieved-when list requires a render test proving Cancel/Escape/backdrop dismiss the
overlay — genuine DOM/event behavior, not just markup presence. This project has zero dependencies
beyond `@anthropic-ai/claude-agent-sdk` (`deps:check` enforces it) and zero precedent anywhere in its
600+ test suite for DOM/browser-automation testing; reaching for `happy-dom` or similar was tried and
reverted (`bun add -D happy-dom` pulled in 36 transitive packages, at odds with a project whose whole
posture — hand-rolled YAML parser, hand-rolled validator, no front-end framework — is minimal and
dependency-free by design).

**The choice:** `tests/board-editor-overlay.test.ts` hand-rolls a deliberately small DOM (~250 lines):
an `EventTarget`/`Element`/`Document` triad supporting exactly the attribute/classList/value/
textContent/querySelector-family surface `app.js`'s overlay block touches, a minimal selector matcher
(single-class/attr/tag/id, comma lists, one descendant level — enough for every selector the overlay
code actually calls, and harmless-by-construction for the handful of unrelated selectors elsewhere in
`app.js` that this fixture simply doesn't contain elements for), and controllable fake `setTimeout`/
`clearTimeout` (so the 250ms debounce is provably exercised — including that two rapid keystrokes
coalesce into exactly one re-check — without costing real wall-clock time) plus a scriptable
`fetch`/`window.confirm`/`location.reload`. The real `assets/app.js` is loaded verbatim via `node:vm`
(confirmed available under Bun) and executed against this fixture; DOMContentLoaded is dispatched
exactly once, same as a browser. This tests the ACTUAL shipped file, not a reimplementation of its
logic — the one path that couldn't accidentally drift from what a browser really runs. A companion
string-assertion test in `board-render.test.ts` (`renderRegistry`'s real HTML output) keeps the
hand-built fixture's classes/attributes honest against the real templates.

## Tests

`tests/board-serve.test.ts`: a passing buffer against `POST /registry/check/*path` reports `ok:true`
without writing; a malformed one reports the real `UNKNOWN_KEY` error, also without writing; the
critical case — an `agents/lyra.md` buffer with an unknown model trips the cross-reference
`UNKNOWN_MODEL` check via the unsaved content (proven by asserting the file on disk is byte-identical
before and after, and that the SAME unedited content round-trips as `ok:true` through the identical
route); a 404 for an entity that doesn't exist and a 400 for a path outside the registry allowlist; and
a read-only board still answers it (no write side effect, unlike the save route it sits beside).

`tests/board-editor-overlay.test.ts`: opening populates the overlay's title/kind/textarea from the
clicked card and fires an immediate check; rapid keystrokes debounce into exactly one re-check and Save
stays disabled until it resolves `ok`; an invalid response renders the real error code/location/message
inline and keeps Save blocked; clicking a disabled Save does nothing (no POST); a successful Save
targets the write route (not the check route), closes the overlay, and reloads; and — the dismiss-path
requirement — Cancel, Escape, and the backdrop each close immediately with no prompt on a clean buffer,
and each prompt `"Discard unsaved changes?"` on a dirty one (declining leaves the overlay open,
confirming closes it).

`tests/board-render.test.ts`: the two pre-overlay tests describing the old inline `rawmd-edit`
textarea/per-card Save button were rewritten for the new architecture (hidden `rawmd-source` +
`data-edit-open` trigger, one shared overlay instead of N inline editors) rather than deleted; a new
test asserts the overlay is a hidden sibling of `.app` (not nested inside it, present after it in the
document, before `</html>`) while board content (rail, an entity card, the Orchestrator panel) remains
in the same document — the "overlay, not a route" requirement, proven on the real render output.

`tests/board-routes.test.ts`: the "every non-mutating route is a GET" invariant test now documents and
asserts its one exception (`POST /registry/check/*path`) by name, rather than being loosened silently.

**Verification.** `bun test` — 650 pass, 1 pre-existing skip, 0 fail, across 53 files. `levare replay
fixtures/golden --stubs` — final artifact statuses still byte-for-byte against `expected.json`.
`deps:check` — `deps ok`. Manually verified against a live `levare serve <scratch>` instance (not just
render-function/test output): `GET /registry` carries the overlay markup and one `data-edit-open`
trigger per entity card; `POST /registry/check/teams/kestrel.md` with the unedited on-disk content returns
`{"ok":true,"errors":[]}`; the same route with a deliberately malformed buffer
(`bogus_key`, several fields dropped) returns the real `UNKNOWN_KEY`/`MISSING_FIELD` errors while the
file on disk is confirmed byte-unchanged afterward; served CSS parses with balanced braces.

**Deliberately out of scope.** Creating a NEW registry entity (there's no "new" affordance today,
inline or otherwise — "Edit source" only ever opens on an entity that already exists) — the check
route's 404-on-missing-file behavior reflects that scope, not an oversight. The Orchestrator panel,
gate cards, and every other registry-adjacent screen are untouched. `crossReference` and
`gitImmutabilityCheck` (work/ artifact consumes/supersedes and approved-immutability) were not made
overlay-aware, since the registry editor never edits a `work/` file — see "the hard part" above.

---

# NOTES UI4 — registry consistency: the confirm modal, human-only validation messages, the bare
# entity tag, and registry URLs as path segments

**The goal.** Four independent rough edges in the registry surface UI3 shipped: (1) the overlay
editor's dirty-dismiss called the browser's native `confirm()` — off-palette, thread-blocking, and
needed to become a reusable in-app primitive, not a one-off; (2) the editor's inline validation
echoed the CLI's own `CODE  file:line` format verbatim, which is meaningless in a buffer with no
visible line numbers; (3) an agent's registry tag read "agent · &lt;team&gt;" while every other kind
shows only its bare type; (4) registry URLs still used `?entity=` query params and `#fragment`
anchors while `/project/<name>` and `/idea/<name>` are paths. All four are presentation/routing
fixes — no validation rule, CLI output, or client-side schema changed anywhere in this round.

## Item 1: the confirm-modal primitive

**The mechanism.** `render.ts#confirmModalHtml()` — one `<div id="confirm-modal" hidden>` per page,
a sibling of `.app` inside `shell()` (same "hidden by default, painted on demand" shape as UI3's
`editorOverlay()`), so it renders on every screen, not just the registry — the goal's explicit
requirement that the upcoming visual-standardisation pass can adopt it as the board's standard
confirmation surface rather than build a second one. Centered panel, dimmed backdrop, a plain
question (`<p class="confirm-modal__question">`, populated at open time) and two actions
(`data-confirm-keep` / `data-confirm-discard`) — same recipe as the editor overlay (`--panel`,
`--border-strong`, `--shadow`), `z-index:220` (above the editor overlay's own `200`, since the
dirty-dismiss confirmation opens ON TOP of the overlay it's confirming the dismissal of).

`app.js#confirmModal(question, opts)` — a small IIFE returning a function that shows the modal,
sets the question text and (optional) button labels, and returns a `Promise<boolean>` (`true` = the
destructive action was confirmed) resolved by whichever of Discard / Keep editing / backdrop /
Escape fires first. Callers read like `window.confirm` used to (`confirmModal(q).then(discard =>
...)`) without ever calling it. The overlay's `requestDismiss()` is now: a clean buffer closes
immediately; a dirty one calls `confirmModal('Discard unsaved changes?')` and only discards if it
resolves `true`. No native `confirm()`/`alert()` remains anywhere in `assets/app.js` — asserted by a
new test in `tests/board-editor-overlay.test.ts` that strips comments (the file's own prose
legitimately says "confirm()" by name, documenting what was replaced) and regexes the remaining code
for `window.confirm(`/`confirm(`/`alert(`.

**Tests.** `tests/board-editor-overlay.test.ts`'s hand-rolled DOM fixture grew a `#confirm-modal`
sibling (backdrop, question, keep/discard buttons) alongside the existing editor-overlay fixture; the
fake `window` in `setupOverlay()` now carries no `confirm`/`alert` at all — a regression back to the
native dialog would throw `window.confirm is not a function` straight out of the click handler and
fail loudly, not silently pass. The dismiss-path tests were rewritten against the modal: a clean
buffer never opens it; a dirty buffer opens it with the question text set, Keep-editing leaves the
editor overlay open, Discard closes it, and the modal's own backdrop click behaves the same as
Keep-editing. `tests/board-render.test.ts` asserts the modal markup is present, hidden, and carries
its three `data-confirm-*` hooks on every screen (studio/project/run/registry), not just the
registry.

## Item 2: the editor shows the human message, not the CLI's code/file/line

**The change.** `app.js#renderErrors` used to build one `<span class="mono">` per error reading
`${code}  ${file}${line ? ':' + line : ''}` plus a `<p>` for the message — exactly
`cli.ts#formatResult`'s own format, mirrored verbatim. The editor shows no line numbers anywhere in
its buffer, so a bare `:line` locator pointed at nothing the Conductor could see, and the code/file
prefix is a grep target for a script, not something a human editing a buffer needs. `renderErrors`
now emits the message alone; the removed CSS rule for the code/location line
(`.editor-overlay__err .mono`) is gone, and the message paragraph itself now carries the danger
tint that line used to.

**What did NOT change.** `POST /registry/check/*path` (serve.ts) still returns the full
`{ code, message, file, line }` per error — verified live against a running server (unchanged JSON
payload) and by a `tests/board-editor-overlay.test.ts` assertion that feeds the SAME
code/file/line-bearing error object through the real `renderErrors` and asserts only the message
survives. `levare validate`'s own CLI output is untouched — a new test in `tests/validate.test.ts`
runs `./levare validate fixtures/rejections/malformed-frontmatter` and asserts the real stderr still
contains `PARSE_ERROR`, the `file:line` locator, and the message, proving one validator and one rule
set, two presentations rather than a second, quietly-diverging implementation.

## Item 3: the bare entity tag

**The change.** `renderRegistry`'s agent-card mapper called `entityBlock` with
`` `agent${team ? ` · ${team.name}` : ""}` `` as the kind label — the one entity kind whose tag
carried a second field. Every other kind (`team`, `skill`, `knowledge`, `type`, `connector`, `eval`)
passes its bare type string. Changed to the literal `"agent"`; the team association is unaffected —
it was already rendered separately on the card body via the existing "wears" row
(`agentBlocks`'s `inner` string), so nothing about *which* information is available regressed, only
where the tag itself lives.

**Tests.** `tests/board-render.test.ts`: an agent card's `.entity__kind` text is exactly `"agent"`,
never containing `"agent &middot;"` or `"agent ·"`; a second test walks every `.entity__kind` span on
the whole registry page and asserts each is one of the seven bare type words.

## Item 4: registry URLs become path segments

**The routes.** Two new GET routes in `serve.ts`, both `page: true` (same onboarding gate every
other screen route gets): `/registry/:entity` (the list view for that kind) and
`/registry/:entity/:name` (the SAME list view, with `renderRegistry`'s new `highlightName` param
naming the one entity to scroll to and highlight — explicitly NOT a second detail-page screen, per
the goal). The existing `GET /registry` (query-param form) is untouched — a cold `?entity=connectors`
link or bookmark still resolves exactly as before; nothing in this round required a redirect. Because
`matchRoute` requires an exact path-segment-count match, `/registry`, `/registry/:entity`, and
`/registry/:entity/:name` never collide with each other regardless of table order.

**The highlight mechanism.** `renderRegistry` resolves `highlightName` into the exact `id`
`entityBlock` already gives that card (`${activeKind}-${name}`, e.g. `connectors-linear`) and stamps
it as `data-highlight="..."` on the page's `<main>` — computed once, server-side, so app.js never has
to re-derive an id from the URL itself. `app.js` reads that attribute on `DOMContentLoaded`
unconditionally (no dependency on any interactive tab-switch state) and, if the named element exists,
calls `scrollIntoView({block:'center'})` and adds `.is-highlighted` — a quiet 1.6s ink-neutral ring
(`assets/styles.css`, respecting `prefers-reduced-motion`), never the accent (design brief: accent is
the Orchestrator's voice only) and never a team hue or gate brass (both already mean something else).
This is the path-based replacement for the old `#<kind>-<name>` fragment anchor's plain browser
scroll-to-anchor behavior, which a path segment (no URL fragment) can't trigger natively.

**Link updates + back/forward.** `registryNavLinks` (the rail's Registry section and the in-content
tab strip — one shared list, so the two can't drift) and `railNav`'s connector rows now emit
`/registry/<kind>` and `/registry/connectors/<name>` instead of `/registry?entity=<kind>` and
`/registry?entity=connectors#connectors-<name>`. The pre-existing client-side interception on
`[data-goto]` clicks (`app.js`'s old "registry: entity switch" block — `preventDefault()` plus a DOM
swap, never touching the URL or browser history) is deleted outright: switching kinds is now a plain
`<a href>` navigation, a fresh server render on every click (PRD invariant 2). This is also what
makes browser back/forward behave correctly across registry navigation for free — there is no
client-side router state to get out of sync with history, because there is no client-side router.

**Tests.** `tests/board-render.test.ts`: the rail/tab-strip links point at `/registry/<kind>`, never
`?entity=`; connector rows point at `/registry/connectors/<name>`; `renderRegistry(kind)` alone
carries no `data-highlight`; `renderRegistry(kind, name)` carries the exact expected
`data-highlight` value while the list view still renders every other entity's card (not a detail
screen). `tests/board-serve.test.ts` — the routing-level proof the goal calls for by name: a cold,
in-process `board.fetch()` GET (no prior navigation, no client state) of `/registry/teams` and of
`/registry/connectors/linear` both return 200 with the right kind active and (for the second) the
right highlight target, never a 404 or a blank fallback; every one of the seven kinds resolves as a
cold path GET; the legacy `?entity=` form still resolves unchanged; the rail/tab links in the served
HTML never contain the old `?entity=` string.

**Verification (all four items).** `bun test` — 665 pass, 1 pre-existing skip, 0 fail, across 53
files. `levare replay fixtures/golden --stubs` — final artifact statuses still byte-for-byte against
`expected.json`. `deps:check` — `deps ok`. Manually verified against a live `levare serve` instance:
`GET /registry/connectors/linear` cold (no prior page load) returns 200 with `connectors` active and
`data-highlight="connectors-linear"` present, both connector cards rendered; `GET /registry/teams`
and the legacy `GET /registry?entity=connectors` both 200; every rail/tab link in the served HTML is
path-form; `POST /registry/check/agents/lyra.md` with a deliberately broken buffer still returns the
full `code`/`file`/`line`-bearing error array unchanged (proving item 2 is a display choice, not a
payload change).

**Deliberately out of scope.** No redirect from the legacy `?entity=` form to the path form — the
goal accepts either "still resolve or redirect," and resolving unchanged is the smaller, lower-risk
change. The visual-standardisation pass that will adopt the confirm-modal primitive elsewhere (e.g.
future destructive actions outside the registry editor) is not part of this round — only the
primitive and its one current caller (the editor's dirty-dismiss) are built here. `assets/registry.html`
(the superseded CD prototype file, never served by `serve.ts`) was left untouched.

# NOTES UI5 — registry page title reflects the entity kind; the redundant in-page tab strip is gone

**The complaint.** Two corrections to the registry surface UI4 left behind. (1) Every registry page
rendered a hardcoded `<h1>Registry</h1>` regardless of which entity kind was on screen — the only
screen in the product that titles itself by section rather than content; `renderProject`/`renderIdea`
both title by what they're showing (`projectName`, `idea.name`). (2) The registry page still rendered
an in-content horizontal tab strip (`teams · agents · skills · …`) duplicating the rail's own
Registry section, now that every kind has a real route reachable from the left nav.

**Item 1: the H1.** `renderRegistry` (`src/board/render.ts`) already resolves and validates
`activeEntity` into `active: RegistryKind` (defaulting to `"teams"` when absent or invalid — the
same fallback the rest of the function already relied on for the tab strip and rail highlighting).
The literal `<h1>Registry</h1>` is now `<h1>${title}</h1>` where `title` capitalizes `active`'s first
letter — every `RegistryKind` is a plain, regular-plural lowercase word (`teams`, `agents`, `skills`,
`knowledge`, `types`, `connectors`, `evals`), so a bare `charAt(0).toUpperCase() + slice(1)` needs no
irregular-plural table. The breadcrumb directly above it (`studio / registry`) is untouched, per the
goal — it names the section, the H1 now names the content, same split `renderProject`/`renderIdea`
already draw between the rail/breadcrumb and their own H1.

**Item 2: the tab strip.** Before removing it, confirmed the rail's own Registry section
(`railNav`, same file) renders independently of the tab strip and already carries every kind's
count: both call the same shared `registryNavLinks()` helper, which builds each link from
`registryKindCount()` — so no count lived only in the tab strip. Deleted the tab strip's own
`<nav class="reg-nav" style="flex-direction:row...">` construction and its injection into `<main>`
between the header and the card grid; `registryNavLinks()` itself is untouched and still has its one
remaining caller in `railNav`. No CSS change needed — `.pcards`/`.phead` have no margin rule coupled
to `.reg-nav`'s presence.

**Tests.** `tests/board-render.test.ts`: a new `describe` asserts, for all seven kinds, that
`renderRegistry(repo, root, kind)` contains `<h1>${Title}</h1>` and never `<h1>Registry</h1>`, plus
that the breadcrumb still reads `studio / registry`. The old tab-strip-specific tests (which matched
`<nav class="reg-nav" style="flex-direction:row...">` and asserted rail/tab-strip parity) are replaced
with one that asserts no such element exists anywhere in `<main>`, and that the rail alone lists every
kind with a `data-goto`/count pair, active-kind highlighting included. `tests/board-serve.test.ts`'s
cold-GET assertions of `<h1>Registry</h1>` for `/registry/teams` and `/registry/connectors/linear`
are updated to the entity-specific titles (`Teams`, `Connectors`); its "rail and tab strip" test is
renamed to just "rail" now that there's only one link surface.

**Verification.** `bun test` — 673 pass, 1 pre-existing skip, 0 fail, across 53 files, 2468
`expect()` calls. `levare replay fixtures/golden --stubs` — final artifact statuses still
byte-for-byte against `expected.json`. `deps:check` — `deps ok`.

**Deliberately out of scope.** No change to `registryKindCount`/`registryNavLinks` themselves — both
were already correct and shared; this round only removed the tab strip's separate rendering of that
same shared list. No change to how `activeEntity` is resolved or defaulted (`"teams"` when absent),
so `GET /registry` with no kind still titles itself "Teams", matching its pre-existing tab-strip and
rail-highlight behavior.

# NOTES UI6 — the shared component vocabulary: `src/board/components.ts`, and every existing renderer
# collapsed onto it

**The goal.** Extract the board's recurring UI patterns — the card contract, status/pace badges, kind
tags, icon links, the stat strip, section counters, empty states, local pending feedback, and the
confirm-modal/overlay surfaces — into one new module (`src/board/components.ts`) and replace the
hand-written markup for each pattern everywhere it appears, so a status colour or a card layout becomes
impossible to set locally. The proof is deletion: `render.ts` should get smaller, not just gain an
import. The one intended behaviour change is `pendingState` — a work-unit (gate-card) action must give
local, in-place feedback instead of replacing the whole card with a loading bar.

**Read first.** `docs/levare-design-brief.md` in full (the authority for every token/colour/dimension
these primitives may use) and `src/board/status.ts` (the canonical status→colour map every badge must
route through — unchanged in this round, only re-exposed through one more layer).

## The module: `src/board/components.ts`

Ten primitives, each a pure function (repo/derived data in, an HTML string out — same discipline as
`render.ts` itself):

- `statusBadge(status, label?, extraClass?)` — a thin, verbatim wrapper over `status.ts`'s own
  `chipClass`/`statusLabel` decision. It is now the ONLY function anywhere that may emit a `.chip`
  element; `render.ts` no longer imports `statusChip` from `status.ts` at all, and every one of its
  eleven former `statusChip(...)` call sites is now `statusBadge(...)`.
- `paceBadge(pace)` — moved from `render.ts` verbatim (it already called `statusChip`; it now calls
  `statusBadge`).
- `tag(text, cls = "entity__kind")` / `chip` (an alias) — the small bare-word label treatment. Its one
  concrete caller today is the registry's entity-kind tag; the `cls` parameter exists so a future
  second use isn't forced to either duplicate the function or hardcode `entity__kind`'s CSS class onto
  an unrelated surface.
- `iconLink({ icon, href, label })` — moved from `render.ts` verbatim, signature changed from three
  positional args to the goal's object form. `TABLER_ICON_PATHS` moved with it.
- `statStrip(stats: Stat[])` — the Studio and Project stat grids. Both screens now build an array of
  `{ value, label, cls?, attr? }` and hand it to the same function; `grid-template-columns` is derived
  from `stats.length` rather than hardcoded per screen (both currently pass 5, but the coupling that
  used to exist — two separate `repeat(5,1fr)` literals that could silently drift if one screen gained
  a stat — is gone).
- `counter(n, { variant, gatecount })` — replaces the old `sectionCount` (Needs You / Running Now / In
  flight headings) AND is now also the registry rail's per-kind count (`<span class="ct">`), which
  used to be a bare inline template at the `registryNavLinks` call site. `variant: "nav"` picks the
  `.ct` vocabulary instead of `.sec__count` — the CSS class differs by context (as it always did), the
  function and the "plain neutral, never gate brass" decision (item 5a) are made once.
- `emptyState({ message, action? })` — see scope note below.
- `pendingState({ label })` — see the behavioural-change section below.
- `card(opts)` — the canonical card contract (title top-left, status top-right, tags/body/meta along
  the bottom). See "the card primitive" below for exactly what it does and does not unify.
- `confirmModal()` / `editorOverlay()` — moved from `render.ts` verbatim (built in UI4/UI3). No
  behavior change; `render.ts`'s `shell()` and `renderRegistry()` now import and call them instead of
  defining them locally.

## The card primitive — what it unifies, and what it deliberately doesn't

`card()` takes a wrapper tag/class/attrs, an optional `pre` slot (content before the title — a type
glyph, a gate marker), an optional `bodyWrapCls` (when given, the title plus a `titleExtra` block are
wrapped together ahead of `status`, matching the gate card's `.gate__body` anatomy; when absent, title
and status sit directly in the top row, matching the project-card/entity-card/unit-row anatomy), and
`tags`/`body`/`meta` slots that follow in order. Every surface keeps its own historical CSS class
family (`.pcard`, `.entity__*`, `.unit__*`, `.gate__*`) — same reasoning `status.ts` already documents
for `.chip`/`.dot`/`.snode`: the SPELLING varies by surface, the STRUCTURAL DECISION (where the title
sits, where the status sits, where supporting content sits) is made exactly once, in this function.

Routed through `card()`: the studio project card (`pcard`), the registry entity card (`entityBlock`,
now ~15 lines shorter and with no bespoke `<article>` template), the project page's work-unit row
(`.unit`/`.unit__head`, the goal's "row variant"), and the gate card's DEFAULT variant (the Needs You
inbox / project-summon card — by far the most common gate rendering).

**Deliberately NOT routed through `card()`: the gate card's `start`, `blocked`, `artifact-blocked`, and
`cta` variants.** These four have real anatomical differences from the default variant and from each
other (the `cta` variant replaces the marker+badge top row with a banner and folds the verbs INSIDE
`.gate__inner` rather than after it; `blocked` has no verbs at all; `start`'s context paragraph and
badge text both branch on `dispatching` in ways the default variant's don't). Forcing all five gate
variants through one call shape would have meant either a `card()` so parameterized it stops being a
real abstraction (more branching in the primitive than it saves at the call site), or quietly
normalizing the four variants' markup toward each other — a visual/structural change the goal's "pure
refactor... must render identically" constraint rules out. `tests/board-components.test.ts` asserts
this scope exactly: zero literal `<div class="pcard__top">`/`<div class="entity__head">`/
`<div class="unit__head">` remain in `render.ts`'s source, and exactly 3 (not 4) literal
`<div class="gate__top">` occurrences remain — start, blocked, artifact-blocked, in that order in the
file. The three untouched variants still call `statusLabel`/`pendingState`/`dispatchingHtml` as before;
only their own outer template stays hand-written.

## `emptyState` — scope

Routed through `emptyState()`: the Needs You inbox, Running Now, In Flight (the goal's named example —
`{ message: "Nothing in flight.", action: "Open a project from the sidebar to start a unit." }`), and
the run view's Timeline — the board's four true section-level "this section has no content" states.

**Deliberately NOT routed through `emptyState()`:** the studio rail's ideas list
(`no ideas captured yet`) — the design brief is explicit that the ideas list must stay "the most
understated element on the page: a backlog, not a to-do; no counts, no urgency styling" — giving it the
same structured treatment as an actionable empty section would be a small but real regression against
that instruction, not a neutral refactor. Also not routed: the small inline lineage/founding/recipe
placeholder rows (`no founding artifacts yet`, `supersedes nothing`, `none declared`, `not referenced
yet`, `No body content.`) — each of these is a single placeholder ROW inside a card/section that DOES
have content (the Constitution card, the Lineage card), not a whole section with none; the design
brief's emptyState language ("the section has no content") doesn't describe them, and their existing
`.founding`/inline-style treatment is a different, smaller-scoped component this goal didn't ask to
touch. No test asserts their exact byte-for-byte markup (checked before making this call), so this is a
scope decision, not a constraint the tests forced.

## `pendingState` — the one intended behaviour change

**Before.** `assets/app.js#markDispatching` — called the instant a Start/Request-changes/Retry verb is
clicked, before the server round-trip completes — replaced the ENTIRE gate card's `innerHTML` with a
bare "dispatching…" line. Title, producer, context, and badge all vanished until the next SSE-driven
reload replaced the whole card with the server's real re-render. This was the anti-pattern the goal
named by name ("clicking an action on a work unit replaces the entire unit with a loading bar").

Notably, the SERVER-rendered dispatching state (`render.ts#gateCardHtml`'s `dispatching` branch, shown
when the daemon's `running()` projection already has an invocation for that unit — e.g. on a page
load that lands mid-dispatch) was already local: it only ever swapped the verbs row and, for the
start-gate variant only, the badge text, leaving the rest of the card exactly where it was. The bug was
specifically in the CLIENT's immediate, pre-round-trip feedback, not the server's eventual one.

**After.** `pendingState({ label })` (components.ts) produces the same small `<span class="pending">`
markup — the composer's existing quiet dots (`.msg--pending .msg__dots`, reused verbatim, not a new
animation) plus a `.pending__label` — that `render.ts#dispatchingHtml` now renders into the
`.gate__verbs` row. `assets/app.js#markDispatching` was rewritten to build the IDENTICAL DOM shape via
`document.createElement`/`classList`/`appendChild` (not a raw `innerHTML` string) and apply it
narrowly: add `is-dispatching` to the card, set `.gate__badge.is-start`'s text to "dispatching" (ONLY
when that class is present — the default/artifact-blocked badges never change server-side either;
overwriting "on you" or "blocked" would have been a new, wrong divergence from the server's own
rendering), and swap the CONTENTS of `.gate__verbs` alone. One edge case found while writing this:
`openNote()` (the Request-changes/Re-scope note composer) appends a SECOND `.gate__verbs` element
(its own Send/Cancel row) as a sibling of the original, now-hidden one — `card.querySelector`'s
first-match semantics would have targeted the wrong (invisible) row. Fixed by threading `card._note`
(already tracked for the note-composer lifecycle) through so `markDispatching` targets whichever
`.gate__verbs` is actually on screen; the submitted note's `<textarea>` is also disabled, not removed,
during the pending window, so the just-typed request text stays visible rather than vanishing.

**Tests.** `tests/board-pending-state.test.ts` — new. Exercises the REAL `assets/app.js` (loaded
verbatim into a `node:vm` sandbox, same no-DOM-library approach `tests/board-editor-overlay.test.ts`
established) against two fixtures matching `render.ts`'s actual gate-card anatomy: (1) clicking Start
on a start-gate card — asserts the title/context/producer are still present and unchanged afterward,
only `.gate__badge`'s text and `.gate__verbs`' contents changed; (2) clicking Request changes then Send
— asserts the pending indicator lands on the visible Send/Cancel row (not the original, hidden one),
the original row is confirmed `display:none`, and the card's title/producer/context are untouched
throughout. Building this harness required two small additions to the (locally-scoped, non-shared)
fake-DOM harness beyond what `board-editor-overlay.test.ts` needed: `closest()` had to support
descendant-combinator selectors (`.gate [data-verb]` — `board-editor-overlay.test.ts` never exercises a
selector shaped like this, only single-compound ones) via the same multi-step ancestor walk
`querySelectorAll` already used, and a minimal `innerHTML` setter/parser for the one fixed
`<button ...>text</button>` shape `openNote()` builds.

## Everything else — byte-for-byte

Because most of this repo's board tests assert literal HTML substrings (not just presence of text),
the refactor's correctness bar was almost entirely "produces the exact same bytes, through a shared
function instead of a duplicated template." `bun test` before and after this round shows the same 146
`board-render.test.ts` assertions passing unchanged — the primitives were built by extracting the
EXISTING template literals into `components.ts` functions and calling them with the exact same
arguments, not by redesigning the markup and hoping tests still matched.

**Tests (new, beyond `board-pending-state.test.ts` above).** `tests/board-components.test.ts` — unit
tests for all ten primitives in isolation (exact-string assertions on `card()`'s two slot shapes, the
gate-badge-audit source check, the statStrip-shared-by-both-screens check, the emptyState scope check,
the confirmModal/editorOverlay relocation check).

**Verification.** `bun test` — 690 pass, 1 pre-existing skip, 0 fail, across 55 files, 2551 `expect()`
calls (up from 673/53/2468 before this round — 17 new tests, two new files). `levare replay
fixtures/golden --stubs` — final artifact statuses still byte-for-byte against `expected.json`.
`deps:check` — `deps ok`. `bun build` on both `render.ts` and the new `components.ts` succeeds with no
unused-import or unresolved-reference errors.

**Net effect on `render.ts`.** 275 lines changed: 110 insertions, 165 deletions — net smaller (-55
lines) despite gaining an 11-name import line and several explanatory comments on the new `card()` call
sites. The functions it lost entirely: `confirmModalHtml`, `editorOverlay`, `sectionCount`, `paceBadge`,
`iconLink`, `TABLER_ICON_PATHS`. `dispatchingHtml` shrank from a 5-line template to a 1-line call.

**Deliberately out of scope / uncertainty recorded, not asked about.** (1) The four gate-card variants
left outside `card()` — see above; a future round could still attempt a more general shape if a fifth
gate anatomy variant ever appears and the pattern becomes clearer. (2) `tag`/`chip` has exactly one
real caller today (registry kind tags) — the `cls` parameter is speculative generality for the goal's
"etc." but nothing else in the current renderers needed a second bare-word-tag treatment; grepped for
one and found none. (3) No CSS class was renamed or removed — `.pcard__top`/`.entity__head`/
`.unit__head`/`.gate__top`/`.gate__body` all still exist in `assets/styles.css` exactly as before;
`card()` only stopped duplicating the JS/TS string templates that produce them, per the goal's own
framing ("the SPELLING still varies by marker shape... the DECISION is made exactly once" — status.ts's
own words, extended here from status colour to card structure). (4) Two small, additive CSS rules
(`.empty`/`.empty__action`/`.pending`/`.pending__label`) were the only styles.css changes; both reuse
existing custom properties (`--fg-mute`, `--fg-dim`) exclusively — no new colour, dimension, or font
was introduced anywhere in this round.

## DIST1. A real single-binary build via `bun build --compile`, and an honest `levare --version`

Step 1 of distribution (phase-1's aspirational "single binary" made real): a `build` script
(`scripts/build.sh`, invoked as `bun run build`) compiles `src/cli.ts` into a standalone executable at
`dist/levare`, stamped with the git commit it was built from; `levare --version`/`-v` prints that
stamp, or an honest "source/dev" when unstamped; `levare doctor` now states its own run mode
(compiled vs. source) first, for the same reason. `./levare`, the documented dev shim (NOTES A3), is
unchanged and still the primary way this repo is run day to day — this only adds a second, parallel
path.

**Version stamping (`src/version.ts`).** The package version comes from a static `import pkg from
"../package.json" with { type: "json" }`, not a `readFileSync` against a resolved repo path — the
latter is exactly the kind of read that breaks under `--compile` (see below). The build commit is
injected via `bun build --define __LEVARE_BUILD_COMMIT__="\"<short-sha>\""`; `typeof
__LEVARE_BUILD_COMMIT__ !== "undefined"` is the standard esbuild/bun `--define` fallback idiom —
`typeof` never throws on an identifier that was never declared (unlike referencing it directly), so
the same code path is correct whether or not `--define` ran. `getVersionInfo()` returns `{ version,
build: {commit} | null }`; `formatVersion()` renders `levare 0.0.1 (build 2b0610f)` or `levare 0.0.1
(source/dev)` — never a fabricated hash. `levare doctor` prints the same distinction as its first
line (`run mode: compiled (build …)` / `run mode: source/dev`) via an optional `VersionInfo` parameter
on `formatDoctor`/`runDoctor`, following the same "optional, appended, absent ⇒ unchanged" shape
`orchestrator` already established there — pre-DIST1 callers are unaffected.

**A pre-existing latent bug this work exposed and fixed: `import.meta.url`-resolved paths break under
`--compile`.** Before this round, `board/render.ts` read levare's own version via `readFileSync(
\`${LEVARE_ROOT}/package.json\`)`, where `LEVARE_ROOT` derives from `sdk-transport.ts`'s
`SDK_WORKER_PATH`, itself `Bun.fileURLToPath(new URL(..., import.meta.url))`. Inside a compiled
binary, `import.meta.url` for bundled code resolves into Bun's virtual `$bunfs` tree
(`file:///$bunfs/root/...`), not the real filesystem — so that read silently threw and the board's
version chip fell back to a hardcoded `"0.0.0"`. Confirmed live: a compiled `dist/levare serve`
printed `v0.0.0` in the header. Fixed by switching `render.ts` to `version.ts`'s
`getVersionInfo().version` (the static-import path, which the bundler inlines correctly either way).
The same `import.meta.url`-resolved-directory pattern was also how `board/serve.ts` located
`assets/styles.css`/`assets/app.js` (`ASSET_DIR = new URL("../../assets/", import.meta.url).pathname`)
— confirmed live: a compiled `dist/levare serve` 404'd both assets. Fixed by importing each asset
directly with `{ type: "file" }` (`stylesCssPath`/`appJsPath`), which Bun embeds in the compiled
binary and transparently resolves through its own `fs` shim (`existsSync`/`readFileSync` both work
unmodified) — verified the fix by compiling a minimal reproduction, then *deleting the source asset
file after compiling* and confirming the binary still served the original content from the embedded
copy. Both `dist/levare serve`'s board HTML and its `/styles.css`/`/app.js` routes now return 200 and
match the source-run shim byte-for-byte.

**Deliberately NOT fixed the same way, and why — two more `import.meta.url` sites remain compiled-binary-
unsafe, out of scope for this step:**
- `replay.ts`'s `STUB_CLI` (`Bun.fileURLToPath(new URL("../fixtures/stubs/member-stub.ts",
  import.meta.url))`) is spawned as a **new subprocess** (`[process.execPath, STUB_CLI, ...]`), not
  read in-process. Confirmed live: `dist/levare replay fixtures/golden --stubs` fails with `unknown
  command: /$bunfs/fixtures/stubs/member-stub.ts` — `$bunfs` paths are only resolvable *within the
  compiled process that embedded them*; a freshly spawned process (even another copy of the same
  binary) cannot see them (verified: `cat`/`ls` against an embedded-file path from outside the
  process that embedded it both fail with ENOENT). `{ type: "file" }` does not help here — it would
  need extracting the embedded script to a real temp file at runtime *and* a real `bun` executable
  on `PATH` to interpret it, a new runtime dependency for a path (`--stubs`) that is explicitly a
  developer/test-only reproduction tool, not something a studio runs in the field. The goal's own
  framing — "git and any vendor CLI (claude/codex) remain RUNTIME prerequisites the binary shells
  out to, exactly as today" — reads as license to leave CLI-member-spawning exactly as it is; this is
  that same shape of spawn, just of a stub instead of a real vendor CLI. **Verified instead via the
  shim**: `./levare replay fixtures/golden --stubs` still matches `fixtures/golden/expected.json`
  byte-for-byte (unchanged; this is the achieved-when's actual ask).
- `sdk-transport.ts`'s `SDK_WORKER_PATH` (spawns the real SDK worker subprocess for the live
  Orchestrator boundary) is the identical spawn-by-resolved-path shape as `STUB_CLI` above, and would
  very likely fail the same way under `--compile` once `ANTHROPIC_API_KEY` is set — not verified live
  in this round (exercising it needs a real credential-bearing SDK call). `orchestrator-
  boundary.ts`'s `ORCHESTRATOR_PROMPT_PATH` is the in-process read shape (like the version chip),
  but deliberately **not** converted to a `{ type: "file" }` embed: `tests/orchestrator-sdk.test.ts`
  has a describe block titled *"docs/orchestrator-prompt.md is loaded from disk, not embedded"* —
  loading it from a real, editable file (not baked into the binary) is an existing, tested,
  deliberate invariant, presumably so the Orchestrator's voice can be tuned without a rebuild;
  embedding it would directly contradict that. Whatever the compiled binary's `docs/` deployment
  story is meant to be (ship `docs/` alongside `dist/levare`? resolve relative to `process.execPath`
  instead of `import.meta.url`?) is a materially bigger question than build-and-version-stamp, and is
  left for a follow-up — the live-Orchestrator boundary under a compiled binary is simply unproven,
  not claimed to work.

  **CORRECTION (NOTES DIST4): this bullet's framing of both sites as "cases that don't run in normal
  compiled use" was wrong for `ORCHESTRATOR_PROMPT_PATH`, and the record needs to say so plainly.**
  `docs/orchestrator-prompt.md` is not a dev-only or test-only path the way `STUB_CLI`'s `--stubs`
  reproduction is — it loads on the very first message a Conductor sends the Orchestrator under any
  `levare serve`, compiled or not. A live host confirmed this directly: a compiled `dist/levare serve`
  ENOENT'd on `/$bunfs/docs/orchestrator-prompt.md` the first time `/orchestrator/message` was called.
  "Deliberately left alone" implied a considered decision that this path was unreachable in ordinary
  compiled use; it was not — it was simply not checked against the compiled-use case at all. The
  "loaded from disk, not embedded" test this bullet cited as a reason not to fix it also turns out not
  to be in tension with the actual fix: `{ type: "file" }` still resolves to the real, editable
  on-disk path in a source run (Bun only rewrites it under `--compile`), so the byte-for-byte-identical
  invariant that test asserts holds unchanged either way — the bullet's own reasoning for leaving this
  alone doesn't survive contact with what `{ type: "file" }` actually does. See NOTES DIST4 below for
  the fix and for what turned out to be genuinely, structurally true of the SDK worker path (not
  merely a deferred verification, as this bullet also wrongly implied by treating both sites as the
  same shape of gap).

**Stale-source honesty (`levare doctor`), and what's deliberately still deferred.** Doctor's run-mode
line answers "is this a build, and if so which commit" — it does NOT compare that commit against the
studio/source tree's own current `HEAD` (a real staleness check: "is this build stale relative to
the code I'm looking at right now"). That fuller check is the goal's own explicitly deferred item;
doing it honestly needs a studio root that IS this repo's own working tree (not just any studio a
compiled binary happens to be pointed at) and a defined notion of "the source commit this run should
be compared against" — left for later, alongside the per-platform release-binary matrix and the CI
that produces it (also explicitly step 2, deferred).

**A container/sandbox-specific `bun build --compile` failure encountered (and routed around) while
verifying this, unrelated to anything in this repo.** In this devcontainer (Docker Desktop's virtiofs
bind mount for `/workspaces/levare` on a macOS host), running `bun build --compile` with the process's
cwd anywhere under that mount fails deterministically: `failed to rename
/run/host_virtiofs/Users/.../levare/.<hash>-00000000.bun-build to <outfile>: ENOENT` — Bun resolves
cwd to a host-side virtiofs path that doesn't exist from inside the container, and its atomic
rename-into-place of the build tempfile fails there, regardless of where `--outfile` itself points
(confirmed: moving only the outfile off the mount does not help; only moving *cwd* off the mount
does). This reproduces with plain `bun build --compile` on an empty one-line entry file — nothing to
do with levare's own code. `scripts/build.sh` works around it unconditionally (compiles from a
`mktemp -d` scratch directory, with absolute entry/outfile paths pointing back into the repo) — inert
and harmless on a normal filesystem (module resolution follows each file's own path, not cwd; verified
identical bundle output either way), so this isn't a compromise specific to this sandbox, just a
safety net that happens to be load-bearing here. Recorded because it cost real time to diagnose and
would otherwise look like "the build script doesn't work."

**Verification.** `bun test` — 704 pass (up from 690: +14 new tests — `tests/version.test.ts` plus
four run-mode cases added to `tests/doctor.test.ts`), 1 pre-existing skip, 0 fail, across 56 files,
2576 `expect()` calls. `bun run build` produces `dist/levare`; smoke-tested: `validate fixtures/golden`
→ `valid` (exit 0), `--version`/`-v` → `levare 0.0.1 (build <commit>)`, `doctor` → `run mode: compiled
(build <commit>)` plus the pre-existing connector report unchanged, `serve` → board HTML and both
static assets all 200 and byte-identical to the source-run shim. `./levare` (unbuilt, source run):
every existing command unchanged; `--version`/`-v` → `levare 0.0.1 (source/dev)`; `doctor` → `run
mode: source/dev` ahead of the unchanged connector report. `levare replay fixtures/golden --stubs`
(via the shim) still matches `fixtures/golden/expected.json` byte-for-byte. `deps:check` → `deps ok`
(`bun build` is invoked only by the dev-time `build` script; no new runtime dependency). `dist/` is
gitignored.

## DIST2. The release pipeline — a GitHub Actions workflow that builds four platform binaries and publishes them

Step 2 of distribution: `.github/workflows/release.yml`, triggered on push of a tag matching `v*`
(`v0.1.0`, `v1.2.3-rc1`, ...) — deliberately distinct from the descriptive waypoint tags (`dist1`,
`f11`, ...) used during development, which the `v*` glob does not match and must never publish a
release. Three jobs, chained: `verify` (`bun test` + `deps:check`) → `build` (the four-platform
matrix, gated on `verify` passing) → `release` (publishes, gated on every matrix leg succeeding). A
build that fails the test suite or ships a forbidden dependency never reaches a published binary.

**Reuses DIST1's build path, does not reinvent it.** `scripts/build.sh` gained two optional
positional arguments — `[outfile] [bun-compile-target]` — so the exact same script now serves both
`bun run build`'s no-arg dev build (`dist/levare`, host platform, unchanged byte-for-byte in
behavior) and the release workflow's four cross-compiled legs (`scripts/build.sh
dist/levare-darwin-arm64 bun-darwin-arm64`, etc.). The `--define __LEVARE_BUILD_COMMIT__` stamp and
the scratch-directory cwd workaround (NOTES DIST1) are untouched, just parameterized. Confirmed
locally: `bun run build` (no args) still produces `dist/levare` for the host platform with the exact
same `--version` output as before this change.

**The platform matrix — four targets, no Windows.** `bun-darwin-arm64`, `bun-darwin-x64`,
`bun-linux-x64`, `bun-linux-arm64`, each producing an identically-named asset
(`levare-<os>-<arch>`). All four cross-compile from a single `ubuntu-latest` runner via `bun build
--compile --target=<t>` — confirmed locally that Bun cross-compiles a `bun-darwin-arm64` binary from
this linux sandbox (downloading that target's runtime on demand), so the matrix does not need
platform-specific runners. Windows is deliberately excluded: levare shells out to `git` and
POSIX-oriented vendor CLIs (`claude`, `codex`) it has never been run against on Windows, and shipping
a Windows binary without ever having tested one would be dishonest — exactly the kind of implied
claim levare's own design tries not to make elsewhere (see doctor's `auth: subscription` warning,
NOTES C13, for the same instinct applied to credential scoping).

**Version stamping for a release build.** DIST1's `version.ts` reads the package version via a
static `package.json` import — correct for a dev build, but a *release* binary must report the TAG's
version, not whatever happens to be sitting in `package.json` (which can legitimately lag a release
tag). The workflow's build job rewrites `package.json`'s `version` field from `GITHUB_REF_NAME`
(stripping the leading `v`) in its own ephemeral checkout, immediately before calling
`scripts/build.sh` — nothing is committed back to the repo or the tag; it only affects what gets
bundled into that job's binary. This was the one place DIST2 could not simply reuse DIST1 unmodified
end to end: DIST1 never needed the version to differ from what was already committed, because it only
ever built from a working tree, not from a tag asserting a specific release version.

**Checksums and publish.** After all four legs upload their binary as a build artifact, the `release`
job downloads them all, flattens them into one directory (`actions/download-artifact`'s multi-artifact
mode nests each under its own subdirectory by name), re-`chmod +x`s them (artifact zipping has a
known history of not reliably preserving the executable bit), generates `SHA256SUMS` covering all
four, and publishes a GitHub Release via `softprops/action-gh-release` with the four binaries and
`SHA256SUMS` as assets, `generate_release_notes: true` for the auto commit-log section, plus an
explicit `body` that is not left to auto-generation: a "Runtime prerequisites — this is NOT
zero-setup" section stating plainly that the binary still needs `git` on `PATH` and a model provider
(`ANTHROPIC_API_KEY` for native members and/or a wrapped vendor CLI for cli members) at runtime, and
a reminder that Windows was not built. Putting this in the explicit `body` (rather than trusting
`generate_release_notes` alone) guarantees the honesty section survives regardless of the auto-notes
feature's own formatting.

**README.** Added a "Distribution" section covering both the existing `bun run build` dev path
(NOTES DIST1) and the new release-download path: platform asset names, the `sha256sum -c
SHA256SUMS --ignore-missing` verify step, chmod+PATH install, and the identical "not zero-setup"
runtime-prerequisites language (`git`, `ANTHROPIC_API_KEY`/a wrapped vendor CLI). Explicitly states an
install script and Homebrew formula are deferred (step 3) rather than implying either exists.
`tests/release-workflow.test.ts` asserts the README and the workflow can't silently drift apart:
every matrix asset name appears in the README, the checksum filename matches, the verify command
matches, and the README makes no premature `brew install`/`curl | sh` claim.

**What was checked locally vs. what genuinely cannot be.** `Bun.YAML.parse` (built into this Bun
version) confirms the workflow file is syntactically valid YAML and — more usefully than a bare
syntax check — `tests/release-workflow.test.ts` parses it and asserts on its actual structure: the
tag trigger is exactly `["v*"]` (and a small glob check confirms `v*` matches semver tags and rejects
`dist1`/`f11`/`ui6`), the matrix is exactly the four named targets with no Windows entry, each build
step invokes `scripts/build.sh` rather than a hand-rolled `bun build` line, `build` depends on
`verify` and `release` depends on `build`, only the `release` job carries `contents: write`, and the
release step's asset list and body text contain what NOTES DIST2 requires. What none of this can
do — and what a YAML/structure check was never going to be able to do — is prove the workflow
actually *runs* correctly on GitHub's own infrastructure: real `oven-sh/setup-bun`/`actions/
upload-artifact`/`actions/download-artifact`/`softprops/action-gh-release` behavior, real
cross-runner artifact permission handling, the real interaction between `generate_release_notes` and
a supplied `body`, and whether GitHub's runners can actually reach whatever Bun downloads for
cross-compilation. **The true test is pushing a real `v*` tag and watching the Actions run — that has
not been done in this pass, and cannot be done from here.** Recorded as the acceptance criterion this
step cannot self-certify, same as NOTES DIST1 recorded its own build-verification workaround as
sandbox-specific and not a substitute for a real cross-platform run.

**Deliberately deferred, per the goal's own step boundary.** An install script (e.g. a `curl | sh`
one-liner) and a Homebrew formula are step 3, not attempted here — the README says so explicitly
rather than silently omitting them. Signing/notarizing the macOS binaries (an unsigned binary
downloaded from the internet will hit Gatekeeper friction on a Mac) was not asked for and is not
attempted; worth flagging for whoever picks up step 3, since it directly affects whether "download
and run" actually works painlessly on macOS even once the binary exists.

**Verification.** `bun test` — 721 pass (up from 704: +17 new tests, `tests/release-workflow.test.ts`),
1 pre-existing skip, 0 fail, across 57 files. `bun run build` (no args, unchanged dev path) still
produces a working `dist/levare`; `./levare` shim regressions unchanged; `levare replay
fixtures/golden --stubs` (via the shim) still matches the oracle byte-for-byte; `deps:check` → `deps
ok`. The workflow YAML parses via `Bun.YAML.parse` and structurally matches every requirement above.

## DIST3. `scripts/build.sh` crashed on macOS's system bash — a fixture-vs-reality gap one level down, in the build script itself

The first command a macOS contributor runs, `bun run build` (no args), aborted with `line 35:
target_args[@]: unbound variable`. Root cause: macOS ships bash 3.2 (Apple has never shipped a
GPLv3-licensed bash newer than that), and bash 3.2 throws "unbound variable" under `set -u` when
`"${arr[@]}"` expands an *empty* array — a bug fixed upstream in bash 4.4. `scripts/build.sh`'s dev
build leaves `target_args` empty (no cross-compile target), so every dev build on a stock Mac hit
this. The script was correct on the bash used by CI and the devcontainer (both far newer than 3.2),
so every existing check passed while the actual entry point contributors use was broken.

**The fix.** `"${target_args[@]}"` → `${target_args[@]+"${target_args[@]}"}`, the standard portable
guard: it expands to nothing when the array is unset/empty and to the quoted elements when set,
correct on bash 3.2 through the newest bash and on zsh. Both call shapes verified locally:
`bun run build` (empty array, dev build) and `scripts/build.sh dist/levare-test bun-linux-x64`
(populated array, the shape release.yml's matrix uses) both compile successfully; the resulting
`dist/levare` still passes `levare replay fixtures/golden --stubs` byte-for-byte against the oracle.

**Why this passed every existing check: the same lesson as F-series fixture-vs-reality bugs, one
level down.** Earlier NOTES entries in this series describe *levare's own* fixtures diverging from
real member/vendor behavior. This is the identical shape applied to the tooling that builds levare:
release.yml's four-platform matrix cross-compiles `bun-darwin-arm64`/`bun-darwin-x64` from a single
`ubuntu-latest` runner (NOTES DIST2 — deliberate, since Bun can cross-compile without a Mac runner at
all). That means `scripts/build.sh` has *targeted* macOS from day one but never *executed* on macOS
in CI — cross-compilation exercises the output binary's target triple, not the shell interpreting the
build script that produces it. A script that must run on a platform has to be run there to be tested
there; being merely a compile target for that platform proves nothing about the script's own
compatibility with it. Heuristic worth keeping: for any script gated on "works on platform X", ask
whether CI actually *executes* it on X, or only asks a cross-compiler to *target* X — those are not
the same coverage.

**Closing the gap: `.github/workflows/ci.yml`, a new workflow distinct from `release.yml`.**
`release.yml` triggers only on `v*` tags (NOTES DIST2, deliberately) and its `verify` job runs on
`ubuntu-latest`, so it was never going to catch this either way. The new `ci.yml` runs on every
push/PR to `main`: an `ubuntu-latest` leg (`bun test` + `deps:check`, the same gate `release.yml`'s
`verify` job runs) plus a `macos-latest` leg that runs `bun run build` for real — not to produce or
upload a release artifact, just to prove the dev build command executes on the OS most contributors
actually use. Kept as a separate workflow file rather than folded into `release.yml` so the tag-only
trigger there (and `tests/release-workflow.test.ts`'s assertions on it) stay untouched.

**What was checked locally vs. what genuinely cannot be.** `Bun.YAML.parse` confirms `ci.yml` is
syntactically valid YAML with the expected `push`/`pull_request` triggers on `main`, an
`ubuntu-latest` test job, and a `macos-latest` job that runs `bun run build`. It cannot prove the
workflow *runs* correctly on GitHub's actual macOS runners — same caveat NOTES DIST2 recorded for
`release.yml` itself: the true test is a real push/PR against `main` on GitHub's infrastructure,
which has not happened from here and cannot happen from here.

**Verification.** `bun test` — 721 pass, 1 pre-existing skip, 0 fail, across 57 files (unchanged
count; no new test file was added for `ci.yml`, since `tests/release-workflow.test.ts`'s existing
structural-assertion pattern is scoped to `release.yml` specifically and this workflow has no README
claims to drift against). `bun run build` (no args) and `scripts/build.sh dist/levare-test
bun-linux-x64` (with target) both succeed; `deps:check` → `deps ok`; `levare replay fixtures/golden
--stubs` (via the `./levare` shim, compiled binary) matches the oracle byte-for-byte.

## Registry editor card pointed a directory-form skill at a file that doesn't exist — two computations of "where does this entity live" disagreeing

A skill (and, it turns out, knowledge/evals — see below) exists in one of two on-disk shapes: a flat
`<name>.md` file, or the Agent Skills folder convention — a directory carrying its own `SKILL.md` plus
optional supporting files (`skills/new-project/`, scaffolded by `levare init`, NOTES H5). `board/extra.ts`'s
loader already discovered each entity's real backing file correctly (an explicit `existsSync(.../SKILL.md)`
check, never a "first .md by readdir order" guess). But `board/render.ts`'s `entityBlock` — the function
every registry card goes through — RECOMPUTED the editable path itself, as `${kind}/${name}.md`, discarding
what the loader had already found. For a directory-form skill that reconstructed path
(`skills/new-project.md`) never exists: the card's hidden `<textarea class="rawmd-source">` (read via a
second, identically name-based reconstruction in the old `rawFor` helper) came up empty, `data-path`
pointed the overlay editor's load/live-check/save requests at the nonexistent file, and the editor reported
the buffer invalid. A save would have silently created a stray `skills/new-project.md` beside the real
directory rather than updating `SKILL.md`.

**The fix: make the loader's discovered path the only source of truth, end to end.** `Entity` (`board/
extra.ts`) gained a `file` field — the exact root-relative path the entity was parsed from
(`skills/spec-writing.md` or `skills/new-project/SKILL.md`) — computed once, in the same branch that
already decides flat-vs-bundled, so there is no second place that could compute it differently.
`entityBlock` (`board/render.ts`) no longer reconstructs `relPath` internally; every one of its seven call
sites (teams/agents/skills/knowledge/types/connectors/evals) now passes an explicit `relPath` — for
skills/knowledge/evals, that's the entity's own `.file`; for teams/agents/types/connectors (which only ever
load through `repo.ts#loadEntities`, flat-file-only, no directory-form branch exists there at all) it's
still `${kind}/${name}.md`, unchanged and still exact because those four kinds structurally cannot drift.
`rawFor` (raw content for the textarea) is now a thin wrapper over a new `rawForPath(root, relPath)`, which
reads from the SAME path embedded as `data-path` — no second reconstruction anywhere. The write routes
(`POST /registry/*path`, `POST /registry/check/*path`) needed no change at all: they already just join
whatever `data-path` the card sent with `root` and operate on that file directly (confirmed by reading
`serve.ts`), and `isRegistryEditablePath` already accepts a nested `skills/<name>/SKILL.md` path (any depth
≥2 ending in `.md` under an allowlisted top-level dir) — the guard was never the bug, only the card's input
to it was wrong.

**Audit of the other extras (goal item 3).** `knowledge`, `evals`, and `skills` all load through the exact
same shared `loadDir` in `extra.ts`, so all three admit the directory-form layout equally, and all three
got the same fix (their `entityBlock` call sites now pass `k.file`/`e.file`). `ideas` also loads through
`loadDir` (so it, too, could technically appear in directory form) but ideas are **never rendered through
`entityBlock`/`rawFor` at all** — `renderIdea` reads an idea's body directly from the already-loaded
`Entity` and has no raw-markdown editor, no `data-path`, no save route. There was no `rawFor`-by-name
reconstruction to fix for ideas because there is no edit-source surface for ideas in the first place; noted
here so that absence reads as deliberate, not overlooked.

**The order-dependence fix (goal item 4) turned out to live in `extra.ts`, not `repo.ts`.** The goal
described this as "repo.ts's directory resolution... takes the first `.md` by readdir order when resolving
a skill directory" — but `repo.ts` has no skill-directory-resolution code at all (skills/knowledge/evals/
ideas are loaded exclusively by `board/extra.ts`, deliberately kept separate from `repo.ts`'s own
`loadEntities`, per that file's header comment). The actual "pick the first `.md` by readdir order" pattern
that exists in this codebase today is `repo.ts#loadUnitArtifacts`'s folder-ARTIFACT index resolution
(`readdirSync(full).filter(n => n.endsWith(".md"))[0]`, also mirrored in `context.ts` and `board/
locate.ts`) — a different subsystem (work-unit artifacts, not registry skills) that this goal's acceptance
criteria don't actually exercise (`bun test`, before and after, shows no test pinning that path's behavior
against a multi-`.md` folder). Rather than "fix" an unrelated subsystem no test in this goal touches, I
implemented the acceptance-criteria requirement literally where it actually applies: `extra.ts#loadDir`'s
directory branch never picked a first-by-readdir-order file to begin with (it already required an exact
`existsSync(SKILL.md)` match) — what it silently lacked was a loud failure when a directory plainly *was*
attempting a skill bundle (it has `.md` files of its own) but named its entry point something other than
`SKILL.md`. That case now throws a new `RegistryEntityError` naming the offending directory, instead of
silently `continue`-ing past it (which would have made the entity invisible in the registry with no
diagnostic at all — arguably worse than an arbitrary pick, and definitely not "resolve to SKILL.md
explicitly, name the error"). A directory with no markdown files at all (not an attempted bundle — e.g. a
stray assets-only folder someone dropped under `skills/`) is still silently skipped, not an error, since
nothing there was ever trying to be an entity. If a future change genuinely wants the artifact-folder
pattern in `repo.ts`/`context.ts`/`board/locate.ts` hardened the same way, that's a separate, unscoped fix —
flagged here rather than folded in unannounced.

**Fixtures.** `fixtures/golden/skills/` stays all-flat, deliberately: it's read by ~38 existing tests, at
least one of which (`tests/board-render.test.ts`'s card-count assertion, "teams(1) + agents(4) + skills(3)
+ ...") hardcodes golden's exact per-kind entity counts. Adding a fourth skill there would be scope creep
against files those tests own. Instead, the directory-form-skill coverage this goal requires is a scratch
copy seeded from golden (the same `cpSync("fixtures/golden", root)` + git-init pattern every other
board-serve test already uses) with one additional `skills/test-bundle/SKILL.md` written in per-test setup
— exercising the exact same code paths (`loadExtras` → `entityBlock` → the real HTTP save/check routes)
without perturbing golden's own pinned shape. `tests/extra.test.ts` (new) unit-tests `loadDir`/`loadExtras`
directly against disposable temp directories: flat resolution, directory-form resolution, both coexisting
with distinct `.file` values, the named-error case, the harmless-skip case, and knowledge/evals sharing the
same behavior. `tests/board-serve.test.ts` gained: a flat-skill round-trip (pinning "unchanged from
before"), and a new describe block round-tripping the directory-form fixture through the real routes — GET
`/registry/skills` embeds `data-path="skills/test-bundle/SKILL.md"` (never the flat form) and shows the
real body content (not empty); `POST /registry/check/skills/test-bundle/SKILL.md` validates ok; `POST
/registry/skills/test-bundle/SKILL.md` writes back to `SKILL.md` in place, creates no stray
`skills/test-bundle.md`, and leaves the bundle's other supporting file untouched.

**Verification.** `bun test` — 731 pass (10 new), 1 pre-existing skip, 0 fail, across 58 files. `levare
validate fixtures/golden` → valid (unaffected — golden itself wasn't touched). `levare replay
fixtures/golden --stubs` matches `expected.json` byte-for-byte (unaffected — the oracle covers
`work/checkout-flow`, which nothing here touches). `deps:check` → `deps ok`.

# NOTES UI7 — the registry card sweep: teams/agents/skills/knowledge push from describing toward showing

Refinement pass over the four registry card kinds that carried the most description-not-shown and
redundant-kind/parent text, per `docs/levare-design-brief.md`'s identity system (colour means team-or-
status, never anything else) and two rules stated in the goal: RULE A (a card on its own entity's page
doesn't repeat its kind or parent — the kind is the URL it lives on) and RULE B (colour means status only;
a team's own declared hue is the one identity exception, expressed via shape/border/avatar tint, never a
second invented colour channel).

## Mechanism: `entityBlock` gained two opt-in knobs, not a fork

Every registry card still goes through the one `entityBlock` function (`board/render.ts`). It gained an
`opts` param with two independent knobs rather than a parallel code path: `showKindTag` (default `true`)
lets a call site drop the top-right `.entity__kind` tag entirely — team/agent/skill now pass
`showKindTag: false`; knowledge/type/connector/eval are untouched by this goal and keep it. `accentColor`
(teams only) adds an inline `border-left:2px solid <hex>` to the card's own `<article>` — reusing the exact
2px accent-border treatment `.release--latest` already established elsewhere on the board, not a new
dimension. `data-editor-kind` (the shared overlay's heading) still always gets the real kind label
regardless of `showKindTag` — the overlay is one shared modal across every entity kind and still needs to
say what it's editing even when the card itself no longer prints that word.

`avatar()` (the existing per-member/per-team-slot primitive) gained one more optional field, `title`,
emitting a plain HTML `title="..."` attribute — the native browser tooltip the goal asked for ("member's
name on hover"), no new JS, no new component.

`tag()` (components.ts's existing tag/chip primitive) is reused verbatim for every new chip on these cards
(team produces, agent produces, knowledge tags) — called with its own `.tag` CSS class (already styled,
already used by `.pcard__tags`) instead of its default `.entity__kind` class, since a produces/tags chip is
a different visual role than a kind label. No new primitive, no fork of `tag()`.

One genuinely new piece: `agentKindBadge()`, a small local helper in `render.ts` (same pattern as the
existing local `avatar()`/`memberAvatar()` helpers — not promoted to components.ts since it's specific to
one card). It renders an agent's `native`/`cli`/`remote` kind as `.kindbadge.kindbadge--<kind>`, three CSS
variants that differ only in border/fill TREATMENT (filled ink, outlined, dashed-outlined) — every declared
colour in all three rules comes from the neutral ink scale (`--fg`/`--fg-dim`/`--fg-mute`/`--border-strong`)
only; none of the four status-palette hues (`--active`/`--ok`/`--gate`/`--danger`) appears anywhere in
`.kindbadge*`, which is what RULE B actually requires (a new test pins this by parsing every `.kindbadge*`
rule out of `assets/styles.css` and asserting none of the four forbidden `var(--...)` tokens appears in any
of them, rather than eyeballing the two colours chosen today).

## Per-card changes

**Teams.** The old "Definition" section's `color` row (`<span class="v mono" style="color:...">#2E6FB0</span>`)
printed the hex as text — the literal "value printed on it" RULE B forbids for the identity exception. It's
gone, replaced by the card's own `border-left` (see above); the small colour-square glyph that used to sit
in the title ahead of the team name is gone too, for the same reason — one colour-as-identity signal (the
border), not two. `members` no longer renders `${count} · name, name, name` — it's a `.chiprow` of avatars,
each with `title="<name>"` for the hover name. `produces` is a `.chiprow` of `tag()` chips instead of a
comma-joined mono string. The "Declared flow" strip already showed an avatar per step; it dropped the
`<span class="mn">name</span>` beside each one (the avatar's own `title` now carries the name on hover) —
shape+colour+hover carry the identity, no name text printed per step. `showKindTag: false` drops the "team"
tag (RULE A).

**Agents.** `showKindTag: false` drops the "agent" tag (RULE A). The "wears &lt;team&gt;" row is gone
outright (RULE A) — the header avatar was already tinted with the team's colour (unchanged), so the team
was already shown, never needed to also be told. `kind` and `model` collapsed from two separate `.prow`
rows into one: `agentKindBadge(a.kind)` followed inline by `· <model>` in the same `<span class="v">`
(when a model is declared; `cli`/`remote` members like `finch`/`rook` have none, so the badge stands alone,
exactly as before). `produces` — previously not rendered on the agent card at all — is now a `.chiprow` of
`tag()` chips, per the goal's explicit ask.

**Skills.** `showKindTag: false` drops the "skill" tag (RULE A). The `<div class="card__h">SKILL.md</div>`
heading is gone — it named the on-disk implementation file, not information about the skill; the
description paragraph is now the entire card body.

**Knowledge.** Kept its kind tag (the goal's KNOWLEDGE section and the "Achieved when" checklist both stop
short of asking for its removal here, unlike teams/agents/skills — RULE A's rationale still nominally
applies, but this goal scopes the four kinds independently and knowledge's own list of asks doesn't include
it, so it's left as UI6 did). The "Injected into" backlink section (a reverse-reference scan over every
agent/team) is gone. In its place: the knowledge entity's own declared `tags` frontmatter field (already
present on both golden fixtures, `house-style`/`model-pricing`, as `tags: [voice, reference]` /
`tags: [cost, reference]`) renders as a `.chiprow` of `tag()` chips. An item with no `tags` frontmatter
falls back to the same "none declared"-style neutral hint text the agent card already uses for an empty
context recipe, rather than a blank body.

## Test updates

Two pre-existing UI4-era tests asserted "every registry entity carries a bare-type kind tag, no exceptions"
— true when written, now superseded by this goal's RULE A asks for three of the seven kinds. Both were
rewritten rather than deleted: the blanket "every `.entity__kind` tag is a bare type word" assertion now
scopes to the four kinds that still carry one (`knowledge`/`type`/`connector`/`eval`); the ordering check
("title before kind badge, for every entity") now skips cards with no kind badge at all instead of failing
on the (now expected) absence. A new `describe` block per card kind pins the goal's own "Achieved when"
list directly: team card → coloured border (regex on the literal `border-left:2px solid <hex>` inline
style) + avatar-chiprow members (not a hex value, not a plain name list) + chip-row produces + no "team"
tag + avatar-only flow steps; agent card → no "agent" tag, no "wears" row, a `.kindbadge` present with none
of its CSS rules touching a status-palette colour var, kind+model in one `.prow` row (asserted by counting
total `.prow` rows on the card, not just checking the pair render adjacently), produces as chips; skill
card → no "skill" tag, no literal `SKILL.md` text anywhere in the rendered body; knowledge card → no
"Injected into" text in the rendered body, tag chips present and matching the fixture's actual declared
tags. Two of those new tests initially false-failed against the *raw markdown source* embedded verbatim in
each card's hidden `<textarea class="rawmd-source">` (the fixture's own prose legitimately still says
"wren, lyra, finch produced this" / "Injected into member context when referenced" — that's the file's
body text, not the rendered card) — fixed by stripping the textarea out of the fragment before asserting,
the same "raw source is not the same surface as the rendered view" distinction UI3's tests already draw
elsewhere in this file.

## Verification

`bun test` — 744 pass (13 new), 1 pre-existing skip, 0 fail, across 58 files (was 731/0/58 before this
goal). `bun run deps:check` → `deps ok`. `levare replay fixtures/golden --stubs` matches
`fixtures/golden/expected.json` byte-for-byte (unaffected — this goal touches only board rendering, never
the runner or its fixtures). `bun build src/cli.ts` compiles clean (no tsconfig.json in this repo, so this
is the project's own type/syntax smoke test in the absence of a separate `tsc --noEmit` script). Manually
verified against a live `levare serve fixtures/golden` — fetched `/registry/{teams,agents,skills,knowledge}`
and inspected the `kestrel`/`lyra`/`finch`/`flow-design`/`house-style` cards' actual rendered markup
directly (no browser available in this environment for a pixel screenshot): team card shows
`border-left:2px solid #2E6FB0` and avatar chips with `title` attributes, no hex text; `lyra` shows
`kindbadge--native` next to `· claude-sonnet-5` in one row and `design`/`spec` as chips; `finch` (a `cli`
member, no model) shows `kindbadge--cli` alone, confirming the adjacent-model rendering is conditional and
doesn't leave a stray separator when no model is declared; `flow-design` shows only its description
paragraph; `house-style` shows `voice`/`reference` as chips and no backlink section.

# NOTES UI8 — the Orchestrator panel reads as a conversation, not a labelled log

Presentation-only redesign of the Orchestrator panel's message history (docs/levare-design-brief.md):
every message used to carry a "RESPONSE now" / "BRIEFING now" header, the Conductor's and the
Orchestrator's own messages were visually identical, and there was no turn-taking signal — it read as a
transcript with repeated chrome, not a chat. Message content, the composer, and the request/response
flow are all unchanged; conversation persistence across navigation stays explicitly out of scope (a
separate future goal).

**The header is gone.** `src/board/components.ts` gains `orchMark()`/`orchTurn()` — the ONE place the
Orchestrator conversation's turn markup is built (same "shared component vocabulary, built once" pattern
UI6 established): `orchMark()` renders the same podium glyph the app header/panel head already draw
(`.turn__mark`, styled identically to `.orch__mark`); `orchTurn(bodyHtml, { caption })` wraps one or more
message bodies in `<div class="turn turn--orch">`, left-aligned by default (no `justify-content`
override), with `caption` rendering a quiet `.turn__caption` line beneath the WHOLE turn. All three
screens' `briefingBody` (`render.ts#renderStudio/renderProject/renderRun`) and the disabled-panel's
unavailability notice now build through `orchTurn()` instead of hand-rolled `<div class="msg">...
<div class="msg__label">...` markup. Only the three real briefings pass `{ caption: "briefing · now" }`
— the opening message is a genuinely distinct one worth marking (item 2); the disabled-panel notice does
NOT get the caption (it's an availability notice, not a briefing, even though it's still rendered as the
Orchestrator speaking — mark, left-aligned).

**Conductor messages** never come from the server (every one is composer-submitted) — they render
client-side as `<div class="turn turn--user">`, right-aligned via `justify-content:flex-end` on the turn
plus a `.msg__body` styled with `background:var(--bg-accent); color:var(--text-accent)` — two NEW
derived CSS variables (`assets/styles.css` `:root`), both expressed purely as `color-mix()`/`var()` over
the EXISTING `--accent`/`--panel` tokens (no new colour literal, per the design brief's "no new colours"
constraint) — so both light and dark values fall out of the existing per-theme `--accent`/`--panel`
overrides with no separate dark-mode redeclaration needed.

**Turn-merging (item 4)** is inherently a client concern (message history isn't persisted — out of
scope — so there's no server-side "list of prior messages" to merge across; each page load server-
renders exactly one opening turn). `assets/app.js` gains `appendTurnMessage(body, speaker, buildBodyEl)`:
if `.orch__body`'s last child is already a turn of the same speaker, the new message's element (always
built via `textContent`, never string-concatenated HTML — the same "untrusted text is never parsed as
markup" discipline the old code already had) is appended into that turn's existing `.turn__content`
(mark shown once, no new spacing/turn wrapper); otherwise a fresh turn is created. Both the summon-gate
narration handler and the composer's reply/error handlers now go through this one function, so a
narration that lands right after another Orchestrator message (or the opening briefing, if summoned
before any Conductor message) merges instead of repeating the mark.

**The in-flight state (item 5)** is local and inline: the composer's submit handler now creates a
pending turn via `appendTurnMessage(body, 'orch', ...)` immediately after appending the Conductor's own
turn (so it always lands as a fresh turn, never merged into the user's) with `.msg__body.msg--pending`
(mark + blinking dots + "thinking…" text) and a `turn--pending` marker class; the panel (`.orch`) itself
never gains a loading class, and nothing but this one inline element changes while a real SDK call is in
flight. On resolution the pending turn is `.remove()`d and the real reply/error is appended through the
same `appendTurnMessage` path — reusing the exact dots primitive already built for the gate composer's
own dispatching state (`components.ts#pendingState`), per the "feedback is local" principle from UI6.

**CSS**: the old `.msg`, `.msg__label` (`.k`/`.t` spans), and `.msg--user` rules are gone outright,
replaced by `.turn`/`.turn__mark`/`.turn__content`/`.turn__caption`/`.turn--user`. The pending-dots
animation rule (`.msg--pending .msg__dots` and its `nth-child` delays) is generalised to `.msg__dots`
directly — dropping the `.msg--pending` ancestor requirement was safe to verify: `.msg__dots` never
appears anywhere it wouldn't also want the blink (the gate's own `pendingState()` output still nests it
under `.msg--pending`, unaffected; the Orchestrator's new inline "thinking…" paragraph now reuses the
same rule directly). `styles.css?v=9` → `v=10`, `app.js?v=7` → `v=8` (cache-busting, existing convention).

## Test coverage

New `tests/board-orchestrator-conversation.test.ts` (14 tests), two halves:
- Server-rendered string assertions (all three screens, on/off): the opening turn is `turn turn--orch`
  with a `turn__mark`, no `msg__label`/"RESPONSE"/"BRIEFING" text anywhere; exactly one `turn__caption`
  reading "briefing · now"; the disabled panel gets the mark but no caption; the composer's enabled/
  disabled markup is asserted byte-identical to its pre-goal form (item 6 — composer unchanged).
- A vm-based fake-DOM harness (same no-DOM-dependency approach as `tests/board-pending-state.test.ts`,
  extended with `lastElementChild`/`createTextNode`/`documentElement`) loading the real `assets/app.js`
  verbatim: two consecutive summoned narrations merge into one `turn--orch` with exactly one
  `turn__mark` and two `msg__body` paragraphs; a composer submission renders `turn--user` right-aligned
  with the typed text and no mark; immediately after submitting, a `turn--pending` Orchestrator turn
  (mark + dots + "thinking…") is the last child of `.orch__body` while the panel's own class is
  untouched and the input is disabled; once a mocked `fetch` resolves, the pending turn is gone and the
  real reply (or, in a second scenario, an error) lands as a fresh Orchestrator turn.

## Verification

`bun test` — 758 pass (14 new, all in the new suite), 1 pre-existing skip, 0 fail, across 59 files (was
744 pass/1 skip/58 files before this goal). `bun run deps:check` → `deps ok`.
`bun run src/cli.ts replay fixtures/golden --stubs` matches `fixtures/golden/expected.json` byte-for-byte
(unaffected — this goal touches only the Orchestrator panel's client/server rendering, never the
runner). `bun build src/cli.ts` compiles clean. Manually verified against a live
`levare serve fixtures/golden` (no ANTHROPIC_API_KEY in this environment, so the disabled-panel path):
fetched `/project/storefront` and confirmed the rendered panel shows the mark, left-aligned, with no
"briefing"/"RESPONSE" label text and no caption (the disabled notice correctly withholds it); fetched
`/styles.css` and `/app.js` and confirmed the new `--bg-accent`/`--text-accent` variables, `.turn*`
rules, and `appendTurnMessage`/`turn--pending` code are all served correctly.

## Uncertainty recorded

The goal's "consecutive same-speaker messages merge" ask is proven for the Orchestrator side (summon
narrations landing back-to-back) since that's the one path where it's reachable today: the composer
disables its input for the duration of a request, so two Conductor messages can never be submitted
back-to-back through the real UI — `appendTurnMessage`'s merge logic is speaker-symmetric (it would
merge consecutive `turn--user` calls exactly the same way), but there's no live code path that exercises
that specific case today, only the shared primitive. Left as-is rather than special-cased, since the
composer's disable-while-pending behaviour is explicitly out of scope to change (item 6/composer
unchanged), and a generic primitive that's symmetric by construction is preferable to one hand-tuned to
today's only reachable case.

## DIST4. Two compiled-binary defects found running the real thing, not assumed from reading the code

Both defects here were found by actually running `dist/levare` and the rendered board, not by static
review — the goal's own instruction ("verify against the real thing") is the throughline for both.

### 1. `docs/orchestrator-prompt.md` ENOENT'd under `--compile` — DIST1's own "deliberately left alone" call was wrong

**Reproduced live first.** Built `dist/levare` at this branch's starting commit, ran `dist/levare serve
<studio> --port N` with a real-shaped (fake) `ANTHROPIC_API_KEY`, and POSTed to `/orchestrator/message`:
`{"ok":false,"error":"ENOENT: no such file or directory, open '/$bunfs/docs/orchestrator-prompt.md'"}`.
Exactly the failure the goal described, and exactly DIST1's own predicted mechanism
(`import.meta.url` inside a `--compile`d binary resolves into Bun's virtual `$bunfs` tree, not the real
filesystem) — DIST1 just never ran this path to see it happen, and its own text said so ("not verified
live in this round").

**The fix — the same one DIST1 already used for the version chip and the board's assets.**
`orchestrator-boundary.ts#ORCHESTRATOR_PROMPT_PATH` now comes from `import orchestratorPromptPath from
"../docs/orchestrator-prompt.md" with { type: "file" }`, replacing `new URL(...,
import.meta.url).pathname`. This is not a new technique in this repo — `board/serve.ts` already does
the identical thing for `assets/styles.css`/`assets/app.js` (NOTES DIST1) — it just hadn't been applied
here. DIST1's own stated reason for NOT doing this was that `tests/orchestrator-sdk.test.ts`'s
*"docs/orchestrator-prompt.md is loaded from disk, not embedded"* describe block requires the prompt
stay a real, editable file, not something baked into the binary. That reasoning doesn't actually block
this fix: `{ type: "file" }` resolves to the REAL on-disk path unchanged in a source run (Bun only
rewrites the import under `--compile`), so `loadOrchestratorPromptSource()` still reads the live,
editable `docs/orchestrator-prompt.md` byte-for-byte in every source/dev run — that existing test
passes unmodified. Only a compiled binary now gets the embedded copy, which is exactly the behavior
DIST1 already established as correct and desired for the CSS/JS assets.

**Proven against the actual compiled binary, three ways, not just the source shim:**
1. `levare doctor` gained a new, independent line — `orchestrator prompt: readable (N bytes) at <path>`
   (or `ERROR — <message>`) — computed by calling the exact same `loadOrchestratorPromptSource(
   ORCHESTRATOR_PROMPT_PATH)` the real boundary uses, wired in ahead of the connector report
   (`doctor.ts`'s new `PromptCheck`, threaded from `cli.ts#runDoctorCmd`). Rebuilding `dist/levare` and
   running `dist/levare doctor <studio>` prints `orchestrator prompt: readable (4251 bytes) at
   /$bunfs/root/orchestrator-prompt-*.md` — the same byte count (4251) `wc -c docs/orchestrator-prompt.md`
   reports, and no `ENOENT`. This line is deliberately independent of the `orchestrator: on/off` line
   above it (see point 2 below) — it proves the prompt READ specifically, regardless of whether the SDK
   worker can otherwise run.
2. `tests/orchestrator-compiled-smoke.test.ts` (new, always runs, not skipped) actually builds a scratch
   binary via `scripts/build.sh` inside `bun test` itself and asserts on its real `doctor` output and a
   real `serve` HTTP response — the automated equivalent of the manual check above, so this stays proven
   on every `bun test` run, not just this one session.
3. Re-ran the original repro from the top of this section against the rebuilt binary: the prompt-read
   error is gone; the failure moved one step further down the call chain, to the SDK worker spawn (§2).

### 2. The SDK worker path — genuinely cannot be fixed the same way, and now says so instead of assuming it away

**Re-examined instead of left as a guess.** DIST1's bullet predicted the SDK worker spawn would
"very likely fail the same way" under `--compile` but never checked. It fails, but not "the same way":

`sdk-transport.ts#createAsyncSdkTransport` spawns the worker as `Bun.spawn([process.execPath,
SDK_WORKER_PATH])`. In a source run, `process.execPath` is the `bun` binary — a generic script
interpreter — so this runs `sdk-worker.ts` as a fresh subprocess correctly. Under `--compile`,
`process.execPath` IS the compiled `dist/levare` executable itself, which is not a generic
interpreter — it only knows how to run its own embedded entrypoint. Confirmed directly: running
`dist/levare /workspaces/levare/src/sdk-worker.ts` (a real, valid path, no `$bunfs` involved at all)
prints `unknown command: /workspaces/levare/src/sdk-worker.ts` and levare's own usage text — the
compiled binary re-enters its OWN CLI argument parser, which has no idea what to do with a script
path. This is a structurally different, and strictly worse, problem than `ORCHESTRATOR_PROMPT_PATH`'s
bug: fixing `SDK_WORKER_PATH`'s own path resolution (e.g. with `{ type: "file" }`, so `existsSync`
and the path itself are both correct) would not help, because there is no interpreter left to hand
that path to. The only way to make this spawn work under `--compile` would be locating and spawning a
REAL, separate `bun` binary from `PATH` — the exact new runtime dependency DIST1 already declined to
introduce for `replay --stubs`'s `STUB_CLI`, for the same reason: this repo's compiled-binary story is
explicitly "git and any vendor CLI remain runtime prerequisites, nothing else," and `bun` itself is
not currently one of them. Restructuring the SDK call to avoid a subprocess entirely (e.g. a Worker
thread in-process) would sidestep this, but is a materially bigger architectural change than a
bug-fix pass should attempt — NOTES phase-7 K9 chose the subprocess shape deliberately, for the
non-blocking/isolation properties a Worker thread would need to independently re-prove — and is left
for a follow-up, not silently assumed to be equivalent effort to the prompt fix above.

**Made the compiled-binary case explicit instead of leaving it to fail per-request.** Both
`resolveOrchestratorStatus` (`orchestrator-status.ts`) and `selectOrchestratorBoundary`
(`orchestrator-boundary.ts`) now take an optional `compiled` parameter, defaulting to the real
`isCompiledBuild()` (`version.ts`, DIST1) — under a compiled binary, both report "unavailable"/return
`null` outright, regardless of what the credential/native-binary precondition says, since that
precondition genuinely cannot predict this failure. This matters beyond just avoiding an ugly error:
`orchestrator-status.ts`'s own header comment states its whole job is that "the badge says on" and
"the route actually answers" can never disagree across the board's indicator, `levare doctor`, and the
real `/orchestrator/message` route — that invariant would otherwise now be silently false for every
compiled binary with a real key. `board/render.ts`'s disabled-panel copy was also switched from a
hardcoded "no ANTHROPIC_API_KEY" string to `status.reason`, so the panel states the REAL reason
(missing key vs. compiled-binary limitation) instead of a generic guess that's wrong in the new case.

### Test coverage

`tests/orchestrator-sdk.test.ts` — new describe block: `selectOrchestratorBoundary` returns `null`
under `compiled=true` even with a present key and a resolvable native binary; unaffected under
`compiled=false`. `tests/orchestrator-status.test.ts` (new file) — `resolveOrchestratorStatus` reports
the compiled-binary reason under `compiled=true` regardless of key presence; falls through to the
ordinary precondition under `compiled=false`. `tests/doctor.test.ts` — new describe block for
`PromptCheck`: readable/error line formatting, absent-param backward compatibility, and a real
`./levare doctor` run asserting the reported byte count matches `docs/orchestrator-prompt.md`'s actual
on-disk size. `tests/orchestrator-compiled-smoke.test.ts` (new file, not skipped) — builds one real
scratch binary and exercises it directly: `doctor` reports the prompt readable with the correct byte
count and no `ENOENT`/`$bunfs` text; a real `serve` process answers `/orchestrator/message` with
`disabled:true` and no `ENOENT`/`$bunfs` text in the body.

### Verification

`bun test` — 769 pass (11 new: 2 in orchestrator-sdk.test.ts, 3 in orchestrator-status.test.ts, 4 in
doctor.test.ts, 2 in orchestrator-compiled-smoke.test.ts), 1 pre-existing skip, 0 fail, across 61 files
(was 758 pass/1 skip/59 files before this goal — NOTES UI8). `bun run deps:check` → `deps ok`.
`bun run build` then `dist/levare doctor <studio>` shows the prompt reading correctly and states the
SDK-worker limitation plainly instead of guessing. `./levare replay fixtures/golden --stubs` (via the
shim) still matches `fixtures/golden/expected.json` byte-for-byte, unaffected — this fix touches only
the Orchestrator boundary's path resolution and status reporting, never the runner.

## UI9. The user-message bubble read as an error — the accent role is vermilion, not a neutral

UI8 gave the Conductor's own message bubble (`.turn--user .msg__body`) the accent role
(`--bg-accent`/`--text-accent`, both `color-mix`-derived from `--accent`). The chosen accent direction
in this codebase, per `docs/levare-design-brief.md`, is **Podium — opera-house vermilion, around
`#C2402A`** — a warm red/coral, the same hue family as `--danger` (`#A81F1A` light / `#EC6A62` dark,
also warm red). Styling the Conductor's OWN message in that hue makes a normal chat bubble read as an
alert, exactly the failure mode the design brief's canonical state palette exists to prevent ("Gates
must never become red: red means error"). It also quietly broke the brief's own accent-scarcity rule —
"the accent appears sparingly in-product (only as the Orchestrator's voice; color otherwise belongs to
teams)" — the accent is supposed to BE the Orchestrator's identity marker specifically, not something
the Conductor's own words wear too.

**The fix — swap the ingredient, keep the recipe.** `--bg-accent`/`--text-accent` are gone entirely
(not left unused — grepped and confirmed no other reference existed), replaced by `--bg-user`/
`--text-user`: `color-mix(in oklab, var(--fg) 12%, var(--panel))` and `var(--fg)`. Same derivation
shape UI8 already established for `--bg-accent` (a `color-mix` of an existing token over `--panel`, no
new colour literal, no separate dark-mode redeclaration needed since `--fg`/`--panel` already flip
per-theme) — only the ingredient hue changed, from `--accent` (a colour) to `--fg` (ink, i.e. no hue at
all). `.turn--user .msg__body` also gained a `1px solid var(--border)` edge — the neutral fill alone
sits close enough to `--panel` in value that a hairline border (the same device `.tchip`/`.gate` already
use for neutral surfaces) keeps the bubble reading as a distinct shape without reintroducing colour.
The Orchestrator's own turns are untouched — still left-aligned, mark, `--accent`-colored mark/plain
`--fg-dim` text, exactly as the goal asked.

**Test coverage.** `tests/user-bubble-color.test.ts` (new file) reads `assets/styles.css` directly and
asserts: `.turn--user .msg__body` contains neither `var(--accent)` nor `var(--danger)` (nor either
token's derived variants) in any form; it does use `background:var(--bg-user)`/`color:var(--text-user)`;
those two tokens are themselves derived from `--fg`/`--panel`, never `--accent`/`--danger`; the old
`--bg-accent`/`--text-accent` tokens are gone from the file, not merely unreferenced; and
`[data-theme="dark"]` declares no separate override for the new tokens (confirming the "falls out of
the existing per-theme values" claim above is actually true, not just asserted).

**What was checked and what genuinely could not be, in this sandbox.** The CSS-derivation logic was
verified directly (no `--accent`/`--danger` reachable from the new rule, confirmed by both the test
above and by reading the resulting `color-mix()` calls) and the resulting page was fetched via
`GET /` against a real `levare serve` instance to confirm the new rule and class markup are actually
served. A rendered, pixel-level screenshot of the bubble (light and dark) was NOT captured: this
sandbox has no headless-browser tooling available (`chromium-cli` and `npx`/`playwright` both absent,
and installing one was out of scope for a bug-fix pass) — noted here rather than silently claimed,
the same discipline DIST2 used for the parts of its own release workflow that could not be run from
here.

### Verification

`bun test` — 775 pass, 1 pre-existing skip, 0 fail, across 62 files (see NOTES DIST4 above for the
combined new-test count across both defects in this goal). `bun run deps:check` → `deps ok`.
`./levare replay fixtures/golden --stubs` matches `fixtures/golden/expected.json` byte-for-byte,
unaffected — this fix touches only `assets/styles.css`, never runner/replay behavior.

## DIST5. The SDK worker now runs from a compiled binary too — self-invocation, the standard `bun build --compile` pattern; correcting DIST4's "does not run from a compiled binary yet"

DIST4 found the SDK worker spawn structurally broken under `--compile` and, correctly for that step's
scope, made the Orchestrator refuse honestly instead of crashing — but that refusal papered over the
actual defect rather than fixing it. This goal fixes it: the compiled `dist/levare` binary can now run
the SDK worker, so native members AND the Orchestrator both work from a compiled binary, not just from
source.

### The fix — self-invocation, not a resolved script path

`sdk-transport.ts#createBunSdkTransport`/`createAsyncSdkTransport` used to spawn `[process.execPath,
SDK_WORKER_PATH]` — a generic script interpreter against a resolved file path. Correct in a source run
(`process.execPath` is the real `bun` interpreter); broken under `--compile`, where `process.execPath`
IS the compiled binary itself, which only knows how to run its own embedded entrypoint (confirmed live
in DIST4: `dist/levare <any script path>` printed `unknown command: <path>`).

The fix: spawn a FRESH COPY OF THIS SAME PROCESS, told to run in worker mode via a hidden internal CLI
subcommand (`__worker`, `sdk-transport.ts#WORKER_COMMAND`) — the standard Bun `--compile` self-invocation
pattern, rather than a separately-resolved script. `cli.ts#runCli` intercepts `__worker` BEFORE `main()`'s
own switch/usage() — deliberately never added to that switch, which is what keeps it out of
`--help`/usage() without a separate allowlist mechanism; a bare `main(["__worker"])` call (bypassing
`runCli`) still falls through to the ordinary "unknown command" response, exactly as before this command
existed. The worker's own logic (`sdk-worker.ts`) was refactored from an unconditional module-level
`main(); ` call into an exported `runSdkWorkerFromStdin()`, invoked either by `cli.ts`'s `__worker`
dispatch (in-process) or by the file's own `if (import.meta.main)` guard (when a test spawns it, or any
script, standalone) — the auto-run guard matters because `cli.ts` now imports this module directly, and
an unconditional `main()` call would have run a real SDK query every time anything imported it.

**The argv shape genuinely differs between the two run modes, and that's fine — it's the standard
pattern, not a special-case being smuggled back in.** Confirmed empirically (a scratch `bun build
--compile` reproduction, not assumed): a compiled binary spawning itself as `[execPath, "flag"]`
reports `process.argv.slice(2) === ["flag"]` in the child — the compiled binary always synthesizes its
own `argv[0]`/`argv[1]` (`["bun", "/$bunfs/root/<name>", ...]`), so anything passed after `execPath` in
the spawn array lands as user-facing args, identical to how `runCli(process.argv.slice(2))` already
reads every other command. A raw `bun` interpreter, by contrast, has no script bound to it — `bun
__worker` alone fails with `error: Script not found "__worker"` (confirmed directly) — so the source-run
spawn hands it this file's own entry point (`cli.ts`, resolved via the same `import.meta.url` idiom
`SDK_WORKER_PATH` already used, safe here specifically because it's only ever read when
`isCompiledBuild()` is false). Either way the child's `process.argv.slice(2)` ends up exactly
`[WORKER_COMMAND]` — one `workerSpawnArgv()` helper (sdk-transport.ts) branches on run mode so every
call site stays identical.

### A second, distinct compiled-only bug this surfaced live, not by inspection: the spawn's own `cwd`

Fixing the argv shape alone was not enough — a live compiled-binary test still failed, with a NEW
error: `ENOENT: no such file or directory, posix_spawn '<execPath>'`. Every worker spawn pins an
explicit `cwd` (`LEVARE_ROOT`, derived from `SDK_WORKER_PATH`'s `import.meta.url` resolution) so the
worker script resolves its own `node_modules` regardless of the caller's cwd (NOTES phase-7 K13).
`LEVARE_ROOT` is a real, walkable on-disk directory in a source run — but under `--compile`,
`import.meta.url` resolves into Bun's virtual `$bunfs` tree, so `LEVARE_ROOT` becomes an unwalkable
path. `Bun.spawn` cannot `chdir` into a `cwd` that doesn't exist on the real filesystem, so
`posix_spawn` fails outright and the child never starts — a DIFFERENT failure mode than the argv bug,
one DIST4 never reached because its blanket refusal short-circuited before any real spawn was ever
attempted. This was never caught by reading the code; it only showed up running the actual compiled
binary's real `serve` against a real studio and POSTing `/orchestrator/message` — exactly the
"verify against the real thing" discipline DIST4 itself established.

**The fix.** A compiled self-invocation needs no pinned cwd at all: the worker's own module resolution
is irrelevant under `--compile` (everything is embedded), and the native-binary path is already
resolved once by the caller and passed explicitly (`pathToClaudeCodeExecutable`) — so `workerSpawnCwd()`
omits `cwd` entirely for a compiled self-invocation, which makes `Bun.spawn` inherit the running
process's own (real) cwd instead. The explicit-`workerPath` test-injection shape (see below) is
untouched — those scripts are always spawned from a `bun test` process, i.e. never compiled, so
`LEVARE_ROOT` is always a real, valid directory there.

### Both native members and the Orchestrator are fixed by the identical change (goal's point 5, confirmed by reading, not assumed)

`adapters.ts#createSdkNativeBoundary`/`createAsyncSdkNativeBoundary` (the native-member boundary) and
`orchestrator-boundary.ts#createSdkOrchestratorBoundary` (the Orchestrator) both default to the SAME
transport singletons — `bunSdkTransport`/`asyncSdkTransport` (`sdk-transport.ts`, both constructed via
`createBunSdkTransport()`/`createAsyncSdkTransport()` with no `workerPath` argument). There is no
per-caller branch in the spawn shape at all: a native member's request and the Orchestrator's request
differ only in the `SdkWorkerRequest` PAYLOAD (agent context + tool allowlist vs. the Orchestrator's
system prompt + schema), never in how the worker process itself is reached. Confirmed live, not just by
reading the code: piping a native-member-shaped request (`{prompt, model, tools: [], allowedTools:
[]}` — the exact shape `adapters.ts#nativeWorkerRequest` builds) directly to the real compiled
`dist/levare __worker` produced a real completion through the self-invoked worker, the identical
mechanism the Orchestrator's own live test exercises. DIST4's framing ("SDK worker spawn genuinely
cannot be fixed the same way [as the prompt-path bug]") was about why the FIX shape had to differ from
`ORCHESTRATOR_PROMPT_PATH`'s `{ type: "file" }` fix, not about the Orchestrator being uniquely affected
— the underlying defect and this fix both apply identically to every caller of `sdk-transport.ts`.

### The Orchestrator no longer forces "off" under a compiled binary

`orchestrator-status.ts#resolveOrchestratorStatus` and `orchestrator-boundary.ts#selectOrchestratorBoundary`
both dropped their `compiled` parameter and the `if (compiled) return null/unavailable` branch DIST4
added — that branch existed ONLY because the old spawn genuinely could not run under `--compile`; now
that it self-invokes correctly either way, the credential/native-binary precondition
(`checkSdkPreconditionsCached`) is the only thing either function still needs to check, compiled or
source. `levare doctor` reflects this directly: a compiled binary with `ANTHROPIC_API_KEY` unset still
honestly reports `orchestrator: off · ANTHROPIC_API_KEY is not set` (a genuinely missing prerequisite,
per the goal's own carve-out), while a compiled binary with a credential present now reports
`orchestrator: on · The Orchestrator is live.` — identical to a source run, where DIST4 always forced
`off` regardless.

### Test coverage

`tests/orchestrator-status.test.ts` — rewritten (the DIST4 version tested the now-removed
compiled-forces-off branch): asserts `resolveOrchestratorStatus` has no compiled/source branch left —
only the credential/native-binary precondition decides the outcome, with a case for each missing
prerequisite (no key; a key but an unresolvable binary, via the existing `requireFrom` test seam).
`tests/orchestrator-sdk.test.ts` — the `selectOrchestratorBoundary — refuses under a compiled binary`
describe block (which asserted the removed `compiled` parameter) is replaced with a describe block
pinning the new API surface: no third argument exists, and a present key + fake transport selects a
real boundary unconditionally. `tests/orchestrator-compiled-smoke.test.ts` (extended, not rewritten —
the DIST4 tests that are still true, like the prompt-byte-count check, are kept) gained:
- `` `<compiled> doctor` reports 'orchestrator: on' when a credential is present `` — the direct proof
  of the status-reporting fix above; the no-credential case now also asserts the OLD "compiled binary"
  reason string is gone.
- A describe block spawning `<compiled> __worker` directly: piping empty stdin returns a
  worker-shaped `{ok:false, error:"...malformed request JSON..."}` response — proving dispatch reached
  `runSdkWorkerFromStdin`, not `main()`'s "unknown command" fallback — fast, offline, deterministic (no
  network or credential needed, unlike the full round-trip below). A second test confirms `--help`
  never lists `__worker`.
- The old "`serve` never 500s with the `$bunfs` ENOENT" test is replaced by two: one confirming a
  genuinely absent credential still reports the honest `disabled` state (not a compiled-binary
  limitation), and one — the core proof — confirming that with a credential present, a real
  `/orchestrator/message` call is ACTUALLY ATTEMPTED end-to-end through the real self-invoked worker
  (never `disabled`, never `ENOENT`/`$bunfs`/`unknown command`), asserting on the SHAPE of the outcome
  (a real reply or a real, never dispatch-shaped, SDK error) rather than which branch — this
  environment's outcome depends on whether a live, authenticated `claude` CLI session is available
  under the worker's hermetic `CLAUDE_CONFIG_DIR` isolation (NOTES phase-7 K15), which the test
  deliberately doesn't assume either way.

### What was actually run, live, to prove this — not just `bun test`

Beyond the automated smoke test, manually verified against the REAL `bun run build` output
(`dist/levare`, not just the test's own scratch binary): `dist/levare --help` never lists `__worker`;
`dist/levare doctor fixtures/golden` reports `orchestrator: off`/`on` correctly for absent/present
credentials; a real `dist/levare serve <studio>` with a fake key, POSTed `/orchestrator/message`,
dispatched a real self-invoked worker call that reached the real `claude` CLI and got a real (hermetic,
correctly-isolated-from-the-operator's-own-session) `Not logged in` rejection — never `ENOENT`,
`$bunfs`, or `unknown command`; and piping a native-member-shaped request directly to `dist/levare
__worker` under this sandbox's own ambient `claude` session produced a genuine model completion
end-to-end. `./levare replay fixtures/golden --stubs` (source shim) still matches the oracle
byte-for-byte, unaffected — this fix touches only the SDK worker spawn, never the batch runner's
stub-member path.

### Verification

`bun test` — 778 pass, 1 pre-existing skip, 0 fail, across 62 files (was 775 pass/1 skip/62 files
before this goal — NOTES DIST4; net +3 tests: the compiled-smoke file gained more cases than the two
rewritten describe blocks lost). `bun run deps:check` → `deps ok`. `bun run build` succeeds; the
resulting `dist/levare` passes every manual check above. `./levare replay fixtures/golden --stubs`
matches the oracle byte-for-byte.

# NOTES UI10 — client-side navigation: the content column swaps in place; the hang, the conversation wipe, and the per-click waste were one architectural gap, not three bugs

## The hang, precisely diagnosed (per the goal's own directive — recorded here, not independently
## re-reproduced live: this sandbox has no browser/devtools tooling, the same limitation NOTES UI9
## already logged for pixel-level verification)

Every in-app link was a plain `<a href>` to a fresh document (UI4's own deliberate choice — see
below). A burst of rapid navigations — the Conductor clicking through several gates or registry
entities in quick succession — each fires a full document GET, a re-fetch of `styles.css`/`app.js`
(cached after the first load, but still a request), and a teardown-then-reopen of the SSE
`/events` connection (the old connection's `abort` fires as the page unloads; the new page's
`app.js` opens a fresh one at `DOMContentLoaded`). Chrome allows at most ~6 simultaneous
connections per origin over HTTP/1.1; the permanent SSE stream already holds one of those six for
the page's entire lifetime, so a burst of navigations needs only 5 more in-flight requests to hit
the ceiling — a document request plus two assets is 3, and if the previous page's own SSE
teardown hasn't finished draining before the next navigation's asset requests land, the burst
routinely eats the rest. The newest navigation's own document request then queues client-side,
invisible to any server-side instrumentation: Chrome's Network panel shows "Provisional headers
are shown" — a request that was handed to the browser's own connection scheduler but has not yet
been placed on the wire, so there is no response to inspect and nothing server-side to blame it
on. The server itself was never slow: `curl`ing the exact same URL during a live episode answered
in 0.138s. That's the exoneration — the bottleneck was never `levare serve`'s own request
handling, it was the browser running out of places to put the next request while an unrelated
permanent connection (the SSE stream) sat on one of its six slots for the whole session.

## The design

The app shell — the header, the left rail, the Orchestrator panel (and thus its conversation), and
the one persistent `/events` SSE connection — now persists across every in-app navigation. Clicking
a same-origin, unmodified, left-click link on an in-app href fetches ONLY the new page's content
column and swaps it into `<main class="main">` in place; the URL updates via `history.pushState`.
This directly removes all three problems the goal named as one architectural gap:

1. **The hang** — an in-app click no longer fires a document request, an asset re-fetch, or an SSE
   teardown/reopen at all. There is nothing left to exhaust the connection pool with.
2. **The conversation wipe** — the Orchestrator `<aside class="orch">` and everything inside it
   (`.orch__body`'s turn history) is never touched by a swap; it is the same DOM subtree before and
   after every in-app navigation.
3. **The waste** — `styles.css`/`app.js` are fetched once, ever, per page load; the SSE connection
   opens once, ever, per page load — regardless of how many in-app navigations follow.

## Re: UI4's own prior removal of client-side interception — this is not the same mistake again

NOTES UI4 deliberately deleted an earlier, naive `[data-goto]` click interceptor for the registry's
kind-switch links: `preventDefault()` plus a DOM swap that never touched the URL or `history` at
all — so the browser's back/forward buttons had nothing to restore to; back from a client-switched
registry kind just left the page state and the address bar out of sync. That interceptor is not
being reintroduced. This goal's mechanism differs in the one respect that actually mattered:
**every** in-app navigation calls `history.pushState` with the real target URL, and a `popstate`
listener re-fetches and re-swaps for whatever URL the browser restores — so Back/Forward re-derive
the page from the server exactly as a real navigation would, just without the network round-trip
for assets/SSE. A cold GET of any URL (a pasted deep link, a bookmark, a shared link) is completely
unaffected — the fragment mechanism is opt-in via a request header only this project's own
`app.js` ever sends; every route's ordinary GET response is byte-for-byte what it always rendered.

## One rendering path — the fragment is sliced out of the SAME render call, never a second one

`src/board/render.ts#pageBody()` (used by all six screen renderers — studio, project, run,
artifact, idea, registry) wraps the content column and a page's own "extras" (gate-summon
`<template>`s on the project page; the shared registry editor overlay on the registry page — both
recreated per navigation, unlike the Orchestrator's conversation, which has real state worth
keeping) in plain HTML comment markers: `<!--main-->...<!--/main-->` and
`<!--extras-->...<!--/extras-->`. These markers are inert in every existing code path — invisible
in the rendered page, untouched by any existing test's `.toContain(...)` assertions (additive
only), and never reachable from escaped user content (`derive.ts#esc()` turns any literal `<`/`>`
in interpolated data into `&lt;`/`&gt;`, so a comment delimiter can never appear inside data by
accident).

`src/board/serve.ts#extractFragment()` is pure string slicing against that marker output — no HTML
parser, no DOM library (this project has neither, by design). `createBoard`'s router calls the
route's ordinary handler FIRST, exactly as a cold GET would (same function, same repo read, same
render call) — a fragment request (`X-Levare-Fragment: 1`, sent only by this project's own
`app.js`) then slices the already-rendered HTML string into `{title, main, extras, highlightId}`
and returns that as JSON instead of the full document; a non-fragment request is returned
completely unchanged. `tests/board-fragment.test.ts` proves this directly rather than by
inspection: for `/studio`, `/project/storefront`, and `/registry/teams`, it fetches BOTH the
ordinary HTML response and the fragment response for the same URL and asserts the fragment's
`main`/`title`/`extras` are byte-identical to the same regions sliced out of the ordinary
response — the fragment path cannot have forked the render logic, because both assertions are
computed from what the exact same route handler produced.

Onboarding (`renderOnboarding`, an unrelated standalone screen that never goes through
`pageBody()`) has no markers; `extractFragment` returns `null` for it, and the route falls back to
serving the real, unmodified onboarding HTML even under a fragment request — the client's job is to
notice the non-JSON response and fall back to a real navigation (FAILURE HONESTY, below), not to
special-case onboarding itself.

## The client: interception, the swap, and failure honesty

`assets/app.js`'s new navigation block: a delegated `document` click listener intercepts a link
click only when it is same-origin, left-click (`button === 0`), carries no modifier key
(ctrl/meta/shift/alt), has no `download` attribute, no `target` other than `_self`, and is not a
bare `#` fragment link — everything else (external links, modified clicks, downloads, in-page
anchors) navigates exactly as an ordinary `<a>` always has, untouched. On an intercepted click:
`fetchFragment(url)` sends the request with the fragment header and validates the response is
`ok`, carries an `application/json` content-type, and its `main` field is a string; anything short
of that (network failure, a non-200, a non-JSON reply) resolves to `null`. `navigate()` then either
applies the swap (`swapFragment`: replaces `<main class="main">` outright via
`document.createElement('div').innerHTML = data.main` then `replaceChild`, refills
`[data-extras-host]`, updates `document.title` — decoding the handful of entities `esc()` can
produce, since a raw `document.title = "..."` assignment does not decode HTML entities the way an
initial `<title>` parse does — reapplies the registry deep-link highlight/scroll behavior, and
scrolls to top) or, if the fetch failed for any reason, falls back to `location.href = url` — a
real navigation, never a broken half-swap (the goal's own FAILURE HONESTY requirement). A
navigation token guards against a slow, superseded fetch applying its stale swap after a newer
click has already landed.

`history.pushState` fires only for a genuine click-driven navigation; a `popstate` listener and the
SSE `reload` trigger both call the same `navigate()` with `push:false` — a `popstate` (the browser
has already moved `location` before firing the event) or an SSE-driven repo change is a content
REFRESH of a URL the history stack already has an entry for, not a new one.

## The registry editor overlay needed a rebind hook, not just a swap target

The registry editor overlay (`editorOverlay()`) lives inside the swappable `extras` region — its
concrete DOM node is destroyed and a fresh one created by every navigation into or within the
registry (and re-created as *absent* on every navigation away from it). The overlay's direct
element listeners (Cancel/backdrop/Save/textarea-input — all bound to specific button/textarea
node instances at setup time, matching `tests/board-editor-overlay.test.ts`'s existing direct-
dispatch test style, which this change deliberately preserves rather than rewriting to full
delegation) would otherwise silently stop working the first time the Conductor client-navigates
into the registry from any other screen — `bindEditorOverlay()` (unchanged in *body* from the
pre-UI10 code, just wrapped so it is re-callable) now runs once at startup and again inside
`swapFragment()` after `[data-extras-host]` is refilled. The two handlers that genuinely don't
need rebinding — the `[data-edit-open]` open-trigger and Escape-to-dismiss, both already
`document`-delegated before this goal — are attached exactly once and call through
`openEditor`/`requestDismiss`, two outer `var`s `bindEditorOverlay()` reassigns on every call, so
they always resolve to whichever overlay instance is current without accumulating duplicate
`document`-level listeners across repeated registry navigations.

A successful registry save (`ovSave`'s click handler) and the SSE `reload` broadcast both used to
call `location.reload()` — both now call the shared `refreshCurrent()` (a same-URL, `push:false`
navigate) instead, so neither one tears down the SSE connection this goal exists to stop doing
that to. This does not change one pre-existing, unrelated risk: an SSE-driven refresh that lands
while the editor overlay is open with unsaved changes already discarded that buffer under the old
`location.reload()` behavior; it still does under the new swap-based refresh, for the same reason
(the extras region, overlay included, is unconditionally replaced) — noted as an accepted,
unchanged tradeoff, not a new regression this goal introduced.

## Test coverage

`tests/board-fragment.test.ts` (new) — `extractFragment` unit tests (marker slicing, a null result
when markers are absent, an empty-string `extras` when a page has none, `highlightId` parsing);
`isFragmentRequest`; a live `createBoard("fixtures/golden")` suite: every parameterless `page`
route's cold GET (no fragment header) is still the complete, unaffected HTML document; a fragment
GET returns the JSON envelope and never leaks rail/orch markup into `main`; the byte-identity proof
against the ordinary response described above; the registry deep-link highlight id; extras
containing the editor overlay on a registry page and the empty string elsewhere; a project page's
gate-summon template landing in `extras`, never inside `main`; a non-page route (an asset) ignoring
the fragment header entirely; an unknown route still a plain 404 JSON envelope under the fragment
header; and a fragment GET against an uninitialized studio falling back to the real onboarding HTML
(content-type `text/html`, no markers) rather than a fragment envelope.

`tests/board-client-navigation.test.ts` (new) — the same "load the real `assets/app.js` verbatim
into a hand-rolled fake DOM via `node:vm`" pattern `tests/board-orchestrator-conversation.test.ts`
and `tests/board-editor-overlay.test.ts` already established, extended with a real (not mocked)
small tag-soup HTML parser backing a `FakeElement.innerHTML` setter — since the swap's whole
mechanism IS "parse fetched HTML into DOM nodes," the harness needs an `innerHTML` that actually
parses, not a stub — plus a fake `history` (records `pushState` calls, exposes the current
entry), a `location` whose `pathname`/`search` a test can move (mirroring a real browser moving
`location` before firing `popstate`) and whose `href` setter is observable (proving a real-
navigation fallback occurred), and a `window` with `addEventListener`/`dispatchEvent` for
`popstate`. Asserts, all against the real `app.js`: an in-app click fetches the fragment with the
`X-Levare-Fragment` header and swaps `.main` without any document navigation; the swap pushes
history with the clicked URL; `popstate` re-fetches and re-swaps for the restored URL and never
pushes a new entry (back/forward parity with real navigation — the exact property NOTES UI4's own
removed interceptor lacked); the Orchestrator panel's conversation turn is the SAME DOM node,
untouched, before and after a swap; the rail is likewise untouched; the SSE `EventSource` is
constructed exactly once regardless of how many in-app navigations follow; the SSE `reload`
message refreshes the CURRENT url's content in place without pushing history or opening a second
`EventSource`; a modified click (ctrl/meta/shift/alt, or a non-primary mouse button), an external
(cross-origin) link, and a `download` link are each never intercepted (`preventDefault` never
called, no fetch ever issued); and, twice over — a rejected fetch, and a resolved-but-non-JSON
response (the onboarding-fallback shape) — a failed fragment fetch falls back to a real navigation
(`location.href` assignment) rather than a broken half-swap, leaving the existing DOM exactly as it
was.

`tests/board-editor-overlay.test.ts` (existing suite, one test updated) — the "Save closes the
overlay" test now asserts the post-save refresh is a THIRD fragment fetch (`/registry/teams` with
the `X-Levare-Fragment` header), not a `location.reload()` call — the same behavioral change
`refreshCurrent()` makes in production, proven against the exact same suite that already drives
the real overlay code end-to-end. The suite's fake `location`/`window`/`history` objects gained the
minimal surface (`pathname`, `search`, `href`, a no-op `history.pushState`) `refreshCurrent()`
now touches; every other fixture and assertion in that file is unchanged, and every other test in
it still passes unmodified — the `bindEditorOverlay()` refactor preserves the exact direct-listener
behavior that suite exercises (see above), it only wraps it so it is re-callable.

## Verification

`bun test` — 804 pass, 1 pre-existing skip, 0 fail, across 64 files (was 778 pass/1 skip/62 files
before this goal — NOTES DIST5; net +26 tests: 15 in the new `board-fragment.test.ts`, 11 in the new
`board-client-navigation.test.ts`). `bun run deps:check` → `deps ok`. `./levare replay fixtures/golden
--stubs` matches `fixtures/golden/expected.json` byte-for-byte, unaffected — this goal touches only
`render.ts`/`serve.ts`/`app.js`, never the runner or replay path. Manually verified against a live
`levare serve` instance pointed at a scratch copy of `fixtures/golden`: a cold `GET /studio` is still
a complete `<!doctype html>` document carrying the `<!--main-->` marker (present but inert — the
marker changes nothing about what a cold GET renders); a fragment `GET /project/storefront` (with
`X-Levare-Fragment: 1`) returns a `200 application/json` envelope whose `main` is the real,
server-rendered project page's content column; a fragment `GET /registry/connectors/linear` reports
`highlightId: "connectors-linear"`, matching the cold page's own `data-highlight` deep-link target.

**What could not be verified live, and why.** The Chrome connection-exhaustion hang itself (per-tab
Network-panel behavior, "Provisional headers are shown") was not independently reproduced in this
sandbox — there is no headless-browser or devtools-protocol tooling available here (the same,
already-logged limitation as NOTES UI9's pixel-level screenshot gap); the diagnosis above is
recorded as directed by the goal, not re-derived from a fresh repro. What WAS verified live is the
mechanism that removes the hang's precondition: an in-app navigation, exercised end-to-end against
the real server above, issues exactly one request (the fragment fetch) — no document GET, no asset
re-fetch, no SSE reconnect — which is the structural fix regardless of whether this sandbox can put
a real Chrome tab through the original failure to confirm it no longer occurs.

# NOTES: the fixed-port straggler — a fifth site the prior sweep's own grep couldn't see

## Why the earlier "no fifth site" claim (above, "Test suite: fixed ports collided...") was wrong

That fix searched for other subprocess spawns of `./levare` and found none, so it declared the class
finished. It missed `tests/orchestrator-compiled-smoke.test.ts`, which spawns a *compiled* binary
(`scratchOut`, a `bun build --compile` scratch output built by `scripts/build.sh`) rather than
`./levare` — a grep keyed on the literal string `./levare` structurally cannot see a spawn of a
different path, even though the underlying defect (a formula-derived port instead of an OS-assigned
one) is identical. Two tests there each computed a "spread but still fixed" port — `41000 +
(process.pid % 500)` and `41500 + (process.pid % 500)` — the exact pattern the original fix's own
`serve-subprocess.ts` header already named as the thing to avoid, just re-invented in a file the
grep didn't reach. This is the second time this class has shipped incomplete (four sites fixed, a
fifth surfaced two sessions later); the lesson applied this time is to grep for the *symptom*
(`port` near a multi-digit literal, anywhere in `tests/` and `src/`) rather than for one known
caller shape, and to treat "no more matches for MY search" as weaker evidence than a suite-wide
pattern grep.

## The fix

`tests/serve-subprocess.ts#spawnLevareServe` gained an optional `bin` (default `"./levare"`) so the
same OS-assigned-ephemeral-port + read-the-bound-port-back-from-stdout helper works for any binary
that accepts `levare`'s CLI shape — the source shim and a compiled `bun build --compile` output
alike, since both print the identical `runServeCmd` startup line. Both
`orchestrator-compiled-smoke.test.ts` tests now call `spawnLevareServe([root, "--no-daemon"], {
bin: scratchOut, ... })` instead of hand-rolling a `Bun.spawn` with a formula port; the
`await new Promise((r) => setTimeout(r, 500))` "hope it's up by now" waits in both tests are gone
too, since `spawnLevareServe` only resolves once the subprocess's own stdout proves the server is
actually listening — strictly stronger than a fixed sleep.

**Suite-wide confirmation, not just this one file.** `grep -rnE "port[^a-zA-Z]{0,3}[1-9][0-9]{3,4}"
tests/ src/ scripts/` — the only remaining hits are `cli.ts`'s and `board/serve.ts`'s own `4173`
*default* (never itself a test booting a server) and `security-audit.test.ts`'s `4173` used purely
as a same-origin URL literal in a CSRF assertion (no server bound). `grep -rnE "Bun\.serve\(|\.listen\("
tests/` — no hits outside `src/board/serve.ts` itself. No fixed-port server boot remains anywhere in
`tests/`.

## Verification

`bun test` — 804 pass, 1 pre-existing skip, 0 fail, across 64 files (unchanged pass count; this is a
pure conversion, no new/removed test cases). `bun test` re-run with a decoy `levare serve
fixtures/golden --port 4173 --no-daemon --read-only` bound and confirmed listening (`curl` 200)
before the suite ran — identical result, 804 pass/0 fail, exit 0; the decoy was still answering
requests when the suite finished, proving nothing raced or crashed it. `levare replay fixtures/golden
--stubs` matches `fixtures/golden/expected.json` byte-for-byte. `bun run deps:check` → `deps ok`.

# NOTES: readdir[0] order-dependence in a work-unit folder-artifact's index resolution

## The defect

`repo.ts#loadUnitArtifacts`, resolving which file inside a folder artifact (e.g.
`work/<project>/<unit>/design-x/`) carries the frontmatter, took `readdirSync(full).filter((n) =>
n.endsWith(".md"))[0]` — the first `.md` by whatever order the filesystem's `readdir()` happens to
return, which POSIX leaves unspecified. `validate.ts`'s `INDEX_COUNT` check rejects a folder holding
more than one `.md` file, but that check runs on a separate path (`discoverFolderArtifacts`, only
reached when `loadRepo`'s `validate: true` default is in effect) — a repo loaded with `{ validate:
false }` (an established, already-used pattern: `tests/f19-blocked-artifact-verbs.test.ts`,
`tests/binding.test.ts`, `tests/f20-loop-exhaustion.test.ts` all inspect intermediate/off-contract
state this way) can still reach `loadUnitArtifacts` with two `.md` files present in a folder, and
whichever one the OS handed back first silently became "the" artifact — the same class as the F11
insertion-order bug: never let read order pick the authoritative file.

## The fix

Sort the directory listing before filtering/taking the first entry:
`readdirSync(full).sort().filter((n) => n.endsWith(".md"))[0]` — matching the tiebreak already used
by every other `readdirSync()` call in this file (`dirs()`, the outer project/unit loops, the
top-level `loadEntities` sweep). There is no named-file convention for a folder artifact's index (no
`index.md`-only rule is enforced anywhere — the golden fixture's own folder artifact happens to be
named `index.md` but nothing requires that name), so lexicographic-sort-then-first is the rule that
matches the existing contract (deterministic, documented, no new naming requirement imposed on
folder-artifact authors).

## Test coverage

New `tests/repo-folder-artifact-order.test.ts`: builds a scratch folder artifact with two `.md`
files (`a-first.md` / `z-second.md`, distinct `id`s) written in each disk-write order in turn, loads
the repo with `{ validate: false }`, and asserts the resolved artifact is always the
lexicographically-first file's `id` — never the other one, and stable across repeated loads.
Confirmed the test actually exercises the fix by reverting `repo.ts`'s `sort()` and re-running: both
new tests fail (the pre-fix `[0]`-of-unsorted-readdir happened to return `z-second.md` first in this
environment) — re-applying the fix restores 0 fail.

## Verification

`bun test` — 806 pass (+2 from the new file), 1 pre-existing skip, 0 fail, across 65 files. `levare
replay fixtures/golden --stubs` matches `fixtures/golden/expected.json` byte-for-byte (this fix only
changes which pre-existing single-index folder artifact wins a tie that never occurs in the golden
fixture — its own folder artifacts each already have exactly one `.md`). `bun run deps:check` → `deps
ok`.

# NOTES: RENAME-ORPHANS-REFERENCES — a hint, not a rewrite, when a broken reference is clearly a rename

## Scope, deliberately minimal

Full guided-rename (rewriting every stale reference automatically) is out of scope per the goal. This
only makes an existing failure explain itself when the evidence for "this is a rename" is
unambiguous — it never rewrites anything and never guesses when the evidence is merely suggestive.

## Where it applies

`UNKNOWN_TEAM` (`validateResponsibleTeam` in `validate.ts`) is the one place in this validator where
a reference names an *entity* (a `name:`-bearing registry file — team/agent/type/project/connector/
knowledge/eval/skill) that doesn't resolve. (`UNRESOLVED_CONSUMES`/`UNRESOLVED_SUPERSEDES` are the
closest cousins, but those reference artifact `id`s, not entity `name:` declarations, so a rename
there has no analogous "does a file exist under the declared name" evidence to check — left alone,
per "never guess wildly.")

## The signal used

A team file whose FILENAME still matches the unresolved name (e.g. a reference says `team: kestrel`
and `teams/kestrel.md` still exists) but whose own `name:` field now declares something else (e.g.
`name: raven`) — the entity itself was renamed (its declared identity changed) but the file wasn't
moved and the reference wasn't updated. This is the one conservative case the fix checks; an
unresolved name with no file at all behind it (an ordinary typo, or a genuinely deleted team) gets no
hint, since there is no on-disk evidence to hint from.

## The fix

`validateResponsibleTeam` now also builds `teamNameByFileStem` (file stem → declared `name:`) while
it walks `teams/`, and collects every `UNKNOWN_TEAM` error it emits into a `Map<oldName,
ValidationError[]>`. After the unit walk, for each unresolved name with a file-stem match whose
declared name differs, it appends one line to EVERY error object already naming that reference (there
can be more than one unit still pointing at the old name): `"if you renamed an entity, every
reference to the old name must be updated — N reference(s) still point at '<old>'; teams/<old>.md now
declares name: '<new>'"` — the exact count and the concrete new name, both read off disk, never
guessed.

## Test coverage

Two new tests in `tests/validate.test.ts` (reusing the existing `F10 defect 2`describe block's
`buildStudio` fixture helper): (1) rewriting `teams/kestrel.md`'s `name:` to `raven` while the unit
still says `team: kestrel` — asserts the hint appears, names the count and both the old and new name;
(2) the pre-existing "team: naming a team that doesn't exist" ghost-team case — asserts the hint does
NOT appear, since no file exists under that name at all (an ordinary typo, not a rename).

## Verification

`bun test` — 808 pass (+2), 1 pre-existing skip, 0 fail, across 65 files. `levare replay
fixtures/golden --stubs` matches `fixtures/golden/expected.json` byte-for-byte (golden's own teams
are never renamed, so this path is never exercised there). `bun run deps:check` → `deps ok`.

# NOTES: release workflow action versions — clearing the Node 20 deprecation warnings

## The defect

The v0.1.0 Actions run emitted six Node 20 deprecation warnings from `actions/checkout@v4` and
`actions/upload-artifact@v4` — both pinned to majors whose runtime has since moved past what GitHub
now considers current.

## What was bumped, and how the target versions were confirmed

Queried the GitHub API directly for each action's actual latest release (not from training-data
memory, since this repo's own knowledge cutoff predates today) — `curl
https://api.github.com/repos/<org>/<repo>/releases/latest`:

- `actions/checkout` **v4 → v7** (latest: v7.0.0, 2026-06-18)
- `actions/upload-artifact` **v4 → v7** (latest: v7.0.1, 2026-04-10)
- `actions/download-artifact` **v4 → v8** (latest: v8.0.1, 2026-03-11) — not named in the goal's own
  six-warning list, but it is the same class (a GitHub-owned action several majors behind), so bumped
  as "any other deprecated action version" per the goal's own instruction
- `softprops/action-gh-release` **v2 → v3** (latest: v3.0.2, 2026-07-13) — same reasoning; v3's own
  release notes confirm it is purely a Node 20 → Node 24 runtime move, no input/output changes
- `oven-sh/setup-bun` **left at v2** — its latest release (v2.2.0, 2026-03-14) is still major v2; no
  bump due

Checked each new major's release notes for the two workflow files' actual usage before bumping:
`checkout@v7` and `upload-artifact@v7`/`download-artifact@v8` are additive (new opt-in parameters —
direct unzipped uploads, digest-mismatch handling — all defaulting to the prior zipped-artifact
behavior this workflow already relies on); `action-gh-release@v3` is a pure runtime bump. None require
a new required input this workflow doesn't already pass.

## Verification

`bun -e "Bun.YAML.parse(...)"` — both `.github/workflows/ci.yml` and `.github/workflows/release.yml`
still parse. `bun test tests/release-workflow.test.ts` — all 17 structural assertions pass unchanged
(none of them pin an exact action version string; they match on the action name prefix, e.g.
`startsWith("softprops/action-gh-release")`, so no assertion needed updating). Full `bun test` — 808
pass, 1 pre-existing skip, 0 fail, across 65 files (no test count change — this finding touches only
the workflow YAML). `levare replay fixtures/golden --stubs` matches `fixtures/golden/expected.json`
byte-for-byte. `bun run deps:check` → `deps ok`.

**What could not be verified.** These workflows only truly run under GitHub Actions itself (pushing
to `main` / tagging a release) — not something this sandbox can execute — so the *absence* of the
Node 20 deprecation warnings on a real run is asserted from each new major's own release notes
(runtime bumped to Node 24, as GitHub's deprecation notice requires) rather than independently
re-observed in a live Actions run.

# NOTES UI11 — the long-list treatment, the types/connectors registry-card sweep, and Orchestrator/user timestamp captions

## Item 1: long lists

**Left nav (Projects/Ideas).** `railNav`'s two long-lived rail sections now cap at 7 rows
(`RAIL_LONGLIST_CAP`, `render.ts#railLongList`); at 7 or fewer a section renders exactly the same
markup as before (verified against the existing "rail is byte-identical across all six screens"
test, unchanged). Past 7, the remaining rows still render server-side — inside a `hidden`
`.railsec__overflow` div — followed by a `<button data-rail-expand>+ N more</button>`;
`assets/app.js`'s one new `click` delegate un-hides the overflow div and removes the button. No new
route, no fetch: the "expansion reveals the rest client-side" requirement is just un-hiding markup
that was already in the DOM.

Projects order by real recency now (`derive.ts#projectLastActivity`: the newest `created` date among
any artifact anywhere in the project), most-recently-active first — never filesystem mtime, same
reasoning `mostRelevantUnit` already established. **Ideas get no such reordering**: the `idea`
frontmatter schema (`validate.ts#IDEA_SCHEMA`) carries no timestamp field at all, and NOTES UI1's own
precedent already rejected filesystem mtime as a recency signal ("a fresh git checkout stamps [it]
uniformly and so carries no real recency signal"). Rather than fabricate a signal that doesn't exist
on disk, ideas keep their existing order (`extra.ts#loadDir`'s own `readdirSync().sort()`) — the cap
+ expand mechanic applies identically regardless, which is the actual behavioural contract the goal's
achieved-when criteria test.

**Registry list filter.** `renderRegistry` now renders a `<input data-registry-filter>` above the
card grid when the *active* kind's own count exceeds 10 (`registryKindCount`); at 10 or fewer, no
input. `assets/app.js`'s one new `input` delegate filters `.entity.card` elements by their visible
`.entity__title` + `.rendered` text (never the hidden `.rawmd-source` raw-markdown textarea — that's
"Edit source" material, not what's on screen), toggling a plain `.is-filtered-out` class rather than
touching `style.display` (which `entityBlock` already uses, per-kind, for the inactive-kind cards —
two independent hiding mechanisms compose fine since "hidden OR hidden" is still hidden).

Both features are pure delegated listeners on `document` (`click`/`input`), matching the codebase's
own established idiom for anything that must survive a UI10 client-side navigation swap without a
rebind step (see app.js's own comment on the editor-overlay's two document-delegated listeners) — the
rail is never one of the two regions a swap replaces at all, and the registry filter input is
re-created fresh by every swap into `.main`, so neither needs special-casing.

## Item 2: types cards

Dropped the `glyph` prow row (RULE A, same ruling UI7 already applied to teams/agents/skills — the
title already shows it via `${t.glyph} ${esc(t.name)}`). `expects`/`gates` now render as chip rows
through the same `tag()` primitive agents' `produces` already uses, replacing the old
arrow-joined/comma-joined plain strings.

## Item 3: connectors cards

**Kind badge.** `connectorKindBadge` (render.ts) reuses the exact `.kindbadge` shape-treatment system
UI7 built for agent kinds — `cli` shares the agent kind's own outlined `--cli` variant (identical
concept), and a new `.kindbadge--mcp` (filled, like `--native`) was added so the two connector kinds
read as a clear filled/outlined pair. Neither draws from the status palette — confirmed by extending
the existing "`.kindbadge` rules never contain `var(--active/--ok/--gate/--danger)`" test, which
already sweeps every `.kindbadge*` rule in the stylesheet including the new one.

**The C13 scoping warning — a deliberate tension with NOTES UI1, resolved without reopening the
brief's colour ban.** NOTES UI1 previously stripped this exact note down to plain neutral text,
because the design brief bans a general-purpose amber "warn" hue outright ("anything tempted toward
amber is either needs-you (brass, gate-shaped) or failed (red), or it renders neutral with text").
This goal explicitly asks for real warning styling on the *same* note ("it IS a warning and must get
proper warning styling"). Read literally, those two rulings collide; the resolution kept here is that
the brief's ban is specifically about the amber/red *hues* (gate brass and failure red are
semantically reserved), not about whether a warning may ever look distinct at all — so
`components.ts#noticeWarning` gives it a bordered/tinted panel plus a small vendored alert-triangle
icon, entirely in the neutral ink scale (`var(--fg)`/`var(--panel)`/`var(--border-strong)`, the exact
same "shape/treatment, never colour" reasoning `agentKindBadge` already established for RULE B). No
amber, no red, no new hue anywhere — just more visual weight than a plain `<div class="prow">` row.
Checked whether this warning renders anywhere else on the board (the goal named "doctor's board
rendering" as a second possible site): `doctor.ts`'s own `health.warning` field is only ever consumed
by the CLI text formatter (`doctor.ts:109`, unchanged per the goal) — `railNav`'s connector rows
(`render.ts`) show only a status dot and name, never this warning text, so the registry card is the
only board surface that ever renders it.

## Item 4: Orchestrator/user timestamp captions

`components.ts#orchTurn` took a plain `caption?: string`; it now takes a structured
`{ captionTime?: { text, title }, captionLabel? }`, rendered by the new `turnCaption()` primitive as
`<label · ><span class="turn__time" title="<full ISO>"><relative text></span>` — every caption's
relative text is now a real computed value (`derive.ts#captionTime`: "now"/"2m"/"1h"/"3d", the same
coarse buckets as the existing `ageLabel` but "now" instead of "just now" for the first minute, since
a conversation caption reads more naturally that way) with the full ISO timestamp in the `title`
attribute, never just a hardcoded string. The three screens that already used `orchTurn`
(studio/project/run) pass `captionLabel: "briefing"` unchanged in spirit; the three that had never
been migrated off UI8's predecessor (`renderArtifact`/`renderIdea`/`renderRegistry`, still on the old
raw `<div class="msg"><div class="msg__label">` markup — apparently missed when UI8 introduced the
turn/caption anatomy) are migrated onto `orchTurn` here too, since leaving them behind would mean 3 of
6 screens didn't get this goal's spacing/timestamp fix at all. `renderIdea`/`renderRegistry` gained a
`now: Date = new Date()` parameter (both previously had none) to compute the caption's timestamp;
every existing positional call site is unaffected since both new params are appended, not inserted.

**Every turn, not just the opening briefing, now carries a caption** — the goal's achieved-when
explicitly names both "orchestrator AND user messages" (plural), and generalizing the mechanism (not
just fixing its CSS) is what makes the two speakers' captions genuinely "visually consistent with
each other," not one one-off case and one absent one. `assets/app.js#appendTurnMessage` stamps a
caption (`buildCaption()`) once per NEW turn (never on a same-speaker message merging into an
existing turn — matching the pre-existing "no later message repeats the caption" rule, just widened
from "the opening message only" to "every turn"), using `new Date()` at the moment of creation — every
client-appended turn is definitionally "now" (zero elapsed time between creating it and stamping it),
so the relative text is always `"now"`; the bucketing logic exists client-side purely to mirror
`derive.ts#captionTime`'s markup shape exactly, not because this call site needs anything else today.

**The CSS fix for "the caption currently crowds the message."** `.turn` was `display:flex` with no
`flex-direction` (a row) and `.turn__caption` was a third flex sibling next to `.turn__mark` +
`.turn__content` — despite the pre-existing doc comment already claiming it rendered "beneath the
whole turn," it did not; it sat in the same row, which is the actual crowding this goal names.
Fixed with the standard flex-wrap trick: `.turn{ flex-wrap:wrap }` plus `.turn__caption{ flex:0 0
100% }` forces the caption onto its own line under the fixed-width mark + flexible content, with
`margin-left:21px` aligning it under the message text (mark width + row gap) rather than under the
mark glyph. The Conductor's turn (no mark, right-aligned bubble) gets `margin-left:0; text-align:right`
instead, so its caption reads as "beneath the bubble" rather than under a mark that isn't there — both
speakers share the identical `.turn__caption`/`.turn__time` classes and only this one alignment rule
differs.

## Test coverage

New `tests/board-ui11.test.ts`: server-rendered structure for the nav long-list (9-project and
11-idea synthetic/scratch repos: exactly 7 visible, the rest in a hidden overflow, exact "+ N more"
count; a 7-and-fewer case renders no wrapper at all) and the registry filter (11 vs. 10 synthetic
teams; every golden-fixture kind, all small, renders no input); the types card sweep (no glyph row,
expects/gates as chips); the connectors sweep (kind badge shape, no forbidden status-palette colour;
a synthetic `auth: subscription` connector's note carries the `notice--warning` treatment and its
icon, while `auth: env` connectors carry no warning at all); and a hand-rolled DOM harness (same
no-framework approach as `tests/board-orchestrator-conversation.test.ts`) proving the rail-expand
click and the registry-filter input actually work against the real `assets/app.js`, not just that the
server emits the right markup.

Extended `tests/board-orchestrator-conversation.test.ts`: the existing "briefing · now" caption
assertion updated for the new `<span class="turn__time" title="...">` markup; three new tests assert
a client-appended Orchestrator turn and a Conductor turn both carry the identical caption treatment
(relative text "now", full-ISO `title`), and that a second message merging into an existing turn does
not add a second caption.

## Verification

`bun test` — 827 pass (+19 from the two new/extended files), 1 pre-existing skip, 0 fail, across 66
files (up from 808/65 pre-UI11). `levare replay fixtures/golden --stubs` matches
`fixtures/golden/expected.json` byte-for-byte. `bun run deps:check` → `deps ok`.

**What could not be verified.** No browser/devtools tooling exists in this sandbox (the same
limitation NOTES UI9/UI10 already logged), so the actual pixel-level result — whether the caption
genuinely reads as "unobtrusive," whether the filter input's placeholder wraps sensibly at narrow
widths — is asserted from markup/class structure and the hand-rolled DOM harness's behavioural
checks, not from an observed render.

# NOTES UI12 — a canonical message-severity scale, closing the tension NOTES UI11 documented

## The gap

The design brief had a canonical **status** palette (entity lifecycle state: done/active/waiting/
blocked/needs-you/failed) but no vocabulary at all for **message severity** — how seriously the
Conductor should take a callout, as opposed to what state an entity is in. NOTES UI11 hit this
directly: the C13 `auth: subscription` connector note is genuinely a warning, but the brief's
blanket "no general-purpose amber" rule left `noticeWarning` (components.ts) with a tinted panel and
an alert icon but no colour — "structure without colour" was that note's own honest description of
the compromise. This goal's ruling is that the missing vocabulary, not the amber ban, was the actual
defect — so it adds the vocabulary rather than reopening the status palette.

## The brief amendment (docs/levare-design-brief.md)

A new **"Message severity is a second, independent scale"** section sits alongside "Status is the
canonical state palette," explicit that the two are different channels answering different
questions ("what lifecycle state is this *entity* in" vs. "how seriously should the Conductor take
this *message*"). Three levels: **NOTE** (neutral ink, quiet info affordance), **WARNING** (a muted
amber — tinted panel, amber-toned border and icon, ink body text), **DANGER** (the existing danger
red, formally folded into the scale, unchanged).

The amber rule is refined, not repealed: gate brass (§"Gate color means 'needs you'") stays the only
amber-family value on the *status* channel; warning amber is a second, distinct swatch reserved
exclusively for the *severity* channel — the brief is explicit the two must never be visually
interchangeable (a warning callout must not read as a gate at a glance), which is why they're
different hex values in both modes, not the same brass reused. Danger red, by contrast, is
*intentionally* shared between the two channels ("bad" is one meaning whether it's an entity's state
or a message's severity) — the brief spells out why that reuse is fine while the amber split isn't:
gate brass and message-warning are two genuinely different meanings, so per the one-hue-one-meaning
rule they can't share a hue; failed-red and danger-red are the *same* meaning in both places, so
sharing is correct.

**Tokens** (assets/styles.css): a new `--warning` custom property, light `#96591C` / dark `#E2A25A`
— chosen deliberately distinct from `--gate` (`#8A6414` / `#C99A3C`) in both themes so the two ambers
can never be confused for one another even by inspecting the token values directly. Panel wash and
border derive the same way the gate treatment already does — `color-mix(in oklab, var(--warning) N%,
var(--panel)/var(--border-strong))`, never a hand-picked literal — so both themes stay correct by
construction, matching every other derived-not-hardcoded rule already in the stylesheet (`.gate__badge`,
`.chip.is-gate`, etc.). NOTE and DANGER need no new tokens: NOTE reads the existing `--fg`/`--border`/
`--fg-mute` neutrals, DANGER reads the existing `--danger` token the status palette already owns.

## `callout()` — the one primitive (src/board/components.ts)

`noticeWarning`/`alertIcon` are gone, replaced by `callout(severity, bodyHtml)` where `severity` is
`"note" | "warning" | "danger"`. It emits the same `<div class="notice notice--{severity}">` shape
`noticeWarning` already established (so the one already-approved call site's markup contract barely
moves — `notice--warning`'s class name is unchanged, which is why the pre-existing UI11 test for it
still passes verbatim), with a severity-specific vendored Tabler-style icon: `ti-alert-triangle`
(warning, reused verbatim from the old `alertIcon`), a new `ti-info-circle`-shaped icon (note), and a
new `ti-alert-octagon`-shaped icon (danger) — the octagon reuses the same exclamation-mark strokes
(`M12 9v4` / `M12 16h.01`) the triangle already used, matching how Tabler's own alert-icon family
shares that glyph across shapes, so danger reads as "the same kind of urgency, a harder shape" rather
than a visually unrelated icon. Body text is always the plain `notice__text` span — severity lives
in the wrapper class and the icon, never as inline color on the prose, in every one of the three
variants (this was already `noticeWarning`'s own discipline; `callout` just generalizes it across all
three severities instead of hardcoding it for one).

## Migration

Audited render.ts for every inline note/warning/danger-shaped block (grep for "note"/"caveat"/"heads
up"/"advisory" outside comments, plus every `<p`/`<div` literal near gate/status code) — the C13
connector note is the *only* one. This matches NOTES UI11's own conclusion when it went looking for a
second site: `doctor.ts`'s `health.warning` field is CLI-text-only (`doctor.ts:109`, untouched by
this goal — "CLI output unchanged" per the goal's own scope) and no board renderer (`railNav`'s
connector rows included) ever surfaces it. The orchestrator-unavailable popover
(`orchestratorIndicator`) and the disabled-panel message are informational asides with their own
established component shapes (`.orchind__pop`, `orchTurn`) predating this goal and not callout-shaped
in the first place — migrating them was out of scope and would have been unrelated churn. So the one
migration is: the C13 note's `noticeWarning(...)` call becomes `callout("warning", ...)` — gaining the
muted amber NOTES UI11 was forced to deny it.

## Test coverage

New `tests/board-ui12.test.ts`: `callout()` unit tests (three distinct classes, three distinct icon
paths, body text never carries severity styling inline); a CSS-source sweep asserting three separate
`.notice--*` rules exist, that only `.notice--warning` (and its icon) ever reads `var(--warning)`,
that `--warning` and `--gate` are different literal values in both `:root` and `[data-theme="dark"]`,
and that no `.chip`/`.dot`/`.snode`/`.gate*` status-palette rule ever reads `var(--warning)`; the C13
connector card renders `notice notice--warning` with its icon and an `auth: env` connector renders no
callout at all; and a "no board renderer emits a callout-shaped block except through the primitive"
sweep (render.ts never hand-builds a `notice notice--` literal, imports `callout` from
components.ts, and `components.ts` itself only ever emits the `notice notice--` string from inside
`callout()` — one occurrence of the literal in the whole file).

## Verification

`bun test` — 839 pass (+12 from the new file), 1 pre-existing skip, 0 fail, across 67 files (up from
827/66 pre-UI12). `bun run src/cli.ts replay fixtures/golden --stubs` matches
`fixtures/golden/expected.json` byte-for-byte (this goal touches board presentation only — the CLI
replay path and its oracle are untouched, so the byte-for-byte match is expected, not incidental).
`bun run deps:check` → `deps ok`.

**What could not be verified.** Same standing limitation as NOTES UI9/UI10/UI11: no browser/devtools
tooling in this sandbox, so the actual rendered contrast/legibility of the new `--warning` amber
against `--panel` in both themes is asserted from the token values and the `color-mix` derivation
formula (the same formula already trusted for gate brass), not from an observed render.

# NOTES REV1 — the schema must not promise what the runtime doesn't do

Three findings from the consolidated Claude+Codex review (`docs/code-review.md` lineage), all the
same species as F8 (native mocked, shipped), F11 (model declared, ignored), C14 (loop in fixture
only), DIST4 (worker dead in compiled) — a capability real in one mode, absent in another, with
nothing telling a user so.

## Finding 1 (CRITICAL) — every CLI command required the SDK installed, even offline ones

`src/cli.ts:16` had a top-level `import { runSdkWorkerFromStdin } from "./sdk-worker.ts"`, and
`sdk-worker.ts` has its own top-level `import { query } from "@anthropic-ai/claude-agent-sdk"`. ES
module imports execute at load time regardless of which command actually dispatches — so on a fresh
checkout with no `bun install` (no node_modules at all, or any environment where the SDK package
can't resolve), `levare validate`, `doctor`, and `context` failed before reaching their own logic with
`Cannot find module '@anthropic-ai/claude-agent-sdk'` — commands that never touch a model couldn't
run without the model vendor's package installed. Introduced by DIST5's `__worker` wiring.

**Fix:** the `sdk-worker.ts` import in `cli.ts#runCli` is now a dynamic `await import()`, made only
inside the `WORKER_COMMAND` (`__worker`) branch — the one place that ever actually needs the SDK.
Verified `sdk-transport.ts` (imported unconditionally by `cli.ts` for `WORKER_COMMAND`/`workerSpawnArgv`)
does NOT itself import the SDK package or `sdk-worker.ts` — it only resolves the worker's own file path
via `Bun.fileURLToPath` (a string operation, no module load) and probes the SDK's platform binary via a
scoped `createRequire(...).resolve(...)` call (a runtime, catchable resolution attempt, not a static
import) — confirmed by grep: `@anthropic-ai/claude-agent-sdk` and `sdk-worker` appear in
`sdk-transport.ts` only in comments/path-construction, never in an `import` statement. `board/serve.ts`
(also imported unconditionally by `cli.ts`, for `serve`) was checked the same way — its own import
chain (`orchestrator-boundary.ts`, `adapters.ts`) never imports `sdk-worker.ts` either, only
`sdk-transport.ts`'s non-SDK-importing surface.

**Test:** new `tests/cli-no-sdk.test.ts`. The cleanest honest simulation of "SDK unresolvable": copy
just `src/`, `assets/`, `docs/`, `fixtures/`, `package.json` into a scratch tmpdir with no
`node_modules` anywhere in or above it, and run `bun --no-install <scratch>/src/cli.ts <cmd>` from
there. `--no-install` is necessary and was discovered empirically — Bun's own runtime defaults to
`--install=auto` ("auto-installs when no node_modules"), so a bare "delete node_modules" scratch dir
silently self-heals by fetching the SDK from Bun's global cache/registry, masking the exact bug this
test exists to catch. `--no-install` is the honest equivalent of the described failure environments (a
fresh checkout in an offline CI runner, a locked-down registry, or `bun run` with Bun's own
auto-install disabled). Asserts `validate`/`doctor`/`context --dry-run` all succeed and never mention
the SDK package or "Cannot find module"; a companion test proves the premise itself — `__worker` (the
one command that DOES need the SDK) still fails there, with a genuine module-resolution error, never
"unknown command" and never a silent success. A second describe block proves the fix didn't regress
`WORKER_COMMAND` when the SDK IS installed, in source mode (`bun src/cli.ts __worker` against the real
repo) — the counterpart to `tests/orchestrator-compiled-smoke.test.ts`'s existing compiled-binary proof
of the same seam.

## Verification (finding 1)

`bun test` — 844 pass (+5 from the new file), 1 pre-existing skip, 0 fail, across 68 files (up from
839/67 pre-REV1). `bun run src/cli.ts replay fixtures/golden --stubs` matches
`fixtures/golden/expected.json` byte-for-byte. `bun run deps:check` → `deps ok`. `bun run build`
succeeds; the compiled binary's `__worker` subcommand still returns a worker-shaped response
(`{"ok":false,"error":"sdk worker: malformed request JSON..."}`), not "unknown command".

## Finding 2 — guardrails are declared, validated, rendered — and inert

`checkGuardrails` (`src/guardrails.ts:36`) has zero production call sites; its would-be enforcement
point is the merge phase, which `docs/prd-amendment-1.md` §2 (invariant 6) formally defers to v1.1:
"SPECIFIED, NOT IMPLEMENTED." The code is not forgotten — but nothing told a *user*. A Conductor
writing `protected_branches: [main]` today reasonably believed levare already blocked a matching
merge; it doesn't.

**Fix — the telling, not the enforcement** (no merge machinery was built; that stays out of scope,
v1.1's own work):

- `src/guardrails.ts` gains `hasDeclaredGuardrails(team: Team): boolean` — the one place that decides
  "does this team declare a non-empty guardrails block", shared by both surfaces below so they can
  never independently drift on the definition.
- `levare doctor` (`src/doctor.ts#formatDoctor`/`runDoctor`, new optional `guardrailsTeams` param,
  wired in `cli.ts#runDoctorCmd`): prints `⚠ guardrails are declared but not yet enforced —
  enforcement lands with the merge phase (v1.1): <team, team, …>` ahead of the connector report, for
  every team in the studio that declares guardrails.
- The registry's team card (`src/board/render.ts`) renders the same message via the canonical
  `callout("warning", …)` primitive (NOTES UI12's message-severity scale) — the same treatment the
  C13 subscription-connector note already uses — whenever that team declares guardrails.
- `levare validate` is unchanged: a team's guardrails block still validates exactly as before (this
  finding is about telling, not about rejecting a legal declaration).

**Test:** `tests/doctor.test.ts` — `formatDoctor`/`runDoctor` print the warning naming every given
team, print nothing when the list is empty or omitted (pre-REV1 callers unaffected), and the real CLI
against `fixtures/golden` (whose `kestrel` team already declares
`protected_branches`/`protected_paths`/`never`) names `kestrel`. `tests/board-render.test.ts` —
kestrel's registry card carries the warning callout; a synthetic team with no `guardrails:` field, or
an empty `{}` block, gets no callout.

## Verification (finding 2)

`bun test` — 850 pass, 1 pre-existing skip, 0 fail, across 68 files (up from 844/68). `bun run
src/cli.ts replay fixtures/golden --stubs` matches `fixtures/golden/expected.json` byte-for-byte
(this finding touches doctor output and board presentation only). `bun run deps:check` → `deps ok`.
`bun run build` succeeds.

## Finding 3 — `kind: remote` validates cleanly but is fully mocked

An agent declaring `kind: remote` passes validation and, if dispatched, gets a fixture response from
the mocked `RemoteBoundary` (`adapters.ts` documents this — no live MCP call exists anywhere in the
codebase). A studio author cannot tell that from the schema alone.

**Fix — the telling, not the capability** (no MCP wiring was built; that stays out of scope):

- `src/validate.ts` gains `ValidationWarning` (a type alias of `ValidationError` — same shape, used
  for a legal declaration whose runtime doesn't do what it promises, never an ok/not-ok verdict) and
  a `warnings: ValidationWarning[]` field on `ValidationResult`. `validateAgentRemoteNotice` (called
  alongside the existing `validateAgentVariant` for every agent) pushes a `REMOTE_NOT_IMPLEMENTED`
  warning naming the agent, for any `kind: remote` declaration — never rejecting it, since the
  declaration is legal.
- `levare validate` (`cli.ts#runValidate`) prints `valid` (exit 0, unchanged) followed by any
  warnings, using the same per-entry format errors already use.
- `levare doctor` (new `remoteAgents` param on `formatDoctor`/`runDoctor`, wired in
  `cli.ts#runDoctorCmd` from `repo.agents`) prints `⚠ remote members are not yet implemented — these
  will not produce real work: <agent, agent, …>` for every remote-kind agent in the studio — the same
  repeated-telling pattern as finding 2's guardrails line, in case a Conductor never re-reads
  `validate`'s own output.
- The registry's agent card (`src/board/render.ts`) renders the same message via the canonical
  `callout("warning", …)` primitive whenever that agent declares `kind: remote`.

**Test:** `tests/validate.test.ts` — a `kind: remote` agent validates `ok: true` with a
`REMOTE_NOT_IMPLEMENTED` warning naming it; a native/cli agent carries no such warning; the real CLI
prints the warning and still exits 0. `tests/doctor.test.ts` — `formatDoctor`/`runDoctor` print the
warning naming every given remote agent, print nothing when the list is empty or omitted (pre-REV1
callers unaffected), and the real CLI against a scratch studio (fixtures/golden plus one added
`kind: remote` agent) names it. `tests/board-render.test.ts` — a synthetic `kind: remote` agent's card
carries the warning callout; native/cli agents' cards carry none.

## Verification (finding 3)

`bun test` — 858 pass, 1 pre-existing skip, 0 fail, across 68 files (up from 850/68). `bun run
src/cli.ts replay fixtures/golden --stubs` matches `fixtures/golden/expected.json` byte-for-byte
(this finding touches validate/doctor output and board presentation only — no fixture agent declares
`kind: remote`, so the golden oracle is unaffected). `bun run deps:check` → `deps ok`. `bun run build`
succeeds.

## Overall (NOTES REV1)

All three findings share one species: a capability real in one mode and silently absent in another,
with nothing telling a user so. Finding 1 was the load-bearing fix (a genuine capability gap — the
CLI's own offline commands didn't run); findings 2 and 3 were pure telling fixes — no new enforcement
or MCP wiring was built, matching the goal's explicit scope. `bun test` — 858 pass, 1 pre-existing
skip, 0 fail, across 68 files (up from 839/67 pre-REV1, +19 net new tests across three files).
`bun run src/cli.ts replay fixtures/golden --stubs` matches the oracle byte-for-byte. `bun run
deps:check` → `deps ok`. `bun run build` succeeds; the compiled binary's `__worker` subcommand still
dispatches into the real worker.

# NOTES REV2 — writes must be atomic around commit failure, and startup must be ordered

Two findings from the consolidated review.

## Finding 1 — a mutation with no matching commit is an unaudited change

"Files are the truth + git is the audit log" (PRD §2, §9) means every on-disk mutation must be
answerable by a commit that recorded it. Before this fix, every mutating path wrote its candidate
content to disk, validated, and ONLY THEN committed — `writeFileSync` first, `conductorCommit`/
`runnerCommit` (which can throw: a rejected hook, a corrupt index, no resolvable identity) last, with
nothing to undo the write if that final step failed. `board/serve.ts`'s registry route already rolled
back on a VALIDATION failure (an existing `backup`/`writeFileSync` pair), but not on a COMMIT failure
— the exact gap the goal named. Every other mutating path (`board/gateops.ts`'s gate resolutions,
`dagwalk.ts`'s produce/block paths, `orchestrator.ts`'s unit operations, `daemon.ts`'s budget-gate
`stop`) had no rollback of either kind.

**Fix — one shared transactional write helper, `transactionalWrite` (`src/git.ts`):** captures the
original content of every file about to be touched (`null` when a path doesn't exist yet), writes the
candidate state, runs an optional caller-supplied `validate()` (deliberately AFTER the write — some
validators, like the registry route's `validatePath(root)`, re-derive the whole repo from disk and
need the candidate state already there to see it), then commits via the caller's own identity function
(`conductorCommit`/`runnerCommit`/a daemon-supplied override — the helper stays identity-agnostic). On
EITHER failure, it restores every touched file to its captured original (deleting any that didn't
exist) — AND resets the git index for those paths (`git reset --`), since `git add` may have already
staged the candidate content before `git commit` itself failed; left alone, that stale index entry
could ride along into a later, unrelated commit touching the same paths. A `TxFile.content: null`
candidate (not just an original-state capture) is also supported, for the one call site that commits a
deletion as part of its own transaction (`orchestrator.ts#promoteIdea`'s idea file, folded into the
same commit as the new unit it becomes).

Every mutating path now routes through it: `board/gateops.ts` (`doApprove`, `doReject`,
`doRescopeArtifact`, `doRequest`, `resolveBlockedArtifactGate`'s abandon/skip/retry branches),
`dagwalk.ts` (`blockUnit`, `produceOne`, `writeBlocked`), `board/serve.ts`'s registry save,
`orchestrator.ts` (`openUnit`, `captureIdea`, `promoteIdea`, `resolveProposal`,
`runNewProjectSkill`'s studio-side project-file write), and `daemon.ts`'s `pauseUnit` (the budget
gate's `stop` verb). `grep -rn writeFileSync src` now turns up only three sites outside `git.ts`
itself, all deliberately out of scope: `init.ts`'s founding-commit scaffold (a single whole-repo
first-ever commit — there is no prior *audited* state to roll back to, and `makeFoundingCommit` already
has its own documented "nothing committed, told loudly" failure story) and
`orchestrator.ts#runNewProjectSkill`'s `README.md` write into a FRESHLY CLONED, separate project repo
(not the studio root — a different repository's own bootstrap, committed via its own raw git calls,
never `conductorCommit`).

A subtlety only surfaced by the refactor: `board/gateops.ts`'s loop-companion cascade
(`applyLoopCompanionApproval`, C2/F16) used to write the companion artifact's approval DIRECTLY to
disk, ahead of the primary resolution's own write+commit — meaning a companion approval could land on
disk even if the primary resolution's validation later failed. It now returns the companion's
candidate `{ path, content }` instead of writing it, and the caller folds it into the SAME
`transactionalWrite` call as the primary write — one commit, one transaction, matching the goal's
"multi-file mutations as one transaction" requirement. This uncovered a real ordering bug during the
fix: when a loop's `until` names the CRITIC (so `doRequest`'s "second role" branch reassigns
`supersedeFile` to the round's AUTHOR artifact), the companion cascade's target and `doRequest`'s own
supersede target are the SAME file — naively concatenating both candidate writes let whichever was
last in the array clobber the other. Fixed by reading the companion's pending (not-yet-on-disk)
content as the supersede's "old source" when the paths collide, and writing that path exactly once.

**Tests** (`tests/git-transactional-write.test.ts`, `tests/orchestrator-daemon-transactional.test.ts`):
direct unit tests of `transactionalWrite` (success; a validate failure restores and never touches
HEAD; a commit failure — forced by corrupting `.git/index`, since `commitAs` already neutralizes the
goal's own suggested levers of identity/hook sabotage by always passing explicit `-c user.name=...`/
`-c core.hooksPath=/dev/null` overrides — restores a multi-file transaction byte-for-byte, including
deleting a file that didn't exist before). Byte-identical rollback proven for the three mutation shapes
the goal named: a gate approval (`spec-checkout-flow-v1` approve), a registry save (editing
`knowledge/house-style.md` through the board), and a dagwalk artifact write (starting `loyalty-flow`'s
satisfied start gate) — plus two of the additional paths the broader "every mutating path" fix reached:
`orchestrator.ts#promoteIdea` (multi-file, including the delete-candidate path) and
`daemon.ts#resolveBudget("stop")`.

## Finding 2 — the daemon's watcher started before the port was bound

`serve()` (`src/board/serve.ts`) called `daemon?.start()` (which opens a `work/` fs.watch) BEFORE
`Bun.serve` attempted to bind. A bind failure (port already in use) threw past that point with the
daemon's watcher already live and no handle ever returned to stop it — a failed startup that leaked a
running background watcher forever (the process either kept running with a headless watcher, or, if
the caller didn't crash outright, simply had no way to reach it via the `ServeHandle` that was never
returned).

**Fix:** construct (but do not start) the daemon, create the board, THEN attempt `Bun.serve` inside a
try/catch. On success, start the daemon. On failure, close the board (tearing down its own fs.watch/
SSE state) and rethrow — nothing is left running. No ordering here was load-bearing the other way (the
daemon watches `work/`, which cannot change meaningfully before the HTTP listener exists to serve
anything), so no daemon-before-bind case needed preserving.

**Test** (`tests/serve-bind-order.test.ts`): occupies an ephemeral port, then calls `serve()` against
that same port with a real (non-fixture) scratch studio — `Daemon.prototype.start` is spied to prove it
is never invoked when the bind throws.

## Verification (REV2)

`bun test` — 867 pass, 1 pre-existing skip, 0 fail, across 71 files (up from 858/68 pre-REV2, +9 net
new tests across 3 new files). `bun run src/cli.ts replay fixtures/golden --stubs` matches
`fixtures/golden/expected.json` byte-for-byte. `bun run deps:check` → `deps ok`. `bun run build`
succeeds.

# NOTES REV3 — paying the architecture debt (closing R3): shared flow semantics, the layering inversion, and typechecking in the gate

Three items from the consolidated architecture review.

## Item 1 — extracting the shared flow semantics (closing R3 properly)

R3 named the standing risk directly: `responsibleTeams`/`responsibleTeamsFor`, `untilSatisfied`, and
`resolveStep`/step-matching (`kindMatches`) existed as separately-maintained "independent copies" in
runner.ts, gates.ts, dagwalk.ts, and a fourth copy in validate.ts — every one of them commented with
the exact same justification: avoiding a circular import back to runner.ts. C14 (NOTES.md, above) was
the drift this produced once already: the Runner's batch walk and the live dagwalk walk disagreed on
when a loop's `until` condition was satisfied. `tests/loop-c14.test.ts`'s cross-engine equivalence test
contained the drift going forward but never removed the duplication itself — R3 stayed open.

**Fix:** `src/flow.ts` — a dependency-light leaf module that imports only `types.ts` and nothing that
could import it back. It holds `kindMatches`, `responsibleTeamsFor`/`responsibleTeamFor` (including the
unit `team:` override, ruling C12/F10), `resolveStep`, `unmetAfter`, and `untilSatisfied`. `FlowRepo` is
a structural subset of repo.ts's `Repo` (teams/types/units), described rather than imported — repo.ts
itself imports validate.ts, and validate.ts needs flow.ts, so importing `Repo` here would recreate the
exact cycle this module exists to end; every real `Repo` already satisfies the shape structurally, so
callers pass one through unchanged. `untilSatisfied` takes the artifact map directly (not a repo),
since the Runner's own per-run mutable map (`this.artifacts`, updated live as the batch walk produces
and approves artifacts) and the live walk's on-disk snapshot (`repo.artifacts`, reloaded before every
call) are not the same container shape, only the same shape of *value*.

`RunnerError` now lives in flow.ts (a plain zero-dependency `Error` subclass) and is re-exported from
runner.ts, which still uses it for its own broader error cases (budget/timebox/approval failures, not
just flow resolution) — moving the class didn't need to change any of its other call sites.

runner.ts, gates.ts, dagwalk.ts, and validate.ts (plus a fifth, unnamed-in-the-goal but structurally
identical copy in context.ts) now import from flow.ts instead of re-deriving it; every "independent
copy" comment and the code it justified is deleted (`grep -rn "independent copy" src/` now returns
nothing under the flow-semantics files — the one remaining hit, `board/gateops.ts`'s `blockedRetryDoc`,
is a document-formatting helper unrelated to flow resolution, out of this goal's scope). gates.ts keeps
`loopMembershipFor`/`isLoopCompanionKind`/`loopUntilKind` (gate-specific, built on top of flow.ts's
primitives) and `patchFrontmatter`/`upsertFrontmatterField` (unrelated frontmatter helpers); it now
re-exports flow.ts's functions for its own existing callers rather than redefining them.

**Verification:** `bun test` — 867/867 (up from 858 pre-REV3, no new tests added for this item — the
existing cross-engine equivalence test in `tests/loop-c14.test.ts` now proves the shared module serves
both engines rather than proving two copies agree, which is the stronger claim). `bun run src/cli.ts
replay fixtures/golden --stubs` matches `fixtures/golden/expected.json` byte-for-byte — the extraction
is byte-identical, as it must be for a pure restructuring. `bun run deps:check` → `deps ok`. `bun run
build` succeeds.

## Item 2 — the core→board layering inversion

`src/orchestrator-projection.ts` (core: the Orchestrator's deterministic studio view, ruling C10)
imported `board/derive.ts`, `board/extra.ts`, and `board/timeline.ts`; `src/dagwalk.ts` (core: the live
DAG walk) imported `board/locate.ts`. All four are pure derivation/lookup helpers over a loaded `Repo`
or the filesystem — no HTML, no HTTP, nothing UI-specific — needed by both the board's render path and
core. **Uncertainty recorded and resolved by judgment:** the goal named only `derive.ts` explicitly
("core, misfiled"); grep found orchestrator-projection.ts and dagwalk.ts also depended on `extra.ts`,
`timeline.ts`, and `locate.ts` for the identical reason. Moving `derive.ts` alone would have left the
boundary check (below) failing immediately on those three, so all four moved together, under the same
reasoning the goal gave for `derive.ts` itself.

**Fix:** `board/derive.ts` → `src/derive.ts`, `board/extra.ts` → `src/extra.ts`, `board/timeline.ts` →
`src/timeline.ts`, `board/locate.ts` → `src/locate.ts`. Every importer updated: `board/gateops.ts`,
`board/onboarding.ts`, `board/render.ts`, `board/status.ts`, `board/components.ts`,
`orchestrator.ts`, `orchestrator-projection.ts`, `dagwalk.ts`, and the tests that exercised any of
them (`tests/binding.test.ts`, `tests/board-render.test.ts`, `tests/f18/f19/f20-*.test.ts`,
`tests/loop-c14.test.ts`, `tests/extra.test.ts`, plus comment-only references in
`tests/board-serve.test.ts`/`tests/security-audit.test.ts`).

**The boundary check** (`tests/layering-boundary.test.ts`): scans every file directly under `src/`
(excluding `src/board/` itself) for an import from `src/board/`, and fails the build if it finds one
outside a small, named, commented allowlist. **Two pre-existing exceptions are allowlisted, not
fixed — recorded here rather than silently permitted by a loose check:**
- `cli.ts` imports `board/serve.ts` — the CLI entrypoint/composition root wiring the board's HTTP
  server into `levare serve`. This is ordinary top-down layering (the entrypoint depends on everything),
  not the R3 inversion (core reaching for board-owned derivation logic), so it stays as-is.
- `orchestrator.ts` imports `board/gateops.ts`'s `resolveGate` — the Orchestrator reuses the board's own
  gate-write API (the same commit path the board itself uses) rather than a second implementation of
  gate mutation. This is a real, pre-existing coupling between two non-board layers and *could* be seen
  as a milder version of the same inversion, but unwinding it means relocating gateops.ts's mutation
  surface (563 lines, HTTP/Daemon-coupled) out of board/ entirely — a materially larger, riskier change
  than this goal's named scope. Recorded honestly as deferred rather than silently exempted or papered
  over with a weaker check.

**Verification:** `bun test` — 869/869 (+2 for the boundary test). `bun run src/cli.ts replay
fixtures/golden --stubs` matches the oracle byte-for-byte (this item only moves files and updates
import paths — zero behavioural change). `bun run deps:check` → `deps ok`. `bun run build` succeeds.

## Item 3 — typechecking in the gate

No `tsconfig.json`, no typecheck script existed; Bun executes `.ts` without checking it, so a type
error only surfaces at runtime, if at all.

**tsconfig.json:** `strict: true`, plus `moduleResolution: "bundler"` + `allowImportingTsExtensions:
true` (this codebase imports with explicit `.ts` extensions throughout, matching how Bun itself
resolves them), `lib: ["ESNext", "DOM"]`, and `types: ["bun"]` (`@types/bun`/`bun-types` added as
devDependencies). **Why DOM lib, on a server-only Bun codebase:** without it, bun-types' own fallback
shapes for `Request`/`Response`/`Blob` degrade to a near-empty `{}` for methods like `.json()` (no DOM
lib present to provide the real `Body` mixin) — accounting for roughly 57 of the ~86 errors `strict`
alone surfaced. Including `DOM` gives `req.json()` etc. their real, precise types instead; the tradeoff
(pulling in unused browser globals like `window`/`document`) is harmless since nothing here references
them. **Flags evaluated and deliberately NOT enabled:** `noUncheckedIndexedAccess` was tried first and
alone added ~360 more errors (`array[i]` reads throughout the test suite going from `T` to `T |
undefined`) — a real category of rigor, but disproportionate to this goal's scope and exactly the "large
pre-existing count" the goal anticipated; deferred rather than mechanically silenced at hundreds of call
sites. `noImplicitOverride` was tried and added zero — folded in as effectively free... then dropped
again since nothing in this codebase uses class inheritance across module boundaries where it would
bite; omitted rather than enabled-and-inert. **Everything else `strict: true` implies is enabled, and
the full include set — `src/**/*.ts` AND `tests/**/*.ts` — passes at zero errors; no flag needed to stay
off to reach that, and no file needed excluding.** `src/assets.d.ts` declares the three ambient module
shapes Bun's `with { type: "file" }` asset imports need (`*.css`, `*.md`, and the one `*.js` asset
import) that bun-types doesn't ship declarations for itself.

**The ~25 errors `strict` (with DOM) surfaced were fixed, not laundered — none used `any`:**
- `board/gateops.ts`: a `TxFile.content: string | null` read as an unconditional supersede source —
  restructured into an explicit branch that throws a real, named error on the null (deletion) case
  instead of asserting past it; this was a genuine latent gap (a companion cascade that happened to be a
  deletion would have crashed inside `patchFrontmatter` with a confusing message instead of a clear one).
- `sdk-worker.ts`: `settingSources: [] as const` (a `readonly []`) didn't satisfy the SDK's mutable
  `SettingSource[]` — fixed with the SDK's own exported `SettingSource` type (`[] as SettingSource[]`).
- `tests/board-ui12.test.ts`: imported `Repo` from `types.ts`, which never exported it (it's `repo.ts`'s
  own interface) — a real broken import, silently tolerated only because nothing ran it through a
  compiler before. Fixed to import from `repo.ts`.
- `tests/orchestrator.test.ts`, `tests/runner.test.ts`: two synthetic-repo test fixtures were missing
  the `studio: StudioSettings` field `Repo` has required since NOTES F11 — added `studio: {}`, matching
  every other fixture in the suite.
- `tests/native-sdk-boundary.test.ts`: an `agent()` test-fixture helper never set `produces` (an
  `Agent`-required field) at all, so its one caller built an `Agent` with `produces: undefined` at
  runtime, silently — a real fixture gap, not just a type annotation gap. Added `produces: ["design"]`.
- Several `spawnSync`/`Bun.spawn` return values typed via `ReturnType<typeof spawnSync>` /
  `ReturnType<typeof Bun.spawn>` — a known TS gotcha where `ReturnType<>` of an overloaded function
  picks a default/last overload rather than the one the concrete call actually resolves to (here,
  `Buffer`-flavored instead of the `string`/`"pipe"`-flavored result the call's own options produce).
  Fixed with explicit `SpawnSyncReturns<string>` / `Bun.Subprocess<"ignore", "pipe", "pipe">`
  annotations naming the real shape.
- The remaining dozen or so were narrow, genuine `strict`-null-checking gaps in test assertions
  (`process.env.X` is `string | undefined`; `resolveNativeBinary()` is `string | null` where production
  code itself already normalizes with `?? undefined`, at `adapters.ts:133,157` — tests now do the same;
  a `selectOrchestratorBoundary(...)` result used without the `expect(...).not.toBeNull()` +
  `boundary!` pattern the same file already established at its other call sites, applied consistently
  here too) — each fixed with the same non-null-assertion/coalescing idiom already in use elsewhere in
  the same file, not introduced fresh.

**package.json:** `typecheck: "bunx tsc --noEmit"`; `typescript` and `@types/bun` added under
`devDependencies` only (never `dependencies` — `deps:check` only inspects `dependencies`, and stays
`deps ok` unchanged, confirmed). **ci.yml:** `bun run typecheck` added to the `test` job, between `bun
test` and `bun run deps:check`.

**Verification:** `bun run typecheck` (`bunx tsc --noEmit`) exits 0 across the full `src/**/*.ts` +
`tests/**/*.ts` include set. `bun test` — 869/869, 1 pre-existing skip. `bun run src/cli.ts replay
fixtures/golden --stubs` matches the oracle byte-for-byte (every fix in this item is either a type
annotation or a narrow, behavior-preserving guard — none change what any code path does with valid
input). `bun run deps:check` → `deps ok`. `bun run build` succeeds; the compiled binary's own
`validate`/`--version` still work (asset embedding is unaffected — `.d.ts` files are compile-time only).

## Overall (NOTES REV3, closing R3)

`bun test` — 869 pass, 1 pre-existing skip, 0 fail, across 72 files (up from 858/68 pre-REV3, +11 net
new tests: 2 from the layering-boundary check, the rest incidental to fixture repairs). `bun run
typecheck` passes and runs in CI. `bun run src/cli.ts replay fixtures/golden --stubs` matches
`fixtures/golden/expected.json` byte-for-byte — the non-negotiable proof that none of the three items
changed any runtime behavior. `bun run deps:check` → `deps ok`. `bun run build` succeeds. R3 is closed:
`grep -rn "independent copy" src/` finds nothing under the flow-semantics files; `src/flow.ts` is the
one shared definition; the core→board import direction is enforced by a test, not just a convention.

## NOTES DOCS1 — Auto-generated entity cheatsheets

Motivation: the hand-written registry-entity reference (`docs/guide/05-reference/02-registry-entities.md`)
took three attempts to get accurate because it was written from memory, and drifts silently whenever a
schema changes underneath it. `REGISTRY_SCHEMAS` (plus `ARTIFACT_SCHEMA`/`WORK_UNIT_SCHEMA`/
`STUDIO_SCHEMA`, all in `src/validate.ts`) is already the single source of truth `levare validate`
itself enforces — the cheatsheets are a pure walk over that same data, so they cannot drift from what
the validator actually does.

**Exports (src/validate.ts):** `Schema`/`FieldSpec` (previously unexported internal types) and
`ARTIFACT_SCHEMA`/`WORK_UNIT_SCHEMA`/`STUDIO_SCHEMA` (previously unexported consts) are now exported,
alongside the already-exported `REGISTRY_SCHEMAS`. No behavior changed — this is additive visibility
only, confirmed by the full suite passing unchanged.

**Generator (`scripts/generate-cheatsheets.ts`, `bun run docs:generate`):** walks 12 schemas (the 9 in
`REGISTRY_SCHEMAS` + artifact + work-unit + studio) and emits one markdown file per entity into
`docs/guide/05-reference/cheatsheets/<schema.name>.md`. Per file: a one-line description, a field table
(field/type/required/nullable/enum, plus one-level-flattened map subfields, plus a removed-fields
section when `schema.removed` is non-empty — all mechanically derived from `FieldSpec`), a minimal valid
skeleton, a one-line "body is for" note, and a "generated, do not edit by hand" footer.

Exactly two hand-maintained one-line maps exist in the generator (`DESCRIPTIONS`, `BODY_PURPOSE`) — the
one editorial element the schema cannot express. The `BODY_PURPOSE` lines were verified against actual
body-reading call sites (`src/context.ts`'s `readEntityBody`, `src/derive.ts`'s `firstParagraph`,
`src/board/render.ts`'s `renderBody`, etc.), not guessed — several entities (connector, type, studio,
work-unit, eval) turned out to have no meaningful body semantics at all, which the cheatsheet says
plainly rather than inventing one.

**Skeleton honesty, proven not asserted:** rather than hand-encoding which fields are ADDITIONALLY
required per variant (e.g. a `kind: native` agent needs `model`, a `kind: cli` agent needs `command` +
`result`; a connector's `env` is required only when `auth: env`) — which would be exactly the kind of
duplicated, driftable fact this whole feature exists to eliminate — the generator builds a candidate
from `FieldSpec.required` fields only, then **runs the real `validatePath`** against it in a scratch
studio, and self-heals: any `MISSING_FIELD` error's field name (extracted generically from the last
single-quoted token in the message — both the schema-level and the `validateAgentVariant`-level
messages quote the field name last) is looked up in the schema and filled with a type-appropriate
placeholder; `EMPTY_PRODUCES`/`EMPTY_ENV` (the two "declared non-empty" checks a `required: true` on a
`str[]` can't express) are recognized by their real, exported error codes and re-filled. If either code
is ever renamed in `validate.ts`, this fix silently stops firing and the skeleton-validates test below
fails immediately, naming it. One deliberate non-generic exception: a `model`/`orchestrator_model`
placeholder uses a real baseline id (`claude-sonnet-5`, from `pricing.ts`'s `BASELINE_PRICING`) rather
than an arbitrary string, since `validateKnownModels` would otherwise reject any placeholder.

**Drift + honesty tests (`tests/cheatsheets.test.ts`):** (1) a fresh `generateAll()` is asserted
byte-identical to every committed file — a schema change without regenerating fails with "schemas
changed: run `bun run docs:generate`"; a construction test proves this comparison actually distinguishes
a real diff (mutates one generated byte and re-asserts). (2) two consecutive generations are asserted
identical (determinism). (3) every generated skeleton is written into its own fresh scratch studio and
run through the real `validatePath` — asserted `ok: true, errors: []` for all 12 entities.

**CI (`ci.yml`):** the drift test above already runs inside the existing `bun test` step; an additional,
more human-readable explicit step regenerates and `git diff --exit-code`s the cheatsheets directory
directly, so a CI failure here reads as "the committed docs are stale" rather than a generic test-name
failure.

**Integration:** `docs/guide/05-reference/README.md` gains a table row linking `cheatsheets/`;
`02-registry-entities.md` gains a one-paragraph pointer at the top to the generated cheatsheets — the
prose file itself is untouched otherwise, remaining the home of cross-entity rules (flow shapes, the
lifecycle, connector auth/env agreement) that aren't single-field facts.

**Uncertainty recorded, not asked about:** the field table intentionally omits a "Default" column even
though the goal text lists one — `FieldSpec` (the schema data itself) carries no `default` metadata
anywhere; the actual defaults (`context_via: arg`, `pace: auto`, `auth: env`, …) live scattered across
`repo.ts`/`adapters.ts`/`runner.ts`, disconnected from `validate.ts`. Encoding them as a second,
hand-maintained fact on `FieldSpec` — one no runtime code path would ever read, so nothing would catch
it going stale — would recreate exactly the drift problem this feature exists to close. Per the hard
rule ("if a fact is not derivable from the schema, it does not go in the cheatsheet"), it's omitted;
required/nullable/enum are the facts `FieldSpec` actually encodes, and only conditional/variant
requirements are shown, indirectly, via the skeleton (whose extra fields are proof, not narration, that
a variant needs them).

**Verification:** `bun test` → 874 pass, 1 pre-existing skip, 0 fail (73 files; the 8 environment-only
failures observed mid-session — missing native SDK binary / no `ANTHROPIC_API_KEY` on this sandboxed
linux-arm64 devcontainer — were confirmed pre-existing via `git stash` on the unmodified tree, and
disappeared once the sandbox's own missing platform package was installed locally; nothing under this
item touches that code path). `bun run docs:generate` twice in a row produces byte-identical output.
`bun run typecheck` → exit 0. `bun run deps:check` → `deps ok` (the generator imports `src/validate.ts`
directly at dev time; no new runtime dependency). `git diff --exit-code` on `cheatsheets/` after
regenerating → clean.

# NOTES REV4 — the review's low-priority batch: four small structural/naming cleanups, byte-identical throughout

Four items from the consolidated review's low-priority batch. All are refactors or docs — no runtime
behaviour changes anywhere in this revision; every item's own verification proves it independently, and
`bun run src/cli.ts replay fixtures/golden --stubs` matching the oracle byte-for-byte is the load-bearing
proof common to all of them.

## Item 1 — splitting render.ts by screen

`src/board/render.ts` had grown to ~1290 lines/41 functions: all six screens (studio, project, run,
artifact, idea, registry) plus the shell/rail/gate-card/Orchestrator-panel plumbing they all share, in
one file.

**Fix:** `src/board/render/` — `shell.ts` holds everything genuinely shared across two or more screens
(the `<html>` shell, `appHeader`, `pageBody`, the Orchestrator panel, `railNav`, `gateCardHtml` and its
dispatching helpers, avatar/kind-badge/token-link helpers, `projectStatusChip`, and the markdown-body/
lineage-empty helpers `renderArtifact`/`renderIdea` both need); `studio.ts`, `project.ts`, `run.ts`,
`artifact.ts`, `idea.ts`, `registry.ts` each hold exactly one screen's `render*` export plus whatever
helper was ONLY ever called from that one screen (`runningNowHtml` → studio.ts, `miniScoreHtml` →
project.ts, `scoreNodeClass` → run.ts, `lineageItem`/`lineageUnresolved` → artifact.ts, `entityBlock`/
`rawFor`/`rawForPath` → registry.ts) — moved to the screen that uses it rather than left in the shared
file, so each screen module only imports the shared surface it actually touches instead of sharing one
1290-line scope.

**`render.ts` becomes a thin re-export barrel**, not a fully-updated import graph, and this was a
deliberate choice, not the default: `board/serve.ts` and thirteen test files import multiple screen
renderers from `"../src/board/render.ts"` (some by a dozen distinct symbols across a file). Updating
every one of those call sites to per-screen paths would touch ~14 files for a cosmetic path change and
add real risk of a missed/misspelled import, for a codebase where nothing about the import graph was
actually wrong (`serve.ts` importing "the board's render layer" from one place is exactly right — it's
render.ts's own INTERNAL shape that was the problem, not who imports it externally). The barrel keeps
every external call site byte-identical; the "cleaner graph" the goal asked for is inside `render/`
itself, where the split actually happened.

**Two source-text tests (`tests/board-components.test.ts`, `tests/board-ui12.test.ts`) read
`src/board/render.ts` as a string** to assert absences ("no hand-rolled `.chip` literal", "no re-derived
`notice notice--` block", "`gate__top` appears exactly 3 times") — with render.ts now a 20-line barrel,
reading only that file would make every one of those assertions vacuously true regardless of what the
split-out files actually contain, silently defanging tests whose entire purpose is catching a
regression. Both now build `RENDER_SRC` from the barrel PLUS every file under `render/` (concatenated),
preserving the tests' real assertion power; two of the barrel-relative-import checks (`from "./components.ts"` literally) were loosened to accept either `./` or `../`, since `render/*.ts` sit one
directory deeper than the old render.ts and their real, correct import is `"../components.ts"`.

**Verification:** `bun test` — 874 pass (up from 871 pre-split — no tests removed, two updated for the
new file layout, none weakened in what they assert). `bun run typecheck` → exit 0. `bun run src/cli.ts
replay fixtures/golden --stubs` matches `fixtures/golden/expected.json` byte-for-byte. A direct
before/after spot-check (`git stash` the split, render all six screens against the golden fixture at a
fixed clock, `git stash pop`, render the same six again) diffed byte-identical — studio, project, run,
registry, one artifact (`spec-checkout-flow-v1`), and one idea (`loyalty-program`). `tests/layering-
boundary.test.ts` (REV3) still passes unchanged — `render/` sits under `src/board/`, so it's on the
board side of the boundary the same as render.ts always was. `bun run deps:check` → `deps ok`. `bun run
build` succeeds.

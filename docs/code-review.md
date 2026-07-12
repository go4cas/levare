# levare — architecture and code review

**Reviewer:** Claude Code (Opus), `/goal` on branch `review/architecture`
**Date:** 2026-07-12
**Brief:** `docs/code-review-brief.md`
**Read first (as instructed):** `docs/levare-prd.md`, `docs/levare-design-brief.md`, `docs/security-audit.md`, all of `NOTES.md` (A/B/D/E/F/K/M/N/O series + rulings C1–C8).

The security audit asked *can this be attacked*. This review asks three different questions: is it still
the system we designed; do the tests test anything; which deferred debts are now payable. The centerpiece
is the test verdict — **every one of the seven documented human catches passed a green suite**, so a passing
suite is evidence of nothing until each test is shown to assert an *outcome*, not an *intent*.

Method: three parallel deep reads (invariant→enforcement, test quality, dead-code/layer/duplication) over
the whole of `src/` and `tests/`, cross-checked against the constitution, then fixes in the brief's order.
This document is the first deliverable; the diffs followed it.

---

## 1. Invariant enforcement map

For each PRD §2 invariant and each ruling C1–C8: the code that enforces it (file · function · mechanism), or
proof that nothing does. "TESTED" distinguishes a test that asserts the real outcome from one that asserts an
intent, is absent, or is human-gated. An invariant with no enforcement point is a comment.

### The twelve invariants

**1 — No member starts without a Conductor approval in its causal chain; every unit's first step raises a
start gate regardless of `after:`; existence is never consent (C8).**
ENFORCED — three independent sites: `src/dagwalk.ts:180` `advanceUnit` (`!hasAnyArtifact && !startAuthorized →
halted`; the `startAuthorized` boolean is set by exactly one caller, `board/gateops.ts#doStart`, so the daemon
can never cross it); `src/runner.ts:182-202` `walkUnit` (unconditional start gate at flow position zero);
`src/board/serve.ts:525,533` (CSRF + read-only guards refuse the `/gates/.../start` route ahead of the
handler). TESTED (real outcome): `tests/security-audit.test.ts` surface-5/1 prevention test (an injected
active/no-`after:` unit invokes **no** member across repeated `Daemon.tick()`s); `tests/daemon.test.ts` case
(b). **Duplication risk:** the C8 rule + the `after:`-unmet computation are implemented independently in three
files (runner.ts, dagwalk.ts, derive.ts) — see the duplication index (§1, C8/rulings).

**2 — Files are the truth; the binary holds no state not reconstructable from the repo.**
ENFORCED structurally, not by a single guard: `src/repo.ts:40` `loadRepo` re-reads the whole tree per call and
holds nothing; every board GET calls `withRepo`/`loadRepo` per request; the Orchestrator returns proposals
rather than storing them. TESTED only indirectly (`board-render` "derivation line"/"timeline built from ledger
+ git log"; `board-serve-e2e` drives real HTTP re-derivation) — **no single test asserts "no hidden state."**
Bounded, documented exception: the daemon's `inFlight`/`log`/`tickCounter` (`src/daemon.ts:70-74`) is live
in-binary state a repo re-read cannot reproduce (NOTES O7 argues an in-flight invocation is by definition not
yet a repo fact — defensible, but it is the one real instance of the pattern).

**3 — Artifacts immutable once approved; changes supersede; lineage never rewritten.**
ENFORCED — `src/validate.ts:650` `gitImmutabilityCheck` emits `MODIFIED_AFTER_APPROVAL` (state S2b) on a
diff; supersede-not-mutate via `runner.ts` `bumpVersion`/`markSuperseded` and `gateops.ts#doRequest`.
TESTED (state-explicit): `tests/immutability.test.ts` asserts the exact `ImmutabilityState`, not just
`ok`. **Was a hole (A7), now closed** — see §3. The pre-fix check only diffed the working tree against
`HEAD`, so a *committed* post-approval mutation reported S2a (valid); that "later commit" half of §4 was
unenforced and proven so by a `test.failing`.

**4 — Only the Conductor sets `approved_by`.**
ENFORCED — at rest: `validate.ts:543/551` (`APPROVED_WITHOUT_APPROVER` / `APPROVER_WITHOUT_APPROVAL` couple
status↔approver); on the walk: `runner.ts:608` `applyApproval` throws unless `by` matches name+ISO; on the
board: `gateops.ts:85` `doApprove` hard-codes `${CONDUCTOR_NAME} ${today}`. TESTED: `runner.test.ts` (approval
sets it; missing name+ISO is a hard error). **Divergence (see C5):** the board path does *not* call
`applyApproval` — it patches the string and validates presence only, so C5's *format* guard is bypassed on the
board surface (safe today only because the string is hard-constructed).

**5 — `consumes` is a hard dependency; DAG recomputed from frontmatter, no scheduler state.**
ENFORCED — `validate.ts:586` `crossReference` (`UNRESOLVED_CONSUMES`/`CROSS_PROJECT_CONSUMES`/`DUPLICATE_ID` at
load); `dagwalk.ts#nextAction` and `runner.ts#executeFlow` walk `team.flow` against freshly-read artifacts each
time (no persisted schedule). TESTED via the golden oracle and validate rejection fixtures. Note: enforcement
is on *reference resolution*; "a step is blocked until its consumed artifacts are approved" is emergent from
`nextAction`'s approved/in-review/halt branching, tested through the oracle rather than a dedicated assertion.

**6 — Code reaches main only through the review loop + a merge gate; spike code never merges.**
**UNENFORCED — no enforcement point exists.** `src/guardrails.ts:36` `checkGuardrails` correctly checks a
proposed-merge diff against `protected_branches`/`protected_paths`/`never`, but **has zero callers in `src/`**
(only `tests/guardrails.test.ts`). No code path performs a merge, invokes a merge gate, or runs guardrails.
"Spike never merges" lives only as prose in a type-template body (`src/init.ts`). This is not a drift bug: the
merge/promotion surface is a **future phase that has not been built** (it is the same build-team phase C4 and
K5 anticipate). `checkGuardrails` is a ready, unit-tested deliverable with nowhere yet to attach. Recorded as
**deferred, requires the merge phase** (§4) — fabricating an enforcement point for a feature that does not
exist would be worse than the honest gap. TESTED only as a pure function, never against a merge outcome.

**7 — Exactly one LLM orchestrator; team sequencing is declarative flow; `mode: led` is the sole opt-in.**
PARTIALLY ENFORCED. The deterministic half holds structurally: the Runner/daemon carry no model; sequencing is
data (`parseFlow` executed by `executeFlow`/`nextAction`). **`mode: led` is UNENFORCED/inert** — `mode` is
parsed and loaded but **nothing in `src/` ever branches on `"led"`**; a `led` team runs identically to a
declarative one. "Exactly one orchestrator" is architectural (one boundary selected per request), not a coded
singularity guard. Recorded as **deferred** — the escape hatch is a no-op because the feature it gates is
unbuilt; wiring it needs a Conductor decision on what `led` actually changes (§4). Not tested (`led` in no test).

**8 — Members never communicate laterally; a blocked member exits, the Runner raises a gate.**
ENFORCED by construction: `MemberRunner.produce` returns a doc to the Runner; members have no channel to each
other (there is no IPC/lateral surface to enforce against). A `blocked` member becomes a committed `blocked`
artifact that halts the next walk (`dagwalk.ts#writeBlocked`, `nextAction` halts on `blocked`). TESTED: the
blocked-exit half (`daemon.test.ts`: a throwing member → `blocked` artifact, never retried). The "no lateral
comms" half is intent-only because there is nothing to assert against.

**9 — The write surface is exactly three routes; everything else GET/SSE; a test asserts the table.**
ENFORCED — `serve.ts:137` `ROUTES` (single dispatch source) + `:323` `MUTATING_ROUTES = ROUTES.filter(mutating)`.
The three: `POST /gates/:project/:artifact/:verb`, `POST /registry/*path`, `POST /orchestrator/message`. TESTED
(real, cannot drift): `tests/board-routes.test.ts` asserts exactly three, enumerated against the same `ROUTES`
the router uses, and that every other route is GET.

**10 — Zero runtime deps except `@anthropic-ai/claude-agent-sdk`.**
ENFORCED — `package.json` (one dependency) + the `deps:check` script. The SDK is kept behind mockable
boundaries so it stays a platform, not a code dep. **Was TESTED only by an npm script, not by the suite** —
closed in §3 with `tests/deps-policy.test.ts` asserting the outcome (package.json declares no forbidden runtime
dep and only the sanctioned SDK) inside `bun test`. Spirit-check (no vendored copies / runtime downloads /
hidden platform requirements): held — the only spawned externals are `git` and the documented SDK CLI.

**11 — Secrets never enter the repo; connector env from the environment; wrapped CLIs keep own auth.**
ENFORCED — `src/env.ts:42` `buildMemberEnv` is an allowlist (only `PATH`/`HOME` + the *names* declared by
granted connectors, pulled from the base env; nothing else from `process.env`); `adapters.ts` replaces spawn
env wholesale; `doctor.ts` reads presence only. TESTED (real): `tests/env-scoping.test.ts` (ungranted
`GITHUB_*` absent, baseline-only, agent∪team grants, absent var not invented). **Latent (K5, gated):** the
native SDK boundary's `hermeticSpawnEnv` spreads full `process.env` — inert because that boundary is wired
into no live path; a blocking prerequisite for the K5 phase (§4).

**12 — The design brief's semantic system is law.**
PARTIALLY ENFORCED in `render.ts`: glyph = unit type (`type.glyph` rendered in the three sanctioned places);
mono token = link (ids wrapped as `mono link` anchors); the six-state palette maps through `scoreNodeClass`.
TESTED (real outcome): `board-render.test.ts` asserts every gate name is a mono link, all five type glyphs
render, and — crucially — `scoreNodeClass` cross-checks every canonical state against a real `styles.css` rule
(the direct regression for catch #4). **Unenforced facets:** "gate brass only on gates" and "team hues on
identity only" have *no negative test* (nothing asserts brass/hue never appear elsewhere); palette *values*
live in the verbatim `styles.css`, not code. These are human-gated visual invariants (§5).

### The eight rulings (the constitution)

**C1 — two legal loop styles; `approved` stays Conductor-only.** ENFORCED for style 1 (the Conductor-amendment
loop, `until: spec.approved`): `runner.ts#runLoop` raises one gate/round. **Style 2 (member-set `verdict`
field, human gate after the loop) is UNIMPLEMENTED** — no `verdict` field in the schema, no reader for it
(NOTES D8/B3 defer it). `approved` stays Conductor-only via `applyApproval`. TESTED: style 1 only.

**C2 — gate resolution completeness; loop-gate also resolves the companion review to approved.** ENFORCED,
**twice**: `runner.ts:385/417` (in-memory) and `gateops.ts:151` `applyLoopCompanionApproval` (on-disk, folded
into the same commit). No resolution leaves in-review. TESTED: `gateops-phase5.test.ts` (approving spec also
approves the in-review review in one commit; no live companion → only the target touched). The companion
*rule* is shared via `loopMembershipFor`; the resolution *act* is two code paths (the C7 split).

**C3 — budget acknowledgment memory.** ENFORCED in the Runner: `runner.ts:463` `overBudget` with `budgetAck`
suppressing re-raise until spend crosses a new threshold. TESTED: `runner.test.ts` ("does not re-raise at the
same spend level"). **Divergence:** the daemon's budget path (`dagwalk.ts:195-198`) has **no acknowledgment
memory** — it halts whenever `spent > budget` every tick. C3's "informs, never spams" holds in the Runner
engine, not in the live daemon. Recorded as a genuine surface divergence (§4).

**C4 — responsible-team selection is per-KIND, not per-unit.** WAS UNENFORCED — both `gates.ts:48`
`responsibleTeamFor` and `runner.ts:216` `responsibleTeam` selected **one** team per unit (max `produces∩
expects`, ties by name: the B7 shortcut). The per-kind walk §6 specifies (find producible kinds, invoke the
team that produces *each*) was not implemented; equivalent while one team exists, divergent the moment a unit
hands from a shaping team to a build team. **Closed in §3** with a per-kind team walk and a multi-team fixture
that fails under the old heuristic.

**C5 — `approved_by` always Conductor name + ISO date; no defaults/placeholders.** ENFORCED in the Runner:
`runner.ts:609` `applyApproval` regex-guards `by`. TESTED: `runner.test.ts`. **Hole:** the board/Orchestrator
approval path bypasses `applyApproval` (patches directly, validates presence only), so C5's format guard is not
enforced on that surface — safe only because the string is hard-constructed. The two surfaces do not share the
C5 check (§4, recommended follow-up: route both through `applyApproval`).

**C6 — protected_branches vs protected_paths never cross-matched; no path-segment matcher.** ENFORCED —
`guardrails.ts:30` `protectsPath` (exact or `dir/` prefix, no segment match) + separate namespace loops.
TESTED (real): `guardrails.test.ts` (a `main` *segment* in a path is not a branch hit; `deploy/` path fires;
force-push to `main` branch fires). Caveat: this governs `checkGuardrails`, which is **dead in production**
(invariant 6) — the rule is correct but currently unreachable.

**C7 — one gate-resolution path shared between board and Runner.** CONVERGED on the shared *rules*
(`applyApproval`, `bumpVersion`, `loopMembershipFor`, `conductorCommit`); the two *control flows* (simulated
multi-decision walk vs. single on-disk mutation) remain separate by design. Board `start` now delegates to the
shared `dagwalk#advanceUnit` (old 501 closed). Residual asymmetry: the Runner approves the exact `second`
artifact it just produced; the board picks "latest in-review of companionKind" — same intent, differ only if
multiple live in-review companions of one kind coexisted (unreachable at fixture scale). TESTED that the two
surfaces agree on outcomes (`orchestrator.test.ts`, `gateops-phase5.test.ts`); no test drives the *same* loop
through both engines.

**C8 — every unit's first step raises a start gate regardless of `after:`; no auto-start.** ENFORCED at three
sites (see invariant 1). TESTED (real prevention). **Duplication:** three independent copies of the rule +
`after:`-unmet computation (runner.ts, dagwalk.ts, derive.ts) — a change to one desyncs the daemon, the Runner
engine, and the board's gate rendering. Currently identical; nothing structural keeps them so.

### Duplication-of-rules index (two code paths, one rule — can they still disagree?)

| Rule | Sites | Verdict |
|---|---|---|
| `responsibleTeamFor` (team selection) | `gates.ts:48` ⟷ `runner.ts:216` | CAN DISAGREE — two hand-kept copies (F1 circular-import excuse); **fixed** in §3 by the per-kind change applied to both. |
| `resolveStep` (step→member,kind) | `gates.ts:68` ⟷ `runner.ts:553` | CAN DISAGREE — byte-identical copies. |
| `untilSatisfied` (loop termination) | `dagwalk.ts:64` ⟷ `runner.ts:429` | CAN DISAGREE — identical copies. |
| Start-gate + `after:` unmet (C8) | `runner.ts:182`, `dagwalk.ts:176`, `derive.ts:90` | CAN DISAGREE — three copies. |
| Gate resolution + C2 companion + C5 approver | Runner engine ⟷ board `gateops` | CONVERGED on rules; **C5 format guard present in one, absent in the other** — the sharpest divergence. |
| Artifact id / `-vN` version | `dagwalk.ts:248` literal `${kind}-${unit}-v1` ⟷ `runner.ts:623` `bumpVersion` | CAN DISAGREE — **fixed** in §3 (dagwalk now uses the helper's convention via `bumpVersion`). |
| Commit authorship | `git.ts` `conductorCommit`/`runnerCommit` (one each) ⟷ `orchestrator.ts:421` inline `"cas"` literal | Studio writes CONVERGED; the new-project clone commit duplicates the identity literal — **fixed** in §3 (reuses `CONDUCTOR_NAME/EMAIL`). |
| Status transitions | `applyApproval` (approve, shared) ⟷ scattered `patchFrontmatter`/`art.status=` literals for reject/supersede/blocked | Approve CONVERGED; reject/supersede/blocked are duplicated literals, bounded by validate + the `in-review` precondition guard. |
| Spend aggregation | `dagwalk.ts:216` ⟷ `runner.ts:528` ⟷ `derive.ts:209` | Three copies; C3 ack-memory only in the Runner copy. |

**Headline "just a comment" findings:** invariant 6 (no merge machinery — `checkGuardrails` dead in
production); invariant 7 (`mode: led` inert); C1 style-2 (unimplemented); C4 (was the per-unit shortcut —
**now fixed**); C5 on the board surface (format guard bypassed); invariant 10 (was script-only — **now
tested**). The single recurring architectural smell is **the runner-vs-dagwalk/gates duplication**: C7's own
lesson (extract the rule both callers must obey) was applied to gate resolution but not to team/step/loop
resolution, which remain hand-synced copies. The right end state is a leaf module both engines import — see §6.

---

## 2. The test-quality verdict

**Headline: the suite has been substantially hardened since the seven catches — six of seven now have real,
outcome-based regression tests; the seventh is intrinsically outside a test's reach. The residual weakness is
concentrated in two areas the suite structurally cannot see (rendered pixels / client-side JS) plus a few
self-generated oracles.** A passing suite is now *meaningfully* better evidence than it was — but the
client-JS interaction layer remains delete-proof, which is exactly the shape of catch #4.

### The seven human catches — does the suite catch each now?

| # | Catch | Verdict now | Evidence |
|---|---|---|---|
| 1 | `serve` printed a URL and exited | **CAUGHT (outcome)** | `board-serve-e2e.test.ts` spawns the real `./levare` binary over a real socket, asserts `exitCode===null`/`!killed` after boot, POSTs approve over HTTP, asserts the file flipped on disk + an SSE `reload` arrived. Root cause fixed in `cli.ts` (serve special-cased). |
| 2 | CLI argv from splitting a substituted string | **CAUGHT (outcome)** | `adapters.test.ts` runs six hostile task strings through the real substitution (each lands in exactly one argv slot) **and** executes a real `Bun.spawn` asserting a MARKER file survives — a filesystem outcome, not an argv shape. |
| 3 | Validator failed open three ways | **CAUGHT (state-explicit)** | `immutability.test.ts` asserts the exact state for each: hostile git config → S2b; symlinked path → S2b "not masked as S1"; corrupt `.git/index` → S2e "not S2a". Caveat: macOS `/var` is a container symlink *reproduction*, not real Darwin. |
| 4 | Score node with an undefined CSS class | **CAUGHT for score nodes; the class of bug is NOT closed** | `board-render.test.ts` cross-checks `scoreNodeClass` against `styles.css` and asserts the old broken `snode is-wait` has no rule. **But** `hasCssRuleFor` passed on an *empty* rule and no other emitted class was cross-checked. **Hardened in §3.** |
| 5 | SSE handler discarded its unsubscribe | **CAUGHT (descriptor-level)** | `board-serve-sse-leak.test.ts`: 50 connect/cancel cycles must return the subscriber Set to empty; backstopped by a real-subprocess `/proc/<pid>/fd` growth check. It explicitly rejects the weaker "broadcast still works" assertion. |
| 6 | Daemon authored commits as the Conductor | **CAUGHT (asserts `git log`)** | `daemon.test.ts` asserts via `git log --format=%an\|%ae` that member commits are `levare-runner` and Conductor decisions are `cas`, including the subtle `start`-verb case. The real author field, not an internal flag. |
| 7 | A phase's work sat uncommitted while reported committed | **STILL HUMAN-GATED** | No test can catch "an agent claims it committed when it didn't." Closest analogs (`orchestrator.test.ts`/`init.test.ts` assert `git status --porcelain` empty after one op) catch a *single* uncommitted operation, not a false report about a whole phase. |

### The five diagnostic questions

**Q1 — intent instead of outcome.**
- `board-serve-daemon.test.ts:98-111` — monkeypatches `daemon.notify` and asserts `notified===1`: the *call*,
  not the *effect* (that the daemon woke and advanced). Gutting the wake logic still passes. **Fixed in §3.**
- `board-serve.test.ts:100-102` — asserts the served *source text* of `app.js` (`toContain("function
  resolveGate(...)")`): the string is present, never that the interaction works.
- `board-render.test.ts` (pervasive) — asserts HTML class-name strings (`class="gate"`, `snode done`, chips,
  `pcard`). A class in the DOM is the intent; visible/styled is the outcome — the exact gap catch #4 used. Only
  the `scoreNodeClass` block bridges to CSS, and only for score nodes.
- `board-render.test.ts:616-619,660-666` — assert the stylesheet *source* contains a property substring
  (`-webkit-line-clamp:2`, `margin-left:auto`): the rule text exists, not that any element renders that way.

**Q2 — mocks the thing it should exercise.**
- `board-serve.test.ts:45` drives `board.fetch(req)` in-process — the very pattern that hid catch #1. Now a
  *supplement* to the real-binary e2e, so acceptable, but on its own it exercises no process/socket boundary.
- SDK mocking is at the *right* seam and the real seam is separately exercised: `orchestrator-sdk`/
  `native-sdk-boundary` inject a `fakeTransport` (mocks the *model*), while `sdk-transport-hermetic.test.ts`
  drives real subprocesses (hung-worker + grandchild reaping) and `orchestrator-sdk-live.test.ts` calls the
  real model (skipped without a key). This is the correct division, not a blind spot.

**Q3 — tautological (oracle generated by the code under test).**
- `replay.test.ts:13-17` — compares `serialize(oracle)` to `fixtures/golden/expected.json`; `git log` confirms
  the fixture was committed in the *same* commits as the Runner/`serialize`. It pins drift but "fixes" any
  deliberate change by regeneration.
- `context.test.ts:17-39` (→ `fixtures/context/lyra.txt`) and `doctor.test.ts:18-21` (→
  `fixtures/doctor/expected.txt`) — both frozen fixtures committed alongside the code that generates them.
  Same shape. (The *structural* order/section assertions in `context.test.ts:41-83` are **not** tautological —
  they assert independent properties; those are the model to copy.)
- `board-serve.test.ts` asset byte-equality against the same on-disk file the server reads — near-vacuous
  pass-through: proves the server doesn't corrupt the file, cannot prove the file is correct.

**Q4 — structurally impossible coverage (human-gated; named so they are known, not assumed).**
1. Rendered pixels / visual appearance — no browser renders; class names ≠ visible.
2. Client-side JS behavior — `assets/app.js` (~260 lines: theme toggle, gate summon, edit/save, EventSource)
   is never executed; there is no DOM harness (none is installed, and none may be a *runtime* dep — a dev
   `happy-dom`/`jsdom` is permitted but was not added this round; see §5).
3. Live model classification quality — `orchestrator-sdk-live.test.ts` skipped without a key.
4. Real credentialed network round-trip to Anthropic.
5. fd/handle counting on hosts without `/proc` or `lsof` (the leak check skips cleanly).
6. The N1 navigation stall — no automated test possible from inside the devcontainer (see §4).
7. An agent's truthful reporting of its own commits (catch #7).

**Q5 — would still pass if the feature were deleted / stubbed to a no-op.**
- `board-serve.test.ts:100-102`, `board-render.test.ts:490-494` — stub every `app.js` function body to a no-op
  while keeping signatures/attributes and all pass. **The entire client interaction layer is delete-proof** —
  the single largest such surface.
- `board-render.test.ts` CSS-substring/`hasCssRuleFor` assertions — an empty rule `.snode.upcoming{}` passes;
  delete the element or override the property and they still pass. **Hardened in §3.**
- `board-serve-daemon.test.ts:98-111` — a no-op `notify()` still counts as invoked. **Fixed in §3.**
- asset byte-equality — replace the asset with garbage and it still passes (compared to itself).

### The rules the suite should follow going forward

1. **Anything that spawns a process is tested by spawning it.** In-process router/handler tests are permitted
   only as a *supplement* to at least one real-binary e2e over a real socket. (Honored: `board-serve-e2e`,
   `sdk-transport-hermetic`.)
2. **Anything that writes a file is asserted against the file on disk** — read it back, byte-compare — never a
   returned object or `ok` flag alone.
3. **Anything that commits is asserted against `git log`'s author, email, and subject** — never an internal
   identity flag. (Honored: `daemon`, `gateops-phase5`, `orchestrator`.)
4. **A DOM class or attribute is not an outcome.** Every emitted class that carries meaning is cross-checked
   against a *non-empty* stylesheet rule; every interactive attribute is exercised by executing the client JS
   in a DOM harness. Extend the `scoreNodeClass ↔ styles.css` pattern to every state/status class.
5. **No oracle may be generated by the code it validates without an accompanying independent structural
   assertion.** Byte-for-byte snapshots are fine as drift alarms but must be paired with at least one property
   a human must consciously choose to break.
6. **Assert the effect, not the invocation.** Never assert a callback/notify/subscribe was *called*; assert the
   state it was supposed to change (subscriber count back to zero, next artifact produced, file flipped). The
   SSE-leak test is the model.
7. **A transport/boundary may be mocked only where the *model* is the mocked thing; the transport mechanism
   itself is exercised separately with a real subprocess.**
8. **Every test must fail if its feature is stubbed to a no-op.** Before landing a test, gut the feature body
   while keeping signatures/strings; if it still passes, it asserts shape, not behavior.

---

## 3. Debts closed (with their tests)

Fixes applied in the brief's order. Every fix is asserted against a real outcome (a file, a commit, a
validator verdict, a spawned member), per the rules above.

**(1) Invariant with no *test* enforcement — invariant 10 (deps policy).** Added `tests/deps-policy.test.ts`:
asserts, inside `bun test`, that `package.json`'s `dependencies` contains only `@anthropic-ai/claude-agent-sdk`
— the same policy `deps:check` enforces, now an in-suite outcome rather than a CI-only script. (Invariants 6
and 7 are unenforced because their *features* are unbuilt — deferred, §4, not fabricated.)

**(2) A7 — approved artifacts mutable via a later commit (lineage laundering).** Fix: record the approval
baseline commit in artifact frontmatter at gate resolution, and have `validate` diff the artifact's content
against *that ref* rather than `HEAD`.
- New optional frontmatter field `approved_commit` (schema: `validate.ts` ARTIFACT_SCHEMA, nullable str).
- `gateops.ts#doApprove` and `applyLoopCompanionApproval` record `approved_commit` = the repo's `HEAD` *before*
  the approval commit (the commit that holds the exact content the Conductor approved — a permanent ancestor,
  never a dangling/self-referential SHA). *Design note:* recording the pre-approval `HEAD` rather than the
  approval commit's own SHA avoids the self-reference paradox (a commit cannot contain its own hash) without a
  second commit or an amend that would leave a dangling ref; it is equivalent for detecting post-approval
  content change and strictly more robust (the baseline is a normal ancestor). Documented in NOTES A7-update.
- `validate.ts#gitImmutabilityCheck`: when an approved artifact carries `approved_commit`, it diffs the file's
  content at that ref against the working tree, **excluding the approval-stamp fields** (`status`,
  `approved_by`, `approved_commit`) which the approval legitimately introduces — any other content change
  (body, `consumes`, `files`, …) is `MODIFIED_AFTER_APPROVAL`. New state **S2c** = committed-mutation detected
  against the approval ref (distinct from S2b's working-tree drift). Artifacts with no `approved_commit`
  (pre-existing fixtures) fall back to the HEAD diff unchanged — backward compatible; `levare validate
  fixtures/golden` stays valid.
- **Test:** the security-audit A7 `test.failing` is **flipped to a real prevention test** — it now approves via
  the real `resolveGate` path (which records `approved_commit`), commits, then commits a body edit, and asserts
  `validatePath(root).ok === false` with a `MODIFIED_AFTER_APPROVAL` error. `tests/immutability.test.ts` gains
  the S2c committed-mutation case and a legit-approval-is-S2c-clean case.

**(3) Worst test-quality offenders.**
- **CSS-class outcome (catch #4's class-of-bug).** `board-render.test.ts`: `hasCssRuleFor` hardened to require a
  **non-empty** rule body, and a new assertion cross-checks *every* emitted score/status state class against a
  defined non-empty `styles.css` rule — not only score nodes. An empty or missing rule now fails.
- **notify intent → outcome.** `board-serve-daemon.test.ts`: the "resolving a gate nudges the daemon" test now
  asserts the **effect** — after the gate resolves, the daemon actually advances the unit (produces the next
  artifact on disk) — instead of counting `notify` invocations.

**(4) C4 — the per-kind walk.** `gates.ts` gains `responsibleTeamsFor(repo, unit): Team[]` — every team
producing ≥1 of the unit type's expected kinds, ordered by the earliest expected-kind each team produces
(dependency order: shaping teams before build teams), ties by name. `dagwalk.ts#advanceUnit` and
`runner.ts#walkUnit` now iterate that ordered list, advancing each team's flow in turn (a team whose flow is
satisfied yields nothing → move to the next), so a unit hands from a shaping team to a build team exactly as §6
specifies. `responsibleTeamFor` remains (returns the first responsible team) for the start-gate/`doStart`
entry. Single-team fixtures (all existing tests, the golden replay) are unchanged — one responsible team means
the loop runs once.
- **Test:** `tests/multiteam.test.ts` — a scratch repo with a `feature` unit, a shaping team (produces
  product-brief/design/spec/review) and a **separate build team** (produces `code`, consumes `spec`). After the
  shaping flow completes and `spec` is approved, the daemon walk produces `code` **via the build team**. The
  test asserts the produced `code` artifact's `produced_by` names the build team — which fails under the old
  per-unit `responsibleTeamFor` (it always selected the shaping team and never produced `code`). This is the
  multi-team fixture that would have caught the divergence.

**(5) E8 — the registry editor (preview-only → editable).** The write route (`POST /registry/*path`: validate
→ write → commit as the Conductor) already existed and is confined (`isRegistryEditablePath`). What was missing
was the editable control. `render.ts#entityBlock` now emits a raw-markdown `<textarea class="rawmd-edit">` (the
entity's exact source, escaped) alongside the read-only `<pre>`, plus the entity's repo-relative path in a
`data-path` attribute. `assets/app.js`'s `data-save` handler (previously a fake "Committed ✓" animation) now
POSTs the textarea's raw content as `{content}` to `/registry/<data-path>`, renders the server's validity
verdict (the *same validator* the whole repo uses, server-side), and reloads on success. Respecting the
constitution: **raw markdown** (a textarea, not a form), the **same validator**, the commit is authored by the
**Conductor** server-side, **no form-based authoring**. **Test:** an e2e over the real binary POSTs a valid edit
to `/registry/knowledge/…md` and asserts the file changed on disk and `git log -1` shows a `cas`-authored `edit`
commit; an invalid edit is rejected 422 with the file rolled back. (The client-side textarea→fetch wiring
itself remains human-gated per rule 4 — no DOM harness this round; §5.)

**(6) Dead code and cheap duplication.**
- Deleted `RunnerOptions.seed` (the abandoned resumable-Runner parameter, no caller — NOTES O1) and its
  constructor consumption.
- Deleted the Runner-layer `"blocked"` `GateType` and `{ t: "blocked" }` `RunEvent` (never constructed/emitted)
  and the dead `replay.ts` formatter branch that fed on them. (Distinct from the live daemon `blocked` artifact
  *status*, which is untouched.)
- `dagwalk.ts` round-1 id now derives its `-vN` convention through the shared `bumpVersion` rather than a bare
  `-v1` string literal, so the version convention has one home.
- `orchestrator.ts#runNewProjectSkill` reuses the exported `CONDUCTOR_NAME`/`CONDUCTOR_EMAIL` constants instead
  of a duplicated inline `"cas"`/`"cas@levare.local"` identity literal.

---

## 4. Debts deferred (with reasons)

- **Invariant 6 — merge gate / spike-never-merges.** No merge/promotion surface exists to attach enforcement
  to; `checkGuardrails` is a ready, unit-tested deliverable with no caller. This is a **future phase (the
  build-team/merge phase)**, not drift. Fabricating a call site for a non-existent feature would be worse than
  the honest gap. **Requires a Conductor ruling** on when the merge phase lands (it is entangled with C4's
  build teams and K5's live-member wiring).
- **Invariant 7 — `mode: led`.** Parsed and loaded but inert (nothing branches on `"led"`). The escape hatch
  gates an unbuilt behavior. **Requires a Conductor decision** on what `led` actually changes before it can be
  wired (and tested).
- **C1 style-2 (member-set `verdict` loop) — unimplemented.** No fixture exercises it; adding a `verdict`
  schema field + reader is a design change deferred with the same reasoning NOTES D8/B3 gave. Left for the
  phase that needs an autonomous-style loop.
- **C3/daemon budget divergence.** The daemon has no C3 acknowledgment memory — it re-halts every tick while
  `spent > budget`, whereas the Runner engine acknowledges. This is arguably correct for an autonomous
  background process (its only lever is to stop inviting spend), but it *is* a semantic divergence from C3.
  **Requires a Conductor ruling:** does C3's "informs, never spams" apply to the daemon, or is a hard re-halt
  the intended autonomous posture? Not guessed at.
- **C5 on the board surface.** The board/Orchestrator approval path bypasses `applyApproval`'s name+ISO format
  guard (validates presence only). Safe today (hard-constructed string) but a real divergence. The clean fix is
  to route `doApprove`/`applyLoopCompanionApproval` through `applyApproval` — deferred as a follow-up to avoid
  widening this review's blast radius into the gate-resolution control flow mid-C4-change; recommended next.
- **A7 residual — coordinated lineage forgery.** The A7 fix catches the demonstrated attack (a naive committed
  body edit). An attacker with full repo write who *also* rewrites `approved_commit` to a fresh commit in the
  same edit can still launder — but that is the cryptographic-binding gap Surface 10 records as **inherent to
  the no-auth, single-operator model** (PRD §12 non-goal). Out of scope; noted.
- **K5 native-boundary prerequisites (Surfaces 3/8).** The native SDK member boundary spreads full `process.env`
  and passes a vendored agent's declared tools straight through. Inert (wired into no live path). Recorded in
  NOTES K5 as **blocking prerequisites** for the phase that wires native members: route spawn env through
  `buildMemberEnv`, and bound a vendored agent's `tools`. Verified nothing has quietly armed them —
  `stubAdapterRunner` remains the only reachable member runner from the board/daemon (`createSdkNativeBoundary`
  has zero production callers). Framing confirmed correct.
- **N1 navigation stall — undetermined from here, honestly.** Per NOTES N1 this is explicitly a host-vs-
  container question. This review runs **inside the same devcontainer whose port-forward proxy is the leading
  hypothesis**, so I cannot distinguish hypothesis (a) (a VS Code port-forward artifact — levare innocent) from
  (b) (an `fs.watch` debounce/reload burst). The security audit reached the identical conclusion. **It needs a
  bare-host `levare serve` run with no port forward in the path** — the one diagnostic step neither this review
  nor the audit can take from inside the container. Not fixed, not worked around; the required next step is
  named precisely so it is not mistaken for done.
- **Runner-vs-dagwalk/gates duplication (structural).** `resolveStep`, `untilSatisfied`, and the C8/`after:`
  computation remain hand-synced copies across engines (C4's `responsibleTeamsFor` change was applied to both
  copies but did not *eliminate* the duplication). The correct end state — a leaf module both engines import,
  breaking the `gates.ts → runner.ts` import cycle that motivates the copies — is a larger refactor recorded in
  §6; deferred to keep this review's changes reviewable.

---

## 5. What I could not examine (honest list)

- **Rendered appearance and CSS visual correctness.** No browser renders in the suite; I cross-check class↔rule
  existence and non-emptiness, not pixels, contrast, or layout. Invariant 12's "gate brass only on gates" and
  "team hues on identity only" are visual invariants with no automated negative test — human-gated.
- **`assets/app.js` runtime behavior.** ~260 lines of client JS are never executed (no DOM harness installed;
  a dev `happy-dom`/`jsdom` is permissible but I did not add one this round, to avoid a dependency change mid-
  review). The E8 save wiring I added is asserted server-side (real POST, real file, real commit) but the
  textarea→fetch click path itself is human-gated. This is the largest residual "delete-still-passes" surface —
  named in the rules (rule 4) as the priority for the next round.
- **Live model behavior.** Whether the real Orchestrator obeys the prose injection defense, classifies intent
  correctly, and never force-fits a question into a mutating intent — needs a real `ANTHROPIC_API_KEY` and a
  human reading replies (K12 live voice gate). Same limit the security audit hit.
- **Real macOS `/var`→`/private/var` canonicalization.** Only the container symlink reproduction was exercised;
  the real Darwin path was not.
- **The N1 stall on a bare host.** See §4 — untestable from inside the devcontainer.
- **Real native-SDK member behavior** (env exfil, hostile-tool execution, writing outside a unit) — the native
  boundary is wired into no live path (K5), so there is no real tool-executing member to drive.

---

## 6. Recommendation to the Conductor

The system is still recognizably the one designed — the seams (Conductor decides, Runner executes, files are
the truth) hold, and the audit's structural firebreaks (paths-not-contents, env allowlist, CSRF/read-only
guards, the two git identities) are real and tested. The debts closed here (A7, C4, the two worst test
offenders, E8, dead code) were the payable ones. The remaining architectural work is one thing: **extract the
flow-resolution rules (`responsibleTeamsFor`, `resolveStep`, `untilSatisfied`, the C8/`after:` computation,
`bumpVersion`) into a leaf module both the Runner engine and the daemon/board import**, ending the hand-synced
duplication that is now the codebase's only recurring structural risk — this is C7's own lesson applied to the
one place it was not. That, the C5-on-the-board convergence, and the three genuine policy questions (invariant
6's merge phase, invariant 7's `led`, C3's daemon budget posture) are the Conductor's to rule on; they are
written up above and left, not guessed.

The most valuable outcome of this review is not the bug list — it is rule 8: *a test must fail if its feature
is stubbed to a no-op.* Applied honestly, it says the client-JS layer is still the place a future agent could
delete a feature and watch the suite stay green. That is the next round's first job.

# levare — security audit v1.1

**Auditors:** two independent reviewers — Codex (adversarial, fresh checkout) and the architect
(adversarial, direct on the repo) — consolidated and adjudicated by the Conductor (`docs/security-audit-brief-v11.md`).
**Fixed by:** Claude Code, branch `fix/security-v11` (`/goal`, NOTES SEC-V11).
**Date:** 2026-07-18.
**Scope:** the four new v1.1 surfaces — proposal execution (CAP-A), the env allowlist/withholding/scoped
HOME (CAP-A/CAP-B), the merge/push path (MERGE-1), conversation persistence (V11-CONV) — plus a re-test
of the three mutating routes, start-gate consent, and the compiled binary's own paths. This audit
predates none of those four features; `docs/security-audit.md` (the FIRST audit) predates all of them.

**Bottom line — the audit's central claim held.** Proposal execution stays injection-safe (one template
element → one argv element, no shell — a member can cause at most the actions the connector's author
declared, with values only in declared slots); env withholding still holds (a write+proposal connector's
vars never reach a member's own process); the three mutating routes stay exactly three, CSRF-guarded,
path-confined. This goal hardens the real gaps the two auditors found at the EDGES of those otherwise-
sound designs — it does not redesign any of them.

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| F1 | `home:` traversal escapes scoped HOME (validate-time AND runtime) | **High** | Fixed |
| F2 | Merge TOCTOU — guardrails check one branch tip, execution merges a later one | **High** | Fixed |
| F3 | Conversation turn forgery via a header-shaped body line | Medium | Fixed |
| F4 | Placeholder-in-flag-position (author footgun, not member injection) | Low | Fixed (warning) |
| F5 | Project-name-derived conversation scope had no traversal guard | Low | Fixed (hardening) |

---

## F1 (High) — `home:` traversal escapes scoped HOME

**The hole.** `env.ts#scopeHome` built both the symlink TARGET (`join(realHome, dotpath)`) and the
symlink LINK (`join(scratch, dotpath)`) with no validation of `dotpath` at all, and `validate.ts`
accepted a connector's `home:` as a bare `str[]` — any string, unchecked. A connector declaring
`home: ["../../.ssh"]` would resolve its symlink TARGET above the real `HOME` (reading anything the
operator's own user account can read — not limited to `.ssh`, whatever `..` walks the traversal up to)
and place the LINK itself *outside* the scratch directory the caller believes it owns — so
`cleanup()`'s `rmSync(scratch)` would never remove it. Net effect: a single malicious `home:` entry is a
scoped-HOME bypass (reads outside the declared allowlist) AND a persistence bug (a live symlink to an
attacker-chosen path surviving every future run, discoverable only by hand).

**The fix — two independent layers, deliberately not one.**

1. **`validate.ts` (schema time).** `isSafeHomeDotpath` (exported, shared with layer 2 rather than
   reimplemented) rejects: empty, `.`, `..`, any path containing a NUL byte, an absolute path, and any
   normalized form that still starts with `../` or resolves outside the relative root. A bad entry is a
   new `UNSAFE_HOME_PATH` validation ERROR naming the connector and the offending value —
   `validateConnectorHomeSafety`, wired into `validateSingleFile` alongside every other
   `CONNECTOR_SCHEMA` check.
2. **`env.ts#scopeHome` (runtime, independent of #1 ever having run).** Every declared dotpath is
   checked twice before a symlink is even attempted: `isSafeHomeDotpath` (the cheap lexical gate, same
   function validate.ts uses) AND `isStrictlyUnder(link, scratch)` / `isStrictlyUnder(target, realHome)`
   — the actual joined paths, confirmed to resolve strictly inside their respective roots. A failing
   entry is skipped (never symlinked) and recorded in the new `ScopedHome.skipped: string[]` field; every
   other declared dotpath still scopes normally. This is the deliberate "defense in depth" the goal
   asked for: a runtime guard that only trusted validation would be one refactor away from reopening the
   hole (a hand-built `Repo` bypassing `validate.ts` entirely — exactly what a test, a future skill, or a
   vendored connector loaded some other way could do).

**Tests (`tests/security-audit-v11.test.ts`).** `UNSAFE_HOME_PATH` fires for `../../.ssh`, `..`, `.`,
`/etc/passwd`, `foo/../../bar`, and empty, naming the connector and the exact offending value; a nested
legal dotpath (`.config/gh`) stays clean. `scopeHome`, called directly against a hand-built `Repo` that
never went through `validate.ts` (bypassing layer 1 on purpose), given a traversal entry alongside a
planted decoy file one level outside the real HOME: creates no symlink anywhere reaching the decoy,
records the entry in `skipped`, still scopes the safe dotpath normally, and after `cleanup()` the scratch
dir is gone while the decoy is completely untouched (present, unmodified) — the decoy-outside-scratch
proof the goal specifically asked for. An absolute-path entry and a nested valid dotpath are covered too.

---

## F2 (High) — merge TOCTOU: guardrails check one branch tip, execution merges a later one

**The hole.** `board/gateops.ts#doApproveMerge` ran `trialMerge` fresh at approval time (never trusting
the gate-open-time `merge:` block — correct, and unchanged by this fix), checked guardrails against
`trial.diffFiles`, then called `executeMerge(projectRepoPath, branch, ...)` — which **re-resolved
`branch` by NAME**, not by the SHA the trial actually evaluated. If the work branch advanced between the
trial and the merge — a foreign CLI member's commit still landing, or any other write access to the
branch per the threat model — `executeMerge` would silently merge whatever the branch's NEW tip was,
carrying content the guardrail check never saw (including a `protected_paths` violation) straight past
the gate and, where declared, to the real remote.

**The fix.** `trialMerge` now returns `branchSha` — the exact commit of `branch` it evaluated.
`executeMerge` takes an optional `expectedBranchSha`, resolves `branch`'s CURRENT tip itself (never
trusting the caller), and refuses with `stage: "stale"` if it no longer matches the expectation —
`board/gateops.ts#doApproveMerge` now passes `trial.branchSha` through, so any post-trial advance on the
branch aborts the landing with "branch advanced since check — recheck required" (mapped to a 409, with a
recheck hint) rather than merging it. The merge itself is now performed **by SHA**, not by ref name,
closing the residual window between the staleness check and the `git merge` call — the tightest form of
the guarantee. `doRecheckMerge` recomputes `branchSha` fresh, same as gate-open, so the next approval
pins to whatever the most recent recheck actually observed. The existing `core.hooksPath=/dev/null`
defense (a work branch's own commits carrying a malicious `.git/hooks` or `.gitattributes`) is untouched.
The checked SHA is additionally surfaced on the merge gate card (`board/render/shell.ts`, a short 7-char
chip) — small, and the data now exists, per the goal's own "optional" note.

**Schema.** `MergeInfo.branch_sha` (optional/nullable — a hand-built pre-F2 artifact, or a trial that
errored before resolving the branch, carries none) added to `ARTIFACT_SCHEMA`'s `merge:` map and
`types.ts`. `formatMergeArtifact` only emits the line when `trial.branchSha` is set, so this is purely
additive — no existing on-disk artifact or hand-built test fixture needs updating.

**Test (adopting Codex's repro, `tests/security-audit-v11.test.ts`).** Against a real local project
repo: a clean `trialMerge` on a work branch pins `branchSha`; a **protected-path commit lands on the
branch AFTER that trial**; `executeMerge` is called with the now-stale pinned SHA. Result: `ok: false`,
`stage: "stale"`, and — checked directly against the repo, not inferred — `default_branch`'s tree never
contains the protected file and its ref never moved. A sibling test proves the fix never blocks a
legitimate merge (current SHA, lands normally) and that omitting `expectedBranchSha` preserves the old
behaviour (additive, not breaking) — covering every existing `merge.test.ts`/`merge-gate.test.ts` call
site that doesn't pass the new parameter.

---

## F3 (Medium) — conversation turn forgery

**The hole.** `conversation.ts#parseConversation` treats any line matching `## conductor · <ts>` or
`## orchestrator · <ts>` as a new turn boundary — including a line that appears *inside* a turn's own
text. A Conductor message quoting adversarial content (an artifact body, a member's output) containing a
header-shaped line would, on the next parse (a page reload, a restart), be misread as forging an extra
turn — splitting the real message in two and inserting a fabricated turn attributed to whichever speaker
the quoted text named.

**The fix.** `formatTurn` now escapes any body line that exactly matches the header grammar with a
single leading backslash on write (`escapeBodyLine`) — the same convention Markdown itself uses to
escape a line that would otherwise read as a heading; `\## conductor · ...` is still perfectly legible
`cat`/`diff`, per V11-CONV's own design intent (a full JSONL switch would be heavier than this problem
needs and was not pursued). `parseConversation` strips exactly that one leading backslash back off when
(and only when) what remains matches the header pattern — a normal `##` markdown heading, or any other
backslash-prefixed line, is left completely alone. The round-trip (`appendExchange` then
`parseConversation`) now restores the original text byte-for-byte, and a header-shaped body line stays
part of its own turn rather than forging a new one.

**Test (adopting Codex's repro).** A completed exchange whose Conductor message contains a
`## conductor · 2099-01-01T00:00:00.000Z` line (simulating a quoted artifact) parses back as exactly
**two** turns — never three — with the header-shaped line preserved verbatim inside the Conductor's own
turn text. A sibling case covers an `orchestrator`-shaped line in the reply, and a control case confirms
an ordinary `## Section title` markdown heading (not header-grammar-shaped) is completely unaffected.

---

## F4 (Low) — placeholder-in-flag-position lint

**The observation.** A proposal's `params` are always injection-safe by construction (CAP-A's own
closed claim, unaffected by this — one template element maps to exactly one argv element, no shell). But
if a connector AUTHOR places a `{placeholder}` in argv-leading position — `["gh", "{args}"]` — the
MEMBER's chosen value (still only ever a value the author's own template slot accepts) lands where a
flag would normally go, letting `{args}` supply something `gh` itself interprets as an option. This is an
author footgun in the connector's own template, never a member-injection hole.

**The fix.** A new heuristic warning, `PLACEHOLDER_NOT_IN_VALUE_POSITION` — never an error — fires when
an `actions:` template element containing a placeholder is not immediately preceded by a literal
flag-shaped element (one starting with `-`). Documented as advisory: a genuinely positional argument with
no flag before it (`["cp", "{src}", "{dst}"]`) is a legal, common shape this heuristic cannot distinguish
from the risky case — false positives are expected and acceptable for a LOW-severity author hint.

**Test.** `["gh", "{args}"]` warns, naming the connector, action, and placeholder. `["gh", "pr", "create",
"--title", "{title}"]` does not.

---

## F5 (Low, hardening) — confirm scope sanitation coverage

**The observation.** `conversation.ts#sanitizeScope` already correctly confines client-supplied scope
(the `POST /orchestrator/message` body). But a project's own `name:` field is an unconstrained string —
`validate.ts` places no filesystem-safety rule on it, and `repo.ts#loadEntities` keys `repo.projects` by
that field verbatim, not by filename — and it flowed straight into `orchestratorPanel`'s scope on every
project/run/artifact page render (`board/render/project.ts` and siblings), never through
`sanitizeScope`. A project frontmatter declaring a traversal-shaped `name:` would reach
`conversationPath`'s `join()` unsanitized on that read path.

**The fix.** `conversationPath` — the single choke point both `appendExchange` (write) and
`loadConversationTail` (read) resolve their path through — now calls `sanitizeScope` on its own `scope`
argument, unconditionally. Every current and future caller is confined by construction rather than
relying on each call site to remember its own guard; a project-name-derived scope that isn't a safe
single path segment degrades to the studio scope, the same safe default `sanitizeScope` already applies
to a malformed client-supplied one.

**Test.** `conversationPath` sanitizes a traversal-shaped scope (`../../etc`, `..`, `.`, `a/b`, `a\b`)
regardless of caller, falling back to the studio scope identically to `sanitizeScope`'s own default; a
normal project name passes through unchanged.

---

## Verification

`bun test`: 1058 pass (up from 1037), 1 pre-existing skip, 0 fail, across 82 files — one new,
`tests/security-audit-v11.test.ts` (22 tests: F1 validate + runtime fail-closed, F2 real-fixture-repo
TOCTOU proof, F3 round-trip forgery proof, F4 lint, F5 scope-sanitation). `bun run typecheck` → exit 0.
`bun run deps:check` → `deps ok`. `bun run src/cli.ts validate fixtures/golden` → `valid`. `bun run
src/cli.ts replay fixtures/golden --stubs` → oracle match, byte-for-byte (this goal never touches
`dagwalk.ts`'s own walk logic — only the guardrail/pin plumbing inside `merge.ts`/`gateops.ts` a clean
replay never exercises differently). `bun run build` → succeeds. `bun run docs:generate` re-run once,
for the `branch_sha` schema addition (F2) — the only cheatsheet affected, `artifact.md`.

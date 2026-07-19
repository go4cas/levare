# Current gaps

A register, not a roadmap. Every item here is a decision that was made — to defer, to leave
unenforced, or to accept a tradeoff — not a wish list with dates. Each paragraph cites the NOTES
entry or PRD amendment where the decision was actually made; read that source for the full reasoning.
If you're deciding whether to build one of these, start there, not here.

## The v1.1 merge phase — closed (NOTES MERGE-1), invariant 6 in full force

levare now takes a work unit's code through a merge gate to a project's `main`
([`docs/prd-amendment-2.md`](prd-amendment-2.md), rulings M1–M5) — **invariant 6 is back in full
force**; Amendment 1 §2's "SPECIFIED, NOT IMPLEMENTED" reclassification and its own REV1 guardrails
notice are both retired, per Amendment 2 §2. A unit opened on a project declaring `repo:` gets a work
branch (`levare/<unit>`, created from `default_branch`'s tip at unit-open time); when its flow
completes, a merge gate opens with a trial-merge report (branch, commits ahead, diffstat, clean or
conflicted with files named); approving a clean gate runs `checkGuardrails` against the actual diff
(a violation fails the execution, named, even post-approval) and, if clear, produces a real merge
commit (never squash/rebase) authored `levare-runner`, pushing in the same transaction where the
project declares `remote:` — a push failure rolls the local merge back byte-perfectly and blocks the
gate with the reason named. `checkGuardrails` (guardrails.ts) is no longer dormant: its production
call site is `board/gateops.ts#doApproveMerge`.

One thing this closure deliberately did NOT cover, closed by a later goal, and one standing exclusion
that remains by design:

- **Member-side work-branch checkout is per-dispatch isolated — closed (NOTES R4-SANDBOX, Ruling 1).**
  The single-working-tree checkout named here at the time of this closure (`adapters.ts#AdapterRunner`'s
  `memberWorkingContext`, since retired) has been replaced: a member dispatched for a unit on a
  repo-bearing project now gets its own `git worktree add` of the work branch, under a per-run scratch
  path, created immediately before the invoke call and removed immediately after
  (`merge.ts#createDispatchWorktree`) — the same scratch-worktree technique the merge machinery itself
  (trial merge, execution, rollback) already used, extended to a third caller. Two units on the same
  repo-bearing project advanced concurrently now get two independent worktrees of their own two
  branches — no shared checkout to race. A two-concurrent-dispatch test proves the isolation directly
  (`tests/adapters.test.ts`).
- **Self-referential projects (`repo: .`, e.g. the golden fixture's own `studio` project) are excluded
  from the whole mechanism** — no work branch, no merge gate, no per-dispatch worktree — because that
  path IS the studio's own repo, the same one every gate resolution in this app commits artifacts into.
  Mixing branch-switching into that tree would be a correctness hazard, not a feature; `resolveProjectRepoPath`
  (merge.ts) excludes it structurally. A project whose `repo:` doesn't resolve to a real local git checkout at
  all (an unfetched SSH URL, a placeholder) is likewise unaffected — no work branch, no merge gate, no
  worktree, flow completion behaves exactly as it did before either goal.

## Remote/MCP members

An agent may declare `kind: remote` and it validates cleanly — but every remote invocation is served
by a mocked `RemoteBoundary` (`adapters.ts`); no live MCP call exists anywhere in the codebase today.
`levare validate`, `levare doctor`, and the registry's agent card all surface an explicit warning for
any `kind: remote` declaration so a studio author can't mistake the schema accepting the declaration
for the runtime honoring it (NOTES REV1, Finding 3). The wiring itself — an actual MCP client, a real
remote dispatch path — was and is out of scope; only the honesty layer was built.

## Conversation persistence — closed (NOTES V11-CONV), two narrower gaps remain

The Orchestrator conversation now persists to `conversations/<scope>/<YYYY-MM>.md` — an append-only,
per-scope, per-month markdown log, committed as `levare-runner` via the REV2 transactional helper, one
commit per completed exchange (NOTES V11-CONV closes the exclusion NOTES UI8 named and UI10 left open).
Two deliberate, narrower gaps remain from that goal:

- **No in-UI "load earlier" affordance.** The panel only ever renders the current scope's
  current-month segment, capped to the last `TAIL_EXCHANGES` (conversation.ts) exchanges. Older months,
  and anything beyond the cap, stay on disk — fully greppable (`grep`/`cat`/`git log -p` over
  `conversations/`) but not reachable from the panel itself. Paging or a "load earlier" control was
  explicitly deferred, not attempted.
- **The turn-block format is a plain log, not an escaped serialization.** A message body line that
  happens to exactly match a `## conductor · <timestamp>` / `## orchestrator · <timestamp>` header
  would be misread as a new turn boundary on reparse — accepted deliberately (conversation.ts's own
  comment) to keep the format pleasant to hand-edit and diff, rather than adding escaping for an
  extremely unlikely accidental collision.

## The capability layer

Referenced repeatedly (NOTES C13; `docs/guide/07-community.md`'s own "roadmap has real gaps" note)
as the future phase that would give each member its own isolated runtime view — its own filesystem,
its own scoped environment — rather than every member sharing one process-level env allowlist.

**Part A is built (NOTES CAP-A):** a connector now declares `effects: read | write`, and a `write`
connector's `gate: proposal | trusted` — a member granted a `write` + `gate: proposal` connector (the
default) never sees that connector's own env vars at all; it drafts an artifact of kind `proposal`
naming a connector-declared action and params, a Conductor's gate approval is what triggers levare's
own execution step (the only code that ever reads the credential), and a `kind: mcp` proposal's
execution is honestly recorded `executed: skipped` rather than pretended. This closes the "levare
cannot tell a read from a write" gap named above and gives the member-drafts/Conductor-approves/
levare-acts shape a real, gated write path for the first time.

**Part B is built (NOTES CAP-B):** `tools:` is now a validated fixed vocabulary (`SDK_TOOL_NAMES`,
sdk-transport.ts) rather than a free-form registry — an unknown name is a validation error naming the
real one. For a `native` member the declared list forwards to the Claude Agent SDK's own boundary
verbatim (a test proves the boundary receives exactly the declared list); a `cli` member's `tools:`
cannot be enforced the same way at the per-tool level — there is no SDK boundary in that spawn path for
a named-tool allowlist to reach — so it's a validate/doctor warning instead (`CLI_TOOLS_NOT_ENFORCEABLE`),
silenced only by removing the field. **v2's OS sandbox (below) narrows this warning's text, but does not
silence it:** a working sandbox confines a `cli` member's overall filesystem/network reach, which is a
coarser boundary than `tools:` itself describes (it cannot distinguish "may use Read" from "may use
Write") — so the gap the warning names is real either way. A connector also gains `home:` — dotpaths
under `$HOME` a subscription-authenticated vendor CLI actually needs (`home: [".codex"]`); a member
granted a connector that declares it gets a per-run scratch `HOME` symlinking only those paths (never a
copy — the login is a live credential), created before the spawn and removed after. A subscription
connector declaring no `home:` keeps the pre-CAP-B behaviour (the member's process sees the real,
unscoped `HOME`) and gets a new `SUBSCRIPTION_NO_HOME` warning, the sibling to `SUBSCRIPTION_NO_ROLE`
(NOTES C15). This narrows, but does not close, "Per-member subscription-credential scoping" below — see
that entry for the residual `home:` itself cannot fix.

**OS-level sandboxing (v2) — closed (NOTES R4-SANDBOX, Ruling 2; the macOS shape settled by a Conductor
ruling after live bisection, NOTES R4-SANDBOX-FIX-3).** Process isolation between a `cli` member's
spawned process and the operating system — the one item parts A and B both named but deliberately left
unbuilt — now exists, best-effort and per-OS, honestly reported. Both real `cli` spawn paths
(`adapters.ts`'s sync and async `CliSpawn` boundaries) wrap the member process in an OS sandbox where a
working primitive exists on the host, detected fresh at every spawn (never assumed from the platform: a
binary can be present and non-functional, e.g. this repo's own Linux dev container, where
`bubblewrap`/`unshare` are both on `PATH` but fail every invocation because the outer container disables
unprivileged user namespaces).

**The two platforms no longer enforce the SAME SHAPE of confinement at the `full` tier, and this is
recorded honestly rather than implied uniform (`levare doctor` prints a model note alongside the
primitive name for exactly this reason).** Linux `bubblewrap`, unchanged since Ruling 2: an allow-list
built from an EMPTY root — the process can reach its per-dispatch worktree (Ruling 1, above) read-write,
its `scopeHome` scratch `HOME` (NOTES CAP-B) read-write, the studio root, the interpreter's own install
tree, and a small enumerated set of baseline system paths (`/usr`, `/bin`, `/lib`, `/lib64`, `/etc`) —
nothing else; a decoy file ANYWHERE outside that list is genuinely unreadable. macOS `sandbox-exec`,
flipped to a DENY-LIST model by a live 14-profile bisection (NOTES R4-SANDBOX-FIX-3): the allow-list shape
proved unwinnable against `dyld`'s own shared-cache lookup on this OS (every enumerated variant tried
aborted identically, `SIGABRT` before `main()`, no sandbox denial logged for it) — the OS is broadly
readable by default, the same as an unsandboxed process, and the operator's own user data (`$HOME`,
`/Users`, `/Volumes`) is denied instead, with the dispatch worktree/scoped HOME/granted connector targets/
interpreter tree re-allowed explicitly on top (Seatbelt's own later-rule-wins semantics makes this a real
deny-list, not merely a differently-ordered allow-list). Both satisfy the actual threat model — a member
must not read the operator's dotfiles, other projects, or the studio beyond its grants — by different,
non-equivalent means; hiding the OS from `dyld` was never the goal and, per the bisection, isn't
achievable on this platform regardless of further effort. The darwin decoy-file test's own meaning
survives this change: a file under the operator's `$HOME` outside the granted set is still genuinely
unreadable, proven the identical way — it's simply no longer true that everything outside a short
allow-list is unreadable on macOS, because nothing on this OS can make that claim survive contact with
`dyld`.

Network is best-effort on both platforms — denied unless the member holds at least one granted connector
(every connector this codebase has IS levare's own way of declaring an external reach). Per-OS primitive
selection: Linux tries `bubblewrap` first (level `full`), falling back to a raw `unshare` mount-namespace
confinement (level `fs-only` — filesystem only, weaker than `full` in a THIRD distinct way: it confines
writes to the declared roots via a read-only remount of `/`, but does not additionally hide unlisted
read-only paths the way bubblewrap's empty-root construction does); macOS uses a generated `sandbox-exec`
profile (level `full`, deny-list shape). No working primitive on either OS → an unsandboxed spawn (level
`none`) — a Conductor ruling, never escalated to a spawn failure — plus a new `SANDBOX_UNAVAILABLE`
doctor/validate/registry warning, sibling to `CLI_TOOLS_NOT_ENFORCEABLE` above. The enforcement level
actually used is recorded on the produced artifact (`sandbox: full | fs-only | none`), per run, never
omitted — though as of this ruling, `full` itself requires reading which `primitive` produced it to know
which of the two non-equivalent guarantees actually applied.

**Honestly, in five rounds.** The FIRST live run of this feature was on macOS — the only host in this
project's history where `sandbox-exec` actually engaged rather than reporting `none` — and it failed 20
pre-existing tests plus the two new decoy/read-back tests, all real-spawn paths. Round 1 (NOTES
R4-SANDBOX-FIX) fixed macOS path canonicalization (`sandbox-exec`'s path rules match the KERNEL-RESOLVED
form, and `/tmp`/`/var/folders` are symlinks into `/private`) and widened the read-only allowlist to
include the studio root and the interpreter's own install location, which had broken nearly every real
CLI fixture this repo's own suite spawns. A SECOND live run, with the kernel's own unified log checked
directly for sandbox denials, found ZERO — proving the member process was dying before the sandbox ever
judged anything, an entirely different class of bug than round 1 fixed. Round 2 (NOTES
R4-SANDBOX-FIX-2) found the actual composition defect: the profile was passed inline (`-p <string>`,
never independently verified on this host) rather than via a temp file (`-f <path>`, the exact form a
manual check proved works), plus an unverified `--` separator neither `man sandbox-exec` nor that same
manual check ever showed. Both are now aligned with the one invocation shape actually proven to work. A
THIRD live run — with the wrapper now composing and applying correctly, confirmed via
`LEVARE_SANDBOX_DEBUG` — found the process still dying, this time under `dyld`'s own
`ignition_halt`/`abort_with_reason`, no sandbox denial logged for it; a 14-profile bisection on the live
host proved no enumerated allow-list satisfies `dyld` on this OS, and a Conductor ruling (NOTES
R4-SANDBOX-FIX-3) flipped the macOS model to deny-listing instead, described above. A FOURTH live run —
against the new deny-list model — dropped the failure count from 20 to 9, and this time the
`LEVARE_SANDBOX_DEBUG` capture convicted the generated profile TEXT directly: a security bug (the
operator's real HOME was blanket re-allowed whenever a member had no genuinely scoped one — the exact
common case the round-3 decoy test exercised, and why that test itself was failing), a crash (denying
`/Users` without re-allowing the ancestor directory components between it and a re-allowed path breaks
path traversal — recognizable by a NEW signature, `SIGTRAP` inside `std::__call_once`, bun/Zig panicking
on an unexpected `EPERM`, never a logged sandbox denial), and a cosmetic duplicate-rule issue. Round 4
(NOTES R4-SANDBOX-FIX-4) fixed all three: the HOME re-allow now requires the home to be genuinely
DIFFERENT from the operator's real one; every re-allowed path gets ancestor-directory metadata access so
traversal into it survives a denied ancestor; every generated line is deduplicated. Throughout, a
`LEVARE_SANDBOX_DEBUG=1` env var prints the composed argv and raw spawn result for whichever run
confirms it. What COULD be verified without a live macOS host (canonicalization logic, argv/profile
construction, rule ORDER in the generated profile text, the deny-defeat/ancestor-metadata/dedup fixes all
directly against the generator's own output) was; what could only be proven by actually running there
(bubblewrap's own Linux behaviour beyond this repo's own dev container, `unshare`'s fs-only fallback
anywhere, and now whether the round-4-corrected profile clears the remaining 9 failures on the same host
that reported them) still wasn't, and is named rather than assumed — see NOTES R4-SANDBOX-FIX-4's own
"still requires a live host" list.

## Connector trust-tier taxonomy

A connector now declares `role: model | tool` (NOTES C15) — what FUNCTION it serves — and, since NOTES
CAP-A, `effects: read | write` — whether a grant lets a member merely read through it or only propose
against it. That narrows this gap (a read-only tool connector and a state-mutating one are now
distinguishable, and the latter is gated by default) but does not close it: there is still no team-
scoped grant system beyond whichever agents happen to be granted a connector, and no finer tier within
`effects: write` itself (e.g. "may propose against production, may not against staging"). NOTES C13's
own guidance — "prefer `auth: env`, grant `auth: subscription` only to trusted members" — remains
advisory prose in a doctor warning, not an enforced taxonomy. Building the rest is capability-layer
work, not yet started.

## Per-member subscription-credential scoping

A subscription-authenticated CLI (the motivating case: `codex login` writing a session to
`~/.codex`) reads its credential off disk, outside any env var levare could withhold. NOTES C13 named
this precisely and NOTES CAP-B (the capability layer, part B, above) narrows it with a real filesystem
boundary: a connector declaring `home: [".codex"]` gives a granted member's spawned process a per-run
scratch `HOME` symlinking only that path — the operator's other dotfiles (`~/.ssh`, `~/.aws`, anything
not named) are never visible to that member's process at all, and a decoy-file test proves it. What
`home:` does **not** fix, and cannot: it scopes *what a granted member's process can see on disk*, never
*who is allowed to hold the grant in the first place* — **any** member granted this SAME connector can
still use the live login, symlink or not; only the real `codex login`/`codex logout` revokes it. `levare
doctor` and the registry card both still say so plainly (now conditioned on whether `home:` is
declared), rather than let a scoped grant read as a per-member-revocable one. A connector declaring no
`home:` at all gets the pre-CAP-B behaviour unchanged — the member's process sees the operator's entire
real `HOME` — and a new warning (`SUBSCRIPTION_NO_HOME`) names that gap explicitly.

## Install script and Homebrew formula

Distribution today is a downloaded, checksum-verified binary placed on `PATH` by hand, or a
build-from-source. `README.md`'s own Distribution section and NOTES DIST2 state explicitly that an
install script and a Homebrew formula are deferred to a later step, rather than implying either
exists — `tests/release-workflow.test.ts` asserts the README makes no premature `brew install`/
`curl | sh` claim. The release pipeline (four cross-compiled platform binaries, checksums, a GitHub
Release) is built; the one-line installer on top of it is not.

## The loadRepo-per-request position

Every board route re-derives its `Repo` from disk on every request — no caching layer sits in front
of `loadRepo`. This is a deliberate reading of PRD invariant 2 ("the binary holds no state that
cannot be reconstructed by re-reading the repo"), not an oversight: a prior `withRepo()` wrapper in
`board/serve.ts` looked like it might be a future cache seam but was in fact a zero-behaviour alias,
and was removed rather than kept as an implied promise of caching to come (NOTES REV4, item 3a) — a
derivation cache would sit in real tension with invariant 2's own wording, so it isn't treated as a
"someday" item here so much as a standing tradeoff: simplicity and correctness (every render reflects
the actual current file state) over the read latency of large repos.

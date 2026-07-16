# Current gaps

A register, not a roadmap. Every item here is a decision that was made — to defer, to leave
unenforced, or to accept a tradeoff — not a wish list with dates. Each paragraph cites the NOTES
entry or PRD amendment where the decision was actually made; read that source for the full reasoning.
If you're deciding whether to build one of these, start there, not here.

## The v1.1 merge phase, and guardrails enforcement

levare produces artifacts through gates; it does not yet take a branch through a merge gate to a
project's `main`. **Invariant 6 is formally reclassified as "SPECIFIED, NOT IMPLEMENTED — v1.1"**
([`docs/prd-amendment-1.md`](prd-amendment-1.md) §2) — it remains the intended design and the single
largest missing feature, but until it ships, levare makes no claim about how code lands. A direct
consequence: a team's declared `guardrails:` block (`protected_paths`/`protected_branches`/`never`)
validates, renders on the registry card, and is completely inert — `checkGuardrails` has zero
production call sites, because its only enforcement point is the merge phase that doesn't exist yet.
Rather than stay silent about that, `levare doctor` and the registry's team card both surface an
explicit warning naming the gap (NOTES REV1, Finding 2) — the telling was built; the enforcement is
still v1.1's own work.

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
its own scoped environment — rather than every member sharing one process-level env allowlist. It
does not exist yet. Everything below in this register that talks about per-member isolation or
credential scoping is a specific instance of this same missing layer.

## Connector trust-tier taxonomy

A connector now declares `role: model | tool` (NOTES C15) — what FUNCTION it serves — but there is
still no broader trust-tier system distinguishing, say, a read-only tool connector from one that can
mutate production state, or scoping a connector to specific teams beyond whichever agents happen to
be granted it. NOTES C13's own guidance — "prefer `auth: env`, grant `auth: subscription` only to
trusted members" — remains advisory prose in a doctor warning, not an enforced taxonomy. Building one
is capability-layer work, not yet started.

## Per-member subscription-credential scoping

A subscription-authenticated CLI (the motivating case: `codex login` writing a session to
`~/.codex`) reads its credential off disk, outside any env var levare could withhold — so **any**
member able to spawn that command can use the login, whether or not it was ever granted a
`subscription` connector. NOTES C13 names this precisely and makes it visible everywhere a connector
is reported (`levare doctor`, the registry card: *"levare cannot scope this credential... The grant
is documentation, not enforcement"*) rather than pretending otherwise — but the fix (per-member
process isolation, e.g. a member-specific `$HOME`/`CODEX_HOME`) is deferred to the capability-layer
work above, "the same future phase that would let levare give each member its own filesystem view,
not just its own env."

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

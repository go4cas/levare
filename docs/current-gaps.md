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
cannot be enforced the same way — there is no SDK boundary in that spawn path for an allowlist to
reach — so it's a validate/doctor warning instead (`CLI_TOOLS_NOT_ENFORCEABLE`), silenced only by
removing the field. A connector also gains `home:` — dotpaths under `$HOME` a subscription-authenticated
vendor CLI actually needs (`home: [".codex"]`); a member granted a connector that declares it gets a
per-run scratch `HOME` symlinking only those paths (never a copy — the login is a live credential),
created before the spawn and removed after. A subscription connector declaring no `home:` keeps the
pre-CAP-B behaviour (the member's process sees the real, unscoped `HOME`) and gets a new
`SUBSCRIPTION_NO_HOME` warning, the sibling to `SUBSCRIPTION_NO_ROLE` (NOTES C15). This narrows, but
does not close, "Per-member subscription-credential scoping" below — see that entry for the residual
`home:` itself cannot fix.

**What remains, still not built:**

- **OS-level sandboxing (v2).** Process isolation — a member-specific filesystem view, network
  restriction — beyond the environment/credential/tool-allowlist/HOME scoping parts A and B now give.
  Ratified as v2's own next-in-line item (R4). Parts A and B govern WHAT a member can read/act through
  and, for `native`, which SDK tools it can reach; none of that sits between a `cli` member and the
  operating system it runs on.

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

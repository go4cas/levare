# levare — architecture and code review brief

**For:** Claude Code (Opus, its own `/goal` phase, branch `review/architecture`)
**From:** Cas (the Conductor), with the architect
**Read first:** `docs/levare-prd.md`, `docs/levare-design-brief.md`, `docs/security-audit.md`, and all
of `NOTES.md` — the A/B/D/E/F/K/M/N/O series (every assumption and known gap) and the Rulings ledger
C1–C8 (the constitution; a change that breaks one is an amendment, not a decision).

---

## Posture

The security audit asked *can this be attacked.* This review asks three different questions:

1. **Is it still the system we designed?** Eight phases of autonomous implementation drift. Find where
   the code and the constitution disagree.
2. **Do the tests test anything?** This is the centerpiece — see below.
3. **What debts are due?** Several were deferred with explicit reasoning. Some are now payable.

You are not attacking the code and you are not admiring it. You are the architect who has been away,
reading what was actually built.

## The centerpiece: the test-quality verdict

**Every serious bug in this build passed a green test suite.** Seven of them, each caught by a human
looking at the running system:

1. `levare serve` printed a URL and exited immediately — 168 tests green. The tests called the router
   in-process and never booted the binary.
2. The CLI adapter built argv by splitting a substituted string — command injection, caught by reading
   code at a gate.
3. The validator failed open three separate ways (hostile git config, macOS path canonicalisation, a
   git error impersonating "verified unchanged") — all green in the container.
4. A score node was emitted with a class the stylesheet never defined — asserted present in the DOM,
   invisible on screen.
5. The SSE handler discarded its unsubscribe callback — a handle leak that forced restarts; tests
   asserted the intent, not the descriptors.
6. The daemon authored its commits as the Conductor — the tests checked an internal flag, not
   `git log`'s author field.
7. An entire phase's work sat uncommitted while the agent reported it committed.

**Produce a verdict on the test suite, not just a bug list.** Specifically:

- **Where does a test assert an intent rather than an outcome?** (An internal flag instead of the file
  on disk; a returned object instead of the commit; a class name instead of a rendered pixel.)
- **Where does a test mock the thing it is supposed to exercise?** (The in-process router instead of
  the spawned binary; the SDK boundary instead of the transport.)
- **Where is a test tautological?** (Asserting against an oracle the same code generated; asserting a
  serializer round-trips through itself.)
- **Where is coverage structurally impossible?** (Things only a human eye or a real host can see —
  name them explicitly, so they are known to be human-gated rather than assumed covered.)
- **Which tests would still pass if the feature were deleted?**

Then: fix the worst offenders, and state the *rules* the suite should follow going forward (e.g.
"anything that spawns a process is tested by spawning it"; "anything that writes a file is asserted
against the file"; "anything that commits is asserted against `git log`").

## Architecture: is it still the system we designed?

- **The invariants (PRD §2).** Twelve of them, plus rulings C1–C8. For each, find the code that
  enforces it — or prove that nothing does. An invariant with no enforcement point is a comment.
- **Layer discipline.** The design's core seam: *the Conductor decides, the Orchestrator routes, the
  Runner executes, members work, files are the truth.* Find where that seam has been crossed —
  judgment leaking into the deterministic layer, state leaking out of the filesystem, dispatch logic
  accreting inside a boundary.
- **Duplication of rules.** C7's lesson was that convergence sometimes means extracting the rule both
  callers must obey. Find the other places where two code paths implement one rule (gate resolution,
  context assembly, commit authorship, artifact id generation, status transitions) and say whether
  they can still disagree.
- **Dead code and vestigial concepts.** Phases superseded each other. What is no longer reachable?
- **The single-binary, zero-dependency promise.** Still true? `deps:check` proves one thing; verify
  the spirit (no vendored copies, no runtime downloads, no hidden platform requirements beyond the
  documented SDK CLI).

## Debts now payable

- **A7 — approved artifacts are mutable via a later commit.** The security audit ranked this High and
  left an xfail. The fix is known: record the approval commit ref in frontmatter at gate resolution;
  `validate` diffs the artifact against *that ref*, not HEAD. This closes lineage laundering. Do it.
- **C4 — the responsible-team heuristic.** The walk selects one team per unit; PRD §6 specifies a
  *per-kind* walk (find producible kinds, invoke the team that produces each). Equivalent while
  fixtures hold one team; a divergence the moment a unit hands from a shaping team to a build team.
  Close it, and add a multi-team fixture that would have caught it.
- **E8 — the registry editor is preview-only.** The write route exists and is tested; the UI has no
  editable control. Wire it, respecting the constitution (raw markdown, the same validator, commit as
  the Conductor, no form-based authoring).
- **N1 — the intermittent navigation stall.** Still unexplained. Determine whether it is a harness
  artifact (the devcontainer port-forward) or a real bug, and say so definitively.
- **The K5 pre-arms.** Native SDK members inherit the full process env, and vendored tools are
  unbounded. Both are recorded as blocking prerequisites for the phase that wires native members live.
  Verify that framing is correct and that nothing has quietly armed them already.

## Method

Work on `review/architecture`. Read broadly before changing anything — the first deliverable is a
report, not a diff. Then fix in this order: (1) anything where an invariant has no enforcement,
(2) A7, (3) the worst test-quality offenders, (4) C4, (5) E8, (6) dead code. Where a fix requires a
Conductor ruling, write it up and leave it; do not guess at policy.

Deliver `docs/code-review.md`: the invariant enforcement map, the test-quality verdict with its rules,
the debts closed and their tests, the debts deferred with reasons, and an honest list of what you did
not have time or means to examine.

## What "good" looks like

The most valuable thing this review can produce is not a list of bugs. It is a suite that would have
caught the seven. If, after this review, a future agent deletes a feature and the tests still pass,
the review failed.

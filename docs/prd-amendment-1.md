# PRD Amendment 1 — post-audit and post-review

**Date:** 2026-07-12
**Author:** Cas (the Conductor)
**Applies to:** `docs/levare-prd.md` v1.0
**Occasioned by:** the security audit (`docs/security-audit.md`) and the architecture review
(`docs/code-review.md`), which between them demonstrated two Critical vulnerabilities, two High
findings, and one honest gap: **two of the twelve invariants have no enforcement point, because the
features that would enforce them were never built.**

An unenforced invariant is worse than an acknowledged gap. It is a false guarantee, and this project
has spent its entire build learning to distrust those. This amendment closes the gap by telling the
truth in the document.

---

## 1. Invariant 1 — restated in its strict form (ruling C8)

The security audit demonstrated that a hand-written or injected `unit.md` with no `after:` condition
caused an unattended member invocation — real subprocesses, real spend — with no Conductor approval in
its causal chain. Combined with the (now fixed) CSRF hole, it was one step from remote unattended
execution.

**Invariant 1 now reads:**

> No member process ever starts without a Conductor approval in its causal chain. **Every work unit's
> first flow step raises a start gate — regardless of type, regardless of `after:`. A unit's existence
> is not consent.** `after:` remains a condition on when a start gate is *raised*, never a licence to
> begin work. External events (issues, schedules, `after:` conditions) may only raise gates.

Implemented in `dagwalk`, `runner`, and the board's `openGates`; the audit's exploit is now a
permanent prevention test.

## 2. Invariant 6 — reclassified: specified, not yet implemented

> *Original:* Code reaches a project's main branch only through the review loop plus a merge gate.

The review found no enforcement point, because **the merge phase does not exist.** levare currently
produces artifacts through gates; it does not yet take a branch through a merge gate to a project's
`main`.

**Status: SPECIFIED, NOT IMPLEMENTED — v1.1.** It remains the intended design and the largest missing
feature. Until it ships, levare makes no claim about how code lands. The invariant is not deleted; it
is marked as a promise not yet kept, so that nothing in the system pretends otherwise.

## 3. Invariant 7 — `mode: led` cut from v1

> *Original:* Exactly one LLM orchestrator. Team-internal sequencing is declarative `flow` data;
> `mode: led` is the sole escape hatch, per team, opt-in.

The first half stands and is enforced. The second half — `mode: led` — was designed as an escape hatch
and never built, because no work unit in eight phases needed it.

**Status: CUT FROM v1.** Its absence strengthens the design: one orchestrator, no exceptions, no
second locus of judgment. If a real use case appears, it can be built then, as a feature with a gate —
not carried as an unimplemented clause.

**Invariant 7 now reads:** *Exactly one LLM orchestrator. Team-internal sequencing is declarative
`flow` data executed by the Runner. There is no escape hatch.*

## 4. Artifact contract — `approved_commit` (closes A7)

The audit ranked as High that an approved artifact could be mutated by a *later commit*: `validate`
diffed only against `HEAD`, so a committed post-approval edit read as valid. Lineage laundering.

**The contract gains one field:**

```yaml
approved_commit: 9f3c1ab        # the commit ref at which the Conductor approved; set at gate resolution
```

`validate` now diffs an approved artifact against **that ref**, not `HEAD` (excluding the stamp fields
themselves). A committed mutation after approval is caught as a distinct state and fails validation.
The audit's expected-to-fail test is now a permanent prevention test.

**Invariant 3 is unchanged in wording and, for the first time, actually enforced.**

## 5. Ruling C3 (extended) — budget gates halt the daemon

The daemon spends money unattended. A budget gate that does not stop it is a gate that watches you
overspend and files a report.

**Ruling:** when a unit's ledger crosses its declared `budget:`, the budget gate is raised **and the
daemon halts that unit** until the Conductor resolves it — exactly as it halts at every other gate.
`continue` acknowledges the current spend and suppresses re-raising until a new threshold is crossed
(C3's original memory rule); `raise` updates the effective budget; `stop` pauses the unit. Other units
are unaffected — a budget is per-unit, not global.

## 6. Deferred to v1.1, with reasons

- **The merge phase** (invariant 6) — the largest gap. Its own phase, not a bolt-on.
- **`runner` ⇄ `dagwalk` duplication** — the review names the correct end state (a shared leaf module
  both call). Cleanliness, not correctness: the per-kind walk now lives consistently in both.
- **N1** — the intermittent navigation stall remains unexplained and untestable from inside the
  devcontainer. To be settled by the Conductor on the host, outside the port-forward, before v1.
- **The K5 pre-arms** — native SDK members inherit the full process env, and vendored tools are
  unbounded. Both are harmless only because the native boundary is unwired. **They are blocking
  prerequisites: the phase that wires native members live cannot merge until both are closed.**

## 7. What this amendment is really recording

Twelve invariants were written before a line of code existed. After eight phases, an adversarial
audit, and an architecture review: nine are enforced, one was strengthened after an exploit proved it
too loose, one is honestly marked unbuilt, and one is cut. That is what a constitution surviving
contact with implementation looks like — and the fact that the gaps are *known* is the only reason
they are safe.

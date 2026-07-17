# PRD Amendment 2 — the merge phase, ratified

**Date:** 2026-07-17
**Author:** Cas (the Conductor)
**Applies to:** `docs/levare-prd.md` v1.0, as amended by Amendment 1
**Occasioned by:** the v1.1 design session for the merge phase. Amendment 1 §2 reclassified
invariant 6 as *specified, not implemented*. This amendment ratifies the implementation design.
When the merge phase ships, invariant 6 returns to full force and this amendment is its
constitutional record.

---

## 1. Invariant 6 — the enforcement design (rulings M1–M5)

> Code reaches a project's `main` branch only through the review loop plus a merge gate.

**M1 — The mechanic.** A work unit's code lands on a **work branch** in the project repo
(`levare/<unit>`, created by the Runner; members commit to it, never to `default_branch`). When the
unit's flow completes — every artifact approved — a **merge gate** opens as the unit's final gate.
Approving it is the Conductor's instruction to land the work: **the members drafted, the Conductor
approved, levare merges.** The merge is execution-on-approval — the same constitutional shape as a
capability proposal (Amendment record: NOTES CAP-A). The unit's body of work *is* the proposal; the
merge gate is its approval.

**M2 — The gate is informed.** When the merge gate opens, levare performs a **trial merge in a
scratch worktree** — never touching the real branch state — and the gate presents: the branch, commits
ahead, a diffstat, the guardrail check result, and whether the merge is **clean or conflicted**. A
conflicted merge gate cannot be approved: it blocks, naming the conflicting files. Resolution is
human work in the repository; the gate re-checks on demand.

**M3 — Guardrails enforce at execution, on the actual diff.** `protected_paths` is checked against
the files the merge would touch; `protected_branches` against the target branch; `never` against the
operations the execution would perform. A violation **fails the execution with the named rule — even
after approval.** Approval expresses the Conductor's wish; guardrails are the studio's law; the law
outranks the wish. The failure names the rule precisely so that, if the law is wrong, the Conductor
amends the guardrail deliberately rather than the system ignoring it silently.
(`checkGuardrails`, built in phase 3 and dormant since, acquires its production call site here.)

**M4 — Merge shape: a merge commit, always.** Authored by `levare-runner`, its message naming the
unit and the approving gate. The work branch's member-commit history is preserved — the audit trail
of *who wrote what* — and the merge commit marks *who approved the landing*. No squash (destroys
member attribution), no rebase (rewrites history in a system whose ethos is append-only truth). Not
configurable in v1.1: one honest shape first.

**M5 — The push is part of the transaction.** Where the project declares a `remote:`, merge + push
execute as one transaction. If the push fails — auth, a moved remote, any reason — the entire
execution fails with the reason, the local merge is rolled back (the transactional-write pattern,
NOTES REV2), and the gate blocks with the failure named. A merge that landed locally but not
remotely is a torn write at repository scale; levare does not leave those behind.

## 2. Standing text

Amendment 1 §2's reclassification of invariant 6 (*"specified, not yet implemented"*) remains in
force until the merge phase ships and its acceptance tests pass, at which point invariant 6 reads in
full force with this amendment as its design record. The guardrails honesty notice (NOTES REV1 —
"declared but not yet enforced") is retired in the same change.

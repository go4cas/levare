---
title: The constitution
parent: Reference
nav_order: 5
---

# 5.4 · The constitution

levare is governed by a small set of invariants — properties that must hold no matter what — and a
growing ledger of rulings, each one a decision made when the invariants alone didn't settle a case.

A contribution that violates an invariant is a bug, not a feature. A contribution that touches a
ruling should say which one, and why.

---

## The invariants

These are the properties the whole system is built to preserve. Every one has, at some point, been
violated by a plausible-looking change that passed its tests — which is why they are written down.

**1 · The Conductor is the only approver.** No artifact leaves `in-review`, no unit starts, no gate
resolves, without a decision that traces to a human. The daemon has no capacity to decide anything.

**2 · Files are the truth.** Every piece of state — teams, agents, work, artifacts, decisions — is a
file in git. The board is a projection, re-derived on every request. There is no database, no cache,
nowhere else for the truth to hide. Change a file by hand and the system changes.

**3 · The audit log distinguishes the human from the machine.** The Conductor's decisions commit as
the Conductor. Machine work commits as `levare-runner`. They are never confused, because confusing
them would defeat the one artifact whose purpose is to tell them apart.

**4 · A loop ends only by a Conductor's approval, or by exhaustion.** The `until` condition is a human
gate. A loop that cannot converge escalates; it never gives up silently and never spins.

**5 · Existence is not consent.** A work unit's presence on disk authorises nothing. Every unit's
first step raises a start gate, regardless of type or dependencies.

**6 · A member sees only what it was granted.** A spawned member's environment contains the baseline
(`PATH`, `HOME`) plus exactly the variables its granted connectors name — and nothing else. (For
environment credentials. A CLI that authenticates itself from disk is outside this boundary, and
levare says so; see ruling C13.)

**7 · levare never fails silently, and never guesses.** If it knows a member died, a unit can't
advance, a loop won't converge, or a model it asked for isn't the one that ran — it says so. Ambiguity
is an error with options, never a coin-flip.

**8 · levare owns the write.** Members produce content. levare authors the artifact — its kind, id,
lineage, cost, and identity — from what it already knows. A member's self-report is never trusted.

**9 · Cost is never faked.** A receipt records what was actually spent. Silence is recorded as
`unreported`, a subscription as `usd: null` with the plan named — never as `$0`.

**10 · Code reaches a project's `main` branch only through the review loop plus a merge gate** (the
PRD's own invariant 6 — numbered differently there; see `docs/levare-prd.md`'s own list). In full
force as of the merge phase (NOTES MERGE-1; `docs/prd-amendment-2.md`, rulings M1–M5, is its design
record). A work unit's code lands on a work branch, never `default_branch`, directly; a conflicted
merge gate cannot be approved; a guardrail violation fails the merge even after approval, named; the
push is part of the same transaction as the merge, and a push failure rolls the merge back
byte-perfectly. Spike code never merges — promotion means a new feature unit consuming the spike's
findings.

---

## The rulings

Each ruling resolved a specific case the invariants left open. They're recorded in `NOTES.md` in full;
this is the index.

| Ruling | What it settled |
|---|---|
| **C6** | Guardrail namespaces: `protected_paths` match file paths, `protected_branches` match branch refs — never cross-matched. |
| **C8** | Every unit's first step raises a start gate. Existence is not consent (invariant 5). |
| **C9** | A member declares `context_artifacts: paths \| inline`. A member whose cwd is outside the studio must receive artifact contents inline, because it cannot read a path. |
| **C10** | The Orchestrator receives a derived projection of the studio, not filesystem tools. An oracle that browses is an oracle that can wander. |
| **C11** | There is no "offline mode" — there is the Orchestrator, present or absent. No fallback ever answers in levare's voice without being levare. |
| **C12** | levare authors the artifact; members produce content only (invariant 8). |
| **C13** | Connectors declare `auth: env \| subscription`. levare scopes environment credentials; a disk-authenticated CLI is outside that boundary, and the grant is documentation, not enforcement. |
| **C14** | A loop dispatches both members every round. The gate is at the loop's outcome, never on each turn (invariant 4). |
| **M1–M5** | The merge phase (`docs/prd-amendment-2.md`): work branch, trial merge, guardrails at execution on the actual diff, merge-commit-always, push-in-transaction with rollback. Invariant 10 above, in full force. |

---

## What a contribution owes

- If it touches the walk, the daemon, or a gate: it must not weaken invariant 1 or 5.
- If it touches spawning: it must not weaken invariant 6.
- If it touches commits or receipts: it must not weaken invariant 3, 8, or 9.
- If a test would still pass with the feature deleted, the test is not testing the feature.
- If a mechanism is exercised only by the fixture, it is not exercised. The live path and the batch
  path must agree, and a test must prove they agree.

That last line is not abstract. Three separate times, a mechanism worked in the fixture and was absent
from the live path — and each time, a green suite certified a product that could not do the thing it
claimed. The fixture is not the product.

---

Back to **[5 · Reference](README.md)**.

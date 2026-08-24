---
title: Artifact
parent: Cheatsheets
grand_parent: Reference
nav_order: 10
---

# Artifact — `work/<project>/<unit>/<file>.md`

A markdown deliverable with YAML frontmatter, produced by a member and tracked through review.

## Fields

| Field | Type | Required | Nullable | Enum values | Description |
|---|---|---|---|---|---|
| `kind` | string | ✅ | — | — | The artifact kind (e.g. spec, review) — which work-unit-type step this satisfies. |
| `id` | string | ✅ | — | — | This artifact's identifier, unique within its unit. |
| `unit` | string | ✅ | — | — | The work unit this artifact belongs to. |
| `project` | string | ✅ | — | — | The project this artifact belongs to. |
| `status` | enum | ✅ | — | `draft` · `in-review` · `approved` · `rejected` · `superseded` · `blocked` · `skipped` | Where this artifact stands in review (§6): draft, in-review, approved, rejected, superseded, blocked, or skipped. |
| `produced_by` | string | ✅ | — | — | The member (agent) that produced this artifact. |
| `consumes` | string[] | ✅ | — | — | Other artifacts this one was produced from. |
| `supersedes` | string | ✅ | ✅ | — | The artifact id this one replaces, or null if it supersedes nothing. |
| `approved_by` | string | ✅ | ✅ | — | Who approved this artifact at its gate, or null if not yet approved. |
| `approved_commit` | string | — | ✅ | — | The commit whose content was approved at gate resolution, so the immutability check can diff against that ref rather than HEAD. Absent on pre-A7 artifacts, which fall back to the HEAD diff. |
| `created` | date (`YYYY-MM-DD` or `YYYY-MM-DDTHH:MM:SS.sssZ`) | ✅ | — | — | When this artifact was created — a full UTC ISO timestamp (YYYY-MM-DDTHH:MM:SS.sssZ) on every artifact levare writes now, so age displays and gate-response medians read to the minute; a bare YYYY-MM-DD from before this changed stays permanently valid and reads as that day's UTC midnight. |
| `files` | string[] | ✅ | — | — | Paths to the files that make up this artifact. |
| `usage` | map | — | ✅ | — | Cost/usage receipt for the member run that produced this artifact. |
| `usage.model` | string | — | ✅ | — | The model used, or null if not reported. |
| `usage.tokens_in` | number | — | ✅ | — | Input tokens reported, or null if unreported. |
| `usage.tokens_out` | number | — | ✅ | — | Output tokens reported, or null if unreported. |
| `usage.tokens_cache_read` | number | — | ✅ | — | Prompt-cache READ input tokens (priced into usd at a discount vs tokens_in) — native members only; absent for a cli/remote member's receipt, which has no cache accounting to give. |
| `usage.tokens_cache_write` | number | — | ✅ | — | Prompt-cache WRITE (cache-creation) input tokens (priced into usd at their own, typically premium, rate) — native members only; absent for a cli/remote member's receipt. |
| `usage.usd` | number | — | ✅ | — | USD cost, or null if unreported or not applicable (e.g. a subscription-authenticated member — see plan below). For a native member this is the Claude Agent SDK's OWN reported cost (real vendor billing, verbatim) — not derived from tokens_in/tokens_out against knowledge/model-pricing.md, and not reproducible by multiplying them against it, since the SDK's cost also prices tokens_cache_read/tokens_cache_write above at their own separate rates. For a cli/remote member, usd IS an estimate from knowledge/model-pricing.md. |
| `usage.wall_clock_s` | number | — | ✅ | — | Wall-clock seconds the run took, or null if not timed. |
| `usage.plan` | string | — | ✅ | — | The subscription plan covering the cost, set only when the member's receipt came from an auth: subscription connector — usd above is always null for these. |
| `connector` | string | — | ✅ | — | Reserved for kind: proposal — the connector this proposal targets. |
| `action` | string | — | ✅ | — | Reserved for kind: proposal — one of the target connector's declared actions. |
| `params` | map (arbitrary key → string) | — | ✅ | — | Reserved for kind: proposal — params covering every placeholder in the action's argv template. |
| `execution` | map | — | ✅ | — | Reserved for kind: proposal — the on-approval execution record, set by levare itself on gate approval, never authored by a member. |
| `execution.executed_at` | string | ✅ | — | — | When this execution ran. |
| `execution.status` | enum | ✅ | — | `ok` · `failed` · `skipped` | ok (ran successfully), failed (a real non-zero-exit or timed-out execution), or skipped (the honest mcp-not-implemented case — never pretend a call happened). |
| `execution.exit` | number | — | ✅ | — | The process exit code, or null if not applicable. |
| `execution.output_digest` | string | — | ✅ | — | A hash of stdout+stderr, not the raw bytes — never grows a commit unbounded and never risks echoing a secret the connector's output happened to include. |
| `execution.warning` | string | — | ✅ | — | A human-readable warning about the execution, or null. |
| `blocked_reason` | string | — | ✅ | — | Why this artifact is blocked, when status is blocked — written by the runner when a member fails to produce it. Never cleared by a later status change, so it survives a successful retry's supersession as the record of what actually happened to the superseded attempt. |
| `merge` | map | — | ✅ | — | Reserved for kind: merge — the trial-merge report, written by levare when the gate opens and rewritten in place by the recheck verb. |
| `merge.branch` | string | ✅ | — | — | The work branch being merged. |
| `merge.target` | string | ✅ | — | — | The branch it merges into. |
| `merge.commits_ahead` | number | ✅ | — | — | How many commits the work branch is ahead of target. |
| `merge.diffstat` | string | ✅ | — | — | A summary of the diff between branch and target. |
| `merge.conflicted` | boolean | ✅ | — | — | Whether the trial merge found conflicts — true makes the gate unapprovable until resolved. |
| `merge.conflicts` | string[] | ✅ | — | — | The files with conflicts, when conflicted is true. |
| `merge.guardrail_violations` | string[] | ✅ | — | — | Guardrail violations this diff triggered at gate-open time — advisory here; the binding check re-runs against the diff at execution time. |
| `merge.branch_sha` | string | — | ✅ | — | The exact work-branch SHA this trial evaluated — verified unchanged before the merge lands. Absent on pre-F2 artifacts or a trial that errored before resolving the branch. |
| `merge_result` | map | — | ✅ | — | Reserved for kind: merge — set by levare only once a merge gate's approval actually executed a clean merge (and, where declared, a successful push). A failed merge writes nothing here at all. |
| `merge_result.executed_at` | string | ✅ | — | — | When the merge executed. |
| `merge_result.merge_commit` | string | ✅ | — | — | The resulting merge commit SHA. |
| `merge_result.pushed` | boolean | ✅ | ✅ | — | Whether the merge also landed on the project's remote — null when the project declares no remote:. |
| `merge_result.checkout_behind` | boolean | — | ✅ | — | True when the project repo's own primary checkout had default_branch checked out at execution time — M4's own deliberate never-checkout guarantee (merge.ts) leaves that checkout staging every merged file for deletion until synced by hand. Absent on a merge_result written before this field existed. |
| `verdict` | enum | — | ✅ | `APPROVED` · `CHANGES REQUESTED` | Reserved for kind: review — the critic's own verdict on what it reviewed: APPROVED or CHANGES REQUESTED. Populated by adapters.ts#author's read-only, whole-document extraction (never a guess: exactly one anchored line — optionally `Verdict: `-prefixed — must match the whole document, or this stays absent; see verdict_source). Absent means not recorded — predates this field, extraction found zero or more than one matching line, or the critic's own prompt hasn't been updated to declare it yet — and must never be treated as either enum value. |
| `verdict_source` | enum | — | — | `declared` · `extracted` | Present only when verdict is set. extracted — levare found exactly one anchored verdict line in the review body (the only value this binary writes today). declared — reserved for a future structured channel a member's boundary reports directly; not yet implemented, never written. Absent whenever verdict itself is absent. |
| `sandbox` | enum | — | ✅ | `full` · `fs-only` · `none` · `not-wrapped` | The OS-level sandbox enforcement this member's spawn actually ran under: full (filesystem and network confined), fs-only (filesystem-only fallback), none (a real wrap was attempted but no working primitive was found on this host — the spawn ran unconfined). 'not-wrapped' is a legacy value: artifacts written before this binary wired kind: native onto the sandbox mechanism stamped it unconditionally for every native member; this binary never writes it again, but still accepts it on artifacts that already have it. Absent on pre-Ruling-2 artifacts, or whenever the producing boundary was a mocked/stub double. |
| `sandbox_reason` | string | — | — | — | Present alongside sandbox: none when this artifact's producing member declared sandbox: unsandboxed (the author's own documented reason). On a legacy artifact, may also be present alongside sandbox: not-wrapped, carrying levare's own fixed (no-longer-written) explanation. |
| `registry` | string | — | ✅ | — | A content hash over the governing registry (teams/agents/connectors/projects/skills/knowledge/types/studio.md) as it stood on disk when this artifact was produced — what definitions actually governed the dispatch. Absent on pre-this-ruling artifacts. |
| `code_commit` | string | — | ✅ | — | The commit SHA this dispatch's own worktree file changes landed on the work branch as, or 'none' if the dispatch changed nothing. Present only when a real dispatch worktree existed for this member. Absent on pre-this-ruling artifacts. |
| `code_commit_actor` | string | — | ✅ | — | Present only when code_commit's landed commit was authored/committed under an identity other than the member's expected git.ts#memberIdentity — names the observed author (and committer, if different) instead. Absent when the identity matched, including every commit levare's own commitDispatchWorktree made itself. |

## Minimal valid skeleton

```markdown
---
kind: example-kind
id: example-id
unit: example-unit
project: example-project
status: draft
produced_by: example-produced_by
consumes: []
supersedes: null
approved_by: null
created: 2024-01-01
files: []
---

Replace this line with the real content.
```

**Body:** The artifact's actual document. Its first paragraph is the dashboard summary, and it's injected into a consumer's context when that consuming agent declares `context_artifacts: inline`.

---

Generated by `scripts/generate-cheatsheets.ts` from the `artifact` schema in `src/validate.ts`.
Do not edit by hand — run `bun run docs:generate`.

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
| `created` | date (`YYYY-MM-DD`) | ✅ | — | — | The date this artifact was created. |
| `files` | string[] | ✅ | — | — | Paths to the files that make up this artifact. |
| `usage` | map | — | ✅ | — | Cost/usage receipt for the member run that produced this artifact. |
| `usage.model` | string | — | ✅ | — | The model used, or null if not reported. |
| `usage.tokens_in` | number | — | ✅ | — | Input tokens reported, or null if unreported. |
| `usage.tokens_out` | number | — | ✅ | — | Output tokens reported, or null if unreported. |
| `usage.usd` | number | — | ✅ | — | Estimated USD cost, or null if unreported or not applicable (e.g. a subscription-authenticated member — see plan below). |
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
| `sandbox` | enum | — | ✅ | `full` · `fs-only` · `none` | The OS-level sandbox a kind: cli (or fully-implemented kind: remote) member's spawn actually ran under: full (filesystem and network confined), fs-only (filesystem-only fallback), or none (no working primitive found — the spawn ran unconfined). Absent for native members and pre-this-ruling artifacts. |

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

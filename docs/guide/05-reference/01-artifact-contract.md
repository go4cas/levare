---
title: The artifact contract
parent: Reference
nav_order: 1
---

# 5.1 · The artifact contract

An **artifact** is a markdown file with YAML frontmatter, produced by a member, that levare knows how
to reason about. The frontmatter *is* the contract. levare authors it — a member produces only the
body (ruling C12).

---

## The frontmatter

```yaml
---
kind: spec                              # what type of thing this is
id: spec-checkout-flow-v1               # unique within the project
unit: checkout-flow
project: storefront
status: in-review
produced_by: press/lyra                 # team/member that authored it
consumes: [product-brief-v1]            # its lineage — the dependency graph
supersedes: null                        # or the id of the version it replaces
approved_by: null                       # the Conductor, once approved
created: 2026-07-11T14:03:22.451Z
files: []                               # supplementary files travelling with it
usage:                                  # the cost receipt (optional)
  model: claude-sonnet-5
  tokens_in: 1507
  tokens_out: 845
  usd: 0.0152
  wall_clock_s: 12.0
---

The body is the actual document. Its first paragraph is the display summary.
```

| Field | Required | Nullable | Notes |
|---|---|---|---|
| `kind` | ✅ | — | The artifact type — matches a flow step / a team's `produces` |
| `id` | ✅ | — | Unique within the project; convention is `<kind>-<unit>-v<n>` |
| `unit` | ✅ | — | The work unit this belongs to |
| `project` | ✅ | — | The project |
| `status` | ✅ | — | One of the lifecycle states below |
| `produced_by` | ✅ | — | `team/member` that authored it |
| `consumes` | ✅ | — | The artifact ids this was built from — **the dependency graph** |
| `supersedes` | ✅ | ✅ | The id of the version this replaces, or `null` |
| `approved_by` | ✅ | ✅ | The Conductor who approved it, or `null` |
| `approved_commit` | — | ✅ | The commit at which it was approved — the immutability anchor |
| `created` | ✅ | — | A UTC timestamp — a bare `YYYY-MM-DD` from before this field carried a time of day stays valid, read as that day's UTC midnight |
| `files` | ✅ | — | Supplementary files, or `[]` |
| `usage` | — | ✅ | The cost receipt (see below) |

`consumes` is the load-bearing one. It isn't metadata — it's the edge set of the dependency graph.
levare walks it to decide what can be produced next, and it's how a spec proves it was written from an
approved brief rather than from nothing.

---

## The lifecycle

`status` is one of:

| Status | Meaning |
|---|---|
| `draft` | Being written; not yet offered for review |
| `in-review` | Produced, awaiting a Conductor decision |
| `approved` | Accepted by the Conductor — **immutable** |
| `rejected` | Refused on content grounds |
| `superseded` | Replaced by a newer version |
| `blocked` | Its member failed to produce it; awaiting a retry/skip/abandon decision |
| `skipped` | A blocked step the Conductor chose to skip; the walk continues past it |

**Only the Conductor moves an artifact out of `in-review`.** Not the Orchestrator, not the daemon,
not the member that wrote it.

### Immutability

Once approved, an artifact is immutable — and this is enforced, not merely asked for. levare records
the commit at which you approved it (`approved_commit`). If the file changes afterward, validation
fails: an approved artifact whose content no longer matches the commit it was approved at is a
tampered artifact.

A revision is therefore never an edit. It's a **new version** — a new file, with a new `id`, whose
`supersedes` names the old one. The old one's status becomes `superseded`. The history stays legible,
and every version is still on disk.

---

## The receipt

The `usage:` block records what a member's invocation cost. Three numbers, three reliabilities —
and `usd` is not computed the same way twice:

```yaml
usage:
  model: claude-sonnet-5    # the model that ACTUALLY ran (from the SDK's own report)
  tokens_in: 1507           # when the member reported them
  tokens_out: 845
  usd: 0.0152                # see below — not one formula for every member kind
  wall_clock_s: 12.0        # when levare timed the member
```

For a `cli`/`remote` member, `usd` **is** an estimate — priced from `tokens_in`/`tokens_out` against
`knowledge/model-pricing.md`'s flat per-model rate. For a `kind: native` member, it isn't: `usd` is the
Claude Agent SDK's **own reported `total_cost_usd`**, used verbatim — real vendor billing, not a derived
figure. **Don't check a native receipt's `usd` by multiplying `tokens_in`/`tokens_out` against the
pricing table** — you'll land 40–50% off, because the SDK's cost also prices prompt-cache read/write
tokens at their own separate rates, and those tokens are reported nowhere in `tokens_in`/`tokens_out` —
only in the native-only `usage.tokens_cache_read`/`usage.tokens_cache_write` fields (see the [artifact
cheatsheet](cheatsheets/artifact.md)).

Two honest special cases:

- A member that reports nothing records `unreported` — never a fabricated `$0`.
- A subscription-authenticated member (ruling C13) records `usd: null` with the `plan` named — a
  flat-rate plan doesn't bill per token, so pricing it would be a fiction.

And a guard worth knowing about: levare compares the model it *requested* against the model the
receipt *reports*. If a vendor silently substitutes a different model, the artifact is **blocked**,
naming both. A receipt that disagrees with the request is not accepted quietly.

---

## What else levare records

Beyond the fields above, five more are levare's own — not authored by the member, and each written
only when its own circumstance actually applies.

**`verdict` / `verdict_source`** — on a `kind: review` artifact, levare reads the review's own body
rather than asking the critic to declare a verdict separately: markdown decoration is stripped from
each line, then exactly one resulting line — `APPROVED` or `CHANGES REQUESTED`, optionally
`Verdict: `-prefixed — must match in its entirety. Found → `verdict` carries it and
`verdict_source: extracted`. Zero or more than one match → `verdict` stays absent and
`verdict_source: not-found`, so a failed scan is visible rather than silently guessed. `declared` is
reserved for a future structured channel and isn't written yet. See [4.6 · Your first
loop](../04-workflow/06-first-loop.md#what-the-critic-actually-said) for the extraction rule worked
through a real review.

**`blocked_class` / `blocked_class_source`** — when an artifact is `blocked` (see [4.8 · When a member
fails](../04-workflow/08-when-a-member-fails.md)), `blocked_reason` carries the vendor's own error
text, but not whose problem it is. `blocked_class` answers that, when levare can tell: `operator` (the
studio/environment needs fixing — Retry cannot succeed) or `transient` (a rate-limit/5xx/connection
failure that already survived one levare-level retry and still failed). Absent means member-caused or
unknown, and Retry stays offered. `blocked_class_source` says how it was decided: `status` from a real
HTTP error status the SDK's retry stream carried, `message` from matching the failure text against a
known vendor error string when the call never made an HTTP round trip at all.

**`merge_result`** — a `kind: merge` artifact's gate opens with a trial-merge report (`merge:` — branch,
commits ahead, diffstat, conflicts). `merge_result` is different: levare writes it only once approval
actually executes a clean merge (and push, where the project declares a remote) — the merge commit SHA,
whether it pushed, and `checkout_behind`, which flags that the project's own primary checkout still has
every merged file staged for deletion until synced by hand. A failed merge writes nothing here at all.

**`code_commit` / `code_commit_actor`** — when a dispatch has its own worktree, `code_commit` names the
commit SHA its file changes landed on the work branch as, or `none` if the dispatch changed nothing.
`code_commit_actor` is present only when that commit's author/committer identity doesn't match the
member's expected git identity — it names who it actually was instead.

**`registry`** — a content hash over `teams/`, `agents/`, `connectors/`, `projects/`, `skills/`,
`knowledge/`, `types/`, and `studio.md` exactly as they stood on disk when this artifact was produced —
deliberately not `HEAD`, which `work/` commits move independently of the registry. Two artifacts
sharing the same `registry` value ran under byte-identical definitions, full stop; a different value
means something governing the dispatch changed between them, whether or not the commit history shows it.

**Full field list, enum values, and skeleton:** the [artifact cheatsheet](cheatsheets/artifact.md).

---

Next: **[5.2 · Registry entities](02-registry-entities.md)**

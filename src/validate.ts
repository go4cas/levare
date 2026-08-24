// levare validator — a first-class, hand-rolled deliverable (PRD §3, §4, §5).
//
// Validates the studio repo (or any subtree of it): artifacts under work/<project>/<unit>/ and the
// registry/entity definition files under teams/ agents/ types/ projects/ connectors/ knowledge/
// evals/ ideas/. Dispatches a schema by file location, enforces required-and-typed fields, enum
// membership, unknown-key rejection, and cross-artifact consumes/supersedes resolution within a
// project. The approved-immutability rule is checked against git when the path is a git repo.

import { readdirSync, readFileSync, statSync, existsSync, realpathSync } from "node:fs";
import { join, relative, dirname, basename, sep, isAbsolute, resolve, normalize } from "node:path";
import { spawnSync } from "node:child_process";
import { parseFrontmatter, YamlError, type YamlValue } from "./yaml.ts";
import { loadPricing, type Pricing } from "./pricing.ts";
import { readOverlaid, type OverlayFile } from "./overlay.ts";
import { kindMatches } from "./flow.ts";
import { SDK_TOOL_NAMES } from "./sdk-transport.ts";
import type { SandboxDetection } from "./sandbox.ts";
import { approvalExemptFields } from "./approval-fields.ts";
import { formatCheckoutSyncNotice, FORMER_CHECKOUT_SYNC_NOTICES } from "./merge.ts";
export type { OverlayFile } from "./overlay.ts";

export interface ValidationError {
  code: string;
  message: string;
  file: string;
  line?: number;
}

// A legal declaration whose runtime doesn't (yet) do what it promises — never an ok/not-ok verdict
// (that's what `errors` is for). Same shape as ValidationError so every existing formatter/display
// path works unchanged; kept as a distinct type/field because a warning must never flip `ok` to
// false (NOTES REV1 finding 3: `kind: remote` is a legal, valid declaration — it just isn't wired to
// a live MCP call yet).
export type ValidationWarning = ValidationError;

// NOTES F22: `validatePath`/`validateArtifactSource` already accumulate EVERY error for a touched
// entity in one pass (per-file walking, per-field schema checks — neither short-circuits). The gap
// was downstream: every caller that turns a `ValidationError[]` into ONE human-facing message
// (a 422 response, a blocked artifact's reason, a chat reply) kept only `errs[0]`, discarding the
// rest — so a project pointer (or artifact, or unit) missing three required fields reported one, the
// Conductor fixed it, ran again, got told about the second, fixed it, ran a third time for the last.
// One shared formatter, used everywhere a `ValidationError[]` becomes a single string, so this can
// never regress into a second, independently-truncating call site.
export function formatValidationErrors(errs: ValidationError[]): string {
  return errs.map((e) => `${e.code}: ${e.message}`).join("; ");
}

// Which branch the approved-immutability check took for a given target/artifact (see
// gitImmutabilityCheck). Exposed so tests can assert the *state*, not merely ok/not-ok — a
// wrong-state exit (e.g. masking a mutation as "no history") must never pass again.
//   S0  target is not a git repo         → cannot verify (valid)
//   S1  file has no history in HEAD       → nothing to compare (valid)
//   S2a file in HEAD and unchanged        → valid
//   S2b file in HEAD and differs          → MODIFIED_AFTER_APPROVAL
//   S2c file differs from its recorded approval commit (A7 committed-mutation) → MODIFIED_AFTER_APPROVAL
//   S2e git diff errored (status > 1)     → unverifiable; fail-open (valid), never mistaken for S2a
export type ImmutabilityState = "S0" | "S1" | "S2a" | "S2b" | "S2c" | "S2e";
export interface ImmutabilityCheck {
  file: string;
  state: ImmutabilityState;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  fileCount: number;
  immutability: ImmutabilityCheck[];
}

// ---------------------------------------------------------------------------
// Schema DSL
// ---------------------------------------------------------------------------

type Scalar = "str" | "num" | "bool" | "date";
export interface FieldSpec {
  // NOTES CAP-A: "action-map" is a mapping of arbitrary action names to a non-empty argv template
  // array (a connector's declared `actions:`); "str-map" is a mapping of arbitrary keys to a plain
  // string value (a proposal's `params:`). Both differ from "map" in that the KEY SET is not fixed by
  // the schema — "map"'s `fields:` describes a known, closed set of sub-keys, these describe an
  // open set whose value shape is fixed instead.
  type: Scalar | "str[]" | "num[]" | "enum" | "map" | "flow" | "list" | "action-map" | "str-map";
  required?: boolean;
  nullable?: boolean;
  enum?: string[];
  fields?: Record<string, FieldSpec>; // for type: "map"
  // One-line, human-readable field meaning — required on every field so a generated cheatsheet's
  // Description column can never silently go blank. Sourced from this same file's/types.ts's own doc
  // comments (the authoritative account of what a field means), not invented separately — the docs:
  // generate step (scripts/generate-cheatsheets.ts) reads this, never a second copy of the prose.
  description: string;
  // Known, validated string vocabulary for a "str[]"/"str" field whose legal values are fixed but
  // enforced by a semantic check rather than this schema's own `enum`/`type` (e.g. agent `tools:`
  // against SDK_TOOL_NAMES, validateAgentTools below) — surfaced in a generated cheatsheet exactly
  // like `enum` is, so a studio author can discover the vocabulary from the docs instead of from an
  // UNKNOWN_TOOL error.
  vocabulary?: readonly string[];
}
export interface Schema {
  name: string;
  fields: Record<string, FieldSpec>;
  /** Fields that a prior PRD version accepted and this one rejects: name → the diagnosis message
   * (e.g. why it was cut, in which version). A document still declaring one fails with a specific
   * REMOVED_FIELD error naming it — an old studio gets told, not silently ignored (PRD v1.1). */
  removed?: Record<string, string>;
}

// NOTES F19: "skipped" — a Conductor's explicit "skip" verb on a blocked artifact, marking the step
// abandoned so the walk can continue past it.
const STATUS_ENUM = ["draft", "in-review", "approved", "rejected", "superseded", "blocked", "skipped"];

export const ARTIFACT_SCHEMA: Schema = {
  name: "artifact",
  fields: {
    kind: { type: "str", required: true, description: "The artifact kind (e.g. spec, review) — which work-unit-type step this satisfies." },
    id: { type: "str", required: true, description: "This artifact's identifier, unique within its unit." },
    unit: { type: "str", required: true, description: "The work unit this artifact belongs to." },
    project: { type: "str", required: true, description: "The project this artifact belongs to." },
    status: {
      type: "enum",
      required: true,
      enum: STATUS_ENUM,
      description: "Where this artifact stands in review (§6): draft, in-review, approved, rejected, superseded, blocked, or skipped.",
    },
    produced_by: { type: "str", required: true, description: "The member (agent) that produced this artifact." },
    consumes: { type: "str[]", required: true, description: "Other artifacts this one was produced from." },
    supersedes: { type: "str", required: true, nullable: true, description: "The artifact id this one replaces, or null if it supersedes nothing." },
    approved_by: { type: "str", required: true, nullable: true, description: "Who approved this artifact at its gate, or null if not yet approved." },
    // A7: the commit whose content the Conductor approved — recorded at gate resolution so the
    // immutability check can diff against that ref rather than HEAD, closing the committed-mutation
    // gap. Optional/nullable: pre-A7 artifacts carry none and fall back to the HEAD diff.
    approved_commit: {
      type: "str",
      required: false,
      nullable: true,
      description: "The commit whose content was approved at gate resolution, so the immutability check can diff against that ref rather than HEAD. Absent on pre-A7 artifacts, which fall back to the HEAD diff.",
    },
    created: {
      type: "date",
      required: true,
      description:
        "When this artifact was created — a full UTC ISO timestamp (YYYY-MM-DDTHH:MM:SS.sssZ) on every artifact levare writes now, so age displays and gate-response medians read to the minute; a bare YYYY-MM-DD from before this changed stays permanently valid and reads as that day's UTC midnight.",
    },
    files: { type: "str[]", required: true, description: "Paths to the files that make up this artifact." },
    usage: {
      type: "map",
      required: false,
      nullable: true,
      description: "Cost/usage receipt for the member run that produced this artifact.",
      fields: {
        model: { type: "str", nullable: true, description: "The model used, or null if not reported." },
        tokens_in: { type: "num", nullable: true, description: "Input tokens reported, or null if unreported." },
        tokens_out: { type: "num", nullable: true, description: "Output tokens reported, or null if unreported." },
        // NOTES "receipt cache tokens": present only on a native (kind: native) member's receipt — a
        // cli/remote member's boundary has no cache accounting to report, so these are absent, never a
        // misleading `null`, on any other artifact.
        tokens_cache_read: {
          type: "num",
          required: false,
          nullable: true,
          description: "Prompt-cache READ input tokens (priced into usd at a discount vs tokens_in) — native members only; absent for a cli/remote member's receipt, which has no cache accounting to give.",
        },
        tokens_cache_write: {
          type: "num",
          required: false,
          nullable: true,
          description: "Prompt-cache WRITE (cache-creation) input tokens (priced into usd at their own, typically premium, rate) — native members only; absent for a cli/remote member's receipt.",
        },
        usd: {
          type: "num",
          nullable: true,
          description:
            "USD cost, or null if unreported or not applicable (e.g. a subscription-authenticated member — see plan below). For a native member this is the Claude Agent SDK's OWN reported cost (real vendor billing, verbatim) — not derived from tokens_in/tokens_out against knowledge/model-pricing.md, and not reproducible by multiplying them against it, since the SDK's cost also prices tokens_cache_read/tokens_cache_write above at their own separate rates. For a cli/remote member, usd IS an estimate from knowledge/model-pricing.md.",
        },
        wall_clock_s: { type: "num", nullable: true, description: "Wall-clock seconds the run took, or null if not timed." },
        // NOTES C13: set only when the member's receipt came from an auth: subscription connector —
        // names the plan covering the cost, since usd above is always null for these.
        plan: {
          type: "str",
          required: false,
          nullable: true,
          description: "The subscription plan covering the cost, set only when the member's receipt came from an auth: subscription connector — usd above is always null for these.",
        },
      },
    },
    // NOTES CAP-A: reserved for kind: proposal — validateProposalArtifact below enforces presence/
    // shape/cross-entity checks conditionally on kind, the same "shape-only here, semantics below"
    // split validateConnectorAuth already uses for auth/env.
    connector: { type: "str", required: false, nullable: true, description: "Reserved for kind: proposal — the connector this proposal targets." },
    action: { type: "str", required: false, nullable: true, description: "Reserved for kind: proposal — one of the target connector's declared actions." },
    params: { type: "str-map", required: false, nullable: true, description: "Reserved for kind: proposal — params covering every placeholder in the action's argv template." },
    execution: {
      type: "map",
      required: false,
      nullable: true,
      description: "Reserved for kind: proposal — the on-approval execution record, set by levare itself on gate approval, never authored by a member.",
      fields: {
        executed_at: { type: "str", required: true, description: "When this execution ran." },
        status: {
          type: "enum",
          required: true,
          enum: ["ok", "failed", "skipped"],
          description: "ok (ran successfully), failed (a real non-zero-exit or timed-out execution), or skipped (the honest mcp-not-implemented case — never pretend a call happened).",
        },
        exit: { type: "num", required: false, nullable: true, description: "The process exit code, or null if not applicable." },
        output_digest: {
          type: "str",
          required: false,
          nullable: true,
          description: "A hash of stdout+stderr, not the raw bytes — never grows a commit unbounded and never risks echoing a secret the connector's output happened to include.",
        },
        warning: { type: "str", required: false, nullable: true, description: "A human-readable warning about the execution, or null." },
      },
    },
    // Finding 84: why this artifact is `blocked`, mirroring work-unit.blocked_reason one level down.
    // Set once at write time (dagwalk.ts#writeBlocked, board/gateops.ts#blockedRetryDoc) and never
    // cleared — a successful retry patches only `status` to `superseded`, so this survives to tell a
    // failed-dispatch supersession apart from an ordinary content-revision one, which never sets it.
    blocked_reason: {
      type: "str",
      required: false,
      nullable: true,
      description: "Why this artifact is blocked, when status is blocked — written by the runner when a member fails to produce it. Never cleared by a later status change, so it survives a successful retry's supersession as the record of what actually happened to the superseded attempt.",
    },
    // NOTES MERGE-1 (PRD Amendment 2, M1/M2): reserved for `kind: merge` — the trial-merge report a
    // merge gate carries. Structurally optional on every artifact (mirroring `execution:`'s own
    // reservation for `kind: proposal`) rather than schema-gated by kind — a merge gate is levare's
    // own synthetic artifact, never a member's output, so there is no member-facing contract to police
    // here the way validateProposalArtifact polices a member-authored proposal.
    merge: {
      type: "map",
      required: false,
      nullable: true,
      description: "Reserved for kind: merge — the trial-merge report, written by levare when the gate opens and rewritten in place by the recheck verb.",
      fields: {
        branch: { type: "str", required: true, description: "The work branch being merged." },
        target: { type: "str", required: true, description: "The branch it merges into." },
        commits_ahead: { type: "num", required: true, description: "How many commits the work branch is ahead of target." },
        diffstat: { type: "str", required: true, description: "A summary of the diff between branch and target." },
        conflicted: { type: "bool", required: true, description: "Whether the trial merge found conflicts — true makes the gate unapprovable until resolved." },
        conflicts: { type: "str[]", required: true, description: "The files with conflicts, when conflicted is true." },
        guardrail_violations: {
          type: "str[]",
          required: true,
          description: "Guardrail violations this diff triggered at gate-open time — advisory here; the binding check re-runs against the diff at execution time.",
        },
        // NOTES SEC-V11 F2: the exact work-branch SHA this trial evaluated — optional (a hand-built
        // pre-F2 merge artifact, or a trial that errored before resolving the branch, carries none) so
        // this stays additive, never a breaking schema change for existing on-disk artifacts.
        branch_sha: {
          type: "str",
          required: false,
          nullable: true,
          description: "The exact work-branch SHA this trial evaluated — verified unchanged before the merge lands. Absent on pre-F2 artifacts or a trial that errored before resolving the branch.",
        },
      },
    },
    // NOTES MERGE-1 (M4/M5): reserved for `kind: merge` — set by levare only once a merge gate's
    // approval actually executed a clean merge (and, where declared, a successful push).
    merge_result: {
      type: "map",
      required: false,
      nullable: true,
      description: "Reserved for kind: merge — set by levare only once a merge gate's approval actually executed a clean merge (and, where declared, a successful push). A failed merge writes nothing here at all.",
      fields: {
        executed_at: { type: "str", required: true, description: "When the merge executed." },
        merge_commit: { type: "str", required: true, description: "The resulting merge commit SHA." },
        pushed: { type: "bool", required: true, nullable: true, description: "Whether the merge also landed on the project's remote — null when the project declares no remote:." },
        // Optional/nullable, same convention as `merge.branch_sha` above: a `merge_result` written
        // before the 2026-08-20 checkout-sync ruling carries no `checkout_behind` at all (the field
        // didn't exist yet), and that must stay a valid, already-approved artifact — not a schema
        // break the first time this studio is validated after upgrading. Absence is meaningful
        // (predates the ruling), never fabricated as false for old data.
        checkout_behind: {
          type: "bool",
          required: false,
          nullable: true,
          description: "True when the project repo's own primary checkout had default_branch checked out at execution time — M4's own deliberate never-checkout guarantee (merge.ts) leaves that checkout staging every merged file for deletion until synced by hand. Absent on a merge_result written before this field existed.",
        },
      },
    },
    // Ruling 2026-08-23 ("the gate card is where decisions happen", Findings 104/105): reserved for
    // kind: review — the critic's own bottom-line conclusion. Phase 1 of that ruling audited every real
    // review in one live studio (nine, across three units): all nine read CHANGES REQUESTED — no review
    // has ever approved. What that ruling actually rejected was SENTIMENT-GUESSING: an extractor tuned
    // and tested entirely against that one negative case would meet a real APPROVED for the first time
    // in production, exactly the kind of untested path this field exists to avoid. `status: approved` on
    // a review artifact is NOT this — it means the CONDUCTOR approved the review AS AN ARTIFACT (accepted
    // it into the record), never that the critic's own verdict was positive: one of the nine audited
    // reviews is `status: approved` with `CHANGES REQUESTED` in its body. `verdict` is the one field
    // actually answerable to "what did the critic conclude".
    //
    // Ruling 2026-08-24 (the verdict bridge, Finding 118) found the channel Ruling 2026-08-23 left open
    // but unbuilt: a member has no way to WRITE frontmatter directly (Ruling C12 — levare authors the
    // artifact from facts it already knows, never the member's own account of them), so without a bridge
    // this field could never populate, on any review, ever. The bridge accepted is STRUCTURAL extraction,
    // not sentiment-guessing: `adapters.ts#author`'s own read-only, whole-document scan for a line that
    // IS, in its entirety, one of the two enum values (optionally `Verdict: `-prefixed) — never a
    // substring match inside ordinary critique prose ("no changes requested" can never trip it). Every
    // matching line in the document is counted, never just the first or the last: exactly one match is
    // unambiguous and is accepted; zero means the critic never declared one; two or more — even two
    // IDENTICAL values — is a conflict, resolved by neither position nor recency, never resolved by
    // guessing. `verdict_source` (below) names this provenance, so a reader — and, eventually, a loop
    // consumer — can always tell a structurally-extracted value from one a future channel reports
    // directly, rather than reaching a bare `verdict` check that can't tell the difference.
    //
    // Nullable, never required: every review artifact this product has ever produced predates this
    // field. Findings 99 and 114 are both live outages from the same assumption — that artifacts on
    // disk were written by the current binary; 99 was a required field, 114 was a required sentence
    // (merge.ts's checkout-sync notice). A required flip here would brick every existing studio's
    // review history the instant this binary upgrades. Absence means NOT RECORDED — predates this
    // field, extraction found zero or more than one matching line, or a critic whose own prompt hasn't
    // been told about the declared format yet (all collapse to the same state, deliberately: neither is
    // "no verdict", and a card must render that as its own explicit third state, never guess one of the
    // two enum values — Finding 105 is a card that said nothing where a fact belonged, and a confident
    // wrong default would be worse than that silence).
    //
    // Deliberately NOT read by flow.ts#untilSatisfied or any loop-resolution path: `until:
    // review.approved` stays exactly what NOTES "loop until semantics" already established it always
    // was — the Conductor's own approval of the review artifact, via `status`, never a member's prose
    // (or, now, this field). Wiring `verdict` into loop resolution would silently implement
    // docs/code-review.md's separately-named, deliberately-deferred "C1 style-2" (member-set verdict,
    // autonomous loop termination — NOTES D8/B3); that is a different, bigger ruling this unit does not
    // make, and NOTES VERDICT-BRIDGE records that when it comes, it must decide EXPLICITLY whether
    // `extracted` provenance counts for it — never reachable by writing the obvious `verdict ===
    // "APPROVED"` check alone. `verdict` is advisory and card-only, exactly as declared here.
    verdict: {
      type: "enum",
      required: false,
      nullable: true,
      enum: ["APPROVED", "CHANGES REQUESTED"],
      description:
        "Reserved for kind: review — the critic's own verdict on what it reviewed: APPROVED or CHANGES REQUESTED. Populated by adapters.ts#author's read-only, whole-document extraction (never a guess: exactly one anchored line — optionally `Verdict: `-prefixed — must match the whole document, or this stays absent; see verdict_source). Absent means not recorded — predates this field, extraction found zero or more than one matching line, or the critic's own prompt hasn't been updated to declare it yet — and must never be treated as either enum value.",
    },
    // Ruling 2026-08-24 (the verdict bridge, Finding 118, Q3): sibling to `verdict` above — records HOW
    // that value was obtained, present only when `verdict` itself is set (mirrors `sandbox`/
    // `sandbox_reason`'s own "present only when relevant" shape). `extracted` is the only value this
    // binary ever writes today (adapters.ts#author's read-only body scan). `declared` is reserved for a
    // future structured channel a member's own boundary reports directly — never body prose — that does
    // not exist yet (Ruling C12 gives no member a channel to write frontmatter at all). Exists so that
    // when C1 style-2 (NOTES D8/B3) is separately ruled on, whether `extracted` provenance is trustworthy
    // enough to gate autonomous loop continuation is a decision someone has to make on purpose — today's
    // actual safeguard against that ("nobody wrote the reader yet") is exactly the kind of implicit
    // assumption Findings 99 and 114 already showed this product cannot rely on.
    verdict_source: {
      type: "enum",
      required: false,
      enum: ["declared", "extracted"],
      description:
        "Present only when verdict is set. extracted — levare found exactly one anchored verdict line in the review body (the only value this binary writes today). declared — reserved for a future structured channel a member's boundary reports directly; not yet implemented, never written. Absent whenever verdict itself is absent.",
    },
    // NOTES R4-SANDBOX (v2, Ruling 2): the OS-sandbox enforcement level a `kind: cli`/`kind: remote`/
    // `kind: native` member's spawn actually ran under, when it produced this artifact — independent of
    // `usage`/`unreported` (see adapters.ts#author). Absent for pre-this-ruling artifacts, and absent
    // whenever the boundary that ran was a mocked/stub double (nothing genuine to stamp).
    //
    // Finding 75 (part 1, 2026-08-24; part 2, 2026-08-24): "not-wrapped" was a FOURTH value, stamped
    // unconditionally for every `kind: native` member while levare had no wrap wired for that kind at
    // all — NOT the same fact as "none" (a real wrap attempted, host had nothing). Part 2 wires the wrap
    // (adapters.ts#createSdkNativeBoundary/createAsyncSdkNativeBoundary spawn the SDK worker's own
    // self-invocation through it, exactly like a `cli` member's spawn): a NEW native artifact now stamps
    // one of the same three live values `cli`/`remote` always could. "not-wrapped" stays in the enum
    // ONLY so an artifact an OLDER binary already wrote still validates (Finding 99's ruling: never
    // rewrite what an older binary produced) — this binary never stamps it again.
    sandbox: {
      type: "enum",
      required: false,
      nullable: true,
      enum: ["full", "fs-only", "none", "not-wrapped"],
      description: "The OS-level sandbox enforcement this member's spawn actually ran under: full (filesystem and network confined), fs-only (filesystem-only fallback), none (a real wrap was attempted but no working primitive was found on this host — the spawn ran unconfined). 'not-wrapped' is a legacy value: artifacts written before this binary wired kind: native onto the sandbox mechanism stamped it unconditionally for every native member; this binary never writes it again, but still accepts it on artifacts that already have it. Absent on pre-Ruling-2 artifacts, or whenever the producing boundary was a mocked/stub double.",
    },
    // NOTES R4-SANDBOX-APPSERVER: present alongside `sandbox: none` produced by a member declaring
    // `sandbox: unsandboxed` (types.ts#Agent.sandbox, cli-only) — distinguishes "this host had nothing"
    // from "this member was declared unsandboxeable, on any host" (adapters.ts#author's own doc explains
    // why the two facts must never collapse into the identical `sandbox: none` line alone).
    //
    // Finding 75 (part 1): a legacy artifact may also carry this field alongside `sandbox: not-wrapped`,
    // holding levare's own fixed (no-longer-written) explanatory text rather than an author's
    // declaration — safe to have shared the field across both cases, since the discriminator was always
    // `sandbox`'s own value ("none" vs "not-wrapped"), never this field's presence or its prose.
    sandbox_reason: {
      type: "str",
      required: false,
      description: "Present alongside sandbox: none when this artifact's producing member declared sandbox: unsandboxed (the author's own documented reason). On a legacy artifact, may also be present alongside sandbox: not-wrapped, carrying levare's own fixed (no-longer-written) explanation.",
    },
    // NOTES REGISTRY-PROVENANCE: a content hash over the governing registry — teams/, agents/,
    // connectors/, projects/, skills/, knowledge/, types/, studio.md — exactly as it stood on disk when
    // this artifact was produced (git.ts#registryStateHash). Present on every artifact from every member
    // kind, unlike sandbox above. Optional/nullable: pre-this-ruling artifacts carry none.
    registry: {
      type: "str",
      required: false,
      nullable: true,
      description: "A content hash over the governing registry (teams/agents/connectors/projects/skills/knowledge/types/studio.md) as it stood on disk when this artifact was produced — what definitions actually governed the dispatch. Absent on pre-this-ruling artifacts.",
    },
    // Goal "commit-on-produce" (Finding 74): whether this dispatch's own dispatch-worktree file changes
    // (if any) survived the worktree's teardown as a commit on the work branch — see
    // adapters.ts#commitCodeChanges's own doc. Present only when a real dispatch worktree existed for
    // this member, for every member kind (unlike sandbox above, which is cli/remote-only — a worktree's
    // existence, not the spawn kind, is what makes a code commit possible).
    code_commit: {
      type: "str",
      required: false,
      nullable: true,
      description: "The commit SHA this dispatch's own worktree file changes landed on the work branch as, or 'none' if the dispatch changed nothing. Present only when a real dispatch worktree existed for this member. Absent on pre-this-ruling artifacts.",
    },
    // Unit "member authorship survives a self-commit": present ONLY when `code_commit`'s own landed
    // commit was authored/committed under an identity other than `git.ts#memberIdentity(produced_by)`
    // expected — detection, never prevention, of a member's own commit resolving (or deliberately
    // overriding to) some other identity. Absent whenever the identity matched.
    code_commit_actor: {
      type: "str",
      required: false,
      nullable: true,
      description: "Present only when code_commit's landed commit was authored/committed under an identity other than the member's expected git.ts#memberIdentity — names the observed author (and committer, if different) instead. Absent when the identity matched, including every commit levare's own commitDispatchWorktree made itself.",
    },
  },
};

export const WORK_UNIT_SCHEMA: Schema = {
  name: "work-unit",
  fields: {
    type: {
      type: "enum",
      required: true,
      enum: ["inception", "feature", "fix", "spike", "research"],
      description: "The work-unit type template this unit follows — what it's expected to produce and where it gates.",
    },
    status: {
      type: "enum",
      required: true,
      enum: ["active", "paused", "blocked", "shipped", "abandoned"],
      description: "Where this unit stands: active, paused, blocked, shipped, or abandoned.",
    },
    project: { type: "str", required: false, description: "The project this unit belongs to." },
    unit: { type: "str", required: false, description: "This unit's own identifier." },
    after: { type: "str[]", required: false, description: "Start-gate condition — this unit is invisible to the walk until every named condition is met." },
    // Ruling C12/F10 defect 2: disambiguates which team is responsible when more than one team in the
    // studio produces a kind this unit's type expects — see validateResponsibleTeam below.
    team: {
      type: "str",
      required: false,
      description: "Explicit team override — required when more than one team in the studio could produce a kind this unit's type expects, so levare never has to guess which is responsible.",
    },
    timebox: { type: "str", required: false, nullable: true, description: "Spike/timebox duration, Runner-enforced." },
    budget: { type: "num", required: false, nullable: true, description: "USD budget — crossing the ledger sum raises a budget gate." },
    // Why a `blocked` unit is blocked (NOTES F1) — e.g. an unbindable flow step. Recorded on disk so
    // the block is visible and explains itself, never a unit that silently does nothing.
    blocked_reason: {
      type: "str",
      required: false,
      nullable: true,
      description: "Why this unit is blocked, when status is blocked — written by the walk when it cannot bind a flow step to a member, so the block explains itself instead of silently doing nothing.",
    },
  },
};

const TEAM_SCHEMA: Schema = {
  name: "team",
  fields: {
    name: { type: "str", required: true, description: "The team's name." },
    description: {
      type: "str",
      required: false,
      description: "A short card headline (display-only — never read by the runner). Falls back to the charter's own lead when absent.",
    },
    consumes: { type: "str[]", required: true, description: "Artifact kinds this team consumes as input." },
    produces: { type: "str[]", required: true, description: "Artifact kinds this team can produce." },
    members: { type: "str[]", required: true, description: "The agents (members) that belong to this team." },
    flow: { type: "flow", required: true, description: "The declarative sequence of step/gate/loop entries the Runner executes." },
    style: {
      type: "map",
      required: true,
      description: "Display settings for this team.",
      fields: {
        color: {
          type: "str",
          required: true,
          description:
            "The team's declared brand color. Not rendered verbatim: shifted to the nearest hue that clears the WCAG AA contrast floor for avatar text and stays visually distinct from Podium's accent and gate-brass system colors (a hue that collides with either — e.g. a saturated red landing near Podium's own red-orange — is pushed off it). A color already clear of both constraints renders essentially as declared. See src/board/team-color.ts for the exact transform.",
        },
      },
    },
    guardrails: {
      type: "map",
      required: false,
      description: "Guardrails constraining this team's diffs and branches.",
      fields: {
        protected_paths: { type: "str[]", description: "File paths (matched against diff contents) this team must never touch — a different namespace from protected_branches, never cross-matched." },
        protected_branches: { type: "str[]", description: "Branch refs this team must never touch — a different namespace from protected_paths, never cross-matched." },
        never: { type: "str[]", description: "Actions this team must never take." },
      },
    },
    knowledge: { type: "str[]", required: false, description: "Knowledge documents (by name) injected into every member's context." },
    connectors: { type: "str[]", required: false, description: "Connector grants — the Runner injects each named connector's env into this team's members." },
  },
  // `mode:` (the `mode: led` escape hatch) was cut in PRD v1.1 (invariant 7 restated: exactly one LLM
  // orchestrator, declarative `flow` executed by the Runner, no escape hatch). A team still declaring
  // it is diagnosed, never silently ignored.
  removed: {
    mode: "the `mode` field was removed in PRD v1.1 (invariant 7: exactly one LLM orchestrator, no `mode: led` escape hatch)",
  },
};

const AGENT_SCHEMA: Schema = {
  name: "agent",
  fields: {
    name: { type: "str", required: true, description: "The member's name." },
    description: {
      type: "str",
      required: false,
      description: "A short card headline (display-only — never read by the runner). Falls back to the body's own lead when absent.",
    },
    kind: {
      type: "enum",
      required: true,
      enum: ["native", "cli", "remote"],
      description: "How this member is invoked: native (the built-in Claude Agent SDK), cli (a wrapped vendor CLI), or remote (an MCP tool call).",
    },
    // The kinds this member can produce — the studio's capability declaration (NOTES F1). Required:
    // a member that declares nothing it produces can bind to no flow step, so no team it belongs to
    // can run. This is the field whose absence made every real studio structurally unrunnable.
    produces: {
      type: "str[]",
      required: true,
      description: "The artifact kinds this member can produce — the studio's capability declaration. A member that produces nothing can bind to no flow step, so no team it belongs to can run.",
    },
    // native
    model: {
      type: "str",
      required: false,
      description: "native: the model this member uses. cli: also settable, but only reaches the vendor if command includes a {model} placeholder.",
    },
    skills: { type: "str[]", required: false, description: "native: reusable instruction sets (by name) included in this member's context." },
    tools: {
      type: "str[]",
      required: false,
      description: "native: the SDK-level tool allowlist for this member, validated against the Claude Agent SDK's own tool vocabulary — see SDK_TOOL_NAMES below. Distinct from remote's singular tool: this is a set of SDK tool names, not an MCP tool choice.",
      vocabulary: SDK_TOOL_NAMES,
    },
    knowledge: { type: "str[]", required: false, description: "Knowledge documents (by name) injected into this member's context." },
    // cli — argv template as a structured array; each element is one argv slot (§5, no shell split).
    command: {
      type: "str[]",
      required: false,
      description: "cli: the argv template as a structured array — each element is exactly one argv slot; a {placeholder} substitutes in place, never a shell string to split.",
    },
    // How a cli member receives its assembled context (NOTES F7): `{task}` substitution (default) or
    // the child's stdin. Ignored for native/remote.
    context_via: {
      type: "enum",
      required: false,
      enum: ["arg", "stdin"],
      description: "cli: how this member receives its assembled context — arg (default, substitutes {task} in the command template) or stdin (the full context is written to the child's stdin instead). Ignored for native/remote.",
    },
    // How this member receives consumed artifacts (§6 recipe item 7, ruling C9): `paths` (default,
    // unchanged behaviour) or `inline` (full text) — see validateAgentContextScope below for the
    // corresponding cwd-outside-studio definition error.
    context_artifacts: {
      type: "enum",
      required: false,
      enum: ["paths", "inline"],
      description: "How this member receives consumed artifacts: paths (default — root-relative paths only, for a member with filesystem access to the studio) or inline (the full text of every consumed artifact, for a member that cannot reach the studio filesystem).",
    },
    cwd: { type: "str", required: false, description: "cli: the working directory this member's process spawns in." },
    timeout: { type: "num", required: false, description: "cli: the spawn timeout, in seconds." },
    result: { type: "str", required: false, description: "cli: required for kind: cli — how the member's result is read back." },
    // remote
    server: { type: "str", required: false, description: "remote: the kind: mcp connector (by name) this member calls." },
    // NOTES MCP-1B: which MCP tool this member calls, and its tools/call arguments template
    // ({task}-substituted at dispatch — see adapters.ts#createAsyncStdioRemoteBoundary).
    tool: {
      type: "str",
      required: false,
      description: "remote: the singular MCP tool this member invokes on server's connector via tools/call — the member's declared intent → server-call mapping. Distinct from native's tools: this names one chosen MCP tool, not an SDK vocabulary allowlist.",
    },
    params: {
      type: "str-map",
      required: false,
      nullable: true,
      description: "remote: the static tools/call arguments template — each value substitutes {task} with the assembled context.",
    },
    // env scoping (§6): connectors granted to this agent, unioned with its team's grants.
    connectors: { type: "str[]", required: false, description: "Per-agent connector grants, unioned with the team's grants for env scoping." },
    // NOTES R4-SANDBOX-APPSERVER: the declared escape hatch from Ruling 2's OS sandbox — see
    // types.ts#Agent.sandbox's own doc for the full reasoning.
    sandbox: {
      type: "enum",
      required: false,
      enum: ["auto", "unsandboxed"],
      description: "cli: 'auto' (default) — best-effort OS sandboxing per Ruling 2, unchanged. 'unsandboxed' — this member's spawn is NEVER wrapped by levare's OS sandbox, on any host; requires sandbox_reason.",
    },
    sandbox_reason: {
      type: "str",
      required: false,
      description: "Required alongside sandbox: unsandboxed — the documented reason a Conductor can act on (e.g. why this vendor CLI cannot run confined).",
    },
    style: {
      type: "map",
      required: true,
      description: "Display settings for this member.",
      fields: { avatar: { type: "str", required: true, description: "The member's display avatar." } },
    },
  },
};

const TYPE_SCHEMA: Schema = {
  name: "type",
  fields: {
    name: { type: "str", required: true, description: "The work-unit type's name." },
    glyph: { type: "str", required: true, description: "A short display glyph for this type." },
    expects: { type: "str[]", required: true, description: "Artifact kinds a unit of this type is expected to produce." },
    gates: { type: "str[]", required: true, description: "Where this type gates in the flow." },
    output: { type: "str", required: false, description: "A human-readable description of this type's expected output." },
    timebox: { type: "str", required: false, nullable: true, description: "Spike/timebox duration for units of this type, Runner-enforced." },
    promotable_to: {
      type: "str",
      required: false,
      nullable: true,
      description: "The knowledge kind a research report of this type promotes to through a gate.",
    },
  },
};

const PROJECT_SCHEMA: Schema = {
  name: "project",
  fields: {
    name: { type: "str", required: true, description: "The project's name." },
    repo: { type: "str", required: true, description: "Path to the project's product repo." },
    remote: { type: "str", required: true, nullable: true, description: "The git remote to push merges to, or null if this project declares none." },
    default_branch: { type: "str", required: true, description: "The branch merges land on." },
    deploy: { type: "str", required: true, nullable: true, description: "How this project deploys, or null if undeclared." },
    pace: {
      type: "enum",
      required: true,
      enum: ["auto", "step"],
      description: "auto (the daemon advances the score by itself between gates) or step (advances only on explicit Conductor action).",
    },
    overrides: { type: "map", required: false, description: "One-level merge over team defaults, scoped to this project." },
  },
};

const CONNECTOR_SCHEMA: Schema = {
  name: "connector",
  fields: {
    name: { type: "str", required: true, description: "The connector's name." },
    kind: {
      type: "enum",
      required: true,
      enum: ["mcp", "cli"],
      description: "The transport: mcp (a Model Context Protocol server) or cli (a wrapped command).",
    },
    server: { type: "str", required: false, description: "mcp: the server identifier." },
    command: { type: "str", required: false, description: "cli: the command this connector wraps." },
    // NOTES MCP-1B (PRD Amendment 3, ruling R1): the real stdio spawn argv for a kind: mcp connector —
    // see Connector.argv's own doc (types.ts). Absent/empty is a legal, still-honest declaration (an
    // HTTP/SSE server, or simply not configured yet); env.ts#remoteAgentImplemented is where that gets
    // narrowed into a warning for any remote agent that actually references this connector.
    argv: {
      type: "str[]",
      required: false,
      description: "mcp: the real stdio spawn command, argv only, never a shell string. Absent/empty means this connector has no working stdio path yet — an HTTP/SSE server, or simply not configured.",
    },
    // Required-ness of `env` is auth-mode-dependent (NOTES C13) — enforced by validateConnectorAuth
    // below, not by this shape-only schema, since "required" here would reject a bare-absent `env:`
    // on an `auth: subscription` connector even though that's the correct shape for one.
    env: {
      type: "str[]",
      required: false,
      description: "The env var NAMES a granted member receives — values never live in the repo. Required for auth: env connectors; must be empty for auth: subscription connectors.",
    },
    scope: { type: "str", required: false, description: "The scope this connector's credential is limited to." },
    // NOTES C13: how this connector's backend authenticates. Defaults to "env" when absent — the
    // original, unchanged behaviour.
    auth: {
      type: "enum",
      required: false,
      enum: ["env", "subscription"],
      description: "How this connector's backend authenticates: env (default — levare's allowlist injects exactly the named vars, and that grant IS the enforcement) or subscription (the backend authenticates from its own stored credentials, e.g. `codex login`; env must be empty).",
    },
    plan: {
      type: "str",
      required: false,
      description: "Human-readable note on the subscription plan in use — required in practice for auth: subscription connectors, so receipts and doctor can name what's covering the cost.",
    },
    // NOTES C15: this connector's FUNCTION — model access vs. tool/service access — distinct from
    // `kind` (the transport) and never confused with `type` (reserved for domain templates). Defaults
    // to "tool" when absent, the common case.
    role: {
      type: "enum",
      required: false,
      enum: ["model", "tool"],
      description: "This connector's function: model (grants model access, e.g. codex) or tool (default — grants tool/service capabilities, e.g. github, linear). Distinct from kind (the transport).",
    },
    // NOTES CAP-A: whether a grant lets a member merely read through this connector (default) or
    // write through it — a write connector's env is withheld from members (env.ts), never injected.
    effects: {
      type: "enum",
      required: false,
      enum: ["read", "write"],
      description: "Whether a grant lets a member merely read through this connector (default) or write through it — a side-effecting action against the outside world. A write connector's env is withheld from members; only levare's own execution step (on gate approval) reads it.",
    },
    // NOTES CAP-A: only meaningful when effects: write — validateConnectorEffects below rejects it on
    // an effects: read connector rather than silently ignoring it.
    gate: {
      type: "enum",
      required: false,
      enum: ["proposal", "trusted"],
      description: "Only meaningful when effects: write. proposal (default) — the grant is 'may draft a proposal', never 'holds the credential'. trusted — the declared, visible opt-out that injects exactly as an effects: read connector always has.",
    },
    // NOTES CAP-A: action name → argv template, declared here so a member can never supply raw argv —
    // required (non-empty) for an effects: write connector, enforced by validateConnectorEffects below
    // (required-ness here would reject an absent `actions:` on a perfectly valid effects: read
    // connector, the same reasoning `env`'s own required-ness is auth-mode-conditional, not schema-fixed).
    actions: {
      type: "action-map",
      required: false,
      description: "Required (non-empty) for effects: write connectors — the declared action vocabulary: action name → argv template array with {placeholder} slots. A member proposing against this connector names an action and fills placeholders with params:, never raw argv.",
    },
    // NOTES CAP-B / NOTES MCP-1C: dotpaths under $HOME this connector's backend needs (e.g. [".codex"],
    // or [".npm"] for an MCP server) — originally auth: subscription only, generalized by ruling R3 to
    // any kind: mcp connector's own declared reach; see env.ts#scopeHomeForConnector and Connector.home's
    // own doc (types.ts).
    home: {
      type: "str[]",
      required: false,
      description: "Dotpaths under $HOME this connector's own backend actually needs (e.g. [\".codex\"]) — the one, auditable, per-connector way to declare a real-HOME path a spawned process needs, symlinked into a scratch $HOME rather than left unscoped.",
    },
  },
};

const KNOWLEDGE_SCHEMA: Schema = {
  name: "knowledge",
  fields: {
    name: { type: "str", required: true, description: "The knowledge document's name, referenced by name from an agent's or team's knowledge: list." },
    tags: { type: "str[]", required: false, description: "Tags for organizing/filtering knowledge documents." },
  },
};

const EVAL_SCHEMA: Schema = {
  name: "eval",
  fields: {
    name: { type: "str", required: true, description: "The eval's name." },
    unit: { type: "str", required: false, description: "The work-unit type this eval scores." },
    rubric: { type: "str[]", required: false, description: "The scoring rubric's criteria." },
  },
};

const SKILL_SCHEMA: Schema = {
  name: "skill",
  fields: {
    name: { type: "str", required: true, description: "The skill's name, referenced by name from an agent's or team's skills: list." },
    description: { type: "str", required: false, description: "A human-readable summary of what this skill does." },
    scripts: { type: "str[]", required: false, description: "Scripts this skill bundles." },
  },
};

// The root `studio.md` singleton (NOTES F11) — studio-level declarations, distinct from a
// `projects/*.md` product pointer. `orchestrator_model` is checked by `validateKnownModels` below
// against `knowledge/model-pricing.md`, exactly like an agent's own `model:` field.
export const STUDIO_SCHEMA: Schema = {
  name: "studio",
  fields: {
    orchestrator_model: {
      type: "str",
      required: false,
      description: "The Orchestrator's declared model — the registry field that replaces LEVARE_ORCHESTRATOR_MODEL as the source of truth (the env var remains a runtime override).",
    },
    conductor_git_identity: {
      type: "map",
      required: false,
      description: "Finding 90: the operator's own git identity (`git config user.name`/`user.email`) — declared so timeline.ts#gitLogRows can render a hand-committed edit and a levare-recorded Conductor action as the same actor instead of two.",
      fields: {
        name: { type: "str", required: true, description: "The operator's own `git config user.name`." },
        email: { type: "str", required: true, description: "The operator's own `git config user.email`." },
      },
    },
  },
};

const IDEA_SCHEMA: Schema = {
  name: "idea",
  fields: {
    name: { type: "str", required: true, description: "The idea's name." },
    pitch: { type: "str", required: false, description: "The one-sentence pitch — used on promotion to a project." },
    tags: { type: "str[]", required: false, description: "Tags for organizing/filtering ideas." },
  },
};

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

interface DiscoveredArtifact {
  file: string; // path to the .md carrying frontmatter
  dir: string; // artifact directory (folder artifact) or the unit dir (single-file)
  isFolder: boolean;
  data: Record<string, YamlValue>;
}

/**
 * Validate one artifact document (raw markdown source) against the artifact contract — the Runner's
 * boundary check (§6: "the contract is enforced at the boundary, never trusted from the member").
 * Reuses the exact ARTIFACT_SCHEMA and semantic checks used for on-disk validation; no second copy.
 * Returns [] when the document is on-contract. `dir`, if given, is where listed `files:` are resolved.
 */
export function validateArtifactSource(src: string, file = "<member-output>", dir?: string, root?: string, overlay?: OverlayFile): ValidationError[] {
  const errors: ValidationError[] = [];
  let data: Record<string, YamlValue>;
  try {
    ({ data } = parseFrontmatter(src));
  } catch (e) {
    if (e instanceof YamlError) errors.push({ code: "PARSE_ERROR", message: e.message, file, line: e.line });
    else errors.push({ code: "PARSE_ERROR", message: String(e), file });
    return errors;
  }
  validateAgainstSchema(data, ARTIFACT_SCHEMA, file, errors);
  // Resolve listed files relative to `dir` (a synthetic path lets the shared semantics run unchanged).
  // NOTES CAP-A: `root`, when given, lets the proposal-artifact cross-entity check (does the named
  // connector exist, is it effects: write, is the action declared, is it granted to the producer) run
  // at the SAME member-output boundary every other artifact-contract check already runs at — a bad
  // proposal becomes a `blocked` artifact (dagwalk.ts/gateops.ts's existing failure path), never a
  // committed-then-repo-wide-RepoError surprise on the next `loadRepo`.
  validateArtifactSemantics(data, dir ? join(dir, basename(file)) : file, errors, root, overlay);
  return errors;
}

/**
 * Validate a path (single file or a directory tree).
 *
 * `overlay`, when given, substitutes `overlay.content` for `overlay.path` (a resolved absolute path)
 * everywhere this pass would otherwise read that file off disk — the registry editor's live-validation
 * route (board/serve.ts) uses this to check an unsaved buffer against the real repo (cross-reference
 * checks like UNKNOWN_MODEL and AGENT_IN_MULTIPLE_TEAMS included) without writing it to disk first.
 * `overlay.path` must name a file that already exists on disk; validating a not-yet-created entity is
 * not a case the registry editor needs (it only ever opens on an existing entity).
 */
export function validatePath(target: string, overlay?: OverlayFile, sandbox?: SandboxDetection): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];
  let fileCount = 0;
  const artifacts: DiscoveredArtifact[] = [];

  const st = existsSync(target) ? statSync(target) : null;
  if (!st) {
    return {
      ok: false,
      errors: [{ code: "NOT_FOUND", message: `path does not exist: ${target}`, file: target }],
      warnings: [],
      fileCount: 0,
      immutability: [],
    };
  }

  if (st.isFile()) {
    fileCount = 1;
    // No studio root to cross-check a proposal artifact's connector against — fail-open (NOTES CAP-A).
    validateSingleFile(target, classify(target), errors, artifacts, overlay, warnings);
  } else {
    // Directory tree: walk registry folders + work/. `target` IS the studio root here.
    const mdFiles = walkMarkdown(target);
    fileCount = mdFiles.length;
    for (const f of mdFiles) {
      validateSingleFile(f, classify(relative(target, f)), errors, artifacts, overlay, warnings, target);
    }
    // Folder-artifact discovery + index-count check on work/ subdirectories.
    discoverFolderArtifacts(target, errors, artifacts);
  }

  // Cross-entity structural checks: can this studio actually RUN? (only meaningful for a whole tree)
  if (st.isDirectory()) {
    validateStudioBindings(target, errors, overlay);
    validateAgentTeamMembership(target, errors, overlay);
    validateResponsibleTeam(target, errors, overlay);
    validateUncoverableExpectedKinds(target, warnings, overlay);
    validateAgentContextScope(target, errors, overlay);
    validateEnvNotTracked(target, errors);
    validateKnownModels(target, errors, overlay);
    const implementedRemoteAgents = validateAgentRemoteImplementation(target, warnings, overlay);
    validateSandboxTelling(target, warnings, overlay, sandbox, implementedRemoteAgents);
  }

  // Cross-artifact checks over everything discovered.
  crossReference(artifacts, errors);
  const immutability = gitImmutabilityCheck(target, artifacts, errors);

  return { ok: errors.length === 0, errors, warnings, fileCount, immutability };
}

type Kind =
  | { schema: Schema; isArtifact: boolean; isUnit: boolean }
  | { schema: null; isArtifact: false; isUnit: false };

// The registry's own list of entity kinds — every top-level directory (besides `work/`, which is
// special-cased above: it holds units and artifacts, not a registry entity schema) that a studio can
// carry entity definitions in. This is the single source of truth for "what registry directories
// exist" — `scaffoldStudio` (init.ts) and its own test derive the expected scaffold directory set
// from `Object.keys(REGISTRY_SCHEMAS)` rather than a second, independently-maintained list, so a
// future registry entity can't be silently forgotten from the scaffold the way `evals/` was.
export const REGISTRY_SCHEMAS: Record<string, Schema> = {
  teams: TEAM_SCHEMA,
  agents: AGENT_SCHEMA,
  types: TYPE_SCHEMA,
  projects: PROJECT_SCHEMA,
  connectors: CONNECTOR_SCHEMA,
  knowledge: KNOWLEDGE_SCHEMA,
  evals: EVAL_SCHEMA,
  skills: SKILL_SCHEMA,
  ideas: IDEA_SCHEMA,
};

function classify(relPath: string): Kind {
  const parts = relPath.split(sep).filter(Boolean);
  const top = parts[0];
  const base = basename(relPath);
  // Team LEARNINGS.md notes (`<team>.learnings.md`) are plain markdown injected into context, not
  // schema entities — skip them wherever they sit so the validator doesn't demand team frontmatter.
  if (base.endsWith(".learnings.md")) return { schema: null, isArtifact: false, isUnit: false };
  // The root `studio.md` singleton (NOTES F11) — a bare top-level file, never nested in a registry
  // folder, so it must be matched before the REGISTRY_SCHEMAS[top] lookup below (which only
  // recognizes folders).
  if (parts.length === 1 && base === "studio.md") return { schema: STUDIO_SCHEMA, isArtifact: false, isUnit: false };
  if (top === "work") {
    if (base === "unit.md") return { schema: WORK_UNIT_SCHEMA, isArtifact: false, isUnit: true };
    if (base === "ledger.ndjson") return { schema: null, isArtifact: false, isUnit: false };
    return { schema: ARTIFACT_SCHEMA, isArtifact: true, isUnit: false };
  }
  const schema = REGISTRY_SCHEMAS[top];
  if (schema) return { schema, isArtifact: false, isUnit: false };
  return { schema: null, isArtifact: false, isUnit: false };
}

function walkMarkdown(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name === "node_modules" || name === ".git") continue;
      // `conversations/` (NOTES V11-CONV; the literal must match conversation.ts#CONVERSATIONS_DIR —
      // not imported here to avoid a validate.ts <-> conversation.ts import cycle, since
      // conversation.ts itself calls back into this module's own `validatePath`) is the Orchestrator's
      // append-only exchange log — a record, not a registry entity. It carries no schema (`classify`
      // below has none for it) and is never read by repo.ts#loadRepo either, so this walk must never
      // descend into it at all: skipping it here, at the studio root, rather than relying on
      // `classify`'s incidental null-schema skip, makes the exemption explicit and keeps every other
      // `validatePath` call zero-cost regardless of how much conversation history has accumulated.
      if (dir === root && name === "conversations") continue;
      const full = join(dir, name);
      const s = statSync(full);
      if (s.isDirectory()) stack.push(full);
      else if (name.endsWith(".md")) out.push(full);
    }
  }
  return out.sort();
}

function validateSingleFile(
  file: string,
  kind: Kind,
  errors: ValidationError[],
  artifacts: DiscoveredArtifact[],
  overlay?: OverlayFile,
  warnings: ValidationWarning[] = [],
  root?: string,
): void {
  if (!kind.schema) return; // unknown location or non-schema file (e.g. README) — skip.
  let data: Record<string, YamlValue>;
  try {
    ({ data } = parseFrontmatter(readOverlaid(file, overlay)));
  } catch (e) {
    if (e instanceof YamlError) {
      errors.push({ code: "PARSE_ERROR", message: e.message, file, line: e.line });
    } else {
      errors.push({ code: "PARSE_ERROR", message: String(e), file });
    }
    return;
  }
  validateAgainstSchema(data, kind.schema, file, errors);
  if (kind.schema === ARTIFACT_SCHEMA) validateArtifactSemantics(data, file, errors, root, overlay);
  if (kind.isArtifact) {
    artifacts.push({ file, dir: dirname(file), isFolder: false, data });
  }
  if (kind.schema === AGENT_SCHEMA) validateAgentVariant(data, file, errors);
  if (kind.schema === AGENT_SCHEMA) validateAgentTools(data, file, errors);
  if (kind.schema === AGENT_SCHEMA) validateAgentCliToolsWarning(data, file, warnings);
  if (kind.schema === AGENT_SCHEMA) validateAgentSandboxDeclaration(data, file, errors);
  if (kind.schema === AGENT_SCHEMA) validateAgentSandboxDeclaredWarning(data, file, warnings);
  if (kind.schema === CONNECTOR_SCHEMA) validateConnectorAuth(data, file, errors);
  if (kind.schema === CONNECTOR_SCHEMA) validateConnectorRoleWarning(data, file, warnings);
  if (kind.schema === CONNECTOR_SCHEMA) validateConnectorHomeWarning(data, file, warnings);
  if (kind.schema === CONNECTOR_SCHEMA) validateConnectorHomeShimWarning(data, file, warnings);
  if (kind.schema === CONNECTOR_SCHEMA) validateConnectorHomeSafety(data, file, errors);
  if (kind.schema === CONNECTOR_SCHEMA) validateActionPlaceholderPosition(data, file, warnings);
  if (kind.schema === CONNECTOR_SCHEMA) validateConnectorEffects(data, file, errors);
  if (kind.schema === CONNECTOR_SCHEMA) validateConnectorFetchAtDispatch(data, file, warnings);
}

function discoverFolderArtifacts(root: string, errors: ValidationError[], artifacts: DiscoveredArtifact[]): void {
  const workRoot = join(root, "work");
  if (!existsSync(workRoot)) return;
  // work/<project>/<unit>/<subdir>/  where subdir contains the folder artifact.
  for (const project of listDirs(workRoot)) {
    for (const unit of listDirs(join(workRoot, project))) {
      const unitDir = join(workRoot, project, unit);
      for (const entry of listDirs(unitDir)) {
        const artDir = join(unitDir, entry);
        const indices = readdirSync(artDir).filter((n) => n.endsWith(".md"));
        if (indices.length !== 1) {
          errors.push({
            code: "INDEX_COUNT",
            message: `folder artifact '${entry}' must have exactly one markdown index file, found ${indices.length}`,
            file: artDir,
          });
          continue;
        }
        // The index .md was already validated by walkMarkdown as an artifact and pushed with
        // isFolder:false; upgrade that record to a folder artifact.
        const indexPath = join(artDir, indices[0]);
        const existing = artifacts.find((a) => a.file === indexPath);
        if (existing) existing.isFolder = true;
      }
    }
  }
}

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => {
      try {
        return statSync(join(dir, n)).isDirectory() && n !== ".git";
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

function validateAgainstSchema(
  data: Record<string, YamlValue>,
  schema: Schema,
  file: string,
  errors: ValidationError[],
): void {
  // Unknown keys are errors (PRD §4: "unknown keys are errors, not warnings"). A key that a prior PRD
  // version accepted and this one removed (schema.removed) is diagnosed specifically — REMOVED_FIELD
  // names the field and why it is gone — rather than lumped in as a generic unknown key, so an old
  // studio carrying it gets a real explanation (PRD v1.1).
  for (const key of Object.keys(data)) {
    if (key in schema.fields) continue;
    const removedWhy = schema.removed?.[key];
    if (removedWhy !== undefined) {
      errors.push({ code: "REMOVED_FIELD", message: `${removedWhy}; remove it from this ${schema.name}`, file });
    } else {
      errors.push({ code: "UNKNOWN_KEY", message: `unknown key '${key}' in ${schema.name}`, file });
    }
  }
  for (const [key, spec] of Object.entries(schema.fields)) {
    const present = key in data;
    if (!present) {
      if (spec.required) {
        errors.push({ code: "MISSING_FIELD", message: `missing required field '${key}' in ${schema.name}`, file });
      }
      continue;
    }
    checkField(data[key], spec, key, schema.name, file, errors);
  }
}

function checkField(
  value: YamlValue,
  spec: FieldSpec,
  key: string,
  schemaName: string,
  file: string,
  errors: ValidationError[],
): void {
  if (value === null) {
    if (!spec.nullable) {
      errors.push({ code: "BAD_TYPE", message: `field '${key}' may not be null in ${schemaName}`, file });
    }
    return;
  }
  const typeError = (want: string) =>
    errors.push({ code: "BAD_TYPE", message: `field '${key}' must be ${want} in ${schemaName}`, file });

  switch (spec.type) {
    case "str":
      if (typeof value !== "string") typeError("a string");
      break;
    case "num":
      if (typeof value !== "number") typeError("a number");
      break;
    case "bool":
      if (typeof value !== "boolean") typeError("a boolean");
      break;
    case "date":
      if (typeof value !== "string" || !isIsoDate(value)) {
        errors.push({ code: "BAD_DATE", message: `field '${key}' must be an ISO date (YYYY-MM-DD) or a UTC ISO timestamp (YYYY-MM-DDTHH:MM:SS[.sss]Z) in ${schemaName}`, file });
      }
      break;
    case "enum":
      if (typeof value !== "string" || !spec.enum!.includes(value)) {
        errors.push({
          code: "BAD_ENUM",
          message: `field '${key}' must be one of [${spec.enum!.join(", ")}] in ${schemaName}, got '${String(value)}'`,
          file,
        });
      }
      break;
    case "str[]":
      if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) typeError("an array of strings");
      break;
    case "num[]":
      if (!Array.isArray(value) || !value.every((v) => typeof v === "number")) typeError("an array of numbers");
      break;
    case "list":
      if (!Array.isArray(value)) typeError("a list");
      break;
    case "flow":
      if (!Array.isArray(value)) {
        typeError("a list of flow steps");
      } else {
        for (const item of value) {
          if (item === null || typeof item !== "object" || Array.isArray(item)) {
            errors.push({ code: "BAD_TYPE", message: `each flow entry must be a mapping in ${schemaName}`, file });
            break;
          }
        }
      }
      break;
    case "action-map":
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        typeError("a mapping of action name to argv template array");
      } else {
        for (const [actionName, template] of Object.entries(value as Record<string, YamlValue>)) {
          if (!Array.isArray(template) || template.length === 0 || !template.every((el) => typeof el === "string" && el.length > 0)) {
            errors.push({
              code: "BAD_TYPE",
              message: `action '${key}.${actionName}' must be a non-empty array of non-empty strings (an argv template) in ${schemaName}`,
              file,
            });
          }
        }
      }
      break;
    case "str-map":
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        typeError("a mapping of string to string");
      } else {
        for (const [k, v] of Object.entries(value as Record<string, YamlValue>)) {
          if (typeof v !== "string") {
            errors.push({ code: "BAD_TYPE", message: `field '${key}.${k}' must be a string in ${schemaName}`, file });
          }
        }
      }
      break;
    case "map":
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        typeError("a mapping");
      } else if (spec.fields) {
        const m = value as Record<string, YamlValue>;
        for (const k of Object.keys(m)) {
          if (!(k in spec.fields)) {
            errors.push({ code: "UNKNOWN_KEY", message: `unknown key '${key}.${k}' in ${schemaName}`, file });
          }
        }
        for (const [k, subspec] of Object.entries(spec.fields)) {
          if (!(k in m)) {
            if (subspec.required) {
              errors.push({ code: "MISSING_FIELD", message: `missing required field '${key}.${k}' in ${schemaName}`, file });
            }
            continue;
          }
          checkField(m[k], subspec, `${key}.${k}`, schemaName, file, errors);
        }
      }
      break;
  }
}

// `created` (the only "date" field) moved from a bare calendar date to a full UTC timestamp so
// `ageLabel`/`medianGateResponseDays` (derive.ts) stop reading from a fabricated midnight — see
// NOTES "created timestamp". Every artifact written before that change carries a bare `YYYY-MM-DD`,
// and that shape stays permanently valid (not a deprecated fallback): `new Date("2026-08-13")`
// already parses a date-only ISO string as UTC midnight per spec, which is exactly the honest
// reading — "some time that day, exact instant unknown" — so old artifacts keep reading correctly
// forever, they just can't report an age finer than a day.
const ISO_DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function isIsoDate(s: string): boolean {
  if (ISO_DATE_ONLY_RE.test(s)) {
    const [y, m, d] = s.split("-").map(Number);
    if (m < 1 || m > 12 || d < 1 || d > 31) return false;
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }
  if (ISO_DATETIME_RE.test(s)) return !Number.isNaN(new Date(s).getTime());
  return false;
}

// ---------------------------------------------------------------------------
// Artifact-specific semantics
// ---------------------------------------------------------------------------

function validateArtifactSemantics(data: Record<string, YamlValue>, file: string, errors: ValidationError[], root?: string, overlay?: OverlayFile): void {
  // An approved artifact must name its approver (conductor-only; §4).
  if (data.status === "approved" && (data.approved_by === null || data.approved_by === undefined)) {
    errors.push({
      code: "APPROVED_WITHOUT_APPROVER",
      message: "artifact with status 'approved' must set approved_by (conductor name + ISO date)",
      file,
    });
  }
  // A non-approved artifact must NOT carry an approver — only the Conductor sets approved_by on approval.
  if (data.status !== "approved" && data.approved_by !== null && data.approved_by !== undefined) {
    errors.push({
      code: "APPROVER_WITHOUT_APPROVAL",
      message: `approved_by is set but status is '${String(data.status)}'; only an approved artifact may name an approver`,
      file,
    });
  }
  // Listed supplementary files must exist next to the index.
  if (Array.isArray(data.files)) {
    for (const f of data.files) {
      if (typeof f !== "string") continue;
      if (!existsSync(join(dirname(file), f))) {
        errors.push({ code: "MISSING_FILE", message: `listed file '${f}' does not exist beside the artifact index`, file });
      }
    }
  }
  validateProposalArtifact(data, file, errors, root, overlay);
}

// NOTES CAP-A: `kind: proposal` is the artifact shape a member drafts to act through a granted
// `effects: write` connector — "the member drafts, the Conductor approves, levare acts" (item 4,
// execution.ts). Structural presence (connector/action/params all set) is checked unconditionally;
// the cross-entity half (does the connector exist, is it effects: write, is the action declared, do
// params cover every placeholder, is the connector actually granted to the producing member/team)
// only runs when `root` is given — fail-open (no studio to check against) mirrors this file's other
// unverifiable-state postures (UNKNOWN_MODEL's own pricing-table fallback, the git-immutability S0/S1
// states) rather than a hard requirement every caller must satisfy.
function validateProposalArtifact(data: Record<string, YamlValue>, file: string, errors: ValidationError[], root?: string, overlay?: OverlayFile): void {
  if (data.kind !== "proposal") {
    if (data.connector !== undefined || data.action !== undefined || data.params !== undefined || data.execution !== undefined) {
      errors.push({
        code: "PROPOSAL_FIELDS_ON_NON_PROPOSAL",
        message: `artifact kind '${String(data.kind)}' declares connector/action/params/execution — these fields are reserved for kind: proposal`,
        file,
      });
    }
    return;
  }

  const connectorName = typeof data.connector === "string" ? data.connector : undefined;
  const action = typeof data.action === "string" ? data.action : undefined;
  const params = data.params !== null && typeof data.params === "object" && !Array.isArray(data.params) ? (data.params as Record<string, YamlValue>) : undefined;
  if (!connectorName) errors.push({ code: "MISSING_FIELD", message: "a 'proposal' artifact requires 'connector'", file });
  if (!action) errors.push({ code: "MISSING_FIELD", message: "a 'proposal' artifact requires 'action'", file });
  if (!params) errors.push({ code: "MISSING_FIELD", message: "a 'proposal' artifact requires 'params'", file });
  if (!connectorName || !action || !params) return;
  if (!root) return;

  const connectorFile = join(root, "connectors", `${connectorName}.md`);
  if (!existsSync(connectorFile)) {
    errors.push({ code: "UNKNOWN_CONNECTOR", message: `proposal references connector '${connectorName}', which does not exist`, file });
    return;
  }
  let cdata: Record<string, YamlValue>;
  try {
    ({ data: cdata } = parseFrontmatter(readOverlaid(connectorFile, overlay)));
  } catch {
    return; // its own PARSE_ERROR is already recorded by the per-file pass.
  }
  const effects = cdata.effects === "write" ? "write" : "read";
  if (effects !== "write") {
    errors.push({
      code: "PROPOSAL_AGAINST_READ_CONNECTOR",
      message: `proposal targets connector '${connectorName}', which is effects: read — a proposal against a read connector is a definition error`,
      file,
    });
    return;
  }
  const actions = cdata.actions !== null && typeof cdata.actions === "object" && !Array.isArray(cdata.actions) ? (cdata.actions as Record<string, YamlValue>) : {};
  const template = actions[action];
  if (!Array.isArray(template) || !template.every((x) => typeof x === "string")) {
    errors.push({ code: "UNDECLARED_ACTION", message: `proposal names action '${action}', which connector '${connectorName}' does not declare`, file });
    return;
  }
  const placeholders = new Set<string>();
  const placeholderRe = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
  for (const el of template as string[]) {
    let m: RegExpExecArray | null;
    while ((m = placeholderRe.exec(el))) placeholders.add(m[1]);
  }
  const paramKeys = Object.keys(params);
  for (const p of placeholders) {
    if (!(p in params)) errors.push({ code: "MISSING_PARAM", message: `proposal action '${connectorName}/${action}' requires param '${p}', not provided in 'params'`, file });
  }
  for (const k of paramKeys) {
    if (!placeholders.has(k)) errors.push({ code: "UNKNOWN_PARAM", message: `proposal provides param '${k}', which action '${connectorName}/${action}''s template does not use`, file });
  }

  const producedBy = typeof data.produced_by === "string" ? data.produced_by : undefined;
  if (producedBy && producedBy.includes("/")) {
    const [teamName, memberName] = producedBy.split("/");
    if (!isConnectorGrantedTo(root, connectorName, teamName, memberName, overlay)) {
      errors.push({
        code: "CONNECTOR_NOT_GRANTED",
        message: `proposal produced by '${producedBy}' targets connector '${connectorName}', which is not granted to that member or its team`,
        file,
      });
    }
  }
}

// Whether `connectorName` is granted (agent-level or team-level) to `memberName` — hand-parsed
// straight off disk, the same technique every other cross-entity check in this file uses (never via
// repo.ts#loadRepo, which itself depends on this module).
function isConnectorGrantedTo(root: string, connectorName: string, teamName: string, memberName: string, overlay?: OverlayFile): boolean {
  const granted = new Set<string>();
  const agentFile = join(root, "agents", `${memberName}.md`);
  if (existsSync(agentFile)) {
    try {
      const { data } = parseFrontmatter(readOverlaid(agentFile, overlay));
      for (const c of strList(data.connectors)) granted.add(c);
    } catch {
      /* its own PARSE_ERROR is already recorded by the per-file pass */
    }
  }
  const teamFile = join(root, "teams", `${teamName}.md`);
  if (existsSync(teamFile)) {
    try {
      const { data } = parseFrontmatter(readOverlaid(teamFile, overlay));
      for (const c of strList(data.connectors)) granted.add(c);
    } catch {
      /* its own PARSE_ERROR is already recorded by the per-file pass */
    }
  }
  return granted.has(connectorName);
}

function validateAgentVariant(data: Record<string, YamlValue>, file: string, errors: ValidationError[]): void {
  // An empty `produces:` list passes the str[] type check but declares no capability at all — the
  // member can satisfy no flow step. Rejected here rather than left to fail at runtime (NOTES F1).
  if (Array.isArray(data.produces) && data.produces.length === 0) {
    errors.push({
      code: "EMPTY_PRODUCES",
      message: `agent '${String(data.name)}' declares no kinds in 'produces'; a member that produces nothing can bind to no flow step`,
      file,
    });
  }
  const need = (field: string) => {
    if (!(field in data) || data[field] === null) {
      errors.push({ code: "MISSING_FIELD", message: `agent kind '${String(data.kind)}' requires '${field}'`, file });
    }
  };
  if (data.kind === "native") need("model");
  else if (data.kind === "cli") {
    need("command");
    need("result");
    // NOTES F11: a CLI member's declared model is only enforceable if the Runner can actually hand
    // it to the vendor CLI — that means substituting it into the command template via a `{model}`
    // placeholder (adapters.ts#defaultCliCommand). A `model:` with no `{model}` anywhere in `command`
    // is a declaration that can never reach the vendor: a lie, caught here rather than discovered as
    // a silent no-op at run time.
    if (typeof data.model === "string" && Array.isArray(data.command)) {
      const hasPlaceholder = data.command.some((c) => typeof c === "string" && c.includes("{model}"));
      if (!hasPlaceholder) {
        errors.push({
          code: "MODEL_PLACEHOLDER_MISSING",
          message: `agent '${String(data.name)}' declares kind: cli and model: '${data.model}', but its command template has no '{model}' placeholder — a declared model that cannot reach the vendor is a lie`,
          file,
        });
      }
    }
  } else if (data.kind === "remote") {
    need("server");
    // NOTES MCP-1B: the member's declared intent → server-call mapping (ruling R5) — which tool on
    // `server`'s connector this member invokes. `params` stays optional: a tool that takes no arguments
    // is legal (validate.ts cannot know a live server's input schema statically; see
    // validateAgentRemoteImplementation below for the deeper, tree-wide cross-entity check).
    need("tool");
  }
}

// NOTES MCP-1B (PRD Amendment 3, ruling R5): `kind: remote` validates cleanly and is a LEGAL
// declaration — but it only produces real work through a real, GRANTED, stdio `kind: mcp` connector
// (a non-empty `argv:`, ruling R1); a `server:` that's missing, wrong-kind, ungranted, or an HTTP/SSE
// connector with no stdio path (ruling R1's still-deferred phase 2) is told plainly here, a warning
// never an error — the declaration is not rejected, the same "fix the telling, not the capability"
// posture REV1 established, now narrowed to name only what remains genuinely unimplemented. Tree-wide
// (needs the connector registry + team grants to resolve), so it only runs when `root` is a directory
// (mirrors validateProposalArtifact's own "no root, no cross-entity check" fail-open posture) — a
// single-file validate (no root) emits no remote warning at all, same as that check.
//
// NOTES MCP-1C (PRD Amendment 3, ruling R3): a FULLY implemented remote agent (`reason === null` below)
// now spawns a real OS process (adapters.ts#createAsyncStdioRemoteBoundary) that goes through the exact
// same sandbox wrap a `kind: cli` agent's spawn does — so it's eligible for the exact same
// SANDBOX_UNAVAILABLE telling a `kind: cli` agent gets when `sandbox.level === "none"`. This function
// only RESOLVES eligibility (returns the implemented agents' names) rather than emitting the warning
// itself — the follow-up to Finding 75 (part 1) collapsed SANDBOX_UNAVAILABLE from one warning per
// affected member to ONE aggregate warning per studio (see validateSandboxTelling, below, the sole
// emitter — Finding 75 part 2 folds `kind: native` into the same aggregate, closing the separate
// SANDBOX_NOT_WRAPPED code that block used to also emit): six identical ~250-char
// per-member paragraphs read as six problems when it is one host/kind fact, and buried doctor's own
// actually-actionable warnings (missing credentials) below the fold. Resolving eligibility here, not
// re-deriving it a second time from bare frontmatter in validateSandboxTelling, keeps the two checks
// from silently disagreeing about which remote agents are "real" as this resolution logic evolves.
function validateAgentRemoteImplementation(root: string, warnings: ValidationWarning[], overlay?: OverlayFile): string[] {
  const implementedRemoteAgents: string[] = [];
  const agentsDir = join(root, "agents");
  if (!existsSync(agentsDir)) return implementedRemoteAgents;

  const teamConnectors = new Map<string, Set<string>>();
  const teamsByMember = new Map<string, string[]>();
  const teamsDir = join(root, "teams");
  if (existsSync(teamsDir)) {
    for (const file of readdirSync(teamsDir).sort()) {
      if (!file.endsWith(".md") || file.endsWith(".learnings.md")) continue;
      let tdata: Record<string, YamlValue>;
      try {
        ({ data: tdata } = parseFrontmatter(readOverlaid(join(teamsDir, file), overlay)));
      } catch {
        continue; // its own PARSE_ERROR was already recorded by the per-file pass.
      }
      const teamName = typeof tdata.name === "string" ? tdata.name : basename(file, ".md");
      teamConnectors.set(teamName, new Set(strList(tdata.connectors)));
      for (const member of strList(tdata.members)) {
        const arr = teamsByMember.get(member) ?? [];
        arr.push(teamName);
        teamsByMember.set(member, arr);
      }
    }
  }

  for (const name of readdirSync(agentsDir).sort()) {
    if (!name.endsWith(".md") || name.endsWith(".learnings.md")) continue;
    const file = join(agentsDir, name);
    let data: Record<string, YamlValue>;
    try {
      ({ data } = parseFrontmatter(readOverlaid(file, overlay)));
    } catch {
      continue; // its own PARSE_ERROR was already recorded by the per-file pass.
    }
    if (data.kind !== "remote") continue;
    const agentName = typeof data.name === "string" ? data.name : basename(name, ".md");
    const serverName = typeof data.server === "string" ? data.server : undefined;
    if (!serverName) continue; // MISSING_FIELD already recorded by validateAgentVariant.

    const connectorFile = join(root, "connectors", `${serverName}.md`);
    let reason: string | null = null;
    if (!existsSync(connectorFile)) {
      reason = `its declared server '${serverName}' is not a known connector`;
    } else {
      let cdata: Record<string, YamlValue>;
      try {
        ({ data: cdata } = parseFrontmatter(readOverlaid(connectorFile, overlay)));
      } catch {
        cdata = {};
      }
      if (cdata.kind !== "mcp") {
        reason = `its declared server '${serverName}' is a kind: '${String(cdata.kind)}' connector, not kind: mcp`;
      } else {
        const argv = cdata.argv;
        const hasArgv = Array.isArray(argv) && argv.length > 0 && argv.every((x) => typeof x === "string");
        if (!hasArgv) {
          reason = `connector '${serverName}' declares no stdio 'argv' — it is either an HTTP/SSE MCP server (ruling R1's still-deferred phase 2) or not yet configured for the stdio path`;
        } else {
          const ownGrant = new Set(strList(data.connectors));
          const teamGrants = new Set((teamsByMember.get(agentName) ?? []).flatMap((t) => [...(teamConnectors.get(t) ?? [])]));
          if (!ownGrant.has(serverName) && !teamGrants.has(serverName)) {
            reason = `connector '${serverName}' is a working stdio kind: mcp connector, but it is not granted to '${agentName}' (agent or team 'connectors:')`;
          }
        }
      }
    }
    if (reason) {
      warnings.push({
        code: "REMOTE_NOT_IMPLEMENTED",
        message: `agent '${agentName}' declares kind: remote — ${reason}; this member will not produce real work until it does (only a real, granted, stdio kind: mcp connector is implemented — PRD Amendment 3 ruling R5)`,
        file,
      });
    } else {
      // NOTES MCP-1C: reached ONLY for a fully implemented remote agent — a real, granted, stdio
      // kind: mcp connector, exactly the case adapters.ts#createAsyncStdioRemoteBoundary spawns for real
      // and sandbox-wraps (ruling R3) — so it's eligible for validateSandboxTelling's own aggregate
      // SANDBOX_UNAVAILABLE warning, alongside every eligible kind: cli agent.
      implementedRemoteAgents.push(agentName);
    }
  }
  return implementedRemoteAgents;
}

// Finding 75 (part 1, follow-up 2026-08-24; part 2, 2026-08-24): the sole emitter of
// SANDBOX_UNAVAILABLE — a STUDIO-LEVEL fact, not a per-member one. The same host lacking bubblewrap is
// not six separate facts because six members happen to be cli/remote/native. ONE warning per studio,
// naming every affected member — mirroring doctor.ts's own already-collapsed `sandboxedAgents` line
// rather than inventing a second, inconsistent shape here. `implementedRemoteAgents` is threaded in from
// validateAgentRemoteImplementation (already resolved there — see its own doc for why this function
// doesn't re-derive it). Tree-wide only (same "no root, no cross-entity telling" posture as
// validateAgentRemoteImplementation) — a single-file validate has no sibling agents to aggregate
// against, so it stays silent on this code, same as before this change (`sandbox` was already only ever
// passed from a directory-tree validatePath call).
//
// Part 2 closes the SANDBOX_NOT_WRAPPED code this function used to also emit: a `kind: native` member's
// spawn now goes through the identical sandbox wrap a `cli`/implemented-`remote` member's does
// (adapters.ts#createSdkNativeBoundary/createAsyncSdkNativeBoundary) — it is folded into the same
// `sandboxedAgents` list below rather than told as a separate, levare-can-never-fix-this fact, because
// that fact is no longer true.
function validateSandboxTelling(root: string, warnings: ValidationWarning[], overlay: OverlayFile | undefined, sandbox: SandboxDetection | undefined, implementedRemoteAgents: string[]): void {
  const agentsDir = join(root, "agents");
  if (!existsSync(agentsDir)) return;

  const sandboxEligibleAgents: string[] = [];
  for (const name of readdirSync(agentsDir).sort()) {
    if (!name.endsWith(".md") || name.endsWith(".learnings.md")) continue;
    let data: Record<string, YamlValue>;
    try {
      ({ data } = parseFrontmatter(readOverlaid(join(agentsDir, name), overlay)));
    } catch {
      continue; // its own PARSE_ERROR was already recorded by the per-file pass.
    }
    const agentName = typeof data.name === "string" ? data.name : basename(name, ".md");
    // NOTES R4-SANDBOX-APPSERVER: a `sandbox: unsandboxed` cli agent is excluded — SANDBOX_DECLARED_
    // UNSANDBOXED (still per-member; each one names its OWN author-given reason, which genuinely does
    // differ member to member, unlike the host/kind fact this function aggregates) is its telling.
    // `native` has no such declared escape hatch (Finding 75 part 2) — every native agent is eligible.
    if (data.kind === "native" || (data.kind === "cli" && data.sandbox !== "unsandboxed")) sandboxEligibleAgents.push(agentName);
  }

  const sandboxedAgents = [...sandboxEligibleAgents, ...implementedRemoteAgents].sort();
  if (sandbox && sandbox.level === "none" && sandboxedAgents.length > 0) {
    warnings.push({
      code: "SANDBOX_UNAVAILABLE",
      message: `no working OS-level sandbox primitive was found on this host (tried: ${sandboxPrimitivesTried(sandbox)}) — these members run unconfined beyond env/HOME scoping: ${sandboxedAgents.join(", ")}; see 'levare doctor' for what was tried`,
      file: agentsDir,
    });
  }
}

// NOTES CAP-B (part B, item 1): `tools:` is a validated fixed enum, not a free-form registry — every
// name must be a real Claude Agent SDK tool name (SDK_TOOL_NAMES, sdk-transport.ts, derived honestly
// from the installed SDK's own tool-schema surface). An unknown name is caught here, at validation
// time, rather than discovered live as a name the SDK boundary silently never matches against
// anything — the vocabulary is named in the error so a studio author can fix it without spelunking.
function validateAgentTools(data: Record<string, YamlValue>, file: string, errors: ValidationError[]): void {
  if (!Array.isArray(data.tools)) return; // shape already caught by the str[] schema check.
  const name = typeof data.name === "string" ? data.name : basename(file, ".md");
  for (const t of data.tools) {
    if (typeof t === "string" && !SDK_TOOL_NAMES.includes(t)) {
      errors.push({
        code: "UNKNOWN_TOOL",
        message: `agent '${name}' declares tool '${t}', which is not a Claude Agent SDK tool name — valid tools: ${SDK_TOOL_NAMES.join(", ")}`,
        file,
      });
    }
  }
}

// NOTES CAP-B (part B, item 3) / NOTES R4-SANDBOX (v2, Ruling 2): a `kind: cli` member's `tools:` still
// cannot be enforced at the PER-TOOL level — there is no SDK boundary in the cli path for a named-tool
// allowlist to reach (adapters.ts's `runCli`/`runCliAsync` spawn the vendor binary directly; `req.tools`
// is read only by the native worker request). Ruling 2's OS-level sandbox narrows the gap around it — a
// sandboxed cli spawn's overall filesystem/network REACH is confined — but it cannot distinguish "may
// use Read" from "may use Write" the way a real tool allowlist would: the sandbox is a coarser boundary
// than `tools:` itself describes, so this warning is narrowed, never silenced, by a working sandbox.
// Warned here (never an error, the same "legal declaration, told plainly" posture
// `validateAgentRemoteImplementation` above takes), and doctor.ts repeats it; the ONLY way to silence it is to remove
// `tools:` — declare the constraint in the connector/command instead, via the vendor's own flags
// (`codex --sandbox read-only` is this repo's own in-tree precedent).
function validateAgentCliToolsWarning(data: Record<string, YamlValue>, file: string, warnings: ValidationWarning[]): void {
  if (data.kind !== "cli" || !Array.isArray(data.tools) || data.tools.length === 0) return;
  const name = typeof data.name === "string" ? data.name : basename(file, ".md");
  warnings.push({
    code: "CLI_TOOLS_NOT_ENFORCEABLE",
    message: `agent '${name}' declares kind: cli and 'tools:' — tools: on a cli member is not enforceable by levare at the per-tool level, even under a working OS sandbox (Ruling 2 narrows the member's overall reach, but does not distinguish between individual named tools) — encode the constraint in the connector/command via the vendor's own flags`,
    file,
  });
}

// NOTES R4-SANDBOX-APPSERVER: `sandbox: unsandboxed` is a deliberate, honest escape hatch from Ruling
// 2's OS sandbox (see types.ts#Agent.sandbox's own doc) — but an undocumented one would be exactly the
// silent-degradation outcome that ruling explicitly refuses. A hard ERROR (not a warning) when the
// reason is missing: unlike SANDBOX_UNAVAILABLE (a HOST fact this studio's author has no control over),
// `sandbox: unsandboxed` is an AUTHOR'S OWN declaration — nothing stops them from also declaring why.
function validateAgentSandboxDeclaration(data: Record<string, YamlValue>, file: string, errors: ValidationError[]): void {
  if (data.sandbox !== "unsandboxed") return;
  const name = typeof data.name === "string" ? data.name : basename(file, ".md");
  if (typeof data.sandbox_reason !== "string" || data.sandbox_reason.trim() === "") {
    errors.push({
      code: "SANDBOX_UNSANDBOXED_NO_REASON",
      message: `agent '${name}' declares sandbox: unsandboxed but no 'sandbox_reason' — a member declared to run OUTSIDE levare's OS sandbox, on any host, needs a documented reason a Conductor can act on`,
      file,
    });
  }
}

// The sibling WARNING to the error above — fires whenever the declaration is legally complete (a reason
// IS present), so a Conductor reading `levare validate`'s output sees this member's unconfined status
// with the SAME plainness `SANDBOX_UNAVAILABLE` already gives a host lacking a primitive — but the two
// codes are deliberately DIFFERENT: this one names a DECLARED, author-chosen exemption; that one names
// a HOST capability gap. Collapsing them would let a Conductor mistake "I decided this" for "my machine
// can't do this," which run on entirely different remedies (fix the declaration vs. fix the host).
function validateAgentSandboxDeclaredWarning(data: Record<string, YamlValue>, file: string, warnings: ValidationWarning[]): void {
  if (data.kind !== "cli" || data.sandbox !== "unsandboxed") return;
  if (typeof data.sandbox_reason !== "string" || data.sandbox_reason.trim() === "") return; // SANDBOX_UNSANDBOXED_NO_REASON already names the incomplete case as an error.
  const name = typeof data.name === "string" ? data.name : basename(file, ".md");
  warnings.push({
    code: "SANDBOX_DECLARED_UNSANDBOXED",
    message: `agent '${name}' declares sandbox: unsandboxed — its process runs OUTSIDE levare's OS sandbox on every host, even where a working primitive exists, by explicit author declaration: ${data.sandbox_reason}`,
    file,
  });
}

function sandboxPrimitivesTried(sandbox: SandboxDetection): string {
  if (sandbox.platform === "linux") return "bubblewrap, unshare";
  if (sandbox.platform === "darwin") return "sandbox-exec";
  return "none available for this platform";
}

// NOTES C13: a connector's `auth:` and `env:` must agree. `auth: env` (default) is levare's
// enforced grant — an empty env list declares nothing for the Runner to inject or scope, so it's a
// definition error, not a connector with nothing to do. `auth: subscription` names a backend that
// authenticates itself from its own stored credentials — declaring env vars there would claim an
// enforcement levare does not and cannot provide, so it's rejected the same way.
function validateConnectorAuth(data: Record<string, YamlValue>, file: string, errors: ValidationError[]): void {
  const auth = data.auth === "subscription" ? "subscription" : "env";
  const env = Array.isArray(data.env) ? data.env : [];
  const name = typeof data.name === "string" ? data.name : basename(file, ".md");
  if (auth === "env" && env.length === 0) {
    errors.push({
      code: "EMPTY_ENV",
      message: `connector '${name}' declares auth: env but names no env vars — an env-authenticated connector has nothing for levare to inject or scope; declare 'auth: subscription' if the backend authenticates itself instead`,
      file,
    });
  }
  if (auth === "subscription" && env.length > 0) {
    errors.push({
      code: "SUBSCRIPTION_WITH_ENV",
      message: `connector '${name}' declares auth: subscription but also names env vars (${env.join(", ")}) — a subscription-authenticated backend has nothing to declare, and levare cannot scope its credential either way`,
      file,
    });
  }
}

// NOTES C15: `role` is new and optional, defaulting to "tool" — but a pre-C15 studio's `auth:
// subscription` connector (the canonical model-access shape, per C13) predates the field entirely,
// and silently defaulting it to "tool" would mislabel exactly the connector this ruling exists to
// name correctly. A warning, not an error (REV1 warnings channel — the declaration is legal, just
// possibly incomplete): fires only when `role` is genuinely absent, so declaring EITHER role
// explicitly (including `role: tool`, for a subscription-authenticated tool connector) silences it.
function validateConnectorRoleWarning(data: Record<string, YamlValue>, file: string, warnings: ValidationWarning[]): void {
  if (data.auth !== "subscription" || data.role !== undefined) return;
  const name = typeof data.name === "string" ? data.name : basename(file, ".md");
  warnings.push({
    code: "SUBSCRIPTION_NO_ROLE",
    message: `connector '${name}' is subscription-authenticated but declares no role — if it provides model access, declare 'role: model'`,
    file,
  });
}

// NOTES CAP-B (part B, item 4): the sibling to SUBSCRIPTION_NO_ROLE above, for the same "legal but
// worth flagging" family — a subscription connector with no `home:` gives every member it's granted to
// the OPERATOR'S ENTIRE `$HOME` (today's pre-CAP-B behaviour, unchanged, still the default). Declaring
// `home:` is what actually scopes the credential (env.ts#scopeHome); this warning is how a studio
// author discovers that opt-in exists at all, rather than assuming a bare `auth: subscription` grant is
// already scoped. Fires only when `home` is genuinely absent — declaring it (even `home: []`, though
// that scopes to nothing) silences it.
function validateConnectorHomeWarning(data: Record<string, YamlValue>, file: string, warnings: ValidationWarning[]): void {
  if (data.auth !== "subscription" || data.home !== undefined) return;
  const name = typeof data.name === "string" ? data.name : basename(file, ".md");
  warnings.push({
    code: "SUBSCRIPTION_NO_HOME",
    message: `connector '${name}' is subscription-authenticated but declares no 'home:' — the member receives your entire HOME; declare the vendor's config path (e.g. 'home: [".codex"]') to scope it`,
    file,
  });
}

// NOTES R4-SANDBOX-APPSERVER: a subscription connector's `home:` names dotpaths under the real HOME
// (e.g. `.codex`) to symlink into a granted member's scratch HOME — but the connector's own `command`
// (e.g. `codex`) is frequently NOT a plain binary sitting loose on PATH; it's a version-manager SHIM
// (Volta, nvm, asdf, mise, pyenv, rbenv all install this way) — a small script/binary at, say,
// `~/.volta/bin/codex` that reads the manager's OWN bookkeeping under `~/.volta/...` to find which
// real, manager-installed binary to actually exec. `home: [".codex"]` alone gives that shim a scratch
// HOME with no `.volta` entry at all — the shim fails to resolve anything, surfacing as the MANAGER's
// own error ("Volta error: Could not find executable \"codex\""), naming a tool the operator will
// wrongly go debug, never levare's own scoping decision. Confirmed live (NOTES R4-SANDBOX-APPSERVER's
// own elimination table): adding the manager's own root to `home:` (`[".codex", ".volta"]`) clears
// this specific failure and lets the dispatch proceed to whatever the connector's real backend does
// next.
//
// This is deliberately NOT auto-granted — a version-managed binary cannot be scoped narrowly at all:
// granting `.volta` exposes every toolchain Volta manages under this operator's account, not just the
// one connector being defined, and only the connector's own author can judge whether that tradeoff is
// acceptable for this studio (named explicitly in the warning text below, and in the docs). This
// function only NAMES the gap — a pure function over an already-resolved command path, a connector's
// declared `home:` list, and the real HOME — so both `validateConnectorHomeShimWarning` (schema-time,
// fed a real `Bun.which` resolution) and `doctor.ts#diagnose` (host-check time) can surface the
// identical finding in levare's own voice, rather than leaving the manager's own confusing error as
// the only signal an operator ever sees.
export interface VersionManagerRoot {
  /** Human-readable name, e.g. "Volta" — used in the warning text, never parsed. */
  manager: string;
  /** The manager's own root dotpath under HOME, e.g. ".volta" — what `home:` would need to add. */
  dotpath: string;
}

// Every version manager this project has independent evidence for (Volta, live-confirmed; the rest
// are the SAME shim-under-a-HOME-dotpath shape by their own documented install layout, named per the
// goal's own "not codex-specific in principle" scope — a `cli` member is a first-class member kind,
// and any vendor CLI installed through a shim hits the identical wall — not independently
// live-verified each). mise defaults to XDG (`~/.local/share/mise`), not a single dotdir — named as
// its own two-segment dotpath rather than forcing a fictional `.mise` entry that doesn't exist on disk.
export const VERSION_MANAGER_HOME_ROOTS: VersionManagerRoot[] = [
  { manager: "Volta", dotpath: ".volta" },
  { manager: "nvm", dotpath: ".nvm" },
  { manager: "asdf", dotpath: ".asdf" },
  { manager: "mise", dotpath: ".local/share/mise" },
  { manager: "pyenv", dotpath: ".pyenv" },
  { manager: "rbenv", dotpath: ".rbenv" },
];

/**
 * `resolvedCommandPath` (a real `Bun.which`/PATH resolution result, or `undefined` when the command
 * isn't found at all — nothing to detect a gap in) — does it sit under a known version manager's own
 * root, under `home`, that `declaredHome` does NOT already cover? Returns the FIRST matching root, or
 * `undefined` when the resolved path isn't under HOME at all (a system-wide install, e.g. `/usr/bin`
 * or a plain Homebrew prefix — no shim, no gap), isn't under any known manager's root, or the
 * manager's root (or an ancestor entry covering it) is already among `declaredHome`'s own dotpaths.
 */
export function detectVersionManagerHomeGap(resolvedCommandPath: string | undefined, declaredHome: string[], home: string): VersionManagerRoot | undefined {
  if (!resolvedCommandPath) return undefined;
  const rel = relative(home, resolvedCommandPath);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  for (const root of VERSION_MANAGER_HOME_ROOTS) {
    if (rel !== root.dotpath && !rel.startsWith(`${root.dotpath}/`)) continue;
    const granted = declaredHome.some((d) => d === root.dotpath || d.startsWith(`${root.dotpath}/`));
    return granted ? undefined : root;
  }
  return undefined;
}

// NOTES R4-SANDBOX-APPSERVER: fires at STUDIO VALIDATION time, using a real `Bun.which` resolution
// against THIS host's own PATH — the same "host-aware but never assumed" posture `validateSandboxTelling`
// already takes for `SANDBOX_UNAVAILABLE` (both are optional-injection, host-dependent checks; this one
// isn't threaded through `validatePath`'s own `sandbox?` parameter because it needs no probe/spawn, only
// a cheap PATH lookup already safe to run unconditionally — the same posture `hasResolvableLocalPath`
// elsewhere in this file already takes for a live `existsSync` check). `which`/`home` are injectable
// (test-only — production always uses the real ones) so `tests/capability-cap-b.test.ts` can pin the
// exact shim-under-HOME shape without mutating this process's own real PATH/HOME. The default passes
// `{ PATH: process.env.PATH }` explicitly rather than calling bare `Bun.which(cmd)` — proven live in
// this container: `Bun.which` without an explicit `PATH` option resolves against whatever PATH the Bun
// process itself started with, NOT a runtime mutation of `process.env.PATH` — the same integration
// test that pins this warning's wiring caught the difference directly.
function validateConnectorHomeShimWarning(
  data: Record<string, YamlValue>,
  file: string,
  warnings: ValidationWarning[],
  which: (cmd: string) => string | null = (cmd) => Bun.which(cmd, { PATH: process.env.PATH ?? "" }),
  home: string | undefined = process.env.HOME,
): void {
  if (data.auth !== "subscription" || !Array.isArray(data.home) || data.home.length === 0) return;
  if (typeof data.command !== "string" || !data.command || !home) return;
  const declaredHome = data.home.filter((h): h is string => typeof h === "string");
  const gap = detectVersionManagerHomeGap(which(data.command) ?? undefined, declaredHome, home);
  if (!gap) return;
  const name = typeof data.name === "string" ? data.name : basename(file, ".md");
  warnings.push({
    code: "SUBSCRIPTION_HOME_SHIM_GAP",
    message: `connector '${name}' declares home: [${declaredHome.join(", ")}] but '${data.command}' resolves through ${gap.manager} (~/${gap.dotpath}), which is not in that list — a version-managed binary cannot be scoped narrowly: add '${gap.dotpath}' to home: too (this exposes every toolchain ${gap.manager} manages, not just this connector) or install '${data.command}' outside a version manager. Left as-is, a scoped member's spawn fails with ${gap.manager}'s own "could not find executable" error, not levare's — see 'levare doctor' for the same finding in this host's own live context.`,
    file,
  });
}

// NOTES SEC-V11 F1 (HIGH): a `home:` dotpath is joined straight onto both the real HOME and the
// scratch HOME (env.ts#scopeHome) with no validation before this fix — a connector declaring
// `home: ["../../.ssh"]` would resolve its symlink TARGET above the real HOME (reading anything the
// operator's own user can read) and place the LINK itself outside the scratch dir the caller believes
// it owns and cleans up, so a traversal entry would leave a live, unrevoked symlink to an arbitrary
// path behind forever. This is layer one of the two-layer fix (schema-time rejection); env.ts#scopeHome
// carries the SAME check independently at runtime (defense in depth — a caller that ever bypasses
// validate.ts, or a future refactor that drops this call, must not regain the hole). Exported so
// env.ts can share the identical definition of "safe" rather than maintaining a second copy that could
// drift out of agreement with this one.
export function isSafeHomeDotpath(p: string): boolean {
  if (typeof p !== "string" || p.length === 0) return false;
  if (p.includes("\0")) return false;
  if (isAbsolute(p)) return false;
  if (p === "." || p === "..") return false;
  // Reject a ".." segment anywhere, or an empty segment (a stray "//"), before even normalizing —
  // belt-and-suspenders ahead of the normalize-based check below, which alone would already catch
  // these, but a segment-level check reads its own intent without relying on `normalize`'s semantics.
  const segments = p.split("/");
  if (segments.some((s) => s === "..")) return false;
  const normalized = normalize(p);
  if (normalized === ".." || normalized === "." || normalized.startsWith("../") || isAbsolute(normalized)) return false;
  return true;
}

function validateConnectorHomeSafety(data: Record<string, YamlValue>, file: string, errors: ValidationError[]): void {
  if (!Array.isArray(data.home)) return; // shape (str[]) already enforced by the schema.
  const name = typeof data.name === "string" ? data.name : basename(file, ".md");
  for (const entry of data.home) {
    if (typeof entry !== "string") continue; // already BAD_TYPE from the schema.
    if (!isSafeHomeDotpath(entry)) {
      errors.push({
        code: "UNSAFE_HOME_PATH",
        message: `connector '${name}' declares home: entry '${entry}', which is not a safe relative dotpath under HOME — traversal ('..'), absolute paths, and empty segments are rejected`,
        file,
      });
    }
  }
}

// NOTES SEC-V11 F4 (LOW, hardening): a heuristic warning, never an error — a param value substituted
// into an argv template is always injection-safe by construction (one template element → one argv
// element, no shell — CAP-A's own closed claim, unaffected by this), but if the connector author places
// a `{placeholder}` in argv-LEADING position (nothing flag-shaped immediately before it), the MEMBER's
// chosen value lands where a flag would normally go — e.g. `["gh", "{args}"]` lets a proposal's own
// `args` param supply `--upload-pack=...`-shaped content that `gh` then interprets as an option, not a
// positional value. This is an author footgun in the connector's own template, not a member-injection
// hole (the member still only ever supplies a value the author's own template slot accepts) — so it's a
// WARNING naming the position, never a validation error; a template with a genuinely positional
// argument (no flag before it) is a legal, common shape (e.g. `["cp", "{src}", "{dst}"]`) this heuristic
// cannot distinguish from the risky case, which is why it stays advisory (documented limit, NOTES).
function validateActionPlaceholderPosition(data: Record<string, YamlValue>, file: string, warnings: ValidationWarning[]): void {
  const actions = data.actions;
  if (actions === null || typeof actions !== "object" || Array.isArray(actions)) return;
  const name = typeof data.name === "string" ? data.name : basename(file, ".md");
  const placeholderRe = /\{[A-Za-z_][A-Za-z0-9_]*\}/;
  for (const [actionName, template] of Object.entries(actions as Record<string, YamlValue>)) {
    if (!Array.isArray(template)) continue; // shape already caught elsewhere.
    for (let i = 0; i < template.length; i++) {
      const el = template[i];
      if (typeof el !== "string" || !placeholderRe.test(el)) continue;
      const prev = i > 0 ? template[i - 1] : undefined;
      const precededByFlag = typeof prev === "string" && prev.startsWith("-");
      if (!precededByFlag) {
        warnings.push({
          code: "PLACEHOLDER_NOT_IN_VALUE_POSITION",
          message: `connector '${name}' action '${actionName}' places a placeholder at argv position ${i} ('${el}') with nothing flag-shaped immediately before it — a placeholder should sit in value position after its flag, or the value could be interpreted as an option`,
          file,
        });
      }
    }
  }
}

// NOTES CAP-A: `gate` is only meaningful for an `effects: write` connector, and an `effects: write`
// connector must declare its action vocabulary (`actions:`) — a member drafting a proposal can only
// ever name an action the connector's OWN author declared, never raw argv (item 1). Mirrors
// validateConnectorAuth's own "shape-only in the schema, cross-field agreement here" split.
function validateConnectorEffects(data: Record<string, YamlValue>, file: string, errors: ValidationError[]): void {
  const effects = data.effects === "write" ? "write" : "read";
  const name = typeof data.name === "string" ? data.name : basename(file, ".md");
  if (data.gate !== undefined && effects !== "write") {
    errors.push({
      code: "GATE_ON_READ_CONNECTOR",
      message: `connector '${name}' declares 'gate' but is effects: read — gate is only meaningful for an effects: write connector`,
      file,
    });
  }
  if (effects === "write") {
    const actions = data.actions;
    const hasActions = actions !== null && typeof actions === "object" && !Array.isArray(actions) && Object.keys(actions).length > 0;
    if (!hasActions) {
      errors.push({
        code: "MISSING_ACTIONS",
        message: `connector '${name}' declares effects: write but names no 'actions' — a write connector must declare its argv template vocabulary so a member can never supply raw argv`,
        file,
      });
    }
  } else if (data.actions !== undefined) {
    errors.push({
      code: "ACTIONS_ON_READ_CONNECTOR",
      message: `connector '${name}' declares 'actions' but is effects: read — actions are only meaningful for an effects: write connector`,
      file,
    });
  }
}

// ---------------------------------------------------------------------------
// Fetch-at-dispatch MCP launcher detection (NOTES MCP-1C addendum 6)
// ---------------------------------------------------------------------------
//
// The Conductor's ruling on closing MCP-1C item #4 (a live-macOS `npx -y`-spawned connector hanging for
// 60s under a working sandbox): this is a SECURITY ruling, not a bug to engineer around by widening the
// sandbox. `npx -y`/`bunx`/`pnpm dlx`/`yarn dlx` all mean the same thing — "download whatever is at this
// name right now and execute it" — the exact untrusted-code shape the R4 sandbox exists to contain,
// happening at dispatch time instead of at `npm install` time. A pre-installed server, spawned by a
// resolved path, is auditable and gets a narrow, per-connector grant (adapters.ts#
// argvScriptReadOnlyPaths, NOTES MCP-1C addendum 3); a fetch-at-dispatch server's real code lands in an
// npm/npx/bun cache under the operator's own HOME — unreachable and unreferenced anywhere in argv, so
// there is nothing this sandbox could ever grant a narrow path to. That gap is WHY it hung rather than
// erred: the interpreter blocked on a denied read instead of exiting cleanly (the same "blocked process,
// not a crash" shape addendum 3 already found one layer down, for a local script instead of a cache dir).

interface FetchRunnerSpec {
  /** The launcher's resolved basename (argv[0], stripped of any directory prefix) — matched literally,
   *  never a substring, so e.g. "npx" never accidentally matches a connector's own "my-npx-wrapper". */
  basename: string;
  /** When set, this launcher is a general-purpose CLI (pnpm, yarn) that only fetches-and-runs under a
   *  specific SUBCOMMAND — the launcher's mere presence in argv[0] says nothing on its own. Absent means
   *  the launcher IS the fetch-and-run mode by itself (npx, bunx have no other purpose). */
  subcommand?: string;
}

// The named, extensible runner set — new package runners belong here, never as a one-off string match
// bolted onto the detection function itself. Today's known fetch-and-run launchers; not an exhaustive
// claim about every package runner that will ever exist.
const FETCH_AND_RUN_LAUNCHERS: FetchRunnerSpec[] = [
  { basename: "npx" }, // esp. dangerous with -y/--yes, which skips the "install this?" confirmation too
  { basename: "bunx" },
  { basename: "pnpm", subcommand: "dlx" },
  { basename: "yarn", subcommand: "dlx" },
];

export interface FetchAtDispatchLauncher {
  /** The matched launcher's own basename, e.g. "npx". */
  runner: string;
  /** The matched subcommand, when the launcher needed one (e.g. "dlx"). Undefined for npx/bunx. */
  subcommand?: string;
}

/**
 * Detects a `kind: mcp` connector's argv invoking a known package-runner in fetch-and-run mode. Matches
 * on the resolved BASENAME of argv[0] (never the full path — a connector may legitimately reference an
 * absolute install of npx, e.g. `/usr/local/bin/npx`), so this can never be defeated by where the
 * launcher itself happens to live on a given host, only by what it's actually a launcher FOR.
 *
 * A match is treated as fetch-at-dispatch UNLESS argv also names a resolvable, absolute path to an
 * EXISTING local file — the same "interpreter + local script" shape adapters.ts#argvScriptReadOnlyPaths
 * already grants narrowly. That carve-out is deliberate: a locally-installed server invoked THROUGH a
 * runner (e.g. `npx /abs/path/to/installed-server.js`) is a resolved-path dispatch like any other, not a
 * bare-package fetch — it's the "download a package NAME" case this function exists to catch, not every
 * invocation of npx/bunx/etc. on principle.
 */
export function detectFetchAtDispatchLauncher(argv: string[]): FetchAtDispatchLauncher | null {
  if (argv.length === 0) return null;
  const launcherBase = basename(argv[0]);
  const spec = FETCH_AND_RUN_LAUNCHERS.find((s) => s.basename === launcherBase);
  if (!spec) return null;
  const rest = argv.slice(1);
  if (spec.subcommand && !rest.includes(spec.subcommand)) return null;
  const hasResolvableLocalPath = rest.some((el) => isAbsolute(el) && existsSync(el) && statSync(el).isFile());
  if (hasResolvableLocalPath) return null;
  return { runner: launcherBase, subcommand: spec.subcommand };
}

// A legal-but-unsupported-under-sandbox declaration — the SAME honesty-layer posture
// REMOTE_NOT_IMPLEMENTED/SANDBOX_UNAVAILABLE above take: tell plainly at validate time, never reject the
// declaration outright, because whether it actually matters depends on the host that ends up dispatching
// it. A host with no working sandbox primitive at all (this container's own standing reality) runs it
// exactly as before — no regression for that case. `adapters.ts#createAsyncStdioRemoteBoundary` re-runs
// this SAME detection at dispatch time and turns it into a hard, fail-fast AdapterError specifically when
// a working sandbox primitive IS present — replacing what used to be a silent 60s hang against a denied
// cache with an immediate, named refusal, mirroring how `kind: remote`'s own REV1 warnings stay warnings
// here and only bite as an actual constraint once something tries to really run under confinement.
function validateConnectorFetchAtDispatch(data: Record<string, YamlValue>, file: string, warnings: ValidationWarning[]): void {
  if (data.kind !== "mcp") return;
  const argv = data.argv;
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((x) => typeof x === "string")) return;
  const launcher = detectFetchAtDispatchLauncher(argv as string[]);
  if (!launcher) return;
  const name = typeof data.name === "string" ? data.name : basename(file, ".md");
  const invocation = launcher.subcommand ? `${launcher.runner} ${launcher.subcommand}` : launcher.runner;
  warnings.push({
    code: "MCP_FETCH_AT_DISPATCH",
    message: `connector '${name}' spawns its server via '${invocation}', a package runner that fetches and executes a package at dispatch time — the same untrusted-code shape the R4 sandbox exists to contain, now happening at dispatch instead of at install. This cannot be confined under a working sandbox: the fetched server's real code lands in an npm/npx/bun cache under the operator's own HOME, a location no connector argv references and none is granted. Install the server locally instead and reference its resolved script or binary path directly in this connector's argv (a locally-installed server invoked THROUGH a runner is unaffected by this warning) — see docs/guide/04-workflow/05-foreign-agent.md. Dispatching this connector on a host with a working sandbox primitive is refused outright rather than left to hang.`,
    file,
  });
}

// ---------------------------------------------------------------------------
// Known-model validation (NOTES F11) — a model that cannot be priced cannot be declared
// ---------------------------------------------------------------------------
//
// `knowledge/model-pricing.md` is the single known-model set: the same table `pricing.ts` reads to
// price a usage receipt's USD estimate. An agent (any kind) or the studio's own `orchestrator_model`
// naming a model absent from that table is rejected here, at validation time — never discovered live,
// as an unpriceable receipt or (worse) a silently-substituted default model on a member the Conductor
// specifically chose for its capability.
//
// Fail-open when the table itself is absent or empty (consistent with this validator's other
// unverifiable-state postures, e.g. the git-immutability check's S0/S1): a target with no pricing
// table at all has nothing to check a declared model against, and a subtree fixture that never
// declares a knowledge/ directory (most rejection fixtures, most ad hoc test studios) is not making a
// pricing claim this check could meaningfully validate.

/** Every agent name → its declared `model:`, when present, from `agents/*.md`. */
function declaredAgentModels(
  agentsDir: string,
  overlay?: OverlayFile,
): Array<{ agentName: string; model: string; file: string }> {
  const out: Array<{ agentName: string; model: string; file: string }> = [];
  if (!existsSync(agentsDir)) return out;
  for (const name of readdirSync(agentsDir).sort()) {
    if (!name.endsWith(".md") || name.endsWith(".learnings.md")) continue;
    const file = join(agentsDir, name);
    let data: Record<string, YamlValue>;
    try {
      ({ data } = parseFrontmatter(readOverlaid(file, overlay)));
    } catch {
      continue; // its own PARSE_ERROR was already recorded by the per-file pass.
    }
    if (typeof data.model === "string") {
      const agentName = typeof data.name === "string" ? data.name : basename(name, ".md");
      out.push({ agentName, model: data.model, file });
    }
  }
  return out;
}

// NOTES C15 (re-keyed from C13): agent names granted (directly or via their team) at least one
// `role: model` connector — a member whose model arrives through a connector (subscription OR env
// auth) declares a `model:` this table can't price the same way a native member's is priced, so it's
// exempt from UNKNOWN_MODEL below. This is what the exemption always meant; C13 approximated it as
// "granted ANY subscription connector" because `role` didn't exist yet, which over-exempted (a
// subscription TOOL connector, possible in principle, exempted an agent's model from pricing
// validation for no reason) and under-exempted (an env-authenticated model connector didn't exempt
// at all). Hand-parsed straight off disk (not via repo.ts's loadRepo), matching every other
// cross-entity check in this file, so validation stays independent of a fully-loadable repo.
function modelRoleAgents(root: string, overlay?: OverlayFile): Set<string> {
  const out = new Set<string>();
  const connectorsDir = join(root, "connectors");
  if (!existsSync(connectorsDir)) return out;

  const modelConnectors = new Set<string>();
  for (const file of readdirSync(connectorsDir).sort()) {
    if (!file.endsWith(".md")) continue;
    let data: Record<string, YamlValue>;
    try {
      ({ data } = parseFrontmatter(readOverlaid(join(connectorsDir, file), overlay)));
    } catch {
      continue;
    }
    if (data.role === "model") {
      modelConnectors.add(typeof data.name === "string" ? data.name : basename(file, ".md"));
    }
  }
  if (modelConnectors.size === 0) return out;

  // team name → its own connector grants, and which agents are its members.
  const teamConnectorsByMember = new Map<string, Set<string>>();
  const teamsDir = join(root, "teams");
  if (existsSync(teamsDir)) {
    for (const file of readdirSync(teamsDir).sort()) {
      if (!file.endsWith(".md") || file.endsWith(".learnings.md")) continue;
      let data: Record<string, YamlValue>;
      try {
        ({ data } = parseFrontmatter(readOverlaid(join(teamsDir, file), overlay)));
      } catch {
        continue;
      }
      const connectors = strList(data.connectors);
      for (const member of strList(data.members)) {
        const set = teamConnectorsByMember.get(member) ?? new Set<string>();
        for (const c of connectors) set.add(c);
        teamConnectorsByMember.set(member, set);
      }
    }
  }

  const agentsDir = join(root, "agents");
  if (existsSync(agentsDir)) {
    for (const file of readdirSync(agentsDir).sort()) {
      if (!file.endsWith(".md") || file.endsWith(".learnings.md")) continue;
      let data: Record<string, YamlValue>;
      try {
        ({ data } = parseFrontmatter(readOverlaid(join(agentsDir, file), overlay)));
      } catch {
        continue;
      }
      const agentName = typeof data.name === "string" ? data.name : basename(file, ".md");
      const granted = new Set<string>([...strList(data.connectors), ...(teamConnectorsByMember.get(agentName) ?? [])]);
      for (const g of granted) {
        if (modelConnectors.has(g)) {
          out.add(agentName);
          break;
        }
      }
    }
  }
  return out;
}

function validateKnownModels(root: string, errors: ValidationError[], overlay?: OverlayFile): void {
  // NOTES F23: `loadPricing` always includes the binary's own baseline table now, so this never
  // fails open on an unconfigured studio — a fresh studio with no knowledge/model-pricing.md at all
  // is still checked against every real, currently-callable model the binary ships.
  const pricing: Pricing = loadPricing(root, overlay);
  const exemptAgents = modelRoleAgents(root, overlay);

  for (const { agentName, model, file } of declaredAgentModels(join(root, "agents"), overlay)) {
    if (exemptAgents.has(agentName)) continue; // C15: model arrives through a connector, not priced here.
    if (!pricing.has(model)) {
      errors.push({
        code: "UNKNOWN_MODEL",
        message: `agent '${agentName}' declares model '${model}', which is not in knowledge/model-pricing.md's known-model set — an unpriceable model means silently wrong cost accounting`,
        file,
      });
    }
  }

  const studioFile = join(root, "studio.md");
  if (existsSync(studioFile)) {
    let data: Record<string, YamlValue>;
    try {
      ({ data } = parseFrontmatter(readOverlaid(studioFile, overlay)));
    } catch {
      data = {};
    }
    if (typeof data.orchestrator_model === "string" && !pricing.has(data.orchestrator_model)) {
      errors.push({
        code: "UNKNOWN_MODEL",
        message: `studio declares orchestrator_model '${data.orchestrator_model}', which is not in knowledge/model-pricing.md's known-model set — an unpriceable model means silently wrong cost accounting`,
        file: studioFile,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Studio bindability (NOTES F1) — is this studio structurally RUNNABLE?
//
// The defect this closes: `levare validate` said "valid" about a studio that could not run a single
// step. Every per-file schema check passed; what nothing checked was the one cross-entity fact the
// whole Runner rests on — that each flow step a team declares binds to a member that declares it can
// produce a matching kind. That binding failure surfaced only at runtime, inside the daemon, on the
// unit's first step. A studio whose teams cannot bind is not "valid with a runtime surprise ahead";
// it is invalid, and it is told so here, naming the team, the kind, and the members it looked at.
//
// This is the same resolution rule the Runner applies (flow.ts#resolveStep, NOTES B2): a step label
// binds to a member producing `kind === label` or `kind.endsWith("-" + label)`; zero matches or more
// than one is a hard failure, never a silent guess. `kindMatches` is imported from flow.ts (NOTES R3)
// — a dependency-light leaf module that imports only types.ts, so validate.ts (which repo.ts, in
// turn, imports) can depend on it without closing an import cycle back to runner.ts.
// ---------------------------------------------------------------------------

/** Every flow step label a team's flow declares, in order — plain steps plus both halves of a loop. */
function flowStepLabels(flow: YamlValue): string[] {
  const labels: string[] = [];
  if (!Array.isArray(flow)) return labels;
  for (const node of flow) {
    if (node === null || typeof node !== "object" || Array.isArray(node)) continue;
    const m = node as Record<string, YamlValue>;
    if (typeof m.step === "string") labels.push(m.step);
    if (m.loop !== null && typeof m.loop === "object" && !Array.isArray(m.loop)) {
      const between = (m.loop as Record<string, YamlValue>).between;
      if (Array.isArray(between)) for (const b of between) if (typeof b === "string") labels.push(b);
    }
  }
  return labels;
}

function strList(v: YamlValue): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * Reject a studio that cannot run: a team promising a kind no member of it produces, or a flow step
 * that binds to no member (or to more than one — an ambiguity the Runner refuses to guess through).
 * Runs only for a tree carrying BOTH `teams/` and `agents/` — the two halves of the binding; a
 * subtree with only one of them (a rejection fixture, a single registry file) is not a studio and
 * has nothing to bind.
 */
function validateStudioBindings(root: string, errors: ValidationError[], overlay?: OverlayFile): void {
  const teamsDir = join(root, "teams");
  const agentsDir = join(root, "agents");
  if (!existsSync(teamsDir) || !existsSync(agentsDir)) return;

  // agent name → the kinds it declares it can produce.
  const produces = new Map<string, string[]>();
  for (const name of readdirSync(agentsDir).sort()) {
    if (!name.endsWith(".md") || name.endsWith(".learnings.md")) continue;
    let data: Record<string, YamlValue>;
    try {
      ({ data } = parseFrontmatter(readOverlaid(join(agentsDir, name), overlay)));
    } catch {
      continue; // its own PARSE_ERROR was already recorded by the per-file pass.
    }
    if (typeof data.name === "string") produces.set(data.name, strList(data.produces));
  }

  for (const file of readdirSync(teamsDir).sort()) {
    if (!file.endsWith(".md") || file.endsWith(".learnings.md")) continue;
    const path = join(teamsDir, file);
    let data: Record<string, YamlValue>;
    try {
      ({ data } = parseFrontmatter(readOverlaid(path, overlay)));
    } catch {
      continue;
    }
    const team = typeof data.name === "string" ? data.name : basename(file, ".md");
    const members = strList(data.members);
    // What this team's members can actually produce, and how each is described in an error message.
    const caps: Array<{ member: string; kind: string }> = [];
    for (const m of members) for (const kind of produces.get(m) ?? []) caps.push({ member: m, kind });
    const roster = members
      .map((m) => {
        const ks = produces.get(m);
        if (ks === undefined) return `${m} (no agent definition)`;
        return ks.length ? `${m} produces [${ks.join(", ")}]` : `${m} produces nothing`;
      })
      .join("; ");

    // (1) A promise the team cannot keep: `produces: [k]` with no member producing k.
    for (const kind of strList(data.produces)) {
      if (caps.some((c) => c.kind === kind)) continue;
      errors.push({
        code: "UNPRODUCIBLE_KIND",
        message:
          `team '${team}' declares it produces '${kind}', but no member of it declares '${kind}' in its own 'produces': ` +
          `${roster || "the team has no members"}`,
        file: path,
      });
    }

    // (2) A flow step no member can satisfy — the exact failure the Runner would hit on this unit's
    // first walk, hoisted to validation time so it is a studio error, not a runtime surprise.
    for (const label of flowStepLabels(data.flow)) {
      const matches = caps.filter((c) => kindMatches(c.kind, label));
      if (matches.length === 0) {
        errors.push({
          code: "UNBINDABLE_STEP",
          message:
            `flow step '${label}' in team '${team}' binds to no member: no member produces a kind matching it ` +
            `(a kind matches when it equals the step label or ends with '-${label}'): ${roster || "the team has no members"}`,
          file: path,
        });
      } else if (matches.length > 1) {
        errors.push({
          code: "AMBIGUOUS_STEP",
          message:
            `flow step '${label}' in team '${team}' is ambiguous — it binds to ${matches.map((c) => `${c.member}:${c.kind}`).join(", ")}; ` +
            "the Runner never guesses between two producers",
          file: path,
        });
      }
    }

    // (3) Ruling F16: a loop whose `until` names a kind neither of its own two members can ever
    // produce is unsatisfiable BY CONSTRUCTION — no round the loop ever runs could make it true, so
    // the walk would sit at that loop forever (or, worse, silently fall through past it once its two
    // members happen to both resolve for unrelated reasons). Caught here, at studio-definition time,
    // the same "name what cannot bind, don't discover it live" posture as UNBINDABLE_STEP above —
    // never a live surprise.
    for (const node of Array.isArray(data.flow) ? data.flow : []) {
      if (node === null || typeof node !== "object" || Array.isArray(node)) continue;
      const m = node as Record<string, YamlValue>;
      if (m.loop === null || typeof m.loop !== "object" || Array.isArray(m.loop)) continue;
      const loop = m.loop as Record<string, YamlValue>;
      const between = Array.isArray(loop.between) ? loop.between.filter((x): x is string => typeof x === "string") : [];
      const until = typeof loop.until === "string" ? loop.until : "";
      if (between.length !== 2 || !until) continue; // malformed shape — parseFlow/schema catch this elsewhere.
      const untilKind = until.split(".")[0];
      const resolvedKinds = new Set<string>();
      for (const label of between) for (const c of caps) if (kindMatches(c.kind, label)) resolvedKinds.add(c.kind);
      if (!resolvedKinds.has(untilKind)) {
        errors.push({
          code: "LOOP_UNTIL_UNREACHABLE",
          message:
            `team '${team}' loop between [${between.join(", ")}] has until '${until}', but '${untilKind}' matches neither loop ` +
            `member's resolved kind (${[...resolvedKinds].join(", ") || "none bound"}) — this loop could never satisfy its own ` +
            "exit condition (ruling F16)",
          file: path,
        });
      }
    }
  }
}

/**
 * levare's model is one team per agent: teams are reused across projects, but an agent is never
 * reused across teams. `env.ts#teamOf` resolves a member's team by returning the FIRST team whose
 * `members` lists it — so an agent named in more than one team's `members` silently gets only that
 * first team's connector grants and charter (guardrails, knowledge, style) everywhere else in the
 * studio; the second team's membership is not an error anywhere else, it is just silently ignored.
 * That is a silent-wrong-answer bug, not a runtime crash, so it is caught here instead: naming the
 * agent and every team that lists it. The fix is never to share one agent definition across teams —
 * duplicate and rename the agent per team instead (e.g. `scribe-press`, `scribe-docs`).
 */
function validateAgentTeamMembership(root: string, errors: ValidationError[], overlay?: OverlayFile): void {
  const teamsDir = join(root, "teams");
  if (!existsSync(teamsDir)) return;

  const teamsByMember = new Map<string, string[]>();
  for (const file of readdirSync(teamsDir).sort()) {
    if (!file.endsWith(".md") || file.endsWith(".learnings.md")) continue;
    let data: Record<string, YamlValue>;
    try {
      ({ data } = parseFrontmatter(readOverlaid(join(teamsDir, file), overlay)));
    } catch {
      continue; // its own PARSE_ERROR was already recorded by the per-file pass.
    }
    const team = typeof data.name === "string" ? data.name : basename(file, ".md");
    for (const member of strList(data.members)) {
      const arr = teamsByMember.get(member) ?? [];
      arr.push(team);
      teamsByMember.set(member, arr);
    }
  }

  for (const [member, teams] of [...teamsByMember].sort(([a], [b]) => a.localeCompare(b))) {
    if (teams.length <= 1) continue;
    const agentFile = join(root, "agents", `${member}.md`);
    errors.push({
      code: "AGENT_IN_MULTIPLE_TEAMS",
      message:
        `agent '${member}' is listed in more than one team's members: ${teams.sort().join(", ")} — levare's model is ` +
        "one team per agent (teams are reused across projects; agents are not reused across teams), so this agent " +
        "silently takes on only the first team's connector grants and charter; duplicate and rename the agent per " +
        "team instead (e.g. 'scribe-press', 'scribe-docs')",
      file: existsSync(agentFile) ? agentFile : teamsDir,
    });
  }
}

/**
 * Ruling C12/F10 defect 2 — team ambiguity: "levare must not guess" extended to WHICH team is
 * responsible for a unit, not just which member. The Conductor found this live: a `press` team (one
 * member, produces `product-brief`) started a unit whose work `press` was meant to do — and `kestrel`
 * ran it instead, because kestrel also declares `product-brief` and gates.ts#responsibleTeamsFor's
 * produces∩expects scoring silently picked one. For every work unit, if some kind its type `expects`
 * is produced by more than one team AND the unit does not disambiguate with `team:`, that is an
 * AMBIGUOUS_PRODUCER error naming the kind(s) and every candidate team — never a runtime coin-flip.
 * A `team:` override, when present, is validated on its own terms: it must name a real team, and that
 * team must actually be able to produce something the unit's type expects (otherwise the override just
 * relocates the "nothing can run this unit" failure UNBINDABLE_STEP/UNPRODUCIBLE_KIND already catch).
 */
function validateResponsibleTeam(root: string, errors: ValidationError[], overlay?: OverlayFile): void {
  const workRoot = join(root, "work");
  const teamsDir = join(root, "teams");
  const typesDir = join(root, "types");
  if (!existsSync(workRoot) || !existsSync(teamsDir) || !existsSync(typesDir)) return;

  const teamProduces = new Map<string, string[]>();
  // file stem → its own declared `name:` — lets an UNKNOWN_TEAM hint recognize the specific rename
  // shape "the file that used to be named/referenced this still exists, but its `name:` field now
  // says something else" (see the RENAME_HINT block below), without guessing at any other shape.
  const teamNameByFileStem = new Map<string, string>();
  for (const file of readdirSync(teamsDir).sort()) {
    if (!file.endsWith(".md") || file.endsWith(".learnings.md")) continue;
    let data: Record<string, YamlValue>;
    try {
      ({ data } = parseFrontmatter(readOverlaid(join(teamsDir, file), overlay)));
    } catch {
      continue; // its own PARSE_ERROR was already recorded by the per-file pass.
    }
    const name = typeof data.name === "string" ? data.name : basename(file, ".md");
    teamProduces.set(name, strList(data.produces));
    teamNameByFileStem.set(basename(file, ".md"), name);
  }

  const typeExpects = new Map<string, string[]>();
  for (const file of readdirSync(typesDir).sort()) {
    if (!file.endsWith(".md")) continue;
    let data: Record<string, YamlValue>;
    try {
      ({ data } = parseFrontmatter(readOverlaid(join(typesDir, file), overlay)));
    } catch {
      continue;
    }
    const name = typeof data.name === "string" ? data.name : basename(file, ".md");
    typeExpects.set(name, strList(data.expects));
  }

  // Old (unresolved) team name → every UNKNOWN_TEAM error object that named it, so a rename hint
  // (below) can be appended to all of them at once, however many units still reference it.
  const unknownTeamErrorsByName = new Map<string, ValidationError[]>();

  for (const project of listDirs(workRoot)) {
    for (const unitName of listDirs(join(workRoot, project))) {
      const unitFile = join(workRoot, project, unitName, "unit.md");
      if (!existsSync(unitFile)) continue;
      let data: Record<string, YamlValue>;
      try {
        ({ data } = parseFrontmatter(readFileSync(unitFile, "utf8")));
      } catch {
        continue;
      }
      const type = typeof data.type === "string" ? data.type : undefined;
      const expects = type ? (typeExpects.get(type) ?? []) : [];
      const team = typeof data.team === "string" ? data.team : undefined;

      if (team) {
        if (!teamProduces.has(team)) {
          const err: ValidationError = { code: "UNKNOWN_TEAM", message: `unit '${unitName}' declares team: '${team}', but no such team is defined`, file: unitFile };
          errors.push(err);
          const bucket = unknownTeamErrorsByName.get(team);
          if (bucket) bucket.push(err);
          else unknownTeamErrorsByName.set(team, [err]);
          continue;
        }
        const produces = teamProduces.get(team)!;
        if (expects.length > 0 && !produces.some((k) => expects.includes(k))) {
          errors.push({
            code: "TEAM_CANNOT_PRODUCE",
            message:
              `unit '${unitName}' declares team: '${team}', but that team produces [${produces.join(", ") || "nothing"}] — ` +
              `none of which its type '${type}' expects [${expects.join(", ")}]`,
            file: unitFile,
          });
        }
        continue; // disambiguated: an explicit team: names exactly one responsible team.
      }

      // Which of the type's expected kinds are produced by more than one team?
      const producersByKind = new Map<string, string[]>();
      for (const [teamName, kinds] of teamProduces) {
        for (const kind of kinds) {
          if (!expects.includes(kind)) continue;
          const arr = producersByKind.get(kind) ?? [];
          arr.push(teamName);
          producersByKind.set(kind, arr);
        }
      }
      const ambiguous = [...producersByKind.entries()].filter(([, teams]) => teams.length > 1);
      if (ambiguous.length === 0) continue;
      const allTeams = new Set<string>();
      for (const [, teams] of ambiguous) for (const t of teams) allTeams.add(t);
      errors.push({
        code: "AMBIGUOUS_PRODUCER",
        message:
          `unit '${unitName}' (type '${type}') needs kind(s) [${ambiguous.map(([k]) => k).join(", ")}], each produced by more than one team ` +
          `(${[...allTeams].sort().join(", ")}); levare never guesses which team is responsible — add 'team:' to ${unitFile} naming one`,
        file: unitFile,
      });
    }
  }

  // RENAME-ORPHANS-REFERENCES (minimal, honest version): every UNKNOWN_TEAM error above already names
  // the broken reference — this only ADDS a hint when the pattern clearly looks like a rename, never
  // reference-rewriting and never a guess. The one conservative signal used: a team file whose own
  // FILENAME still matches the unresolved name, but whose own declared `name:` field now says
  // something else — i.e. the entity itself moved on, and these references are the ones that didn't
  // follow. A name that simply never existed anywhere (an ordinary typo) triggers no such file match,
  // so it gets no hint.
  for (const [oldName, refs] of unknownTeamErrorsByName) {
    const newName = teamNameByFileStem.get(oldName);
    if (!newName || newName === oldName) continue;
    const hint =
      ` (if you renamed an entity, every reference to the old name must be updated — ${refs.length} reference(s) ` +
      `still point at '${oldName}'; teams/${oldName}.md now declares name: '${newName}')`;
    for (const err of refs) err.message += hint;
  }
}

/**
 * Fault 1 (NOTES RAIL-UNREACHABLE): a unit's type `expects:` a fixed shape of kinds, but its actual
 * responsible team may cover only part of it — `teams/kestrel.md` declares `produces: [product-brief,
 * design, spec]` against `feature`'s `expects: [product-brief, design, spec, code, review]`, and no
 * member anywhere in the golden studio produces `code` at all. That gap is not itself an error: a team
 * assigned to a unit that only ever needs a subset of its type's stages (a brief-and-review-only unit,
 * say) is a legitimate configuration, and TEAM_CANNOT_PRODUCE/AMBIGUOUS_PRODUCER above already refuse
 * the genuinely broken shapes (no responsible team at all, or more than one candidate). This is the
 * narrower, honest middle ground: a WARNING naming exactly which of the type's expected kinds no member
 * of the unit's responsible team(s) can ever produce, so a Conductor reads it at `levare validate` time
 * rather than discovering it only as a score-rail row that sits at "queued" forever
 * (derive.ts#scoreNodes / flow.ts#unreachableExpectedKinds — the identical reachability computation,
 * never a second copy of it, so validate and the board can never disagree on which stages are honestly
 * reachable).
 */
function validateUncoverableExpectedKinds(root: string, warnings: ValidationWarning[], overlay?: OverlayFile): void {
  const workRoot = join(root, "work");
  const teamsDir = join(root, "teams");
  const agentsDir = join(root, "agents");
  const typesDir = join(root, "types");
  if (!existsSync(workRoot) || !existsSync(teamsDir) || !existsSync(agentsDir) || !existsSync(typesDir)) return;

  const agentProduces = new Map<string, string[]>();
  for (const name of readdirSync(agentsDir).sort()) {
    if (!name.endsWith(".md") || name.endsWith(".learnings.md")) continue;
    let data: Record<string, YamlValue>;
    try {
      ({ data } = parseFrontmatter(readOverlaid(join(agentsDir, name), overlay)));
    } catch {
      continue; // its own PARSE_ERROR was already recorded by the per-file pass.
    }
    if (typeof data.name === "string") agentProduces.set(data.name, strList(data.produces));
  }

  const teamMembers = new Map<string, string[]>();
  const teamProduces = new Map<string, string[]>();
  for (const file of readdirSync(teamsDir).sort()) {
    if (!file.endsWith(".md") || file.endsWith(".learnings.md")) continue;
    let data: Record<string, YamlValue>;
    try {
      ({ data } = parseFrontmatter(readOverlaid(join(teamsDir, file), overlay)));
    } catch {
      continue;
    }
    const name = typeof data.name === "string" ? data.name : basename(file, ".md");
    teamMembers.set(name, strList(data.members));
    teamProduces.set(name, strList(data.produces));
  }

  const typeExpects = new Map<string, string[]>();
  for (const file of readdirSync(typesDir).sort()) {
    if (!file.endsWith(".md")) continue;
    let data: Record<string, YamlValue>;
    try {
      ({ data } = parseFrontmatter(readOverlaid(join(typesDir, file), overlay)));
    } catch {
      continue;
    }
    const name = typeof data.name === "string" ? data.name : basename(file, ".md");
    typeExpects.set(name, strList(data.expects));
  }

  for (const project of listDirs(workRoot)) {
    for (const unitName of listDirs(join(workRoot, project))) {
      const unitFile = join(workRoot, project, unitName, "unit.md");
      if (!existsSync(unitFile)) continue;
      let data: Record<string, YamlValue>;
      try {
        ({ data } = parseFrontmatter(readFileSync(unitFile, "utf8")));
      } catch {
        continue;
      }
      const type = typeof data.type === "string" ? data.type : undefined;
      const expects = type ? (typeExpects.get(type) ?? []) : [];
      if (expects.length === 0) continue;
      const teamOverride = typeof data.team === "string" ? data.team : undefined;
      // Candidate responsible team(s) — the same produces∩expects scoring flow.ts#responsibleTeamsFor
      // uses. An explicit `team:` override names the sole candidate; otherwise every team producing at
      // least one expected kind is one (AMBIGUOUS_PRODUCER, above, already refuses a genuine conflict
      // between candidates — this only ever asks "can NONE of them cover this kind").
      const candidates = teamOverride
        ? teamProduces.has(teamOverride) ? [teamOverride] : []
        : [...teamProduces.entries()].filter(([, produces]) => produces.some((k) => expects.includes(k))).map(([name]) => name);
      if (candidates.length === 0) continue; // no responsible team at all — a different failure, caught elsewhere.

      const uncoverable = expects.filter(
        (kind) => !candidates.some((teamName) => (teamMembers.get(teamName) ?? []).some((m) => (agentProduces.get(m) ?? []).includes(kind))),
      );
      if (uncoverable.length === 0) continue;
      warnings.push({
        code: "UNCOVERABLE_EXPECTED_KIND",
        message:
          `unit '${unitName}' (type '${type}') expects kind(s) [${uncoverable.join(", ")}], but no member of its responsible team ` +
          `(${candidates.join(", ")}) declares producing ${uncoverable.length === 1 ? "it" : "any of them"} — this may be a legitimate ` +
          "configuration (a unit that only ever needs part of its type's shape), but the board's score rail will show these stage(s) " +
          "as not covered, never as merely queued",
        file: unitFile,
      });
    }
  }
}

/**
 * Ruling C9 (NOTES D6): how a member receives consumed artifacts (§6 recipe item 7) is a per-agent
 * declaration — `context_artifacts: inline` carries the full text, the default `paths` carries only
 * root-relative paths — because only the agent knows what it can reach. An agent whose declared `cwd`
 * resolves outside the studio root but has NOT declared `inline` can never open what a path points at:
 * that is a definition error, caught here rather than discovered live (the dogfood finding this
 * closes — a real Gemini member, run from /tmp with no studio access, was handed a path it could not
 * open and would have had to guess the question).
 *
 * A `cwd` still holding an unresolved `{…}` template (NOTES D9) resolves only at spawn time, not
 * definition time, so its eventual location is unknowable here and is skipped, not guessed at.
 */
function validateAgentContextScope(root: string, errors: ValidationError[], overlay?: OverlayFile): void {
  const agentsDir = join(root, "agents");
  if (!existsSync(agentsDir)) return;
  const resolvedRoot = resolve(root);
  for (const name of readdirSync(agentsDir).sort()) {
    if (!name.endsWith(".md") || name.endsWith(".learnings.md")) continue;
    const file = join(agentsDir, name);
    let data: Record<string, YamlValue>;
    try {
      ({ data } = parseFrontmatter(readOverlaid(file, overlay)));
    } catch {
      continue; // its own PARSE_ERROR was already recorded by the per-file pass.
    }
    const cwd = typeof data.cwd === "string" ? data.cwd : undefined;
    if (!cwd || cwd.includes("{")) continue;
    if (data.context_artifacts === "inline") continue;
    const resolvedCwd = resolve(isAbsolute(cwd) ? cwd : join(root, cwd));
    const rel = relative(resolvedRoot, resolvedCwd);
    const outside = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
    if (!outside) continue;
    const agentName = typeof data.name === "string" ? data.name : basename(name, ".md");
    errors.push({
      code: "CWD_OUTSIDE_STUDIO_NO_INLINE",
      message:
        `agent '${agentName}' has cwd '${cwd}' outside the studio root '${root}' and does not declare ` +
        `'context_artifacts: inline'; such a member can never read what it consumes at that path (ruling C9)`,
      file,
    });
  }
}

/**
 * NOTES C11 part 4 (hard rule a): a committed `.env` in a studio that will be shared is a catastrophe
 * — every credential in it becomes visible to anyone who clones the repo, forever, even after the file
 * is later removed (it stays in history). This fails closed: any `.env` tracked by git at the studio
 * root is a validation error, naming the file and why, rather than a warning that's easy to ignore.
 * Only meaningful when the target is itself a git repo (gitToplevel below returns null otherwise —
 * nothing to check against, same fail-open posture as the immutability check's own S0 state).
 */
function validateEnvNotTracked(root: string, errors: ValidationError[]): void {
  const envFile = join(root, ".env");
  if (!existsSync(envFile)) return;
  const toplevel = gitToplevel(root);
  if (!toplevel) return;
  const rel = relative(toplevel, canonical(envFile));
  // `git ls-files --error-unmatch <path>` exits 0 iff the path IS tracked (present in the index) —
  // the same primitive gitImmutabilityCheck already relies on for "is this file in git at all".
  const r = spawnSync("git", ["-C", toplevel, "ls-files", "--error-unmatch", rel], { encoding: "utf8" });
  if (r.status === 0) {
    errors.push({
      code: "ENV_FILE_TRACKED",
      message:
        `.env is tracked by git — a committed credential in a studio that will be shared is a catastrophe. ` +
        `Remove it from git (git rm --cached .env), add .env to .gitignore, and rotate any credential it held.`,
      file: envFile,
    });
  }
}

// ---------------------------------------------------------------------------
// Cross-artifact reference resolution (consumes / supersedes)
// ---------------------------------------------------------------------------

function crossReference(artifacts: DiscoveredArtifact[], errors: ValidationError[]): void {
  // Build per-project and global id indexes.
  const byProject = new Map<string, Map<string, DiscoveredArtifact>>();
  const globalIds = new Map<string, DiscoveredArtifact>();
  for (const a of artifacts) {
    const project = String(a.data.project ?? "");
    const id = a.data.id;
    if (typeof id !== "string") continue;
    let proj = byProject.get(project);
    if (!proj) byProject.set(project, (proj = new Map()));
    if (proj.has(id)) {
      errors.push({ code: "DUPLICATE_ID", message: `duplicate artifact id '${id}' within project '${project}'`, file: a.file });
    } else {
      proj.set(id, a);
    }
    globalIds.set(id, a);
  }

  for (const a of artifacts) {
    const project = String(a.data.project ?? "");
    const proj = byProject.get(project);
    const resolve = (id: string, kind: "consumes" | "supersedes") => {
      if (proj?.has(id)) return;
      if (globalIds.has(id)) {
        errors.push({
          code: "CROSS_PROJECT_CONSUMES",
          message: `${kind} id '${id}' resolves to a different project than '${project}'`,
          file: a.file,
        });
      } else {
        errors.push({
          code: kind === "consumes" ? "UNRESOLVED_CONSUMES" : "UNRESOLVED_SUPERSEDES",
          message: `${kind} id '${id}' does not resolve to an artifact in project '${project}'`,
          file: a.file,
        });
      }
    };
    if (Array.isArray(a.data.consumes)) {
      for (const c of a.data.consumes) if (typeof c === "string") resolve(c, "consumes");
    }
    if (typeof a.data.supersedes === "string") resolve(a.data.supersedes, "supersedes");
  }
}

// ---------------------------------------------------------------------------
// Approved-immutability check (against git; §4)
// ---------------------------------------------------------------------------

// Environment-sensitivity audit (NOTES.md A4):
//  - Baseline is always `HEAD`, never a hardcoded branch name (`main`/`master`/`trunk`), so the
//    check is correct on any repo regardless of its default branch.
//  - Paths are canonicalized with realpath on BOTH sides before the repo-relative path is computed.
//    `git rev-parse --show-toplevel` returns a symlink-resolved path (on macOS the temp dir lives
//    under /var, a symlink to /private/var), while the validator holds the caller's uncanonical
//    path. Without canonicalization, `relative(toplevel, file)` produces a bogus `../../…` path,
//    `cat-file -e HEAD:<bogus>` fails, and the check would fall through to S1 — masking a mutation
//    as "no history". Canonicalizing both sides makes the relative path correct regardless.
//  - Two distinct "valid" states are separated explicitly (S0 no repo, S1 no history) so a missing
//    baseline is never silently mistaken for an unchanged one.
//  - The S2 comparison uses `git diff` (which honours the repo's own normalization, e.g.
//    core.autocrlf) rather than a raw byte-compare of `git show` output, so a checkout filter
//    cannot manufacture a false "modified" verdict.
// Returns the state taken for each approved artifact (plus a single S0 entry when the target is not
// a git repo) so callers/tests can assert the branch, not merely the pass/fail outcome.
function gitImmutabilityCheck(
  target: string,
  artifacts: DiscoveredArtifact[],
  errors: ValidationError[],
): ImmutabilityCheck[] {
  const checks: ImmutabilityCheck[] = [];
  const toplevel = gitToplevel(target);
  if (!toplevel) {
    checks.push({ file: canonical(target), state: "S0" }); // not a git repo; cannot verify.
    return checks;
  }
  for (const a of artifacts) {
    if (a.data.status !== "approved") continue;
    // Canonicalize both sides so the symlinked-tmpdir case (macOS /var → /private/var) resolves.
    const rel = relative(toplevel, canonical(a.file));

    // A7 (committed-mutation): when the artifact records the commit whose content was approved,
    // diff the working file against THAT ref, not HEAD — so a mutation that is itself committed
    // (advancing HEAD) can no longer report "unchanged". The approval-stamp fields (status,
    // approved_by, approved_commit) legitimately differ from the pre-approval baseline and are
    // excluded; any other content change (body, consumes, files, …) is a violation. A missing/null
    // approved_commit falls back to the HEAD diff below (pre-A7 artifacts, backward compatible).
    const approvedCommit = typeof a.data.approved_commit === "string" ? a.data.approved_commit.trim() : "";
    if (approvedCommit) {
      const baseline = spawnSync("git", ["-C", toplevel, "show", `${approvedCommit}:${rel}`], { encoding: "utf8" });
      if (baseline.status !== 0) {
        // The recorded ref doesn't contain this file (unreachable ref, or never committed there) —
        // no usable baseline; fall open like S1 rather than fabricate a violation.
        checks.push({ file: a.file, state: "S1" });
        continue;
      }
      let current: string;
      try {
        current = readFileSync(a.file, "utf8");
      } catch {
        checks.push({ file: a.file, state: "S2e" });
        continue;
      }
      const kind = typeof a.data.kind === "string" ? a.data.kind : "";
      // `merge.target` (the branch approval merged into) is itself NOT approval-exempt — it's part of
      // the gate-open `merge:` block, so it's guaranteed identical between baseline and current here
      // regardless of which side we read it from. Reading it lets the checkout-sync notice be
      // reconstructed and matched exactly, never pattern-matched (see stripCheckoutSyncNotice's doc).
      const mergeTarget =
        kind === "merge" && a.data.merge && typeof a.data.merge === "object" && !Array.isArray(a.data.merge) && typeof (a.data.merge as Record<string, YamlValue>).target === "string"
          ? ((a.data.merge as Record<string, YamlValue>).target as string)
          : null;
      const baselineStripped = stripApprovalStamp(stripCheckoutSyncNotice(baseline.stdout, mergeTarget), kind);
      const currentStripped = stripApprovalStamp(stripCheckoutSyncNotice(current, mergeTarget), kind);
      if (baselineStripped === currentStripped) {
        checks.push({ file: a.file, state: "S2a" });
      } else {
        checks.push({ file: a.file, state: "S2c" });
        errors.push({
          code: "MODIFIED_AFTER_APPROVAL",
          message: "approved artifact content differs from the commit in which it was approved; approved artifacts are immutable (§4)",
          file: a.file,
        });
      }
      continue;
    }

    // S1: does the approved file exist in the current commit at all?
    const inHead = spawnSync("git", ["-C", toplevel, "cat-file", "-e", `HEAD:${rel}`], { encoding: "utf8" });
    if (inHead.status !== 0) {
      checks.push({ file: a.file, state: "S1" }); // no history for this file yet — nothing to compare.
      continue;
    }
    // S2: has the working tree diverged from the committed (approved) version?
    // `git diff --quiet` exits 0 when identical, 1 when different, >1 on error.
    const diff = spawnSync("git", ["-C", toplevel, "diff", "--quiet", "HEAD", "--", rel], { encoding: "utf8" });
    if (diff.status === 0) {
      checks.push({ file: a.file, state: "S2a" }); // identical — verified unchanged.
    } else if (diff.status === 1) {
      checks.push({ file: a.file, state: "S2b" });
      errors.push({
        code: "MODIFIED_AFTER_APPROVAL",
        message: "approved artifact has been modified since its committed version; approved artifacts are immutable",
        file: a.file,
      });
    } else {
      // status > 1 (or null) — git itself errored; unverifiable. Fail-open (consistent with S0/S1)
      // but recorded distinctly so a diff error never impersonates a verified-unchanged S2a.
      checks.push({ file: a.file, state: "S2e" });
    }
  }
  return checks;
}

// Remove the frontmatter lines `kind`'s approval path legitimately writes (approval-fields.ts's
// registry: the universal stamp — status/approved_by/approved_commit — plus whatever extra MAP field
// that kind's own approve verb adds, e.g. `merge_result` for kind: merge) so an approved artifact can
// be compared to its pre-approval-baseline content: what remains (every other frontmatter field + the
// whole body) must be byte-identical, or the content was mutated after approval. Only lines inside the
// leading `---`/`---` fence are touched, so a body that happens to contain a field-like token is never
// affected. A stamp field is a single scalar line; a kind-specific field is a block (its own `key:`
// line plus every indented continuation line that follows, same shape `upsertFrontmatterMap` writes)
// — both are recognized by the same loop, so a newly-registered map field needs no new stripping logic.
function stripApprovalStamp(src: string, kind: string): string {
  const lines = src.split("\n");
  if (lines[0]?.trim() !== "---") return src;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return src;
  const exempt = new Set(approvalExemptFields(kind));
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (i > 0 && i < end) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*):/.exec(lines[i]);
      if (m && exempt.has(m[1])) {
        i++;
        while (i < end && /^[ \t]/.test(lines[i])) i++; // skip that field's own indented continuation lines, if any.
        continue;
      }
    }
    out.push(lines[i]);
    i++;
  }
  return out.join("\n");
}

// Remove the `formatCheckoutSyncNotice` suffix `doApproveMerge` conditionally appends to a merge
// artifact's body — the ONE piece of body content any approval path writes (every other approval-time
// write is frontmatter, handled by `stripApprovalStamp` above). SECURITY: this must never become a
// substring/marker search. A search-and-drop-everything-after approach would let a post-approval
// mutation hide arbitrary content behind a forged copy of the marker text — insert
// "**Checkout out of sync:**<payload>" at the end of an approved body, and a naive stripper would
// treat everything from that point on as "the sanctioned notice" and silently exclude it from the
// comparison, exactly the "body mutation hiding behind that marker" this function exists to rule out.
// Instead this RECONSTRUCTS the exact expected suffix from `defaultBranch` (read from the artifact's
// own `merge.target`, itself immutable-checked since it's outside the exempt set) via the SAME
// `formatCheckoutSyncNotice` the writer uses, and only strips it when `src` ends with that exact
// string, byte for byte. Any deviation — a different branch name, extra trailing text, a truncated
// copy — fails the exact match, so nothing is stripped and the forged content surfaces as a real
// comparison mismatch (MODIFIED_AFTER_APPROVAL) instead of being laundered through. Called identically
// on both baseline and current: the baseline (pre-approval) never legitimately ends with this exact
// text, so it's always a no-op there.
//
// The notice's WORDING is itself a versioned schema element, not free-form prose (the ~/source/
// jot-studio outage, 2026-08-23 — see formatCheckoutSyncNotice's own doc): an artifact approved before
// PR #26 has PR #26's predecessor's wording baked into its baseline forever, and reconstructing only
// today's wording can never match it. Tries the current wording first (the common case), then every
// retired one in `FORMER_CHECKOUT_SYNC_NOTICES`, oldest-schema-element treatment applied uniformly —
// each candidate still requires the SAME exact, byte-for-byte suffix match; none of this loosens the
// match into a pattern/marker search.
function stripCheckoutSyncNotice(src: string, defaultBranch: string | null): string {
  if (!defaultBranch) return src;
  for (const format of [formatCheckoutSyncNotice, ...FORMER_CHECKOUT_SYNC_NOTICES]) {
    const suffix = `\n\n${format(defaultBranch)}\n`;
    if (src.endsWith(suffix)) {
      // The writer builds this suffix onto `body.trimEnd()` (gateops.ts#doApproveMerge), consuming the
      // single trailing newline every `kind: merge` body carries (formatMergeArtifact's own
      // convention — this notice is the only body content ANY approval writes, and only for this
      // kind). Re-add that one newline so the reconstructed content matches the pre-notice baseline
      // exactly, not merely up to trailing whitespace.
      return src.slice(0, -suffix.length) + "\n";
    }
  }
  return src;
}

// realpath, tolerant of a path that does not resolve (returns the input unchanged).
function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function gitToplevel(target: string): string | null {
  const dir = existsSync(target) && statSync(target).isDirectory() ? target : dirname(target);
  const r = spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (r.status !== 0) return null;
  // Canonicalize so it matches realpath-resolved artifact paths on symlinked filesystems.
  return canonical(r.stdout.trim());
}

// levare domain types (PRD §5). These are the in-memory shapes the Runner walks: teams and their
// declarative flows, agents, type templates, projects, work units, and artifacts. Loaders in
// repo.ts parse the markdown-with-frontmatter files (via the phase-1 yaml parser) into these.
//
// The flow is the only structurally interesting frontmatter: an ordered list whose entries are one
// of three shapes — a `step`, a `gate`, or a `loop` block (§5). We normalize the raw parsed maps
// into a discriminated union (FlowNode) so the Runner never re-inspects loose YAML shapes.

import type { YamlValue } from "./yaml.ts";

// ---------------------------------------------------------------------------
// Flow (team.flow) — the declarative sequence the Runner executes (§6)
// ---------------------------------------------------------------------------

export interface FlowStep {
  kind: "step";
  /** Task label from the flow step (§6 context recipe item 6); resolves to a (member, kind). */
  step: string;
}
export interface FlowGate {
  kind: "gate";
  /** Only `human` gates exist today; the field is kept for forward-compatibility. */
  who: string;
}
export interface FlowLoop {
  kind: "loop";
  /** The two step labels the loop alternates, e.g. [spec, review]. */
  between: [string, string];
  /** A status condition on a named kind, e.g. `spec.approved`. */
  until: string;
  maxRounds: number;
  /** What to do when max_rounds is reached without `until`; only `gate` today. */
  onExhaust: string;
}
export type FlowNode = FlowStep | FlowGate | FlowLoop;

// ---------------------------------------------------------------------------
// Registry entities (§5)
// ---------------------------------------------------------------------------

export interface Team {
  name: string;
  /** Optional card headline (registry cards legibility unit) — display-only, never read by the
   * runner. Falls back to the charter's own lead when absent; see render/registry.ts. */
  description?: string;
  consumes: string[];
  produces: string[];
  members: string[];
  flow: FlowNode[];
  style: { color: string };
  // Guardrails split branches from file paths (ruling C6): `protected_branches` match a branch ref,
  // `protected_paths` match file paths in a diff — different namespaces, never cross-matched.
  guardrails?: { protected_paths?: string[]; protected_branches?: string[]; never?: string[] };
  knowledge?: string[];
  /** Connector grants (§5): the Runner injects each named connector's env into this team's members. */
  connectors?: string[];
  /** Team charter (markdown body), injected into member context (§6). */
  charter: string;
  /** Team LEARNINGS.md content, injected after the charter (§6 recipe item 4); "" when none. */
  learnings: string;
}

export interface Agent {
  name: string;
  /** Optional card headline (registry cards legibility unit) — display-only, never read by the
   * runner. Falls back to the body's own lead when absent; see render/registry.ts. */
  description?: string;
  kind: "native" | "cli" | "remote";
  /**
   * The artifact kinds this member can produce (§5, NOTES F1). This is the studio's capability
   * declaration: `repoCapabilities` (repo.ts) reads every agent's `produces` to build the
   * {member, kind}[] map the Runner resolves flow steps against. Before F1 the map existed only in
   * the fixture stubs (`CAPABILITIES`), so a real agent had no way to declare a capability at all
   * and no real studio could bind a flow step to a member.
   */
  produces: string[];
  model?: string;
  /**
   * CLI argv template as a structured array (§5), e.g. ["codex", "review", "--input", "{task}"].
   * Each element is exactly one argv slot: a `{placeholder}` is substituted in place and the value —
   * spaces, quotes, metacharacters and all — stays a single argument. Never a shell string to split.
   */
  command?: string[];
  /**
   * How a `kind: cli` member receives its assembled §6 context (NOTES F7). `"arg"` (default): the
   * full context substitutes `{task}` in the `command` template, exactly one argv element. `"stdin"`:
   * the full context is written to the child's stdin instead — for a CLI that reads its prompt from
   * stdin rather than an argv flag. Ignored for `native`/`remote` agents.
   */
  context_via?: "arg" | "stdin";
  /**
   * How this member receives consumed artifacts (§6 recipe item 7, ruling C9). `"paths"` (default):
   * root-relative paths only — correct for a member with filesystem access to the studio. `"inline"`:
   * the full text (frontmatter + body) of every consumed artifact, for a member that cannot reach the
   * studio filesystem (e.g. a wrapped CLI deliberately run in an isolated scratch directory). A cwd
   * resolving outside the studio root without declaring `"inline"` is a definition error — `levare
   * validate` rejects it (NOTES D6/C9).
   */
  context_artifacts?: "paths" | "inline";
  cwd?: string;
  timeout?: number;
  result?: string;
  /** remote: the `kind: mcp` connector this member calls (its registry `name`, PRD Amendment 3 ruling
   * R5) — validated against the connector registry by validate.ts, resolved and dispatched for real by
   * adapters.ts#createAsyncStdioRemoteBoundary (NOTES MCP-1B). */
  server?: string;
  /** remote: the MCP tool name this member invokes on `server`'s connector via `tools/call` — the
   * member's declared intent → server-call mapping ruling R5 asks for. Required for kind: remote. */
  tool?: string;
  /**
   * remote: the static `tools/call` arguments template — each value substitutes `{task}` with the
   * assembled §6 context (mirrors adapters.ts#defaultCliCommand's own `{task}` substitution for a cli
   * member's argv). There is no separate "propose params" step for a remote member (ruling R2: one
   * dispatch, one call, one artifact) — this is where the member's declared intent is expressed.
   */
  params?: Record<string, string>;
  skills?: string[];
  tools?: string[];
  knowledge?: string[];
  /** Per-agent connector grants (§5), unioned with the team's grants for env scoping. */
  connectors?: string[];
  /**
   * NOTES R4-SANDBOX-APPSERVER: the declared escape hatch from Ruling 2's OS sandbox (sandbox.ts) — for
   * a `kind: cli` member whose vendor CLI cannot run confined at all (its own architecture needs OS
   * access the sandbox's threat model won't safely grant: an in-process IPC client, a self-sandboxing
   * helper, or whatever a live host investigation names). `"auto"` (default): best-effort sandboxing per
   * Ruling 2, unchanged — a working primitive confines the spawn, none proceeds unconfined either way.
   * `"unsandboxed"`: `adapters.ts#sandboxWrap` never even attempts to wrap this member's spawn, on ANY
   * host — REQUIRES `sandbox_reason` (validate.ts rejects the declaration without one; a Conductor
   * reading the registry or a produced artifact must never see "this member runs unconfined" without
   * also seeing WHY). Recorded on every artifact this member produces (`sandbox_reason:`, adapters.ts#
   * author), surfaced by `levare validate`/`levare doctor` with the same plainness `SANDBOX_UNAVAILABLE`
   * already uses for the unrelated "host has no primitive" case — the two are deliberately never
   * conflated (see that field's own doc). Silent degradation was ruled out explicitly; this is the
   * honest alternative when sandboxing genuinely cannot be granted.
   */
  sandbox?: "auto" | "unsandboxed";
  /** Required alongside `sandbox: unsandboxed` — the documented reason a Conductor can act on. */
  sandbox_reason?: string;
  style: { avatar: string };
  body: string;
}

// A connector definition (§5): names the env var *names* a granted member receives; values never
// live in the repo (invariant 11). `kind: cli` wraps a command; `kind: mcp` names an MCP server.
// Studio-level settings (NOTES F11): a root singleton (`studio.md`), distinct from `projects/*.md`
// (product pointers). Currently carries only the Orchestrator's declared model — the registry field
// that replaces `LEVARE_ORCHESTRATOR_MODEL` as the source of truth (the env var remains a runtime
// override). Optional throughout: an absent file, or an absent field, means "no studio-level
// declaration" and callers fall back to their own built-in default.
export interface StudioSettings {
  orchestratorModel?: string;
}

// NOTES C13: how a connector's CLI/MCP backend authenticates. `env` (default) is the original
// model — levare's allowlist (env.ts) injects exactly the named vars, and that grant IS the
// enforcement. `subscription` names a backend that authenticates itself from its own stored
// credentials (e.g. `codex login` writing a session to ~/.codex) — `env` must be empty for these,
// because there is nothing for levare to inject or scope. Any member able to spawn the binary can
// use the login, granted or not; the grant is documentation, not enforcement (see doctor.ts).
export type ConnectorAuth = "env" | "subscription";

// NOTES C15: `kind` names the TRANSPORT (mcp/cli — how levare connects); `role` names the FUNCTION
// (model/tool — what the connector serves in the ecosystem). `codex` grants model access; `github`/
// `linear` grant tool/service capabilities. Defaults to "tool", the common case — every connector
// defined before this ruling is unchanged. Deliberately not named `type`, which is reserved for
// domain templates (work-unit type).
export type ConnectorRole = "model" | "tool";

// NOTES CAP-A (v1.1 capability layer, part A). `effects` names whether granting this connector lets a
// member merely READ through it (unchanged since phase 3 — the grant IS the enforcement, env.ts injects
// the named vars) or WRITE through it (a side-effecting action against the outside world). `gate` only
// has meaning for an `effects: write` connector: `proposal` (default) means the grant is "may draft a
// proposal against this connector", never "holds its credential" — env.ts#buildMemberEnv withholds the
// connector's env vars from every member's own process; only levare's own execution step (on gate
// approval) reads them. `gate: trusted` is the declared, visible opt-out — injects exactly as an
// `effects: read` connector always has. A `gate:` on an `effects: read` connector is a definition error
// (gate is meaningless without something to gate).
export type ConnectorEffects = "read" | "write";
export type ConnectorGate = "proposal" | "trusted";

export interface Connector {
  name: string;
  kind: "mcp" | "cli";
  server?: string;
  command?: string;
  /**
   * NOTES MCP-1B (PRD Amendment 3, ruling R1/R5): the real stdio spawn command for a `kind: mcp`
   * connector — argv only, never a shell string (mirrors mcp-client.ts#StdioMcpServerCommand.argv and
   * this file's own `Agent.command`'s non-shell-split guarantee). Absent/empty means this connector has
   * no working stdio path yet — an HTTP/SSE server (ruling R1's deferred phase 2, which spawns nothing
   * locally and so never declares one) or simply not yet configured — env.ts#remoteAgentImplemented is
   * the single place that draws this line for validate/doctor/registry's honesty warnings.
   */
  argv?: string[];
  env: string[];
  scope?: string;
  auth: ConnectorAuth;
  /** Human-readable note on the subscription plan in use — required in practice for `auth:
   * subscription` connectors so receipts and doctor can name what's covering the cost (§10). */
  plan?: string;
  /** NOTES C15: this connector's function — a model connector or a tool/service connector. */
  role: ConnectorRole;
  /** NOTES CAP-A: defaults to "read" — every connector defined before this ruling is unchanged. */
  effects: ConnectorEffects;
  /** NOTES CAP-A: defaults to "proposal" — only meaningful when effects: write. */
  gate: ConnectorGate;
  /**
   * NOTES CAP-A: the declared action vocabulary for an `effects: write` connector — action name →
   * argv template array with `{placeholder}` slots, e.g. `create-issue: ["gh", "issue", "create",
   * "--title", "{title}"]`. Templates are DECLARED here, in the connector's own definition; a member
   * proposing against this connector names an action and fills the placeholders with `params:` — it
   * can never supply raw argv. Required (non-empty) for every `effects: write` connector, whichever
   * `kind` — a `kind: mcp` write connector still declares its action vocabulary/placeholder shape
   * here even though execution is not yet implemented for MCP (see execution.ts).
   */
  actions?: Record<string, string[]>;
  /**
   * NOTES CAP-B (v1.1 capability layer, part B, item 4) / NOTES MCP-1C (PRD Amendment 3, ruling R3):
   * dotpaths under `$HOME` this connector's own backend actually needs (e.g. `[".codex"]`, or
   * `[".npm"]` for a bunx/npx-spawned MCP server's own cache dir). Originally scoped to `auth:
   * subscription` connectors, whose credential is a live, disk-stored login rather than an env var —
   * `env.ts#scopeHomeForConnector` gives a spawned process a per-run scratch `$HOME` containing
   * SYMLINKS to only these paths from the real home, never a copy, since the underlying resource is
   * live (revoking a subscription login in the real home revokes it everywhere it's symlinked). Ruling
   * R3 generalizes the SAME mechanism to a `kind: mcp` connector's declared stdio server, `auth: env` or
   * not: an MCP server otherwise gets the identical deny-user-data confinement a `cli` member's spawn
   * does (adapters.ts#createAsyncStdioRemoteBoundary), and `home:` is the one, auditable, per-connector
   * way to declare a specific real-HOME path that server legitimately needs — never a blanket exception.
   * A connector declaring no `home` keeps the pre-CAP-B behaviour: the spawned process sees the real,
   * unscoped `$HOME` (see the `SUBSCRIPTION_NO_HOME` doctor/validate warning, `auth: subscription`
   * only). Undeclared/empty is a no-op for anything with no live resource on disk to scope.
   */
  home?: string[];
}

export interface TypeTemplate {
  name: string;
  glyph: string;
  expects: string[];
  gates: string[];
  output?: string;
  /** Spike/timebox semantics, Runner-enforced (§5). */
  timebox?: string | null;
  /** Research reports promote to knowledge/ through a gate (§5). */
  promotable_to?: string | null;
}

export interface Project {
  name: string;
  repo: string;
  remote: string | null;
  default_branch: string;
  deploy: string | null;
  pace: "auto" | "step";
  /** One-level merge over team defaults (§5). */
  overrides?: Record<string, YamlValue>;
  /** House rules (markdown body), injected into every member context for this project (§6). */
  houseRules: string;
}

export type WorkUnitStatus = "active" | "paused" | "blocked" | "shipped" | "abandoned";

export interface WorkUnit {
  type: string;
  status: WorkUnitStatus;
  project: string;
  unit: string;
  /** Start-gate condition — a unit with unmet `after:` is invisible to the walk (§6, NOTES A6). */
  after?: string[];
  /**
   * Explicit team override (ruling C12/F10 defect 2): when two teams in a studio both produce a kind
   * this unit's type expects, `levare validate` refuses to guess (AMBIGUOUS_PRODUCER) unless the unit
   * names which team is responsible. When set, the walk (gates.ts#responsibleTeamsFor/runner.ts) uses
   * ONLY this team, never the produces∩expects scoring — validated separately (the team must exist
   * and must actually produce something the type expects).
   */
  team?: string;
  timebox?: string | null;
  /** USD; crossing the ledger sum raises a budget gate (§10). */
  budget?: number | null;
  /**
   * Why this unit is blocked, when its status is `blocked` (NOTES F1). Written by the walk when it
   * cannot bind a flow step to a member — the failure that used to be swallowed, leaving the unit
   * silently doing nothing forever. Files are the truth (invariant 2), so the reason lives on disk
   * with the status it explains, and the board renders it as a gate.
   */
  blocked_reason?: string | null;
  /** Directory holding the unit and its artifacts. */
  dir: string;
}

export type ArtifactStatus =
  | "draft"
  | "in-review"
  | "approved"
  | "rejected"
  | "superseded"
  | "blocked"
  // NOTES F19: a Conductor's explicit "skip" verb on a blocked artifact — the step is marked
  // abandoned so the walk can continue past this kind (dagwalk.ts#nextAction treats it like
  // `approved` for a plain step), distinct from `blocked` (still awaiting a Conductor decision) and
  // from `rejected` (a content review outcome, not a produce-failure one).
  | "skipped";

// NOTES CAP-A: the on-approval record of a proposal artifact's execution — appended by levare itself,
// never authored by a member. `status: "skipped"` names the honest mcp-not-implemented case (never
// pretend a call happened); `status: "failed"` records a real, non-zero/timed-out cli execution — the
// approval itself is never undone by a failed execution, this record is what explains why the unit
// then blocks. `output_digest` is a hash of stdout+stderr, not the raw bytes — never grows a commit
// unbounded and never risks echoing a secret the connector's own output happened to include.
export interface ExecutionRecord {
  executed_at: string;
  status: "ok" | "failed" | "skipped";
  exit: number | null;
  output_digest: string | null;
  warning: string | null;
}

// NOTES MERGE-1 (PRD Amendment 2, M1/M2): reserved for `kind: merge` — the merge gate's own trial-merge
// report, written by levare itself (never a member) when the gate opens, and rewritten in place by the
// `recheck` verb. `conflicted: true` is what makes the gate unapprovable (board/gateops.ts refuses
// `approve` while it holds) — `conflicts` names the files so resolution (human work in the project repo)
// knows exactly where to look. `guardrail_violations` is the human-readable record of what the SAME
// diff's guardrail check found at gate-open time — advisory here; the binding check re-runs at
// execution time (M3) against whatever the diff looks like the instant approval is spent.
export interface MergeInfo {
  branch: string;
  target: string;
  commits_ahead: number;
  diffstat: string;
  conflicted: boolean;
  conflicts: string[];
  guardrail_violations: string[];
  // NOTES SEC-V11 F2: the exact work-branch SHA this trial evaluated — the pin `executeMerge` verifies
  // the branch still points at before landing (merge.ts's own doc). Optional/nullable: a hand-built
  // pre-F2 artifact, or a trial that errored before resolving the branch, carries none.
  branch_sha?: string | null;
}

// NOTES MERGE-1 (M4/M5): the on-approval record of a merge gate's SUCCESSFUL execution — appended by
// levare, never a member, only once the merge (and, where declared, the push) actually landed. Unlike
// `ExecutionRecord` (CAP-A: a failed proposal execution is still recorded, and the approval stands
// regardless), a merge gate's failure is never recorded here at all: M5's rollback is byte-perfect and
// "un-approves nothing", so a guardrail violation, a merge conflict rediscovered at execution time, or
// a push failure all return an error to the caller with nothing written to disk — the artifact stays
// `in-review`, exactly as if approval had never been attempted. `pushed: null` means the project
// declares no `remote:` (push never attempted); `pushed: true` means it landed there too.
export interface MergeResultRecord {
  executed_at: string;
  merge_commit: string;
  pushed: boolean | null;
  // NOTES (2026-08-20 checkout-sync ruling): true when the project repo's own primary checkout had
  // `default_branch` checked out at execution time — M4's "never a checkout" guarantee (merge.ts's own
  // header) is deliberate and stays load-bearing, but it leaves that ONE checkout staging every merged
  // file for deletion until synced by hand (merge.ts#checkoutBehindMerge's own doc has the mechanism).
  // Always written by every merge approval from this ruling forward (never omitted) — but optional and
  // nullable here, same convention as `MergeInfo.branch_sha`, so a `merge_result` committed BEFORE this
  // field existed stays a valid, already-approved artifact rather than a schema break the moment this
  // studio is next validated. Absence means "predates the ruling", never "the check was skipped".
  checkout_behind?: boolean | null;
}

export interface Artifact {
  kind: string;
  id: string;
  unit: string;
  project: string;
  status: ArtifactStatus;
  produced_by: string;
  consumes: string[];
  supersedes: string | null;
  approved_by: string | null;
  created: string;
  files: string[];
  usage?: Usage | null;
  /** First body paragraph is the display summary (NOTES A8). */
  body?: string;
  /** NOTES CAP-A: reserved for `kind: proposal` — the connector this proposal targets. */
  connector?: string | null;
  /** NOTES CAP-A: reserved for `kind: proposal` — one of the connector's declared `actions:` names. */
  action?: string | null;
  /** NOTES CAP-A: reserved for `kind: proposal` — params covering every placeholder in the action's template. */
  params?: Record<string, string> | null;
  /** NOTES CAP-A: reserved for `kind: proposal` — set by levare on gate approval, never by a member. */
  execution?: ExecutionRecord | null;
  /** NOTES MERGE-1: reserved for `kind: merge` — the trial-merge report, written by levare when the
   * merge gate opens and rewritten in place by the `recheck` verb. */
  merge?: MergeInfo | null;
  /** NOTES MERGE-1: reserved for `kind: merge` — set by levare only on a successful `approve`. */
  merge_result?: MergeResultRecord | null;
  /** NOTES R4-SANDBOX (v2, Ruling 2): the OS-level sandbox enforcement a `kind: cli` member's spawn
   * actually ran under, when this artifact was produced by one — "full" (filesystem AND network
   * confined), "fs-only" (a filesystem-only fallback — no working bubblewrap, but the kernel still
   * permits an unshare-based mount-namespace confinement), or "none" (no working primitive found on
   * this host — the spawn ran unconfined; see sandbox.ts). Independent of `usage`/`unreported` — a cli
   * member that reported no usage at all still carries its real sandbox level, never omitted just
   * because nothing else was reported. Absent for native/remote and every pre-this-ruling artifact
   * (Ruling 2 wraps only the two cli spawn paths). */
  sandbox?: "full" | "fs-only" | "none" | null;
  /** NOTES REGISTRY-PROVENANCE: a content hash over the governing registry (teams/, agents/,
   * connectors/, projects/, skills/, knowledge/, types/, studio.md) exactly as it stood on disk when
   * this artifact was produced — see git.ts#registryStateHash's own doc for why a content hash, not
   * `HEAD`, is what gets recorded. Present on every artifact from every member kind (unlike `sandbox`,
   * this is not about how the spawn ran, but about what defined it). Absent on pre-this-ruling artifacts. */
  registry?: string | null;
  /** Goal "commit-on-produce" (Finding 74): the commit SHA this dispatch's own worktree file changes
   * landed on the work branch as, or "none" if the dispatch changed nothing — see
   * adapters.ts#commitCodeChanges's own doc. Present only when a real dispatch worktree existed for this
   * member (self-referential/unresolvable `repo:`, or no work branch yet, both omit it — exactly
   * `sandbox`'s own no-worktree case, but for every member kind, not just cli/remote). Absent on every
   * pre-this-ruling artifact. */
  code_commit?: string | null;
  /** Unit "member authorship survives a self-commit": present ONLY when `code_commit`'s own landed
   * commit was authored/committed under an identity other than `git.ts#memberIdentity(produced_by)`
   * expected — a member's own bare commit (native Bash tool, or a `cli` member's own vendor process)
   * resolved some other ambient identity instead of ever going through `merge.ts#commitDispatchWorktree`'s
   * own `-c` override, or a member deliberately overrode identity on its own command line. Detection
   * only — levare does not and cannot prevent either case, only surface it (see
   * `commitDispatchWorktree`'s own doc). Absent whenever the identity matched, including every commit
   * `commitDispatchWorktree` made itself. */
  code_commit_actor?: string | null;
}

export interface Usage {
  model: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  usd: number | null;
  wall_clock_s: number | null;
}

// A normalized usage receipt (§10), produced at the Runner boundary by every adapter. Three numbers,
// three reliabilities: wall-clock (always, when the adapter timed the member), tokens (when the
// member reported them), USD. `unreported` is recorded honestly when the member gave nothing at all —
// silence is never dressed up as $0.
//
// NOTES "receipt cache tokens": `usd` is NOT uniformly "estimated from knowledge/model-pricing.md" —
// that estimate (pricing.ts#priceUsd) is only ever reached for a cli/remote member's receipt
// (receipts.ts#normalizeReceipt, the only caller). A `kind: native` member's `usd` is the Claude Agent
// SDK's OWN reported `total_cost_usd` (sdk-worker.ts#deriveReceipt), used verbatim — real vendor
// billing, not a derived figure, and specifically NOT reproducible by multiplying `tokens_in`/
// `tokens_out` against the pricing table's flat per-model rate: the SDK's cost already prices
// prompt-cache read/write tokens at their own separate rates, and those tokens are reported nowhere in
// `tokens_in`/`tokens_out` at all — see `tokens_cache_read`/`tokens_cache_write` below.
export interface Receipt {
  model: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  /** Prompt-cache READ input tokens (the SDK's `ModelUsage.cacheReadInputTokens`, summed across every
   * model entry) — priced into a native receipt's `usd` at a discount vs a fresh `tokens_in` token,
   * so folding it into `tokens_in` would misstate what a dollar of `usd` bought. Present (a number,
   * possibly 0) only on a native receipt that reported usage at all; absent (`undefined`) for every
   * other member kind and for an `unreported` native receipt — a cli/remote member has no cache
   * accounting to give. */
  tokens_cache_read?: number | null;
  /** Prompt-cache WRITE (cache-creation) input tokens (the SDK's `ModelUsage.cacheCreationInputTokens`)
   * — `tokens_cache_read`'s write-side counterpart, priced at its own separate (typically premium)
   * rate. Same presence rule as `tokens_cache_read`. */
  tokens_cache_write?: number | null;
  wall_clock_s: number | null;
  usd: number | null;
  unreported: boolean;
  /** NOTES C13: a subscription-authenticated member's `usd` above is always null — pricing per
   * token would be a fiction for a flat-rate plan — and the plan is named here instead, so the
   * gap in cost accounting is explained rather than left to look like a bug. */
  plan?: string;
}

// ---------------------------------------------------------------------------
// Flow parsing — normalize raw frontmatter `flow:` into FlowNode[]
// ---------------------------------------------------------------------------

export class FlowError extends Error {}

export function parseFlow(raw: YamlValue, teamName: string): FlowNode[] {
  if (!Array.isArray(raw)) throw new FlowError(`team '${teamName}' flow must be a list`);
  return raw.map((entry, i) => parseFlowNode(entry, teamName, i));
}

function parseFlowNode(entry: YamlValue, teamName: string, i: number): FlowNode {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw new FlowError(`team '${teamName}' flow entry ${i} must be a mapping`);
  }
  const m = entry as Record<string, YamlValue>;
  if ("step" in m) return { kind: "step", step: str(m.step, `${teamName} flow[${i}].step`) };
  if ("gate" in m) return { kind: "gate", who: str(m.gate, `${teamName} flow[${i}].gate`) };
  if ("loop" in m) {
    const l = m.loop;
    if (l === null || typeof l !== "object" || Array.isArray(l)) {
      throw new FlowError(`team '${teamName}' flow[${i}].loop must be a mapping`);
    }
    const lm = l as Record<string, YamlValue>;
    const between = lm.between;
    if (!Array.isArray(between) || between.length !== 2 || !between.every((x) => typeof x === "string")) {
      throw new FlowError(`team '${teamName}' loop.between must be a list of exactly two step labels`);
    }
    return {
      kind: "loop",
      between: [between[0] as string, between[1] as string],
      until: str(lm.until, `${teamName} loop.until`),
      maxRounds: num(lm.max_rounds, `${teamName} loop.max_rounds`),
      onExhaust: str(lm.on_exhaust, `${teamName} loop.on_exhaust`),
    };
  }
  throw new FlowError(`team '${teamName}' flow entry ${i} is neither step, gate, nor loop`);
}

function str(v: YamlValue, where: string): string {
  if (typeof v !== "string") throw new FlowError(`${where} must be a string`);
  return v;
}
function num(v: YamlValue, where: string): number {
  if (typeof v !== "number") throw new FlowError(`${where} must be a number`);
  return v;
}

// levare native-dispatch observability (NOTES DISPATCH-TRACE, native-dispatch-hang investigation,
// 2026-08-19). Phase 1 of that investigation established that a native member's dispatch — request,
// environment, HOME, worker stdout/stderr, everything — produced NO diagnostic surface at all on
// failure: a blocked artifact records a single line of error text, and the transport layer captured the
// worker's own stdout/stderr on the timeout path and then discarded it (sdk-transport.ts). This module
// closes that gap: one JSON trace file per native dispatch attempt, written to the studio itself, so a
// Conductor debugging a live failure has something to read that survives the process that failed.
//
// Two invariants this module exists to hold, not merely happen to satisfy:
//
//   1. NEVER a connector's env VALUE. The env section is built exclusively through
//      `env.ts#describeMemberEnv` — the same redaction guard that function's own doc requires every
//      env-describing diagnostic in this codebase to go through — which returns variable NAMES and a
//      `present: true` marker only, structurally incapable of carrying a value. `HOME` is reported the
//      identical way: this module records only WHETHER it was scoped (env.ts#scopeHome ran and swapped
//      in a scratch directory) as a boolean, never the literal path — a fact about which code path ran,
//      not a value read out of the environment. See `tests/dispatch-trace.test.ts` for the test that
//      asserts no value ever reaches a trace, including when a connector's own `env:` list names a var
//      whose value looks exactly like a credential.
//   2. Bounded retention. A trace directory nobody prunes is its own slow-burning defect — `sweepTraces`
//      runs on every write (best-effort, mirrors every other scratch-resource cleanup in this codebase:
//      never fails the dispatch it's cleaning up after) and enforces both a file-count cap and a max-age
//      cap, whichever is stricter for a given file.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describeMemberEnv } from "./env.ts";
import type { InvokeRequest } from "./adapters.ts";
import type { Receipt } from "./types.ts";
import type { SandboxLevel } from "./sandbox.ts";

// A trace file's text fields are bounded, not omitted — the same "record it, but bounded and honestly
// flagged" posture as every other capped record in this codebase (e.g. sandbox.ts's dedup, the Workflow
// tool's own "no silent caps" convention this investigation otherwise has no relation to). 200_000 chars
// comfortably covers a real member's assembled context or a worker's diagnostic stderr; a member that
// somehow exceeds it gets a truncated trace with `_truncated: true`, never a silently shortened one.
const MAX_FIELD_CHARS = 200_000;

// Retention: BOTH bounds apply, whichever is stricter for a given file. A count cap alone can't bound
// staleness (a quiet studio's oldest trace could sit for months); an age cap alone can't bound disk use
// under a bursty dispatch rate. Applied together, swept opportunistically on every write — this
// codebase's own scratch-resource precedent (env.ts#scopeHome, adapters.ts#createCliVendorScratch) has
// no separate cron/daemon sweep anywhere, and a native dispatch is comparatively rare (one real SDK call
// per attempt), so paying the sweep cost on every write is negligible.
export const DISPATCH_TRACE_MAX_FILES = 500;
export const DISPATCH_TRACE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export const DISPATCH_LOG_DIR_NAME = join(".levare", "dispatch-logs");

// `fromEnd` keeps the TAIL instead of the head. `context`/the default keep the head — a Conductor
// reading a member's assembled context wants to see it from the start. `worker_stdout`/`worker_stderr`
// (NOTES DISPATCH-TRACE phase 1 recovery) keep the tail instead: on a killed-mid-stream dispatch, the
// stderr now carries a running transcript (assistantContentLogLines, sdk-worker.ts) that only GROWS
// as the call runs, so the head is always the earliest, least-relevant turns — keeping it would silently
// cut off exactly the moments right before the kill, which is the part a Conductor debugging a timeout
// actually needs.
function truncate(text: string, opts: { fromEnd?: boolean } = {}): { value: string; truncated: boolean } {
  if (text.length <= MAX_FIELD_CHARS) return { value: text, truncated: false };
  return { value: opts.fromEnd ? text.slice(-MAX_FIELD_CHARS) : text.slice(0, MAX_FIELD_CHARS), truncated: true };
}

export interface DispatchTraceEnvEntry {
  name: string;
  present: true;
}

export interface DispatchTraceRecord {
  unit: string;
  project: string;
  member: string;
  kind: string;
  agent_kind: "native" | "cli" | "remote";
  agent_model?: string;
  tools: string[];
  cwd?: string;
  timeout_ms: number;
  /** Env var NAMES only (env.ts#describeMemberEnv) — every baseline var plus every connector-granted
   * var this dispatch's env carried, structurally incapable of carrying a value. */
  env: DispatchTraceEnvEntry[];
  /** Whether env.ts#scopeHome swapped in a scratch HOME for this dispatch — a fact about which code
   * path ran, never the literal directory. */
  home_scoped: boolean;
  anthropic_api_key_present: boolean;
  /** Finding 112: whether a real spawnable native binary was found — reported by the WORKER
   * (`sdk-worker.ts`, the only place that ever knows on a compiled build; see
   * `resolvePathToClaudeCodeExecutable`'s own doc) when it ran far enough to answer, else by the
   * parent's own pre-spawn knowledge for a source build (resolved once, at boundary-construction
   * time, before any dispatch). Absent — never `false` — when neither knows: a compiled-build start
   * trace (the worker hasn't run yet) or a transport-level failure the worker's own `respond()` never
   * reached. `false` is a real, meaningful negative now; `undefined` means "not yet knowable", never
   * conflated with it. */
  native_binary_resolved?: boolean;
  /** This levare process's own pid — not the worker's (unknown until the transport spawns it, after
   * the start trace is already written). Lets a Conductor confirm which process a live trace belongs
   * to; not a substitute for a worker pid this module never has in hand. */
  pid: number;
  started_at: string;
  /** `in_progress` is written ONLY by `buildDispatchTraceStart`, at dispatch start, before anything
   * about the outcome is knowable — never a terminal state. A trace file left at `in_progress` (the
   * dispatch's process died before the amend write landed) is diagnostic in its own right: it is the
   * literal signature of a hang, not an ambiguous empty result. Every field below that isn't knowable
   * until the dispatch finishes is correspondingly optional, populated only by the amend write.
   * Finding 124: `"idle"` is distinct from `"timeout"` — the worker's OWN idle bound firing (no stream
   * activity for N minutes) versus the transport's outer wall-clock kill; see
   * `NativeDispatchOutcome.idle`'s own doc for how the two stay mutually exclusive. */
  outcome: "in_progress" | "ok" | "timeout" | "idle" | "error";
  duration_ms?: number;
  /** Wall-clock timestamp captured at the SAME call site that resolves `duration_ms`/`outcome` (the
   * finish builder, `buildDispatchTrace`) — not derived by adding `duration_ms` to `started_at`, so it
   * reflects when the dispatch actually finished rather than an arithmetic reconstruction of it. `null`
   * for exactly as long as `outcome` stays `"in_progress"` — the amend write is what turns both fields
   * real at once, so a trace can never carry a terminal `outcome` with a null `ended_at`, or vice versa. */
  ended_at: string | null;
  error?: string;
  context: string;
  context_truncated: boolean;
  worker_stdout?: string;
  worker_stdout_truncated?: boolean;
  worker_stderr?: string;
  worker_stderr_truncated?: boolean;
  receipt?: Receipt;
}

export interface NativeDispatchOutcome {
  ok: boolean;
  error?: string;
  timedOut: boolean;
  /** Finding 124: whether the WORKER's own idle bound fired (`sdk-worker.ts#consumeQuery` — no stream
   * activity for N minutes), as opposed to `timedOut` (the transport's outer wall-clock kill). The two
   * are mutually exclusive by construction: a wall-clock kill happens entirely outside the worker (it
   * never gets to respond at all, so it can never report `idle`), and a worker that fires its own idle
   * bound exits cleanly (never triggering the transport's kill). Absent/`false` for every caller that
   * never wires an idle bound through (today: `orchestrator-boundary.ts`'s interpret/narrate/converse
   * traces, which share this same type but never populate this field) — never a stand-in `true`. */
  idle?: boolean;
  durationMs: number;
  /** Wall-clock ISO timestamp taken by the caller at the moment the transport call resolved — see
   * `DispatchTraceRecord.ended_at`'s own doc for why this is captured, not computed from `durationMs`. */
  endedAt: string;
  stdout: string;
  stderr: string;
  receipt?: Receipt;
}

export interface DispatchTraceIdentityOpts {
  homeScoped: boolean;
  anthropicApiKeyPresent: boolean;
  /** See `DispatchTraceRecord.native_binary_resolved` — undefined when not yet knowable, never a
   * stand-in `false`. */
  nativeBinaryResolved?: boolean;
  startedAt: string;
  timeoutMs: number;
}

/**
 * Everything about a dispatch that's known BEFORE it runs — inputs, env var names, HOME scoping, pid,
 * timestamp, timeout bound. Shared by `buildDispatchTraceStart` (written as-is, `outcome: "in_progress"`)
 * and `buildDispatchTrace` (this plus the outcome fields, once they're knowable) so the two never drift
 * out of sync on what "the same dispatch" means. `req`'s `env` is what `describeMemberEnv`-equivalent
 * redaction runs over; callers must pass the SAME env the real spawn used (already allowlisted by
 * `buildMemberEnv` upstream — this function trusts that boundary, exactly as every other consumer of an
 * `InvokeRequest.env` already does) so a trace never reports a broader grant than the dispatch actually
 * held.
 */
function buildDispatchTraceIdentity(req: InvokeRequest, opts: DispatchTraceIdentityOpts) {
  const context = truncate(req.context);
  return {
    unit: req.unit,
    project: req.project,
    member: req.member,
    kind: req.kind,
    agent_kind: req.agent.kind,
    agent_model: req.agent.model,
    tools: req.tools,
    cwd: req.projectRepoPath,
    timeout_ms: opts.timeoutMs,
    // NOTES DISPATCH-TRACE invariant 1: names only, via the SAME redaction guard every other
    // env-describing diagnostic in this codebase must go through — never `req.env` itself.
    env: describeMemberEnv(req.env),
    home_scoped: opts.homeScoped,
    anthropic_api_key_present: opts.anthropicApiKeyPresent,
    native_binary_resolved: opts.nativeBinaryResolved,
    pid: process.pid,
    started_at: opts.startedAt,
    context: context.value,
    context_truncated: context.truncated,
  };
}

/**
 * The start-of-dispatch trace (Finding 113): written before the spawn, so a Conductor reading
 * `.levare/dispatch-logs/` mid-dispatch sees this immediately instead of nothing for the dispatch's
 * entire duration. `outcome: "in_progress"` is the ONLY value this builder ever produces — never a
 * terminal state — so a file left in this shape (the process died before the amend write) reads
 * unambiguously as "started, never finished", not as a completed dispatch that produced nothing.
 */
export function buildDispatchTraceStart(req: InvokeRequest, opts: DispatchTraceIdentityOpts): DispatchTraceRecord {
  return { ...buildDispatchTraceIdentity(req, opts), outcome: "in_progress", ended_at: null };
}

/** What `buildDispatchTrace` (the finish builder) always produces — the outcome-dependent fields
 * `DispatchTraceRecord` otherwise leaves optional (so `buildDispatchTraceStart`'s in-progress shape
 * stays legal) are guaranteed present here, so a caller of the finish builder never has to narrow. */
export type DispatchTraceFinishedRecord = DispatchTraceRecord & {
  duration_ms: number;
  outcome: "ok" | "timeout" | "idle" | "error";
  worker_stdout: string;
  worker_stdout_truncated: boolean;
  worker_stderr: string;
  worker_stderr_truncated: boolean;
};

/**
 * Pure record builder — separated from `writeDispatchTrace`'s disk I/O so a test can assert on the
 * record's shape (in particular, the two invariants this module's own header names) without touching a
 * filesystem. Written on exit: amends the start trace (`buildDispatchTraceStart`) with everything only
 * knowable once the dispatch finished — output, duration, outcome. Callers MUST pass the identical
 * `opts.startedAt` (and, for `writeDispatchTrace`, the same target file) the start trace used, so the
 * finish write lands on the SAME file rather than creating a second one — see `traceFileName`'s own doc.
 */
export function buildDispatchTrace(req: InvokeRequest, outcome: NativeDispatchOutcome, opts: DispatchTraceIdentityOpts): DispatchTraceFinishedRecord {
  const stdout = truncate(outcome.stdout, { fromEnd: true });
  const stderr = truncate(outcome.stderr, { fromEnd: true });
  return {
    ...buildDispatchTraceIdentity(req, opts),
    duration_ms: outcome.durationMs,
    // Finding 124: `idle` is checked before the plain `ok`/`error` split — same "outer bound wins"
    // precedence `timedOut` already had — but AFTER `timedOut`, since the two are mutually exclusive
    // (see `NativeDispatchOutcome.idle`'s own doc): a wall-clock kill happens outside the worker (it
    // never gets to report `idle`), and a worker that fires its own idle bound exits cleanly (never
    // triggering the wall-clock kill).
    outcome: outcome.timedOut ? "timeout" : outcome.idle ? "idle" : outcome.ok ? "ok" : "error",
    ended_at: outcome.endedAt,
    error: outcome.error,
    worker_stdout: stdout.value,
    worker_stdout_truncated: stdout.truncated,
    worker_stderr: stderr.value,
    worker_stderr_truncated: stderr.truncated,
    receipt: outcome.receipt,
  };
}

// Filesystem-safe, monotonically-sortable-by-name file stem: an ISO timestamp with the colons that
// break Windows/some POSIX tooling replaced, plus unit/kind/member so a Conductor can spot the right
// file without opening it. `member` may itself contain a `/` (team/member — see AdapterRunner#author's
// own `producedBy` convention); replaced the same way.
function traceFileName(record: DispatchTraceRecord, now: string): string {
  const stamp = now.replace(/[:.]/g, "-");
  const safeMember = record.member.replace(/\//g, "_");
  return `${stamp}-${record.unit}-${record.kind}-${safeMember}.json`;
}

/**
 * Best-effort retention sweep — mirrors every other scratch-resource cleanup in this codebase (never
 * fails the caller over a cleanup that couldn't complete). Deletes anything beyond `DISPATCH_TRACE_MAX_
 * FILES` (oldest first, by mtime) AND anything older than `DISPATCH_TRACE_MAX_AGE_MS`, independently —
 * either bound alone can delete a file the other bound would have kept.
 */
export function sweepDispatchTraces(dir: string, now: number = Date.now(), maxFiles: number = DISPATCH_TRACE_MAX_FILES, maxAgeMs: number = DISPATCH_TRACE_MAX_AGE_MS): void {
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return; // directory doesn't exist yet, or unreadable — nothing to sweep
  }
  const withStats = entries
    .map((name) => {
      try {
        return { name, mtimeMs: statSync(join(dir, name)).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((e): e is { name: string; mtimeMs: number } => e !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first

  const toDelete = new Set<string>();
  for (const e of withStats.slice(maxFiles)) toDelete.add(e.name);
  for (const e of withStats) if (now - e.mtimeMs > maxAgeMs) toDelete.add(e.name);

  for (const name of toDelete) {
    try {
      unlinkSync(join(dir, name));
    } catch {
      /* best-effort — a trace file surviving a failed sweep is not worth failing the run over */
    }
  }
}

// Shared by `writeDispatchTrace`/`writeOrchestratorTrace` — the disk-I/O half of "write a trace",
// identical for both record shapes (same directory, same best-effort swallow, same opportunistic
// sweep). Only the filename derivation differs between the two, so that stays with each caller.
function writeTraceFile(studioRoot: string, fileName: string, record: unknown, describeFailure: string): void {
  const dir = join(studioRoot, DISPATCH_LOG_DIR_NAME);
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, fileName), JSON.stringify(record, null, 2));
    sweepDispatchTraces(dir);
  } catch (e) {
    console.error(`levare: could not write ${describeFailure}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Writes one dispatch trace to `<studioRoot>/.levare/dispatch-logs/` and sweeps retention. Best-effort:
 * a write failure (disk full, permissions) is logged and swallowed, never thrown — a diagnostic that can
 * crash the dispatch it's diagnosing would be strictly worse than the silence it replaces.
 */
export function writeDispatchTrace(studioRoot: string, record: DispatchTraceRecord, now: string = record.started_at): void {
  writeTraceFile(studioRoot, traceFileName(record, now), record, `dispatch trace for ${record.member}/${record.kind} (${record.unit})`);
}

// ---------------------------------------------------------------------------------------------
// Orchestrator traces (Finding 94): interpret()/narrate()/converse() (orchestrator-boundary.ts) are
// SDK calls through the exact same transport a member dispatch uses, but they carry no unit/project/
// member/kind — there is no InvokeRequest, no `agent`, nothing `DispatchTraceRecord` requires as
// identity. Rather than widen that type with a second, unrelated set of optional fields (which would
// leave one type describing two call shapes and weaken the "every member trace has unit/member/kind"
// guarantee this module's other consumers rely on), this is a sibling record — sharing truncation,
// filename derivation, and the retention sweep, not the shape. A `converse()` timeout was the ORIGINAL
// gap Finding 94 named: `interpret()` failing twice at 45000ms left nothing in `.levare/dispatch-logs/`
// at all, because the trace only ever covered the member path.
//
// `env` here is the Orchestrator's own env (`opts.env ?? process.env` in orchestrator-boundary.ts) —
// the UNFILTERED process environment, or an unallowlisted caller override, never a member's
// `buildMemberEnv`-allowlisted subset. `describeMemberEnv`'s redaction guarantee (names only, never a
// value) holds regardless of which env record is passed in — it's structurally value-blind — but the
// NAME SET an Orchestrator trace records is consequently broader than a member trace's own. No
// `home_scoped` field either: the Orchestrator path never calls `scopeHome` at all, and a `false`
// here would misleadingly imply scoping was considered and declined rather than never applicable.

export type OrchestratorCall = "interpret" | "narrate" | "converse";

export interface OrchestratorTraceRecord {
  call: OrchestratorCall;
  model: string;
  timeout_ms: number;
  /** Env var NAMES only — see this section's own header for why the set is broader than a member
   * trace's. */
  env: DispatchTraceEnvEntry[];
  anthropic_api_key_present: boolean;
  pid: number;
  started_at: string;
  /** Same `in_progress` sentinel and same reasoning as `DispatchTraceRecord.outcome` — written only by
   * `buildOrchestratorTraceStart`, never a terminal state. Finding 160: `"idle"` is the same distinct
   * outcome `DispatchTraceRecord.outcome` already carries for the native path — the Orchestrator's own
   * idle bound (orchestrator-boundary.ts's `DEFAULT_ORCHESTRATOR_IDLE_TIMEOUT_MS`) firing, as opposed
   * to the outer wall-clock kill (`"timeout"`); the two stay mutually exclusive by the same construction
   * `NativeDispatchOutcome.idle`'s own doc describes. */
  outcome: "in_progress" | "ok" | "timeout" | "idle" | "error";
  duration_ms?: number;
  /** Same fact, same capture discipline, as `DispatchTraceRecord.ended_at` — a sibling record, not a
   * shared shape, but this field's meaning and its `in_progress` → real transition are identical. */
  ended_at: string | null;
  error?: string;
  prompt: string;
  prompt_truncated: boolean;
  worker_stdout?: string;
  worker_stdout_truncated?: boolean;
  worker_stderr?: string;
  worker_stderr_truncated?: boolean;
  receipt?: Receipt;
}

export interface OrchestratorTraceIdentityOpts {
  call: OrchestratorCall;
  model: string;
  timeoutMs: number;
  env: Record<string, string | undefined>;
  anthropicApiKeyPresent: boolean;
  startedAt: string;
  prompt: string;
}

function buildOrchestratorTraceIdentity(opts: OrchestratorTraceIdentityOpts) {
  const prompt = truncate(opts.prompt);
  return {
    call: opts.call,
    model: opts.model,
    timeout_ms: opts.timeoutMs,
    env: describeMemberEnv(opts.env),
    anthropic_api_key_present: opts.anthropicApiKeyPresent,
    pid: process.pid,
    started_at: opts.startedAt,
    prompt: prompt.value,
    prompt_truncated: prompt.truncated,
  };
}

/** The start-of-call trace (Finding 94): written before the transport call, mirroring
 * `buildDispatchTraceStart` — everything known up front, `outcome: "in_progress"` until amended. */
export function buildOrchestratorTraceStart(opts: OrchestratorTraceIdentityOpts): OrchestratorTraceRecord {
  return { ...buildOrchestratorTraceIdentity(opts), outcome: "in_progress", ended_at: null };
}

export type OrchestratorTraceFinishedRecord = OrchestratorTraceRecord & {
  duration_ms: number;
  outcome: "ok" | "timeout" | "idle" | "error";
  worker_stdout: string;
  worker_stdout_truncated: boolean;
  worker_stderr: string;
  worker_stderr_truncated: boolean;
};

/** The finish trace — amends the start trace with the outcome, mirroring `buildDispatchTrace`.
 * `outcome` here is the SAME shape `NativeDispatchOutcome` already describes (ok/error/timedOut/idle/
 * durationMs/stdout/stderr/receipt) — the Orchestrator's transport call produces the identical summary
 * a member dispatch's does, via the same `asSdkTransportResult`. */
export function buildOrchestratorTrace(outcome: NativeDispatchOutcome, opts: OrchestratorTraceIdentityOpts): OrchestratorTraceFinishedRecord {
  const stdout = truncate(outcome.stdout, { fromEnd: true });
  const stderr = truncate(outcome.stderr, { fromEnd: true });
  return {
    ...buildOrchestratorTraceIdentity(opts),
    duration_ms: outcome.durationMs,
    // Finding 160: `idle` checked before the plain `ok`/`error` split, after `timedOut` — identical
    // precedence to `buildDispatchTrace`'s own (the two are mutually exclusive by construction).
    outcome: outcome.timedOut ? "timeout" : outcome.idle ? "idle" : outcome.ok ? "ok" : "error",
    ended_at: outcome.endedAt,
    error: outcome.error,
    worker_stdout: stdout.value,
    worker_stdout_truncated: stdout.truncated,
    worker_stderr: stderr.value,
    worker_stderr_truncated: stderr.truncated,
    receipt: outcome.receipt,
  };
}

// Same reasoning as `traceFileName`: filesystem-safe, sortable-by-name, keyed on `started_at` (not
// wall-clock-at-write-time) so a start write and its later amend land on the identical file.
function orchestratorTraceFileName(record: OrchestratorTraceRecord, now: string): string {
  const stamp = now.replace(/[:.]/g, "-");
  return `${stamp}-orchestrator-${record.call}.json`;
}

/** Writes one Orchestrator trace — same directory, same best-effort swallow, same opportunistic
 * retention sweep as `writeDispatchTrace`. */
export function writeOrchestratorTrace(studioRoot: string, record: OrchestratorTraceRecord, now: string = record.started_at): void {
  writeTraceFile(studioRoot, orchestratorTraceFileName(record, now), record, `orchestrator trace for ${record.call}()`);
}

/**
 * Findings 162/95: `interpret()`/`narrate()`/`converse()` have no unit or project to attach a
 * usage-bearing artifact to (`OrchestratorTraceIdentityOpts`'s own doc — there is genuinely nowhere
 * unit-scoped to bill this cost against), so unlike every other total in this codebase (all of them a
 * sum over `Repo.artifacts`), Orchestrator spend can only ever be read back from the trace files
 * themselves. Best-effort and read-only, mirroring `sweepDispatchTraces`: a missing/unreadable
 * directory or a corrupt trace file contributes nothing rather than throwing. `calls` counts every
 * FINISHED call (`in_progress` excluded) regardless of whether it carried a priced receipt, so a studio
 * can tell "zero calls" apart from "calls happened, none reported usage".
 */
export function orchestratorSpend(studioRoot: string): { usd: number; calls: number } {
  const dir = join(studioRoot, DISPATCH_LOG_DIR_NAME);
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith(".json") && f.includes("-orchestrator-"));
  } catch {
    return { usd: 0, calls: 0 };
  }
  let usd = 0;
  let calls = 0;
  for (const name of entries) {
    try {
      const record = JSON.parse(readFileSync(join(dir, name), "utf8")) as OrchestratorTraceRecord;
      if (record.outcome === "in_progress") continue;
      calls += 1;
      if (typeof record.receipt?.usd === "number") usd += record.receipt.usd;
    } catch {
      /* corrupt/partial trace file — contributes nothing, doesn't fail the total */
    }
  }
  return { usd: Math.round(usd * 100) / 100, calls };
}

// ---------------------------------------------------------------------------------------------
// Cli dispatch traces (Finding 132): `writeDispatchTrace` above is called only from the two native
// boundaries (`createSdkNativeBoundary`/`createAsyncSdkNativeBoundary`) — `DispatchTraceRecord.
// agent_kind`'s `"cli"` and `"remote"` variants were declared but structurally unreachable, so a `kind:
// cli` member ran with no diagnostic surface at all. Findings 52 (six rounds of live-sandbox debugging
// to explain a codex dispatch's own failure), 54 (still unobserved — needs a codex dispatch to see), and
// 139 (a cli member's auth failure is invisible because the vendor subprocess exposes no error_status)
// are the same blindness from three angles.
//
// This is a SIBLING record, not a widened `DispatchTraceRecord` — the same "don't invent a shape that
// can't be populated" reasoning `OrchestratorTraceRecord` above already established. A `kind: cli`
// dispatch is a vendor subprocess (`AdapterRunner#runCli`/`runCliAsync`), not an SDK worker: there is no
// message stream, no receipt, no token accounting, no `native_binary_resolved` question — copying those
// fields across would leave them structurally always-null, which Finding 112 already named as worse
// than simply not having the field.
//
// `agent_kind: "cli"` is a literal, not `DispatchTraceRecord.agent_kind`'s own type — kept as a real
// field (not just implied by which file this builder lives in) so a Conductor grepping
// `.levare/dispatch-logs/*.json` for `"agent_kind"` finds every dispatch kind by the same key, even
// though the shapes around it differ.
//
// `remote` (MCP) is deliberately OUT OF SCOPE for this unit, not merely deferred silently: `mcp-
// client.ts#connectStdioMcpServer` spawns once and stays alive across `listTools`/`listResources`/
// `callTool` calls, and its own `McpSession` interface exposes neither the child's pid nor its stderr
// tail (it tracks a bounded `stderrTail` internally, in a closure, purely to enrich a thrown
// `McpProtocolError`'s own message — never returned to the caller). A remote dispatch's failure mode is
// consequently a thrown protocol error, not an exit code — "exit status" as this record shapes it for
// cli genuinely doesn't fit remote's own shape without widening `McpSession` itself, which is real
// scope this unit did not take on. Cli-only is the deliberate, reported outcome here (the goal's own
// ruling names this as an acceptable answer) — a future unit that widens `McpSession` to expose pid/
// stderr can add a `RemoteDispatchTraceRecord` sibling then, on real evidence of what it can report.
//
// The record is written at dispatch start (`buildCliDispatchTraceStart`, `outcome: "in_progress"`) and
// amended on exit (`buildCliDispatchTrace`), mirroring `buildDispatchTraceStart`/`buildDispatchTrace`'s
// own Finding-113 discipline: a cli dispatch can hang exactly like a native one (Finding 52's own six
// rounds were largely spent on a sandboxed cli spawn that never returned), and a trace stranded at
// `in_progress` is precisely the signature that made the native path's own 2026-08-25 timeout
// diagnosable.
//
// No `outcome: "idle"` here — Finding 124's idle bound is `sdk-worker.ts#consumeQuery` watching a
// message STREAM for inactivity; a cli spawn has no message stream at all, only a wall-clock timeout
// (`SpawnResult.timedOut`, enforced by `Bun.spawnSync`'s own `timeout` option / `asyncBunSpawn`'s own
// `setTimeout`), so `"timeout"` is the only abort outcome this record needs.

// Mirrors `adapters.ts#summarizeArgv`'s own per-element cap and `…(N chars total)` suffix exactly (a
// Conductor reading a trace and an AdapterError message for the SAME dispatch sees the identical
// shape) — reimplemented locally rather than imported, since `adapters.ts` already imports FROM this
// module (`buildDispatchTrace`/`writeDispatchTrace`) and importing back would make the two files
// circular for no real benefit. One argv element can carry a member's ENTIRE §6-assembled context
// (`context_via: arg`, `{task}` substitution) — often thousands of characters — so this must cap PER
// ELEMENT, never truncate the whole array as one joined string the way `truncate()` above does for a
// single field: a whole-string cap could spend its entire budget on argv[1] and silently drop every
// later argument.
const MAX_ARGV_ELEMENT_CHARS = 200;
function truncateArgvElements(args: string[]): string[] {
  return args.map((a) => (a.length > MAX_ARGV_ELEMENT_CHARS ? `${a.slice(0, MAX_ARGV_ELEMENT_CHARS)}…(${a.length} chars total)` : a));
}

export interface CliDispatchTraceRecord {
  agent_kind: "cli";
  unit: string;
  project: string;
  member: string;
  kind: string;
  /** The resolved argv[0] this dispatch actually spawned — the WRAPPED command (`bwrap`/`sandbox-exec`
   * when a sandbox tier engaged), never the pre-wrap member command, mirroring
   * `adapters.ts#cliResultToDoc`'s own "wrapped argv, not the member's" precedent: a trace that named
   * what the member WOULD have run unsandboxed would make "did the wrapper even engage" just as
   * impossible to tell from the trace as it used to be from the error text alone. */
  command: string;
  /** `argv.slice(1)`, each element capped (`truncateArgvElements`) — never the raw, unbounded array. */
  args: string[];
  cwd?: string;
  timeout_ms: number;
  /** Env var NAMES only (env.ts#describeMemberEnv), over the env this dispatch's spawn ACTUALLY carried
   * — including any `full`-tier sandbox redirect (`GIT_CONFIG_GLOBAL`, `GH_CONFIG_DIR`, etc. —
   * adapters.ts#fullSandboxEnvRedirect), never the pre-redirect allowlist alone. */
  env: DispatchTraceEnvEntry[];
  /** Same fact, same meaning, as `DispatchTraceRecord.home_scoped` — whether `env.ts#scopeHome` swapped
   * in a scratch HOME for this dispatch. */
  home_scoped: boolean;
  /** The OS sandbox enforcement level this spawn actually ran under (`adapters.ts#sandboxWrap`) —
   * absent only when the spawn boundary was a test double (`this.spawn !== bunSpawn`), which never
   * wraps anything at all; see `sandboxWrap`'s own doc for why a double is never wrapped. */
  sandbox_level?: SandboxLevel;
  /** `req.agent.sandbox_reason` — present only when the member DECLARED `sandbox: unsandboxed` (an
   * author-stated fact that this member's process cannot run confined), distinct from
   * `sandbox_level: "none"` meaning merely "this host has no working primitive" — the same distinction
   * `AdapterRunner#author`'s own `sandbox_reason:` artifact line already draws. */
  sandbox_reason?: string;
  /** Whether this dispatch held a real dispatch-worktree git write grant (`req.dispatchGitWriteGrant`)
   * — a fact about which code path ran, never the granted paths themselves (those are real filesystem
   * locations under the operator's own project checkout, not a value this trace needs to name). */
  git_write_grant: boolean;
  /** Whether a fresh, per-dispatch vendor-CLI scratch redirect (`adapters.ts#createCliVendorScratch`)
   * applied to this spawn — never the scratch directory's own path, exactly `git_write_grant`'s own
   * boolean-fact-not-a-path discipline. */
  vendor_scratch: boolean;
  /** This levare process's own pid — see `DispatchTraceRecord.pid`'s own doc for why this is never the
   * spawned child's pid at start-trace time (the child doesn't exist yet when this is written). */
  pid: number;
  /** The spawned CLI's own pid — unlike native's own worker pid (never captured anywhere in this
   * codebase, per `DispatchTraceRecord.pid`'s own doc), a cli spawn's pid IS cheaply available the
   * instant `Bun.spawnSync`/`Bun.spawn` returns, well before this dispatch's own outer promise/call
   * resolves — populated only on the finish write (`buildCliDispatchTrace`), absent on the in-progress
   * start trace for the same reason `pid` above is never the child's: it doesn't exist yet. */
  child_pid?: number;
  started_at: string;
  /** Same `in_progress` sentinel and reasoning as `DispatchTraceRecord.outcome` (Finding 113) — written
   * only by `buildCliDispatchTraceStart`, before the spawn, never a terminal state. No `"idle"` variant
   * — see this section's own header for why a cli spawn has nothing an idle bound could watch. */
  outcome: "in_progress" | "ok" | "timeout" | "error";
  duration_ms?: number;
  /** Same capture discipline as `DispatchTraceRecord.ended_at` — real wall clock at the call site
   * closest to the spawn actually resolving, never arithmetic. */
  ended_at: string | null;
  /** `SpawnResult.exitCode` verbatim — `-1` means killed by signal (`proc.exitCode === null`), never a
   * real exit code; see `SpawnResult.signalCode`'s own doc for why the two must be read together. */
  exit_code?: number;
  signal_code?: string | null;
  error?: string;
  /** Bounded TAIL of the CLI's own stderr (`truncate(…, { fromEnd: true })`, this module's own cap) —
   * never the full, unbounded stream. */
  stderr_tail?: string;
  stderr_tail_truncated?: boolean;
  /** Bounded tail of stdout — cli auth/protocol failures often surface on stdout rather than stderr
   * (`adapters.ts#vendorStructuredError` already checks both, and `diagnoseCliFailure` falls back to
   * stdout's own last non-empty line when stderr is empty) — Finding 139's own "cli auth failure is
   * invisible" gap is exactly this: an auth error a vendor CLI printed to stdout, which this trace would
   * otherwise never record at all. */
  stdout_tail?: string;
  stdout_tail_truncated?: boolean;
}

export interface CliDispatchTraceIdentityOpts {
  unit: string;
  project: string;
  member: string;
  kind: string;
  command: string;
  args: string[];
  cwd?: string;
  timeoutMs: number;
  /** The ACTUAL spawn env (post sandbox redirect) — see `CliDispatchTraceRecord.env`'s own doc. */
  env: Record<string, string>;
  homeScoped: boolean;
  sandboxLevel?: SandboxLevel;
  sandboxReason?: string;
  gitWriteGrant: boolean;
  vendorScratch: boolean;
  startedAt: string;
}

function buildCliDispatchTraceIdentity(opts: CliDispatchTraceIdentityOpts) {
  return {
    agent_kind: "cli" as const,
    unit: opts.unit,
    project: opts.project,
    member: opts.member,
    kind: opts.kind,
    command: opts.command,
    args: truncateArgvElements(opts.args),
    cwd: opts.cwd,
    timeout_ms: opts.timeoutMs,
    env: describeMemberEnv(opts.env),
    home_scoped: opts.homeScoped,
    sandbox_level: opts.sandboxLevel,
    sandbox_reason: opts.sandboxReason,
    git_write_grant: opts.gitWriteGrant,
    vendor_scratch: opts.vendorScratch,
    pid: process.pid,
    started_at: opts.startedAt,
  };
}

/** The start-of-dispatch trace (Finding 113's discipline, applied to cli): written before the spawn, so
 * a hung cli dispatch (Finding 52's own six rounds) leaves something in `.levare/dispatch-logs/` for its
 * entire duration instead of nothing. `outcome: "in_progress"` is the only value this ever produces. */
export function buildCliDispatchTraceStart(opts: CliDispatchTraceIdentityOpts): CliDispatchTraceRecord {
  return { ...buildCliDispatchTraceIdentity(opts), outcome: "in_progress", ended_at: null };
}

export interface CliDispatchOutcome {
  timedOut: boolean;
  durationMs: number;
  endedAt: string;
  exitCode?: number;
  signalCode?: string | null;
  childPid?: number;
  stdout: string;
  stderr: string;
}

export type CliDispatchTraceFinishedRecord = CliDispatchTraceRecord & {
  duration_ms: number;
  outcome: "ok" | "timeout" | "error";
  stderr_tail: string;
  stderr_tail_truncated: boolean;
  stdout_tail: string;
  stdout_tail_truncated: boolean;
};

/** The finish trace — amends the start trace with everything only knowable once the spawn resolved:
 * exit status, duration, the stderr/stdout tails. `outcome` is `"ok"` only for a real zero exit; a
 * signal-killed or nonzero-exit spawn is `"error"`, exactly `AdapterRunner#cliResultToDoc`'s own
 * exitCode/signal handling — this never re-derives success from anything other than `exitCode === 0`. */
export function buildCliDispatchTrace(outcome: CliDispatchOutcome, opts: CliDispatchTraceIdentityOpts): CliDispatchTraceFinishedRecord {
  const stderr = truncate(outcome.stderr, { fromEnd: true });
  const stdout = truncate(outcome.stdout, { fromEnd: true });
  return {
    ...buildCliDispatchTraceIdentity(opts),
    duration_ms: outcome.durationMs,
    outcome: outcome.timedOut ? "timeout" : outcome.exitCode === 0 ? "ok" : "error",
    ended_at: outcome.endedAt,
    exit_code: outcome.exitCode,
    signal_code: outcome.signalCode,
    child_pid: outcome.childPid,
    stderr_tail: stderr.value,
    stderr_tail_truncated: stderr.truncated,
    stdout_tail: stdout.value,
    stdout_tail_truncated: stdout.truncated,
  };
}

// Same reasoning as `traceFileName`/`orchestratorTraceFileName`: filesystem-safe, sortable-by-name,
// keyed on `started_at` so a start write and its later amend land on the identical file.
function cliTraceFileName(record: CliDispatchTraceRecord, now: string): string {
  const stamp = now.replace(/[:.]/g, "-");
  const safeMember = record.member.replace(/\//g, "_");
  return `${stamp}-${record.unit}-${record.kind}-${safeMember}-cli.json`;
}

/** Writes one cli dispatch trace — same directory, same best-effort swallow, same opportunistic
 * retention sweep as `writeDispatchTrace`/`writeOrchestratorTrace`. */
export function writeCliDispatchTrace(studioRoot: string, record: CliDispatchTraceRecord, now: string = record.started_at): void {
  writeTraceFile(studioRoot, cliTraceFileName(record, now), record, `cli dispatch trace for ${record.member}/${record.kind} (${record.unit})`);
}

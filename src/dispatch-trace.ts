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

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describeMemberEnv } from "./env.ts";
import type { InvokeRequest } from "./adapters.ts";
import type { Receipt } from "./types.ts";

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
  native_binary_resolved: boolean;
  started_at: string;
  duration_ms: number;
  outcome: "ok" | "timeout" | "error";
  error?: string;
  context: string;
  context_truncated: boolean;
  worker_stdout: string;
  worker_stdout_truncated: boolean;
  worker_stderr: string;
  worker_stderr_truncated: boolean;
  receipt?: Receipt;
}

export interface NativeDispatchOutcome {
  ok: boolean;
  error?: string;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  receipt?: Receipt;
}

/**
 * Pure record builder — separated from `writeDispatchTrace`'s disk I/O so a test can assert on the
 * record's shape (in particular, the two invariants this module's own header names) without touching a
 * filesystem. `req` is the InvokeRequest actually handed to the boundary — its `env` is what
 * `describeMemberEnv`-equivalent redaction runs over; callers must pass the SAME env the real spawn used
 * (already allowlisted by `buildMemberEnv` upstream — this function trusts that boundary, exactly as
 * every other consumer of an `InvokeRequest.env` already does) so a trace never reports a broader grant
 * than the dispatch actually held.
 */
export function buildDispatchTrace(
  req: InvokeRequest,
  outcome: NativeDispatchOutcome,
  opts: { homeScoped: boolean; anthropicApiKeyPresent: boolean; nativeBinaryResolved: boolean; startedAt: string; timeoutMs: number },
): DispatchTraceRecord {
  const context = truncate(req.context);
  const stdout = truncate(outcome.stdout, { fromEnd: true });
  const stderr = truncate(outcome.stderr, { fromEnd: true });
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
    started_at: opts.startedAt,
    duration_ms: outcome.durationMs,
    outcome: outcome.timedOut ? "timeout" : outcome.ok ? "ok" : "error",
    error: outcome.error,
    context: context.value,
    context_truncated: context.truncated,
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

/**
 * Writes one dispatch trace to `<studioRoot>/.levare/dispatch-logs/` and sweeps retention. Best-effort:
 * a write failure (disk full, permissions) is logged and swallowed, never thrown — a diagnostic that can
 * crash the dispatch it's diagnosing would be strictly worse than the silence it replaces.
 */
export function writeDispatchTrace(studioRoot: string, record: DispatchTraceRecord, now: string = record.started_at): void {
  const dir = join(studioRoot, DISPATCH_LOG_DIR_NAME);
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const file = join(dir, traceFileName(record, now));
    writeFileSync(file, JSON.stringify(record, null, 2));
    sweepDispatchTraces(dir);
  } catch (e) {
    console.error(`levare: could not write dispatch trace for ${record.member}/${record.kind} (${record.unit}): ${e instanceof Error ? e.message : String(e)}`);
  }
}

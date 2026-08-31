// The SDK worker's own logic: runs exactly one real Claude Agent SDK query to completion and prints
// its outcome as a single line of JSON on stdout. Reached two ways (NOTES DIST5):
//
//   - In-process, via `runSdkWorkerFromStdin()` below — this is what `cli.ts`'s hidden `__worker`
//     subcommand calls when a fresh copy of levare ITSELF is spawned in worker mode (the standard
//     `bun build --compile` self-invocation pattern; see sdk-transport.ts's `workerSpawnArgv`). This
//     is the path every real caller (source or compiled) takes today.
//   - Standalone, via this file's own `if (import.meta.main)` guard — kept so a test can still point
//     `createBunSdkTransport`/`createAsyncSdkTransport` at an arbitrary worker SCRIPT (a real file
//     path, spawned with a real `bun` interpreter) to simulate a slow/hung/broken worker without
//     touching the real SDK — see tests/orchestrator-sdk.test.ts and tests/sdk-transport-hermetic.test.ts.
//
// Either way, the caller blocks on it via `Bun.spawnSync`/`Bun.spawn` (adapters.ts's `bunSpawn`
// already blocks on the "cli" agent kind the same way). Never logs or persists `ANTHROPIC_API_KEY`:
// this file never reads the key's value — it only spreads its own already-scoped `process.env` (set
// by the parent's spawn call, per sdk-transport.ts's env-trust-boundary note) into the SDK's own
// `options.env`, explicitly rather than relying on the SDK's documented "omitted env inherits
// process.env" default — being explicit here removes any doubt that the credential the launching
// process was granted actually reaches the inner `claude` CLI subprocess the SDK itself spawns
// (invariant 11).
//
// `settingSources: []` + `persistSession: false` (NOTES phase-7 K15): a live host hung indefinitely
// because the spawned CLI inherited the OPERATOR's personal Claude Code configuration — specifically
// a user-installed SessionEnd hook that never completed in a TTY-less spawned subprocess. Passing an
// empty `settingSources` array is the SDK's own documented "isolation mode" — no user/project/local
// settings are loaded at all, so a hook has nothing to fire from; `persistSession: false` additionally
// stops session transcripts from being written to `~/.claude/projects/` at all. Combined with
// sdk-transport.ts's `CLAUDE_CONFIG_DIR` redirection, this spawn never reads from or writes to the
// operator's real Claude Code profile — the same hermetic-subprocess discipline already applied to
// every git invocation in this codebase (NOTES A4/E12), now applied to the CLI subprocess too.

import { existsSync } from "node:fs";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SettingSource, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { extractFromBunfs } from "@anthropic-ai/claude-agent-sdk/extract";
import type { SdkWorkerRequest, SdkWorkerResponse, FailureClass } from "./sdk-transport.ts";
import type { Receipt } from "./types.ts";
import { isCompiledBuild } from "./version.ts";
// The SAME embedded asset sdk-transport.ts imports — this file runs as a fresh self-invocation of
// the identical compiled binary (NOTES DIST5's `workerSpawnArgv`), so it sees the identical `$bunfs`
// and the identical embedded value.
import embeddedNativeBinaryAsset from "./native-binary.generated.ts";

function respond(res: SdkWorkerResponse): void {
  console.log(JSON.stringify(res));
}

/**
 * Resolve the real, spawnable `pathToClaudeCodeExecutable` for this request. If the parent already
 * resolved one (the source-tree case — `sdk-transport.ts#resolveNativeBinary`), use it unchanged.
 * Otherwise, for a compiled build with an embedded asset, extract it HERE — this is the one safe
 * place to do so; see `sdk-transport.ts`'s module comment on why the parent process never attempts
 * this itself (NOTES DIST7 addendum: neither `require()` nor a runtime dynamic `import()` of any
 * `@anthropic-ai/claude-agent-sdk` subpath works inside a compiled binary, confirmed empirically —
 * only this file's own top-level static imports, reachable because `cli.ts` loads this module via a
 * dynamic `import("./sdk-worker.ts")` gated on the hidden `__worker` command, ever resolve here).
 * Falls through to `undefined` (never throws) when nothing was embedded either — `query()` then
 * attempts its own last-resort lookup, exactly as it always has when explicit resolution comes up
 * empty (NOTES phase-7 K14).
 */
function resolvePathToClaudeCodeExecutable(requested: string | undefined): string | undefined {
  if (requested) return requested;
  if (!isCompiledBuild() || embeddedNativeBinaryAsset === null) return undefined;
  try {
    const extracted = extractFromBunfs(embeddedNativeBinaryAsset);
    return existsSync(extracted) ? extracted : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Pure request → `query()` options mapping, factored out specifically so a test can assert the
 * EXACT hermetic configuration (`settingSources: []`, `persistSession: false`) without spawning a
 * real subprocess or invoking the real SDK — see tests/sdk-transport-hermetic.test.ts (NOTES K15).
 */
export function buildQueryOptions(req: SdkWorkerRequest) {
  return {
    systemPrompt: req.systemPrompt,
    model: req.model,
    tools: req.tools ?? [],
    allowedTools: req.allowedTools ?? [],
    outputFormat: req.outputFormat,
    cwd: req.cwd,
    // Explicit, never left to the SDK's own implicit resolution (NOTES phase-7 K14): a live host
    // showed the SDK's internal require.resolve-based lookup fail to find a platform binary that
    // genuinely existed as a sibling node_modules package. For a source run, sdk-transport.ts
    // resolves the exact same binary itself (once, at boundary-construction time) and hands the
    // resolved path here unchanged; for a compiled run, the parent leaves this unset and
    // `resolvePathToClaudeCodeExecutable` (above) resolves+extracts the embedded asset right here
    // instead (NOTES DIST7 — the parent process can never safely do that extraction itself). Only
    // when NEITHER produced a path does this stay undefined and the SDK attempt its own lookup as a
    // last resort (which will report the same failure either way, never a silent mismatch).
    pathToClaudeCodeExecutable: resolvePathToClaudeCodeExecutable(req.pathToClaudeCodeExecutable),
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    // SDK isolation mode (NOTES K15) — no user/project/local settings, so a user-installed hook (the
    // confirmed hang cause on a live host) has nothing to fire from; nothing is persisted to disk.
    settingSources: [] as SettingSource[],
    persistSession: false,
    // Explicit, not omitted: spread this process's own env (already scoped by the parent spawn, per
    // sdk-transport.ts's env-trust-boundary note) so the SDK's inner `claude` subprocess is guaranteed
    // the same credentials this worker itself was launched with.
    env: { ...process.env },
  };
}

/**
 * NOTES F11: the model that ACTUALLY produced a response — derived from the result message's own
 * `modelUsage`, cross-checked against `respondingModel` (tracked by the caller from each streamed
 * `assistant` message's own `message.model`, a `BetaMessage` field), never guessed from `modelUsage`'s
 * key order.
 *
 * Proven live: a single `query()` call can report MULTIPLE models in `modelUsage` — an internal
 * auxiliary call (observed: automatic memory recall) ran on `claude-haiku-4-5-20251001` alongside the
 * actual response, which correctly ran on the requested `claude-sonnet-5` — with no signal in that
 * object's key order about which one generated `result.result`. The prior code took
 * `Object.entries(modelUsage)[0]` on the (false) assumption that "every call passes exactly one
 * explicit model" (recorded as a since-corrected comment right at that line) — plain JS object key
 * order is insertion order, not significance order, and an unrelated auxiliary call inserted its key
 * FIRST in the reproduced case. `respondingModel` — the LAST assistant turn's own model, the one whose
 * content the result message actually reports — is the fix; `modelUsage[0]` stays only as a fallback
 * for the (untested-live, believed impossible) case where no `assistant` message was ever seen.
 *
 * `tokens_in`/`tokens_out`/`tokens_cache_read`/`tokens_cache_write`/`usd` still SUM every entry in
 * `modelUsage` — that is correct: the member genuinely cost that much regardless of which internal
 * call spent which tokens. Only the reported MODEL NAME needed fixing, not the cost accounting.
 *
 * NOTES "receipt cache tokens": the SDK's own `ModelUsage` (agentSdkTypes.d.ts, re-exported from
 * sdk.d.ts) carries `cacheReadInputTokens`/`cacheCreationInputTokens` alongside `inputTokens`/
 * `outputTokens` — real fields on every entry, not a speculative addition. Before this, only
 * `inputTokens`/`outputTokens` were summed, so `total_cost_usd` (which the SDK prices INCLUDING cache
 * read/write, each at its own rate) always ran ahead of what `tokens_in`/`tokens_out` could account
 * for — a receipt whose own numbers didn't reconcile with its own cost, on every call that touched a
 * cached prompt (i.e. nearly every real one: the system prompt/tool definitions are large and static
 * per member). Summed here exactly like `inputTokens`/`outputTokens` always were, so the receipt now
 * reports where the rest of `usd` went instead of leaving it unaccounted for.
 *
 * Factored out (rather than left inline in `main()`'s loop) specifically so a test can feed a
 * synthetic multi-model `modelUsage` object and assert the correct model wins, without spawning a
 * real subprocess or mocking the SDK's own `query()` async generator — see
 * tests/sdk-worker-receipt.test.ts.
 */
export function deriveReceipt(
  message: {
    modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }>;
    duration_ms?: number;
    total_cost_usd?: number;
  },
  respondingModel: string | null,
  reqModel?: string,
): Receipt {
  const modelUsage = Object.entries(message.modelUsage ?? {});
  const tokensIn = modelUsage.length ? modelUsage.reduce((sum, [, u]) => sum + (u.inputTokens ?? 0), 0) : null;
  const tokensOut = modelUsage.length ? modelUsage.reduce((sum, [, u]) => sum + (u.outputTokens ?? 0), 0) : null;
  const tokensCacheRead = modelUsage.length ? modelUsage.reduce((sum, [, u]) => sum + (u.cacheReadInputTokens ?? 0), 0) : null;
  const tokensCacheWrite = modelUsage.length ? modelUsage.reduce((sum, [, u]) => sum + (u.cacheCreationInputTokens ?? 0), 0) : null;
  return {
    model: respondingModel ?? modelUsage[0]?.[0] ?? reqModel ?? null,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    tokens_cache_read: tokensCacheRead,
    tokens_cache_write: tokensCacheWrite,
    wall_clock_s: typeof message.duration_ms === "number" ? message.duration_ms / 1000 : null,
    usd: typeof message.total_cost_usd === "number" ? message.total_cost_usd : null,
    unreported: modelUsage.length === 0 && typeof message.total_cost_usd !== "number",
  };
}

/**
 * NOTES DISPATCH-TRACE (native-dispatch-hang investigation, phase 1 recovery): renders one streamed
 * `assistant` message's own content blocks — the member's own text and tool calls, `Write` included —
 * into stderr log lines. Phase 1 established that this worker previously retained NOTHING from the
 * stream except two narrow signals (`api_retry`, the responding model) plus whatever the terminal
 * `result` message's own `.result` text held; every intermediate block, including a `Write` tool call's
 * full input, was inspected only for those two signals and then discarded — the same mechanism behind
 * both the empty `worker_stdout`/`worker_stderr` on a killed dispatch AND the standing Finding 70 (a
 * `Write`-heavy member's real output never reaching `resultText`, because `resultText` is only ever the
 * final text turn, never a superset of prior tool_use content).
 *
 * Factored out as a pure function — mirrors `deriveReceipt`'s own precedent — so a test can feed a
 * synthetic content array and assert the rendered lines without spawning the real SDK. The caller below
 * logs each returned line to stderr AS THE MESSAGE ARRIVES, not buffered until the end: `sdk-transport.ts`
 * already captures a worker's full stderr unconditionally on every exit path, timeout included (NOTES
 * DISPATCH-TRACE), so a kill mid-stream — the timeout path, where this matters most — now leaves
 * everything streamed before the kill fired sitting in the trace, not only the final line this worker
 * never got the chance to print.
 */
export function assistantContentLogLines(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const lines: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") {
      lines.push(`levare: sdk worker assistant text: ${b.text}`);
    } else if (b.type === "tool_use" && typeof b.name === "string") {
      lines.push(`levare: sdk worker tool_use ${b.name}: ${JSON.stringify(b.input ?? null)}`);
    }
  }
  return lines;
}

/**
 * Finding 92 (REOPENED): the retry loop itself lives entirely inside `@anthropic-ai/claude-agent-sdk`'s
 * `query()` — this worker has no predicate of its own and never did; it only observes each
 * `SDKAPIRetryMessage` as it streams (see the `api_retry` branch below) and, until now, just logged it.
 * The SDK's own retry policy treats 401/403 (invalid or expired credentials) as retryable exactly like
 * 429/5xx — an auth failure can never succeed on retry, so that seven-attempt, 41-second backoff run
 * (evidence: `.levare/dispatch-logs/2026-08-26T09-24-36-148Z-orchestrator-interpret.json`) was always
 * going to end in the SAME 45s wall-clock kill (sdk-transport.ts), reported as a bare timeout with the
 * real cause discarded. This predicate is the one place "retryable" is decided for member dispatch: a
 * `false` here tells the loop below to abort on the FIRST attempt instead of waiting for the SDK to
 * exhaust its own ten retries. Deliberately narrow — only 401/403 are terminal; everything else
 * (429, 5xx, and `null` connection errors) keeps the SDK's existing retry behavior untouched.
 */
export function isNonRetryableAuthStatus(errorStatus: number | null | undefined): boolean {
  return errorStatus === 401 || errorStatus === 403;
}

/**
 * Finding 85: the OTHER operator-actionable shape a vendor call can reject with — any 4xx besides the
 * already-terminal 401/403 (`isNonRetryableAuthStatus`, left untouched — this is a sibling check, not a
 * widening of it) and besides 429 (rate limit stays retryable, same reasoning as that function's own).
 * Anthropic's API returns this range for requests it will never accept as sent — most namely an
 * insufficient credit balance, but also a malformed/oversized request — and no amount of retrying
 * changes that outcome. Deliberately excludes `null` (a connection error, no HTTP response at all — no
 * status to classify from) and 5xx (a vendor-side failure, `transient`'s own territory below).
 */
export function isOperatorActionableStatus(errorStatus: number | null | undefined): boolean {
  return typeof errorStatus === "number" && errorStatus >= 400 && errorStatus < 500 && errorStatus !== 429 && !isNonRetryableAuthStatus(errorStatus);
}

/** The operator-facing message for a non-auth operator-actionable abort (Finding 85) — mirrors
 * `formatAuthFailureError`'s own factoring, but never claims "credentials are invalid or expired": that
 * would be a guess this status range doesn't support (it also covers a rejected request the vendor will
 * never accept as-is, e.g. an insufficient credit balance). */
export function formatOperatorFailureError(status: number, attempt: number): string {
  return `sdk worker: request rejected (HTTP ${status}) on attempt ${attempt} — aborted without retrying, the vendor will not accept this call as sent (check API key permissions, account credit/billing, or the request itself)`;
}

/** The operator-facing message for an aborted auth failure — factored out (mirrors `deriveReceipt`'s
 * own precedent) so a test can assert it names authentication explicitly, without spawning the real
 * SDK. Deliberately says "aborted without retrying", never "timed out": the whole point of Finding 92
 * is that this failure must not be confused with the wall-clock bound (sdk-transport.ts) killing a
 * call that was still legitimately retrying. */
export function formatAuthFailureError(status: number, attempt: number): string {
  return `sdk worker: authentication failure (HTTP ${status}) on attempt ${attempt} — aborted without retrying, credentials are invalid or expired`;
}

/**
 * Finding 167: the commonest operator-actionable failure carries no `error_status` at all — the vendor
 * SDK's own `query()` throws directly (no HTTP round trip, so nothing for `isOperatorActionableStatus`
 * above to see) when there's no valid session, e.g. `Error("Claude Code returned an error result: Not
 * logged in · Please run /login")`. That thrown `Error` is caught raw in `runSdkWorkerFromStdin`'s own
 * catch block below, BEFORE `adapters.ts` wraps it into `native member 'X' sdk call failed: ...` — so
 * this matches the vendor's own message text, never levare's wrapper around it.
 *
 * Mirrors Finding 118's discipline (PR #53's verdict extraction), not a substring check: exact,
 * whole-string equality against a known vendor shape, so a member's own prose mentioning "login" can
 * never false-positive. An unrecognised message returns `undefined` — stays unclassified, Retry stays
 * offered — rather than guessing. Only one string is confirmed to exist today (searched the vendor SDK
 * and every existing test/log for siblings — expired-session, revoked-token, etc. — none found); the
 * map exists so a confirmed sibling can be added later without restructuring this.
 */
const LOCAL_SDK_ERROR_MESSAGES: Record<string, FailureClass> = {
  "Claude Code returned an error result: Not logged in · Please run /login": "operator",
};

export function classifyLocalSdkError(message: string): FailureClass | undefined {
  return LOCAL_SDK_ERROR_MESSAGES[message.trim()];
}

/**
 * Finding 124: races one `iterator.next()` call against an idle timer — resolves `{idle:false,
 * result}` the instant the next message arrives (the common case, on every healthy dispatch), or
 * `{idle:true}` if `idleTimeoutMs` elapses first with no message at all. `idleTimeoutMs` absent (or
 * `0`) skips the race entirely (`await promise` alone) — every existing caller of this worker that
 * never sets `SdkWorkerRequest.idleTimeoutMs` (today: every orchestrator-boundary.ts call, and every
 * test double) keeps its prior no-idle-bound behavior exactly.
 *
 * Factored out as its own pure-ish function (mirrors `deriveReceipt`/`assistantContentLogLines`'s own
 * precedent) so a test can drive the race with a controllable fake promise (one that never resolves, or
 * one that resolves after a known short delay) and real-but-tiny timers, without spawning the real SDK
 * or waiting out a production-sized idle window.
 */
export async function raceIdle<T>(promise: Promise<T>, idleTimeoutMs: number | undefined): Promise<{ idle: true } | { idle: false; result: T }> {
  if (!idleTimeoutMs) return { idle: false, result: await promise };
  let timer: ReturnType<typeof setTimeout>;
  const idled = new Promise<{ idle: true }>((resolve) => {
    timer = setTimeout(() => resolve({ idle: true }), idleTimeoutMs);
  });
  const arrived = promise.then((result) => ({ idle: false as const, result }));
  const outcome = await Promise.race([arrived, idled]);
  clearTimeout(timer!);
  return outcome;
}

/** The operator-facing message for an idle-bound abort (Finding 124) — factored out (mirrors
 * `formatAuthFailureError`'s own precedent) so a test can assert it names idleness explicitly, distinct
 * from both a plain failure and the transport's own wall-clock "timed out after Nms" message: a
 * Conductor reading either this string or a dispatch trace's `outcome` must be able to tell "this
 * worker gave up on its own, having seen nothing for N minutes" apart from "the outer bound killed it
 * mid-stream" — Findings 92 and 123 were both cases of a failure naming the wrong cause. */
export function formatIdleFailureError(idleTimeoutMs: number, elapsedMs: number): string {
  return `sdk worker: idle for ${idleTimeoutMs}ms with no stream activity — aborted after ${elapsedMs}ms elapsed (distinct from the outer wall-clock bound, which never fired)`;
}

export interface ConsumeQueryOptions {
  /** See `SdkWorkerRequest.idleTimeoutMs` — `undefined`/`0` disables the idle bound entirely. */
  idleTimeoutMs: number | undefined;
  abortController: AbortController;
  startedAt: number;
  reqModel: string | undefined;
}

export interface ConsumeQueryResult {
  sawSuccess: boolean;
  resultText: string;
  structuredOutput: unknown;
  receipt: Receipt | undefined;
  failure: string | undefined;
  retryCount: number;
  /** See `isNonRetryableAuthStatus`'s own doc (Finding 92) — takes precedence over `idle` below when
   * both could theoretically be true, mirroring the original inline loop's own ordering (an auth abort
   * always breaks the loop immediately, before an idle race on the next iteration could ever run). */
  authFailure: { status: number; attempt: number } | undefined;
  /** Finding 85: the sibling of `authFailure` for `isOperatorActionableStatus`'s wider net — set
   * instead of (never alongside) `authFailure`, same first-non-retryable-status-wins ordering. */
  operatorFailure: { status: number; attempt: number } | undefined;
  /** Finding 124: `true` only when the idle race (`raceIdle`) actually fired — never inferred from
   * `sawSuccess`/`failure` being falsy, which would conflate "aborted for being genuinely idle" with
   * every other way a dispatch can fail to produce a result. */
  idle: boolean;
}

/**
 * Finding 124: the SDK message-stream consumption loop, factored out of `runSdkWorkerFromStdin` (which
 * used to inline this as a bare `for await`) so a test can drive it with a FAKE message iterator —
 * synthetic `SDKMessage`-shaped objects, or a `.next()` that deliberately never resolves — and assert
 * the idle bound actually fires, without spawning the real SDK (which needs network + a real
 * credential this sandbox has neither of). Every branch below (`api_retry`/auth-abort, `assistant`
 * logging, `result`) is the SAME logic `runSdkWorkerFromStdin` always ran; only the iteration mechanism
 * changed — a manual `iterator.next()` raced against `raceIdle`, replacing the bare `for await`, so a
 * silent gap between messages can be caught mid-wait rather than only ever observed after the fact.
 */
export async function consumeQuery(iterator: AsyncIterator<SDKMessage>, opts: ConsumeQueryOptions): Promise<ConsumeQueryResult> {
  let resultText = "";
  let structuredOutput: unknown;
  let receipt: Receipt | undefined;
  let sawSuccess = false;
  let failure: string | undefined;
  let retryCount = 0;
  let authFailure: { status: number; attempt: number } | undefined;
  let operatorFailure: { status: number; attempt: number } | undefined;
  let respondingModel: string | null = null;
  let idle = false;

  while (true) {
    const nextPromise = iterator.next();
    const raced = await raceIdle(nextPromise, opts.idleTimeoutMs);
    if (raced.idle) {
      idle = true;
      console.error(
        `levare: sdk worker query() idle for ${opts.idleTimeoutMs}ms with no stream activity — aborting ` +
          `(Finding 124: distinct from the wall-clock bound), ${Date.now() - opts.startedAt}ms elapsed so far`,
      );
      opts.abortController.abort();
      // The abandoned `iterator.next()` call settles on its own once the abort propagates — swallow
      // whatever it resolves/rejects to so this never surfaces as an unhandled rejection; the loop has
      // already moved on and nothing here awaits it again.
      nextPromise.catch(() => {});
      break;
    }
    const { value: message, done } = raced.result;
    if (done) break;

    if (message.type === "system" && message.subtype === "api_retry") {
      retryCount++;
      console.error(
        `levare: sdk worker query() retrying (attempt ${message.attempt}/${message.max_retries}, ` +
          `error_status=${message.error_status ?? "null (connection error, no HTTP response)"}, ` +
          `retry_delay_ms=${message.retry_delay_ms}) — ${Date.now() - opts.startedAt}ms elapsed so far`,
      );
      if (isNonRetryableAuthStatus(message.error_status)) {
        authFailure = { status: message.error_status as number, attempt: message.attempt };
        console.error(
          `levare: sdk worker query() aborting — error_status=${message.error_status} is not retryable ` +
            `(auth failure), refusing the SDK's remaining ${message.max_retries - message.attempt} retries`,
        );
        opts.abortController.abort();
        break;
      }
      if (isOperatorActionableStatus(message.error_status)) {
        operatorFailure = { status: message.error_status as number, attempt: message.attempt };
        console.error(
          `levare: sdk worker query() aborting — error_status=${message.error_status} is not retryable ` +
            `(operator-actionable), refusing the SDK's remaining ${message.max_retries - message.attempt} retries`,
        );
        opts.abortController.abort();
        break;
      }
    }
    if (message.type === "assistant") {
      if (typeof message.message?.model === "string") respondingModel = message.message.model;
      for (const line of assistantContentLogLines(message.message?.content)) console.error(line);
    }
    if (message.type === "result") {
      if (message.subtype === "success") {
        sawSuccess = true;
        resultText = message.result;
        structuredOutput = message.structured_output;
        receipt = deriveReceipt(message, respondingModel, opts.reqModel);
      } else {
        const errs = "errors" in message && Array.isArray(message.errors) ? message.errors.join("; ") : undefined;
        failure = `sdk query did not succeed (${message.subtype})${errs ? `: ${errs}` : ""}`;
      }
    }
  }

  return { sawSuccess, resultText, structuredOutput, receipt, failure, retryCount, authFailure, operatorFailure, idle };
}

/** Read one `SdkWorkerRequest` from stdin, run it through the real SDK, print one `SdkWorkerResponse`
 * line of JSON to stdout. Never throws — every failure path (malformed input, transport/SDK error) is
 * reported via `respond({ ok: false, ... })` instead, so a caller awaiting this can always exit 0. */
export async function runSdkWorkerFromStdin(): Promise<void> {
  const input = await Bun.stdin.text();
  let req: SdkWorkerRequest;
  try {
    req = JSON.parse(input);
  } catch (e) {
    respond({ ok: false, error: `sdk worker: malformed request JSON: ${e instanceof Error ? e.message : String(e)}` });
    return;
  }

  // NOTES DIST5-HANG: the ONLY visibility this worker previously had into a slow real call was its
  // caller's own external timeout-and-kill (sdk-transport.ts) firing 45s later with no explanation of
  // what the process spent that time on. Two gaps that left open specifically: (1) a call that's merely
  // SLOW rather than genuinely stuck (finishes on its own, just late) left no trace at all — only a
  // timed-out call was ever diagnosable; (2) the SDK's own `query()` streams a distinct message,
  // `SDKAPIRetryMessage` (`type: "system", subtype: "api_retry"`), for every retried request — including
  // "connection errors (e.g. timeouts) that had no HTTP response" per its own doc comment, exactly the
  // shape a real network-level hang on a restricted-egress host would take — and this worker silently
  // dropped every one of them (the message loop, now `consumeQuery` below, only ever branched on
  // `assistant`/`result`).
  // Both are closed unconditionally (not debug-gated, mirroring `orchestrator-boundary.ts#logReceipt`'s
  // own always-on precedent — real SDK calls are infrequent enough that this costs nothing): the elapsed
  // wall-clock time is logged on EVERY exit path (success, a non-success result, and a thrown error
  // alike), and every `api_retry` message is logged as it streams, naming the attempt count, the
  // classified error status (`null` for a connection-level failure), and the backoff delay the SDK
  // itself chose — so the NEXT time a real call is slow, "the SDK retried N times, last delay Xms,
  // classified as <status>" is sitting in stderr instead of a bare, unexplained 45s wait.
  const startedAt = Date.now();
  // NOTES DISPATCH-TRACE / Finding 112: resolved HERE, once, so every `respond()` below — success,
  // no-result, and thrown — can report whether a real spawnable binary was found. This worker is the
  // only place that ever knows the answer on a compiled build (`resolvePathToClaudeCodeExecutable`'s
  // own doc): the parent that writes the dispatch trace can only see this by asking the worker.
  // Passed into `buildQueryOptions` as an already-resolved `pathToClaudeCodeExecutable` so its own
  // internal resolution call is a same-value passthrough, not a second extraction attempt.
  const resolvedBinaryPath = resolvePathToClaudeCodeExecutable(req.pathToClaudeCodeExecutable);
  const nativeBinaryResolved = resolvedBinaryPath !== undefined;
  try {
    // Finding 92: `authFailure` set the moment a non-retryable status is seen, checked right after the
    // loop exits — takes precedence over both the success/failure result branches and the generic catch,
    // so an auth failure is always reported as itself, never as whatever the abort happens to surface.
    // Finding 124: `idle` mirrors that same precedence discipline for the new idle bound — see
    // `ConsumeQueryResult.idle`'s own doc for why it's a distinct flag, never inferred from `sawSuccess`.
    const abortController = new AbortController();
    const consumed = await consumeQuery(
      query({
        prompt: req.prompt,
        options: { ...buildQueryOptions({ ...req, pathToClaudeCodeExecutable: resolvedBinaryPath }), abortController },
      }),
      { idleTimeoutMs: req.idleTimeoutMs, abortController, startedAt, reqModel: req.model },
    );
    console.error(
      `levare: sdk worker query() finished in ${Date.now() - startedAt}ms (${consumed.retryCount} retr${consumed.retryCount === 1 ? "y" : "ies"}, ` +
        `${consumed.sawSuccess ? "success" : consumed.idle ? "idle" : "no success result"})`,
    );
    if (consumed.authFailure) {
      respond({
        ok: false,
        error: formatAuthFailureError(consumed.authFailure.status, consumed.authFailure.attempt),
        errorClass: "operator",
        errorClassSource: "status",
        nativeBinaryResolved,
      });
      return;
    }
    if (consumed.operatorFailure) {
      respond({
        ok: false,
        error: formatOperatorFailureError(consumed.operatorFailure.status, consumed.operatorFailure.attempt),
        errorClass: "operator",
        errorClassSource: "status",
        nativeBinaryResolved,
      });
      return;
    }
    if (consumed.idle) {
      respond({ ok: false, error: formatIdleFailureError(req.idleTimeoutMs as number, Date.now() - startedAt), idle: true, nativeBinaryResolved });
      return;
    }
    if (!consumed.sawSuccess) {
      // Finding 85: a failure reached here only after the SDK's OWN retry policy already exhausted
      // itself on the message stream (every abortable status above was ruled out) — `retryCount > 0`
      // means at least one of those retries was for a rate-limit/5xx/connection-error shape and the
      // LAST word was still failure, the `transient` class's own definition. `retryCount === 0` means
      // the very first attempt failed for a reason the stream never named as retryable — genuinely
      // unknown, left unclassified rather than guessed (member-caused default, unchanged).
      respond({
        ok: false,
        error: consumed.failure ?? "sdk query produced no result message",
        errorClass: consumed.retryCount > 0 ? "transient" : undefined,
        errorClassSource: consumed.retryCount > 0 ? "status" : undefined,
        nativeBinaryResolved,
      });
      return;
    }
    respond({ ok: true, result: consumed.resultText, structuredOutput: consumed.structuredOutput, receipt: consumed.receipt, nativeBinaryResolved });
  } catch (e) {
    console.error(`levare: sdk worker query() threw after ${Date.now() - startedAt}ms`);
    const message = e instanceof Error ? e.message : String(e);
    // Finding 167: the ONE place the vendor's raw, unwrapped error message is still in scope — see
    // `classifyLocalSdkError`'s own doc for why this is the only layer that can match it safely.
    const errorClass = classifyLocalSdkError(message);
    respond({
      ok: false,
      error: message,
      errorClass,
      errorClassSource: errorClass ? "message" : undefined,
      nativeBinaryResolved,
    });
  }
}

// Only auto-runs when THIS FILE is the process's own entry point — i.e. spawned standalone as a
// script (the test-only path above), never when `cli.ts` merely imports `runSdkWorkerFromStdin` to
// dispatch its hidden `__worker` subcommand (NOTES DIST5) — an unconditional call here would have
// run a real SDK query every time any part of levare imported this module.
if (import.meta.main) {
  runSdkWorkerFromStdin();
}

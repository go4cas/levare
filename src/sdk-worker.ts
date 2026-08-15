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
import type { SettingSource } from "@anthropic-ai/claude-agent-sdk";
import { extractFromBunfs } from "@anthropic-ai/claude-agent-sdk/extract";
import type { SdkWorkerRequest, SdkWorkerResponse } from "./sdk-transport.ts";
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
  // dropped every one of them (the `for await` loop below only ever branched on `assistant`/`result`).
  // Both are closed unconditionally (not debug-gated, mirroring `orchestrator-boundary.ts#logReceipt`'s
  // own always-on precedent — real SDK calls are infrequent enough that this costs nothing): the elapsed
  // wall-clock time is logged on EVERY exit path (success, a non-success result, and a thrown error
  // alike), and every `api_retry` message is logged as it streams, naming the attempt count, the
  // classified error status (`null` for a connection-level failure), and the backoff delay the SDK
  // itself chose — so the NEXT time a real call is slow, "the SDK retried N times, last delay Xms,
  // classified as <status>" is sitting in stderr instead of a bare, unexplained 45s wait.
  const startedAt = Date.now();
  try {
    let resultText = "";
    let structuredOutput: unknown;
    let receipt: Receipt | undefined;
    let sawSuccess = false;
    let failure: string | undefined;
    let retryCount = 0;
    // NOTES F11: see `deriveReceipt`'s own doc for why this is tracked from `assistant` messages
    // rather than trusted to `modelUsage`'s key order.
    let respondingModel: string | null = null;
    for await (const message of query({
      prompt: req.prompt,
      options: buildQueryOptions(req),
    })) {
      if (message.type === "system" && message.subtype === "api_retry") {
        retryCount++;
        console.error(
          `levare: sdk worker query() retrying (attempt ${message.attempt}/${message.max_retries}, ` +
            `error_status=${message.error_status ?? "null (connection error, no HTTP response)"}, ` +
            `retry_delay_ms=${message.retry_delay_ms}) — ${Date.now() - startedAt}ms elapsed so far`,
        );
      }
      if (message.type === "assistant" && typeof message.message?.model === "string") {
        respondingModel = message.message.model;
      }
      if (message.type === "result") {
        if (message.subtype === "success") {
          sawSuccess = true;
          resultText = message.result;
          structuredOutput = message.structured_output;
          // §10: record what the SDK itself reports — real cost and token counts — rather than ever
          // estimating (NOTES phase-7 K16).
          receipt = deriveReceipt(message, respondingModel, req.model);
        } else {
          const errs = "errors" in message && Array.isArray(message.errors) ? message.errors.join("; ") : undefined;
          failure = `sdk query did not succeed (${message.subtype})${errs ? `: ${errs}` : ""}`;
        }
      }
    }
    console.error(`levare: sdk worker query() finished in ${Date.now() - startedAt}ms (${retryCount} retr${retryCount === 1 ? "y" : "ies"}, ${sawSuccess ? "success" : "no success result"})`);
    if (!sawSuccess) {
      respond({ ok: false, error: failure ?? "sdk query produced no result message" });
      return;
    }
    respond({ ok: true, result: resultText, structuredOutput, receipt });
  } catch (e) {
    console.error(`levare: sdk worker query() threw after ${Date.now() - startedAt}ms`);
    respond({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

// Only auto-runs when THIS FILE is the process's own entry point — i.e. spawned standalone as a
// script (the test-only path above), never when `cli.ts` merely imports `runSdkWorkerFromStdin` to
// dispatch its hidden `__worker` subcommand (NOTES DIST5) — an unconditional call here would have
// run a real SDK query every time any part of levare imported this module.
if (import.meta.main) {
  runSdkWorkerFromStdin();
}

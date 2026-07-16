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

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SettingSource } from "@anthropic-ai/claude-agent-sdk";
import type { SdkWorkerRequest, SdkWorkerResponse } from "./sdk-transport.ts";
import type { Receipt } from "./types.ts";

function respond(res: SdkWorkerResponse): void {
  console.log(JSON.stringify(res));
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
    // genuinely existed as a sibling node_modules package. sdk-transport.ts resolves the exact
    // same binary itself (once, at boundary-construction time) and hands the resolved path here;
    // when resolution failed there too, this stays undefined and the SDK attempts its own lookup
    // as a last resort (which will report the same failure either way, never a silent mismatch).
    pathToClaudeCodeExecutable: req.pathToClaudeCodeExecutable,
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
 * `tokens_in`/`tokens_out`/`usd` still SUM every entry in `modelUsage` — that is correct: the member
 * genuinely cost that much regardless of which internal call spent which tokens. Only the reported
 * MODEL NAME needed fixing, not the cost accounting.
 *
 * Factored out (rather than left inline in `main()`'s loop) specifically so a test can feed a
 * synthetic multi-model `modelUsage` object and assert the correct model wins, without spawning a
 * real subprocess or mocking the SDK's own `query()` async generator — see
 * tests/sdk-worker-receipt.test.ts.
 */
export function deriveReceipt(message: { modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number }>; duration_ms?: number; total_cost_usd?: number }, respondingModel: string | null, reqModel?: string): Receipt {
  const modelUsage = Object.entries(message.modelUsage ?? {});
  const tokensIn = modelUsage.length ? modelUsage.reduce((sum, [, u]) => sum + (u.inputTokens ?? 0), 0) : null;
  const tokensOut = modelUsage.length ? modelUsage.reduce((sum, [, u]) => sum + (u.outputTokens ?? 0), 0) : null;
  return {
    model: respondingModel ?? modelUsage[0]?.[0] ?? reqModel ?? null,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
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

  try {
    let resultText = "";
    let structuredOutput: unknown;
    let receipt: Receipt | undefined;
    let sawSuccess = false;
    let failure: string | undefined;
    // NOTES F11: see `deriveReceipt`'s own doc for why this is tracked from `assistant` messages
    // rather than trusted to `modelUsage`'s key order.
    let respondingModel: string | null = null;
    for await (const message of query({
      prompt: req.prompt,
      options: buildQueryOptions(req),
    })) {
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
    if (!sawSuccess) {
      respond({ ok: false, error: failure ?? "sdk query produced no result message" });
      return;
    }
    respond({ ok: true, result: resultText, structuredOutput, receipt });
  } catch (e) {
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

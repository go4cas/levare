// Standalone worker spawned SYNCHRONOUSLY by sdk-transport.ts's `bunSdkTransport`. Runs exactly one
// real Claude Agent SDK query to completion and prints its outcome as a single line of JSON on
// stdout — the actual async/await boundary lives in this separate process, so the caller can block
// on it with a plain `Bun.spawnSync` the same way adapters.ts's `bunSpawn` already blocks on the
// "cli" agent kind. Never logs or persists `ANTHROPIC_API_KEY`: this file never reads the key's
// value — it only spreads its own already-scoped `process.env` (set by the parent's `Bun.spawnSync`
// call, per sdk-transport.ts's env-trust-boundary note) into the SDK's own `options.env`, explicitly
// rather than relying on the SDK's documented "omitted env inherits process.env" default — being
// explicit here removes any doubt that the credential the launching process was granted actually
// reaches the inner `claude` CLI subprocess the SDK itself spawns (invariant 11).
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
    settingSources: [] as const,
    persistSession: false,
    // Explicit, not omitted: spread this process's own env (already scoped by the parent spawn, per
    // sdk-transport.ts's env-trust-boundary note) so the SDK's inner `claude` subprocess is guaranteed
    // the same credentials this worker itself was launched with.
    env: { ...process.env },
  };
}

async function main(): Promise<void> {
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
    for await (const message of query({
      prompt: req.prompt,
      options: buildQueryOptions(req),
    })) {
      if (message.type === "result") {
        if (message.subtype === "success") {
          sawSuccess = true;
          resultText = message.result;
          structuredOutput = message.structured_output;
          // §10: record what the SDK itself reports — real cost and token counts — rather than ever
          // estimating (NOTES phase-7 K16). `modelUsage` is a per-model breakdown; summed across
          // entries (in practice always one, since every call passes exactly one explicit `model`).
          const modelUsage = Object.entries(message.modelUsage ?? {});
          const tokensIn = modelUsage.length ? modelUsage.reduce((sum, [, u]) => sum + (u.inputTokens ?? 0), 0) : null;
          const tokensOut = modelUsage.length ? modelUsage.reduce((sum, [, u]) => sum + (u.outputTokens ?? 0), 0) : null;
          receipt = {
            model: modelUsage[0]?.[0] ?? req.model ?? null,
            tokens_in: tokensIn,
            tokens_out: tokensOut,
            wall_clock_s: typeof message.duration_ms === "number" ? message.duration_ms / 1000 : null,
            usd: typeof message.total_cost_usd === "number" ? message.total_cost_usd : null,
            unreported: modelUsage.length === 0 && typeof message.total_cost_usd !== "number",
          };
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

main();

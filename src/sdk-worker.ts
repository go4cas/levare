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

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SdkWorkerRequest, SdkWorkerResponse } from "./sdk-transport.ts";

function respond(res: SdkWorkerResponse): void {
  console.log(JSON.stringify(res));
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
    let sawSuccess = false;
    let failure: string | undefined;
    for await (const message of query({
      prompt: req.prompt,
      options: {
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
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        // Explicit, not omitted: spread this process's own env (already scoped by the parent spawn,
        // per sdk-transport.ts's env-trust-boundary note) so the SDK's inner `claude` subprocess is
        // guaranteed the same credentials this worker itself was launched with.
        env: { ...process.env },
      },
    })) {
      if (message.type === "result") {
        if (message.subtype === "success") {
          sawSuccess = true;
          resultText = message.result;
          structuredOutput = message.structured_output;
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
    respond({ ok: true, result: resultText, structuredOutput });
  } catch (e) {
    respond({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

main();

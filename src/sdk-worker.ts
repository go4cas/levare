// Standalone worker spawned SYNCHRONOUSLY by sdk-transport.ts's `bunSdkTransport`. Runs exactly one
// real Claude Agent SDK query to completion and prints its outcome as a single line of JSON on
// stdout — the actual async/await boundary lives in this separate process, so the caller can block
// on it with a plain `Bun.spawnSync` the same way adapters.ts's `bunSpawn` already blocks on the
// "cli" agent kind. Never logs or persists `ANTHROPIC_API_KEY`: the key is read only implicitly, by
// the SDK itself, from this process's own environment (invariant 11) — this file never touches it.

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
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
      },
    })) {
      if (message.type === "result") {
        if (message.subtype === "success") {
          sawSuccess = true;
          resultText = message.result;
          structuredOutput = message.structured_output;
        } else {
          failure = `sdk query did not succeed (${message.subtype})`;
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

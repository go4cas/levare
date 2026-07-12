// levare SDK transport (phase 7, closing invariant-10's "mocked this phase" deferral). The two
// boundary interfaces this repo already has — `OrchestratorBoundary` (orchestrator.ts) and
// `NativeBoundary` (adapters.ts) — are both synchronous by design (dispatch, gate resolution, and
// repo operations all assume a synchronous member/boundary call, per phase 5/3). The real Claude
// Agent SDK is inherently asynchronous: its `query()` spawns and streams from a `claude` CLI
// subprocess (confirmed from the SDK's own shipped README — see the `bun build --compile` section on
// `pathToClaudeCodeExecutable`). Rather than thread async through the Runner/board/gateops call
// chain — a change the phase directive explicitly warns against ("back the two boundaries behind
// their existing interfaces... if you find yourself editing orchestrator.ts's dispatch to
// accommodate the SDK, stop and reconsider the boundary instead") — a small standalone worker script
// (`sdk-worker.ts`) makes the one real async `query()` call and prints its outcome as a single line
// of JSON on stdout. This module spawns that worker SYNCHRONOUSLY via `Bun.spawnSync`, exactly the
// pattern `adapters.ts`'s `CliSpawn`/`bunSpawn` already uses for the "cli" agent kind.
//
// This is also the literal "transport level" the goal asks tests to mock at: `SdkTransport` is
// injectable exactly like `CliSpawn` (adapters.test.ts already establishes the pattern of injecting
// a fake spawn and asserting the argv/env it was handed), so `bun test` never spawns the worker,
// never touches the network, and never needs `ANTHROPIC_API_KEY`.

import { existsSync } from "node:fs";

export interface SdkWorkerRequest {
  /** The user-turn content sent to the model this call. */
  prompt: string;
  /** Loaded verbatim from disk by the caller (never edited/appended here) when set. */
  systemPrompt?: string;
  model?: string;
  /** Base tool set the model may see (levare's own `tools:` vocabulary — passed through as-is; see
   * NOTES phase-7 K2 for the scope boundary on SDK built-in tool-name mapping). */
  tools?: string[];
  allowedTools?: string[];
  outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
  cwd?: string;
}

export type SdkWorkerResponse = { ok: true; result: string; structuredOutput?: unknown } | { ok: false; error: string };

/** The transport boundary: run one SDK request to completion and return its final outcome. */
export interface SdkTransport {
  run(req: SdkWorkerRequest, opts: { env: Record<string, string | undefined>; timeoutMs: number }): SdkWorkerResponse;
}

export const SDK_WORKER_PATH = new URL("./sdk-worker.ts", import.meta.url).pathname;

/**
 * Whether the environment carries credentials the SDK can authenticate with — presence only, the
 * value itself is never read into a log, artifact, or commit (invariant 11), mirroring doctor.ts's
 * `EnvProbe` posture exactly. This is the one check that selects the real boundary vs. the
 * deterministic offline fallback.
 */
export function hasAnthropicCredentials(env: Record<string, string | undefined> = process.env): boolean {
  return typeof env.ANTHROPIC_API_KEY === "string" && env.ANTHROPIC_API_KEY.length > 0;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/** Default transport: a real, synchronous spawn of the worker script, which makes the real SDK call. */
export const bunSdkTransport: SdkTransport = {
  run(req, opts) {
    if (!existsSync(SDK_WORKER_PATH)) {
      return { ok: false, error: `sdk worker script not found at ${SDK_WORKER_PATH}` };
    }
    const proc = Bun.spawnSync([process.execPath, SDK_WORKER_PATH], {
      env: opts.env as Record<string, string>,
      stdin: Buffer.from(JSON.stringify(req)),
      stdout: "pipe",
      stderr: "pipe",
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    if (proc.exitedDueToTimeout) return { ok: false, error: `sdk worker timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms` };
    const stdout = proc.stdout ? new TextDecoder().decode(proc.stdout).trim() : "";
    if (proc.exitCode !== 0) {
      const stderr = proc.stderr ? new TextDecoder().decode(proc.stderr).trim() : "";
      return { ok: false, error: `sdk worker exited ${proc.exitCode}: ${stderr || stdout || "(no output)"}` };
    }
    try {
      return JSON.parse(stdout) as SdkWorkerResponse;
    } catch {
      return { ok: false, error: `sdk worker produced non-JSON output: ${stdout.slice(0, 200)}` };
    }
  },
};

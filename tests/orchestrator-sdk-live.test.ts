import { test, expect } from "bun:test";
import { createSdkOrchestratorBoundary } from "../src/orchestrator-boundary.ts";
import { hasAnthropicCredentials } from "../src/sdk-transport.ts";

// Live smoke test (phase 7 acceptance): boots the REAL boundary — the real @anthropic-ai/claude-agent-sdk
// worker subprocess, real network call — and asserts one interpret() round trip. Skipped whenever
// ANTHROPIC_API_KEY is absent from the environment, so `bun test` in this sandbox (and any CI without
// a live key) never requires one; this test exists for the Conductor to run outside the sandbox,
// with a real key exported, to confirm the wiring actually works end to end.

const live = hasAnthropicCredentials();

test.skipIf(!live)(
  "live: the real SDK-driven OrchestratorBoundary completes a real interpret() round trip",
  async () => {
    // A genuine transport failure (bad/missing credential, worker crash, timeout) now throws
    // OrchestratorSdkError directly out of interpret() — see tests/orchestrator-sdk.test.ts — so this
    // call is left unwrapped: any transport-level failure fails this test loudly and legibly (the
    // thrown message carries the worker's exit code / stderr), rather than being swallowed into a
    // passing-but-wrong "unknown" result. Manually verify wall-clock: a genuine round trip to a real
    // model takes on the order of seconds, not the ~70ms a broken-transport short-circuit would.
    const boundary = createSdkOrchestratorBoundary();
    const intent = await boundary.interpret("what needs me");
    // "unknown" is still a legal Intent a live model could genuinely return, but not for this literal
    // briefing phrase under docs/orchestrator-prompt.md's own §Behaviors — treat it as a real
    // classification miss, distinct from (and only reachable past) a transport failure.
    expect(intent.kind).toBe("briefing");
  },
  // Comfortably LONGER than the boundary's own internal timeout (45s — orchestrator-boundary.ts),
  // never shorter (NOTES phase-7 K15): a shorter outer timeout is exactly what let a real hang run to
  // this test's own limit instead of the transport's own timeout-kill firing and being observed.
  90_000,
);

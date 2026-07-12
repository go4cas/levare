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
  () => {
    const boundary = createSdkOrchestratorBoundary();
    const intent = boundary.interpret("what needs me");
    // Loose on the exact kind (a live model call is not byte-deterministic), strict on the shape:
    // it must be one of the seven Intent kinds the SDK's json_schema output format constrains it to,
    // never an SDK/parse failure silently downgraded to "unknown" with the raw text echoed back.
    expect(["briefing", "gate-decision", "capture-idea", "open-unit", "promote-idea", "stats", "unknown"]).toContain(intent.kind);
    if (intent.kind === "unknown") {
      // "unknown" is a legal Intent, but for this literal briefing phrase it should not be reachable
      // through a live, working SDK call — surface the raw text so a real failure is diagnosable.
      throw new Error(`live interpret() fell back to unknown for a plain briefing phrase: ${JSON.stringify(intent)}`);
    } else {
      expect(intent.kind).toBe("briefing");
    }
  },
  60_000,
);

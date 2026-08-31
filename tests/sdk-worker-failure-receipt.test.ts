import { test, expect, describe } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { consumeQuery } from "../src/sdk-worker.ts";

// Findings 162/95: a dispatch that produces nothing must still cost something. An error-subtype result
// message (error_max_turns, error_during_execution, ...) carries the SAME total_cost_usd/modelUsage
// fields a success result does — the SDK already priced whatever ran before the failure. Previously
// `consumeQuery`'s non-success branch built only a `failure` string and threw the receipt away. These
// tests assert it now derives one, mirroring sdk-worker-failure-class.test.ts's own fakeIterator harness
// (pure function, no real SDK/network/credential).

function fakeIterator(messages: unknown[]): AsyncIterator<SDKMessage> {
  let i = 0;
  return {
    async next() {
      if (i >= messages.length) return { value: undefined as unknown as SDKMessage, done: true as const };
      return { value: messages[i++] as SDKMessage, done: false as const };
    },
  };
}

describe("consumeQuery — an error-subtype result still reports its real, priced usage", () => {
  test("error_max_turns carries total_cost_usd/modelUsage — receipt is derived, not dropped", async () => {
    const iterator = fakeIterator([
      { type: "assistant", message: { model: "claude-sonnet-5", content: [] } },
      {
        type: "result",
        subtype: "error_max_turns",
        modelUsage: { "claude-sonnet-5": { inputTokens: 500, outputTokens: 200 } },
        duration_ms: 45000,
        total_cost_usd: 0.0372,
      },
    ]);
    const consumed = await consumeQuery(iterator, { idleTimeoutMs: 5000, abortController: new AbortController(), startedAt: Date.now(), reqModel: undefined });
    expect(consumed.sawSuccess).toBe(false);
    expect(consumed.failure).toContain("error_max_turns");
    expect(consumed.receipt).toBeDefined();
    expect(consumed.receipt?.unreported).toBe(false);
    expect(consumed.receipt?.usd).toBe(0.0372);
    expect(consumed.receipt?.model).toBe("claude-sonnet-5");
    expect(consumed.receipt?.tokens_in).toBe(500);
    expect(consumed.receipt?.tokens_out).toBe(200);
  });

  test("error_during_execution with zero modelUsage and no total_cost_usd stays honestly unreported", async () => {
    const iterator = fakeIterator([{ type: "result", subtype: "error_during_execution", modelUsage: {}, duration_ms: 3977 }]);
    const consumed = await consumeQuery(iterator, { idleTimeoutMs: 5000, abortController: new AbortController(), startedAt: Date.now(), reqModel: undefined });
    expect(consumed.receipt).toBeDefined();
    expect(consumed.receipt?.unreported).toBe(true);
    expect(consumed.receipt?.usd).toBeNull();
  });

  test("a genuine idle abort (no result message at all) reports no receipt — nothing to derive it from", async () => {
    // Never resolves within the idle bound — mirrors sdk-worker-idle-timeout.test.ts's own "silent
    // stream" shape. The idle bound firing is the real assertion; receipt staying undefined is the point.
    const iterator: AsyncIterator<SDKMessage> = { next: () => new Promise(() => {}) };
    const consumed = await consumeQuery(iterator, { idleTimeoutMs: 20, abortController: new AbortController(), startedAt: Date.now(), reqModel: undefined });
    expect(consumed.idle).toBe(true);
    expect(consumed.receipt).toBeUndefined();
  });
});

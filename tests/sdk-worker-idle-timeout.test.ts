import { test, expect, describe } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { raceIdle, consumeQuery, formatIdleFailureError } from "../src/sdk-worker.ts";

// Finding 124: "an idle bound, so a busy worker is not killed like a hung one" — a member that streams
// continuously (tool calls, assistant turns) must never be killed just because its TOTAL run is long;
// only a genuine silence (no message at all for N ms) should abort it, distinctly reported from the
// outer wall-clock bound (sdk-transport.ts's own kill, which fires from OUTSIDE the worker and never
// reaches this code at all). Both `raceIdle` (the race primitive) and `consumeQuery` (the message loop
// built on it) are exercised here with a FAKE message iterator and real-but-tiny timers — never the
// real SDK, which needs network + a credential this sandbox has neither of, mirroring
// sdk-worker-auth-retry.test.ts's own "pure logic, no real query()" precedent.

// A minimal fake async iterator over synthetic SDKMessage-shaped objects. `hangAtIndex`, when it
// matches the CURRENT index, returns a promise that never resolves — simulating a genuine silent gap
// (a stuck tool call, a network stall with zero streamed bytes) without needing a real hung SDK call.
function fakeIterator(messages: unknown[], opts: { delays?: number[]; hangAtIndex?: number } = {}): AsyncIterator<SDKMessage> {
  let i = 0;
  return {
    async next() {
      const index = i;
      if (opts.hangAtIndex === index) return new Promise<never>(() => {});
      if (index >= messages.length) return { value: undefined as unknown as SDKMessage, done: true as const };
      const delay = opts.delays?.[index] ?? 0;
      i++;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      return { value: messages[index] as SDKMessage, done: false as const };
    },
  };
}

function assistantMessage(text: string, model = "claude-sonnet-5") {
  return { type: "assistant", message: { model, content: [{ type: "text", text }] } };
}

function resultSuccess(result: string) {
  return { type: "result", subtype: "success", result, modelUsage: {}, duration_ms: 10, total_cost_usd: 0 };
}

function apiRetry(attempt: number, errorStatus: number | null) {
  return { type: "system", subtype: "api_retry", attempt, max_retries: 3, error_status: errorStatus, retry_delay_ms: 1 };
}

describe("raceIdle — the race primitive an idle bound is built on", () => {
  test("no idleTimeoutMs (undefined) — just awaits the promise, no race at all", async () => {
    const outcome = await raceIdle(Promise.resolve("value"), undefined);
    expect(outcome).toEqual({ idle: false, result: "value" });
  });

  test("idleTimeoutMs of 0 is treated as 'no bound' — mirrors the falsy-default convention every other resolveMemberTimeoutS-style bound in this codebase uses", async () => {
    const outcome = await raceIdle(Promise.resolve("value"), 0);
    expect(outcome).toEqual({ idle: false, result: "value" });
  });

  test("the underlying promise resolving well before the idle window wins — a busy worker is never falsely flagged idle", async () => {
    const fast = new Promise((resolve) => setTimeout(() => resolve("arrived"), 10));
    const outcome = await raceIdle(fast, 200);
    expect(outcome).toEqual({ idle: false, result: "arrived" });
  });

  test("a promise that never resolves within the idle window reports idle:true", async () => {
    const never = new Promise(() => {});
    const outcome = await raceIdle(never, 30);
    expect(outcome).toEqual({ idle: true });
  });
});

describe("formatIdleFailureError — names idleness explicitly, distinct from the wall-clock bound's own message", () => {
  test("names idle, the bound, and the elapsed time — never says 'timed out'", () => {
    const msg = formatIdleFailureError(300_000, 300_050);
    expect(msg).toContain("idle for 300000ms");
    expect(msg).toContain("300050ms elapsed");
    expect(msg).not.toContain("timed out");
  });

  test("explicitly distinguishes itself from the wall-clock bound (Finding 92/123: a failure must name the right cause)", () => {
    expect(formatIdleFailureError(300_000, 300_010)).toContain("distinct from the outer wall-clock bound");
  });
});

describe("consumeQuery — a dispatch that streams continuously past N is not killed (the ruling's own test)", () => {
  test("many messages, each well inside the idle window, complete normally — idle never fires even though the TOTAL run exceeds N", async () => {
    // 6 messages, 15ms apart = 75ms total — comfortably longer than the 20ms idle window used per-gap,
    // proving a long-but-continuously-streaming run is never mistaken for a silent one.
    const messages = [assistantMessage("thinking..."), assistantMessage("still going..."), assistantMessage("almost done..."), resultSuccess("done.")];
    const iterator = fakeIterator(messages, { delays: [15, 15, 15, 15] });
    const consumed = await consumeQuery(iterator, { idleTimeoutMs: 200, abortController: new AbortController(), startedAt: Date.now(), reqModel: undefined });
    expect(consumed.idle).toBe(false);
    expect(consumed.sawSuccess).toBe(true);
    expect(consumed.resultText).toBe("done.");
  });

  test("a fully silent gap past N is killed and reported as idle, not as a timeout", async () => {
    const abortController = new AbortController();
    const iterator = fakeIterator([assistantMessage("starting...")], { delays: [5], hangAtIndex: 1 });
    const consumed = await consumeQuery(iterator, { idleTimeoutMs: 30, abortController, startedAt: Date.now(), reqModel: undefined });
    expect(consumed.idle).toBe(true);
    expect(consumed.sawSuccess).toBe(false);
    expect(abortController.signal.aborted).toBe(true);
  });

  test("no idleTimeoutMs at all — unchanged prior behavior, a slow-but-eventually-arriving stream still completes", async () => {
    const iterator = fakeIterator([assistantMessage("hi"), resultSuccess("ok")], { delays: [20, 0] });
    const consumed = await consumeQuery(iterator, { idleTimeoutMs: undefined, abortController: new AbortController(), startedAt: Date.now(), reqModel: undefined });
    expect(consumed.idle).toBe(false);
    expect(consumed.sawSuccess).toBe(true);
  });

  test("an auth failure (Finding 92) still takes precedence, even with an idle bound configured — the two mechanisms don't interfere", async () => {
    const abortController = new AbortController();
    const iterator = fakeIterator([apiRetry(1, 401)]);
    const consumed = await consumeQuery(iterator, { idleTimeoutMs: 5000, abortController, startedAt: Date.now(), reqModel: undefined });
    expect(consumed.authFailure).toEqual({ status: 401, attempt: 1 });
    expect(consumed.idle).toBe(false);
    expect(abortController.signal.aborted).toBe(true);
  });

  test("a retryable status (429) keeps consuming — unaffected by the idle bound as long as messages keep arriving", async () => {
    const iterator = fakeIterator([apiRetry(1, 429), resultSuccess("recovered")], { delays: [5, 5] });
    const consumed = await consumeQuery(iterator, { idleTimeoutMs: 200, abortController: new AbortController(), startedAt: Date.now(), reqModel: undefined });
    expect(consumed.retryCount).toBe(1);
    expect(consumed.idle).toBe(false);
    expect(consumed.sawSuccess).toBe(true);
    expect(consumed.resultText).toBe("recovered");
  });
});

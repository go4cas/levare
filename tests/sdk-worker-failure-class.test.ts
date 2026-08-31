import { test, expect, describe } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { consumeQuery, isOperatorActionableStatus, formatOperatorFailureError } from "../src/sdk-worker.ts";

// Finding 85: a failure must say whose problem it is. `isOperatorActionableStatus` is the SIBLING check
// to `isNonRetryableAuthStatus` (sdk-worker-auth-retry.test.ts, left untouched by this unit) — the wider
// "other 4xx" net that also aborts on attempt 1, most namely an insufficient credit balance, without
// ever claiming a credential is invalid (that message is `formatAuthFailureError`'s own, and stays
// scoped to 401/403). Pure functions, tested the same way as that file's own precedent: no real SDK,
// no network, no credential — this sandbox has neither.

function fakeIterator(messages: unknown[]): AsyncIterator<SDKMessage> {
  let i = 0;
  return {
    async next() {
      if (i >= messages.length) return { value: undefined as unknown as SDKMessage, done: true as const };
      return { value: messages[i++] as SDKMessage, done: false as const };
    },
  };
}

function apiRetry(attempt: number, errorStatus: number | null) {
  return { type: "system", subtype: "api_retry", attempt, max_retries: 3, error_status: errorStatus, retry_delay_ms: 1 };
}

function resultSuccess(result: string) {
  return { type: "result", subtype: "success", result, modelUsage: {}, duration_ms: 10, total_cost_usd: 0 };
}

describe("isOperatorActionableStatus — 4xx besides 401/403/429 is a rejection retrying can never fix", () => {
  test("400 (e.g. an insufficient credit balance) is operator-actionable — the goal's own observed case", () => {
    expect(isOperatorActionableStatus(400)).toBe(true);
  });

  test("404/422 (other rejected-request shapes) are operator-actionable too", () => {
    expect(isOperatorActionableStatus(404)).toBe(true);
    expect(isOperatorActionableStatus(422)).toBe(true);
  });

  test("401/403 are NOT this function's territory — isNonRetryableAuthStatus already owns them, no double-classification", () => {
    expect(isOperatorActionableStatus(401)).toBe(false);
    expect(isOperatorActionableStatus(403)).toBe(false);
  });

  test("429 (rate limit) stays retryable — this check excludes it, same reasoning as isNonRetryableAuthStatus's own", () => {
    expect(isOperatorActionableStatus(429)).toBe(false);
  });

  test("5xx stays retryable — a vendor-side failure, transient's own territory", () => {
    expect(isOperatorActionableStatus(500)).toBe(false);
    expect(isOperatorActionableStatus(503)).toBe(false);
  });

  test("null (connection error, no HTTP response) is never operator-actionable — no status to classify from", () => {
    expect(isOperatorActionableStatus(null)).toBe(false);
    expect(isOperatorActionableStatus(undefined)).toBe(false);
  });
});

describe("formatOperatorFailureError — never claims a credential is invalid, unlike formatAuthFailureError", () => {
  test("names the status and attempt, never says 'authentication failure'", () => {
    const msg = formatOperatorFailureError(400, 1);
    expect(msg).toContain("HTTP 400");
    expect(msg).toContain("attempt 1");
    expect(msg).not.toContain("authentication failure");
    expect(msg).not.toContain("credentials are invalid");
  });

  test("says 'aborted without retrying' — matches formatAuthFailureError's own precedent", () => {
    expect(formatOperatorFailureError(400, 1)).toContain("aborted without retrying");
  });

  test("names billing/credit as one of the things to check, since a 400 covers that case", () => {
    expect(formatOperatorFailureError(400, 1)).toContain("credit");
  });
});

describe("consumeQuery — operatorFailure aborts on attempt 1, alongside (never instead of) authFailure", () => {
  test("a 400 sets operatorFailure and aborts immediately, refusing the SDK's remaining retries", async () => {
    const abortController = new AbortController();
    const iterator = fakeIterator([apiRetry(1, 400)]);
    const consumed = await consumeQuery(iterator, { idleTimeoutMs: 5000, abortController, startedAt: Date.now(), reqModel: undefined });
    expect(consumed.operatorFailure).toEqual({ status: 400, attempt: 1 });
    expect(consumed.authFailure).toBeUndefined();
    expect(abortController.signal.aborted).toBe(true);
  });

  test("a 401 still sets authFailure, never operatorFailure — the two checks don't double-fire on the same status", async () => {
    const iterator = fakeIterator([apiRetry(1, 401)]);
    const consumed = await consumeQuery(iterator, { idleTimeoutMs: 5000, abortController: new AbortController(), startedAt: Date.now(), reqModel: undefined });
    expect(consumed.authFailure).toEqual({ status: 401, attempt: 1 });
    expect(consumed.operatorFailure).toBeUndefined();
  });

  test("a 429 sets neither — stays retryable and keeps consuming to a successful result", async () => {
    const iterator = fakeIterator([apiRetry(1, 429), resultSuccess("recovered")]);
    const consumed = await consumeQuery(iterator, { idleTimeoutMs: 5000, abortController: new AbortController(), startedAt: Date.now(), reqModel: undefined });
    expect(consumed.operatorFailure).toBeUndefined();
    expect(consumed.authFailure).toBeUndefined();
    expect(consumed.sawSuccess).toBe(true);
  });

  test("retryCount > 0 with neither authFailure nor operatorFailure is the 'transient exhaustion' shape a boundary reads to classify — 429 retried, then the stream ends with no result", async () => {
    const iterator = fakeIterator([apiRetry(1, 429)]);
    const consumed = await consumeQuery(iterator, { idleTimeoutMs: 5000, abortController: new AbortController(), startedAt: Date.now(), reqModel: undefined });
    expect(consumed.retryCount).toBe(1);
    expect(consumed.sawSuccess).toBe(false);
    expect(consumed.authFailure).toBeUndefined();
    expect(consumed.operatorFailure).toBeUndefined();
  });
});

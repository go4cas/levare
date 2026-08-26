import { test, expect, describe } from "bun:test";
import { isNonRetryableAuthStatus, formatAuthFailureError } from "../src/sdk-worker.ts";

// Finding 92 (REOPENED): the SDK's own retry policy (inside `@anthropic-ai/claude-agent-sdk`'s
// `query()`, not levare's code) previously treated 401/403 exactly like 429/5xx — retryable — so an
// expired-credential dispatch burned seven retries and 41s of exponential backoff before the 45s
// wall-clock bound (sdk-transport.ts) killed it and reported a bare timeout, discarding the real
// cause. `isNonRetryableAuthStatus` is the predicate sdk-worker.ts's `api_retry` handler now consults
// to abort on the FIRST attempt instead; `formatAuthFailureError` is the message the operator sees.
// Both are pure — mirrors `deriveReceipt`/`assistantContentLogLines`'s own precedent for testing this
// file's logic without spawning the real SDK (which needs network + a real credential this sandbox has
// neither of).

describe("isNonRetryableAuthStatus — only 401/403 are terminal, everything else keeps retrying", () => {
  test("401 (expired/invalid credentials) is non-retryable — the exact case from the reopened finding", () => {
    expect(isNonRetryableAuthStatus(401)).toBe(true);
  });

  test("403 (forbidden) is non-retryable", () => {
    expect(isNonRetryableAuthStatus(403)).toBe(true);
  });

  test("429 (rate limit) stays retryable — backoff-and-retry is the correct behavior for it", () => {
    expect(isNonRetryableAuthStatus(429)).toBe(false);
  });

  test("5xx (server errors) stay retryable", () => {
    expect(isNonRetryableAuthStatus(500)).toBe(false);
    expect(isNonRetryableAuthStatus(502)).toBe(false);
    expect(isNonRetryableAuthStatus(503)).toBe(false);
  });

  test("null (connection error, no HTTP response) stays retryable — unchanged from before this fix", () => {
    expect(isNonRetryableAuthStatus(null)).toBe(false);
  });

  test("other 4xx (e.g. a malformed request) are left alone — this fix is scoped to auth, not all 4xx", () => {
    expect(isNonRetryableAuthStatus(400)).toBe(false);
    expect(isNonRetryableAuthStatus(404)).toBe(false);
  });
});

describe("formatAuthFailureError — the message the operator actually sees", () => {
  test("names authentication explicitly, never presents as a timeout", () => {
    const msg = formatAuthFailureError(401, 1);
    expect(msg).toContain("authentication failure");
    expect(msg).toContain("HTTP 401");
    expect(msg).not.toContain("timed out");
    expect(msg).not.toContain("timeout");
  });

  test("names the terminating status and the attempt it aborted on", () => {
    expect(formatAuthFailureError(403, 1)).toContain("HTTP 403");
    expect(formatAuthFailureError(401, 3)).toContain("attempt 3");
  });

  test("says 'aborted without retrying' — distinct from the 45s wall-clock kill path (Finding 124 stays out of scope)", () => {
    expect(formatAuthFailureError(401, 1)).toContain("aborted without retrying");
  });
});

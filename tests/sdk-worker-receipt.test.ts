import { test, expect, describe } from "bun:test";
import { deriveReceipt } from "../src/sdk-worker.ts";

// NOTES F11 — the ACTUAL live defect, proven against the real SDK (not a mocked transport): a native
// member declaring `model: claude-sonnet-5` produced an artifact whose usage receipt named
// `claude-haiku-4-5-20251001`. Traced to sdk-worker.ts's own receipt construction, not to anything
// upstream — the request DID carry the declared model correctly (adapters.ts#nativeWorkerRequest has
// passed `model: req.agent.model` since NOTES phase-7 K1, and tests/native-sdk-boundary.test.ts already
// asserted that). The real bug: a single `query()` call can report MULTIPLE models in its result
// message's `modelUsage` object (confirmed live: an internal auxiliary call — automatic memory recall —
// ran on `claude-haiku-4-5-20251001` alongside the primary response, which correctly ran on the
// requested `claude-sonnet-5`), and the old code picked `Object.entries(modelUsage)[0]` — the FIRST key
// by object insertion order, which carries no guarantee of being the model that generated the response.
// In the reproduced case the auxiliary call's key happened to be inserted first.
//
// These tests exercise `deriveReceipt` directly with a synthetic multi-model `modelUsage` object
// (exactly the shape observed live), asserting the model comes from the tracked `respondingModel` (the
// last `assistant` message's own `message.model`), never from `modelUsage`'s key order.

describe("sdk-worker.ts#deriveReceipt — the model that answered, not the first modelUsage key (NOTES F11)", () => {
  test("an auxiliary model inserted FIRST in modelUsage does not win — respondingModel does", () => {
    // Exact shape reproduced live: haiku's auxiliary-call entry precedes sonnet's real-response entry.
    const message = {
      modelUsage: {
        "claude-haiku-4-5-20251001": { inputTokens: 522, outputTokens: 11 },
        "claude-sonnet-5": { inputTokens: 169, outputTokens: 6 },
      },
      duration_ms: 2247,
      total_cost_usd: 0.001174,
    };
    const receipt = deriveReceipt(message, "claude-sonnet-5");
    expect(receipt.model).toBe("claude-sonnet-5");
    // Cost/token accounting still sums EVERY model's usage — only the reported name needed fixing.
    expect(receipt.tokens_in).toBe(691);
    expect(receipt.tokens_out).toBe(17);
    expect(receipt.usd).toBe(0.001174);
    expect(receipt.unreported).toBe(false);
  });

  test("a single-model modelUsage (the common case) is unaffected — same answer either way", () => {
    const message = { modelUsage: { "claude-opus-4-8": { inputTokens: 100, outputTokens: 20 } }, duration_ms: 1000, total_cost_usd: 0.01 };
    expect(deriveReceipt(message, "claude-opus-4-8").model).toBe("claude-opus-4-8");
    // Even with no tracked respondingModel (defense in depth), the single entry is still correct.
    expect(deriveReceipt(message, null).model).toBe("claude-opus-4-8");
  });

  test("no modelUsage entries at all and no responding model → falls back to the requested model, unreported", () => {
    const message = { modelUsage: {}, duration_ms: 500 };
    const receipt = deriveReceipt(message, null, "claude-sonnet-5");
    expect(receipt.model).toBe("claude-sonnet-5");
    expect(receipt.unreported).toBe(true);
  });

  test("respondingModel wins even when it never appears as a modelUsage key at all", () => {
    // Defensive: the receipt names what the ASSISTANT MESSAGE reported, not what modelUsage happens
    // to contain — these should agree in practice, but respondingModel is the more direct signal.
    const message = { modelUsage: { "claude-haiku-4-5-20251001": { inputTokens: 1, outputTokens: 1 } }, duration_ms: 1, total_cost_usd: 0.0001 };
    expect(deriveReceipt(message, "claude-sonnet-5").model).toBe("claude-sonnet-5");
  });
});

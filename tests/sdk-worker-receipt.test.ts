import { test, expect, describe } from "bun:test";
import { deriveReceipt } from "../src/sdk-worker.ts";
import { baselinePricing } from "../src/pricing.ts";

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

// NOTES "receipt cache tokens" — the actual live defect: `deriveReceipt` summed only `inputTokens`/
// `outputTokens` from `modelUsage`, so a receipt's own `tokens_in`/`tokens_out` never accounted for the
// prompt-cache read/write tokens `total_cost_usd` already priced in — a careful operator checking
// `(tokens_in/1e6)*in_per_m + (tokens_out/1e6)*out_per_m` against the reported `usd` (exactly what
// `knowledge/model-pricing.md`'s rates are FOR) found the two off by 40-50%, on every real call, since
// the system prompt/tool definitions cached per member are large relative to a short brief's own input.
//
// The fixture below uses the SDK's real `ModelUsage` shape (agentSdkTypes.d.ts, re-exported from
// sdk.d.ts: inputTokens/outputTokens/cacheReadInputTokens/cacheCreationInputTokens/webSearchRequests/
// costUSD/contextWindow/maxOutputTokens) — not a hand-trimmed subset — and its numbers are the actual
// figures observed for one real dispatch (product-brief-add-command-v3): 892 in / 786 out reported,
// $0.020895 billed, claude-sonnet-5's baseline rates ($3.00/M in, $15.00/M out). Backing the gap out as
// unpriced input tokens at that rate gives 2143 — this fixture's `cacheReadInputTokens`.
describe("sdk-worker.ts#deriveReceipt — prompt-cache tokens are summed and reported (NOTES 'receipt cache tokens')", () => {
  const REALISTIC_MODEL_USAGE = {
    "claude-sonnet-5": {
      inputTokens: 892,
      outputTokens: 786,
      cacheReadInputTokens: 2143,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUSD: 0.020895,
      contextWindow: 200_000,
      maxOutputTokens: 8_192,
    },
  };

  test("tokens_cache_read/tokens_cache_write are summed from modelUsage, alongside tokens_in/tokens_out", () => {
    const message = { modelUsage: REALISTIC_MODEL_USAGE, duration_ms: 9_500, total_cost_usd: 0.020895 };
    const receipt = deriveReceipt(message, "claude-sonnet-5");
    expect(receipt.tokens_in).toBe(892);
    expect(receipt.tokens_out).toBe(786);
    expect(receipt.tokens_cache_read).toBe(2143);
    expect(receipt.tokens_cache_write).toBe(0);
    expect(receipt.usd).toBe(0.020895);
  });

  test("once cache tokens are included, the receipt's own numbers reconcile with its own cost under knowledge/model-pricing.md's baseline rates — tokens_in/tokens_out alone do not", () => {
    const message = { modelUsage: REALISTIC_MODEL_USAGE, duration_ms: 9_500, total_cost_usd: 0.020895 };
    const receipt = deriveReceipt(message, "claude-sonnet-5");
    const rate = baselinePricing().get(receipt.model!)!;

    const computedFromInOutOnly = (receipt.tokens_in! / 1_000_000) * rate.in_per_m + (receipt.tokens_out! / 1_000_000) * rate.out_per_m;
    // The pre-fix defect, reproduced: pricing only the reported tokens_in/tokens_out undercounts the
    // real cost by roughly 30% — exactly the "careful operator does the arithmetic and finds a
    // discrepancy" scenario this fix closes.
    expect(computedFromInOutOnly).toBeLessThan(receipt.usd! * 0.75);

    const computedWithCache =
      ((receipt.tokens_in! + receipt.tokens_cache_read! + receipt.tokens_cache_write!) / 1_000_000) * rate.in_per_m + (receipt.tokens_out! / 1_000_000) * rate.out_per_m;
    expect(computedWithCache).toBeCloseTo(receipt.usd!, 6);
  });

  test("no cache activity at all (cacheReadInputTokens/cacheCreationInputTokens both 0) reports zero, not absent — a real number, never a silent gap", () => {
    const message = {
      modelUsage: { "claude-opus-4-8": { inputTokens: 50, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
      duration_ms: 100,
      total_cost_usd: 0.0005,
    };
    const receipt = deriveReceipt(message, "claude-opus-4-8");
    expect(receipt.tokens_cache_read).toBe(0);
    expect(receipt.tokens_cache_write).toBe(0);
  });

  test("no modelUsage entries at all → cache fields are null, matching tokens_in/tokens_out's own unreported convention", () => {
    const message = { modelUsage: {}, duration_ms: 500 };
    const receipt = deriveReceipt(message, null, "claude-sonnet-5");
    expect(receipt.unreported).toBe(true);
    expect(receipt.tokens_cache_read).toBeNull();
    expect(receipt.tokens_cache_write).toBeNull();
  });
});

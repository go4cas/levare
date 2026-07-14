import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePricing, priceUsd, loadPricing, baselinePricing } from "../src/pricing.ts";
import { normalizeReceipt, formatReceipt } from "../src/receipts.ts";
import type { Usage } from "../src/types.ts";

// §10: three numbers, three reliabilities. levare estimates USD from the pricing table; a member
// that reports nothing is recorded as `unreported`, never a fabricated $0.

describe("pricing table (knowledge/model-pricing.md)", () => {
  const pricing = loadPricing("fixtures/golden");

  test("parses the model rows and skips header/separator", () => {
    expect(pricing.get("claude-sonnet-5")).toEqual({ in_per_m: 3.0, out_per_m: 15.0 });
    expect(pricing.get("claude-opus-4-1")).toEqual({ in_per_m: 15.0, out_per_m: 75.0 });
    expect(pricing.has("model")).toBe(false); // header row is not a rate
  });

  test("priceUsd estimates from reported tokens, rounded to cents", () => {
    // 8200/M * 3.00 + 2100/M * 15.00 = 0.0246 + 0.0315 = 0.0561 → 0.06
    expect(priceUsd("claude-sonnet-5", 8200, 2100, pricing)).toBe(0.06);
  });

  test("an unknown model is unpriceable → null, never a guess", () => {
    expect(priceUsd("codex", 4200, 900, pricing)).toBe(null);
    expect(priceUsd(null, 100, 100, pricing)).toBe(null);
  });

  test("no reported tokens → null", () => {
    expect(priceUsd("claude-sonnet-5", null, null, pricing)).toBe(null);
  });

  test("parsePricing tolerates extra whitespace and pipe framing", () => {
    const p = parsePricing("| model | a | b |\n|---|---|---|\n|  m1  | 1.5 | 2.5 |\n");
    expect(p.get("m1")).toEqual({ in_per_m: 1.5, out_per_m: 2.5 });
  });
});

// NOTES F23 (ruling): a `levare init`-scaffolded studio used to price (and validate!) work against
// `claude-sonnet`/`claude-opus` — neither a real, callable model id — because the ONLY pricing data
// came from a studio's own knowledge/model-pricing.md, and a fresh/misconfigured one could name
// anything. levare now ships a baseline pricing table IN THE BINARY, current with each release; a
// studio's own file only EXTENDS or OVERRIDES it.
describe("F23: the binary ships a baseline pricing table; a studio's file extends/overrides it", () => {
  test("baselinePricing() carries real, currently-callable model ids with no studio file involved", () => {
    const base = baselinePricing();
    expect(base.size).toBeGreaterThan(0);
    expect(base.get("claude-sonnet-5")).toEqual({ in_per_m: 3.0, out_per_m: 15.0 });
    expect(base.has("claude-sonnet")).toBe(false); // the exact non-model this ruling closes
    expect(base.has("claude-opus")).toBe(false);
  });

  test("a studio with NO knowledge/model-pricing.md at all still prices a baseline model", () => {
    const dir = mkdtempSync(join(tmpdir(), "levare-baseline-pricing-"));
    try {
      const pricing = loadPricing(dir); // no knowledge/ dir at all
      expect(pricing.get("claude-sonnet-5")).toEqual({ in_per_m: 3.0, out_per_m: 15.0 });
      expect(priceUsd("claude-sonnet-5", 1_000_000, 0, pricing)).toBe(3.0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a studio's own knowledge/model-pricing.md OVERRIDES a baseline rate for the same model", () => {
    const dir = mkdtempSync(join(tmpdir(), "levare-override-pricing-"));
    try {
      mkdirSync(join(dir, "knowledge"), { recursive: true });
      writeFileSync(
        join(dir, "knowledge/model-pricing.md"),
        ["---", "name: model-pricing", "---", "", "| model | tokens_in (/M) | tokens_out (/M) |", "| --- | --- | --- |", "| claude-sonnet-5 | 1.00 | 1.00 |", ""].join("\n"),
      );
      const pricing = loadPricing(dir);
      expect(pricing.get("claude-sonnet-5")).toEqual({ in_per_m: 1.0, out_per_m: 1.0 }); // overridden
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a studio's own knowledge/model-pricing.md EXTENDS the baseline with a model the binary doesn't know", () => {
    const dir = mkdtempSync(join(tmpdir(), "levare-extend-pricing-"));
    try {
      mkdirSync(join(dir, "knowledge"), { recursive: true });
      writeFileSync(
        join(dir, "knowledge/model-pricing.md"),
        ["---", "name: model-pricing", "---", "", "| model | tokens_in (/M) | tokens_out (/M) |", "| --- | --- | --- |", "| my-self-hosted-model | 0.10 | 0.20 |", ""].join("\n"),
      );
      const pricing = loadPricing(dir);
      expect(pricing.get("my-self-hosted-model")).toEqual({ in_per_m: 0.1, out_per_m: 0.2 });
      // The baseline is still present alongside the extension — never replaced wholesale.
      expect(pricing.get("claude-sonnet-5")).toEqual({ in_per_m: 3.0, out_per_m: 15.0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("normalizeReceipt (§10)", () => {
  const pricing = loadPricing("fixtures/golden");

  test("a reported usage block is normalized and USD is derived from the table", () => {
    const usage: Usage = { model: "claude-sonnet-5", tokens_in: 8200, tokens_out: 2100, usd: 999, wall_clock_s: 95 };
    const r = normalizeReceipt(usage, pricing);
    expect(r.unreported).toBe(false);
    expect(r.wall_clock_s).toBe(95);
    // The member's own usd (999) is ignored — levare prices cost itself.
    expect(r.usd).toBe(0.06);
  });

  test("a member that reports NOTHING is recorded as unreported, all figures null", () => {
    const r = normalizeReceipt(null, pricing);
    expect(r).toEqual({ model: null, tokens_in: null, tokens_out: null, wall_clock_s: null, usd: null, unreported: true });
  });

  test("an all-null usage block is silence, not a $0 run", () => {
    const r = normalizeReceipt({ model: null, tokens_in: null, tokens_out: null, usd: null, wall_clock_s: null }, pricing);
    expect(r.unreported).toBe(true);
  });

  test("an unpriceable model yields usd null but is NOT unreported (tokens were given)", () => {
    const r = normalizeReceipt({ model: "codex", tokens_in: 4200, tokens_out: 900, usd: null, wall_clock_s: 60 }, pricing);
    expect(r.unreported).toBe(false);
    expect(r.usd).toBe(null);
    expect(r.wall_clock_s).toBe(60);
  });

  test("formatReceipt renders unreported plainly and priced figures quietly", () => {
    expect(formatReceipt(normalizeReceipt(null, pricing))).toBe("usage: unreported");
    const priced = formatReceipt(normalizeReceipt({ model: "claude-sonnet-5", tokens_in: 8200, tokens_out: 2100, usd: null, wall_clock_s: 95 }, pricing));
    expect(priced).toContain("$0.06");
    expect(priced).toContain("claude-sonnet-5");
  });
});

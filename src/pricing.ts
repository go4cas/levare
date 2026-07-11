// levare cost pricing (§10). Parses the USD-per-million-token table out of
// knowledge/model-pricing.md and prices a usage receipt's USD estimate from reported tokens.
//
// The table is the single source of truth for cost estimates: no rates are hard-coded here. A model
// absent from the table is *unpriceable* — priceUsd returns null rather than guessing, so an unknown
// model surfaces as `usd: null` on the receipt (a quiet, honest gap) instead of a fabricated figure.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface Rate {
  in_per_m: number;
  out_per_m: number;
}
export type Pricing = Map<string, Rate>;

/** Parse a model-pricing markdown table into rates. Rows look like `| model | in | out |`. */
export function parsePricing(markdown: string): Pricing {
  const pricing: Pricing = new Map();
  for (const line of markdown.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("|")) continue;
    const cells = t.split("|").map((c) => c.trim()).filter((c, i, a) => !(i === 0 && c === "") && !(i === a.length - 1 && c === ""));
    if (cells.length !== 3) continue;
    const [model, tin, tout] = cells;
    // Skip the header row and the `---` separator row.
    if (!/^[\d.]+$/.test(tin) || !/^[\d.]+$/.test(tout)) continue;
    pricing.set(model, { in_per_m: Number(tin), out_per_m: Number(tout) });
  }
  return pricing;
}

/** Load pricing from a repo root's knowledge/model-pricing.md; empty map when absent. */
export function loadPricing(root: string): Pricing {
  const file = join(root, "knowledge", "model-pricing.md");
  if (!existsSync(file)) return new Map();
  return parsePricing(readFileSync(file, "utf8"));
}

/**
 * Estimate USD from reported tokens against the pricing table. Returns null (unpriceable) when the
 * model is absent, unknown, or tokens weren't reported — never a guessed number.
 */
export function priceUsd(
  model: string | null,
  tokens_in: number | null,
  tokens_out: number | null,
  pricing: Pricing,
): number | null {
  if (model === null) return null;
  const rate = pricing.get(model);
  if (!rate) return null;
  if (tokens_in === null && tokens_out === null) return null;
  const usd = ((tokens_in ?? 0) / 1_000_000) * rate.in_per_m + ((tokens_out ?? 0) / 1_000_000) * rate.out_per_m;
  return Math.round(usd * 100) / 100;
}

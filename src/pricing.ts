// levare cost pricing (§10). Parses the USD-per-million-token table out of
// knowledge/model-pricing.md and prices a usage receipt's USD estimate from reported tokens.
//
// NOTES F23 (ruling): a `levare init`-scaffolded studio used to ship a `knowledge/model-pricing.md`
// naming `claude-sonnet`/`claude-opus` — neither a real, callable model id — so a fresh studio priced
// (and validated!) work against models that don't exist, and its own scaffolded agents failed on
// their first invocation. The table is no longer the ONLY source of truth: levare ships a baseline
// pricing table IN THE BINARY (`BASELINE_PRICING` below), current with each release, so a fresh studio
// with no `knowledge/model-pricing.md` at all still prices and validates against real models out of
// the box. A studio's own `knowledge/model-pricing.md`, when present, EXTENDS or OVERRIDES the
// baseline entry-by-entry (a studio can still price an exotic/self-hosted model the binary doesn't
// know about, or override a baseline rate) — never replaces it wholesale. A model absent from BOTH is
// *unpriceable* — `priceUsd` returns null rather than guessing, so an unknown model surfaces as
// `usd: null` on the receipt (a quiet, honest gap) instead of a fabricated figure.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { readOverlaid, type OverlayFile } from "./overlay.ts";

export interface Rate {
  in_per_m: number;
  out_per_m: number;
}
export type Pricing = Map<string, Rate>;

// The baseline table shipped in the binary — real, currently-callable Claude model ids only (see
// docs/guide or the claude-api skill for the authoritative id list). Kept as markdown, parsed through
// the same `parsePricing` a studio's own file goes through, so there is exactly one parser for the
// shape, not a hand-rolled literal Map that could drift from what a studio-authored table means.
const BASELINE_PRICING_MARKDOWN = `
| model              | tokens_in (/M) | tokens_out (/M) |
| ------------------ | --------------- | --------------- |
| claude-opus-4-8     | 5.00            | 25.00           |
| claude-sonnet-5     | 3.00            | 15.00           |
| claude-fable-5      | 1.00            | 5.00            |
| claude-haiku-4-5-20251001 | 1.00      | 5.00            |
`;

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

/** The binary's own baseline pricing table (NOTES F23) — exported so `levare doctor`/`init` can show
 * or diff against it without re-parsing the markdown constant themselves. */
export function baselinePricing(): Pricing {
  return parsePricing(BASELINE_PRICING_MARKDOWN);
}

/**
 * Load pricing for a studio: the binary's baseline (NOTES F23), overlaid with the studio's own
 * `knowledge/model-pricing.md` when present — the studio file EXTENDS or OVERRIDES the baseline
 * entry-by-entry, never replaces it. A studio with no pricing file of its own still prices and
 * validates against every baseline model.
 */
export function loadPricing(root: string, overlay?: OverlayFile): Pricing {
  const pricing = baselinePricing();
  const file = join(root, "knowledge", "model-pricing.md");
  if (existsSync(file) || (overlay && overlay.path === resolve(file))) {
    for (const [model, rate] of parsePricing(readOverlaid(file, overlay))) pricing.set(model, rate);
  }
  return pricing;
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

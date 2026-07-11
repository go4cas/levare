// levare usage-receipt normalization (§10). Every adapter (native/CLI/remote) funnels its member's
// reported usage through here, so the receipt shape is identical regardless of who produced it — the
// normalization lives at the Runner boundary, not in each adapter.
//
// The one rule that matters: silence is recorded as silence. A member that reports nothing at all
// yields `unreported: true` with every figure null — never a $0 that would read as "ran for free".
// USD is always the adapter's own estimate from the pricing table (levare prices cost; members
// report tokens), so an unpriceable model surfaces as `usd: null`.

import type { Receipt, Usage } from "./types.ts";
import { priceUsd, type Pricing } from "./pricing.ts";

/** True when a usage block carries no signal at all (absent, null, or every field null/undefined). */
function isSilent(usage: Usage | null | undefined): boolean {
  if (usage === null || usage === undefined) return true;
  return (
    usage.model == null &&
    usage.tokens_in == null &&
    usage.tokens_out == null &&
    usage.usd == null &&
    usage.wall_clock_s == null
  );
}

export function normalizeReceipt(usage: Usage | null | undefined, pricing: Pricing): Receipt {
  if (isSilent(usage)) {
    return { model: null, tokens_in: null, tokens_out: null, wall_clock_s: null, usd: null, unreported: true };
  }
  const u = usage!;
  const model = u.model ?? null;
  const tokens_in = u.tokens_in ?? null;
  const tokens_out = u.tokens_out ?? null;
  const wall_clock_s = u.wall_clock_s ?? null;
  // levare estimates USD from the pricing table; a member's own usd figure is not trusted as the
  // estimate. Unpriceable (unknown model / no tokens) → null, a quiet honest gap.
  const usd = priceUsd(model, tokens_in, tokens_out, pricing);
  return { model, tokens_in, tokens_out, wall_clock_s, usd, unreported: false };
}

/** One-line receipt rendering for transcripts: quiet mono figures, never an alarm (§10). */
export function formatReceipt(r: Receipt): string {
  if (r.unreported) return "usage: unreported";
  const parts: string[] = [];
  parts.push(r.usd != null ? `$${r.usd.toFixed(2)}` : "$ —");
  if (r.tokens_in != null || r.tokens_out != null) parts.push(`${r.tokens_in ?? "?"} in / ${r.tokens_out ?? "?"} out`);
  if (r.model != null) parts.push(r.model);
  if (r.wall_clock_s != null) parts.push(`${r.wall_clock_s}s`);
  return `usage: ${parts.join(" · ")}`;
}

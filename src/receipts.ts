// levare usage-receipt normalization (§10) for a cli/remote member's own self-reported usage, and for
// the "nothing reported at all" fallback shared by every member kind. A `kind: native` member's real
// receipt does NOT flow through here — it comes verbatim from sdk-worker.ts#deriveReceipt (the Claude
// Agent SDK's own accounting) and adapters.ts#author uses it as-is; `normalizeReceipt(null, ...)` is
// reached for native only when the boundary reported no receipt at all (NOTES "receipt cache tokens":
// this file's own USD-is-always-estimated claim below was true for cli/remote but never for native —
// see types.ts#Receipt's own header for the corrected split).
//
// The one rule that matters here: silence is recorded as silence. A member that reports nothing at all
// yields `unreported: true` with every figure null — never a $0 that would read as "ran for free". For
// the cli/remote receipts THIS function actually builds, USD is the adapter's own estimate from the
// pricing table (levare prices cost; those members report tokens), so an unpriceable model surfaces as
// `usd: null`.

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

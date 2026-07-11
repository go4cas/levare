---
kind: product-brief
id: product-brief-v1
unit: checkout-flow
project: storefront
status: approved
produced_by: kestrel/wren
consumes: []
supersedes: null
approved_by: "cas 2026-07-08"
created: 2026-07-07
files: []
usage:
  model: claude-sonnet
  tokens_in: 8200
  tokens_out: 2100
  usd: 0.06
  wall_clock_s: 95
---

# Guest checkout

Guest checkout with a saved-card fallback: shoppers buy without creating an account, and a returning email is quietly offered its saved card as a one-tap path through payment.

Today the storefront forces account creation before payment, and roughly a third of first-time carts are abandoned at that wall. Most of those shoppers are buying a single item on their phone and will never come back to a signup screen.

The job is to let anyone finish a purchase as a guest while still recognising a returning email, so a card saved on a previous order can be reused without a full sign-in. We will read success as a higher completion rate on first-time carts, measured thirty days after ship.

---
kind: design
id: design-checkout-v1
unit: checkout-flow
project: storefront
status: approved
produced_by: kestrel/lyra
consumes: [product-brief-v1]
supersedes: null
approved_by: "cas 2026-07-09"
created: 2026-07-08
files: [checkout-wireframe.svg]
usage:
  model: claude-sonnet
  tokens_in: 12400
  tokens_out: 3800
  usd: 0.10
  wall_clock_s: 210
---

# Checkout design

A single-page checkout: cart review, contact, payment, and confirmation stacked as one scrolling flow, with a saved-card offer that surfaces the instant a returning email is entered.

Returning shoppers see their masked saved card as the default payment method behind a one-tap "use this card" control; first-time shoppers get a plain card form with no interruption. A persistent order-summary rail keeps the running total and item count in view at every step, and the confirmation state doubles as the receipt. The attached wireframe shows the four sections and the summary rail.

---
kind: spec
id: spec-checkout-flow-v1
unit: checkout-flow
project: storefront
status: in-review
produced_by: kestrel/lyra
consumes: [product-brief-v1, design-checkout-v1]
supersedes: null
approved_by: null
created: 2026-07-11
files: []
usage:
  model: claude-sonnet
  tokens_in: 31000
  tokens_out: 10000
  usd: 0.58
  wall_clock_s: 480
---

# Spec — checkout-flow

Implementation spec for the single-page checkout. This artifact sits at `in-review`: its
flow position declares `gate: human`, so it *is* the open gate awaiting the Conductor.

- Route `/checkout` renders all four sections server-side; client script only toggles
  section collapse and revalidates the payment field.
- Payment submission is idempotent on an order key; a double-submit never double-charges.
- The order-summary rail is a projection of the cart, recomputed on every render.

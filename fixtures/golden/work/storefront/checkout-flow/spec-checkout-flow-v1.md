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

# Guest checkout spec

The guest-checkout spec is ready for review, with two open questions on guest checkout still to settle: whether a returning email must be verified before its saved card is offered, and how a payment should be kept idempotent when there is no account to anchor the order.

Route `/checkout` renders cart, contact, payment, and confirmation server-side; the client only shifts focus between sections and revalidates the card field. A returning email is matched against a hashed card token and, on a hit, its saved card is offered as the default method.

Payment submission is idempotent on an order key so a double-tap never double-charges, and the order-summary rail is recomputed from the cart on every render. The two open questions above are the only things standing between this and build.

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

# Design — checkout-flow

A folder artifact: this index carries the frontmatter; the wireframe travels alongside in
`files:`. Single-page flow with four collapsible sections — cart, address, payment,
confirmation — and a persistent order summary rail.

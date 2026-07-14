---
name: press
consumes: []
produces: [product-brief, review]
members: [scribe, corvid]
flow:
  - loop:
      between: [product-brief, review]
      until: approval.approved
      max_rounds: 3
      on_exhaust: gate
style:
  color: "#4B2E83"
---

# Press — a loop whose `until` names neither of its own two members

`until: approval.approved` names a kind (`approval`) that is neither `product-brief` nor
`review` — the loop's own two members — so no round this loop ever runs could make it true.
This is the exact "wedge" ruling F16 found live: a loop that can never satisfy its own exit
condition must fail at `levare validate`, not spin (or silently fall through) at runtime.

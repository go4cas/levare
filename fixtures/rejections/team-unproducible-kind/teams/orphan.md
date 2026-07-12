---
name: orphan
consumes: [pitch]
produces: [report, findings]
members: [scribe]
flow:
  - step: report
  - gate: human
style:
  color: "#8A8F98"
---

# Orphan — a team promising a kind no member produces

The team advertises `findings`, but its only member (scribe) declares `produces: [report]`.
A `spike` unit routed here would be handed to a team that cannot produce what it promised.
This must fail `levare validate`, not sit silent at runtime (NOTES F1).

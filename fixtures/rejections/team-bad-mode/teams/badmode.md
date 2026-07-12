---
name: badmode
consumes: [pitch]
produces: [spec]
members: [lyra]
flow:
  - step: spec
mode: declarative
style:
  color: "#2E6FB0"
---
`mode:` was removed in PRD v1.1 — even the once-valid `declarative` value must now fail validation
with a REMOVED_FIELD diagnosis, so an old studio carrying it is told rather than silently ignored.

---
name: kestrel
consumes: [pitch, product-brief]
produces: [product-brief, design, spec]
members: [wren, lyra, finch]
flow:
  - step: brief
  - gate: human
  - step: design
  - gate: human
  - loop:
      between: [spec, review]
      until: spec.approved
      max_rounds: 3
      on_exhaust: gate
mode: declarative
style:
  color: "#2E6FB0"
guardrails:
  protected_branches: [main]
  protected_paths: [deploy/]
  never: [force-push, delete-branch]
knowledge: [house-style]
---

# Kestrel — the product-shaping team

Kestrel takes a pitch to an approved specification. Wren frames the product brief,
Lyra designs the flow and drafts the spec, Finch reviews against the house style.
The team never touches a project's main branch; code lands only through a downstream
review loop and a merge gate.

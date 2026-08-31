---
name: helm
description: "Pitch to founding charter"
consumes: []
produces: [founding-brief, charter]
members: [kite]
flow:
  - step: brief
  - gate: human
  - step: charter
style:
  color: "#7A4FB5"
knowledge: [house-style]
---

# Helm — the founding team

Helm stands up a new project: it turns a promoted pitch into a founding brief, then —
once approved — a founding charter every later unit in the project cites. `pitch` is
never a flow-produced artifact here; `promoteIdea` folds the idea's own pitch text
straight into the new unit's body, so an inception unit's score rail shows `pitch` as an
expects-only stage (Finding 78 part 2, ordering rule 1) rather than one helm's flow ever
places.

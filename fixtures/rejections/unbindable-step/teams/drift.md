---
name: drift
consumes: [pitch]
produces: [report]
members: [scribe]
flow:
  - step: report
  - gate: human
  - step: critique
  - gate: human
style:
  color: "#8A8F98"
---

# Drift — a flow step that binds to no member

`critique` names no kind any member of this team produces (scribe produces `report`), so the
Runner could never resolve the step to a member. This is the exact failure the daemon used to
hit on a unit's first walk; it must fail at `levare validate` instead (NOTES F1).

---
name: spike
glyph: "∻"
expects: [question, findings]
gates: [findings]
output: findings
timebox: 1d
---

# Spike

A disposable investigation. Its code never ships; its output is `findings`. The glyph
reads as ephemeral. Timebox is Runner-enforced. Promotion means a new feature unit that
consumes the findings — the spike itself never merges.

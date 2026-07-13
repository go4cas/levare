---
name: rook
kind: cli
produces: [report]
command: [gemini, -p, "{task}", --output-format, json]
context_via: arg
context_artifacts: inline
cwd: "/tmp"
timeout: 600
result: "Emits a `report` artifact markdown file to stdout; runs sandboxed in an isolated scratch directory outside the studio, so it declares context_artifacts: inline to receive consumed-artifact contents rather than paths it could never open (ruling C9)."
style:
  avatar: Ro
---

# Rook — wrapped Gemini research member

Rook is a foreign CLI (Gemini) wrapped as a member and deliberately run outside the
studio tree, in an isolated scratch directory — a repo's own config could otherwise
alter a wrapped CLI's behaviour in ways the studio never asked for. Because it has no
filesystem access back into the studio, it cannot open a path §6 item 7 would otherwise
hand it. It declares `context_artifacts: inline` (ruling C9): section 7 of its
assembled context carries the full text of every consumed artifact, never a pointer.

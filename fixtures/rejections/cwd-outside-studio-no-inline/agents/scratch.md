---
name: scratch
kind: cli
produces: [report]
command: [gemini, -p, "{task}"]
cwd: "/tmp"
timeout: 600
result: "Emits a report artifact."
style:
  avatar: Sc
---

# scratch — a CLI member with cwd outside the studio, no `context_artifacts: inline` declared

This agent's `cwd` resolves outside the studio root and it does not declare
`context_artifacts: inline` — ruling C9 says that is a definition error: such a member
can never read a path §6 item 7 would hand it.

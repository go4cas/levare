---
name: finch
kind: cli
produces: [review]
command: [codex, review, --input, "{task}", --repo, "{feature_repo}"]
cwd: "{feature_repo}"
timeout: 600
result: "Emits review commentary as plain text on stdout — content only, never frontmatter of its own; levare authors the artifact wrapper (id, status, consumes, usage) around that content and validates the whole document against the artifact contract before recording it (ruling C12)."
style:
  avatar: Fi
---

# Finch — wrapped Codex reviewer

Finch is a foreign CLI (Codex) wrapped as a member. The Runner spawns the `command`
template with `{task}` substituted, enforces the timeout, and validates that the raw
output conforms to the artifact contract at the boundary — the contract is never
trusted from the member.

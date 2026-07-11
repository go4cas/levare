---
name: finch
kind: cli
command: "codex review --input {task} --repo {feature_repo}"
cwd: "{feature_repo}"
timeout: 600
result: "Emits a `review` artifact markdown file to stdout; the wrapper validates its frontmatter against the artifact contract before recording it."
style:
  avatar: Fi
---

# Finch — wrapped Codex reviewer

Finch is a foreign CLI (Codex) wrapped as a member. The Runner spawns the `command`
template with `{task}` substituted, enforces the timeout, and validates that the raw
output conforms to the artifact contract at the boundary — the contract is never
trusted from the member.

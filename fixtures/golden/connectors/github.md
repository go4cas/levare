---
name: github
kind: cli
command: gh
env: [GITHUB_TOKEN]
scope: "Granted to teams that open PRs and manage releases. Values come from the environment; never stored in the repo."
role: tool
---

# GitHub connector

Wraps the `gh` CLI. The Runner injects `GITHUB_TOKEN` only into members whose team or
agent grants this connector.

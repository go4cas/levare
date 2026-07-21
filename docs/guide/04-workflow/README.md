---
title: Workflow
nav_order: 5
has_children: true
---

# 4 · Workflow

The guided build. You'll take a real product from a sentence to an approved brief, one step at a
time, and at the end you'll have spent about two cents.

Every step here was walked on a real machine before it was written. Where something was awkward, it
says so.

---

## What you're building

A terminal todo list. Three commands: `todo add`, `todo list`, `todo done`. State in a single JSON
file. It's deliberately dull — the point is levare, not the product.

## Before you start

You'll need what [Quickstart](../02-quickstart.md) set up (Bun, git, a studio), plus **an Anthropic
API key**, because from here on a real model does real work and costs real money. Not much — the
whole of this chapter costs about $0.02 — but it isn't free, and levare will show you every cent.

Put it in a `.env` at your studio root:

```sh
cd ~/studio
cat > .env <<'EOF'
ANTHROPIC_API_KEY=sk-ant-...
EOF

grep -q '^\.env$' .gitignore || echo ".env" >> .gitignore
```

levare loads that file at startup. Two things to know:

- **A shell variable always wins over `.env`.** If you `export ANTHROPIC_API_KEY` in your terminal,
  that's what gets used.
- **`levare validate` will refuse to run if `.env` is tracked by git.** Studios get shared; a
  committed credential in a shared studio is a catastrophe. This one fails closed, deliberately.

Check it took:

```sh
levare doctor .
```

```
orchestrator: on · The Orchestrator is live.
```

---

## The steps

| | |
|---|---|
| [4.1 · Capture an idea](01-capture-an-idea.md) | A sentence in a file. Costs nothing, commits you to nothing. |
| [4.2 · Promote it to a project](02-promote-to-a-project.md) | The first real commitment — and where you write the house rules. |
| [4.3 · Your first team and member](03-first-team-and-member.md) | The `produces` declaration, and why it's the most load-bearing line in a studio. |
| [4.4 · Your first gate](04-first-gate.md) | Start, watch a member run, read what it wrote, and decide. |
| [4.5 · A foreign agent on your team](05-foreign-agent.md) | Wrap someone else's CLI as a first-class member. |
| [4.6 · Your first loop](06-first-loop.md) | An author and a critic, alternating, with a declared budget. |
| [4.7 · The daemon](07-the-daemon.md) | Approve once; let the score advance by itself. |
| [4.8 · When a member fails](08-when-a-member-fails.md) | Reading a blocked artifact. |

---

Start with **[4.1 · Capture an idea](01-capture-an-idea.md)**.

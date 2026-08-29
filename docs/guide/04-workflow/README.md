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

levare loads that file at startup **and re-reads it on every page load and mutating request** — so a
correction lands without a restart. Three things to know:

- **A shell variable always wins over `.env`.** If you `export ANTHROPIC_API_KEY` in your terminal
  with a value that differs from what's in `.env`, that's what gets used. levare tells the two apart
  by value, not by presence — some runtimes (Bun included) auto-load `.env` into the process before
  levare ever runs, so "already present" can't by itself mean "shell-exported."
- **`levare validate` will refuse to run if `.env` is tracked by git.** Studios get shared; a
  committed credential in a shared studio is a catastrophe. This one fails closed, deliberately.
- **Fixing a typo in `.env` takes effect on the next request to a `levare serve` that's already
  running — no restart.** levare re-derives `.env` on every page load and every mutating request.
  Registry files (`teams/`, `agents/`, `connectors/`, `projects/`) are different — those *do* need a
  restart to take effect. [4.6](06-first-loop.md) explains why, and where else it applies.

Check it took:

```sh
levare doctor .
```

```
orchestrator: on · ANTHROPIC_API_KEY is present — its validity isn't checked until the Orchestrator makes a real request.
```

---

## Two modes, and the difference is deliberate

levare generates the things that are mechanical. `levare new` writes a work unit; `levare project new`
writes a project. Both infer what they can from your studio and refuse to guess when they can't.

It does **not** generate agents, teams, connectors or ideas — you'll write those by hand in the
chapters ahead, and that isn't a gap levare hasn't got round to.

**An agent file *is* a system prompt.** The prose below the frontmatter is the whole point of it. A
team's `flow:` is a sequence someone has to think about. A command that scaffolded either would hand
you a stub you'd immediately open and fill in — saving you the frontmatter, and nothing that matters.

Units and projects are scaffolding. Agents and teams are your studio's constitution. **You author a
constitution.**

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

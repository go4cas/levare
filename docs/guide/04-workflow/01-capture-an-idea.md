---
title: Capture an idea
parent: Workflow
nav_order: 1
---

# 4.1 · Capture an idea

Everything in levare starts as a sentence.

Not a project, not a ticket, not a backlog item — a **pitch**, in a file, costing nothing and
committing you to nothing. The `ideas/` folder exists so that thinking stays cheap.

```sh
cd ~/studio

cat > ideas/todo-cli.md <<'EOF'
---
name: todo-cli
tags: [tools, cli]
---

A todo list you drive from the terminal. Add a task, list what's open, mark one done.
No accounts, no sync, no server — just a file on disk and three commands.
EOF

levare validate .
```

```
valid
```

That's the whole thing. Two frontmatter fields and a paragraph.

## Look at it

```sh
levare serve .
```

`todo-cli` appears under **IDEAS** in the rail. Click it: the pitch, rendered. No project, no work
unit, no gate, no cost.

You can also just ask:

> **you:** list every idea in this studio

> **Orchestrator:** One idea captured: **todo-cli** — "A todo list you drive from the terminal. Add a
> task, list what's open, mark one done."

## Why this is a first-class concept

Most tools make you commit before you can capture. You open a ticket, pick a project, assign an
owner — and the friction means the thought either gets dropped or gets promoted before it's ready.

An idea in levare is a file with a name and a sentence. It has no project, so nothing can be built
from it. It has no team, so nobody can act on it. It costs nothing to keep and nothing to delete.
It is a place to put a thought.

When one earns it, you promote it — and *that's* the commitment.

---

Next: **[4.2 · Promote it to a project](02-promote-to-a-project.md)**

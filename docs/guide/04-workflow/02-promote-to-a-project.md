---
title: Promote it to a project
parent: Workflow
nav_order: 2
---

# 4.2 · Promote it to a project

A **project** is a commitment. It says: *this thing is real, here is where its code lives, and here
are the rules every agent must obey when they touch it.*

```sh
cd ~/studio

cat > projects/todo-cli.md <<'EOF'
---
name: todo-cli
repo: ~/source/todo-cli
remote: git@github.com:you/todo-cli.git
default_branch: main
deploy: null
pace: auto
---

# todo-cli

A terminal todo list. Three commands: add, list, done. State lives in a single JSON file
under the user's home directory.

## House rules

- Zero runtime dependencies. Bun's standard library only.
- Single binary. No config file, no server, no network.
- Every command must work offline and finish in under 50ms.
- Errors are diagnoses: say what went wrong and what to do about it.
EOF

mkdir -p work/todo-cli
levare validate .
```

## The fields

| Field | Required | What it does |
|---|---|---|
| `name` | ✅ | Must match the filename |
| `repo` | ✅ | Where the product's code lives on your machine |
| `remote` | ✅ | Its git remote — there must be somewhere for approved work to land |
| `default_branch` | ✅ | Usually `main` |
| `deploy` | — | Where it ships, or `null` |
| `pace` | — | `auto` (the daemon advances between gates) or `step` (you nod before each team runs) |

`remote` being **required** is a design statement, not bureaucracy: a project levare will accept is
one where finished work has somewhere to go.

## The house rules are not decoration

That "House rules" section is injected into **every member's context**, on every invocation, for
every unit in this project. It's section 5 of the [context recipe](../03-concepts.md#context-what-a-member-actually-sees).

You write it once. Every agent that ever touches this project reads it. You will see the effect
directly in [4.4](04-first-gate.md) — the brief that comes back cites the 50ms budget and the
zero-dependency rule, and nobody told the agent about them except this file.

That's what a project *is*, in levare: a pointer, and a constitution.

## Look at it

```sh
levare serve .
```

`todo-cli` appears under **PROJECTS**, chip reading `idle`, `0 units`. Click it and you'll see the
pointer and the house rules, rendered.

---

Next: **[4.3 · Your first team and member](03-first-team-and-member.md)**

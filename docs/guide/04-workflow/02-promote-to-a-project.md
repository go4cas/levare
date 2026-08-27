---
title: Promote it to a project
parent: Workflow
nav_order: 2
---

# 4.2 · Promote it to a project

A **project** is a commitment. It says: *this thing is real, here is where its code lives, and here
are the rules every agent must obey when they touch it.*

You already have (or just cloned) todo-cli's own repo somewhere on disk — for this walkthrough,
that's `~/source/todo-cli`, with an `origin` remote already configured. `levare project new` reads
`default_branch` and `remote` straight off that checkout, so nothing here is typed twice:

```sh
cd ~/studio

levare project new todo-cli --repo ~/source/todo-cli <<'EOF'
- Zero runtime dependencies. Bun's standard library only.
- Single binary. No config file, no server, no network.
- Every command must work offline and finish in under 50ms.
- Errors are diagnoses: say what went wrong and what to do about it.
EOF

mkdir -p work/todo-cli
levare validate .
```

```
levare project new · projects/todo-cli.md
  repo: ~/source/todo-cli
  remote: git@github.com:you/todo-cli.git (inferred)
  default_branch: main (inferred)
  deploy: null (default)
  pace: auto (default)
  git: committed 3f9a1c2e0b7d
Next: levare validate .
```

## The fields

| Field | Required | What it does |
|---|---|---|
| `name` | ✅ | Must match the filename |
| `repo` | ✅ | Where the product's code lives on your machine |
| `remote` | ✅ (may be `null`) | Its git remote — there must be somewhere for approved work to land |
| `default_branch` | ✅ | Usually `main` |
| `deploy` | ✅ (may be `null`) | Where it ships, or `null` |
| `pace` | ✅ | `auto` (the daemon advances between gates) or `step` (you nod before each team runs) |

Every one of these six keys must be **present** in the file — `remote`/`deploy` may be `null`, but
omitting the key entirely fails `levare validate`. `levare project new` always writes all six; you
never have to remember which ones are nullable.

`remote` allowing `null` is not an invitation to leave it unset: a project levare will accept is one
where finished work has somewhere to go. `levare project new` only writes `null` there when the
checkout has no remote (or more than one, without `--remote` to disambiguate) — add `origin` to the
checkout, or pass `--remote` explicitly, and it infers it, exactly as it did with `default_branch`
above.

If `--repo` doesn't point at a real local git checkout, `levare project new` refuses immediately,
naming the path it resolved to — you never find out from a stalled dispatch three steps later.

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

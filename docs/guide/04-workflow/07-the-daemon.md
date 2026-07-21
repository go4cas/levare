---
title: The daemon
parent: Workflow
nav_order: 7
---

# 4.7 · The daemon

Everything so far has needed a click. The daemon is what makes levare feel like a studio rather than
a form: **you approve, and the next thing runs.**

It's already on. You've been using it all along.

```
levare serve . → http://localhost:4173 · daemon: on
```

---

## What it does

The daemon watches `work/`. When something changes — a file you edited, a gate you resolved, an
artifact a member produced — it walks the graph and asks one question: *is there anything I'm allowed
to do?*

If yes, it does it. If it reaches a gate, it stops.

That's the whole thing. It has no model, no judgment, and no opinions. It is the part of levare that
could spend your money, and it is deliberately the part with no capacity to decide anything.

## What it will never do

- **It never resolves a gate.** Not a start gate, not a review gate, not a budget gate. Gates are
  yours.
- **It never starts a unit you haven't started.** Every unit's first step raises a start gate —
  regardless of type, regardless of dependencies. *A unit's existence is not consent.*
- **It never retries a failed member.** A member that fails produces a blocked artifact and stops.
  Retrying costs money, so retrying is a decision (see [4.8](08-when-a-member-fails.md)).
- **It never signs your name.** Its commits are authored by `levare-runner`. Yours are authored by
  you.

## What it makes possible

Without the daemon, a loop would be four clicks. With it, you approve once and watch:

```
start add-command → press/scribe produced product-brief v1        (loop round 1)
advance add-command → press/corvid produced review v1             (loop round 1)
```

You clicked **Start**. levare dispatched Scribe, took his prose, wrote the artifact, committed it,
saw that the loop's other kind was now producible, dispatched Corvid, gave it the brief, took its
review, wrote *that* artifact, committed it, and raised the gate — and stopped there, because the
next thing needed you.

Two members, two vendors, one click.

## Pace

A project declares how eagerly it advances:

```yaml
# projects/todo-cli.md
pace: auto        # the daemon advances between gates (the default)
```

```yaml
pace: step        # you nod before each team runs
```

`auto` is what you want almost always. `step` exists for work where each dispatch is expensive enough
that you want to see it coming — and it means exactly what it says: **the daemon still halts at every
gate, but now it also halts before each team's turn.**

## Watching it work

The **Running now** section is a true projection of what's in flight — not a guess, not an optimistic
UI state. If it says a member is running, a process is running.

```
Running now
  Sc  scribe producing product-brief for todo-cli/add-command · just now
```

And when it stops, `git log` is the record:

```sh
git log --format='%h %an — %s' -6
```

```
9f2c1a4 cas           — approve review-add-command-v3
a3d90e1 levare-runner — advance add-command → press/corvid produced review v3 (loop round 3)
7b8e043 levare-runner — request changes on product-brief v2 → product-brief v3
2c91f5e cas           — request changes on product-brief-add-command-v2
d53c896 levare-runner — advance add-command → press/corvid produced review v2 (loop round 2)
1a4f8b2 levare-runner — advance add-command → press/scribe produced product-brief v1 (loop round 1)
```

**Two identities, alternating.** Every machine action and every human decision, in order, with names
on them. Ask this log who approved the spec and it will tell you. Ask who wrote it, and it will tell
you that too, and they are different answers.

That is the artifact levare exists to produce.

---

Next: **[4.8 · When a member fails](08-when-a-member-fails.md)**

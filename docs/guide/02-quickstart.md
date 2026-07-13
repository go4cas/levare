# 2 · Quickstart

Ten minutes. No API keys, no agents, no spend. At the end you'll have a studio on disk and a board
in your browser.

---

## Prerequisites

- **[Bun](https://bun.sh)** — levare is a Bun binary.
- **git** — not optional. Without it, levare cannot verify that an approved artifact hasn't been
  tampered with, and it has no audit log. It will tell you so.

That's all, for now. Running actual agents needs more, and [Operations](06-operations.md) covers it.

## Install

```sh
git clone https://github.com/go4cas/levare.git
cd levare
bun install
bun run build          # produces ./levare
```

Put the binary somewhere on your `PATH`, or call it by path. The rest of these docs write it as
`levare`.

## Scaffold a studio

A **studio** is a git repository of markdown files. It is *not* the levare source repo — it's yours,
and it lives wherever you keep your work.

```sh
mkdir ~/studio && cd ~/studio
levare init .
```

```
levare init · .
  23 file(s)/dir(s) created
Next: levare validate .    ·    levare serve .
```

`init` scaffolds the skeleton, an example team you can edit or delete, and it runs `git init` and
makes the founding commit itself — because a studio without git is a studio with its guarantees
switched off.

What you get:

```
teams/       who does the work — what they consume, what they produce, their flow
agents/      the members — native (Claude SDK), cli (a wrapped foreign CLI), or remote (MCP)
skills/      reusable instructions a member's context can include
knowledge/   reference documents injected into member context by name
types/       the five work-unit templates: inception, feature, fix, spike, research
connectors/  external services members can be granted (env var NAMES only — never secrets)
projects/    pointers to the products you're building
work/        work units and the artifacts they produce — empty until you open one
ideas/       captured pitches with no project yet
```

## Check it

```sh
levare validate .
```

```
valid
```

That single word is doing real work. `validate` checks every definition against the contract, and it
checks that your studio can actually *run* — that every kind a team promises is produced by a member
it actually has, and that every flow step binds to somebody. A studio that looks fine and does
nothing is the failure mode it exists to prevent.

## Open the board

```sh
levare serve .
```

```
levare · http://localhost:4173
```

You'll see the studio screen: no gates, nothing running, one example team in the registry, and — at
the bottom of the sidebar, on every screen — a line telling you exactly where what you're looking at
came from.

```
derived from work/ on every request
```

That line is a promise. There is no cache, no database, no build step. Edit a file in your editor
and the board updates.

---

## Look around

Try these, in this order:

1. **The registry** — click *teams*. There's one, called `kestrel`, with three members and a flow
   that shows all three shapes levare supports: a plain step, a human gate, and a review loop. Click
   *agents*: `wren` and `lyra` are native Claude agents; `finch` is a wrapped foreign CLI. Read them.
   They're just markdown.

2. **Edit one.** Open `teams/kestrel.md` in your editor and change its colour. Save. The board
   updates itself — the SSE connection tells the page to re-derive, and the projection is rebuilt
   from the file you just changed.

3. **Break one.** Delete `produces:` from an agent and run `levare validate .` again. Read the error.
   It names the file, the field, the team that depended on it, and what each member actually offers.
   Errors in levare are supposed to be *diagnoses*, not complaints.

4. **Ask what's missing.** Run `levare doctor .` — it reports which connectors have their environment
   variables present, and which of their CLIs it can actually find on your `PATH`. Right now it will
   tell you that `github` and `linear` are missing their credentials. That's correct; you haven't
   granted any.

---

## What you have, and what you don't

You have a studio that validates, a board that renders it, and a registry you can edit. **Nothing can
run yet** — you have no credentials, so no member can be invoked. That's deliberate: the quickstart
should cost you nothing and touch nothing.

Next: **[3 · Concepts](03-concepts.md)** — the vocabulary, and why each piece exists.

Or, if you'd rather build than read: **[4 · Workflow](04-workflow/)** — take something from an idea
to an approved spec, one step at a time.

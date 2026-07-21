---
title: Your first gate
parent: Workflow
nav_order: 4
---

# 4.4 · Your first gate

Now a member runs, and it costs you money — about a cent.

## The work unit

A **work unit** is a piece of work with a beginning and an end. It needs a type, and it lives under
the project it belongs to.

```sh
cd ~/studio
mkdir -p work/todo-cli/add-command

cat > work/todo-cli/add-command/unit.md <<'EOF'
---
type: feature
team: press
status: active
budget: 2.00
---

# add-command

The first command: `todo add "buy milk"`. Appends a task to the store and confirms it.
This is the smallest thing that makes the tool useful — everything else builds on it.
EOF

levare validate .
```

The `team:` field is optional — but if two teams in your studio both produce `product-brief`,
levare will refuse to guess:

```
AMBIGUOUS_PRODUCER  work/todo-cli/add-command/unit.md
  unit 'add-command' (type 'feature') needs kind(s) [product-brief], each produced by
  more than one team (kestrel, press); levare never guesses which team is responsible —
  add 'team:' to work/todo-cli/add-command/unit.md naming one
```

The `budget: 2.00` is a ceiling. Cross it and the unit raises a gate rather than a bill.

## Nothing happens

```sh
levare serve .
```

The unit appears — and it does **not** run. It's sitting at a **start gate**:

> **add-command** · `feature` · START GATE
> Queued work unit awaiting your beat to begin.
> **[ Start ]** [ Not yet ] [ Re-scope ]

This is the constitution, and it's worth stating plainly:

> **No member process ever starts without a Conductor approval in its causal chain.** Every work
> unit's first step raises a start gate — regardless of type, regardless of dependencies. **A unit's
> existence is not consent.**

You can create a hundred units. levare will run none of them until you say so, one at a time.

## Start it

Click **Start**. The card immediately shows `dispatching…`, then:

> **Members running: 1** — scribe producing `product-brief` for todo-cli/add-command

Behind that, levare has:

1. Resolved `step: brief` → the kind `product-brief` → the member who produces it → **scribe**
2. Assembled his [context](../03-concepts.md#context-what-a-member-actually-sees): his own definition,
   his skills, his knowledge, the Press charter, **todo-cli's house rules**, the task, and the paths
   to what he consumes
3. Invoked him through the Claude Agent SDK, on the model he declared, with only the credentials his
   team was granted
4. Taken his prose, wrapped it in the artifact contract, committed it as `levare-runner`, and raised
   a gate

Ten seconds later:

> **product-brief-add-command-v1.md** · `member/scribe` · ON YOU
> "Terminal-first users have no friction-free way to capture a task the moment it crosses their mind."
> 2k tok · ~$0.01
> **[ Approve ]** [ Request changes ] [ Reject ]

## Read what it wrote

```sh
cat work/todo-cli/add-command/product-brief-add-command-v1.md
```

```markdown
---
kind: product-brief
id: product-brief-add-command-v1
unit: add-command
project: todo-cli
status: in-review
produced_by: press/scribe
consumes: []
supersedes: null
approved_by: null
created: 2026-07-14
files: []
usage:
  model: claude-sonnet-5
  tokens_in: 1507
  tokens_out: 845
  usd: 0.015243999999999999
  wall_clock_s: 12.034
---
# Product Brief: `add` command

**Problem**: Terminal-first users have no friction-free way to capture a task the moment
it crosses their mind.

**Job to be done**: `todo add "fix the parser"` appends the task to `~/.todo.json` and exits.

**Signal it worked**:
- The task appears when you run `todo list`
- The command returns in under 50ms
- It works with no network, no setup, no config

**Ambiguities**:
- Should it accept todos from stdin for piping? (Not blocking — defer to usage patterns)
- Multi-word tasks: quote-wrapped or space-joined? (Quote-wrapped is unambiguous)
```

**Three things in there are worth stopping on.**

**`~/.todo.json`, the 50ms budget, "no network, no setup, no config".** Nobody told Scribe any of
that. You wrote it once, in the project's house rules, and the context recipe delivered it. That is
what a constitution is *for*.

**The "Ambiguities" section.** Scribe's system prompt says *"if a decision is genuinely ambiguous,
say so in the body rather than guessing."* It didn't guess. It flagged, and handed the decision back
to you — which is the behaviour you want from a colleague and cannot get from a prompt you wrote once
and forgot.

**The frontmatter is not Scribe's.** The member returned prose; **levare** authored every field of
that contract — the kind, the id, the lineage, the model, the token counts. A member never reports
its own metadata, because a member reporting its own token count is a member guessing. levare knows
what it dispatched and what the SDK charged, so levare asserts it.

## Now decide

This is the part no test can do for you.

The brief is good. But those two ambiguities aren't *decisions*, they're deferrals — and a brief that
ends in open questions isn't finished. So: **Request changes**, with a note.

> **Note:** Answer the two ambiguities as decisions, not open questions: multi-word tasks are
> quote-wrapped, and stdin piping is out of scope for v1. Fold them into the brief — a brief that
> ends in questions isn't done.

Scribe runs again — your note is in his context this time — and v2 lands:

```
product-brief-add-command-v2.md
supersedes: product-brief-add-command-v1
```

v1's status flips to `superseded`. The chain is in the file, and in git.

And the new brief has no "Ambiguities" section. In its place:

```markdown
**Constraints from house rules**
- Must finish in <50ms (critical for flow)
- Single JSON file under `~/`
- Zero dependencies beyond Bun stdlib
- Errors diagnose: "File not writable. Check permissions on ~/.todo.json"
```

He didn't just answer the questions. He reframed the document around the project's constitution.

## Approve

Click **Approve**.

- The artifact's status becomes `approved`, with **your name** on the commit.
- levare records the commit ref at which you approved it. Change the file afterwards and validation
  will fail — **an approved artifact is immutable.** A revision is a new version that supersedes it.
- The walk resumes.

```sh
git log --format='%h %an — %s' -4
```

```
9f2c1a4 cas           — approve product-brief-add-command-v2
7b8e043 levare-runner — request-changes add-command → press/scribe produced product-brief v2
2c91f5e levare-runner — start add-command → press/scribe produced product-brief v1
d53c896 cas           — seed
```

**Two identities, never confused.** Your decisions commit as you. Machine work commits as
`levare-runner`. Ask `git log` who approved that brief and it will tell you. Ask who wrote it, and it
will tell you that too, and they are different answers.

Total spent: **$0.02**.

## And then it stops

The `feature` type expects `design` next. Press produces `product-brief` and nothing else, and no
other team in your studio produces `design`.

So the walk halts. Not with an error — there's nothing wrong — it simply has nowhere to go.

**Your flow ends where your team's capabilities end.** Which is the next problem to solve.

---

Next: **[4.5 · A foreign agent on your team](05-foreign-agent.md)** — wrap someone else's CLI as a
first-class member.

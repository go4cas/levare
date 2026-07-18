# 4.8 · When a member fails

Members fail. A vendor rate-limits you, a CLI isn't installed, a model rejects an argument, a network
call times out. It happens, and levare's job is to tell you **why** — precisely, in the vendor's own
words, without you having to go digging.

---

## What a failure looks like

The artifact **blocks**. The walk stops. And the card tells you what happened:

```
add-command · work/todo-cli/add-command/                                   BLOCKED

  The daemon could not produce this artifact: cli member 'corvid' exited 1

  The 'gpt-5' model is not supported when using Codex with a ChatGPT account.

  argv: ["codex","exec","-","-m","gpt-5","--sandbox","read-only", …]

  [ Retry ]  [ Skip ]  [ Abandon ]
```

Three things are on that card deliberately.

**The vendor's own error, first.** Not "exited 1" — the actual diagnosis, lifted from the member's
stderr or its structured error output. levare doesn't interpret it, summarise it, or improve it. It
shows you what the tool said.

**The argv it ran.** Because half of all CLI failures are a flag you got wrong, and you cannot debug a
command you cannot see.

**Three verbs**, because a failure is a decision.

## The three verbs

**Retry** — invoke the same member again, with the same context. For a transient failure: a rate
limit, a 503, a flaky network. **It costs money**, and that is precisely why it's a button you press
rather than something the daemon does on your behalf. Each retry lands in the ledger like any other
invocation.

**Skip** — mark this step abandoned and let the walk continue if it can. For when you'd rather write
the artifact yourself than argue with a tool.

**Abandon** — pause the unit. Something's wrong upstream and the flow shouldn't proceed.

> **The daemon never retries on its own.** A daemon that automatically retries a failing member is a
> daemon that spends your money in a loop while you sleep. levare stops, tells you, and waits.

## Failures before the spawn

Some failures happen before the member ever runs, and levare catches them there:

```
agent 'rook': cwd '/tmp/levare-scratch' does not exist
```

```
agent 'corvid': command 'codex' not found on PATH
```

These are pre-flight checks. A member whose working directory is gone, or whose binary isn't
installed, fails with a *reason* rather than an opaque exit code — because "exited 1" is a symptom,
not a diagnosis.

## Failures that aren't failures

Two states look like failure and aren't:

**A unit that cannot advance.** If your flow needs a `design` and no team in your studio produces one,
the walk halts — not because anything is broken, but because it has nowhere to go. levare says so:

```
add-command needs `design`; no team in this studio produces it.
```

Your flow ends where your team's capabilities end. Add a member who produces the kind, or change the
type.

**A loop that ran out of patience.** Three rounds, no convergence, and `on_exhaust: gate`:

```
review-add-command-v3.md · member/corvid                              EXHAUSTED

  3 of 3 rounds used — this loop cannot continue without `review.approved`.

  round 3/3

  [ Approve anyway ]  [ Re-scope ]  [ Reject ]
```

Note the verb: **Approve anyway.** Not "Approve." You are overruling a critic who refused three times,
and the button says so.

## The rule underneath all of this

levare never fails silently, and it never guesses.

If it knows something — that a member died, that a unit can't advance, that a loop won't converge,
that a model it asked for isn't the one that ran — **it tells you.** A conductor who cannot see what
the orchestra is doing cannot conduct.

That principle cost more to learn than any other in this system. Every one of these states existed
before it was surfaced, and each one, in its silence, cost somebody an hour of confusion.

---

That's the workflow. You've taken a product from a sentence to an approved brief, brought in a member
from another vendor, watched two models argue, and settled it yourself — for about four cents.

**Where next:**

- **[5 · Reference](../05-reference/README.md)** — every field, every schema, every command.
- **[6 · Operations](../06-operations.md)** — what to know before you run agents you don't control.
- **[7 · Community](../07-community.md)** — run your own; share definitions, not runtime.

# 6 · Operations

What to know before you run agents you don't fully control.

This section is about the boundary — what levare governs, and what it doesn't. levare is honest about
both, because a security model you misunderstand is worse than none.

---

## What levare is, operationally

A single-operator console. One person — the Conductor — running it on their own machine, against their
own git repositories, with their own credentials. It is `localhost`, single-user, no authentication,
no multi-tenancy. Every write route is a Conductor action. This is a deliberate scope, not a missing
feature: levare is a cockpit for one pilot.

Everything below follows from that. The threat model isn't "other users" — there are none. It's "the
agents I dispatch, and the code they run."

---

## What a member can see

When levare spawns a member, that member's process environment contains **exactly**:

- `PATH` and `HOME` — the baseline, so a wrapped CLI can resolve its binary and find its own config
- the environment variables named by the connectors that member was granted — and nothing else

It's an **allowlist, never a blocklist.** Your other API keys, your shell's environment, secrets
belonging to other connectors — none of it is copied into the member's process, because nothing copies
it. A member granted `github` sees `GITHUB_TOKEN`. It does not see your `ANTHROPIC_API_KEY`, or your
`STRIPE_KEY`, or anything else, unless a connector it was granted names it.

This is the guarantee levare actually enforces, and it enforces it by construction: the member's
environment is built from the allowlist, not filtered down from yours.

### The one honest exception: subscription auth

A connector declared `auth: subscription` (ruling C13) authenticates from a login the CLI stored on
disk — `codex login` writing a session to `~/.codex`, for instance. levare grants `HOME`, so the CLI
finds that session. Which means: **levare cannot scope a disk-stored credential.** Any member that can
spawn that binary can use the login, granted or not.

levare does not hide this. `levare doctor` prints the warning next to every subscription connector:

```
codex · cli
  auth: subscription · ChatGPT subscription
  ⚠ levare cannot scope this credential — any member that can spawn `codex` can use this
    login. The grant is documentation, not enforcement.
```

Prefer `auth: env` where the vendor offers it. Grant subscription connectors only to members you'd
trust with the login.

### Side-effecting connectors: the grant is not the credential

A connector declared `effects: write` (NOTES CAP-A, v1.1 capability layer) — one that posts an issue,
comments, or otherwise reaches out and changes something — behaves differently from every connector
above **by default**: a member granted it does **not** see its environment variables at all. The
allowlist that builds a member's process (`env.ts#buildMemberEnv`) skips a `write` connector's own vars
entirely unless it's explicitly declared `gate: trusted`. The grant means "you may draft a proposal
against this", never "you hold this credential".

To act, the member produces an artifact of kind `proposal` — naming the connector, one of its declared
`actions:`, and `params` covering every placeholder in that action's argv template. It can never supply
raw argv; only the connector's own author, at definition time, decides what's possible. The proposal
gates like any other artifact. Approving it is what triggers execution: **only then**, and only inside
that one execution step (`execution.ts`), does levare read the connector's credential — substitute the
params into the template, spawn it with an environment containing *just* that connector's vars plus the
baseline, and record the outcome (exit code, a hash of the output, never the raw bytes) on the same
commit as your approval. Rejecting a proposal executes nothing. A failed execution never un-approves the
proposal — it blocks the unit with the failure named, so the next move is yours, not a retry loop's.

`gate: trusted` is the visible opt-out, for a write connector you've decided a member should hold
directly — it injects exactly like an `effects: read` connector always has. Declare it deliberately;
the default (`proposal`) is the safer posture for anything that changes state outside the studio.

---

## What levare does not constrain

This is the part most tools would leave unsaid. levare says it plainly:

**levare governs which agents run, and what they can see. It does not yet govern what a member does to
the machine it runs on.**

A `native` member runs through the Claude Agent SDK with the tools you declared in its `tools:` field —
so its capabilities are bounded by that allowlist. But a `cli` member is a wrapped foreign binary, and
once spawned, it can do whatever that binary can do with the environment and working directory it was
given. levare chose the model, assembled the context, and scoped the environment — but it does not sit
between the member and the operating system.

Some vendors offer their own guardrails, and you should use them. Codex, for example, accepts
`--sandbox read-only` (a member that cannot write to disk), `--ignore-user-config` (nothing from your
machine leaks in), and `--ephemeral` (no session state persists). levare cannot enforce these — but a
member definition can *declare* them, and they're visible in the registry for anyone to audit. When a
vendor hands you a guardrail, use it, and make it visible.

Side-effecting connectors gated as proposals (the `effects: read | write` declaration above) is now
built — that closes the "levare cannot tell a read from a write" half of the capability layer. What
remains, still deferred: **tool forwarding and a scoped `HOME`** for a `native` member (part B of the
capability layer — a member's declared `tools:` currently bounds SDK-native tool calls, but a `cli`
member's own filesystem/network reach is still whatever the binary itself can do), and **OS-level
sandboxing** (v2 — process isolation, not just environment/credential scoping). Until those land, treat
a `cli` member with the same caution you'd treat any script you're about to run: know what the binary
is, and grant it only what it needs.

---

## Running the daemon

`levare serve` runs the daemon, which advances the graph between gates. Operationally, three things
worth knowing:

- **It never spends without a decision in the causal chain.** The daemon dispatches members, but only
  along a path a Conductor started and toward a gate a Conductor will resolve. It cannot start a unit
  you haven't started, and it never retries a failed member on its own.
- **Cost is bounded by budgets.** A work unit's `budget:` raises a gate rather than a bill when crossed.
  Set them.
- **It's `localhost` and single-user.** Don't expose the port. There's no auth because there's no
  second user; putting it on a network would be handing an unauthenticated cockpit to strangers.

---

## Credentials

- Secrets go in your shell or a **gitignored `.env`** at the studio root. `levare validate` refuses to
  run if `.env` is tracked — a committed credential in a studio that gets shared is a catastrophe, and
  the validator treats it as one.
- A shell variable wins over `.env`.
- `levare doctor` reports what's present, what's missing, and where each credential came from. Run it
  when something won't run.

---

Next: **[7 · Community](07-community.md)**

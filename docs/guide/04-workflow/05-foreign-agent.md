---
title: A foreign agent on your team
parent: Workflow
nav_order: 5
---

# 4.5 · A foreign agent on your team

Everything so far has been Claude. Now bring in another vendor — not as an experiment off to the
side, but as a **member of your team**, producing an artifact your flow depends on, gated by you.

The idea: Scribe writes the brief, and a critic reviews it. And the critic is somebody else's model.

This isn't novelty. It's the reason a critic exists at all: **a model reviewing its own work misses
what it's inclined to generate.** Scribe will happily leave a hole in a brief that Scribe would never
notice. A different model, from a different lab, with different habits, notices immediately — you'll
watch it happen.

---

## First, prove the CLI works

levare wraps binaries. It doesn't ship them. So before you declare anything, make sure the thing runs
headlessly on your machine:

```sh
cd $(mktemp -d) && git init -q
codex exec "say ok"
```

If that works, you're in business. (These docs use OpenAI's [Codex CLI](https://github.com/openai/codex);
Google's Gemini CLI works the same way, as does anything with a non-interactive mode.)

**Read the CLI's help before you write the definition.** Guessing at a foreign tool's interface is the
single most reliable way to waste an hour:

```sh
codex exec --help
```

Three things you're looking for, and they each map to a field:

| What you need | Why | Where it goes |
|---|---|---|
| How it takes a prompt | levare must deliver the context recipe | `context_via: arg \| stdin` |
| How it takes a model | levare declares the model, not the vendor ([F11](../05-reference/04-constitution.md)) | `{model}` in `command` |
| How it authenticates | env var, or its own stored login? | the connector's `auth:` |

For Codex: `codex exec -` reads the prompt from **stdin**, `-m` sets the model, and it authenticates
from a stored login written by `codex login`.

## The connector

A connector declares an external system a member can be granted. And here it declares something
uncomfortable and true:

```sh
cd ~/studio

cat > connectors/codex.md <<'EOF'
---
name: codex
kind: cli
command: codex
auth: subscription
env: []
plan: "ChatGPT subscription"
scope: "Codex authenticates via its own stored login (~/.codex). levare does not scope this
        credential — any member that can spawn `codex` can use it. The grant is documentation,
        not enforcement."
---

# Codex connector

Wraps the `codex` CLI in headless mode (`codex exec`). Authenticated by a ChatGPT subscription
rather than an API key, so usage is billed to the plan and receipts record `usd: null`.
EOF
```

### `auth: env` vs `auth: subscription`

This distinction matters more than it looks.

|  | `auth: env` (default) | `auth: subscription` |
|---|---|---|
| **Credential** | An environment variable levare injects | A login the CLI stored on disk |
| **Scoping** | **levare enforces it.** A member without the grant cannot see the key. | **levare cannot enforce it.** Any member that can spawn the binary can use the login. |
| **Cost** | Real per-token receipts | `usd: null`, plan noted — a subscription doesn't bill per token |
| **Setup** | Needs an API key and billing | Works with the login you already have |

levare's credential guarantee is precise: **it scopes *environment* credentials.** A CLI that
authenticates itself from a file in your home directory is outside that boundary, and levare says so
rather than pretending otherwise:

```sh
levare doctor .
```

```
codex · cli
  auth: subscription · ChatGPT subscription
  ⚠ levare cannot scope this credential — any member that can spawn `codex` can use this
    login. The grant is documentation, not enforcement.
  cli codex on PATH
  → ok
```

Prefer `auth: env` where the vendor offers it. Grant `auth: subscription` connectors only to members
you'd trust with the login — because in that mode, the grant is a *label*, not a lock.

## The member

```sh
cat > agents/corvid.md <<'EOF'
---
name: corvid
kind: cli
produces: [review]
model: gpt-5.5
command: ["codex", "exec", "-", "-m", "{model}", "--sandbox", "read-only", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--skip-git-repo-check"]
context_via: stdin
context_artifacts: inline
connectors: [codex]
timeout: 300
result: "Emits review prose on stdout, ending with a verdict line: APPROVED or CHANGES REQUESTED. levare wraps it in the artifact contract."
style:
  avatar: Cv
---

# Corvid — a wrapped Codex critic

You are Corvid, a critic. You review a product brief written by someone else.

Say what is unclear, what is unstated, and what would trip up whoever has to build from it.
Be specific: quote the line, say what is wrong with it. If the brief is genuinely ready, say
so plainly and stop — a reviewer who always finds something is worthless.

End with a verdict on its own line: APPROVED or CHANGES REQUESTED.
EOF

levare validate .
```

### The four fields that make a CLI member work

**`context_via: stdin`** — Codex reads its prompt from stdin when you pass `-`. The assembled context
is far too long for an argv element, so this is the right channel. (`arg` is the default, substituted
into `{task}`.)

**`context_artifacts: inline`** — this one is essential and easy to miss. Corvid runs in an isolated
directory with **no filesystem access to your studio**. It cannot open a path. So levare embeds the
consumed artifact's *full text* in the context instead. Declare `paths` (the default) and your member
gets a pointer to a file it cannot read — and it will tell you so, in its output, which is exactly how
this rule was discovered.

**`{model}` in the command** — levare declares the model, not the vendor. Leave it out and the CLI
picks its own default, silently, and your receipts are fiction.

**`result:`** — required on CLI agents. A prose description of what the binary emits. It's
documentation for whoever reads the registry, and it's required so that wrapping a foreign tool forces
you to state what it actually produces.

### The vendor's own guardrails

Look at the rest of that command template:

```
--sandbox read-only      a critic that cannot write to disk
--ignore-user-config     nothing from your machine leaks into the member
--ignore-rules           no project execpolicy files are loaded
--ephemeral              no session state left behind
```

**levare cannot enforce those — Codex does.** But levare can *declare* them, and anyone reading the
registry can see them. When a vendor hands you guardrails, use them, and make them visible.

(This is the honest boundary of levare's capability model. It governs which agents run, what they see,
and what credentials they hold. It does **not** yet constrain what a wrapped foreign CLI can do to the
machine it runs on. See [Operations](../06-operations.md).)

## What sandboxing means for a vendor CLI's own auth

On a host where levare's OS-level sandbox is available (Operations, above), a `cli` member's process
is confined by the operating system as well as by what levare hands it — and that confinement changes
how the vendor CLI itself behaves, live-validated against a real one (`gh`, not a stub):

- **A sandboxed member's vendor config directory is its own scratch space, not yours.** A CLI's
  config/state/cache locations (`~/.config/<tool>` and friends) are redirected to a fresh, per-dispatch
  directory rather than denied outright, the same technique levare already uses for `git`'s own config.
  The member starts every run with a clean slate — it never sees your `~/.config/gh` (or `~/.codex`, or
  wherever else a CLI keeps its own state).
- **That means it never inherits a login you made yourself.** If you're logged into `gh` on your own
  machine, a sandboxed `gh` member doesn't see that session — its config directory is scratch, not
  yours. Working auth for a sandboxed member has to come through its **connector's** credential in the
  environment instead — `GITHUB_TOKEN`, in `gh`'s case, which the CLI itself checks ahead of a stored
  session by design. This is what the connector above is for; a sandboxed member has no other way in.
- **A network-granted member can make real requests, TLS included; one without a network-granting
  connector cannot reach the network at all.** Holding at least one connector flips network on for the
  member's whole process — a real HTTPS client, certificate verification and all, works end to end. A
  member holding no connector that grants network is denied at the raw socket, before any
  application-level auth logic even runs.
- **Credential and network reach are the same grant, not two.** Both come from the identical condition
  — does this member hold a connector — so a `cli` member can't hold a credential while staying offline
  today; there's no connector shape that names a purely local capability. This is a deliberate stance,
  not an oversight — see [Current gaps](../../current-gaps.md)'s connector trust-tier taxonomy entry for
  why, and what would change it.

None of this is levare talking to the CLI — it's the OS sandbox wrapping the process, so it only
applies on a host where [Operations](../06-operations.md) reports a working sandbox primitive. Where
none exists, the member runs unconfined and none of the above kicks in.

---

Next: **[4.6 · Your first loop](06-first-loop.md)** — where the two of them argue.

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
role: model
env: []
home: [".codex", ".volta"]
plan: "ChatGPT subscription"
scope: "Codex authenticates via its own stored login (~/.codex); home: scopes a granted member's process to a per-run HOME symlinking only these paths from your real one — see Operations for what this does and does not close."
---

# Codex connector

Wraps the `codex` CLI in headless mode (`codex exec`). Authenticated by a ChatGPT subscription
rather than an API key, so usage is billed to the plan and receipts record `usd: null`.
EOF
```

**Why `.volta` is here too, not just `.codex`.** If `codex` on your machine resolves through a version
manager (Volta, nvm, asdf, mise, pyenv, rbenv — anything that installs a shim rather than a plain
binary), `home: [".codex"]` alone gives a granted member's scratch HOME no visibility into the manager's
own bookkeeping, and the shim fails to resolve anything — you'll see the MANAGER's own confusing error
("Volta error: Could not find executable"), not levare's. `levare validate`/`levare doctor` name this
gap directly (`SUBSCRIPTION_HOME_SHIM_GAP`) when they can detect it live on your host. levare never
grants the manager's root for you automatically: a version-managed binary cannot be scoped narrowly —
adding `.volta` exposes every toolchain Volta manages, not just this one connector, and only you can
decide whether that's the right tradeoff for a plain system install instead. If `codex` on your machine
is a plain install (no version manager), `home: [".codex"]` alone is enough — drop `.volta`.

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
codex · cli · model
  auth: subscription · ChatGPT subscription
  ⚠ this credential is scoped to `.codex, .volta` under a per-run HOME — but any member
    granted this connector can still use the login (the grant is not per-member
    revocable; only the real login is).
  cli codex on PATH
  → ok
```

That warning is the **scoped** variant — it shows because this connector declares `home:`. Drop
`home:` entirely and `levare doctor` warns differently (and more loudly): *"levare cannot scope
this credential — any member that can spawn `codex` can use this login. The grant is documentation,
not enforcement."* Declaring `home:` is what moves you from the second warning to the first.

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

(This is the boundary between two different mechanisms, and it moved. levare's **capability model**
governs which agents run, what they see, and what credentials they hold. What a wrapped foreign CLI
can do to the machine it runs on is governed by levare's **OS-level sandbox** instead — which is
real, and is the subject of the next section. On a host with no working sandbox primitive, the
vendor's own flags above are the only guardrails in play, which is exactly why declaring them still
matters. See [Operations](../06-operations.md).)

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
- **A network-granted member can make real requests; one without a network-granting connector cannot
  reach the network at all.** Holding at least one connector flips network on for the member's whole
  process. A member holding no connector that grants network is denied at the raw socket, before any
  application-level auth logic even runs.
- **"Certificate verification works end to end" is validated for one TLS stack, not certified for
  every one.** The live proof behind that claim used `gh` — written in Go, which does its own
  certificate handling and only needed the sandbox to open one narrow path to the platform's trust
  store. A `cli` member whose vendor CLI instead *defers* TLS verification to the platform trust store
  directly (NOTES R4-SANDBOX-TLS: a Rust CLI using `rustls-platform-verifier` or equivalent is the
  case in hand) is a different code path through the same sandbox, and is not covered by the `gh`
  result — see [Current gaps](../current-gaps.md) for what's confirmed and what's still open for
  that case specifically.
- **Credential and network reach are the same grant, not two.** Both come from the identical condition
  — does this member hold a connector — so a `cli` member can't hold a credential while staying offline
  today; there's no connector shape that names a purely local capability. This is a deliberate stance,
  not an oversight — see [Current gaps](../current-gaps.md)'s connector trust-tier taxonomy entry for
  why, and what would change it.

**A note on Corvid specifically (NOTES R4-SANDBOX-APPSERVER, NOTES R4-SANDBOX-TLS — both now
closed):** an "app-server architecture" vendor CLI — one where the CLI itself runs an in-process
client/server split for its own IPC — surfaced two real sandbox gaps in sequence, and both are fixed.
First, `home:`-granted credentials were re-allowed for READ only, never WRITE, which denied a vendor
CLI refreshing its own stored token; a live macOS run confirmed the fix, and Corvid's app-server now
initializes and reaches the network under the sandbox. Second, certificate validation then failed on
both its WebSocket and HTTPS transports (`invalid peer certificate: UnknownIssuer`) — a distinct
fault, because codex's Rust TLS stack defers to the platform trust store directly rather than doing
its own certificate handling the way `gh` (Go) does. A `log stream` capture of the failing dispatch,
diffed against a passing `curl` handshake under the identical generated profile, named exactly one
mach-lookup denial present in the failure and absent from the pass: **`com.apple.SecurityServer`**.
Granted alongside `trustd.agent`, gated on `policy.allowNetwork`, and re-dispatched live — the
handshake completed and the member produced a real `review` artifact at `sandbox: full`.

**A wrapped codex critic runs confined, end to end.** That is what the rest of this chapter
describes, and it is not aspirational. See [Current gaps](../current-gaps.md) for the full six-round
account, including two probe-design flaws found along the way.

If your own `cli` member's vendor CLI can't run confined at all — its own architecture needs OS access
the sandbox won't safely grant — declare that plainly rather than fighting it silently:

```yaml
sandbox: unsandboxed
sandbox_reason: "codex's own app-server needs OS IPC this sandbox's threat model won't grant"
```

`levare validate`/`levare doctor` require the reason and echo it back plainly; the produced artifact
records it too, so anyone reading the registry or a review knows this member never runs confined, and
why — never a silent gap.

None of this is levare talking to the CLI — it's the OS sandbox wrapping the process, so it only
applies on a host where [Operations](../06-operations.md) reports a working sandbox primitive. Where
none exists, the member runs unconfined and none of the above kicks in.

## MCP servers under the sandbox: pre-installed only, never fetched at dispatch

A `kind: remote` member's `kind: mcp` connector gets the identical sandbox wrap a `cli` member's spawn
gets (above) — same OS-level confinement, same `home:` mechanism for a real-HOME path the server
legitimately needs. One shape is not supported under it: **`argv:` naming a package runner that fetches
and executes a package at dispatch time** — `npx` (especially with `-y`/`--yes`), `bunx`, `pnpm dlx`,
`yarn dlx` — over a bare package spec, e.g.:

```yaml
# Rejected under a working sandbox — a fetch-at-dispatch launcher
argv: ["npx", "-y", "@modelcontextprotocol/server-everything", "stdio"]
```

**Why:** `npx -y <pkg>` means "download whatever is at this name right now and execute it" — the exact
untrusted-code problem the sandbox exists to contain, now happening at dispatch instead of at install.
A pre-installed, path-referenced server is auditable and gets a narrow, per-connector filesystem grant
(the interpreter's own script path); a fetch-at-dispatch server's real code lands in an npm/npx/bun
cache under the operator's own `$HOME` — a location nothing in the connector's `argv` ever references,
so the sandbox has nothing to grant a narrow path to. Left alone, this doesn't fail cleanly: the spawned
interpreter blocks trying to read a denied cache path and hangs rather than exiting.

**What to do instead:** install the server locally and reference its resolved script or binary path
directly:

```yaml
# Accepted — a pre-installed server, referenced by its resolved path
argv: ["/usr/local/bin/mcp-server-everything", "stdio"]
# or an interpreter + local script, exactly like the cli case above:
argv: ["node", "/opt/mcp-servers/everything/dist/index.js", "stdio"]
```

A locally-installed server invoked *through* a runner (`npx /abs/path/to/installed-server.js`) is fine
— it's the bare-package-name fetch that's unsupported, not the runner binary itself.

**When this bites:** `levare validate` warns on this declaration unconditionally (`MCP_FETCH_AT_DISPATCH`)
— it's a legal declaration, just one that won't survive contact with a working sandbox, the same
"tell plainly, never reject" posture every other REV1-era warning takes. Dispatch itself only refuses it
on a host where a working sandbox primitive is actually present — on a host with none, the connector
runs exactly as it always has, unconfined. See NOTES MCP-1C addendum 6 for the full ruling.

**One more thing, before the next step relies on it:** if `levare serve` has been running since
[4.4](04-first-gate.md), it has not noticed either of the two files you just wrote. A connector and
an agent are registry, not `work/` — the daemon only watches `work/`, so it takes a restart to pick
either one up. [4.6](06-first-loop.md) is exactly where this stops being trivia and starts mattering.

---

Next: **[4.6 · Your first loop](06-first-loop.md)** — where the two of them argue.

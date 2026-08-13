---
title: Operations
nav_order: 7
---

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
disk — `codex login` writing a session to `~/.codex`, for instance. Which means: **levare cannot scope
a disk-stored credential to a member the way it scopes an env var** — the login lives outside any
environment variable levare could withhold.

**Declare `home:` and it narrows to a real filesystem boundary (v1.1 capability layer, part B).** A
connector can name exactly which dotpaths under `$HOME` its vendor CLI actually needs —
`home: [".codex"]`. When a member is granted a subscription connector that declares `home:`, that
member's spawned process gets a **per-run scratch `HOME`** — a fresh scratch directory, created just
before the spawn and removed just after — containing **symlinks** to only the declared paths from your
real home. Never a copy: the login is a live credential, and revoking it (`codex logout`, deleting the
real `~/.codex`) revokes it everywhere it's symlinked, immediately. Nothing else from your real home —
`~/.ssh`, `~/.aws`, any other dotfile you never named — is reachable from inside that scratch `HOME` at
all.

**Leave `home:` undeclared and you get today's behaviour, unscoped:** the member's spawned process sees
your *entire* real `HOME`, exactly as before this item shipped. `levare doctor` and `levare validate`
both say so plainly rather than let a bare `auth: subscription` grant read as already scoped:

```
codex · cli
  auth: subscription · ChatGPT subscription
  ⚠ levare cannot scope this credential — any member that can spawn `codex` can use this
    login. The grant is documentation, not enforcement. Declare 'home:' to scope it to the
    vendor's own config directory.
```

Declare `home:` and the warning narrows to name what's actually true instead:

```
codex · cli
  auth: subscription · ChatGPT subscription
  ⚠ this credential is scoped to `.codex` under a per-run HOME — but any member granted
    this connector can still use the login (the grant is not per-member revocable; only
    the real login is).
```

That residual is the honest limit of what a symlinked scratch `HOME` can do: it scopes *what a granted
member's process can see on disk*, not *who is allowed to hold the grant in the first place*. Any
member you've granted `codex` can still use the login — `home:` narrows the blast radius of a curious
or buggy member's filesystem reads to the vendor's own config directory; it does not turn the grant
into a per-member-revocable credential. Prefer `auth: env` where the vendor offers it. Grant subscription
connectors only to members you'd trust with the login, and declare `home:` on every one you add.

**`home:` grants read AND write to what it names (NOTES R4-SANDBOX-APPSERVER).** A vendor CLI that
refreshes its own stored credential — most OAuth-authenticated CLIs do, periodically rewriting a token
file — needs to write back into the path `home:` names, not just read it. levare scopes both.

**A version-managed binary needs the manager's own root granted too, not just the vendor's dotpath.** If
the CLI you're wrapping is installed through Volta, nvm, asdf, mise, pyenv, or rbenv, `command:` resolves
to a SHIM — a small script that reads the manager's own bookkeeping (`~/.volta/...`, `~/.nvm/...`, and so
on) to find which real, installed binary to run. `home: [".codex"]` alone gives that shim a scratch HOME
with no manager entry at all — it fails to resolve anything, and the error you'll see is the MANAGER's
own ("Volta error: Could not find executable"), not levare's. `levare validate`/`levare doctor` name this
gap directly when they can detect it live on your host (`SUBSCRIPTION_HOME_SHIM_GAP`) — but levare never
grants the manager's root automatically: **a version-managed binary cannot be scoped narrowly.** Adding
`.volta` to `home:` exposes every toolchain Volta manages under your account, not just this one
connector — decide deliberately whether that's an acceptable tradeoff, or install the vendor CLI as a
plain system binary instead where you want a genuinely narrow grant.

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

**levare governs which agents run, and what they can see — and, for a `cli` member's own spawned
process and, since PRD Amendment 3 ruling R3 (NOTES MCP-1C), a `remote` member's spawned MCP server
process, best-effort per-OS, what it can reach on disk and over the network once it's running
(NOTES R4-SANDBOX, v2 Ruling 2). It does not govern *which named tool* a `cli` member uses within that
reach.**

### `tools:` — the vocabulary is real, and enforcement depends on `kind`

`tools:` is a validated, fixed vocabulary (`SDK_TOOL_NAMES`, derived from the Claude Agent SDK's own
tool surface — `Read`, `Write`, `Bash`, `Glob`, `Grep`, `WebSearch`, and the rest) — `levare validate`
rejects an unknown name outright, naming the real vocabulary so a typo is caught at definition time, not
discovered as a silent no-op at run time. But naming a real tool is not the same as levare being able to
*enforce* the allowlist it names — that depends entirely on the member's `kind`:

| `kind`     | `tools:` enforcement                                                                    |
|------------|-------------------------------------------------------------------------------------------|
| `native`   | **Enforced.** The declared list forwards to the Claude Agent SDK's own `tools`/`allowedTools` boundary, verbatim — the SDK boundary receives exactly what you declared, nothing implicit. Declaring none keeps the current default (an empty allowlist) unchanged. |
| `cli`      | **Not enforced at the per-tool level — warned.** There is no SDK boundary in the cli spawn path for a named-tool allowlist to reach; `finch`'s own `codex` binary decides what it can do, not levare. The OS sandbox below narrows the member's *overall* reach, but a sandbox can't tell "may use Read" from "may use Write" the way `tools:` itself describes — so `levare validate`/`levare doctor` still warn plainly (`CLI_TOOLS_NOT_ENFORCEABLE`) when a cli agent declares `tools:`, narrowed by the sandbox, never silenced by it. The only way to silence the warning itself is to remove the field and encode the constraint in the connector/command instead, via the vendor's own flags (`codex --sandbox read-only` is this studio's own in-tree precedent). |
| `remote`   | **N/A — different vocabulary.** A `remote` member declares `tool:` (singular) — the ONE MCP server tool it calls (PRD Amendment 3 ruling R2, one dispatch, one call) — never `tools:`'s SDK allowlist; there is nothing here for that field to enforce. Its spawned MCP server process gets the same OS-level sandbox a `cli` member's spawn does (below, ruling R3). |

A `native` member's capabilities really are bounded by its declared allowlist now. A `cli` member is
still a wrapped foreign binary that decides for itself which of ITS OWN tools/flags to use with whatever
reach it's given — levare chose the model, assembled the context, and scoped the environment — but now
also sits between it and the operating system, best-effort (below), which is a different, coarser
boundary than a per-tool allowlist would be.

Some vendors offer their own guardrails, and you should still use them — belt and suspenders. Codex, for
example, accepts `--sandbox read-only` (a member that cannot write to disk), `--ignore-user-config`
(nothing from your machine leaks in), and `--ephemeral` (no session state persists). A member definition
can *declare* them, and they're visible in the registry for anyone to audit; layering them on top of
levare's own OS sandbox costs nothing and narrows the reach further on hosts where the vendor's own flag
is more precise than levare's coarser process-level confinement.

Side-effecting connectors gated as proposals (the `effects: read | write` declaration above) closed the
"levare cannot tell a read from a write" half of the capability layer (part A). Real `native` tool
forwarding and a symlinked, per-run scoped `HOME` (the section above) close part B. **OS-level sandboxing
(v2, NOTES R4-SANDBOX; extended to remote/MCP by PRD Amendment 3 ruling R3, NOTES MCP-1C) is now closed
too:** every real `cli` spawn, AND a real `remote` member's own spawned MCP server process, run inside an
OS sandbox wherever a working primitive exists on the host — `bubblewrap` on Linux (falling back to a raw
`unshare` confinement when `bubblewrap` isn't installed but the kernel still allows it), a generated
`sandbox-exec` profile on macOS; the SAME generator either way, never a second, looser profile for MCP.
Filesystem is a hard limit when a primitive works: the member's process can reach its own per-dispatch
working area (a `cli` member's git worktree; a `remote` member's fresh per-dispatch scratch cwd — an MCP
tools/call has no cwd of its own), its own scoped `HOME` (a `remote` member's connector can declare its
OWN `home:` dotpaths a spawned server legitimately needs, the identical mechanism a subscription `cli`
connector already uses), the studio root itself (read-only — so a command checked into the studio, and a
`context_artifacts: paths` member's own consumed-artifact reads, both keep working), the running levare
binary's own install and wherever the member's own interpreter resolves to, and a small set of baseline
system paths — nothing else; a decoy file anywhere outside that reach is genuinely unreadable, proven by
a dedicated test for both `cli` and `remote`. Network is best-effort — denied unless the member holds a
connector granting it somewhere to reach (a `remote` member always holds at least its own MCP server
connector, so this is granted by construction for it). **Detection is never assumed from the platform:** a host can
have `bubblewrap` on `PATH` and still not actually support it (this project's own dev container is exactly
that case — unprivileged user namespaces disabled by the outer container), and levare probes a real
invocation before trusting either primitive, at both `levare doctor` time and at every spawn. A live macOS
run — the first host where `sandbox-exec` actually engaged — caught two real bugs the Linux-only dev
container couldn't: macOS's `/tmp` is a symlink into `/private`, which `sandbox-exec`'s own path rules
don't follow the way a shell would, so every path in the generated profile is now canonicalized before
it's written in; and the original design left out the studio root and the interpreter's own install
location, which is exactly the reach an ordinary vendor CLI needs (NOTES R4-SANDBOX-FIX). When neither
primitive works, the spawn proceeds unsandboxed rather than failing — a Conductor ruling, not an oversight
— and `levare doctor`/`levare validate`/the registry all say so plainly (`SANDBOX_UNAVAILABLE`, the
sibling to `CLI_TOOLS_NOT_ENFORCEABLE` above — fired per `cli` agent, and per fully-implemented `remote`
agent), with the actual
enforcement level (`full` / `fs-only` / `none`) recorded on the produced artifact every run. Treat a
`cli` member, or a `remote` member's granted MCP server, with the same caution you'd treat any script
you're about to run regardless: know what the binary is, and grant it only what it needs — the sandbox
narrows the blast radius of a mistake, it doesn't remove the need for that judgment.

**When a vendor CLI genuinely cannot run confined, declare it — never fight it silently (NOTES
R4-SANDBOX-APPSERVER).** Some vendor CLIs have their own internal architecture — an in-process IPC
client/server split, a self-sandboxing helper that calls into the OS's own sandbox primitive as part of
its startup — that needs OS access this sandbox's threat model won't safely grant. If you've confirmed
that (not merely suspected it — see [Current gaps](../../current-gaps.md) for the live investigation this
project ran against exactly this shape), declare it on the agent:

```yaml
sandbox: unsandboxed
sandbox_reason: "why, specifically — what this CLI's own architecture needs that the sandbox can't grant"
```

`sandbox_reason` is required — `levare validate` rejects the declaration without one. Once declared, this
member's spawn is never wrapped, on any host, even one with a genuinely working sandbox primitive;
`levare validate`/`levare doctor` name it with the same plainness `SANDBOX_UNAVAILABLE` gives a host that
merely lacks a primitive, and the reason is stamped on every artifact this member produces
(`sandbox_reason:`, alongside `sandbox: none`) — so anyone reading the registry, a review, or a produced
artifact sees plainly that this member never runs confined, and why, rather than mistaking it for an
ordinary host capability gap.

**"Network is granted" and "TLS works" are not the same claim, and the gap between them is per TLS stack
(NOTES R4-VENDOR-CLI, NOTES R4-SANDBOX-TLS).** Holding a granting connector opens the raw socket AND a
network-gated mach-lookup grant (`com.apple.trustd.agent` on macOS) a real HTTPS client needs beyond raw
connectivity — live-proven against `gh`, which does its own certificate handling in Go and only needed
that one path opened. A `cli` member wrapping a CLI that instead defers TLS verification to the platform
trust store directly is a different code path through the same sandbox: live evidence (a real macOS run,
`codex`) shows that class failing at certificate validation (`invalid peer certificate: UnknownIssuer`)
even with the identical network grant in place, and `gh`'s own success does not, and never did, certify
it for that case. **On Linux, this gap doesn't exist by construction** — `bubblewrap` grants a
network-allowed member the host's real network namespace outright (no isolated namespace needing its own
DNS/routing setup) and the CA trust store (`/etc/ssl/certs`, `/usr/share/ca-certificates`) is already in
the unconditional baseline read-only allowlist, so nothing further is needed there regardless of which
TLS stack a given `cli` member's vendor CLI uses — proven by construction, not yet live-confirmed on a
working `bubblewrap` host. If your own `cli` member's vendor CLI defers to the platform trust store on
macOS, treat a real end-to-end TLS request as unverified until you've tested it directly on that host;
`scripts/repro-r4-sandbox-tls-handshake.ts` is the codex-independent harness this project built to isolate
exactly this question, and [Current gaps](../../current-gaps.md) tracks the outcome.

**On macOS, a network-granted member can also reach `securityd` — keychain and cryptographic services,
not just trust evaluation (NOTES R4-SANDBOX-TLS).** `trustd.agent` alone was not sufficient for a real,
live TLS handshake through a platform-trust-store-deferring stack: a `log stream` capture of the failing
dispatch, diffed against a passing one, named a second mach service the handshake itself needed —
`com.apple.SecurityServer`, granted identically (network-gated) alongside `trustd.agent`. Read the two
grants as distinct in scope, not a pair: `com.apple.SecurityServer` **is** `securityd`, the daemon behind
the keychain and macOS's cryptographic services generally — a broader surface than `trustd.agent`'s own
trust-evaluation-only reach. What this grant opens: a member's process may send mach messages to
`securityd` at all — the reach a TLS stack that defers to Security.framework needs to complete a
handshake. What it does **not** open: access to any particular keychain item. `securityd` enforces
keychain ACLs per item, on every request, entirely independent of whether the caller can reach it over
mach-lookup at all — this grant is a precondition for talking to the daemon, not a bypass of what the
daemon itself still gates.

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

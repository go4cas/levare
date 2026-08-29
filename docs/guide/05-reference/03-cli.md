---
title: The CLI
parent: Reference
nav_order: 4
---

# 5.3 · The CLI

levare has eight commands. Seven run once and exit; `serve` runs until you stop it.

Every command takes a **studio path** as its first argument. These docs write the binary as `levare`;
if you built from source and haven't put it on your `PATH`, call it by path (`~/source/levare/levare`)
or symlink it (`ln -s ~/source/levare/levare /usr/local/bin/levare`).

---

## `levare init <path>`

Scaffold a new studio.

```sh
levare init ~/studio
```

Creates the directory skeleton, an example team you can edit or delete, a baseline
`knowledge/model-pricing.md`, a `.gitignore`, a `.env.example`, and a `README.md` — then runs
`git init` and makes the founding commit as you. A studio without git is a studio with its guarantees
switched off, so `init` never leaves you without one.

The scaffolded studio **validates and runs out of the box**: its agents declare real, priced models,
and its example team's flow binds end to end.

---

## `levare new <project> <unit> [--type <type>] [--team <team>] [--budget <usd>] [--root <path>]`

Create a work unit — no hand-editing `unit.md` required.

```sh
levare new todo-cli add-command --type feature
```

```
levare new · work/todo-cli/add-command/unit.md
  type: feature
  team: press (inferred)
  git: committed 3f9a1c2e0b7d
Next: levare validate .
```

`--type` and `--team` are only required when your studio leaves more than one candidate — with
exactly one, `new` infers it and says so. `--budget` falls back to the project's own
`overrides: { budget: ... }` when the project declares one; otherwise the unit carries no budget.

Every failure is a diagnosis, never a guess: an unknown project or type names the ones that do
exist, an ambiguous type or team names every candidate and asks you to pick, and a studio that
doesn't already `validate` is refused rather than built on top of.

`new` commits the file under your own resolved git identity (the same `git config user.name`/
`user.email` `init`'s founding commit uses) when one resolves and this studio has git history —
otherwise the file is still written (files are the truth), and the command tells you it wasn't
committed.

---

## `levare project new <name> --repo <path> [--remote <url>] [--default-branch <branch>] [--deploy <text>] [--pace auto|step] [--root <path>]`

Create a project — no hand-editing `projects/<name>.md` required.

```sh
levare project new todo-cli --repo ~/source/todo-cli
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

`--repo` is required and must point at a real local git checkout — `--repo` naming anything else
(a placeholder path, a repo you haven't cloned yet, the studio's own root) is refused immediately,
naming the path it resolved to, rather than left to surface later as `PROJECT_REPO_UNRESOLVED` at
first dispatch. `--default-branch` and `--remote` infer from that checkout when it leaves exactly one
candidate (its current branch; its one configured remote) and require the flag, naming every
candidate, when it doesn't. `--deploy` defaults to `null`; `--pace` defaults to `auto`.

House rules — the project's own [context recipe](../03-concepts.md#context-what-a-member-actually-sees)
injection — are read from stdin when piped in, so the whole registration is one command:

```sh
levare project new todo-cli --repo ~/source/todo-cli <<'EOF'
- Zero runtime dependencies. Bun's standard library only.
- Single binary. No config file, no server, no network.
EOF
```

Every failure is a diagnosis, never a guess, exactly like `new` above — including a studio that
doesn't already `validate`, which is refused rather than built on top of. Commits under your own
resolved git identity the same way `new` does.

---

## `levare validate <path>`

Check a studio against the contract.

```sh
levare validate ~/studio
```

```
valid
```

`validate` checks every entity against its schema **and** checks that the studio can actually run —
that every kind a team promises is produced by a member it has, that every flow step binds, that no
two teams ambiguously produce the same needed kind, that every declared model is priceable, that
`auth` and `env` agree, and more. It reports **every** violated rule for an entity in one pass.

A `valid` studio is one that will not surprise you at 2am. An invalid one is refused with a message
that names the file, the field, and usually the fix.

Run it constantly. It's the fastest way to know what levare thinks of your studio.

---

## `levare doctor <path>`

Report on the studio's environment and readiness.

```sh
levare doctor ~/studio
```

```
run mode: compiled (build 9c00154)

orchestrator: on · ANTHROPIC_API_KEY is present (dotenv); the Claude Agent SDK's native binary
resolved — authentication (an API key or a subscription session) isn't checked until the
Orchestrator makes a real request.

orchestrator prompt: readable (4251 bytes) at /$bunfs/root/orchestrator-prompt-5bbmv1hp.md

sandbox: full (sandbox-exec — OS-visible, operator HOME denied)

levare doctor · 3 connectors

codex · cli · model
  auth: subscription · ChatGPT Plus — flat monthly rate
  ⚠ levare cannot scope this credential — any member that can spawn `codex` can use this
    login. The grant is documentation, not enforcement.
  cli codex on PATH
  → ok

github · cli · tool
  auth: env
  env GITHUB_TOKEN missing
  cli gh on PATH
  → missing-env
```

`doctor` tells you what `validate` can't: which build you're running, whether the Orchestrator's SDK
binary resolved, whether each connector's env vars are actually present (and where they came from —
`.env` or shell), whether each CLI is on your `PATH`, what OS sandbox this host can actually enforce,
and each connector's auth mode with the scoping warning for subscription ones.

**It does not pre-check whether your credential works.** An API key or a subscription session is only
exercised when the Orchestrator makes a real request — and the vendor's own error is what you get
back, which is more accurate than anything levare could guess in advance.

Where `validate` answers *"is this studio correct?"*, `doctor` answers *"will it run on this machine?"*

---

## `levare context <agent> --unit <unit> [--step <step>] [--root <path>] [--dry-run]`

Show exactly what a member will receive.

```sh
levare context lyra --unit checkout-flow --dry-run
```

Prints the full assembled context — the seven-part recipe — for a given member and unit. Not an
approximation: **byte-for-byte what the member's process will be handed.** Use it to see what a member
knows before you spend money finding out.

- `--unit` names the work unit (required).
- `--step` scopes to a specific flow step, when a unit has several.
- `--root` points at a studio other than the current directory.
- `--dry-run` assembles and prints without dispatching anything.

---

## `levare replay <path> [--stubs]`

Re-run a studio's flow deterministically, for testing.

```sh
levare replay fixtures/golden --stubs
```

Drives the batch engine over a studio with scripted decisions. `--stubs` substitutes stub members for
real ones, so the run is deterministic and free — it's how levare's own test suite verifies the walk,
the gates, and the loops produce a known result. You'll rarely need it on your own studio; it's a
development and CI tool.

---

## `levare serve <path> [--port <n>] [--read-only] [--no-daemon]`

Start the board and the daemon.

```sh
levare serve ~/studio
```

```
levare · http://localhost:4173 · daemon: on
```

The one long-running command. It serves the board on localhost, opens an SSE channel so the page
re-derives when files change, and runs the [daemon](../04-workflow/07-the-daemon.md) — which advances
the graph between gates and halts at every one.

- `--port` serves on a port other than the default `4173`.
- `--no-daemon` serves the board without the daemon: you can read and resolve gates, but nothing
  advances on its own. Useful for inspecting a studio without letting it run.
- `--read-only` serves the board with the write routes disabled entirely — a safe way to look at a
  studio you don't intend to touch.

It loads a `.env` from the studio root at startup, and again on every page load and mutating request
— an edited `.env` takes effect on the next request, no restart needed (a shell variable that
genuinely differs still wins over `.env`). It's single-user and localhost, and every write route is a
Conductor action.

Stop it with `Ctrl-C`; it shuts the listener down cleanly.

---

Back to **[5 · Reference](README.md)**.

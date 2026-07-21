---
title: The CLI
parent: Reference
nav_order: 4
---

# 5.3 · The CLI

levare has six commands. Five run once and exit; `serve` runs until you stop it.

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
orchestrator: on · The Orchestrator is live.

levare doctor · 3 connectors

codex · cli
  auth: subscription · ChatGPT subscription
  ⚠ levare cannot scope this credential — any member that can spawn `codex` can use this
    login. The grant is documentation, not enforcement.
  cli codex on PATH
  → ok

github · cli
  auth: env
  env GITHUB_TOKEN missing
  cli gh on PATH
  → missing-env
```

`doctor` tells you what `validate` can't: whether the Orchestrator has a credential, whether each
connector's env vars are actually present (and where they came from — `.env` or shell), whether each
CLI is on your `PATH`, and each connector's auth mode with the scoping warning for subscription ones.

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

## `levare serve <path> [--read-only] [--no-daemon]`

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

- `--no-daemon` serves the board without the daemon: you can read and resolve gates, but nothing
  advances on its own. Useful for inspecting a studio without letting it run.
- `--read-only` serves the board with the write routes disabled entirely — a safe way to look at a
  studio you don't intend to touch.

It loads a `.env` from the studio root at startup (a shell variable wins over `.env`). It's
single-user and localhost, and every write route is a Conductor action.

Stop it with `Ctrl-C`; it shuts the listener down cleanly.

---

Back to **[5 · Reference](README.md)**.

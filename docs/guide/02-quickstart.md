---
title: Quickstart
nav_order: 3
---

# 2 · Quickstart

Ten minutes. No API keys, no agents, no spend. At the end you'll have a studio on disk and a board
in your browser.

---

## Prerequisites

- **`git`** on `PATH` — not optional. Without it, levare cannot verify that an approved artifact
  hasn't been tampered with, and it has no audit log. It will tell you so.
- **[Bun](https://bun.sh)** — only if you're building from source or contributing. The released
  binary is self-contained and doesn't need it.

That's all for *this* walkthrough — it runs no agents and spends nothing. But running the binary for
real is NOT zero-setup: it also needs **a model provider** — `ANTHROPIC_API_KEY` (the Claude Agent
SDK, for native members) and/or a wrapped vendor CLI such as `claude` or `codex` on `PATH` (for cli
members). [Operations](06-operations.md) covers that when you're ready.

## Install

The quickest path — downloads the release binary for your platform, verifies its checksum against
`SHA256SUMS`, and puts it on your `PATH`:

```sh
curl -fsSL https://raw.githubusercontent.com/go4cas/levare/main/scripts/install.sh | sh
```

Two overrides, if you need them:

- `LEVARE_VERSION=v1.2.3 curl ... | sh` — pin to a specific release instead of the latest one.
- `LEVARE_BIN_DIR=/usr/local/bin curl ... | sh` — install somewhere other than `~/.local/bin` (needs
  write access to that directory, e.g. via `sudo`).

If the install directory isn't on your `PATH`, the installer warns you rather than fixing it for
you — add it to your shell profile.

### Installing by hand

If you'd rather not pipe a script into `sh`: from the [releases page](https://github.com/go4cas/levare/releases),
download the binary for your platform (`levare-darwin-arm64`, `levare-darwin-x64`, `levare-linux-x64`,
or `levare-linux-arm64`) and the `SHA256SUMS` file alongside it, verify, then install:

```sh
sha256sum -c SHA256SUMS --ignore-missing   # macOS: shasum -a 256 -c
chmod +x levare-<platform>
mv levare-<platform> /usr/local/bin/levare
levare --version    # confirms the binary and the exact commit it was built from
```

### Building from source — for contributors

If you're working on levare itself rather than just running it, clone the source repo instead of
installing a release:

```sh
git clone https://github.com/go4cas/levare.git
cd levare
bun install
bun run build          # produces dist/levare, a self-contained compiled binary
```

Or skip compiling and run the dev entry point straight from source: `./levare --version`. This is the
levare **source** repo, not your studio — see [3 · Concepts](03-concepts.md) for that distinction.

The rest of these docs write the binary as `levare`; whichever path you took, make sure it's on your
`PATH` so you can call it from anywhere.

## Scaffold a studio

A **studio** is a git repository of markdown files. It is *not* the levare source repo — it's yours,
and it lives wherever you keep your work.

```sh
mkdir ~/studio && cd ~/studio
levare init .
```

```
levare init · .
  25 file(s)/dir(s) created
  git: founding commit 0b0a567d8369 as you <you@example.com>
Next: levare validate .    ·    levare serve .
```

`init` scaffolds the skeleton, an example team you can edit or delete, and it runs `git init` and
makes the founding commit **as you** — because a studio without git is a studio with its guarantees
switched off, and the first commit should carry your name like every one after it.

What you get:

```
teams/         who does the work — what they consume, what they produce, their flow
agents/        the members — native (Claude SDK), cli (a wrapped foreign CLI), or remote (MCP)
skills/        reusable instructions a member's context can include
knowledge/     reference documents (and a baseline model-pricing table) injected by name
types/         the five work-unit templates: inception, feature, fix, spike, research
connectors/    external services members can be granted (env var NAMES only — never secrets)
projects/      pointers to the products you're building
work/          work units and the artifacts they produce — empty until you open one
ideas/         captured pitches with no project yet
studio.md      studio-level settings (e.g. the Orchestrator's model)
.env.example   copy to .env and fill in — for when you're ready to run agents
```

`.env.example` is a template, not a live file. You won't need it for this quickstart — nothing here
spends money or touches a key — but it's where credentials go when you reach
[the workflow](04-workflow/README.md). `.env` is gitignored, and `levare validate` refuses to run if
you ever commit one.

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

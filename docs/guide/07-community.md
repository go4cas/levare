# 7 · Community

levare is built to be run by one person, and shared as text.

---

## Getting levare

Two paths, for two kinds of person.

**Download a binary.** Each release publishes standalone binaries for macOS and Linux (arm64 and x64)
on the [releases page](https://github.com/go4cas/levare/releases), with a `SHA256SUMS` file to verify
against. Download the one for your platform, check it, make it executable, put it on your `PATH`:

```sh
# verify (macOS uses shasum; Linux uses sha256sum)
shasum -a 256 -c SHA256SUMS --ignore-missing
chmod +x levare-darwin-arm64
mv levare-darwin-arm64 /usr/local/bin/levare
```

**Build from source.** If you have [Bun](https://bun.sh) and want the source:

```sh
git clone https://github.com/go4cas/levare.git
cd levare
bun install
bun run build          # produces dist/levare
```

Either way — and this is stated plainly on every release — **a levare binary is not zero-setup.** It
bundles levare and its one dependency, but at runtime it still needs `git` on your `PATH` and a model
provider (an `ANTHROPIC_API_KEY` for native members, and/or a wrapped CLI like `codex` for cli
members). Run `levare doctor` after installing to see exactly what's present and what's missing.

---

## What you share

**Definitions, not runtime.**

A studio is a git repository of markdown files. Your teams, agents, skills, and knowledge are text —
and text is shareable. If you build a good research team, or a critic worth reusing, or a skill that
captures a hard-won technique, you share *the files*. Someone else drops them into their studio, points
their own credentials at them, and runs them on their own machine.

What you don't share is a running service. There's no levare cloud, no hosted multi-tenant thing to log
into. Everyone runs their own, against their own repos, with their own keys. The unit of collaboration
is a definition, not a deployment.

This has a pleasant consequence: **a shared team is auditable before you run it.** It's markdown. You
can read exactly what an agent's system prompt says, what it produces, what connectors it's granted,
and what a wrapped CLI's command line is — before a single member spawns. You're never running a black
box someone handed you; you're running text you read.

---

## Contributing

levare's constitution ([5.4](05-reference/04-constitution.md)) is the bar. A contribution should say
which invariant or ruling it touches, and it must not weaken the ones that matter — the Conductor as
sole approver, the honest audit log, the environment allowlist, the receipts that never lie.

Before proposing new work, check **[Current gaps](../current-gaps.md)** — a register of what's
already known to be deferred or unenforced, and why. It'll tell you whether the gap you found is a
bug or a documented decision, and point you at the NOTES entry or PRD amendment behind it.

Two principles from levare's own construction, worth inheriting:

- **If a test would still pass with the feature deleted, the test isn't testing the feature.**
- **If a mechanism is exercised only by the fixture, it isn't exercised.** The live path and the test
  path must agree, and something must prove they agree. The fixture is not the product.

Both are written into levare because both were learned the hard way.

---

## The shape of it

levare is one dependency, one binary, one operator, files as truth. It stays small on purpose. The
roadmap has real gaps — the capability layer, richer distribution, more of the guide — but the core is
deliberately modest: a cockpit for directing AI agents, where every decision is yours, every cost is
visible, and every action is a line in a log that knows the difference between you and the machine.

Agents play on your beat.

---

Back to **[the guide](README.md)**.

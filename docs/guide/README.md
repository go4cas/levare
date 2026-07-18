# levare — documentation

A solo operator's console for directing teams of AI agents, from pitch to production.

**Agents play on your beat.**

---

## Start here

| | |
|---|---|
| **[1 · Introduction](01-introduction.md)** | What levare is, the three roles, and why there's a human at every gate. |
| **[2 · Quickstart](02-quickstart.md)** | Install, scaffold a studio, open the board. Ten minutes, no API keys. |
| **[3 · Concepts](03-concepts.md)** | The vocabulary — studios, teams, members, work units, artifacts, gates, flows. With diagrams. |

## Build something

| | |
|---|---|
| **[4 · Workflow](04-workflow/)** | The guided build. Take a product from an idea to an approved spec, step by step. |
| [4.1 Capture an idea](04-workflow/01-capture-an-idea.md) | From a pitch to a project. |
| [4.2 Your first member](04-workflow/02-your-first-member.md) | A team, an agent, and the context it receives. |
| [4.3 Your first gate](04-workflow/03-your-first-gate.md) | Approve, request changes, reject. |
| [4.4 Your first loop](04-workflow/04-your-first-loop.md) | A reviewer, `max_rounds`, and what happens on exhaustion. |
| [4.5 Wrapping a foreign CLI](04-workflow/05-wrapping-a-foreign-cli.md) | Gemini, Codex, or anything with a headless mode. |
| [4.6 The daemon](04-workflow/06-the-daemon.md) | Let the score advance between gates. |
| [4.7 Cost and budgets](04-workflow/07-cost-and-budgets.md) | What things cost, and how to bound them. |
| [4.8 When a member fails](04-workflow/08-when-a-member-fails.md) | Reading a blocked artifact. |

## Look things up

| | |
|---|---|
| **[5 · Reference](05-reference/README.md)** | Schemas, the artifact contract, the CLI, the write surface. |
| [5.1 The artifact contract](05-reference/01-artifact-contract.md) | Every field, every status, every rule. |
| [5.2 Registry entities](05-reference/02-registry-entities.md) | Teams, agents, skills, knowledge, types, connectors, projects. |
| [5.3 The CLI](05-reference/03-cli.md) | `init` · `serve` · `validate` · `doctor` · `context` · `replay` |
| [5.4 The constitution](05-reference/04-constitution.md) | The invariants and rulings a contribution must not violate. |

## Run it for real

| | |
|---|---|
| **[6 · Operations](06-operations.md)** | Machine prerequisites, credential discipline, sandboxing, and what levare does *not* constrain. |
| **[7 · Community](07-community.md)** | Run your own. Share definitions, not runtime. |
| [Current gaps](../current-gaps.md) | A register of what's deliberately deferred or unenforced today, and why — not a roadmap. |

---

## The shape of the thing, in one paragraph

levare is a single binary over a git repository of markdown files. There is no database, no
account, no server, and no hosted anything. The files are the truth: your teams, your agents, your
work, and every artifact they produce are markdown with YAML frontmatter, in git. The binary reads
them and serves you a console. One LLM — the **Orchestrator** — interprets what you want and routes
it. A deterministic **Runner** executes it, holds the invariants, and halts at every gate. You are
the **Conductor**, and nothing consequential happens without you.

# 5 · Reference

Look things up. Every field, every command, every rule levare enforces.

Unlike the [Workflow](../04-workflow/), this section is not a path — it's a set of tables you return
to. Read the workflow first if you haven't; this will make more sense once you've built something.

| | |
|---|---|
| [5.1 · The artifact contract](01-artifact-contract.md) | Every frontmatter field, every status, and the rules that govern an artifact's life. |
| [5.2 · Registry entities](02-registry-entities.md) | Agents, teams, connectors, projects, types, studio settings — every field as `validate` sees it. |
| [Cheatsheets](cheatsheets/) | One generated page per entity: field table, enum values, and a copy-pasteable skeleton that actually validates — computed straight from the schemas, so it can't drift from the code. |
| [5.3 · The CLI](03-cli.md) | `init` · `serve` · `validate` · `doctor` · `context` · `replay` |
| [5.4 · The constitution](04-constitution.md) | The invariants and rulings a contribution must not violate. |

---

## One idea, before the tables

Everything in this section describes files. levare has no hidden state, no database, no config store.
An agent is a file. A team is a file. A gate resolution is a commit. When a table says a field is
"required," it means `levare validate` will refuse the file without it — and refuse it with a message
that names the file, the field, and usually the fix.

If you ever wonder what levare thinks about your studio, the answer is always the same: run
`levare validate .`, and read what it says.

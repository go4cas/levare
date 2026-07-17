// `levare init` (phase 6, PRD §3/§11): scaffold an empty directory into a working studio — the
// skeleton (teams/ agents/ skills/ knowledge/ types/ connectors/ projects/ evals/ work/ ideas/), the
// five type templates, one example team with its agents, a sample skill, a .devcontainer/, and a
// starter README. Templates are embedded as literal strings (not read from fixtures/golden/ at runtime) so
// the scaffold works from a `bun build --compile` binary with no source tree alongside it — the
// point of a single portable binary (invariant 2).
//
// The example team/agents/skills/types/connectors/knowledge below are the golden fixture's registry
// entities genericized: those files never referenced "storefront" in the first place (no product
// branding, just generic pitch-to-spec vocabulary), so "genericizing" here means dropping everything
// that WAS demo-specific — the storefront project pointer, the checkout-flow/cart-icon-fix/
// loyalty-flow work units, the loyalty-program idea, the checkout-flow eval — and keeping the rest
// almost verbatim. `work/` and `ideas/` are scaffolded empty: a new studio has no work yet and no
// captured pitches yet, so the honest starting state is empty, not fabricated demo content. The
// example team also ships with no `teams/<name>.learnings.md`: LEARNINGS accumulate from real runs,
// and a studio that has never run anything has none yet — inventing one would misrepresent history
// that doesn't exist.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { makeFoundingCommit, type FoundingCommitResult } from "./git.ts";

export interface ScaffoldResult {
  /** Paths written (files) or created (directories, suffixed "/"), relative to the target. */
  created: string[];
  /** Files that already existed and were left untouched — `init` never overwrites. */
  skipped: string[];
}

export interface InitResult {
  scaffold: ScaffoldResult;
  git: FoundingCommitResult;
}

interface Template {
  path: string;
  content: string;
}

// Directories that must exist even though the fresh studio has no files in them yet.
const EMPTY_DIRS = ["work", "ideas", "evals"];

// Shared verbatim between the scaffolded README and `runInitCmd`'s (cli.ts) fallback output when no
// git identity resolves — one sentence of rationale, one place it's written (phase-6 gate fix-up).
export const GIT_IDENTITY_NOTE =
  "This studio's approved-artifact immutability check and every commit-as-Conductor write path " +
  "(gate approvals, registry edits) depend on git history existing. `levare init` sets this up " +
  "automatically: it runs `git init` and makes a founding commit using your resolved git identity " +
  '(`git config user.name` / `user.email`). If this studio has no commit yet, no identity could be ' +
  "resolved when `init` ran — configure one (`git config --global user.name \"…\"` and " +
  '`user.email "…"`) and commit this studio yourself before relying on those guarantees.';

const README = `# your levare studio

This is a **levare studio**: a git repository of markdown files with YAML frontmatter that the
\`levare\` binary reads, validates, and serves as a console for directing teams of AI agents. There
is no database — the files under this directory are the truth, and every screen \`levare serve\`
renders is derived from them on every request.

## Layout

\`\`\`
teams/       who does the work — name, consumes/produces, flow (step / gate / loop), style color
agents/      native (Claude Agent SDK), cli (wrapped foreign CLI), or remote (MCP) members
skills/      reusable instructions a member's context can include
knowledge/   reference documents injected into member context by name
types/       the five work-unit templates: inception, feature, fix, spike, research
connectors/  external services members can be granted (env var *names* only — never secrets)
projects/    pointers to the products you're building (repo, deploy, pace, house rules)
evals/       rubrics scoring a unit type's output — empty until you write one
work/        work units and their artifacts — empty until you open one
ideas/       captured pitches with no project yet — empty until you capture one
\`\`\`

## Included as a working example

One team, \`kestrel\`, whose flow demonstrates all three flow shapes a team can declare: a plain
\`step\` (\`brief\`), a \`gate: human\` (the Conductor's approval), and a \`loop\` (\`spec\` ⇄ \`review\`,
alternating until \`spec.approved\`, capped at 3 rounds with an escalation gate on exhaustion). Its
three members show both non-remote agent kinds: \`wren\` and \`lyra\` are \`native\` (Claude Agent SDK
subagents), \`finch\` is \`cli\` (a wrapped foreign CLI). \`skills/new-project/\` is a sample skill in
the Agent Skills format — a folder carrying its own \`SKILL.md\` plus supporting files, here a
\`scripts/create-repo.sh\` stub. Edit or delete any of it; it's a starting point, not a fixture.

## Getting started

\`\`\`sh
cp .env.example .env  # fill in real values — .env itself is gitignored, never committed
levare validate .     # confirms every definition here is on-contract
levare serve .        # the board — studio / project / run / registry screens, at the printed URL
levare doctor .       # connector env-presence + CLI/MCP reachability report
\`\`\`

\`.env.example\` names what this studio might need — the Orchestrator's \`ANTHROPIC_API_KEY\` is
optional (the board, registry, and every gate work without it); connector variables are scoped to
whichever team/agent explicitly grants that connector, even once set.

Open a work unit by creating \`work/<project>/<unit>/unit.md\` (see \`types/\` for what each unit
type expects and which artifacts its flow gates on), or capture a pitch as a new file under
\`ideas/\`.

## Git

${GIT_IDENTITY_NOTE}
`;

const DEVCONTAINER = `{
  "name": "levare-studio",
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu",
  "customizations": {
    "vscode": { "extensions": ["anthropic.claude-code"] }
  },
  "postCreateCommand": "curl -fsSL https://bun.sh/install | bash && sudo ln -sf $HOME/.bun/bin/bun /usr/local/bin/bun && curl -fsSL https://claude.ai/install.sh | bash && sudo ln -sf $HOME/.local/bin/claude /usr/local/bin/claude"
}
`;

const TEAM_KESTREL = `---
name: kestrel
consumes: [pitch, product-brief]
produces: [product-brief, design, spec]
members: [wren, lyra, finch]
flow:
  - step: brief
  - gate: human
  - step: design
  - gate: human
  - loop:
      between: [spec, review]
      until: spec.approved
      max_rounds: 3
      on_exhaust: gate
style:
  color: "#2E6FB0"
guardrails:
  protected_branches: [main]
  protected_paths: [deploy/]
  never: [force-push, delete-branch]
knowledge: [house-style]
---

# Kestrel — the product-shaping team

Kestrel takes a pitch to an approved specification. Wren frames the product brief,
Lyra designs the flow and drafts the spec, Finch reviews against the house style.
The team never touches a project's main branch; code lands only through a downstream
review loop and a merge gate.
`;

const AGENT_WREN = `---
name: wren
kind: native
produces: [product-brief]
model: claude-sonnet-5
skills: [product-brief]
tools: [Read, Write]
knowledge: [house-style]
style:
  avatar: Wr
---

You are Wren, a product framer. Turn a captured pitch into a crisp product brief:
the problem, the target user, the one job to be done, and the success signal.
Write in the calm, factual register of the studio. Produce a single \`brief\` artifact.
`;

const AGENT_LYRA = `---
name: lyra
kind: native
produces: [design, spec]
model: claude-sonnet-5
skills: [flow-design, spec-writing]
tools: [Read, Write]
knowledge: [house-style]
style:
  avatar: Ly
---

You are Lyra, a flow designer and spec author. Given a product brief, design the user
flow and draft an implementation spec precise enough for a build team to execute
without further questions. If a decision is genuinely ambiguous, exit blocked with the
question in the body; never guess laterally. Produce \`design\` then \`spec\` artifacts.
`;

const AGENT_FINCH = `---
name: finch
kind: cli
produces: [review]
command: [codex, review, --input, "{task}", --repo, "{feature_repo}"]
cwd: "{feature_repo}"
timeout: 600
result: "Emits review commentary as plain text on stdout — content only, never frontmatter of its own; levare authors the artifact wrapper (id, status, consumes, usage) around that content and validates the whole document against the artifact contract before recording it (ruling C12)."
style:
  avatar: Fi
---

# Finch — wrapped Codex reviewer

Finch is a foreign CLI (Codex) wrapped as a member. The Runner spawns the \`command\`
template with \`{task}\` substituted, enforces the timeout, and validates that the raw
output conforms to the artifact contract at the boundary — the contract is never
trusted from the member.
`;

const SKILL_FLOW_DESIGN = `---
name: flow-design
description: "Design a user flow: enumerate states and transitions, name the one happy path, and mark every branch that hides a product decision."
---

# flow-design skill

Map the flow as an ordered list of states. Name the single happy path first, then each
branch off it. Where a branch conceals a product decision, surface it as an open
question — never resolve it silently. A good flow reads top to bottom with no forward
references.
`;

const SKILL_SPEC_WRITING = `---
name: spec-writing
description: "Turn an approved design into a build-ready spec: routes, data shapes, and the acceptance checks a reviewer will run."
---

# spec-writing skill

State the routes, the data each step writes, and the invariant it preserves. Every claim
a reviewer must check gets its own line. Precision beats prose: if a build team could ask
a question, the spec still has a gap.
`;

// Agent Skills format: a folder carrying its own SKILL.md plus supporting files (here a script),
// rather than the flat `skills/<name>.md` convention the other two skills above use.
const SKILL_NEW_PROJECT = `---
name: new-project
description: "Stand up a new project — create the repo, clone, write the pointer, capture deploy target and house rules, commit."
scripts: [scripts/create-repo.sh]
---

# new-project skill

Run by the Orchestrator to promote an idea into a project (§7): create the remote repo,
clone it locally, write the \`projects/<name>.md\` pointer, ask for the deploy target and
house rules, commit. \`scripts/create-repo.sh\` is the remote-creation half of that recipe —
swap it for whatever your host (GitHub, GitLab, a bare internal remote) actually needs.
`;

const SCRIPT_CREATE_REPO = `#!/usr/bin/env bash
# Stand up a new project's remote repository. Called by the new-project skill with the
# project name as $1; expected to print the resulting clone URL on stdout.
#
# Replace this stub with whatever your host needs, e.g.:
#   gh repo create "acme/$1" --private --clone=false
set -euo pipefail
echo "create-repo.sh is a stub — wire it to your git host before using the new-project skill." >&2
exit 1
`;

const TYPE_INCEPTION = `---
name: inception
glyph: "◈"
expects: [pitch, product-brief, charter]
gates: [charter]
output: charter
---

# Inception

Stands up a new project: the founding brief and charter that every later unit cites.
`;

const TYPE_FEATURE = `---
name: feature
glyph: "▸"
expects: [product-brief, design, spec, code, review]
gates: [brief, design, spec, merge]
output: code
---

# Feature

A full product increment: pitch shaped into a brief, a design, a spec, then built and
reviewed into the project's main branch through a merge gate. The longest score of the
five types.
`;

const TYPE_FIX = `---
name: fix
glyph: "◦"
expects: [report, code, review]
gates: [merge]
output: code
---

# Fix

A small correction: a defect report, a change, a review, a merge gate. A short score.
`;

const TYPE_SPIKE = `---
name: spike
glyph: "∻"
expects: [question, findings]
gates: [findings]
output: findings
timebox: 1d
---

# Spike

A disposable investigation. Its code never ships; its output is \`findings\`. The glyph
reads as ephemeral. Timebox is Runner-enforced. Promotion means a new feature unit that
consumes the findings — the spike itself never merges.
`;

const TYPE_RESEARCH = `---
name: research
glyph: "▤"
expects: [question, report]
gates: [report]
output: report
promotable_to: knowledge
---

# Research

A reading-and-synthesis unit. Its terminal artifact is a \`report\`, promotable to
\`knowledge/\` through a gate. The glyph reads as document-ish.
`;

const CONNECTOR_GITHUB = `---
name: github
kind: cli
command: gh
env: [GITHUB_TOKEN]
scope: "Granted to teams that open PRs and manage releases. Values come from the environment; never stored in the repo."
role: tool
---

# GitHub connector

Wraps the \`gh\` CLI. The Runner injects \`GITHUB_TOKEN\` only into members whose team or
agent grants this connector. \`role: tool\` — GitHub grants a service capability, not model
access (NOTES C15).
`;

const CONNECTOR_LINEAR = `---
name: linear
kind: mcp
server: linear-mcp
env: [LINEAR_API_KEY]
scope: "Read-only issue context for planning members."
role: tool
---

# Linear connector

An MCP server exposing Linear issues. Required env var name is declared; its value comes
from the environment at run time. \`role: tool\` — Linear grants a service capability, not
model access (NOTES C15).
`;

// NOTES C15: the canonical `role: model` example — the same Codex CLI finch wraps directly
// (agents/finch.md) authenticates itself from its own stored session (\`codex login\`) rather than an
// env var levare could inject (NOTES C13). Declared here, unwired to any agent, purely to model the
// shape a studio should declare when it grants model access through a connector: \`auth: subscription\`
// (the credential lives outside levare's scoping) plus \`role: model\` (what it's FOR). NOTES CAP-B:
// \`home: [".codex"]\` is the canonical scoping declaration this connector's own doctor/card warning
// asks for — a granted member's spawned process gets a scratch HOME symlinking only \`~/.codex\`, not
// the operator's entire real HOME (env.ts#scopeHome); the residual (any OTHER member granted THIS
// connector can still use the live login) stays true and stays named, in the body below.
const CONNECTOR_CODEX = `---
name: codex
kind: cli
command: codex
env: []
auth: subscription
role: model
plan: "ChatGPT Plus — flat monthly rate"
scope: "Model access for Codex-backed members. levare scopes this credential to ~/.codex via home: — see auth: subscription (NOTES C13/CAP-B)."
home: [".codex"]
---

# Codex connector

Models the \`role: model\` + \`auth: subscription\` shape: \`codex login\` writes a session to
\`~/.codex\`. \`home: [".codex"]\` scopes a granted member's spawned process to a scratch HOME
symlinking only that path — real \`~/.ssh\`, \`~/.aws\`, and everything else stays invisible to it. The
login itself remains usable by any OTHER member granted this same connector; only the real
\`codex login\` revokes it. Declaring \`home:\` is what turns "documentation of intent" into an actual
filesystem boundary — see doctor's own warning when it's left absent.
`;

const KNOWLEDGE_HOUSE_STYLE = `---
name: house-style
tags: [voice, reference]
---

# House style

Calm, factual, slightly dry. Never celebrate, apologize, or persuade. Filesystem truth
renders in mono; judgment renders in prose. Injected into member context when referenced.
`;

const KNOWLEDGE_MODEL_PRICING = `---
name: model-pricing
tags: [cost, reference]
---

# Model pricing

USD-per-million-token estimates used to price usage receipts (§10). Subscription-plan
members price at 0 with the plan noted; unpriceable receipts record \`usd: null\`.

This table is also the KNOWN-MODEL set (NOTES F11): \`levare validate\` rejects any agent or
studio declaration naming a model not listed here (\`UNKNOWN_MODEL\`) — an unpriceable model
means silently wrong cost accounting, so a model that cannot be priced cannot be declared.

| model             | tokens_in (/M) | tokens_out (/M) |
| ----------------- | --------------- | --------------- |
| claude-opus-4-8   | 5.00            | 25.00           |
| claude-sonnet-5   | 3.00            | 15.00           |
| claude-haiku-4-5  | 1.00            | 5.00            |
| claude-sonnet-4-5 | 3.00            | 15.00           |
| claude-opus-4-1   | 15.00           | 75.00           |
`;

// The studio-level settings file (NOTES F11): a root singleton, distinct from \`projects/studio.md\`
// (a Project pointer). \`orchestrator_model\` is the registry field the Orchestrator's model resolves
// from — \`LEVARE_ORCHESTRATOR_MODEL\` still overrides it at runtime, but this file is the source of
// truth, validated against \`knowledge/model-pricing.md\`'s known-model set exactly like an agent's own
// \`model:\` field. Optional: an absent file (or absent field) falls back to the built-in cheap default.
const STUDIO_SETTINGS = `---
orchestrator_model: claude-sonnet-5
---

# Studio settings

Declarations that apply to the whole studio, not any one project. \`orchestrator_model\`
names the model the Orchestrator (§7) uses for chat, intent classification, and
briefings — edit it here rather than exporting \`LEVARE_ORCHESTRATOR_MODEL\`, which stays
available as a runtime override but is no longer the source of truth.
`;

const PROJECT_STUDIO = `---
name: studio
repo: .
remote: null
default_branch: main
deploy: null
pace: auto  # auto runs each team unattended; \`step\` pauses for the Conductor's nod before every team run
---

# Studio

Points at this studio repo itself, giving non-product work — research units, the field
guide, registry care — a home. Paced \`auto\`: teams run unattended. Switch to \`step\` if
you'd rather nod the Conductor through each team run individually before it fires.
`;

const GITIGNORE = `.DS_Store
node_modules/
.env
`;

// NOTES F23: a fresh studio scaffolds `.env.example` — never a live `.env` (that's a loaded gun: a
// real secret in a freshly-`init`'d, about-to-be-pushed repo). Copy it to `.env` yourself and fill in
// real values; `.env` is already in `.gitignore` above, so it never gets committed by accident.
// `levare serve`/`levare doctor` load `<studio-root>/.env` (dotenv.ts#applyStudioEnv) into the process
// environment on startup — same effect as exporting these in your shell, scoped to this studio only.
const ENV_EXAMPLE = `# levare studio environment — copy this file to \`.env\` and fill in real values.
# \`.env\` is already listed in .gitignore; it is never committed. Never fill in real secrets HERE,
# in .env.example — this file is meant to be committed, as a checklist of what a value needs.

# The Orchestrator (PRD §7) — the chat surface that opens every board session with a briefing,
# interprets intent, and converses grounded in the repo. OPTIONAL: absent, the board, the registry,
# and every gate still work exactly the same — approvals, rejections, and the daemon's own walk are
# never gated on this. Absent, the Orchestrator panel simply renders disabled until you set it.
ANTHROPIC_API_KEY=

# Optional: overrides the model the Orchestrator itself uses (chat, intent classification,
# briefings) — the source of truth is studio.md's own \`orchestrator_model:\` field; set this only to
# override that per-environment (e.g. a cheaper model in CI) without editing the studio definition.
# LEVARE_ORCHESTRATOR_MODEL=

# Connector-granted variables (connectors/*.md) — declared here by NAME only, values here. A
# connector's env vars are scoped (invariant 11): even set here, a member's spawned process sees one
# ONLY when its own team or agent definition explicitly grants that connector — setting a value here
# never hands it to every member automatically.
GITHUB_TOKEN=
LINEAR_API_KEY=
`;

const FILES: Template[] = [
  { path: "README.md", content: README },
  { path: "studio.md", content: STUDIO_SETTINGS },
  { path: ".gitignore", content: GITIGNORE },
  { path: ".env.example", content: ENV_EXAMPLE },
  { path: ".devcontainer/devcontainer.json", content: DEVCONTAINER },
  { path: "teams/kestrel.md", content: TEAM_KESTREL },
  { path: "agents/wren.md", content: AGENT_WREN },
  { path: "agents/lyra.md", content: AGENT_LYRA },
  { path: "agents/finch.md", content: AGENT_FINCH },
  { path: "skills/flow-design.md", content: SKILL_FLOW_DESIGN },
  { path: "skills/spec-writing.md", content: SKILL_SPEC_WRITING },
  { path: "skills/new-project/SKILL.md", content: SKILL_NEW_PROJECT },
  { path: "skills/new-project/scripts/create-repo.sh", content: SCRIPT_CREATE_REPO },
  { path: "types/inception.md", content: TYPE_INCEPTION },
  { path: "types/feature.md", content: TYPE_FEATURE },
  { path: "types/fix.md", content: TYPE_FIX },
  { path: "types/spike.md", content: TYPE_SPIKE },
  { path: "types/research.md", content: TYPE_RESEARCH },
  { path: "connectors/github.md", content: CONNECTOR_GITHUB },
  { path: "connectors/linear.md", content: CONNECTOR_LINEAR },
  { path: "connectors/codex.md", content: CONNECTOR_CODEX },
  { path: "knowledge/house-style.md", content: KNOWLEDGE_HOUSE_STYLE },
  { path: "knowledge/model-pricing.md", content: KNOWLEDGE_MODEL_PRICING },
  { path: "projects/studio.md", content: PROJECT_STUDIO },
];

/**
 * Scaffold `target` into a working levare studio. Never overwrites: an existing file at a template's
 * path is left untouched and recorded in `skipped`, so re-running `init` against a partially-edited
 * studio can never clobber in-progress work.
 */
export function scaffoldStudio(target: string): ScaffoldResult {
  const created: string[] = [];
  const skipped: string[] = [];

  for (const dir of EMPTY_DIRS) {
    const full = join(target, dir);
    if (!existsSync(full)) {
      mkdirSync(full, { recursive: true });
      created.push(`${dir}/`);
    }
  }

  for (const f of FILES) {
    const full = join(target, f.path);
    if (existsSync(full)) {
      skipped.push(f.path);
      continue;
    }
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, f.content);
    created.push(f.path);
  }

  return { created, skipped };
}

/**
 * `levare init`'s full behavior: scaffold the studio, then `git init` it and make the founding
 * commit — using the user's own resolved git identity, not the Conductor's (that identity is for
 * later Conductor actions; this commit predates all of them). Without this, a scaffolded studio
 * would ship with its own guarantees off by default: `validate.ts`'s approved-artifact immutability
 * check fail-opens with no git history to check against, and every commit-as-Conductor write path
 * has nothing to commit onto. `env` is injectable so tests can pin a git identity (or its absence)
 * hermetically rather than depending on the host running the suite (see `makeFoundingCommit`).
 */
export function initStudio(target: string, env?: NodeJS.ProcessEnv): InitResult {
  const scaffold = scaffoldStudio(target);
  const git = makeFoundingCommit(target, "levare init", env);
  return { scaffold, git };
}

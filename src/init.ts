// `levare init` (phase 6, PRD §3/§11): scaffold an empty directory into a working studio — the
// skeleton (teams/ agents/ skills/ knowledge/ types/ connectors/ projects/ work/ ideas/), the five
// type templates, one example team with its agents, a sample skill, a .devcontainer/, and a starter
// README. Templates are embedded as literal strings (not read from fixtures/golden/ at runtime) so
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

export interface ScaffoldResult {
  /** Paths written (files) or created (directories, suffixed "/"), relative to the target. */
  created: string[];
  /** Files that already existed and were left untouched — `init` never overwrites. */
  skipped: string[];
}

interface Template {
  path: string;
  content: string;
}

// Directories that must exist even though the fresh studio has no files in them yet.
const EMPTY_DIRS = ["work", "ideas"];

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
levare validate .     # confirms every definition here is on-contract
levare serve .        # the board — studio / project / run / registry screens, at the printed URL
levare doctor .       # connector env-presence + CLI/MCP reachability report
\`\`\`

Open a work unit by creating \`work/<project>/<unit>/unit.md\` (see \`types/\` for what each unit
type expects and which artifacts its flow gates on), or capture a pitch as a new file under
\`ideas/\`. This directory isn't yet a git repository — run \`git init\` if you want the audit-log
history (and the approved-artifact immutability check) that a real studio relies on.
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
mode: declarative
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
model: claude-sonnet
skills: [product-brief]
tools: [read, write]
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
model: claude-sonnet
skills: [flow-design, spec-writing]
tools: [read, write]
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
command: [codex, review, --input, "{task}", --repo, "{feature_repo}"]
cwd: "{feature_repo}"
timeout: 600
result: "Emits a \`review\` artifact markdown file to stdout; the wrapper validates its frontmatter against the artifact contract before recording it."
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
---

# GitHub connector

Wraps the \`gh\` CLI. The Runner injects \`GITHUB_TOKEN\` only into members whose team or
agent grants this connector.
`;

const CONNECTOR_LINEAR = `---
name: linear
kind: mcp
server: linear-mcp
env: [LINEAR_API_KEY]
scope: "Read-only issue context for planning members."
---

# Linear connector

An MCP server exposing Linear issues. Required env var name is declared; its value comes
from the environment at run time.
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

| model          | tokens_in (/M) | tokens_out (/M) |
| -------------- | -------------- | --------------- |
| claude-sonnet  | 3.00           | 15.00           |
| claude-opus    | 15.00          | 75.00           |
`;

const PROJECT_STUDIO = `---
name: studio
repo: .
remote: null
default_branch: main
deploy: null
pace: step
---

# Studio

Points at this studio repo itself, giving non-product work — research units, the field
guide, registry care — a home. Paced \`step\`: the Conductor nods before each team runs.
`;

const FILES: Template[] = [
  { path: "README.md", content: README },
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

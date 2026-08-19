import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { assertSpawnOk } from "./spawn-helpers.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advanceUnit } from "../src/dagwalk.ts";
import { resolveGate } from "../src/board/gateops.ts";
import { loadRepo } from "../src/repo.ts";
import type { AsyncMemberRunner } from "../src/dagwalk.ts";
import type { Verb } from "../src/runner.ts";

// NOTES DISPATCH-TRACE (native-dispatch-hang investigation, 2026-08-19): Phase 2's own goal flagged
// `consumes: []` on every blocked artifact as a SEPARATE defect from the timeout/stdout-discard one —
// established by reading dagwalk.ts#writeBlocked/board/gateops.ts#blockedRetryDoc: both hardcoded the
// literal string regardless of what the dispatch actually had available, because the failure path never
// threaded the unit's own approved-artifact set through to either doc template. Both call sites now
// compute the SAME consumed-artifact set `AdapterRunner#author` computes for a successful artifact
// (adapters.ts:1436) — this file proves it lands on disk for both the live-walk failure path
// (dagwalk.ts) and the Conductor-triggered retry-fails-again path (board/gateops.ts).
//
// A minimal, purpose-built studio (not the golden fixture): the golden fixture's own `checkout-flow`
// unit binds `spec`/`review` through a LOOP, where forcing `spec` to `approved` short-circuits the
// loop's own `until` condition rather than reaching a plain downstream step — the wrong shape to prove
// this fix against. A plain two-step flow (brief → code, no loop) isolates the one thing under test:
// does a blocked artifact's `consumes:` reflect the unit's real approved set.

const HERMETIC_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" };

function git(root: string, args: string[]) {
  const r = spawnSync(
    "git",
    ["-C", root, "-c", "user.name=seed", "-c", "user.email=seed@levare.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "init.defaultBranch=main", ...args],
    { encoding: "utf8", env: HERMETIC_ENV },
  );
  assertSpawnOk(`git ${args.join(" ")}`, r);
  return r;
}

// `name:` must be one of validate.ts's fixed work-unit-type enum (inception/feature/fix/spike/
// research) — "fix" is reused here purely for its enum membership; `expects`/`gates`/`output` below
// are this test's own free-form kind vocabulary, unrelated to what a real "fix" unit would declare.
const TYPE_TASK = `---
name: fix
glyph: "▸"
expects: [brief, code]
gates: [brief]
output: code
---

# Task
`;

const PROJECT_ACME = `---
name: acme
repo: .
remote: null
default_branch: main
deploy: null
pace: auto
---

# Acme
`;

const TEAM_FORGE = `---
name: forge
consumes: []
produces: [brief, code]
members: [scribe, coder]
flow:
  - step: brief
  - gate: human
  - step: code
style:
  color: "#4B2E83"
---

# Forge — plain two-step flow, blocked-consumes regression
`;

const AGENT_SCRIBE = `---
name: scribe
kind: native
produces: [brief]
model: claude-sonnet-5
style:
  avatar: Sc
---

# Scribe

Drafts the brief.
`;

const AGENT_CODER = `---
name: coder
kind: native
produces: [code]
model: claude-sonnet-5
style:
  avatar: Co
---

# Coder

Writes the code.
`;

const UNIT_WIDGET = `---
type: fix
status: active
project: acme
unit: widget
---

# Widget
`;

const APPROVED_BRIEF = `---
kind: brief
id: brief-widget-v1
unit: widget
project: acme
status: approved
produced_by: forge/scribe
consumes: []
supersedes: null
approved_by: "cas 2026-08-19"
created: 2026-08-19T00:00:00.000Z
files: []
usage:
  model: claude-sonnet-5
  tokens_in: 100
---

# brief

Already-approved brief, seeded directly on disk.
`;

function seedForgeStudio(): string {
  const root = mkdtempSync(join(tmpdir(), "levare-blocked-consumes-"));
  mkdirSync(join(root, "types"), { recursive: true });
  mkdirSync(join(root, "projects"), { recursive: true });
  mkdirSync(join(root, "teams"), { recursive: true });
  mkdirSync(join(root, "agents"), { recursive: true });
  mkdirSync(join(root, "work/acme/widget"), { recursive: true });
  writeFileSync(join(root, "types/fix.md"), TYPE_TASK);
  writeFileSync(join(root, "projects/acme.md"), PROJECT_ACME);
  writeFileSync(join(root, "teams/forge.md"), TEAM_FORGE);
  writeFileSync(join(root, "agents/scribe.md"), AGENT_SCRIBE);
  writeFileSync(join(root, "agents/coder.md"), AGENT_CODER);
  writeFileSync(join(root, "work/acme/widget/unit.md"), UNIT_WIDGET);
  writeFileSync(join(root, "work/acme/widget/brief-widget-v1.md"), APPROVED_BRIEF);
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "seed forge studio with brief approved"]);
  return root;
}

// NOTES: `advanceUnit` resolves EVERY flow step's binding (including the already-satisfied `brief`
// step) against the injected runner's own `capabilities()`, not `repo.agents` — declaring only
// `coder:code` here made even the ALREADY-APPROVED `brief` step read as unbindable (confirmed by
// direct reproduction: the walk's step resolution isn't gated on "is this step already satisfied"
// before checking who COULD produce it). `scribe:brief` is declared for that reason alone — its
// `produce()` is never actually invoked, since `brief-widget-v1.md` is already approved on disk.
const throwingCoder: AsyncMemberRunner = {
  capabilities: () => [
    { member: "scribe", kind: "brief" },
    { member: "coder", kind: "code" },
  ],
  produce: () => {
    throw new Error("simulated dispatch failure");
  },
};

describe("a blocked artifact records the unit's real approved consumed set, not a hardcoded []", () => {
  test("dagwalk.ts#writeBlocked (the live-walk failure path)", async () => {
    const root = seedForgeStudio();
    try {
      const repo = loadRepo(root);
      const unit = repo.units.find((u) => u.unit === "widget")!;
      const result = await advanceUnit(root, repo, unit, throwingCoder, { startAuthorized: true, today: "2026-08-19" });
      expect(result.outcome).toBe("blocked");
      if (result.outcome !== "blocked") return;

      const blockedDoc = readFileSync(join(root, "work/acme/widget", `${result.artifactId}.md`), "utf8");
      expect(blockedDoc).toContain("consumes: [brief-widget-v1]");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("board/gateops.ts#blockedRetryDoc (a Conductor-triggered retry that fails again)", async () => {
    const root = seedForgeStudio();
    try {
      const repo = loadRepo(root);
      const unit = repo.units.find((u) => u.unit === "widget")!;
      const first = await advanceUnit(root, repo, unit, throwingCoder, { startAuthorized: true, today: "2026-08-19" });
      expect(first.outcome).toBe("blocked");
      if (first.outcome !== "blocked") return;

      const retryResult = await resolveGate(root, "acme", first.artifactId, "retry" as Verb, { memberRunner: throwingCoder, today: "2026-08-19" });
      expect(retryResult.ok).toBe(false); // retried and failed again, per resolveBlockedArtifactGate's own contract

      const blockedDoc = readFileSync(join(root, "work/acme/widget", `${first.artifactId}.md`), "utf8");
      expect(blockedDoc).toContain("consumes: [brief-widget-v1]");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

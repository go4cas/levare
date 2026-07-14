import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advanceUnit } from "../src/dagwalk.ts";
import { loadRepo } from "../src/repo.ts";
import { openGates } from "../src/board/derive.ts";
import { renderStudio } from "../src/board/render.ts";
import { buildBriefing } from "../src/orchestrator.ts";
import { stubAdapterRunner } from "../src/replay.ts";
import type { CliProbe, EnvProbe } from "../src/doctor.ts";

const env: EnvProbe = { has: () => false };
const noGh: CliProbe = () => "not-found";

// NOTES F18: a unit whose type `expects` a kind that literally no team in the studio produces at all
// (never even attempted in any team's `flow:`, so `validate.ts#validateStudioBindings` — which only
// inspects declared flow steps — has nothing to catch) sat `active` forever, silently. This is
// DIFFERENT from the pre-existing F1 `unbindable` case (a step within a RESPONSIBLE team's own flow
// that binds to no member): here `gates.ts#responsibleTeamsFor` never finds a responsible team at
// all, and `dagwalk.ts#advanceUnit` short-circuited to a bare `{ outcome: "nothing" }` — indistinguishable
// on the board and in the Orchestrator's briefing from "this unit just isn't due for anything yet".
// Hit three separate times in live use.

const HERMETIC_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" };

function git(root: string, args: string[]) {
  const r = spawnSync(
    "git",
    ["-C", root, "-c", "user.name=seed", "-c", "user.email=seed@levare.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "init.defaultBranch=main", ...args],
    { encoding: "utf8", env: HERMETIC_ENV },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}${r.stdout}`);
  return r;
}

const TYPE_RESEARCH = `---
name: research
glyph: "▤"
expects: [design]
gates: [design]
output: design
---

# Research

Scratch type for the F18 test: it expects \`design\`, but this studio's only team never
produces it at all — not even attempted in any team's flow.
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

// \`core\` produces \`note\`, never \`design\` — and its flow never even references \`design\` as a
// step, so validateStudioBindings' own UNBINDABLE_STEP/AMBIGUOUS_STEP checks (which only look at
// declared flow steps) have nothing to see. This studio validates cleanly.
const TEAM_CORE = `---
name: core
consumes: []
produces: [note]
members: [scout]
flow:
  - step: note
style:
  color: "#333333"
---

# Core

Produces notes. Nothing in this studio produces \`design\`.
`;

const AGENT_SCOUT = `---
name: scout
kind: native
produces: [note]
model: claude-sonnet-5
style:
  avatar: Sc
---

# Scout

Produces a note.
`;

const UNIT_WIDGET = `---
type: research
status: active
project: acme
unit: widget
---

# Widget

A research unit whose type needs \`design\`, which no team in this studio produces.
`;

function seedStudio(): string {
  const root = mkdtempSync(join(tmpdir(), "levare-f18-"));
  mkdirSync(join(root, "types"), { recursive: true });
  mkdirSync(join(root, "projects"), { recursive: true });
  mkdirSync(join(root, "teams"), { recursive: true });
  mkdirSync(join(root, "agents"), { recursive: true });
  mkdirSync(join(root, "work/acme/widget"), { recursive: true });
  writeFileSync(join(root, "types/research.md"), TYPE_RESEARCH);
  writeFileSync(join(root, "projects/acme.md"), PROJECT_ACME);
  writeFileSync(join(root, "teams/core.md"), TEAM_CORE);
  writeFileSync(join(root, "agents/scout.md"), AGENT_SCOUT);
  writeFileSync(join(root, "work/acme/widget/unit.md"), UNIT_WIDGET);
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "seed f18 studio"]);
  return root;
}

describe("F18: a unit no team in the studio can ever advance blocks loudly, naming what it needs", () => {
  test("the studio itself validates clean — this is a runtime gap, not a studio definition error", () => {
    // Throws if validation fails (loadRepo's default `validate: true`).
    expect(() => loadRepo(seedStudio())).not.toThrow();
  });

  test("advanceUnit blocks the unit, naming the missing kind and that no team produces it", async () => {
    const root = seedStudio();
    const repo = loadRepo(root);
    const unit = repo.units.find((u) => u.unit === "widget")!;
    const runner = stubAdapterRunner(repo);

    const result = await advanceUnit(root, repo, unit, runner, { startAuthorized: true });
    expect(result.outcome).toBe("unbindable");
    if (result.outcome !== "unbindable") throw new Error("unreachable");
    expect(result.reason).toContain("research needs `design`");
    expect(result.reason).toContain("no team in this studio produces it");
    expect(result.stepLabel).toBe("design");

    const unitMd = readFileSync(join(root, "work/acme/widget/unit.md"), "utf8");
    expect(unitMd).toContain("status: blocked");
    expect(unitMd).toContain("no team in this studio produces it");
    expect(git(root, ["log", "-1", "--pretty=%s"]).stdout).toContain("block widget");

    // Nothing was produced — there was nothing to bind.
    const after = loadRepo(root, { validate: false });
    expect(after.artifacts.get("acme/widget")?.size ?? 0).toBe(0);
  });

  test("the block surfaces as a gate on the board, and the board renders it", async () => {
    const root = seedStudio();
    const repo = loadRepo(root);
    const unit = repo.units.find((u) => u.unit === "widget")!;
    await advanceUnit(root, repo, unit, stubAdapterRunner(repo), { startAuthorized: true });

    const after = loadRepo(root, { validate: false });
    const gate = openGates(after).find((g) => g.type === "blocked" && g.unit === "widget");
    expect(gate).toBeDefined();
    expect(gate!.reason).toContain("no team in this studio produces it");

    const html = renderStudio(after, root, new Date("2026-07-14T00:00:00Z"), []);
    expect(html).toContain("gate--blocked");
    expect(html).toContain("no team in this studio produces it");
  });

  test("the Orchestrator's briefing surfaces the block too — it no longer says 'Nothing needs you right now'", async () => {
    const root = seedStudio();
    const repo = loadRepo(root);
    const unit = repo.units.find((u) => u.unit === "widget")!;
    await advanceUnit(root, repo, unit, stubAdapterRunner(repo), { startAuthorized: true });

    const after = loadRepo(root, { validate: false });
    const briefing = buildBriefing(after, env, noGh);
    expect(briefing.blocked.map((g) => g.unit)).toEqual(["widget"]);
    expect(briefing.text).not.toContain("Nothing needs you right now");
    expect(briefing.text).toContain("widget");
    expect(briefing.text).toContain("no team in this studio produces it");
  });
});

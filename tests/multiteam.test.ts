import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRepo } from "../src/repo.ts";
import { advanceUnit, nextAction } from "../src/dagwalk.ts";
import { responsibleTeamsFor, responsibleTeamFor } from "../src/gates.ts";
import type { MemberRunner } from "../src/runner.ts";

// Ruling C4: the walk is per-KIND, not per-unit. PRD §6 — "find producible kinds ... and invoke the
// team that produces each" — is how a unit hands from a shaping team to a build team. The old B7
// shortcut selected ONE team per unit (max produces∩expects, ties by name); a `feature` unit whose
// `code` is produced by a separate build team would have that build team ignored (kestrel scores 3,
// forge scores 1 → kestrel wins → forge's `code` never produced), leaving the unit permanently stalled
// at "active" with an unproduced kind. This is the multi-team fixture that would have caught that
// divergence: it FAILS against the old single-team walk (advanceUnit returns "nothing"; no `code`) and
// PASSES against the per-kind walk (forge produces `code` after kestrel's shaping is approved).

const HERMETIC_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
function git(root: string, args: string[]) {
  const r = spawnSync(
    "git",
    ["-C", root, "-c", "user.name=seed", "-c", "user.email=seed@levare.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "init.defaultBranch=main", ...args],
    { encoding: "utf8", env: HERMETIC_ENV },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}${r.stdout}`);
}

const FORGE_TEAM = `---
name: forge
consumes: [spec]
produces: [code]
members: [smith]
flow:
  - step: code
  - gate: human
style:
  color: "#8A8F98"
---

# Forge — the build team

Forge builds an approved spec into code. It is a DIFFERENT team from kestrel (the shaping team):
kestrel produces the brief/design/spec; forge produces the code. This is exactly the shaping→build
handoff ruling C4 is about — one unit, two teams, different kinds.
`;

const SMITH_AGENT = `---
name: smith
kind: cli
produces: [code]
command: ["stub-build", "{task}"]
result: "produces a code artifact"
style:
  avatar: "sm"
---

# Smith

Builds an approved spec into code.
`;

function approvedArtifact(kind: string, id: string, producedBy: string): string {
  return `---
kind: ${kind}
id: ${id}
unit: build-me
project: storefront
status: approved
produced_by: ${producedBy}
consumes: []
supersedes: null
approved_by: "cas 2026-07-11"
created: 2026-07-11
files: []
---

Approved ${kind} for the multi-team handoff fixture.
`;
}

// A member runner covering BOTH teams' members: kestrel's shaping members (so nextAction can resolve
// kestrel's already-satisfied flow steps) and forge's build member (so the walk can produce `code`).
// The produced `code` doc is attributed to forge/smith — the whole point of the assertion below.
function multiTeamRunner(): MemberRunner {
  const caps = [
    { member: "wren", kind: "product-brief" },
    { member: "lyra", kind: "design" },
    { member: "lyra", kind: "spec" },
    { member: "finch", kind: "review" },
    { member: "smith", kind: "code" },
  ];
  return {
    capabilities: () => caps,
    produce: (member, kind) => ({
      doc: `---
kind: ${kind}
id: ${kind}-build-me-vX
unit: build-me
project: storefront
status: in-review
produced_by: forge/${member}
consumes: []
supersedes: null
approved_by: null
created: 2026-07-11
files: []
---

Built ${kind}.
`,
    }),
  };
}

function seedMultiTeamRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "levare-multiteam-"));
  cpSync("fixtures/golden", root, { recursive: true }); // kestrel, lyra/wren/finch, feature type, storefront project
  writeFileSync(join(root, "teams", "forge.md"), FORGE_TEAM);
  writeFileSync(join(root, "agents", "smith.md"), SMITH_AGENT);

  // A feature unit whose shaping (brief/design/spec) is already APPROVED, so the shaping team's flow
  // is satisfied and the only remaining producible kind is `code` — owned by the build team.
  const unitDir = join(root, "work", "storefront", "build-me");
  mkdirSync(unitDir, { recursive: true });
  writeFileSync(join(unitDir, "unit.md"), `---\ntype: feature\nstatus: active\n---\n\n# build-me\n`);
  writeFileSync(join(unitDir, "product-brief-build-me-v1.md"), approvedArtifact("product-brief", "product-brief-build-me-v1", "kestrel/wren"));
  writeFileSync(join(unitDir, "design-build-me-v1.md"), approvedArtifact("design", "design-build-me-v1", "kestrel/lyra"));
  writeFileSync(join(unitDir, "spec-build-me-v1.md"), approvedArtifact("spec", "spec-build-me-v1", "kestrel/lyra"));

  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "seed multi-team fixture"]);
  return root;
}

describe("[ruling C4] a unit hands from a shaping team to a build team (per-kind walk)", () => {
  let root: string;
  beforeEach(() => {
    root = seedMultiTeamRepo();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("responsibleTeamsFor returns both teams in dependency order (shaping before build)", () => {
    const repo = loadRepo(root);
    const unit = repo.units.find((u) => u.unit === "build-me")!;
    expect(responsibleTeamsFor(repo, unit).map((t) => t.name)).toEqual(["kestrel", "forge"]);
    // The old per-unit head still names kestrel — proving the divergence is in the WALK, not the head:
    // a walk bound to the single responsible team would only ever run kestrel.
    expect(responsibleTeamFor(repo, unit)!.name).toBe("kestrel");
  });

  test("the single-team walk (kestrel alone) produces NOTHING — the divergence the old heuristic hid", () => {
    const repo = loadRepo(root);
    const unit = repo.units.find((u) => u.unit === "build-me")!;
    const kestrel = repo.teams.get("kestrel")!;
    // With brief/design/spec approved, kestrel's flow is fully satisfied — a walk that only ever
    // considered kestrel (the old responsibleTeamFor) would produce nothing and leave `code` unbuilt.
    expect(nextAction(repo, unit, kestrel, multiTeamRunner().capabilities()).type).toBe("nothing");
  });

  test("the per-kind walk hands off: the build team produces `code` on disk, authored as forge", async () => {
    const repo = loadRepo(root);
    const unit = repo.units.find((u) => u.unit === "build-me")!;
    const result = await advanceUnit(root, repo, unit, multiTeamRunner(), { startAuthorized: true, today: "2026-07-11" });

    // Under the OLD single-team walk this would be { outcome: "nothing" }. Under C4 the walk hands the
    // unit to forge and produces `code`.
    expect(result.outcome).toBe("produced");
    if (result.outcome !== "produced") throw new Error("expected a production");
    expect(result.kind).toBe("code");

    // The artifact is real, on disk, and attributed to the BUILD team — not the shaping team.
    const codeFile = join(root, "work", "storefront", "build-me", "code-build-me-v1.md");
    const written = readFileSync(codeFile, "utf8");
    expect(written).toContain("kind: code");
    expect(written).toContain("produced_by: forge/smith");
    // And the daemon (runner identity) authored the commit, not the Conductor.
    const author = spawnSync("git", ["-C", root, "log", "-1", "--format=%an|%ae", "--", codeFile], { encoding: "utf8" }).stdout.trim();
    expect(author).toBe("levare-runner|runner@levare.local");
  });
});

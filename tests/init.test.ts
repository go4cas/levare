import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldStudio, initStudio } from "../src/init.ts";
import { validatePath, REGISTRY_SCHEMAS } from "../src/validate.ts";
import { createBoard } from "../src/board/serve.ts";
import { loadRepo, repoCapabilities } from "../src/repo.ts";
import { resolveStep } from "../src/gates.ts";
import { advanceUnit } from "../src/dagwalk.ts";
import { stubAdapterRunner } from "../src/replay.ts";
import { loadPricing } from "../src/pricing.ts";
import { parseFrontmatter } from "../src/yaml.ts";

// Phase 6 deliverable (a): `levare init` scaffolds an empty directory into a working studio — the
// skeleton, the five type templates, one example team with its agents, a sample skill, a
// .devcontainer/, and a starter README, with no demo work units.

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "levare-init-"));
  dirs.push(d);
  return d;
}

describe("scaffoldStudio", () => {
  test("produces exactly the expected skeleton directory set in an empty directory", () => {
    const root = tmpRoot();
    scaffoldStudio(root);
    const top = readdirSync(root).sort();
    expect(top).toEqual([
      ".devcontainer",
      ".env.example",
      ".gitignore",
      "README.md",
      "agents",
      "connectors",
      "evals",
      "ideas",
      "knowledge",
      "projects",
      "skills",
      "studio.md",
      "teams",
      "types",
      "work",
    ]);
    // No demo work units: work/ and ideas/ are scaffolded empty.
    expect(readdirSync(join(root, "work"))).toEqual([]);
    expect(readdirSync(join(root, "ideas"))).toEqual([]);
  });

  // This is the third init-scaffold defect (F23's fictitious models fallback gap and stale finch
  // `result:`, now `evals/` missing from this very scaffold) — the expected set here is DERIVED from
  // validate.ts's own REGISTRY_SCHEMAS map, never a second hardcoded array, so a future registry entity
  // can never again be silently forgotten from the scaffold.
  test("contains every directory the registry itself enumerates, derived from validate.ts's own entity list", () => {
    const root = tmpRoot();
    scaffoldStudio(root);
    // `work/` is the one top-level directory validate.ts special-cases outside REGISTRY_SCHEMAS (it
    // holds units and artifacts, not a registry entity schema) — every other directory the scaffold
    // must contain is exactly REGISTRY_SCHEMAS's own keys.
    const expected = [...Object.keys(REGISTRY_SCHEMAS), "work"].sort();
    for (const dir of expected) {
      expect(existsSync(join(root, dir))).toBe(true);
    }
  });

  test("scaffolds the five type templates", () => {
    const root = tmpRoot();
    scaffoldStudio(root);
    expect(readdirSync(join(root, "types")).sort()).toEqual([
      "feature.md",
      "fix.md",
      "inception.md",
      "research.md",
      "spike.md",
    ]);
  });

  test("scaffolds one example team with native and cli agents, and a sample skill in Agent Skills format", () => {
    const root = tmpRoot();
    scaffoldStudio(root);
    expect(existsSync(join(root, "teams/kestrel.md"))).toBe(true);
    const wren = readFileSync(join(root, "agents/wren.md"), "utf8");
    const finch = readFileSync(join(root, "agents/finch.md"), "utf8");
    expect(wren).toContain("kind: native");
    expect(finch).toContain("kind: cli");
    // Agent Skills format: a folder carrying its own SKILL.md plus supporting files.
    expect(existsSync(join(root, "skills/new-project/SKILL.md"))).toBe(true);
    expect(existsSync(join(root, "skills/new-project/scripts/create-repo.sh"))).toBe(true);
  });

  test("every scaffolded definition validates: `levare validate` on the fresh studio exits ok with zero errors", () => {
    const root = tmpRoot();
    scaffoldStudio(root);
    const result = validatePath(root);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  // NOTES F11: `levare init` used to scaffold `model: claude-sonnet`, which is not a real model ID and
  // fails on a new studio's first native run. This asserts the scaffold's own agents AND its
  // studio-level orchestrator declaration name real, current, PRICED model IDs — the same known-model
  // set `validatePath`'s UNKNOWN_MODEL check enforces, read straight from the scaffold's own
  // knowledge/model-pricing.md rather than duplicated here.
  test("scaffolded agents and the studio's orchestrator_model are all in the known-model set", () => {
    const root = tmpRoot();
    scaffoldStudio(root);
    const pricing = loadPricing(root);
    expect(pricing.size).toBeGreaterThan(0);
    for (const agentFile of ["agents/wren.md", "agents/lyra.md"]) {
      const { data } = parseFrontmatter(readFileSync(join(root, agentFile), "utf8"));
      expect(typeof data.model).toBe("string");
      expect(pricing.has(data.model as string)).toBe(true);
    }
    const { data: studio } = parseFrontmatter(readFileSync(join(root, "studio.md"), "utf8"));
    expect(typeof studio.orchestrator_model).toBe("string");
    expect(pricing.has(studio.orchestrator_model as string)).toBe(true);
    // The whole-studio validator agrees: zero UNKNOWN_MODEL errors.
    const result = validatePath(root);
    expect(result.errors.filter((e) => e.code === "UNKNOWN_MODEL")).toEqual([]);
  });

  test("never overwrites: re-running init after an edit leaves the edited file untouched", () => {
    const root = tmpRoot();
    scaffoldStudio(root);
    const teamFile = join(root, "teams/kestrel.md");
    const edited = readFileSync(teamFile, "utf8") + "\n<!-- my edit -->\n";
    writeFileSync(teamFile, edited);

    const second = scaffoldStudio(root);
    expect(readFileSync(teamFile, "utf8")).toBe(edited);
    expect(second.skipped).toContain("teams/kestrel.md");
    expect(second.created).toEqual([]);
  });

  test("the board renders a non-empty studio screen from a freshly scaffolded root", async () => {
    const root = tmpRoot();
    scaffoldStudio(root);
    const board = createBoard(root);
    const res = await board.fetch(new Request("http://x/"));
    const body = await res.text();
    board.close();
    expect(res.status).toBe(200);
    expect(body).toContain('class="apphead"');
    expect(body).toContain('teams <span class="ct">1</span>');
    expect(body).toContain('agents <span class="ct">3</span>');
    expect(body).not.toContain("This isn't a levare studio yet");
  });
});

// ---------------------------------------------------------------------------
// Phase-6 gate fix-up: `levare init` must git init and make the founding commit itself, using the
// user's own resolved git identity — not the fixed Conductor identity `conductorCommit` uses (this
// commit predates any Conductor action). Hermetic per NOTES.md's phase-1 immutability learnings: a
// resolvable/unresolvable identity must be pinned via env, never left to whatever happens to be
// configured on the host running the suite.
// ---------------------------------------------------------------------------

function envWithIdentity(name: string, email: string, configFile: string): NodeJS.ProcessEnv {
  writeFileSync(configFile, `[user]\n\tname = ${name}\n\temail = ${email}\n`);
  return { ...process.env, GIT_CONFIG_GLOBAL: configFile, GIT_CONFIG_SYSTEM: "/dev/null" };
}

function envWithNoIdentity(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", HOME: tmpdir() };
}

function git(root: string, args: string[], env: NodeJS.ProcessEnv): { status: number | null; stdout: string } {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env });
  return { status: r.status, stdout: r.stdout };
}

describe("initStudio — git init + the founding commit", () => {
  test("with a resolvable git identity: ends as a git repo with exactly one commit, authored by that identity", () => {
    const root = tmpRoot();
    const configFile = join(root, "..", `gitconfig-${Math.random().toString(36).slice(2)}`);
    const env = envWithIdentity("Ada Studio", "ada@example.com", configFile);

    const result = initStudio(root, env);

    expect(result.git.gitAvailable).toBe(true);
    expect(result.git.repoInitialized).toBe(true);
    expect(result.git.committed).toBe(true);
    expect(result.git.identity).toEqual({ name: "Ada Studio", email: "ada@example.com" });
    expect(existsSync(join(root, ".git"))).toBe(true);

    const log = git(root, ["log", "--format=%H %an <%ae> %s"], env);
    const lines = log.stdout.trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("Ada Studio <ada@example.com> levare init");
    expect(lines[0].split(" ")[0]).toBe(result.git.commit);

    // The commit actually captured the scaffold — nothing left uncommitted.
    const status = git(root, ["status", "--porcelain"], env);
    expect(status.stdout.trim()).toBe("");

    rmSync(configFile, { force: true });
  });

  test("with no resolvable git identity: repo is still initialized, but nothing is committed", () => {
    const root = tmpRoot();
    const env = envWithNoIdentity();

    const result = initStudio(root, env);

    expect(result.git.gitAvailable).toBe(true);
    expect(result.git.repoInitialized).toBe(true);
    expect(result.git.identity).toBeNull();
    expect(result.git.committed).toBe(false);
    expect(result.git.commit).toBeNull();
    expect(existsSync(join(root, ".git"))).toBe(true);

    const log = git(root, ["log"], env);
    expect(log.status).not.toBe(0); // no commits exist yet — `git log` fails on an empty history
  });

  test("re-running init after a successful founding commit makes no second commit (nothing new to add)", () => {
    const root = tmpRoot();
    const configFile = join(root, "..", `gitconfig-${Math.random().toString(36).slice(2)}`);
    const env = envWithIdentity("Ada Studio", "ada@example.com", configFile);

    const first = initStudio(root, env);
    expect(first.git.committed).toBe(true);

    const second = initStudio(root, env);
    expect(second.scaffold.created).toEqual([]); // scaffold already complete
    expect(second.git.committed).toBe(false); // nothing staged the second time
    expect(second.git.commit).toBeNull();

    const log = git(root, ["log", "--format=%H"], env);
    expect(log.stdout.trim().split("\n").filter(Boolean).length).toBe(1); // still exactly one commit

    rmSync(configFile, { force: true });
  });
});

// NOTES F1: `levare init` must scaffold a studio that is not merely on-contract but RUNNABLE — the
// defect was a studio that validated clean and could not bind a single flow step to a member. The
// scaffold is the first studio every new Conductor gets; if its example team cannot bind, the very
// first unit they open sits silent. So: it validates, its capability map is non-empty and derived
// from its own agents, every step of its example team's flow resolves, and a unit opened against it
// actually produces its first artifact through the walk.
describe("F1: the scaffolded studio is runnable, not merely valid", () => {
  test("its example team binds every flow step to a member, and a unit produces its first artifact", async () => {
    const root = tmpRoot();
    scaffoldStudio(root);
    expect(validatePath(root).ok).toBe(true);

    const repo = loadRepo(root);
    const caps = repoCapabilities(repo);
    // Capabilities come from the scaffolded agents' own `produces:` — no stub map anywhere.
    expect(caps).toEqual([
      { member: "finch", kind: "review" },
      { member: "lyra", kind: "design" },
      { member: "lyra", kind: "spec" },
      { member: "wren", kind: "product-brief" },
    ]);

    // Every step the example team declares resolves to exactly one member.
    const kestrel = repo.teams.get("kestrel")!;
    expect(resolveStep(kestrel, "brief", caps)).toEqual({ member: "wren", kind: "product-brief" });
    expect(resolveStep(kestrel, "design", caps)).toEqual({ member: "lyra", kind: "design" });
    expect(resolveStep(kestrel, "spec", caps)).toEqual({ member: "lyra", kind: "spec" });
    expect(resolveStep(kestrel, "review", caps)).toEqual({ member: "finch", kind: "review" });

    // End to end: open a feature unit against the scaffolded studio's own project and walk it. The
    // member INVOCATION is stubbed (invariant 10 — no real model call in a test); the binding,
    // capability map, team, flow, and write path are all the scaffold's own.
    const unitDir = join(root, "work", "studio", "pilot");
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(join(unitDir, "unit.md"), ["---", "type: feature", "status: active", "---", "", "# pilot", "", "The first unit in a fresh studio.", ""].join("\n"));

    const withUnit = loadRepo(root);
    const unit = withUnit.units.find((u) => u.unit === "pilot")!;
    const result = await advanceUnit(root, withUnit, unit, stubAdapterRunner(withUnit), {
      startAuthorized: true,
      commit: () => "no-git", // the scaffold-only test root has no git history; the walk's write is what matters
    });
    expect(result.outcome).toBe("produced");
    if (result.outcome !== "produced") throw new Error("unreachable");
    expect(result).toMatchObject({ member: "wren", kind: "product-brief", artifactId: "product-brief-pilot-v1" });
    expect(readFileSync(result.file, "utf8")).toContain("produced_by: kestrel/wren");
    expect(validatePath(root).ok).toBe(true); // still a valid studio after the walk wrote to it
  });
});

// D10/D11 (NOTES "Dogfood findings", 2026-07-13): the phase-6 test above proves `validatePath` (an
// internal function) is happy with a fresh scaffold — but `validatePath` IS what `runValidate`/the
// CLI's `validate` command calls (src/cli.ts), so that was never actually a narrower check than the
// CLI's. What it did NOT prove is that the real `levare` binary, invoked as a real subprocess exactly
// the way a Conductor runs it, agrees — nor did anything pin the specific error codes
// (UNPRODUCIBLE_KIND / UNBINDABLE_STEP / EMPTY_PRODUCES) a regression in the scaffold's `produces:`
// declarations would trip. Both gaps are closed here: an actual `./levare init` + `./levare validate`
// subprocess pair (no internal function calls at all), and a mutation test that strips a scaffolded
// agent's `produces:` and asserts the exact error code the studio-bindings check would raise.
const REPO_ROOT = join(import.meta.dir, "..");

describe("D10/D11: a fresh `levare init` passes the real `levare validate` command, end to end", () => {
  test("./levare init then ./levare validate against the same subprocess binary exits 0 and prints 'valid'", () => {
    const root = tmpRoot();
    const init = spawnSync("./levare", ["init", root], { cwd: REPO_ROOT, encoding: "utf8" });
    expect(init.status).toBe(0);

    const validate = spawnSync("./levare", ["validate", root], { cwd: REPO_ROOT, encoding: "utf8" });
    expect(validate.stdout.trim()).toBe("valid");
    expect(validate.status).toBe(0);
  });

  test("the scaffolded projects/studio.md pointer declares pace: auto", () => {
    const root = tmpRoot();
    scaffoldStudio(root);
    const pointer = readFileSync(join(root, "projects/studio.md"), "utf8");
    expect(pointer).toMatch(/^pace: auto\b/m);
  });

  test("the scaffolded .gitignore exists with .DS_Store, node_modules/, and .env", () => {
    const root = tmpRoot();
    scaffoldStudio(root);
    const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
    const entries = gitignore.split("\n").map((l) => l.trim()).filter(Boolean);
    expect(entries).toEqual([".DS_Store", "node_modules/", ".env"]);
  });

  // NOTES F23: a fresh studio scaffolds `.env.example` — never a live `.env` (a real secret in a
  // freshly-init'd, about-to-be-pushed repo is a loaded gun). It names the variables a studio might
  // need, explains the Orchestrator is optional, and explains connector grants are scoped.
  describe("F23: .env.example, never a live .env", () => {
    test("scaffolds .env.example, and never a live .env", () => {
      const root = tmpRoot();
      scaffoldStudio(root);
      expect(existsSync(join(root, ".env.example"))).toBe(true);
      expect(existsSync(join(root, ".env"))).toBe(false);
    });

    test("names the variables this studio might need, with no real secret values", () => {
      const root = tmpRoot();
      scaffoldStudio(root);
      const example = readFileSync(join(root, ".env.example"), "utf8");
      expect(example).toContain("ANTHROPIC_API_KEY=");
      expect(example).toContain("GITHUB_TOKEN=");
      expect(example).toContain("LINEAR_API_KEY=");
      // A checklist, not a leak: no line assigns an actual-looking secret value.
      for (const line of example.split("\n")) {
        if (line.startsWith("#") || !line.includes("=")) continue;
        expect(line.split("=", 2)[1].trim()).toBe("");
      }
    });

    test("explains the Orchestrator is optional, and that connector grants are scoped", () => {
      const root = tmpRoot();
      scaffoldStudio(root);
      const example = readFileSync(join(root, ".env.example"), "utf8");
      expect(example).toContain("OPTIONAL");
      expect(example).toContain("scoped");
    });

    test(".env.example is not a registry entity — levare validate never trips on it", () => {
      const root = tmpRoot();
      scaffoldStudio(root);
      expect(validatePath(root).ok).toBe(true);
    });
  });

  test("a regression that empties an agent's produces: is caught by the SAME validator the CLI uses (EMPTY_PRODUCES / UNBINDABLE_STEP)", () => {
    const root = tmpRoot();
    scaffoldStudio(root);
    // Reproduce the D10 defect directly: strip wren's `produces:` back to empty, as if the scaffold
    // template had never declared it (the exact shape of the original dogfood bug).
    const wrenPath = join(root, "agents/wren.md");
    const wren = readFileSync(wrenPath, "utf8");
    writeFileSync(wrenPath, wren.replace("produces: [product-brief]", "produces: []"));

    const result = validatePath(root);
    expect(result.ok).toBe(false);
    const codes = result.errors.map((e) => e.code).sort();
    expect(codes).toContain("EMPTY_PRODUCES");
    expect(codes).toContain("UNBINDABLE_STEP");

    // And the real CLI subprocess agrees — not just the internal function.
    const validate = spawnSync("./levare", ["validate", root], { cwd: REPO_ROOT, encoding: "utf8" });
    expect(validate.status).toBe(1);
    expect(validate.stderr).toContain("EMPTY_PRODUCES");
  });
});

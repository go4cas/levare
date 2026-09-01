import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { assertExitCode } from "./spawn-helpers.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldStudio, initStudio } from "../src/init.ts";
import { validatePath } from "../src/validate.ts";
import { loadRepo } from "../src/repo.ts";
import { advanceUnit } from "../src/dagwalk.ts";
import { stubAdapterRunner } from "../src/replay.ts";
import { createUnit } from "../src/new.ts";

// Finding 93 (RELEASE R1): a work unit can be created without hand-editing `unit.md`. These tests
// exercise `createUnit` directly (the function `levare new` calls) against a freshly scaffolded
// studio — the same studio shape a real new user starts from.

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "levare-new-"));
  dirs.push(d);
  return d;
}

function envWithIdentity(name: string, email: string, configFile: string): NodeJS.ProcessEnv {
  writeFileSync(configFile, `[user]\n\tname = ${name}\n\temail = ${email}\n`);
  return { ...process.env, GIT_CONFIG_GLOBAL: configFile, GIT_CONFIG_SYSTEM: "/dev/null" };
}

function envWithNoIdentity(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", HOME: tmpdir() };
}

describe("createUnit — the happy paths", () => {
  // The scaffold ships all five type templates (init.ts's own README explains why: a fresh studio
  // still has to choose), so --type is genuinely ambiguous out of the box — inference is exercised
  // below with a pared-down types/ directory instead.
  test("infers type when the studio defines exactly one, and team when exactly one team can produce it", () => {
    const root = tmpRoot();
    scaffoldStudio(root); // one team (kestrel)
    for (const f of ["inception", "fix", "spike", "research"]) rmSync(join(root, "types", `${f}.md`));
    // Finding 170 (UNKNOWN_CONSUMED_KIND): with `inception` gone, 'pitch' is no longer expected by any
    // remaining type — kestrel's own `consumes: [pitch, product-brief]` would otherwise now name an
    // orphaned kind. Trim it to what's still real, exactly as an operator pruning inception would.
    const kestrelFile = join(root, "teams", "kestrel.md");
    writeFileSync(kestrelFile, readFileSync(kestrelFile, "utf8").replace("consumes: [pitch, product-brief]", "consumes: [product-brief]"));

    const result = createUnit({ root, project: "studio", unit: "pilot", env: envWithNoIdentity() });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.type).toEqual({ value: "feature", source: "inferred" });
    expect(result.team).toEqual({ value: "kestrel", source: "inferred" });
    expect(result.budget).toBeUndefined();

    const written = readFileSync(result.file, "utf8");
    expect(written).toContain("type: feature");
    expect(written).toContain("status: active");
    expect(written).toContain("team: kestrel");
    expect(validatePath(root).ok).toBe(true);
  });

  test("--type/--team flags override inference and are honored verbatim", () => {
    const root = tmpRoot();
    scaffoldStudio(root);

    const result = createUnit({ root, project: "studio", unit: "chore", type: "feature", team: "kestrel", env: envWithNoIdentity() });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.type).toEqual({ value: "feature", source: "flag" });
    expect(result.team).toEqual({ value: "kestrel", source: "flag" });
  });

  test("--budget is honored verbatim; absent budget with no project default leaves budget unset", () => {
    const root = tmpRoot();
    scaffoldStudio(root);

    const withBudget = createUnit({ root, project: "studio", unit: "a", type: "feature", team: "kestrel", budget: 10, env: envWithNoIdentity() });
    expect(withBudget.ok).toBe(true);
    if (!withBudget.ok) throw new Error("unreachable");
    expect(withBudget.budget).toEqual({ value: 10, source: "flag" });
    expect(readFileSync(withBudget.file, "utf8")).toContain("budget: 10");

    const noBudget = createUnit({ root, project: "studio", unit: "b", type: "feature", team: "kestrel", env: envWithNoIdentity() });
    expect(noBudget.ok).toBe(true);
    if (!noBudget.ok) throw new Error("unreachable");
    expect(noBudget.budget).toBeUndefined();
    expect(readFileSync(noBudget.file, "utf8")).not.toContain("budget:");
  });

  test("a project's overrides.budget supplies the default when --budget is absent", () => {
    const root = tmpRoot();
    scaffoldStudio(root);
    const pointer = join(root, "projects", "studio.md");
    const withOverride = readFileSync(pointer, "utf8").replace("pace: auto", "pace: auto\noverrides:\n  budget: 9.5");
    writeFileSync(pointer, withOverride);

    const result = createUnit({ root, project: "studio", unit: "c", type: "feature", team: "kestrel", env: envWithNoIdentity() });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.budget).toEqual({ value: 9.5, source: "default" });
  });

  test("commits under the operator's own resolved git identity when one is available", () => {
    const root = tmpRoot();
    const configFile = join(root, "..", `gitconfig-${Math.random().toString(36).slice(2)}`);
    const env = envWithIdentity("Ada Studio", "ada@example.com", configFile);
    dirs.push(configFile);
    const init = initStudio(root, env);
    expect(init.git.committed).toBe(true);

    const result = createUnit({ root, project: "studio", unit: "pilot", type: "feature", env });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.committed).toBe(true);
    expect(result.commit).toBeTruthy();

    const log = spawnSync("git", ["-C", root, "log", "-1", "--format=%an <%ae> %s"], { encoding: "utf8", env });
    expect(log.stdout.trim()).toBe("Ada Studio <ada@example.com> new: studio/pilot");
  });

  test("with no resolvable git identity, the file is still written but reported as not committed", () => {
    const root = tmpRoot();
    scaffoldStudio(root);
    spawnSync("git", ["init", "-q", root]);

    const result = createUnit({ root, project: "studio", unit: "pilot", type: "feature", env: envWithNoIdentity() });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.committed).toBe(false);
    expect(result.commitNote).toContain("no git identity");
    expect(existsSync(result.file)).toBe(true); // the file is the truth regardless of commit state
  });
});

describe("createUnit — fails loudly, never silently", () => {
  test("an existing unit path is refused", () => {
    const root = tmpRoot();
    scaffoldStudio(root);
    const first = createUnit({ root, project: "studio", unit: "dup", type: "feature", env: envWithNoIdentity() });
    expect(first.ok).toBe(true);
    const second = createUnit({ root, project: "studio", unit: "dup", type: "feature", env: envWithNoIdentity() });
    expect(second).toMatchObject({ ok: false, code: "UNIT_EXISTS" });
  });

  test("an unknown project names the known candidates", () => {
    const root = tmpRoot();
    scaffoldStudio(root);
    const result = createUnit({ root, project: "nope", unit: "x", env: envWithNoIdentity() });
    expect(result).toMatchObject({ ok: false, code: "UNKNOWN_PROJECT" });
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toContain("studio");
  });

  test("an unknown --type names the known candidates", () => {
    const root = tmpRoot();
    scaffoldStudio(root);
    const result = createUnit({ root, project: "studio", unit: "x", type: "bogus", env: envWithNoIdentity() });
    expect(result).toMatchObject({ ok: false, code: "UNKNOWN_TYPE" });
  });

  test("an unknown --team names the known candidates", () => {
    const root = tmpRoot();
    scaffoldStudio(root);
    const result = createUnit({ root, project: "studio", unit: "x", type: "feature", team: "bogus", env: envWithNoIdentity() });
    expect(result).toMatchObject({ ok: false, code: "UNKNOWN_TEAM" });
  });

  test("more than one type in the studio requires --type, naming every candidate", () => {
    const root = tmpRoot();
    scaffoldStudio(root); // types/ ships all five templates
    const result = createUnit({ root, project: "studio", unit: "x", env: envWithNoIdentity() });
    expect(result).toMatchObject({ ok: false, code: "AMBIGUOUS_TYPE" });
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toContain("feature");
    expect(result.message).toContain("inception");
  });

  test("more than one team able to produce the type's expected kinds requires --team", () => {
    const root = tmpRoot();
    scaffoldStudio(root);
    // A second, independent team also producing product-brief — the same shape a second real team
    // reaching the same capability would take. A distinct member avoids AGENT_IN_MULTIPLE_TEAMS.
    writeFileSync(
      join(root, "agents", "wren2.md"),
      readFileSync(join(root, "agents", "wren.md"), "utf8").replace("name: wren", "name: wren2"),
    );
    writeFileSync(
      join(root, "teams", "press.md"),
      ["---", "name: press", "consumes: [pitch]", "produces: [product-brief]", "members: [wren2]", "flow:", "  - step: brief", "style:", '  color: "#333333"', "---", "# press", ""].join("\n"),
    );

    const result = createUnit({ root, project: "studio", unit: "x", type: "feature", env: envWithNoIdentity() });
    expect(result).toMatchObject({ ok: false, code: "AMBIGUOUS_TEAM" });
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toContain("kestrel");
    expect(result.message).toContain("press");
  });

  test("an explicit --team that cannot produce anything the type expects is refused", () => {
    const root = tmpRoot();
    scaffoldStudio(root);
    writeFileSync(
      join(root, "agents", "idle.md"),
      ["---", "name: idle", "description: idle", "kind: native", "produces: [findings]", "model: claude-sonnet-5", "style:", "  avatar: Id", "---", "idle", ""].join("\n"),
    );
    writeFileSync(
      join(root, "teams", "researchers.md"),
      ["---", "name: researchers", "consumes: [question]", "produces: [findings]", "members: [idle]", "flow:", "  - step: findings", "style:", '  color: "#444444"', "---", "# researchers", ""].join(
        "\n",
      ),
    );

    const result = createUnit({ root, project: "studio", unit: "x", type: "feature", team: "researchers", env: envWithNoIdentity() });
    expect(result).toMatchObject({ ok: false, code: "TEAM_CANNOT_PRODUCE" });
  });

  test("rejects a studio that does not itself validate, rather than adding to it", () => {
    const root = tmpRoot();
    scaffoldStudio(root);
    // Corrupt the registry: a team declaring a kind no member of it produces.
    writeFileSync(join(root, "teams", "kestrel.md"), readFileSync(join(root, "teams", "kestrel.md"), "utf8").replace("produces: [product-brief, design, spec]", "produces: [product-brief, design, spec, bogus-kind]"));
    const result = createUnit({ root, project: "studio", unit: "x", env: envWithNoIdentity() });
    expect(result).toMatchObject({ ok: false, code: "STUDIO_INVALID" });
  });

  test("rejects a project/unit name that isn't a safe path segment", () => {
    const root = tmpRoot();
    scaffoldStudio(root);
    const result = createUnit({ root, project: "studio", unit: "../escape", env: envWithNoIdentity() });
    expect(result).toMatchObject({ ok: false, code: "INVALID_NAME" });
  });

  test("a studio with no types defined at all reports NO_TYPES, not a guess", () => {
    const root = tmpRoot();
    scaffoldStudio(root);
    for (const f of ["inception", "feature", "fix", "spike", "research"]) rmSync(join(root, "types", `${f}.md`));
    // Finding 170 (UNKNOWN_CONSUMED_KIND): with every type gone, nothing expects 'pitch' or
    // 'product-brief' any more — kestrel's `consumes:` would otherwise name two orphaned kinds.
    const kestrelFile = join(root, "teams", "kestrel.md");
    writeFileSync(kestrelFile, readFileSync(kestrelFile, "utf8").replace("consumes: [pitch, product-brief]", "consumes: []"));
    const result = createUnit({ root, project: "studio", unit: "x", env: envWithNoIdentity() });
    expect(result).toMatchObject({ ok: false, code: "NO_TYPES" });
  });
});

describe("Finding 93's own acceptance test: created → validates → startable end to end", () => {
  test("a unit created by createUnit passes validate and can be walked to its first artifact", async () => {
    const root = tmpRoot();
    scaffoldStudio(root);
    expect(validatePath(root).ok).toBe(true);

    const result = createUnit({ root, project: "studio", unit: "pilot", type: "feature", env: envWithNoIdentity() });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(validatePath(root).ok).toBe(true);

    const repo = loadRepo(root);
    const unit = repo.units.find((u) => u.unit === "pilot")!;
    const walked = await advanceUnit(root, repo, unit, stubAdapterRunner(repo), {
      startAuthorized: true,
      commit: () => "no-git",
    });
    expect(walked.outcome).toBe("produced");
    if (walked.outcome !== "produced") throw new Error("unreachable");
    expect(walked).toMatchObject({ member: "wren", kind: "product-brief" });
  });
});

describe("./levare new — real subprocess, end to end", () => {
  const REPO_ROOT = join(import.meta.dir, "..");

  test("./levare init then ./levare new then ./levare validate all exit 0", () => {
    const root = tmpRoot();
    const configFile = join(root, "..", `gitconfig-${Math.random().toString(36).slice(2)}`);
    const env = envWithIdentity("Ada Studio", "ada@example.com", configFile);
    dirs.push(configFile);

    const init = spawnSync("./levare", ["init", root], { cwd: REPO_ROOT, encoding: "utf8", env });
    assertExitCode("./levare init <root>", init, 0);

    const created = spawnSync("./levare", ["new", "studio", "pilot", "--type", "feature", "--root", root], { cwd: REPO_ROOT, encoding: "utf8", env });
    assertExitCode("./levare new studio pilot --type feature --root <root>", created, 0);
    expect(created.stdout).toContain("type: feature");
    expect(created.stdout).toContain("team: kestrel (inferred)");
    expect(existsSync(join(root, "work", "studio", "pilot", "unit.md"))).toBe(true);

    const validate = spawnSync("./levare", ["validate", root], { cwd: REPO_ROOT, encoding: "utf8", env });
    expect(validate.stdout.trim().split("\n")[0]).toBe("valid");
    assertExitCode("./levare validate <root>", validate, 0);
  });

  test("an unknown project fails loudly with a non-zero exit and no file written", () => {
    const root = tmpRoot();
    const init = spawnSync("./levare", ["init", root], { cwd: REPO_ROOT, encoding: "utf8" });
    assertExitCode("./levare init <root>", init, 0);

    const created = spawnSync("./levare", ["new", "nope", "x", "--root", root], { cwd: REPO_ROOT, encoding: "utf8" });
    expect(created.status).not.toBe(0);
    expect(created.stderr).toContain("UNKNOWN_PROJECT");
    expect(existsSync(join(root, "work", "nope"))).toBe(false);
  });
});

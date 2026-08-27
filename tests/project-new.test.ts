import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { assertExitCode } from "./spawn-helpers.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldStudio, initStudio } from "../src/init.ts";
import { validatePath } from "../src/validate.ts";
import { createProject } from "../src/project-new.ts";

// Finding 137 (RELEASE R1b): a project can be created without hand-editing `projects/<name>.md`.
// These tests exercise `createProject` directly (the function `levare project new` calls) against a
// freshly scaffolded studio, mirroring tests/new.test.ts's own structure for `createUnit`.

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "levare-project-new-"));
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

// A real local git checkout for `--repo` to resolve against — `createProject` refuses anything else
// up front (REPO_NOT_A_CHECKOUT), so every happy-path test needs one.
function makeTargetRepo(defaultBranch = "main"): string {
  const d = mkdtempSync(join(tmpdir(), "levare-target-repo-"));
  dirs.push(d);
  spawnSync("git", ["-c", `init.defaultBranch=${defaultBranch}`, "-C", d, "init", "-q"]);
  return d;
}

describe("createProject — the happy paths", () => {
  test("infers default_branch and remote when the target repo leaves exactly one candidate each", () => {
    const root = tmpRoot();
    scaffoldStudio(root);
    const targetRepo = makeTargetRepo("main");
    spawnSync("git", ["-C", targetRepo, "remote", "add", "origin", "git@github.com:you/todo-cli.git"]);

    const result = createProject({ root, name: "todo-cli", repo: targetRepo, env: envWithNoIdentity() });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.defaultBranch).toEqual({ value: "main", source: "inferred" });
    expect(result.remote).toEqual({ value: "git@github.com:you/todo-cli.git", source: "inferred" });
    expect(result.deploy).toEqual({ value: null, source: "default" });
    expect(result.pace).toEqual({ value: "auto", source: "default" });

    const written = readFileSync(result.file, "utf8");
    expect(written).toContain("name: todo-cli");
    expect(written).toContain(`repo: ${targetRepo}`);
    expect(written).toContain("remote: git@github.com:you/todo-cli.git");
    expect(written).toContain("default_branch: main");
    expect(written).toContain("deploy: null");
    expect(written).toContain("pace: auto");
    expect(validatePath(root).ok).toBe(true);
  });

  test("no remote on the target repo leaves remote null, legally", () => {
    const root = tmpRoot();
    scaffoldStudio(root);
    const targetRepo = makeTargetRepo("main");

    const result = createProject({ root, name: "todo-cli", repo: targetRepo, env: envWithNoIdentity() });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.remote).toEqual({ value: null, source: "default" });
    expect(readFileSync(result.file, "utf8")).toContain("remote: null");
  });

  test("flags override inference and are honored verbatim", () => {
    const root = tmpRoot();
    scaffoldStudio(root);
    const targetRepo = makeTargetRepo("main");
    spawnSync("git", ["-C", targetRepo, "remote", "add", "origin", "git@github.com:you/todo-cli.git"]);

    const result = createProject({
      root,
      name: "todo-cli",
      repo: targetRepo,
      remote: "git@github.com:someone-else/todo-cli.git",
      defaultBranch: "trunk",
      deploy: "vercel",
      pace: "step",
      env: envWithNoIdentity(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.remote).toEqual({ value: "git@github.com:someone-else/todo-cli.git", source: "flag" });
    expect(result.defaultBranch).toEqual({ value: "trunk", source: "flag" });
    expect(result.deploy).toEqual({ value: "vercel", source: "flag" });
    expect(result.pace).toEqual({ value: "step", source: "flag" });
  });

  test("house rules, when given, are written under their own heading", () => {
    const root = tmpRoot();
    scaffoldStudio(root);
    const targetRepo = makeTargetRepo("main");

    const result = createProject({ root, name: "todo-cli", repo: targetRepo, houseRules: "- Zero deps\n- Single binary", env: envWithNoIdentity() });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const written = readFileSync(result.file, "utf8");
    expect(written).toContain("## House rules");
    expect(written).toContain("- Zero deps");
  });

  test("a repo path is stored verbatim (tilde/relative form), never rewritten to its resolved form", () => {
    const root = tmpRoot();
    scaffoldStudio(root);
    const targetRepo = makeTargetRepo("main");
    // Relative to the studio root — resolveProjectRepoPathRaw joins it onto `root`.
    const relDir = "vendor/todo-cli";
    mkdirSync(join(root, "vendor"), { recursive: true });
    spawnSync("cp", ["-r", targetRepo, join(root, relDir)]);

    const result = createProject({ root, name: "todo-cli", repo: relDir, env: envWithNoIdentity() });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.repo).toBe(relDir);
    expect(readFileSync(result.file, "utf8")).toContain(`repo: ${relDir}`);
  });

  test("commits under the operator's own resolved git identity when one is available", () => {
    const root = tmpRoot();
    const configFile = join(root, "..", `gitconfig-${Math.random().toString(36).slice(2)}`);
    const env = envWithIdentity("Ada Studio", "ada@example.com", configFile);
    dirs.push(configFile);
    const init = initStudio(root, env);
    expect(init.git.committed).toBe(true);
    const targetRepo = makeTargetRepo("main");

    const result = createProject({ root, name: "todo-cli", repo: targetRepo, env });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.committed).toBe(true);
    expect(result.commit).toBeTruthy();

    const log = spawnSync("git", ["-C", root, "log", "-1", "--format=%an <%ae> %s"], { encoding: "utf8", env });
    expect(log.stdout.trim()).toBe("Ada Studio <ada@example.com> new-project: todo-cli");
  });

  test("with no resolvable git identity, the file is still written but reported as not committed", () => {
    const root = tmpRoot();
    scaffoldStudio(root);
    spawnSync("git", ["init", "-q", root]);
    const targetRepo = makeTargetRepo("main");

    const result = createProject({ root, name: "todo-cli", repo: targetRepo, env: envWithNoIdentity() });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.committed).toBe(false);
    expect(result.commitNote).toContain("no git identity");
    expect(existsSync(result.file)).toBe(true);
  });
});

describe("createProject — fails loudly, never silently", () => {
  test("an existing project name is refused", () => {
    const root = tmpRoot();
    scaffoldStudio(root); // ships projects/studio.md
    const targetRepo = makeTargetRepo("main");
    const result = createProject({ root, name: "studio", repo: targetRepo, env: envWithNoIdentity() });
    expect(result).toMatchObject({ ok: false, code: "PROJECT_EXISTS" });
  });

  test("a --repo that isn't a git checkout is refused immediately, not at first dispatch", () => {
    const root = tmpRoot();
    scaffoldStudio(root);
    const notARepo = mkdtempSync(join(tmpdir(), "levare-not-a-repo-"));
    dirs.push(notARepo);
    const result = createProject({ root, name: "todo-cli", repo: notARepo, env: envWithNoIdentity() });
    expect(result).toMatchObject({ ok: false, code: "REPO_NOT_A_CHECKOUT" });
  });

  test("a --repo pointing nowhere at all is refused the same way", () => {
    const root = tmpRoot();
    scaffoldStudio(root);
    const result = createProject({ root, name: "todo-cli", repo: "/definitely/not/a/real/path", env: envWithNoIdentity() });
    expect(result).toMatchObject({ ok: false, code: "REPO_NOT_A_CHECKOUT" });
  });

  test("more than one remote on the target repo requires --remote, naming every candidate", () => {
    const root = tmpRoot();
    scaffoldStudio(root);
    const targetRepo = makeTargetRepo("main");
    spawnSync("git", ["-C", targetRepo, "remote", "add", "origin", "git@github.com:you/todo-cli.git"]);
    spawnSync("git", ["-C", targetRepo, "remote", "add", "upstream", "git@github.com:upstream/todo-cli.git"]);

    const result = createProject({ root, name: "todo-cli", repo: targetRepo, env: envWithNoIdentity() });
    expect(result).toMatchObject({ ok: false, code: "AMBIGUOUS_REMOTE" });
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toContain("origin");
    expect(result.message).toContain("upstream");
  });

  test("a detached HEAD leaves default_branch undetectable, and --default-branch is required", () => {
    const root = tmpRoot();
    scaffoldStudio(root);
    const targetRepo = makeTargetRepo("main");
    writeFileSync(join(targetRepo, "README.md"), "# x\n");
    spawnSync("git", ["-C", targetRepo, "add", "-A"]);
    spawnSync("git", ["-C", targetRepo, "-c", "user.name=t", "-c", "user.email=t@t.local", "commit", "-q", "-m", "x"]);
    const rev = spawnSync("git", ["-C", targetRepo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    spawnSync("git", ["-C", targetRepo, "checkout", "-q", "--detach", rev]);

    const result = createProject({ root, name: "todo-cli", repo: targetRepo, env: envWithNoIdentity() });
    expect(result).toMatchObject({ ok: false, code: "DEFAULT_BRANCH_UNDETECTABLE" });

    const withFlag = createProject({ root, name: "todo-cli", repo: targetRepo, defaultBranch: "main", env: envWithNoIdentity() });
    expect(withFlag.ok).toBe(true);
  });

  test("an invalid --pace is refused, not silently coerced", () => {
    const root = tmpRoot();
    scaffoldStudio(root);
    const targetRepo = makeTargetRepo("main");
    const result = createProject({ root, name: "todo-cli", repo: targetRepo, pace: "bogus", env: envWithNoIdentity() });
    expect(result).toMatchObject({ ok: false, code: "INVALID_PACE" });
  });

  test("rejects a studio that does not itself validate, rather than adding to it", () => {
    const root = tmpRoot();
    scaffoldStudio(root);
    writeFileSync(join(root, "teams", "kestrel.md"), readFileSync(join(root, "teams", "kestrel.md"), "utf8").replace("produces: [product-brief, design, spec]", "produces: [product-brief, design, spec, bogus-kind]"));
    const targetRepo = makeTargetRepo("main");
    const result = createProject({ root, name: "todo-cli", repo: targetRepo, env: envWithNoIdentity() });
    expect(result).toMatchObject({ ok: false, code: "STUDIO_INVALID" });
  });

  test("rejects a project name that isn't a safe path segment", () => {
    const root = tmpRoot();
    scaffoldStudio(root);
    const targetRepo = makeTargetRepo("main");
    const result = createProject({ root, name: "../escape", repo: targetRepo, env: envWithNoIdentity() });
    expect(result).toMatchObject({ ok: false, code: "INVALID_NAME" });
  });
});

describe("Finding 137's own acceptance test: created → validates clean", () => {
  test("a project created by createProject passes levare validate", () => {
    const root = tmpRoot();
    scaffoldStudio(root);
    expect(validatePath(root).ok).toBe(true);
    const targetRepo = makeTargetRepo("main");

    const result = createProject({ root, name: "todo-cli", repo: targetRepo, env: envWithNoIdentity() });
    expect(result.ok).toBe(true);
    const v = validatePath(root);
    expect(v.ok).toBe(true);
  });
});

describe("./levare project new — real subprocess, end to end", () => {
  const REPO_ROOT = join(import.meta.dir, "..");

  test("./levare init then ./levare project new then ./levare validate all exit 0", () => {
    const root = tmpRoot();
    const configFile = join(root, "..", `gitconfig-${Math.random().toString(36).slice(2)}`);
    const env = envWithIdentity("Ada Studio", "ada@example.com", configFile);
    dirs.push(configFile);
    const targetRepo = makeTargetRepo("main");
    spawnSync("git", ["-C", targetRepo, "remote", "add", "origin", "git@github.com:you/todo-cli.git"]);

    const init = spawnSync("./levare", ["init", root], { cwd: REPO_ROOT, encoding: "utf8", env });
    assertExitCode("./levare init <root>", init, 0);

    const created = spawnSync("./levare", ["project", "new", "todo-cli", "--repo", targetRepo, "--root", root], { cwd: REPO_ROOT, encoding: "utf8", env, input: "- Zero deps\n" });
    assertExitCode("./levare project new todo-cli --repo <repo> --root <root>", created, 0);
    expect(created.stdout).toContain("remote: git@github.com:you/todo-cli.git (inferred)");
    expect(created.stdout).toContain("default_branch: main (inferred)");
    expect(existsSync(join(root, "projects", "todo-cli.md"))).toBe(true);
    expect(readFileSync(join(root, "projects", "todo-cli.md"), "utf8")).toContain("- Zero deps");

    const validate = spawnSync("./levare", ["validate", root], { cwd: REPO_ROOT, encoding: "utf8", env });
    expect(validate.stdout.trim().split("\n")[0]).toBe("valid");
    assertExitCode("./levare validate <root>", validate, 0);
  });

  test("a bad --repo fails loudly with a non-zero exit and no file written", () => {
    const root = tmpRoot();
    const init = spawnSync("./levare", ["init", root], { cwd: REPO_ROOT, encoding: "utf8" });
    assertExitCode("./levare init <root>", init, 0);

    const created = spawnSync("./levare", ["project", "new", "todo-cli", "--repo", "/nope/not/a/repo", "--root", root], { cwd: REPO_ROOT, encoding: "utf8" });
    expect(created.status).not.toBe(0);
    expect(created.stderr).toContain("REPO_NOT_A_CHECKOUT");
    expect(existsSync(join(root, "projects", "todo-cli.md"))).toBe(false);
  });
});

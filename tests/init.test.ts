import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldStudio, initStudio } from "../src/init.ts";
import { validatePath } from "../src/validate.ts";
import { createBoard } from "../src/board/serve.ts";

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
      "README.md",
      "agents",
      "connectors",
      "ideas",
      "knowledge",
      "projects",
      "skills",
      "teams",
      "types",
      "work",
    ]);
    // No demo work units: work/ and ideas/ are scaffolded empty.
    expect(readdirSync(join(root, "work"))).toEqual([]);
    expect(readdirSync(join(root, "ideas"))).toEqual([]);
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
    expect(body).toContain('class="deriv"');
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

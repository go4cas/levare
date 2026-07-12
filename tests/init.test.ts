import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldStudio } from "../src/init.ts";
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

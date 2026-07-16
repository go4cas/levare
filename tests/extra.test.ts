import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExtras, RegistryEntityError } from "../src/extra.ts";

// A skill (and every other "extra" — knowledge/evals/ideas, all loaded through the same `loadDir`)
// exists in one of two on-disk shapes: a flat `<name>.md` file, or the Agent Skills folder convention
// — a directory carrying its own `SKILL.md` plus optional supporting files. `Entity.file` is the
// single source of truth for which file backs an entity: the registry card (render.ts) embeds THIS
// path rather than reconstructing `<dir>/<name>.md` from the entity's name, which is wrong for a
// directory-form entity and was the root cause of the empty/invalid editor bug this suite pins.

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "levare-extra-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("loadExtras — flat vs. directory-form entities", () => {
  test("a flat `skills/<name>.md` file resolves with `file` pointing at itself", () => {
    mkdirSync(join(root, "skills"), { recursive: true });
    writeFileSync(join(root, "skills", "flow-design.md"), "---\nname: flow-design\n---\n\nBody.\n");

    const { skills } = loadExtras(root);
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("flow-design");
    expect(skills[0].file).toBe("skills/flow-design.md");
    expect(skills[0].body).toBe("Body.");
  });

  test("a directory-form skill (Agent Skills convention) resolves `file` to its nested SKILL.md, not a reconstructed flat path", () => {
    mkdirSync(join(root, "skills", "new-project", "scripts"), { recursive: true });
    writeFileSync(join(root, "skills", "new-project", "SKILL.md"), "---\nname: new-project\n---\n\nBundle body.\n");
    writeFileSync(join(root, "skills", "new-project", "scripts", "create-repo.sh"), "#!/bin/sh\necho hi\n");

    const { skills } = loadExtras(root);
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("new-project");
    expect(skills[0].file).toBe("skills/new-project/SKILL.md");
    expect(skills[0].body).toBe("Bundle body.");
  });

  test("flat and directory-form skills coexist and each carries its own distinct `file`", () => {
    mkdirSync(join(root, "skills", "new-project"), { recursive: true });
    writeFileSync(join(root, "skills", "flow-design.md"), "---\nname: flow-design\n---\n\nFlat.\n");
    writeFileSync(join(root, "skills", "new-project", "SKILL.md"), "---\nname: new-project\n---\n\nBundled.\n");

    const { skills } = loadExtras(root);
    const byName = Object.fromEntries(skills.map((s) => [s.name, s]));
    expect(byName["flow-design"].file).toBe("skills/flow-design.md");
    expect(byName["new-project"].file).toBe("skills/new-project/SKILL.md");
  });

  test("a skill directory with markdown files but no SKILL.md is a named error, never an arbitrary first-.md pick", () => {
    mkdirSync(join(root, "skills", "broken-bundle"), { recursive: true });
    // Two markdown files, sorted-first is `a-notes.md` — if the loader ever regressed to "pick the
    // first .md by readdir order" it would silently return this file's content as the entity, instead
    // of failing loudly. Neither is named SKILL.md.
    writeFileSync(join(root, "skills", "broken-bundle", "a-notes.md"), "---\nname: broken-bundle\n---\n\nNotes.\n");
    writeFileSync(join(root, "skills", "broken-bundle", "z-notes.md"), "---\nname: broken-bundle\n---\n\nMore notes.\n");

    expect(() => loadExtras(root)).toThrow(RegistryEntityError);
    expect(() => loadExtras(root)).toThrow(/broken-bundle.*SKILL\.md/);
  });

  test("a directory with no markdown files at all (not an attempted bundle) is silently skipped, not an error", () => {
    mkdirSync(join(root, "skills", "assets-only"), { recursive: true });
    writeFileSync(join(root, "skills", "assets-only", "logo.png"), "not really a png");

    const { skills } = loadExtras(root);
    expect(skills).toHaveLength(0);
  });

  test("knowledge/evals/ideas resolve `file` the same way as skills (shared loader)", () => {
    mkdirSync(join(root, "knowledge", "house-style"), { recursive: true });
    writeFileSync(join(root, "knowledge", "house-style", "SKILL.md"), "---\nname: house-style\n---\n\nBundled knowledge.\n");
    mkdirSync(join(root, "evals"), { recursive: true });
    writeFileSync(join(root, "evals", "checkout-flow.md"), "---\nname: checkout-flow\n---\n\nRubric.\n");

    const extras = loadExtras(root);
    expect(extras.knowledge[0].file).toBe("knowledge/house-style/SKILL.md");
    expect(extras.evals[0].file).toBe("evals/checkout-flow.md");
  });
});

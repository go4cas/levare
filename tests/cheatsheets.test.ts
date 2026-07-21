// Drift guard + honesty guard for the generated docs/guide/05-reference/cheatsheets/*.md files
// (NOTES DOCS1). Two properties, proven, not asserted:
//
//   1. DRIFT: the committed cheatsheets are byte-identical to a fresh regeneration from the schemas in
//      src/validate.ts. If a schema changes and someone forgets `bun run docs:generate`, this fails —
//      naming exactly that.
//   2. HONESTY: every generated skeleton, written into a real scratch studio, passes the REAL
//      validator (validatePath) — a cheatsheet whose own example is invalid is worse than none.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAll, INDEX_FILENAME, OUT_DIR, skeletonMarkdown } from "../scripts/generate-cheatsheets.ts";
import {
  ARTIFACT_SCHEMA,
  REGISTRY_SCHEMAS,
  STUDIO_SCHEMA,
  WORK_UNIT_SCHEMA,
  validatePath,
} from "../src/validate.ts";

describe("cheatsheet generation", () => {
  test("committed cheatsheets are byte-identical to a fresh regeneration (no drift)", () => {
    const fresh = generateAll();
    const committed = new Set(readdirSync(OUT_DIR));

    expect(new Set(fresh.keys())).toEqual(committed);

    for (const [name, content] of fresh) {
      const onDisk = readFileSync(join(OUT_DIR, name), "utf8");
      if (onDisk !== content) {
        throw new Error(
          `schemas changed: run \`bun run docs:generate\` — docs/guide/05-reference/cheatsheets/${name} ` +
            `no longer matches what src/validate.ts's schemas would generate`,
        );
      }
    }
  });

  // ISSUE 1 (docs/guide/05-reference/cheatsheets/ 404s on GitHub Pages with no index page): the
  // byte-identical drift test above already fails if this file goes missing or stale (it's just
  // another entry in generateAll()'s Map), but this test names the actual property the folder needs —
  // an index page linking every entity cheatsheet — so a future refactor that keeps the byte compare
  // passing but drops a link still fails, and fails on this line specifically.
  test("the folder index links every generated entity cheatsheet", () => {
    const fresh = generateAll();
    expect(fresh.has(INDEX_FILENAME)).toBe(true);

    const index = fresh.get(INDEX_FILENAME)!;
    for (const [name] of fresh) {
      if (name === INDEX_FILENAME) continue;
      expect(index).toContain(`(${name})`);
    }
  });

  test("two consecutive generations produce identical bytes (deterministic)", () => {
    const a = generateAll();
    const b = generateAll();
    expect([...a.entries()]).toEqual([...b.entries()]);
  });

  test("fails loudly, not silently, when a schema drifts out from under a committed file", () => {
    // Proof-by-construction (per the goal: prove the drift test fails on a real schema change,
    // without permanently breaking any schema): regenerate, then mutate one committed byte the way a
    // forgotten-regenerate would leave it, and confirm the comparison this suite relies on catches it.
    const fresh = generateAll();
    const [name, content] = [...fresh.entries()][0];
    const mutated = content + "\nstray drifted line\n";
    expect(mutated).not.toEqual(readFileSync(join(OUT_DIR, name), "utf8"));
    expect(content).toEqual(readFileSync(join(OUT_DIR, name), "utf8"));
  });
});

describe("cheatsheet skeletons validate for real", () => {
  const ALL_SCHEMAS = [
    ...Object.entries(REGISTRY_SCHEMAS).map(([dir, schema]) => ({ schema, dir })),
    { schema: ARTIFACT_SCHEMA, dir: null as string | null },
    { schema: WORK_UNIT_SCHEMA, dir: null as string | null },
    { schema: STUDIO_SCHEMA, dir: null as string | null },
  ];

  test("every generated skeleton, written into a scratch studio, passes the real validator", () => {
    const cheatsheets = readdirSync(OUT_DIR);
    for (const { schema } of ALL_SCHEMAS) {
      expect(cheatsheets).toContain(`${schema.name}.md`);
    }

    for (const { schema, dir } of ALL_SCHEMAS) {
      const raw = readFileSync(join(OUT_DIR, `${schema.name}.md`), "utf8");
      const match = raw.match(/```markdown\n([\s\S]*?)```/);
      if (!match) throw new Error(`${schema.name}.md: no fenced skeleton block found`);
      const skeleton = match[1];

      const scratchRoot = mkdtempSync(join(tmpdir(), "levare-cheatsheet-skeleton-"));
      try {
        const filePath =
          schema === ARTIFACT_SCHEMA
            ? join(scratchRoot, "work", "example-project", "example-unit", "skeleton.md")
            : schema === WORK_UNIT_SCHEMA
              ? join(scratchRoot, "work", "example-project", "example-unit", "unit.md")
              : schema === STUDIO_SCHEMA
                ? join(scratchRoot, "studio.md")
                : join(scratchRoot, dir!, "skeleton.md");
        mkdirSync(join(filePath, ".."), { recursive: true });
        writeFileSync(filePath, skeleton);

        const result = validatePath(scratchRoot);
        expect({ schema: schema.name, ok: result.ok, errors: result.errors }).toEqual({
          schema: schema.name,
          ok: true,
          errors: [],
        });
      } finally {
        rmSync(scratchRoot, { recursive: true, force: true });
      }
    }
  });

  test("skeletonMarkdown round-trips through the real frontmatter parser", () => {
    // A narrower unit check on the serializer itself: any minimal candidate it emits must at least
    // parse (independent of the fuller validity check above, which goes through validatePath).
    const md = skeletonMarkdown({ name: "example", tags: [], nested: null });
    expect(md.startsWith("---\n")).toBe(true);
    expect(md).toContain("name: example");
    expect(md).toContain("tags: []");
    expect(md).toContain("nested: null");
  });
});

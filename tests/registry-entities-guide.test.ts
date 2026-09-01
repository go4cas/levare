// Structural + honesty guard for docs/guide/05-reference/02-registry-entities.md (Finding 173).
//
// This page is hand-written prose, not generated — it CAN drift, and did: `remote` was marked simply
// "required" (true, but the nullable value is the whole point), the Eval table listed a closed set of
// work-unit types a sibling section two paragraphs above had already declared open, and three registry
// directories (skills/, knowledge/, ideas/) had no section at all. The fix wasn't just rewriting the
// prose — it's this test, so the same drift can't happen silently again.
//
// Two properties, proven, not asserted:
//
//   1. STRUCTURE: every one of the ten entities gets the same four parts, in the same order — a
//      one-line "what it is", a "The basics" table, a "The why" explanation, and a link to that
//      entity's generated cheatsheet. A future edit that drops one of these for a single entity fails
//      here, by name, rather than being caught (or not) by someone re-reading the whole page.
//   2. HONESTY: every fenced ```markdown example in the page is executable content, exactly like the
//      heredocs guide-workflow-blocks.test.ts replays for 04-workflow — a reader copy-pastes it
//      expecting it to work. Every such block here is written into one shared scratch studio and run
//      through the REAL validator (validatePath), so an example that looks right but doesn't actually
//      validate fails loudly instead of shipping.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseFrontmatter } from "../src/yaml.ts";
import { validatePath } from "../src/validate.ts";

const DOC_PATH = "docs/guide/05-reference/02-registry-entities.md";

// The ten entities this page covers, in the order the goal (Finding 173) named them, paired with the
// cheatsheet filename each entity's handoff line must point at.
const ENTITIES = [
  { name: "Agent", cheatsheet: "agent.md" },
  { name: "Team", cheatsheet: "team.md" },
  { name: "Connector", cheatsheet: "connector.md" },
  { name: "Project", cheatsheet: "project.md" },
  { name: "Type", cheatsheet: "type.md" },
  { name: "Studio settings", cheatsheet: "studio.md" },
  { name: "Eval", cheatsheet: "eval.md" },
  { name: "Skill", cheatsheet: "skill.md" },
  { name: "Knowledge", cheatsheet: "knowledge.md" },
  { name: "Idea", cheatsheet: "idea.md" },
];

// Splits the page into one span of text per `## Heading — \`path\`` section, from that heading up to
// (not including) the next `## ` heading or end of file.
function splitSections(src: string): Map<string, { path: string; body: string }> {
  const HEADING_RE = /^## (.+?) — `([^`]+)`$/gm;
  const matches: Array<{ name: string; path: string; index: number; headingEnd: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = HEADING_RE.exec(src))) {
    matches.push({ name: m[1], path: m[2], index: m.index, headingEnd: m.index + m[0].length });
  }
  const sections = new Map<string, { path: string; body: string }>();
  for (let i = 0; i < matches.length; i++) {
    const end = i + 1 < matches.length ? matches[i + 1].index : src.length;
    sections.set(matches[i].name, { path: matches[i].path, body: src.slice(matches[i].headingEnd, end) });
  }
  return sections;
}

function extractMarkdownBlocks(body: string): string[] {
  const RE = /```markdown\n([\s\S]*?)```/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = RE.exec(body))) out.push(m[1]);
  return out;
}

describe("docs/guide/05-reference/02-registry-entities.md follows the four-part shape (Finding 173)", () => {
  const src = readFileSync(DOC_PATH, "utf8");
  const sections = splitSections(src);

  test("the page declares exactly the ten entities the goal named, no more, no fewer", () => {
    expect(new Set(sections.keys())).toEqual(new Set(ENTITIES.map((e) => e.name)));
  });

  for (const { name, cheatsheet } of ENTITIES) {
    test(`${name}'s section has all four parts, in order: basics, why, cheatsheet handoff`, () => {
      const section = sections.get(name);
      expect(section, `no '## ${name} — ...' section found`).toBeDefined();
      const body = section!.body;

      const basicsAt = body.indexOf("**The basics**");
      const whyAt = body.indexOf("**The why**");
      const handoffAt = body.indexOf("**Full field list, enum values, and skeleton:**");

      expect(basicsAt, `${name}: missing '**The basics**'`).toBeGreaterThan(-1);
      expect(whyAt, `${name}: missing '**The why**'`).toBeGreaterThan(-1);
      expect(handoffAt, `${name}: missing the cheatsheet handoff line`).toBeGreaterThan(-1);
      expect(basicsAt, `${name}: 'The basics' must come before 'The why'`).toBeLessThan(whyAt);
      expect(whyAt, `${name}: 'The why' must come before the cheatsheet handoff`).toBeLessThan(handoffAt);

      const handoffLine = body.slice(handoffAt, handoffAt + 200);
      expect(handoffLine, `${name}: handoff line doesn't link to cheatsheets/${cheatsheet}`).toContain(`(cheatsheets/${cheatsheet})`);
    });
  }
});

describe("docs/guide/05-reference/02-registry-entities.md's examples actually validate (Finding 173)", () => {
  const src = readFileSync(DOC_PATH, "utf8");
  const sections = splitSections(src);

  const root = mkdtempSync(join(tmpdir(), "levare-registry-entities-guide-"));
  try {
    for (const [, { path, body }] of sections) {
      for (const block of extractMarkdownBlocks(body)) {
        // A block with no frontmatter (none in this page today) isn't a pasteable entity file — skip it.
        if (!block.startsWith("---\n")) continue;
        const relPath = path.includes("<name>") ? path.replace("<name>", parseFrontmatter(block).data.name as string) : path;
        const full = join(root, relPath);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, block);
      }
    }

    const result = validatePath(root);

    test("every example, written into one shared studio, validates with no errors", () => {
      if (!result.ok) {
        const detail = result.errors.map((e) => `  ${e.code} ${e.file}${e.line ? ":" + e.line : ""} — ${e.message}`).join("\n");
        throw new Error(`the page's own examples don't validate:\n${detail}`);
      }
      expect(result.errors).toEqual([]);
    });

    // Same tolerance guide-workflow-blocks.test.ts uses: these two warnings depend on the host (no OS
    // sandbox primitive in a container) or an illustrative `~/source/todo-cli` that was never actually
    // cloned on this machine — neither says anything about whether the page's examples are correct.
    test("no warnings other than host/placeholder-repo noise", () => {
      const codes = result.warnings.map((w) => w.code);
      const unexpected = codes.filter((c) => c !== "SANDBOX_UNAVAILABLE" && c !== "PROJECT_REPO_UNRESOLVED");
      expect(unexpected).toEqual([]);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

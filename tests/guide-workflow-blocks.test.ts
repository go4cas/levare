// docs/guide/04-workflow's fenced `cat > … <<'EOF'` blocks are pasted verbatim by a reader building
// a real studio — they are executable content, not prose, and a prose-only review of the chapter
// text can't catch a block that the real parser rejects (this is exactly how the codex connector's
// broken multi-line `scope:` shipped once already — see docs/current-gaps.md, NOTES DOCS-WALKTHROUGH-1).
//
// This test replays every such block, in document order, into a scratch studio scaffolded the same
// way `2 · Quickstart`'s `levare init .` leaves one — the guide's own stated precondition (see
// 04-workflow/README.md's "Before you start") — and runs the REAL frontmatter parser and validator
// (not a mock) after each paste, the same way a reader running `levare validate .` after every step
// would. A chapter that shows no output after a block is expected to validate clean with zero
// warnings; where a chapter documents a warning explicitly, it's asserted here too, so this test
// breaks the moment prose and reality drift apart again.

import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { scaffoldStudio } from "../src/init.ts";
import { validatePath } from "../src/validate.ts";

const HEREDOC_RE = /cat > (\S+) <<'EOF'\n([\s\S]*?)\nEOF/g;

function extractHeredocs(src: string): Array<{ path: string; body: string }> {
  const out: Array<{ path: string; body: string }> = [];
  let m: RegExpExecArray | null;
  HEREDOC_RE.lastIndex = 0;
  while ((m = HEREDOC_RE.exec(src))) {
    out.push({ path: m[1], body: m[2] });
  }
  return out;
}

const GUIDE_DIR = "docs/guide/04-workflow";

// Reading order a reader actually follows — README's precondition setup, then 4.1 through 4.8.
const CHAPTERS = [
  "README.md",
  "01-capture-an-idea.md",
  "02-promote-to-a-project.md",
  "03-first-team-and-member.md",
  "04-first-gate.md",
  "05-foreign-agent.md",
  "06-first-loop.md",
  "07-the-daemon.md",
  "08-when-a-member-fails.md",
];

describe("docs/guide/04-workflow's pasteable blocks produce a valid studio", () => {
  const root = mkdtempSync(join(tmpdir(), "levare-guide-blocks-"));
  // What `2 · Quickstart`'s `levare init .` leaves behind — the walkthrough's own stated starting point.
  scaffoldStudio(root);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  for (const chapter of CHAPTERS) {
    const src = readFileSync(join(GUIDE_DIR, chapter), "utf8");
    const blocks = extractHeredocs(src);
    for (const { path, body } of blocks) {
      test(`${chapter} → ${path} parses and validates clean`, () => {
        const full = join(root, path);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, body + "\n");

        const r = validatePath(root);
        if (!r.ok) {
          const detail = r.errors
            .map((e) => `  ${e.code} ${e.file}${e.line ? ":" + e.line : ""} — ${e.message}`)
            .join("\n");
          throw new Error(`after pasting ${chapter}'s ${path} block, \`levare validate\` fails:\n${detail}`);
        }
        expect(r.errors).toEqual([]);
        // A chapter's own narration is the source of truth for which warnings a reader should expect
        // at this point — SUBSCRIPTION_NO_ROLE/SUBSCRIPTION_NO_HOME are the two this suite exists to
        // guard, since both were silently absent from a heredoc the chapter never flagged as warning.
        const codes = r.warnings.map((w) => w.code);
        expect(codes).not.toContain("SUBSCRIPTION_NO_ROLE");
        expect(codes).not.toContain("SUBSCRIPTION_NO_HOME");
      });
    }
  }

  // Fault 1 (NOTES RAIL-UNREACHABLE): the finished studio is, byte for byte, the scenario that
  // motivated the fix — `add-command` (type `feature`, expecting product-brief/design/spec/code/
  // review) is pinned to `team: press`, and 4.6's press only ever grows to `produces: [product-brief,
  // review]` with members scribe (product-brief) and corvid (review). design/spec/code are genuinely
  // uncoverable by this studio as the guide leaves it — a legitimate configuration for a walkthrough
  // that never asked the reader to build a design/spec/code-producing member, but one `levare
  // validate` should name rather than stay silent about (see validate.ts#validateUncoverableExpectedKinds).
  test("the finished studio validates with zero warnings, other than the one this branch intentionally added", () => {
    const r = validatePath(root);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([
      {
        code: "UNCOVERABLE_EXPECTED_KIND",
        message:
          "unit 'add-command' (type 'feature') expects kind(s) [design, spec, code], but no member of its responsible team (press) declares producing any of them — this may be a legitimate configuration (a unit that only ever needs part of its type's shape), but the board's score rail will show these stage(s) as unreachable, never as merely queued",
        file: join(root, "work", "todo-cli", "add-command", "unit.md"),
      },
    ]);
  });
});

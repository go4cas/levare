import { test, expect, describe } from "bun:test";
import { validatePath } from "../src/validate.ts";

describe("golden fixture", () => {
  test("fixtures/golden validates clean", () => {
    const r = validatePath("fixtures/golden");
    if (!r.ok) console.error(r.errors);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.fileCount).toBeGreaterThan(10);
  });

  test("the checkout-flow spec is the open gate (in-review, consumes brief + design)", () => {
    // Sanity: the story the fixture tells matches PRD §4's example artifact.
    const r = validatePath("fixtures/golden/work/storefront/checkout-flow/spec-checkout-flow-v1.md");
    expect(r.ok).toBe(true);
  });
});

describe("levare validate CLI", () => {
  test("`levare validate fixtures/golden` prints 'valid' and exits 0", () => {
    const p = Bun.spawnSync(["./levare", "validate", "fixtures/golden"]);
    expect(p.exitCode).toBe(0);
    expect(p.stdout.toString().trim()).toBe("valid");
  });

  test("a rejection fixture exits 1 and reports the error code", () => {
    const p = Bun.spawnSync(["./levare", "validate", "fixtures/rejections/unknown-key"]);
    expect(p.exitCode).toBe(1);
    expect(p.stderr.toString()).toContain("UNKNOWN_KEY");
  });
});

// Each entry is a self-contained rejection fixture asserting one specific validator error.
// (PRD §11 phase-1 condition: ">= 12 rejection-fixture tests each asserting a specific error".)
const REJECTIONS: Array<[string, string]> = [
  ["malformed-frontmatter", "PARSE_ERROR"],
  ["unknown-key", "UNKNOWN_KEY"],
  ["dangling-consumes", "UNRESOLVED_CONSUMES"],
  ["dangling-supersedes", "UNRESOLVED_SUPERSEDES"],
  ["missing-field", "MISSING_FIELD"],
  ["bad-status", "BAD_ENUM"],
  ["wrong-type-consumes", "BAD_TYPE"],
  ["approved-without-approver", "APPROVED_WITHOUT_APPROVER"],
  ["bad-date", "BAD_DATE"],
  ["missing-file", "MISSING_FILE"],
  ["duplicate-id", "DUPLICATE_ID"],
  ["cross-project-consumes", "CROSS_PROJECT_CONSUMES"],
  ["index-count", "INDEX_COUNT"],
  ["approver-without-approval", "APPROVER_WITHOUT_APPROVAL"],
  ["agent-missing-model", "MISSING_FIELD"],
  ["team-bad-mode", "BAD_ENUM"],
];

describe("rejection fixtures", () => {
  for (const [dir, code] of REJECTIONS) {
    test(`${dir} → ${code}`, () => {
      const r = validatePath(`fixtures/rejections/${dir}`);
      expect(r.ok).toBe(false);
      const codes = r.errors.map((e) => e.code);
      expect(codes).toContain(code);
    });
  }
});

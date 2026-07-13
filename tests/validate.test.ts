import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  ["team-bad-mode", "REMOVED_FIELD"],
  ["team-unproducible-kind", "UNPRODUCIBLE_KIND"],
  ["unbindable-step", "UNBINDABLE_STEP"],
  ["cwd-outside-studio-no-inline", "CWD_OUTSIDE_STUDIO_NO_INLINE"],
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

// NOTES F1: `levare validate` used to say "valid" about a studio that could not run a single step —
// every per-file schema check passed while the one cross-entity fact the Runner rests on (a flow step
// binds to a member that declares it produces a matching kind) went unchecked until runtime. These
// assert the structural checks that make an unrunnable studio an INVALID studio.
describe("F1: a structurally unrunnable studio fails validation, naming what cannot bind", () => {
  test("a team promising a kind no member produces fails, naming the team, the kind, and the members", () => {
    const r = validatePath("fixtures/rejections/team-unproducible-kind");
    expect(r.ok).toBe(false);
    const err = r.errors.find((e) => e.code === "UNPRODUCIBLE_KIND");
    expect(err).toBeDefined();
    expect(err!.message).toContain("team 'orphan'");
    expect(err!.message).toContain("'findings'"); // the kind it promised
    expect(err!.message).toContain("scribe produces [report]"); // the members it actually has
    expect(err!.file).toContain("teams/orphan.md");
  });

  test("a flow step that binds to no member fails, naming the step, the team, and the members", () => {
    const r = validatePath("fixtures/rejections/unbindable-step");
    expect(r.ok).toBe(false);
    const err = r.errors.find((e) => e.code === "UNBINDABLE_STEP");
    expect(err).toBeDefined();
    expect(err!.message).toContain("flow step 'critique'");
    expect(err!.message).toContain("team 'drift'");
    expect(err!.message).toContain("scribe produces [report]");
  });

  test("an agent declaring an empty `produces` can bind to nothing and is rejected", () => {
    const dir = mkdtempSync(join(tmpdir(), "levare-empty-produces-"));
    try {
      mkdirSync(join(dir, "agents"), { recursive: true });
      writeFileSync(
        join(dir, "agents", "mute.md"),
        ["---", "name: mute", "kind: native", "produces: []", "model: claude-sonnet", "style:", "  avatar: Mu", "---", "", "Produces nothing.", ""].join("\n"),
      );
      const r = validatePath(dir);
      expect(r.ok).toBe(false);
      expect(r.errors.map((e) => e.code)).toContain("EMPTY_PRODUCES");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an agent with no `produces` field at all is a MISSING_FIELD, not a silent empty capability", () => {
    const dir = mkdtempSync(join(tmpdir(), "levare-no-produces-"));
    try {
      mkdirSync(join(dir, "agents"), { recursive: true });
      writeFileSync(
        join(dir, "agents", "quiet.md"),
        ["---", "name: quiet", "kind: native", "model: claude-sonnet", "style:", "  avatar: Qu", "---", "", "Declares no capability.", ""].join("\n"),
      );
      const r = validatePath(dir);
      expect(r.ok).toBe(false);
      expect(r.errors.some((e) => e.code === "MISSING_FIELD" && e.message.includes("produces"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the golden fixture — a studio that DOES bind end to end — still validates", () => {
    expect(validatePath("fixtures/golden").ok).toBe(true);
  });
});

// Ruling C9 (NOTES D6): an agent whose cwd resolves outside the studio root can never open a path
// §6 item 7 would hand it, unless it declares `context_artifacts: inline`. `levare validate` must
// reject the definition, naming the agent, its cwd, and the ruling — not discover this live.
describe("ruling C9: cwd outside the studio root requires `context_artifacts: inline`", () => {
  test("rejects, naming the agent, its cwd, and the ruling", () => {
    const r = validatePath("fixtures/rejections/cwd-outside-studio-no-inline");
    expect(r.ok).toBe(false);
    const err = r.errors.find((e) => e.code === "CWD_OUTSIDE_STUDIO_NO_INLINE");
    expect(err).toBeDefined();
    expect(err!.message).toContain("scratch"); // the agent
    expect(err!.message).toContain("/tmp"); // its cwd
    expect(err!.message).toContain("C9"); // the ruling
    expect(err!.file).toContain("agents/scratch.md");
  });

  test("an agent declaring `context_artifacts: inline` with the same outside cwd is accepted", () => {
    const dir = mkdtempSync(join(tmpdir(), "levare-cwd-inline-ok-"));
    try {
      mkdirSync(join(dir, "agents"), { recursive: true });
      writeFileSync(
        join(dir, "agents", "scratch.md"),
        [
          "---",
          "name: scratch",
          "kind: cli",
          "produces: [report]",
          "command: [gemini, -p, \"{task}\"]",
          "cwd: \"/tmp\"",
          "context_artifacts: inline",
          "timeout: 600",
          'result: "Emits a report artifact."',
          "style:",
          "  avatar: Sc",
          "---",
          "",
          "Runs outside the studio; declares inline per ruling C9.",
          "",
        ].join("\n"),
      );
      const r = validatePath(dir);
      expect(r.errors.map((e) => e.code)).not.toContain("CWD_OUTSIDE_STUDIO_NO_INLINE");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a cwd containing an unresolved `{...}` template is not statically checked (NOTES D9)", () => {
    // finch's own golden-fixture cwd (`{feature_repo}`) resolves only at spawn time; C9 must not
    // guess at where that will land.
    const r = validatePath("fixtures/golden");
    expect(r.errors.map((e) => e.code)).not.toContain("CWD_OUTSIDE_STUDIO_NO_INLINE");
  });

  test("the golden fixture's rook (isolated CLI research member) validates: inline + outside cwd", () => {
    expect(validatePath("fixtures/golden").ok).toBe(true);
  });
});

describe("PRD v1.1: `mode:` was removed from the team schema (invariant 7)", () => {
  test("a team definition declaring `mode:` fails validation with a REMOVED_FIELD error naming it and v1.1", () => {
    const r = validatePath("fixtures/rejections/team-bad-mode");
    expect(r.ok).toBe(false);
    const removed = r.errors.find((e) => e.code === "REMOVED_FIELD");
    // The diagnosis must name the field and the version — an old studio is told, not silently ignored.
    expect(removed).toBeDefined();
    expect(removed!.message).toContain("mode");
    expect(removed!.message).toContain("v1.1");
    // And it is NOT swallowed as a generic unknown key (which would give no explanation).
    expect(r.errors.some((e) => e.code === "UNKNOWN_KEY" && e.message.includes("mode"))).toBe(false);
  });
});

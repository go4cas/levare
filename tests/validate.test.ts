import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePath } from "../src/validate.ts";
import { loadPricing } from "../src/pricing.ts";
import { loadRepo } from "../src/repo.ts";

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
  // NOTES R4-SANDBOX: the real `./levare validate` subprocess now probes this host's OWN OS sandbox
  // primitives (never assumed from the platform) — fixtures/golden declares real `kind: cli` agents
  // (finch, rook), so on a host with no working bubblewrap/unshare (this container's own reality — see
  // sandbox.ts's header) it prints `SANDBOX_UNAVAILABLE` warnings after the "valid" line, exactly the
  // same "warnings never flip ok, print after valid" shape `REMOTE_NOT_IMPLEMENTED` already established
  // (see "the real CLI's `levare validate` prints the warning and still exits 0" below) — this asserts
  // the FIRST line and exit code, not exact whole-output equality, since a host WITH a working primitive
  // legitimately prints no warning at all here.
  test("`levare validate fixtures/golden` prints 'valid' and exits 0", () => {
    const p = Bun.spawnSync(["./levare", "validate", "fixtures/golden"]);
    expect(p.exitCode).toBe(0);
    expect(p.stdout.toString().split("\n")[0]).toBe("valid");
  });

  test("a rejection fixture exits 1 and reports the error code", () => {
    const p = Bun.spawnSync(["./levare", "validate", "fixtures/rejections/unknown-key"]);
    expect(p.exitCode).toBe(1);
    expect(p.stderr.toString()).toContain("UNKNOWN_KEY");
  });

  // UI4 item 2: the registry editor now shows the validator's human message ALONE (see
  // tests/board-editor-overlay.test.ts) — this is a display choice in the editor only. The CLI's own
  // output (src/cli.ts#formatResult), a grep target for scripts, is unchanged: code, then a
  // `file:line` locator (when the error carries one), then the message — proving one validator, one
  // rule set, two presentations rather than a second, quietly-diverging implementation.
  test("`levare validate` output is unchanged: it still prints the error CODE and a file:line locator, not just the message", () => {
    const p = Bun.spawnSync(["./levare", "validate", "fixtures/rejections/malformed-frontmatter"]);
    expect(p.exitCode).toBe(1);
    const stderr = p.stderr.toString();
    expect(stderr).toContain("PARSE_ERROR");
    expect(stderr).toContain("fixtures/rejections/malformed-frontmatter/work/storefront/checkout-flow/bad.md:7");
    expect(stderr).toContain("frontmatter is not terminated by a closing '---' fence (line 7)");
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
  ["loop-until-unreachable", "LOOP_UNTIL_UNREACHABLE"],
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
        ["---", "name: mute", "kind: native", "produces: []", "model: claude-sonnet-5", "style:", "  avatar: Mu", "---", "", "Produces nothing.", ""].join("\n"),
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
        ["---", "name: quiet", "kind: native", "model: claude-sonnet-5", "style:", "  avatar: Qu", "---", "", "Declares no capability.", ""].join("\n"),
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

// levare's model is one team per agent: teams are reused across projects, but an agent is never
// reused across teams. `teamOf` (env.ts) resolves a member's team by returning the FIRST team that
// lists it in `members` — so a two-team agent silently got only that first team's connector grants
// and charter everywhere else, a silent-wrong-answer bug rather than a crash. `levare validate` must
// name it instead, never let it pass quietly.
describe("one team per agent: an agent listed in more than one team's members is rejected", () => {
  test("AGENT_IN_MULTIPLE_TEAMS names the agent and every team that lists it", () => {
    const dir = mkdtempSync(join(tmpdir(), "levare-agent-multiple-teams-"));
    try {
      mkdirSync(join(dir, "teams"), { recursive: true });
      writeFileSync(
        join(dir, "teams", "press.md"),
        ["---", "name: press", "consumes: []", "produces: [report]", "members: [scribe]", "flow:", "  - step: report", "style:", "  color: '#111111'", "---", "", "# Press", ""].join("\n"),
      );
      writeFileSync(
        join(dir, "teams", "docs.md"),
        ["---", "name: docs", "consumes: []", "produces: [manual]", "members: [scribe]", "flow:", "  - step: manual", "style:", "  color: '#222222'", "---", "", "# Docs", ""].join("\n"),
      );
      const r = validatePath(dir);
      expect(r.ok).toBe(false);
      const err = r.errors.find((e) => e.code === "AGENT_IN_MULTIPLE_TEAMS");
      expect(err).toBeDefined();
      expect(err!.message).toContain("scribe"); // the agent
      expect(err!.message).toContain("docs"); // every team that lists it
      expect(err!.message).toContain("press");
      expect(err!.message).toContain("scribe-press"); // the duplicate-and-rename pattern
      expect(err!.message).toContain("scribe-docs");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an agent listed in exactly one team's members is unaffected", () => {
    const dir = mkdtempSync(join(tmpdir(), "levare-agent-single-team-"));
    try {
      mkdirSync(join(dir, "teams"), { recursive: true });
      writeFileSync(
        join(dir, "teams", "press.md"),
        ["---", "name: press", "consumes: []", "produces: [report]", "members: [scribe]", "flow:", "  - step: report", "style:", "  color: '#111111'", "---", "", "# Press", ""].join("\n"),
      );
      const r = validatePath(dir);
      expect(r.errors.map((e) => e.code)).not.toContain("AGENT_IN_MULTIPLE_TEAMS");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the golden fixture — no agent shared across teams — has no AGENT_IN_MULTIPLE_TEAMS error", () => {
    const r = validatePath("fixtures/golden");
    expect(r.errors.map((e) => e.code)).not.toContain("AGENT_IN_MULTIPLE_TEAMS");
  });
});

// Ruling F16: a loop must never be permitted to declare an `until` it could never satisfy — no round
// either of its own two members ever runs could make it true, so the walk would sit at that loop
// forever, or (the live-found worse case) silently fall through past it once both members happen to
// resolve for unrelated reasons. This is a studio definition error, caught here, never a live surprise.
describe("F16: a loop's `until` must name one of its own two members' kinds, or it can never be satisfied", () => {
  test("`until` naming neither loop member fails, naming the team, the loop, and what `until` actually resolved to", () => {
    const r = validatePath("fixtures/rejections/loop-until-unreachable");
    expect(r.ok).toBe(false);
    const err = r.errors.find((e) => e.code === "LOOP_UNTIL_UNREACHABLE");
    expect(err).toBeDefined();
    expect(err!.message).toContain("team 'press'");
    expect(err!.message).toContain("[product-brief, review]");
    expect(err!.message).toContain("until 'approval.approved'");
    expect(err!.message).toContain("'approval'");
    expect(err!.file).toContain("teams/press.md");
  });

  test("`until` naming the loop's FIRST member (kestrel's own `until: spec.approved`) validates clean", () => {
    expect(validatePath("fixtures/golden").ok).toBe(true);
  });

  test("`until` naming the loop's SECOND member also validates clean — the check isn't hardcoded to 'first'", () => {
    const dir = mkdtempSync(join(tmpdir(), "levare-loop-until-second-"));
    try {
      mkdirSync(join(dir, "agents"), { recursive: true });
      mkdirSync(join(dir, "teams"), { recursive: true });
      writeFileSync(
        join(dir, "agents", "scribe.md"),
        ["---", "name: scribe", "kind: native", "produces: [product-brief]", "model: claude-sonnet-5", "style:", "  avatar: Sc", "---", "", "Drafts.", ""].join("\n"),
      );
      writeFileSync(
        join(dir, "agents", "corvid.md"),
        ["---", "name: corvid", "kind: native", "produces: [review]", "model: claude-sonnet-5", "style:", "  avatar: Co", "---", "", "Reviews.", ""].join("\n"),
      );
      writeFileSync(
        join(dir, "teams", "press.md"),
        [
          "---",
          "name: press",
          "consumes: []",
          "produces: [product-brief, review]",
          "members: [scribe, corvid]",
          "flow:",
          "  - loop:",
          "      between: [product-brief, review]",
          "      until: review.approved",
          "      max_rounds: 3",
          "      on_exhaust: gate",
          "style:",
          "  color: '#4B2E83'",
          "---",
          "",
          "# Press",
          "",
        ].join("\n"),
      );
      const r = validatePath(dir);
      expect(r.errors.map((e) => e.code)).not.toContain("LOOP_UNTIL_UNREACHABLE");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

// Ruling C12/F10 defect 2: the live "press vs. kestrel" dogfood bug — a second team declaring the same
// `produces:` kind a unit's type expects was silently resolved at runtime by gates.ts's own
// produces∩expects scoring, never surfaced. `levare validate` must refuse to guess.
describe("F10 defect 2: two teams producing the same kind a unit needs is AMBIGUOUS_PRODUCER, never guessed", () => {
  function buildStudio(unitTeam?: string): string {
    const dir = mkdtempSync(join(tmpdir(), "levare-ambiguous-producer-"));
    mkdirSync(join(dir, "teams"), { recursive: true });
    mkdirSync(join(dir, "agents"), { recursive: true });
    mkdirSync(join(dir, "types"), { recursive: true });
    mkdirSync(join(dir, "work", "acme", "launch"), { recursive: true });
    writeFileSync(
      join(dir, "agents", "wren.md"),
      ["---", "name: wren", "kind: native", "produces: [product-brief]", "model: claude-sonnet-5", "style:", "  avatar: Wr", "---", "", "Wren.", ""].join("\n"),
    );
    writeFileSync(
      join(dir, "agents", "scribe.md"),
      ["---", "name: scribe", "kind: native", "produces: [product-brief]", "model: claude-sonnet-5", "style:", "  avatar: Sc", "---", "", "Scribe.", ""].join("\n"),
    );
    writeFileSync(
      join(dir, "teams", "kestrel.md"),
      ["---", "name: kestrel", "consumes: []", "produces: [product-brief]", "members: [wren]", "flow:", "  - step: brief", "style:", "  color: '#000'", "---", "", "Kestrel.", ""].join("\n"),
    );
    writeFileSync(
      join(dir, "teams", "press.md"),
      ["---", "name: press", "consumes: []", "produces: [product-brief]", "members: [scribe]", "flow:", "  - step: brief", "style:", "  color: '#111'", "---", "", "Press.", ""].join("\n"),
    );
    writeFileSync(
      join(dir, "types", "feature.md"),
      ["---", "name: feature", "glyph: '▸'", "expects: [product-brief]", "gates: []", "---", "", "Feature.", ""].join("\n"),
    );
    const teamLine = unitTeam ? `\nteam: ${unitTeam}` : "";
    writeFileSync(
      join(dir, "work", "acme", "launch", "unit.md"),
      `---\ntype: feature\nstatus: active${teamLine}\n---\n\n# launch\n\nAmbiguous-producer test fixture.\n`,
    );
    return dir;
  }

  test("no team: override → AMBIGUOUS_PRODUCER, naming the kind and both teams", () => {
    const dir = buildStudio();
    try {
      const r = validatePath(dir);
      expect(r.ok).toBe(false);
      const err = r.errors.find((e) => e.code === "AMBIGUOUS_PRODUCER");
      expect(err).toBeDefined();
      expect(err!.message).toContain("product-brief");
      expect(err!.message).toContain("kestrel");
      expect(err!.message).toContain("press");
      expect(err!.file).toContain("work/acme/launch/unit.md");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("team: press disambiguates — no AMBIGUOUS_PRODUCER, and press validates as the responsible team", () => {
    const dir = buildStudio("press");
    try {
      const r = validatePath(dir);
      expect(r.errors.map((e) => e.code)).not.toContain("AMBIGUOUS_PRODUCER");
      expect(r.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("team: naming a team that doesn't exist fails with UNKNOWN_TEAM", () => {
    const dir = buildStudio("ghost-team");
    try {
      const r = validatePath(dir);
      const err = r.errors.find((e) => e.code === "UNKNOWN_TEAM");
      expect(err).toBeDefined();
      expect(err!.message).toContain("ghost-team");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // RENAME-ORPHANS-REFERENCES: the minimal cross-reference hint. A rename is unmistakable when a
  // team file still sits at the old name's path but its own `name:` field now says something else —
  // that's the one signal the fix checks for, deliberately not a broader "looks similar" guess.
  test("UNKNOWN_TEAM gets a rename hint when teams/<old-name>.md still exists but now declares a different name", () => {
    const dir = buildStudio("kestrel");
    try {
      // Simulate the rename: kestrel's OWN `name:` field changed to 'raven', but the file is still
      // teams/kestrel.md and the unit (built above) still says `team: kestrel` — exactly what a
      // rename that updated the entity but missed a reference looks like on disk.
      writeFileSync(
        join(dir, "teams", "kestrel.md"),
        ["---", "name: raven", "consumes: []", "produces: [product-brief]", "members: [wren]", "flow:", "  - step: brief", "style:", "  color: '#000'", "---", "", "Kestrel, renamed to raven.", ""].join("\n"),
      );
      const r = validatePath(dir);
      const err = r.errors.find((e) => e.code === "UNKNOWN_TEAM");
      expect(err).toBeDefined();
      expect(err!.message).toContain("no such team is defined");
      expect(err!.message).toContain("if you renamed an entity");
      expect(err!.message).toContain("1 reference(s) still point at 'kestrel'");
      expect(err!.message).toContain("now declares name: 'raven'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The contrasting negative case: an ordinary typo/missing-reference name with no entity file at
  // all behind it must NOT get a rename hint — there's no evidence to hint from, so hinting would be
  // a wild guess, which the goal explicitly rules out.
  test("UNKNOWN_TEAM gets NO rename hint for an ordinary typo — no file exists under the unresolved name at all", () => {
    const dir = buildStudio("ghost-team");
    try {
      const r = validatePath(dir);
      const err = r.errors.find((e) => e.code === "UNKNOWN_TEAM");
      expect(err).toBeDefined();
      expect(err!.message).toContain("no such team is defined");
      expect(err!.message).not.toContain("if you renamed an entity");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("team: naming a real team that can't produce what the type expects fails with TEAM_CANNOT_PRODUCE", () => {
    const dir = buildStudio();
    try {
      // A third team that exists but produces something irrelevant to `feature`'s expects.
      writeFileSync(
        join(dir, "agents", "smith.md"),
        ["---", "name: smith", "kind: native", "produces: [code]", "model: claude-sonnet-5", "style:", "  avatar: Sm", "---", "", "Smith.", ""].join("\n"),
      );
      writeFileSync(
        join(dir, "teams", "forge.md"),
        ["---", "name: forge", "consumes: []", "produces: [code]", "members: [smith]", "flow:", "  - step: code", "style:", "  color: '#222'", "---", "", "Forge.", ""].join("\n"),
      );
      writeFileSync(
        join(dir, "work", "acme", "launch", "unit.md"),
        "---\ntype: feature\nstatus: active\nteam: forge\n---\n\n# launch\n\nAmbiguous-producer test fixture.\n",
      );
      const r = validatePath(dir);
      const err = r.errors.find((e) => e.code === "TEAM_CANNOT_PRODUCE");
      expect(err).toBeDefined();
      expect(err!.message).toContain("forge");
      expect(err!.message).toContain("product-brief");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

// NOTES F11: `model:` was decorative — declared but never enforced, and never validated. This closes
// the validation half: a model levare cannot price cannot be declared, named at `levare validate` time
// (never discovered live), and a CLI agent whose command template can never actually receive its
// declared model is refused the same way.
describe("F11: known-model validation — a model that cannot be priced cannot be declared", () => {
  function buildStudio(opts: {
    agentModel?: string;
    agentKind?: "native" | "cli";
    command?: string;
    studioModel?: string;
    withPricing?: boolean;
    connectors?: Array<{ name: string; auth: "env" | "subscription"; env?: string[]; role?: "model" | "tool" }>;
    agentConnectors?: string[];
  }): string {
    const dir = mkdtempSync(join(tmpdir(), "levare-known-model-"));
    mkdirSync(join(dir, "agents"), { recursive: true });
    if (opts.withPricing !== false) {
      mkdirSync(join(dir, "knowledge"), { recursive: true });
      writeFileSync(
        join(dir, "knowledge", "model-pricing.md"),
        ["---", "name: model-pricing", "---", "", "| model | tokens_in (/M) | tokens_out (/M) |", "| --- | --- | --- |", "| claude-sonnet-5 | 3.00 | 15.00 |", ""].join("\n"),
      );
    }
    if (opts.connectors) {
      mkdirSync(join(dir, "connectors"), { recursive: true });
      for (const c of opts.connectors) {
        const envLine = `env: [${(c.env ?? []).join(", ")}]`;
        const roleLine = c.role ? [`role: ${c.role}`] : [];
        writeFileSync(
          join(dir, "connectors", `${c.name}.md`),
          ["---", `name: ${c.name}`, "kind: cli", `command: ${c.name}`, `auth: ${c.auth}`, envLine, ...roleLine, "---", "", `# ${c.name}`, ""].join("\n"),
        );
      }
    }
    const kind = opts.agentKind ?? "native";
    const lines = ["---", "name: scribe", `kind: ${kind}`, "produces: [report]"];
    if (opts.agentModel !== undefined) lines.push(`model: ${opts.agentModel}`);
    if (kind === "cli") {
      lines.push(`command: [${opts.command ?? "codex, review"}]`, 'result: "emits a report"');
    }
    if (opts.agentConnectors) lines.push(`connectors: [${opts.agentConnectors.join(", ")}]`);
    lines.push("style:", "  avatar: Sc", "---", "", "Scribe.", "");
    writeFileSync(join(dir, "agents", "scribe.md"), lines.join("\n"));
    if (opts.studioModel !== undefined) {
      writeFileSync(join(dir, "studio.md"), `---\norchestrator_model: ${opts.studioModel}\n---\n\n# Studio\n`);
    }
    return dir;
  }

  test("an agent declaring an unknown model fails validation with UNKNOWN_MODEL, naming the agent and the model", () => {
    const dir = buildStudio({ agentModel: "claude-sonnet" }); // not in the known set
    try {
      const r = validatePath(dir);
      expect(r.ok).toBe(false);
      const err = r.errors.find((e) => e.code === "UNKNOWN_MODEL");
      expect(err).toBeDefined();
      expect(err!.message).toContain("scribe");
      expect(err!.message).toContain("claude-sonnet");
      expect(err!.file).toContain("agents/scribe.md");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an agent declaring a known, priced model validates clean", () => {
    const dir = buildStudio({ agentModel: "claude-sonnet-5" });
    try {
      const r = validatePath(dir);
      expect(r.errors.map((e) => e.code)).not.toContain("UNKNOWN_MODEL");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // NOTES F23 (ruling): levare ships a baseline pricing table IN THE BINARY, so this no longer fails
  // open — a fresh studio with no knowledge/model-pricing.md of its own is still checked against every
  // real, currently-callable model the binary knows, closing the exact gap that let a freshly-`levare
  // init`'d studio validate clean while declaring `claude-sonnet`/`claude-opus` (neither a real id).
  test("with no knowledge/model-pricing.md at all, the binary's own baseline table still catches an unknown model", () => {
    const dir = buildStudio({ agentModel: "totally-made-up-model", withPricing: false });
    try {
      const r = validatePath(dir);
      expect(r.errors.map((e) => e.code)).toContain("UNKNOWN_MODEL");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("...and a real baseline model validates clean with no studio pricing file at all", () => {
    const dir = buildStudio({ agentModel: "claude-sonnet-5", withPricing: false });
    try {
      const r = validatePath(dir);
      expect(r.errors.map((e) => e.code)).not.toContain("UNKNOWN_MODEL");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a studio's own knowledge/model-pricing.md EXTENDS the baseline — a custom/self-hosted model it names validates clean", () => {
    const dir = buildStudio({ agentModel: "totally-made-up-model", withPricing: false });
    try {
      mkdirSync(join(dir, "knowledge"), { recursive: true });
      writeFileSync(
        join(dir, "knowledge", "model-pricing.md"),
        ["---", "name: model-pricing", "---", "", "| model | tokens_in (/M) | tokens_out (/M) |", "| --- | --- | --- |", "| totally-made-up-model | 1.00 | 1.00 |", ""].join("\n"),
      );
      const r = validatePath(dir);
      expect(r.errors.map((e) => e.code)).not.toContain("UNKNOWN_MODEL");
      // The baseline is still active alongside the studio's own extension — a genuinely unknown model
      // (never declared by any agent here, but checked the same way) would still fail were it declared.
      expect(loadPricing(dir).has("claude-sonnet-5")).toBe(true);
      expect(loadPricing(dir).has("totally-made-up-model")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the studio's orchestrator_model is validated the same way — unknown model fails UNKNOWN_MODEL naming studio.md", () => {
    const dir = buildStudio({ agentModel: "claude-sonnet-5", studioModel: "gpt-nonsense" });
    try {
      const r = validatePath(dir);
      expect(r.ok).toBe(false);
      const err = r.errors.find((e) => e.code === "UNKNOWN_MODEL" && e.file.endsWith("studio.md"));
      expect(err).toBeDefined();
      expect(err!.message).toContain("gpt-nonsense");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the studio's orchestrator_model in the known set validates clean", () => {
    const dir = buildStudio({ agentModel: "claude-sonnet-5", studioModel: "claude-sonnet-5" });
    try {
      const r = validatePath(dir);
      expect(r.errors.map((e) => e.code)).not.toContain("UNKNOWN_MODEL");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a cli agent declaring a model with no {model} placeholder in its command template fails MODEL_PLACEHOLDER_MISSING", () => {
    const dir = buildStudio({ agentKind: "cli", agentModel: "claude-sonnet-5", command: "codex, review, --input, '{task}'" });
    try {
      const r = validatePath(dir);
      expect(r.ok).toBe(false);
      const err = r.errors.find((e) => e.code === "MODEL_PLACEHOLDER_MISSING");
      expect(err).toBeDefined();
      expect(err!.message).toContain("scribe");
      expect(err!.message).toContain("claude-sonnet-5");
      expect(err!.file).toContain("agents/scribe.md");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a cli agent whose command template DOES carry {model} validates clean on that front", () => {
    const dir = buildStudio({ agentKind: "cli", agentModel: "claude-sonnet-5", command: "codex, review, --model, '{model}'" });
    try {
      const r = validatePath(dir);
      expect(r.errors.map((e) => e.code)).not.toContain("MODEL_PLACEHOLDER_MISSING");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a cli agent declaring no model at all is never subject to MODEL_PLACEHOLDER_MISSING", () => {
    const dir = buildStudio({ agentKind: "cli", command: "codex, review, --input, '{task}'" });
    try {
      const r = validatePath(dir);
      expect(r.errors.map((e) => e.code)).not.toContain("MODEL_PLACEHOLDER_MISSING");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // NOTES C15 (re-keyed from C13): a member whose model arrives through a connector is unpriceable
  // by definition, not by an accounting gap, so UNKNOWN_MODEL must not fire for it — and that is a
  // fact about the connector's ROLE (what it's granted for), not its auth mode (how it authenticates).
  test("an agent granted a role: model connector (auth: subscription) is exempt from UNKNOWN_MODEL", () => {
    const dir = buildStudio({
      agentKind: "cli",
      agentModel: "codex-cli-5",
      command: "codex, review, --model, '{model}'",
      connectors: [{ name: "codex", auth: "subscription", role: "model" }],
      agentConnectors: ["codex"],
    });
    try {
      const r = validatePath(dir);
      expect(r.errors.map((e) => e.code)).not.toContain("UNKNOWN_MODEL");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The other direction of the re-key: a role: model connector that authenticates via `auth: env`
  // (e.g. a hosted-model API key) exempts its granted agent exactly the same way a subscription one
  // does — the exemption follows `role: model`, never `auth: subscription` specifically.
  test("an agent granted a role: model connector authenticated via auth: env is ALSO exempt from UNKNOWN_MODEL", () => {
    const dir = buildStudio({
      agentKind: "cli",
      agentModel: "hosted-model-x",
      command: "hosted, review, --model, '{model}'",
      connectors: [{ name: "hosted", auth: "env", env: ["HOSTED_MODEL_KEY"], role: "model" }],
      agentConnectors: ["hosted"],
    });
    try {
      const r = validatePath(dir);
      expect(r.errors.map((e) => e.code)).not.toContain("UNKNOWN_MODEL");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The C13-era proxy over-exempted: a subscription TOOL connector (no model access at all) must no
  // longer exempt its granted agent's model from pricing validation — only `role: model` does.
  test("an agent granted an auth: subscription connector with NO explicit role (default tool) is NOT exempt — a subscription tool connector must not exempt a model", () => {
    const dir = buildStudio({
      agentKind: "cli",
      agentModel: "codex-cli-5",
      command: "codex, review, --model, '{model}'",
      connectors: [{ name: "codex", auth: "subscription" }], // no role: defaults to "tool"
      agentConnectors: ["codex"],
    });
    try {
      const r = validatePath(dir);
      expect(r.errors.map((e) => e.code)).toContain("UNKNOWN_MODEL");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // An agent NOT granted the model connector still gets the ordinary UNKNOWN_MODEL check —
  // the exemption follows the grant, not the mere existence of a model connector elsewhere.
  test("an agent NOT granted the role: model connector is still subject to UNKNOWN_MODEL", () => {
    const dir = buildStudio({
      agentModel: "codex-cli-5",
      connectors: [{ name: "codex", auth: "subscription", role: "model" }],
      // no agentConnectors: scribe is granted nothing.
    });
    try {
      const r = validatePath(dir);
      expect(r.errors.map((e) => e.code)).toContain("UNKNOWN_MODEL");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// NOTES C13: connectors declare how they authenticate. `auth: env` (default) requires a non-empty
// `env:` list — levare enforces that grant. `auth: subscription` means the backend authenticates
// itself from its own stored credentials — `env:` must be empty, because there is nothing for
// levare to inject or scope. Both misdeclarations are definition errors, caught at validate time.
describe("C13: connector auth mode", () => {
  function connectorStudio(frontmatterExtra: string): string {
    const dir = mkdtempSync(join(tmpdir(), "levare-connector-auth-"));
    mkdirSync(join(dir, "connectors"), { recursive: true });
    writeFileSync(
      join(dir, "connectors", "codex.md"),
      ["---", "name: codex", "kind: cli", "command: codex", frontmatterExtra, "---", "", "# Codex connector", ""].join("\n"),
    );
    return dir;
  }

  test("a subscription connector with an empty env list validates clean", () => {
    const dir = connectorStudio('auth: subscription\nenv: []\nplan: "ChatGPT Plus — flat monthly rate"');
    try {
      const r = validatePath(dir);
      expect(r.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a subscription connector with NO env field at all also validates clean (absent is allowed)", () => {
    const dir = mkdtempSync(join(tmpdir(), "levare-connector-auth-"));
    try {
      mkdirSync(join(dir, "connectors"), { recursive: true });
      writeFileSync(
        join(dir, "connectors", "codex.md"),
        ["---", "name: codex", "kind: cli", "command: codex", "auth: subscription", "---", "", "# Codex connector", ""].join("\n"),
      );
      const r = validatePath(dir);
      expect(r.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a subscription connector that ALSO declares env vars is rejected — nothing to declare, levare cannot scope it either way", () => {
    const dir = connectorStudio("auth: subscription\nenv: [CODEX_TOKEN]");
    try {
      const r = validatePath(dir);
      expect(r.ok).toBe(false);
      const err = r.errors.find((e) => e.code === "SUBSCRIPTION_WITH_ENV");
      expect(err).toBeDefined();
      expect(err!.message).toContain("codex");
      expect(err!.message).toContain("CODEX_TOKEN");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an env connector (default auth) with no env vars is rejected — nothing for levare to inject or scope", () => {
    const dir = connectorStudio("env: []");
    try {
      const r = validatePath(dir);
      expect(r.ok).toBe(false);
      const err = r.errors.find((e) => e.code === "EMPTY_ENV");
      expect(err).toBeDefined();
      expect(err!.message).toContain("codex");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an explicit auth: env connector with no env vars is rejected the same way", () => {
    const dir = connectorStudio("auth: env\nenv: []");
    try {
      const r = validatePath(dir);
      expect(r.ok).toBe(false);
      expect(r.errors.map((e) => e.code)).toContain("EMPTY_ENV");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an env connector naming at least one var validates clean — unchanged, default behaviour", () => {
    const dir = connectorStudio("env: [CODEX_TOKEN]");
    try {
      const r = validatePath(dir);
      expect(r.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unrecognised auth value is rejected by the ordinary enum check, not silently accepted", () => {
    const dir = connectorStudio("auth: oauth\nenv: [CODEX_TOKEN]");
    try {
      const r = validatePath(dir);
      expect(r.ok).toBe(false);
      expect(r.errors.some((e) => e.code === "BAD_ENUM" && e.message.includes("auth"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// NOTES C15: a connector declares its ROLE (model | tool) — what function it serves — distinct from
// `kind` (the transport: mcp/cli) and never confused with `type` (reserved for domain templates).
// Optional, defaulting to "tool" (the common case). Existing pre-C15 connectors, none of which
// declare `role:`, are unaffected by the default; only a subscription connector with no explicit
// role gets a migration warning (below), since silently defaulting THAT case would mislabel exactly
// the connector shape this ruling exists to name correctly.
describe("C15: connector role", () => {
  function roleStudio(frontmatterExtra: string): string {
    const dir = mkdtempSync(join(tmpdir(), "levare-connector-role-"));
    mkdirSync(join(dir, "connectors"), { recursive: true });
    writeFileSync(
      join(dir, "connectors", "codex.md"),
      ["---", "name: codex", "kind: cli", "command: codex", frontmatterExtra, "---", "", "# Codex connector", ""].join("\n"),
    );
    return dir;
  }

  test("a connector with no role: at all validates clean, defaulting to tool", () => {
    const dir = roleStudio("env: [CODEX_TOKEN]");
    try {
      const r = validatePath(dir);
      expect(r.ok).toBe(true);
      expect(loadRepo(dir).connectors.get("codex")!.role).toBe("tool");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("role: model validates clean and resolves to 'model'", () => {
    const dir = roleStudio("env: [CODEX_TOKEN]\nrole: model");
    try {
      const r = validatePath(dir);
      expect(r.ok).toBe(true);
      expect(loadRepo(dir).connectors.get("codex")!.role).toBe("model");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("role: tool validates clean and resolves to 'tool'", () => {
    const dir = roleStudio("env: [CODEX_TOKEN]\nrole: tool");
    try {
      const r = validatePath(dir);
      expect(r.ok).toBe(true);
      expect(loadRepo(dir).connectors.get("codex")!.role).toBe("tool");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unrecognised role value is rejected by the ordinary enum check, not silently accepted", () => {
    const dir = roleStudio("env: [CODEX_TOKEN]\nrole: orchestrator");
    try {
      const r = validatePath(dir);
      expect(r.ok).toBe(false);
      expect(r.errors.some((e) => e.code === "BAD_ENUM" && e.message.includes("role"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // NOTES C15 item 3 (migration honesty): a pre-C15 subscription connector defaults to role: tool —
  // which would silently mislabel it if it actually grants model access. A warning (never an error:
  // the declaration is legal) names exactly this gap, and fires ONLY when role is genuinely absent.
  test("a subscription connector with no role: declared gets a SUBSCRIPTION_NO_ROLE warning, naming it", () => {
    const dir = roleStudio('auth: subscription\nenv: []\nplan: "ChatGPT Plus — flat monthly rate"');
    try {
      const r = validatePath(dir);
      expect(r.ok).toBe(true); // legal declaration — a warning, never an error
      const warning = r.warnings.find((w) => w.code === "SUBSCRIPTION_NO_ROLE");
      expect(warning).toBeDefined();
      expect(warning!.message).toContain("codex");
      expect(warning!.message).toContain("role: model");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an explicit role: model on a subscription connector silences the warning", () => {
    const dir = roleStudio('auth: subscription\nenv: []\nrole: model\nplan: "ChatGPT Plus — flat monthly rate"');
    try {
      const r = validatePath(dir);
      expect(r.warnings.map((w) => w.code)).not.toContain("SUBSCRIPTION_NO_ROLE");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an explicit role: tool on a subscription connector ALSO silences the warning — any explicit declaration is enough", () => {
    const dir = roleStudio('auth: subscription\nenv: []\nrole: tool\nplan: "ChatGPT Plus — flat monthly rate"');
    try {
      const r = validatePath(dir);
      expect(r.warnings.map((w) => w.code)).not.toContain("SUBSCRIPTION_NO_ROLE");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an auth: env connector with no role: declared gets no SUBSCRIPTION_NO_ROLE warning — the gap is specific to subscription connectors", () => {
    const dir = roleStudio("env: [CODEX_TOKEN]");
    try {
      const r = validatePath(dir);
      expect(r.warnings.map((w) => w.code)).not.toContain("SUBSCRIPTION_NO_ROLE");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// NOTES MCP-1B (narrowed from REV1 finding 3): `kind: remote` validates cleanly — it's a legal
// declaration — but only produces real work through a real, granted, stdio `kind: mcp` connector.
// `levare validate` must warn, never reject, and never stay silent about the gap; a working stdio
// connector, granted, gets NO such warning at all.
describe("kind: remote — legal, valid, and warned about (NOTES MCP-1B)", () => {
  function remoteAgentDoc(server = "echo-mcp"): string {
    return ["---", "name: echo", "kind: remote", "produces: [report]", `server: ${server}`, "tool: echo", "style:", "  avatar: Ec", "---", "", "A remote member.", ""].join("\n");
  }

  test("a remote agent naming an unknown connector validates ok, with a REMOTE_NOT_IMPLEMENTED warning naming it", () => {
    const dir = mkdtempSync(join(tmpdir(), "levare-remote-agent-"));
    try {
      mkdirSync(join(dir, "agents"), { recursive: true });
      writeFileSync(join(dir, "agents", "echo.md"), remoteAgentDoc());
      const r = validatePath(dir);
      expect(r.ok).toBe(true);
      expect(r.errors).toEqual([]);
      expect(r.warnings.map((w) => w.code)).toContain("REMOTE_NOT_IMPLEMENTED");
      const w = r.warnings.find((w) => w.code === "REMOTE_NOT_IMPLEMENTED")!;
      expect(w.message).toContain("echo");
      expect(w.message).toContain("not a known connector");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a remote agent missing 'tool' is a MISSING_FIELD error, not merely a warning", () => {
    const dir = mkdtempSync(join(tmpdir(), "levare-remote-notool-"));
    try {
      mkdirSync(join(dir, "agents"), { recursive: true });
      writeFileSync(
        join(dir, "agents", "echo.md"),
        ["---", "name: echo", "kind: remote", "produces: [report]", "server: echo-mcp", "style:", "  avatar: Ec", "---", "", "A remote member.", ""].join("\n"),
      );
      const r = validatePath(dir);
      expect(r.ok).toBe(false);
      expect(r.errors.map((e) => e.code)).toContain("MISSING_FIELD");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a remote agent backed by a real, granted, stdio kind: mcp connector carries NO remote warning", () => {
    const dir = mkdtempSync(join(tmpdir(), "levare-remote-implemented-"));
    try {
      mkdirSync(join(dir, "agents"), { recursive: true });
      mkdirSync(join(dir, "connectors"), { recursive: true });
      // Agent-level `connectors:` grant, so the cross-entity grant check passes too.
      writeFileSync(
        join(dir, "agents", "echo.md"),
        ["---", "name: echo", "kind: remote", "produces: [report]", "server: everything", "tool: echo", "connectors: [everything]", "style:", "  avatar: Ec", "---", "", "A remote member.", ""].join(
          "\n",
        ),
      );
      writeFileSync(
        join(dir, "connectors", "everything.md"),
        [
          "---",
          "name: everything",
          "kind: mcp",
          // NOTES MCP-1C addendum 6: a resolved, path-referenced argv — a bunx/npx-style fetch-at-dispatch
          // launcher would ALSO carry a (separate) MCP_FETCH_AT_DISPATCH warning, which this test isn't
          // about; see the dedicated describe block below for that check.
          'argv: ["/opt/mcp-servers/everything-server", "stdio"]',
          "env: [EVERYTHING_TOKEN]",
          "role: tool",
          "---",
          "",
          "An mcp connector.",
          "",
        ].join("\n"),
      );
      const r = validatePath(dir);
      expect(r.ok).toBe(true);
      expect(r.warnings.map((w) => w.code)).not.toContain("REMOTE_NOT_IMPLEMENTED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a native/cli agent carries no such warning", () => {
    const dir = mkdtempSync(join(tmpdir(), "levare-native-agent-"));
    try {
      mkdirSync(join(dir, "agents"), { recursive: true });
      writeFileSync(
        join(dir, "agents", "scribe.md"),
        ["---", "name: scribe", "kind: native", "produces: [report]", "model: claude-sonnet-5", "style:", "  avatar: Sc", "---", "", "A native member.", ""].join("\n"),
      );
      const r = validatePath(dir);
      expect(r.ok).toBe(true);
      expect(r.warnings).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the real CLI's `levare validate` prints the warning and still exits 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "levare-remote-cli-"));
    try {
      mkdirSync(join(dir, "agents"), { recursive: true });
      writeFileSync(join(dir, "agents", "echo.md"), remoteAgentDoc());
      const p = Bun.spawnSync(["./levare", "validate", dir], { env: process.env });
      expect(p.exitCode).toBe(0);
      const out = p.stdout.toString();
      expect(out).toContain("valid");
      expect(out).toContain("warning");
      expect(out).toContain("REMOTE_NOT_IMPLEMENTED");
      expect(out).toContain("not a known connector");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // NOTES MCP-1C (PRD Amendment 3, ruling R3): a FULLY implemented remote agent (a real, granted,
  // stdio kind: mcp connector — the exact shape "carries NO remote warning" above proves) now spawns a
  // real process levare itself sandboxes — so it earns the SAME SANDBOX_UNAVAILABLE telling a `kind:
  // cli` agent already gets, mirroring validate.ts#validateAgentSandboxWarning's own cli-only warning
  // one level up, in the tree-wide remote-implementation pass (validateAgentRemoteImplementation).
  describe("SANDBOX_UNAVAILABLE for a fully implemented remote agent (NOTES MCP-1C)", () => {
    const NONE_DETECTION = { platform: "linux", primitive: "none", level: "none" } as const;

    function implementedRemoteDir(): string {
      const dir = mkdtempSync(join(tmpdir(), "levare-remote-sandbox-"));
      mkdirSync(join(dir, "agents"), { recursive: true });
      mkdirSync(join(dir, "connectors"), { recursive: true });
      writeFileSync(
        join(dir, "agents", "echo.md"),
        ["---", "name: echo", "kind: remote", "produces: [report]", "server: everything", "tool: echo", "connectors: [everything]", "style:", "  avatar: Ec", "---", "", "A remote member.", ""].join(
          "\n",
        ),
      );
      writeFileSync(
        join(dir, "connectors", "everything.md"),
        // NOTES MCP-1C addendum 6: path-referenced, not a fetch-at-dispatch launcher — see this
        // describe block's own sibling below for the MCP_FETCH_AT_DISPATCH-specific tests.
        ["---", "name: everything", "kind: mcp", 'argv: ["/opt/mcp-servers/everything-server", "stdio"]', "env: [EVERYTHING_TOKEN]", "role: tool", "---", "", "An mcp connector.", ""].join("\n"),
      );
      return dir;
    }

    test("fires when sandbox.level is 'none' and the remote agent is fully implemented", () => {
      const dir = implementedRemoteDir();
      try {
        const r = validatePath(dir, undefined, NONE_DETECTION);
        expect(r.ok).toBe(true);
        expect(r.warnings.map((w) => w.code)).toContain("SANDBOX_UNAVAILABLE");
        const w = r.warnings.find((w) => w.code === "SANDBOX_UNAVAILABLE")!;
        expect(w.message).toContain("echo");
        expect(w.message).toContain("kind: remote");
        expect(w.message).toContain("spawned MCP server process runs unconfined");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("never fires for a NOT-implemented remote agent — REMOTE_NOT_IMPLEMENTED already told the whole story", () => {
      const dir = mkdtempSync(join(tmpdir(), "levare-remote-sandbox-unimpl-"));
      try {
        mkdirSync(join(dir, "agents"), { recursive: true });
        writeFileSync(join(dir, "agents", "echo.md"), remoteAgentDoc());
        const r = validatePath(dir, undefined, NONE_DETECTION);
        expect(r.warnings.map((w) => w.code)).toContain("REMOTE_NOT_IMPLEMENTED");
        expect(r.warnings.map((w) => w.code)).not.toContain("SANDBOX_UNAVAILABLE");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("never fires when no sandbox detection is passed — never assumed", () => {
      const dir = implementedRemoteDir();
      try {
        const r = validatePath(dir);
        expect(r.warnings.map((w) => w.code)).not.toContain("SANDBOX_UNAVAILABLE");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("never fires when sandbox.level is a working primitive", () => {
      const dir = implementedRemoteDir();
      try {
        const r = validatePath(dir, undefined, { platform: "linux", primitive: "bubblewrap", level: "full", bin: "/usr/bin/bwrap" });
        expect(r.warnings.map((w) => w.code)).not.toContain("SANDBOX_UNAVAILABLE");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

// NOTES MCP-1C addendum 6 — the Conductor's ruling closing item #4 (the bunx/npx e2e hang): a `kind:
// mcp` connector whose argv invokes a known package-runner in fetch-and-run mode (npx, bunx, pnpm dlx,
// yarn dlx) over a bare package spec is a legal-but-unsupported-under-sandbox declaration — warned here,
// never rejected (the same REV1 honesty-layer posture as REMOTE_NOT_IMPLEMENTED/SANDBOX_UNAVAILABLE
// above); adapters.ts#createAsyncStdioRemoteBoundary re-runs the identical detection and turns it into a
// hard, fail-fast error specifically when dispatched under a host with a working sandbox primitive (see
// tests/adapters.test.ts's own sibling describe block for that half).
describe("MCP_FETCH_AT_DISPATCH — fetch-at-dispatch MCP launchers (NOTES MCP-1C addendum 6)", () => {
  function connectorDoc(argv: string): string {
    return ["---", "name: everything", "kind: mcp", `argv: ${argv}`, "env: [EVERYTHING_TOKEN]", "role: tool", "---", "", "An mcp connector.", ""].join("\n");
  }

  function connectorDir(argv: string): string {
    const dir = mkdtempSync(join(tmpdir(), "levare-mcp-fetch-at-dispatch-"));
    mkdirSync(join(dir, "connectors"), { recursive: true });
    writeFileSync(join(dir, "connectors", "everything.md"), connectorDoc(argv));
    return dir;
  }

  test.each([
    ["npx -y a bare package spec", '["npx", "-y", "@modelcontextprotocol/server-everything", "stdio"]'],
    ["bunx a bare package spec", '["bunx", "@modelcontextprotocol/server-everything", "stdio"]'],
    ["pnpm dlx a bare package spec", '["pnpm", "dlx", "@modelcontextprotocol/server-everything", "stdio"]'],
    ["yarn dlx a bare package spec", '["yarn", "dlx", "@modelcontextprotocol/server-everything", "stdio"]'],
  ])("fires for %s", (_label, argv) => {
    const dir = connectorDir(argv);
    try {
      const r = validatePath(dir);
      expect(r.ok).toBe(true); // a warning, never an error — the declaration is legal.
      expect(r.warnings.map((w) => w.code)).toContain("MCP_FETCH_AT_DISPATCH");
      const w = r.warnings.find((w) => w.code === "MCP_FETCH_AT_DISPATCH")!;
      expect(w.message).toContain("everything");
      expect(w.message).toContain("fetch");
      expect(w.message).toContain("05-foreign-agent.md");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a pnpm connector with no dlx subcommand is an ordinary CLI invocation, never flagged", () => {
    const dir = connectorDir('["pnpm", "run", "start"]');
    try {
      const r = validatePath(dir);
      expect(r.warnings.map((w) => w.code)).not.toContain("MCP_FETCH_AT_DISPATCH");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a resolved, path-referenced connector (no runner at all) is never flagged", () => {
    const dir = connectorDir('["/opt/mcp-servers/everything-server", "stdio"]');
    try {
      const r = validatePath(dir);
      expect(r.warnings.map((w) => w.code)).not.toContain("MCP_FETCH_AT_DISPATCH");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a runner invocation naming a resolvable, existing local file is a locally-installed server, not fetch-at-dispatch — never flagged", () => {
    const dir = connectorDir(JSON.stringify(["npx", import.meta.path, "stdio"])); // any existing absolute file works as the probe
    try {
      const r = validatePath(dir);
      expect(r.warnings.map((w) => w.code)).not.toContain("MCP_FETCH_AT_DISPATCH");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a kind: cli connector is never checked — this ruling is specific to kind: mcp's own sandboxed spawn", () => {
    const dir = mkdtempSync(join(tmpdir(), "levare-mcp-fetch-at-dispatch-cli-"));
    try {
      mkdirSync(join(dir, "connectors"), { recursive: true });
      writeFileSync(
        join(dir, "connectors", "gh.md"),
        ["---", "name: gh", "kind: cli", "command: npx", "env: [GITHUB_TOKEN]", "role: tool", "---", "", "A cli connector.", ""].join("\n"),
      );
      const r = validatePath(dir);
      expect(r.warnings.map((w) => w.code)).not.toContain("MCP_FETCH_AT_DISPATCH");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

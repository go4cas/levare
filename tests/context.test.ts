import { test, expect, describe } from "bun:test";
import { readFileSync, mkdtempSync, cpSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRepo } from "../src/repo.ts";
import { assembleContext, ContextError } from "../src/context.ts";
import { main } from "../src/cli.ts";
import { BODY_PURPOSE } from "../scripts/generate-cheatsheets.ts";
import { CAPABILITIES } from "../fixtures/stubs/member-stub.ts";
import { assertExitCode } from "./spawn-helpers.ts";

// Context assembly is the §6 recipe, frozen. fixtures/context/lyra.txt is a reviewed deliverable:
// the exact bytes a member receives. These tests pin the recipe order and the paths-only rule, and
// assert the CLI reproduces the frozen fixture byte-for-byte.

const ROOT = "fixtures/golden";

describe("context assembly (§6 recipe)", () => {
  const repo = loadRepo(ROOT);

  test("`levare context lyra --unit checkout-flow --dry-run` matches the frozen fixture exactly", () => {
    const out = assembleContext(repo, { root: ROOT, agent: "lyra", unit: "checkout-flow", capabilities: CAPABILITIES });
    const frozen = readFileSync("fixtures/context/lyra.txt", "utf8");
    expect(out).toBe(frozen);
  });

  test("the CLI command reproduces the frozen fixture byte-for-byte", () => {
    // Capture stdout of the real CLI path.
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown as (s: string) => boolean) = (s: string) => {
      chunks.push(s);
      return true;
    };
    let code: number;
    try {
      code = main(["context", "lyra", "--unit", "checkout-flow", "--root", ROOT, "--dry-run"]);
    } finally {
      process.stdout.write = orig;
    }
    expect(code).toBe(0);
    expect(chunks.join("")).toBe(readFileSync("fixtures/context/lyra.txt", "utf8"));
  });

  // Finding 180: the command's own header (`context · kestrel/lyra · ...`, printed by the frozen
  // fixture below) prints the `team/agent` form, but the argument only ever accepted the bare agent
  // name — an operator pasting what levare itself just showed them got "no agent 'kestrel/lyra'".
  test("`levare context kestrel/lyra --unit checkout-flow --dry-run` accepts the team/agent form its own header prints", () => {
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown as (s: string) => boolean) = (s: string) => {
      chunks.push(s);
      return true;
    };
    let code: number;
    try {
      code = main(["context", "kestrel/lyra", "--unit", "checkout-flow", "--root", ROOT, "--dry-run"]);
    } finally {
      process.stdout.write = orig;
    }
    expect(code).toBe(0);
    expect(chunks.join("")).toBe(readFileSync("fixtures/context/lyra.txt", "utf8"));
  });

  test("a team/agent form naming the wrong team fails loudly, naming the agent's real team", () => {
    const chunks: string[] = [];
    const errs: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = console.error;
    (process.stdout.write as unknown as (s: string) => boolean) = (s: string) => {
      chunks.push(s);
      return true;
    };
    console.error = (s: string) => {
      errs.push(s);
    };
    let code: number;
    try {
      code = main(["context", "helm/lyra", "--unit", "checkout-flow", "--root", ROOT, "--dry-run"]);
    } finally {
      process.stdout.write = origOut;
      console.error = origErr;
    }
    expect(code).toBe(1);
    expect(chunks.join("")).toBe("");
    expect(errs.join("\n")).toContain("kestrel");
  });

  test("the recipe sections appear once, in the fixed §6 order", () => {
    const out = assembleContext(repo, { root: ROOT, agent: "lyra", unit: "checkout-flow", capabilities: CAPABILITIES });
    const order = ["── 1. agent", "── 2. skills", "── 3. knowledge", "── 4. team charter", "── team learnings", "── 5. project house rules", "── 6. task", "── 7. consumed artifacts"];
    let cursor = -1;
    for (const marker of order) {
      const at = out.indexOf(marker);
      expect(at).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  test("consumed artifacts are PATHS only — never their contents (invariant / §6 item 7)", () => {
    const out = assembleContext(repo, { root: ROOT, agent: "lyra", unit: "checkout-flow", capabilities: CAPABILITIES });
    expect(out).toContain("work/storefront/checkout-flow/product-brief-v1.md");
    expect(out).toContain("work/storefront/checkout-flow/design-checkout-v1/index.md");
    // The consumed brief's body sentence must NOT be inlined into the context — paths only.
    expect(out).not.toContain("saved-card fallback");
    expect(out).not.toContain("abandoned at that wall");
  });

  test("only APPROVED upstream artifacts are listed as consumed inputs (the in-review spec is not)", () => {
    const out = assembleContext(repo, { root: ROOT, agent: "lyra", unit: "checkout-flow", capabilities: CAPABILITIES });
    // spec-checkout-flow-v1 sits at in-review on disk — not a vetted input, so not a consumed path.
    const consumedBlock = out.slice(out.indexOf("── 7."));
    expect(consumedBlock).not.toContain("spec-checkout-flow-v1.md");
  });

  test("`--step design` selects the earlier step; default picks the last (spec)", () => {
    const spec = assembleContext(repo, { root: ROOT, agent: "lyra", unit: "checkout-flow", capabilities: CAPABILITIES });
    const design = assembleContext(repo, { root: ROOT, agent: "lyra", unit: "checkout-flow", step: "design", capabilities: CAPABILITIES });
    expect(spec).toContain("step spec → spec");
    expect(design).toContain("step design → design");
  });

  test("an unknown agent is a hard error", () => {
    expect(() => assembleContext(repo, { root: ROOT, agent: "ghost", unit: "checkout-flow", capabilities: CAPABILITIES })).toThrow(ContextError);
  });

  test("the team's charter AND its LEARNINGS.md are both injected (recipe item 4)", () => {
    const out = assembleContext(repo, { root: ROOT, agent: "lyra", unit: "checkout-flow", capabilities: CAPABILITIES });
    expect(out).toContain("Kestrel — the product-shaping team"); // charter
    expect(out).toContain("kestrel — learnings"); // LEARNINGS.md
  });
});

// Finding 172: team.skills reaches every member's context, unioned with the member's own skills:,
// deduped when both name the same skill.
describe("Finding 172: team.skills is unioned into every member's own skills:, deduped", () => {
  function buildStudio(): string {
    const dir = mkdtempSync(join(tmpdir(), "levare-team-skills-"));
    mkdirSync(join(dir, "teams"), { recursive: true });
    mkdirSync(join(dir, "agents"), { recursive: true });
    mkdirSync(join(dir, "skills"), { recursive: true });
    mkdirSync(join(dir, "work", "acme", "launch"), { recursive: true });

    writeFileSync(join(dir, "skills", "team-only-skill.md"), "---\nname: team-only-skill\ndescription: test\n---\n\nTeam-only skill body.\n");
    writeFileSync(join(dir, "skills", "agent-only-skill.md"), "---\nname: agent-only-skill\ndescription: test\n---\n\nAgent-only skill body.\n");
    writeFileSync(join(dir, "skills", "shared-skill.md"), "---\nname: shared-skill\ndescription: test\n---\n\nShared skill body.\n");
    writeFileSync(
      join(dir, "agents", "wren.md"),
      ["---", "name: wren", "kind: native", "produces: [product-brief]", "model: claude-sonnet-5", "skills: [agent-only-skill, shared-skill]", "style:", "  avatar: Wr", "---", "", "Wren.", ""].join(
        "\n",
      ),
    );
    writeFileSync(
      join(dir, "teams", "kestrel.md"),
      [
        "---",
        "name: kestrel",
        "consumes: []",
        "produces: [product-brief]",
        "members: [wren]",
        "flow:",
        "  - step: brief",
        "style:",
        "  color: '#000'",
        "skills: [team-only-skill, shared-skill]",
        "---",
        "",
        "Kestrel.",
        "",
      ].join("\n"),
    );
    writeFileSync(join(dir, "work", "acme", "launch", "unit.md"), "---\ntype: feature\nstatus: active\n---\n\n# launch\n\nTeam skills fixture.\n");
    return dir;
  }

  test("team.skills and agent.skills both reach the member's context, deduped, with no not-found placeholders", () => {
    const dir = buildStudio();
    try {
      const repo = loadRepo(dir);
      const out = assembleContext(repo, { root: dir, agent: "wren", unit: "launch", capabilities: [{ member: "wren", kind: "product-brief" }] });
      const skillsBlock = out.slice(out.indexOf("── 2. skills"), out.indexOf("── 3. knowledge"));
      expect(skillsBlock).toContain("team-only-skill");
      expect(skillsBlock).toContain("agent-only-skill");
      expect(skillsBlock).toContain("shared-skill");
      expect(skillsBlock).not.toContain("(not found");
      // Deduped: shared-skill named on both team and agent must appear as ONE section, not two.
      expect(skillsBlock.split("### shared-skill").length - 1).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Finding 185: sibling of 172 — team.knowledge was parsed, validated (UNKNOWN_KNOWLEDGE), and
// rendered on the team card, but context.ts read only agent.knowledge. Same union, same dedup.
describe("Finding 185: team.knowledge is unioned into every member's own knowledge:, deduped", () => {
  function buildStudio(): string {
    const dir = mkdtempSync(join(tmpdir(), "levare-team-knowledge-"));
    mkdirSync(join(dir, "teams"), { recursive: true });
    mkdirSync(join(dir, "agents"), { recursive: true });
    mkdirSync(join(dir, "knowledge"), { recursive: true });
    mkdirSync(join(dir, "work", "acme", "launch"), { recursive: true });

    writeFileSync(join(dir, "knowledge", "team-only-doc.md"), "---\nname: team-only-doc\n---\n\nTeam-only doc body.\n");
    writeFileSync(join(dir, "knowledge", "agent-only-doc.md"), "---\nname: agent-only-doc\n---\n\nAgent-only doc body.\n");
    writeFileSync(join(dir, "knowledge", "house-style.md"), "---\nname: house-style\n---\n\nHouse style body.\n");
    writeFileSync(
      join(dir, "agents", "wren.md"),
      [
        "---",
        "name: wren",
        "kind: native",
        "produces: [product-brief]",
        "model: claude-sonnet-5",
        "knowledge: [agent-only-doc, house-style]",
        "style:",
        "  avatar: Wr",
        "---",
        "",
        "Wren.",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "teams", "kestrel.md"),
      [
        "---",
        "name: kestrel",
        "consumes: []",
        "produces: [product-brief]",
        "members: [wren]",
        "flow:",
        "  - step: brief",
        "style:",
        "  color: '#000'",
        "knowledge: [team-only-doc, house-style]",
        "---",
        "",
        "Kestrel.",
        "",
      ].join("\n"),
    );
    writeFileSync(join(dir, "work", "acme", "launch", "unit.md"), "---\ntype: feature\nstatus: active\n---\n\n# launch\n\nTeam knowledge fixture.\n");
    return dir;
  }

  test("team.knowledge and agent.knowledge both reach the member's context, deduped, with no not-found placeholders", () => {
    const dir = buildStudio();
    try {
      const repo = loadRepo(dir);
      const out = assembleContext(repo, { root: dir, agent: "wren", unit: "launch", capabilities: [{ member: "wren", kind: "product-brief" }] });
      const knowledgeBlock = out.slice(out.indexOf("── 3. knowledge"), out.indexOf("── 4. team charter"));
      expect(knowledgeBlock).toContain("team-only-doc");
      expect(knowledgeBlock).toContain("agent-only-doc");
      expect(knowledgeBlock).toContain("house-style");
      expect(knowledgeBlock).not.toContain("(not found");
      // Deduped: house-style named on both team and agent must appear as ONE section, not two.
      expect(knowledgeBlock.split("### house-style").length - 1).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Finding 163: item 6 used to be the flow step's label alone — the member never saw the unit's own
// body or its type template, so a generic brief was the only brief its context could support (the
// jot/version-flag incident this finding is named for). Both now render inside section 6, verbatim.
describe("Finding 163: the unit's own body and type template reach the member (recipe item 6)", () => {
  const repo = loadRepo(ROOT);

  test("the unit's own body (unit.md, frontmatter stripped) is inlined verbatim", () => {
    const out = assembleContext(repo, { root: ROOT, agent: "lyra", unit: "checkout-flow", capabilities: CAPABILITIES });
    const task = out.slice(out.indexOf("── 6. task"), out.indexOf("── 7."));
    expect(task).toContain("Rebuild the storefront checkout as a single-page flow");
  });

  test("the unit's type template body (types/<type>.md) is inlined verbatim", () => {
    const out = assembleContext(repo, { root: ROOT, agent: "lyra", unit: "checkout-flow", capabilities: CAPABILITIES });
    const task = out.slice(out.indexOf("── 6. task"), out.indexOf("── 7."));
    expect(task).toContain("### type: feature");
    expect(task).toContain("A full product increment");
  });

  test("the unit section header states it is context, not a licence to override the approved chain", () => {
    const out = assembleContext(repo, { root: ROOT, agent: "lyra", unit: "checkout-flow", capabilities: CAPABILITIES });
    expect(out).toContain("context, not a licence to override the approved artifacts in item 7");
  });

  test("an empty unit body renders `(none)`, same as every other optional recipe section", () => {
    const cloned = { ...repo, units: repo.units.map((u) => (u.unit === "checkout-flow" ? { ...u, body: "" } : u)) };
    const out = assembleContext(cloned, { root: ROOT, agent: "lyra", unit: "checkout-flow", capabilities: CAPABILITIES });
    const task = out.slice(out.indexOf("── 6. task"), out.indexOf("── 7."));
    const unitHeader = task.indexOf("### unit:");
    expect(task.slice(unitHeader)).toContain("### unit: storefront/checkout-flow — context, not a licence to override the approved artifacts in item 7\n(none)");
  });

  test("a unit whose type has no matching types/<type>.md is reported, not silently dropped", () => {
    const cloned = { ...repo, units: repo.units.map((u) => (u.unit === "checkout-flow" ? { ...u, type: "ghost" } : u)) };
    const out = assembleContext(cloned, { root: ROOT, agent: "lyra", unit: "checkout-flow", capabilities: CAPABILITIES });
    expect(out).toContain("### type: ghost\n(not found: types/ghost.md)");
  });

  // Finding 186: the generated type.md/work-unit.md cheatsheets said "Not used" for exactly the two
  // bodies THIS describe block already proves are injected into every dispatch — PR #84 (this file's
  // own tests above) added the behavior, but scripts/generate-cheatsheets.ts's BODY_PURPOSE map was
  // never updated, and nothing tied the two together, so it drifted silently for ten days. Colocating
  // this assertion with the behavior it must never contradict closes that gap: a future PR that removes
  // the injection (breaking the tests above) OR reverts BODY_PURPOSE to "Not used" (breaking this one)
  // fails loudly either way — the two can no longer drift apart unnoticed.
  test("BODY_PURPOSE never re-claims 'Not used' for type/work-unit while this file proves their bodies ARE injected", () => {
    expect(BODY_PURPOSE.type.startsWith("Not used")).toBe(false);
    expect(BODY_PURPOSE["work-unit"].startsWith("Not used")).toBe(false);
  });
});

// Ruling C9 (NOTES D6): delivery of consumed artifacts (recipe item 7) is a per-agent declaration.
// An agent that cannot reach the studio filesystem (an isolated scratch-dir CLI member) declares
// `context_artifacts: inline` and gets the full text instead of an unopenable path.
describe("ruling C9: context_artifacts — paths (default) vs inline", () => {
  const repo = loadRepo(ROOT);

  test("an agent declaring `paths` (or nothing) gets only paths — unchanged behaviour", () => {
    const agent = { ...repo.agents.get("lyra")!, context_artifacts: "paths" as const };
    const cloned = { ...repo, agents: new Map(repo.agents).set("lyra", agent) };
    const out = assembleContext(cloned, { root: ROOT, agent: "lyra", unit: "checkout-flow", capabilities: CAPABILITIES });
    expect(out).toContain("── 7. consumed artifacts (paths only — never contents) ──");
    expect(out).toContain("work/storefront/checkout-flow/product-brief-v1.md");
    expect(out).not.toContain("saved-card fallback");
  });

  test("an agent declaring `inline` gets the full text (frontmatter + body) of every consumed artifact", () => {
    const agent = { ...repo.agents.get("lyra")!, context_artifacts: "inline" as const };
    const cloned = { ...repo, agents: new Map(repo.agents).set("lyra", agent) };
    const out = assembleContext(cloned, { root: ROOT, agent: "lyra", unit: "checkout-flow", capabilities: CAPABILITIES });
    expect(out).toContain("── 7. consumed artifacts (inline — full text, per agent declaration `context_artifacts: inline`, ruling C9) ──");
    // The path is still named (in the per-artifact delimiter), but the body is now ALSO present.
    expect(out).toContain("work/storefront/checkout-flow/product-brief-v1.md");
    expect(out).toContain("kind: product-brief"); // frontmatter, inlined
    expect(out).toContain("saved-card fallback"); // body, inlined — the exact text D2 asserted absent
    expect(out).toContain("abandoned at that wall");
    expect(out).toContain("kind: design");
    expect(out).toContain("A single-page checkout"); // design-checkout-v1's body
  });

  test("recipe header line 2 names the delivery mode actually in use", () => {
    const pathsOut = assembleContext(repo, { root: ROOT, agent: "lyra", unit: "checkout-flow", capabilities: CAPABILITIES });
    expect(pathsOut.split("\n")[1]).toContain("consumed paths");

    const inlineAgent = { ...repo.agents.get("lyra")!, context_artifacts: "inline" as const };
    const cloned = { ...repo, agents: new Map(repo.agents).set("lyra", inlineAgent) };
    const inlineOut = assembleContext(cloned, { root: ROOT, agent: "lyra", unit: "checkout-flow", capabilities: CAPABILITIES });
    expect(inlineOut.split("\n")[1]).toContain("consumed artifacts (inline)");
  });
});

// Finding 180: `levare context <agent> --unit <u>` documents `[--root <path>]` as optional in `--help`,
// same shape as `doctor`'s `[root]` (NOTES DOCS-WALKTHROUGH-2), but the bare form used to resolve
// against `fixtures/golden` — a path that only exists inside levare's own source checkout — everywhere
// else. A test that merely runs from the repo root proves nothing (the old default's relative-path
// fallback happened to succeed there too); this spawns the real CLI with `cwd` set to a studio OUTSIDE
// the repo, with no `--root` at all.
describe("context: bare `[--root]` defaults to the current directory (Finding 180)", () => {
  test("`levare context <agent> --unit <u>` with no --root, run from a studio outside the repo, contexts that studio — not fixtures/golden", () => {
    const dir = mkdtempSync(join(tmpdir(), "levare-context-cwd-"));
    try {
      cpSync("fixtures/golden", dir, { recursive: true });
      const levareBin = join(process.cwd(), "levare");
      const p = Bun.spawnSync([levareBin, "context", "lyra", "--unit", "checkout-flow", "--dry-run"], { cwd: dir });
      assertExitCode("<compiled> context (cwd outside repo)", p, 0);
      const out = p.stdout.toString();
      expect(out).not.toContain("NOT_FOUND");
      expect(out).not.toContain("fixtures/golden");
      expect(out).toContain("context · kestrel/lyra ·");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

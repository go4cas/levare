import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { loadRepo } from "../src/repo.ts";
import { assembleContext, ContextError } from "../src/context.ts";
import { main } from "../src/cli.ts";
import { CAPABILITIES } from "../fixtures/stubs/member-stub.ts";

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
      code = main(["context", "lyra", "--unit", "checkout-flow", "--dry-run"]);
    } finally {
      process.stdout.write = orig;
    }
    expect(code).toBe(0);
    expect(chunks.join("")).toBe(readFileSync("fixtures/context/lyra.txt", "utf8"));
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

import { test, expect, describe } from "bun:test";
import { render } from "../fixtures/stubs/member-stub.ts";
import { parseFrontmatter } from "../src/yaml.ts";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePath } from "../src/validate.ts";

// The stub member CLIs emit canned artifacts deterministically (no clock, no randomness). Phase 2's
// Runner spawns them; here we assert determinism and that their output honours the artifact contract.

describe("stub member CLIs", () => {
  test("output is byte-for-byte deterministic across calls", () => {
    const a = render("lyra", "spec", "checkout-flow", "storefront");
    const b = render("lyra", "spec", "checkout-flow", "storefront");
    expect(a).toBe(b);
  });

  test("emitted artifact parses and carries the expected id + consumes", () => {
    const { data } = parseFrontmatter(render("lyra", "spec", "checkout-flow", "storefront"));
    expect(data.id).toBe("spec-checkout-flow-v1");
    expect(data.consumes).toEqual(["product-brief-v1", "design-checkout-v1"]);
    expect(data.kind).toBe("spec");
  });

  test("emitted artifact validates against the contract in a project context", () => {
    // Lay the three canned artifacts into a scratch tree so consumes resolve, then validate.
    const root = mkdtempSync(join(tmpdir(), "levare-stubs-"));
    try {
      const dir = join(root, "work", "storefront", "checkout-flow");
      Bun.spawnSync(["mkdir", "-p", dir]);
      writeFileSync(join(dir, "product-brief-v1.md"), render("wren", "product-brief", "checkout-flow", "storefront"));
      writeFileSync(join(dir, "design-checkout-v1.md"), render("lyra", "design", "checkout-flow", "storefront"));
      writeFileSync(join(dir, "spec-checkout-flow-v1.md"), render("lyra", "spec", "checkout-flow", "storefront"));
      const r = validatePath(root);
      if (!r.ok) console.error(r.errors);
      expect(r.ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("unknown member/kind pair throws rather than emitting garbage", () => {
    expect(() => render("ghost", "spec", "u", "p")).toThrow(/no canned artifact/);
  });
});

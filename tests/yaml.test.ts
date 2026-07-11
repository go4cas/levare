import { test, expect, describe } from "bun:test";
import { parse, parseFrontmatter, YamlError } from "../src/yaml.ts";

describe("subset-YAML scalars", () => {
  test("infers strings, numbers, booleans, null", () => {
    const v = parse(
      ["s: hello", "n: 42", "f: 0.58", "neg: -3", "b1: true", "b2: false", "nul: null", "tilde: ~", "empty:"].join("\n"),
    ) as Record<string, unknown>;
    expect(v.s).toBe("hello");
    expect(v.n).toBe(42);
    expect(v.f).toBeCloseTo(0.58);
    expect(v.neg).toBe(-3);
    expect(v.b1).toBe(true);
    expect(v.b2).toBe(false);
    expect(v.nul).toBeNull();
    expect(v.tilde).toBeNull();
    expect(v.empty).toBeNull();
  });

  test("quoted strings preserve type and content", () => {
    const v = parse(['num_as_str: "42"', "single: 'it''s fine'", 'esc: "a\\nb"'].join("\n")) as Record<string, unknown>;
    expect(v.num_as_str).toBe("42");
    expect(v.single).toBe("it's fine");
    expect(v.esc).toBe("a\nb");
  });

  test("strips comments outside quotes", () => {
    const v = parse(['a: 1 # trailing comment', 'url: "http://x#y" # real'].join("\n")) as Record<string, unknown>;
    expect(v.a).toBe(1);
    expect(v.url).toBe("http://x#y");
  });
});

describe("subset-YAML collections", () => {
  test("inline string and number arrays", () => {
    const v = parse(["a: [x, y, z]", "b: [1, 2, 3]", "empty: []"].join("\n")) as Record<string, unknown>;
    expect(v.a).toEqual(["x", "y", "z"]);
    expect(v.b).toEqual([1, 2, 3]);
    expect(v.empty).toEqual([]);
  });

  test("block sequence of scalars", () => {
    const v = parse(["items:", "  - one", "  - two", "  - 3"].join("\n")) as Record<string, unknown>;
    expect(v.items).toEqual(["one", "two", 3]);
  });

  test("one-level map", () => {
    const v = parse(["style:", "  color: \"#2E6FB0\"", "  weight: 2"].join("\n")) as Record<string, unknown>;
    expect(v.style).toEqual({ color: "#2E6FB0", weight: 2 });
  });

  test("list of maps with a nested loop block (team flow shape)", () => {
    const src = [
      "flow:",
      "  - step: brief",
      "  - gate: human",
      "  - loop:",
      "      between: [review, revise]",
      "      until: spec.approved",
      "      max_rounds: 3",
      "      on_exhaust: gate",
    ].join("\n");
    const v = parse(src) as { flow: unknown[] };
    expect(v.flow).toEqual([
      { step: "brief" },
      { gate: "human" },
      { loop: { between: ["review", "revise"], until: "spec.approved", max_rounds: 3, on_exhaust: "gate" } },
    ]);
  });
});

describe("subset-YAML rejects exotica", () => {
  const cases: [string, RegExp][] = [
    ["a: &anchor 1", /anchor/],
    ["a: *alias", /alias/],
    ["a: !!str x", /tag/],
    ["a: |", /block scalar/],
    ["a: { b: 1 }", /flow mapping/],
    ["a:\n\t- x", /tab/],
    ["a: [ [1, 2] ]", /nested inline/],
  ];
  for (const [src, re] of cases) {
    test(`rejects: ${JSON.stringify(src)}`, () => {
      expect(() => parse(src)).toThrow(YamlError);
      try {
        parse(src);
      } catch (e) {
        expect((e as Error).message).toMatch(re);
      }
    });
  }

  test("duplicate mapping key is an error", () => {
    expect(() => parse(["a: 1", "a: 2"].join("\n"))).toThrow(/duplicate/);
  });
});

describe("frontmatter extraction", () => {
  test("splits frontmatter from body", () => {
    const { data, body } = parseFrontmatter(["---", "kind: spec", "id: x", "---", "# Title", "prose"].join("\n"));
    expect(data).toEqual({ kind: "spec", id: "x" });
    expect(body.trim()).toBe(["# Title", "prose"].join("\n"));
  });

  test("missing opening fence throws", () => {
    expect(() => parseFrontmatter("no fence here")).toThrow(/begin with/);
  });

  test("unterminated frontmatter throws", () => {
    expect(() => parseFrontmatter(["---", "kind: spec"].join("\n"))).toThrow(/not terminated/);
  });
});

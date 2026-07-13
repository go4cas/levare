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

  // NOTES F3: a `command: [...]` argv template is exactly this shape — an inline sequence whose
  // elements go straight to Bun.spawn as argv. Every quoting style must yield the RAW string (no
  // surrounding quote characters survive into argv[0]), or a definition like `command: ['/tmp/foo.sh']`
  // would silently spawn the literal, unrunnable path `'/tmp/foo.sh'` (quotes and all) instead of
  // `/tmp/foo.sh` — a broken argv that fails opaquely, never a validation error naming the real cause.
  describe("command-array elements — bare, single-quoted, and double-quoted (NOTES F3)", () => {
    test("a bare (unquoted) path element is passed through untouched", () => {
      const v = parse("command: [/tmp/foo.sh]") as Record<string, unknown>;
      expect(v.command).toEqual(["/tmp/foo.sh"]);
    });

    test("a single-quoted path element has its quotes stripped, not carried into argv", () => {
      const v = parse("command: ['/tmp/foo.sh']") as Record<string, unknown>;
      expect(v.command).toEqual(["/tmp/foo.sh"]);
      expect((v.command as string[])[0]).not.toContain("'");
    });

    test("a double-quoted path element has its quotes stripped, not carried into argv", () => {
      const v = parse('command: ["/tmp/foo.sh"]') as Record<string, unknown>;
      expect(v.command).toEqual(["/tmp/foo.sh"]);
      expect((v.command as string[])[0]).not.toContain('"');
    });

    test("mixed bare/single/double elements in one command array all resolve to their raw content", () => {
      const v = parse(`command: [codex, '--flag=it''s on', "--repo", /tmp/x]`) as Record<string, unknown>;
      expect(v.command).toEqual(["codex", "--flag=it's on", "--repo", "/tmp/x"]);
    });

    test("a single-quoted element containing a literal apostrophe uses YAML's '' escape, never a broken argv", () => {
      const v = parse("command: ['it''s a trap']") as Record<string, unknown>;
      expect(v.command).toEqual(["it's a trap"]);
    });
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

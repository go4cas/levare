import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePath } from "../src/validate.ts";
import { railKindOrder, kindOrderForLabels } from "../src/flow.ts";
import { scoreNodes } from "../src/derive.ts";
import type { FlowRepo } from "../src/flow.ts";
import type { Team, TypeTemplate, WorkUnit, Artifact } from "../src/types.ts";
import type { Repo } from "../src/repo.ts";

// Finding 78 part 2: the score rail sorts by the team's declared flow position, once `levare validate`
// guarantees `type.expects` and `team.flow` agree. Two ordering rules (an expects-only kind sorts
// last; a kind two flow entries resolve to appears once, at its first occurrence) plus two validation
// errors (a flow step producing a kind the type never expects; more than one responsible team
// disagreeing on a shared kind's relative order).

function team(over: Partial<Team> & Pick<Team, "name" | "members" | "flow" | "produces">): Team {
  return { consumes: [], style: { color: "#000" }, charter: "", learnings: "", ...over };
}

const CAPS = [
  { member: "wren", kind: "product-brief" },
  { member: "lyra", kind: "design" },
  { member: "lyra", kind: "spec" },
  { member: "finch", kind: "review" },
];

describe("flow.ts#railKindOrder — pure ordering", () => {
  test("flow-placed kinds sort by first-occurrence flow position; an expects-only kind sorts last, in expects order among its peers", () => {
    const kestrel = team({
      name: "kestrel",
      members: ["wren", "lyra", "finch"],
      produces: ["product-brief", "design", "spec"],
      flow: [
        { kind: "step", step: "brief" },
        { kind: "gate", who: "human" },
        { kind: "step", step: "design" },
        { kind: "gate", who: "human" },
        { kind: "loop", between: ["spec", "review"], until: "spec.approved", maxRounds: 3, onExhaust: "gate" },
      ],
    });
    const featureType: TypeTemplate = { name: "feature", glyph: "▸", expects: ["product-brief", "design", "spec", "code", "review"], gates: [] };
    const repo: FlowRepo = { teams: new Map([["kestrel", kestrel]]), types: new Map([["feature", featureType]]), units: [] };
    const unit: WorkUnit = { type: "feature", status: "active", project: "p", unit: "u", dir: "work/p/u" };
    // "code" (expects-only, no flow step ever resolves to it) sorts after every flow-placed kind, in
    // its own expects-relative position among the other expects-only kinds (here, the only one).
    const order = railKindOrder(repo, unit, CAPS);
    expect(order).toEqual(["product-brief", "design", "spec", "review", "code"]);
  });

  test("a kind two flow entries resolve to appears once, at its FIRST occurrence (ordering rule 4)", () => {
    const caps = [
      { member: "wren", kind: "product-brief" },
      { member: "wren", kind: "design" },
    ];
    // The flow revisits the "design" step label a second time (e.g. a redo) — it resolves to the SAME
    // kind both times.
    const team1 = team({
      name: "solo",
      members: ["wren"],
      produces: ["product-brief", "design"],
      flow: [
        { kind: "step", step: "brief" },
        { kind: "step", step: "design" },
        { kind: "gate", who: "human" },
        { kind: "step", step: "design" },
      ],
    });
    const type: TypeTemplate = { name: "t", glyph: "▸", expects: ["product-brief", "design"], gates: [] };
    const repo: FlowRepo = { teams: new Map([["solo", team1]]), types: new Map([["t", type]]), units: [] };
    const unit: WorkUnit = { type: "t", status: "active", project: "p", unit: "u", dir: "work/p/u" };
    const order = railKindOrder(repo, unit, caps);
    // "design" appears exactly once, at its first position — never a duplicate for the repeated step.
    expect(order).toEqual(["product-brief", "design"]);
  });

  test("kindOrderForLabels skips a label that resolves to zero or more than one capability — never guesses", () => {
    const caps = [
      { member: "a", kind: "x" },
      { member: "b", kind: "x" }, // ambiguous for label "x"
    ];
    // "x" is ambiguous (two members), "y" resolves to nothing — both skipped, never reported here
    // (UNBINDABLE_STEP/AMBIGUOUS_STEP own that failure).
    expect(kindOrderForLabels(["x", "y"], ["a", "b"], caps)).toEqual([]);
  });

  test("multiple responsible teams contribute their own flow order, concatenated in team order", () => {
    const shaping = team({ name: "shaping", members: ["wren"], produces: ["product-brief"], flow: [{ kind: "step", step: "brief" }] });
    const build = team({ name: "build", members: ["finch"], produces: ["review"], flow: [{ kind: "step", step: "review" }] });
    const repo: FlowRepo = {
      teams: new Map([
        ["shaping", shaping],
        ["build", build],
      ]),
      types: new Map<string, TypeTemplate>([["feature", { name: "feature", glyph: "▸", expects: ["product-brief", "review"], gates: [] }]]),
      units: [],
    };
    const unit: WorkUnit = { type: "feature", status: "active", project: "p", unit: "u", dir: "work/p/u" };
    const caps = [
      { member: "wren", kind: "product-brief" },
      { member: "finch", kind: "review" },
    ];
    const order = railKindOrder(repo, unit, caps);
    expect(order).toEqual(["product-brief", "review"]);
  });
});

describe("derive.ts#scoreNodes — the rendered rail follows railKindOrder", () => {
  test("scoreNodes emits nodes in flow order, not expects' authoring order", () => {
    const kestrel = team({
      name: "kestrel",
      members: ["wren", "lyra", "finch"],
      produces: ["product-brief", "design", "spec"],
      flow: [{ kind: "step", step: "brief" }, { kind: "step", step: "design" }, { kind: "step", step: "review" }],
    });
    const unit: WorkUnit = { type: "feature", status: "active", project: "p", unit: "u", dir: "work/p/u" };
    const agent = (name: string, produces: string[]) => ({ name, kind: "native" as const, produces, style: { avatar: "Xx" }, body: "" });
    const repo: Repo = {
      root: "/tmp/synthetic-78-2",
      teams: new Map([["kestrel", kestrel]]),
      agents: new Map([
        ["wren", agent("wren", ["product-brief"])],
        ["lyra", agent("lyra", ["design"])],
        ["finch", agent("finch", ["review"])],
      ]),
      // types.expects deliberately authored in a DIFFERENT order than the flow places them.
      types: new Map([["feature", { name: "feature", glyph: "▸", expects: ["design", "product-brief", "code", "review"], gates: [] }]]),
      projects: new Map(),
      connectors: new Map(),
      units: [unit],
      artifacts: new Map(),
      studio: {},
    };
    const nodes = scoreNodes(repo, unit);
    // flow order (brief→product-brief, design→design, review→review), then "code" (expects-only) last.
    expect(nodes.map((n) => n.kind)).toEqual(["product-brief", "design", "review", "code"]);
  });
});

describe("validate.ts — UNDECLARED_FLOW_KIND and CONFLICTING_KIND_ORDER", () => {
  function writeAgent(dir: string, name: string, produces: string[]) {
    writeFileSync(
      join(dir, "agents", `${name}.md`),
      ["---", `name: ${name}`, "kind: native", `produces: [${produces.join(", ")}]`, "model: claude-sonnet-5", "style:", "  avatar: Xx", "---", "", `${name}.`, ""].join("\n"),
    );
  }
  function writeTeam(dir: string, name: string, produces: string[], members: string[], flowYaml: string) {
    writeFileSync(
      join(dir, "teams", `${name}.md`),
      ["---", `name: ${name}`, "consumes: []", `produces: [${produces.join(", ")}]`, `members: [${members.join(", ")}]`, "flow:", flowYaml, "style:", "  color: '#000'", "---", "", `${name}.`, ""].join(
        "\n",
      ),
    );
  }
  function writeType(dir: string, name: string, expects: string[]) {
    writeFileSync(join(dir, "types", `${name}.md`), ["---", `name: ${name}`, "glyph: '▸'", `expects: [${expects.join(", ")}]`, "gates: []", "---", "", `${name}.`, ""].join("\n"));
  }
  function writeUnit(dir: string, project: string, unit: string, type: string, teamOverride?: string) {
    mkdirSync(join(dir, "work", project, unit), { recursive: true });
    const teamLine = teamOverride ? `\nteam: ${teamOverride}` : "";
    writeFileSync(join(dir, "work", project, unit, "unit.md"), `---\ntype: ${type}\nstatus: active${teamLine}\n---\n\n# ${unit}\n\nFinding 78 part 2 fixture.\n`);
  }

  test("a team's flow producing a kind the type doesn't expect is UNDECLARED_FLOW_KIND, naming the type, team, and kind", () => {
    const dir = mkdtempSync(join(tmpdir(), "levare-undeclared-flow-kind-"));
    try {
      mkdirSync(join(dir, "teams"), { recursive: true });
      mkdirSync(join(dir, "agents"), { recursive: true });
      mkdirSync(join(dir, "types"), { recursive: true });
      writeAgent(dir, "wren", ["product-brief"]);
      writeAgent(dir, "finch", ["review"]);
      writeTeam(dir, "kestrel", ["product-brief"], ["wren", "finch"], "  - step: brief\n  - step: review");
      // "feature" expects only product-brief — kestrel's flow also resolves "review", which it never expects.
      writeType(dir, "feature", ["product-brief"]);
      writeUnit(dir, "acme", "launch", "feature");

      const r = validatePath(dir);
      expect(r.ok).toBe(false);
      const err = r.errors.find((e) => e.code === "UNDECLARED_FLOW_KIND");
      expect(err).toBeDefined();
      expect(err!.message).toContain("feature");
      expect(err!.message).toContain("kestrel");
      expect(err!.message).toContain("review");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("two responsible teams disagreeing on a shared kind's relative order is CONFLICTING_KIND_ORDER", () => {
    const dir = mkdtempSync(join(tmpdir(), "levare-conflicting-kind-order-"));
    try {
      mkdirSync(join(dir, "teams"), { recursive: true });
      mkdirSync(join(dir, "agents"), { recursive: true });
      mkdirSync(join(dir, "types"), { recursive: true });
      writeAgent(dir, "wren", ["product-brief"]);
      writeAgent(dir, "finch", ["review"]);
      // Two teams both flow-place BOTH shared kinds — but in opposite relative order.
      writeTeam(dir, "alpha", ["product-brief", "review"], ["wren", "finch"], "  - step: brief\n  - step: review");
      writeTeam(dir, "beta", ["product-brief", "review"], ["wren", "finch"], "  - step: review\n  - step: brief");
      writeType(dir, "feature", ["product-brief", "review"]);
      writeUnit(dir, "acme", "launch", "feature"); // no team: override — both are candidates

      const r = validatePath(dir);
      expect(r.ok).toBe(false);
      const err = r.errors.find((e) => e.code === "CONFLICTING_KIND_ORDER");
      expect(err).toBeDefined();
      expect(err!.message).toContain("product-brief");
      expect(err!.message).toContain("review");
      expect(err!.message).toContain("alpha");
      expect(err!.message).toContain("beta");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an explicit team: override excludes the other team from consideration entirely — no CONFLICTING_KIND_ORDER", () => {
    const dir = mkdtempSync(join(tmpdir(), "levare-conflicting-kind-order-override-"));
    try {
      mkdirSync(join(dir, "teams"), { recursive: true });
      mkdirSync(join(dir, "agents"), { recursive: true });
      mkdirSync(join(dir, "types"), { recursive: true });
      writeAgent(dir, "wren", ["product-brief"]);
      writeAgent(dir, "finch", ["review"]);
      writeTeam(dir, "alpha", ["product-brief", "review"], ["wren", "finch"], "  - step: brief\n  - step: review");
      writeTeam(dir, "beta", ["product-brief", "review"], ["wren", "finch"], "  - step: review\n  - step: brief");
      writeType(dir, "feature", ["product-brief", "review"]);
      writeUnit(dir, "acme", "launch", "feature", "alpha");

      const r = validatePath(dir);
      expect(r.errors.map((e) => e.code)).not.toContain("CONFLICTING_KIND_ORDER");
      expect(r.errors.map((e) => e.code)).not.toContain("AMBIGUOUS_PRODUCER");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("flow and expects agreeing produces no new errors (fixtures/golden's own kestrel+helm)", () => {
    const r = validatePath("fixtures/golden");
    expect(r.errors.map((e) => e.code)).not.toContain("UNDECLARED_FLOW_KIND");
    expect(r.errors.map((e) => e.code)).not.toContain("CONFLICTING_KIND_ORDER");
  });
});

import { test, expect, describe } from "bun:test";
import { loadRepo, type Repo } from "../src/repo.ts";
import {
  Runner,
  timeboxSeconds,
  type Decision,
  type DecisionSource,
  type Gate,
  type MemberRunner,
  type Verb,
} from "../src/runner.ts";
import type { FlowNode, Project, Team, TypeTemplate, WorkUnit } from "../src/types.ts";
import { StubRunner } from "../src/replay.ts";

// The Runner is exercised two ways: (1) against the real golden fixture + stub members, and (2)
// against tiny synthetic repos built in-memory to isolate start gates, budget, timebox, pace, and
// the boundary contract check — none of which the golden fixture triggers on its own.

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// A DecisionSource driven by a positional script; each entry asserts the gate label it answers.
class Script implements DecisionSource {
  private i = 0;
  constructor(private readonly entries: Array<{ expect: string; verb: Verb; note?: string }>) {}
  decide(gate: Gate): Decision {
    const e = this.entries[this.i++];
    if (!e) throw new Error(`no scripted decision for gate '${gate.label}'`);
    expect(gate.label).toBe(e.expect);
    return { verb: e.verb, note: e.note };
  }
}

// A member runner whose emitted artifacts carry caller-controlled usage (for budget/timebox tests).
class FakeMembers implements MemberRunner {
  constructor(
    private readonly caps: Array<{ member: string; kind: string }>,
    private readonly docFor: (member: string, kind: string, unit: string, project: string) => string,
  ) {}
  capabilities() {
    return this.caps;
  }
  produce(member: string, kind: string, unit: string, project: string) {
    return { doc: this.docFor(member, kind, unit, project) };
  }
}

function doc(o: {
  kind: string;
  id: string;
  unit: string;
  project: string;
  produced_by: string;
  status?: string;
  usd?: number;
  wall?: number;
}): string {
  return [
    "---",
    `kind: ${o.kind}`,
    `id: ${o.id}`,
    `unit: ${o.unit}`,
    `project: ${o.project}`,
    `status: ${o.status ?? "in-review"}`,
    `produced_by: ${o.produced_by}`,
    "consumes: []",
    "supersedes: null",
    "approved_by: null",
    "created: 2026-07-11",
    "files: []",
    "usage:",
    "  model: test",
    "  tokens_in: 1",
    "  tokens_out: 1",
    `  usd: ${o.usd ?? 0}`,
    `  wall_clock_s: ${o.wall ?? 0}`,
    "---",
    "",
    `# ${o.kind}`,
    "",
    "A single body paragraph that stands as the display summary.",
  ].join("\n");
}

function team(over: Partial<Team> & { name: string; flow: FlowNode[]; produces: string[]; members: string[] }): Team {
  return {
    consumes: [],
    mode: "declarative",
    style: { color: "#000" },
    charter: "",
    ...over,
  };
}
function type(name: string, expects: string[]): TypeTemplate {
  return { name, glyph: "?", expects, gates: [] };
}
function project(name: string, pace: "auto" | "step" = "auto"): Project {
  return { name, repo: "r", remote: null, default_branch: "main", deploy: null, pace, houseRules: "" };
}
function unit(over: Partial<WorkUnit> & { unit: string; project: string; type: string }): WorkUnit {
  return { status: "active", dir: "/tmp/x", ...over };
}

function makeRepo(parts: { teams: Team[]; types: TypeTemplate[]; projects: Project[]; units: WorkUnit[] }): Repo {
  return {
    root: "/tmp/synthetic",
    teams: new Map(parts.teams.map((t) => [t.name, t])),
    types: new Map(parts.types.map((t) => [t.name, t])),
    projects: new Map(parts.projects.map((p) => [p.name, p])),
    agents: new Map(),
    units: parts.units,
    artifacts: new Map(),
  };
}

// ---------------------------------------------------------------------------
// Type templates + flow parsing (loaded from the golden fixture)
// ---------------------------------------------------------------------------

describe("registry loading", () => {
  const repo = loadRepo("fixtures/golden");

  test("all five type templates load with their glyphs", () => {
    for (const t of ["inception", "feature", "fix", "spike", "research"]) {
      expect(repo.types.has(t)).toBe(true);
    }
    expect(repo.types.get("spike")!.timebox).toBe("1d");
    expect(repo.types.get("research")!.promotable_to).toBe("knowledge");
    expect(repo.types.get("feature")!.expects).toContain("spec");
  });

  test("kestrel flow normalizes into step/gate/loop nodes", () => {
    const flow = repo.teams.get("kestrel")!.flow;
    expect(flow.map((n) => n.kind)).toEqual(["step", "gate", "step", "gate", "loop"]);
    const loop = flow[4];
    if (loop.kind !== "loop") throw new Error("expected loop");
    expect(loop.between).toEqual(["spec", "review"]);
    expect(loop.until).toBe("spec.approved");
    expect(loop.maxRounds).toBe(3);
    expect(loop.onExhaust).toBe("gate");
  });
});

// ---------------------------------------------------------------------------
// Golden walk: gates halt/resume, loop terminates by condition in round 2
// ---------------------------------------------------------------------------

describe("golden walk against stub members", () => {
  test("halts at each declared gate and matches expected.json", () => {
    const repo = loadRepo("fixtures/golden");
    const script = new Script([
      { expect: "brief", verb: "approve", note: "cas 2026-07-11" },
      { expect: "design", verb: "approve", note: "cas 2026-07-11" },
      { expect: "spec review", verb: "request" },
      { expect: "spec review", verb: "approve", note: "cas 2026-07-11" },
    ]);
    const runner = new Runner(repo, { members: new StubRunner(), decisions: script });
    const result = runner.run();

    // Four gates were raised (brief, design, and two loop rounds).
    const gates = result.events.filter((e) => e.t === "gate-raised");
    expect(gates.length).toBe(4);

    // Loop terminated by condition in round 2.
    const end = result.events.find((e) => e.t === "loop-end");
    expect(end).toMatchObject({ reason: "condition", round: 2 });

    const arts = result.artifacts.get("storefront/checkout-flow")!;
    expect(arts.get("product-brief-v1")!.status).toBe("approved");
    expect(arts.get("design-checkout-v1")!.status).toBe("approved");
    expect(arts.get("spec-checkout-flow-v1")!.status).toBe("superseded");
    expect(arts.get("spec-checkout-flow-v2")!.status).toBe("approved");
    expect(arts.get("review-checkout-flow-v2")!.status).toBe("in-review");
    expect(result.unitStatus.get("storefront/checkout-flow")).toBe("active");
  });

  test("only the Conductor's approval sets approved_by", () => {
    const repo = loadRepo("fixtures/golden");
    const script = new Script([
      { expect: "brief", verb: "approve", note: "cas 2026-07-11" },
      { expect: "design", verb: "approve", note: "cas 2026-07-11" },
      { expect: "spec review", verb: "request" },
      { expect: "spec review", verb: "approve", note: "cas 2026-07-11" },
    ]);
    const result = new Runner(repo, { members: new StubRunner(), decisions: script }).run();
    const brief = result.artifacts.get("storefront/checkout-flow")!.get("product-brief-v1")!;
    expect(brief.approved_by).toBe("cas 2026-07-11");
  });
});

// ---------------------------------------------------------------------------
// Loop exhaustion → on_exhaust: gate
// ---------------------------------------------------------------------------

describe("loop exhaustion", () => {
  test("three rounds without approval escalate via on_exhaust gate and pause the unit", () => {
    const repo = loadRepo("fixtures/golden");
    const script = new Script([
      { expect: "brief", verb: "approve" },
      { expect: "design", verb: "approve" },
      { expect: "spec review", verb: "request" },
      { expect: "spec review", verb: "request" },
      { expect: "spec review", verb: "request" },
      { expect: "spec exhausted", verb: "reject" },
    ]);
    const result = new Runner(repo, { members: new StubRunner(), decisions: script }).run();

    const end = result.events.find((e) => e.t === "loop-end");
    expect(end).toMatchObject({ reason: "exhausted", round: 3 });
    const exhaustGate = result.events.find((e) => e.t === "gate-raised" && e.gate.type === "exhaust");
    expect(exhaustGate).toBeDefined();
    expect(result.unitStatus.get("storefront/checkout-flow")).toBe("paused");
  });
});

// ---------------------------------------------------------------------------
// Start gates (after:)
// ---------------------------------------------------------------------------

describe("start gates via after:", () => {
  const buildRepo = (units: WorkUnit[]) =>
    makeRepo({
      teams: [team({ name: "acme", produces: ["alpha"], members: ["m1"], flow: [{ kind: "step", step: "alpha" }] })],
      types: [type("t", ["alpha"])],
      projects: [project("p")],
      units,
    });
  const members = new FakeMembers([{ member: "m1", kind: "alpha" }], (m, k, u, p) =>
    doc({ kind: k, id: `${k}-1`, unit: u, project: p, produced_by: `acme/${m}` }),
  );

  test("a unit with an unmet after: is invisible to the walk (no production)", () => {
    const repo = buildRepo([unit({ unit: "u2", project: "p", type: "t", after: ["u1"] })]);
    const result = new Runner(repo, { members, decisions: new Script([]) }).run();
    expect(result.events.some((e) => e.t === "produce")).toBe(false);
    expect(result.events.some((e) => e.t === "walk" && e.note.includes("invisible"))).toBe(true);
  });

  test("when after: is satisfied a start gate is raised; 'start' proceeds to the flow", () => {
    const repo = buildRepo([
      unit({ unit: "u1", project: "p", type: "t", status: "shipped" }),
      unit({ unit: "u2", project: "p", type: "t", after: ["u1"] }),
    ]);
    const result = new Runner(repo, {
      members,
      decisions: new Script([{ expect: "start", verb: "start" }]),
    }).run();
    const startGate = result.events.find((e) => e.t === "gate-raised" && e.gate.type === "start");
    expect(startGate).toBeDefined();
    expect(result.events.some((e) => e.t === "produce" && e.unit === "u2")).toBe(true);
  });

  test("'notyet' on the start gate leaves the unit unstarted", () => {
    const repo = buildRepo([
      unit({ unit: "u1", project: "p", type: "t", status: "shipped" }),
      unit({ unit: "u2", project: "p", type: "t", after: ["u1"] }),
    ]);
    const result = new Runner(repo, {
      members,
      decisions: new Script([{ expect: "start", verb: "notyet" }]),
    }).run();
    expect(result.events.some((e) => e.t === "produce" && e.unit === "u2")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Budget + timebox gates
// ---------------------------------------------------------------------------

describe("declared limits", () => {
  const twoStepTeam = team({
    name: "acme",
    produces: ["alpha", "beta"],
    members: ["m1", "m2"],
    flow: [
      { kind: "step", step: "alpha" },
      { kind: "step", step: "beta" },
    ],
  });
  const caps = [
    { member: "m1", kind: "alpha" },
    { member: "m2", kind: "beta" },
  ];

  test("crossing the unit budget raises a budget gate; 'stop' pauses the walk", () => {
    const members = new FakeMembers(caps, (m, k, u, p) =>
      doc({ kind: k, id: `${k}-1`, unit: u, project: p, produced_by: `acme/${m}`, usd: 0.06 }),
    );
    const repo = makeRepo({
      teams: [twoStepTeam],
      types: [type("t", ["alpha", "beta"])],
      projects: [project("p")],
      units: [unit({ unit: "u", project: "p", type: "t", budget: 0.1 })],
    });
    const result = new Runner(repo, {
      members,
      decisions: new Script([{ expect: "budget", verb: "stop" }]),
    }).run();
    expect(result.events.some((e) => e.t === "budget")).toBe(true);
    expect(result.unitStatus.get("p/u")).toBe("paused");
  });

  test("'continue' on the budget gate keeps the walk going", () => {
    const members = new FakeMembers(caps, (m, k, u, p) =>
      doc({ kind: k, id: `${k}-1`, unit: u, project: p, produced_by: `acme/${m}`, usd: 0.06 }),
    );
    const repo = makeRepo({
      teams: [twoStepTeam],
      types: [type("t", ["alpha", "beta"])],
      projects: [project("p")],
      units: [unit({ unit: "u", project: "p", type: "t", budget: 0.1 })],
    });
    const result = new Runner(repo, {
      members,
      decisions: new Script([{ expect: "budget", verb: "continue" }]),
    }).run();
    expect(result.unitStatus.get("p/u")).toBe("active");
    expect(result.events.filter((e) => e.t === "produce").length).toBe(2);
  });

  test("crossing the timebox raises a timebox gate", () => {
    const members = new FakeMembers(caps, (m, k, u, p) =>
      doc({ kind: k, id: `${k}-1`, unit: u, project: p, produced_by: `acme/${m}`, wall: 40 }),
    );
    const repo = makeRepo({
      teams: [twoStepTeam],
      types: [type("t", ["alpha", "beta"])],
      projects: [project("p")],
      units: [unit({ unit: "u", project: "p", type: "t", timebox: "1m" })],
    });
    const result = new Runner(repo, {
      members,
      decisions: new Script([{ expect: "timebox", verb: "stop" }]),
    }).run();
    expect(result.events.some((e) => e.t === "timebox")).toBe(true);
    expect(result.unitStatus.get("p/u")).toBe("paused");
  });

  test("timeboxSeconds parses day/hour/minute/second/bare forms", () => {
    expect(timeboxSeconds("1d")).toBe(86400);
    expect(timeboxSeconds("6h")).toBe(21600);
    expect(timeboxSeconds("30m")).toBe(1800);
    expect(timeboxSeconds("90s")).toBe(90);
    expect(timeboxSeconds("3600")).toBe(3600);
    expect(timeboxSeconds(null)).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// pace: step
// ---------------------------------------------------------------------------

describe("pace: step", () => {
  test("pauses for a nod before each team invocation", () => {
    const members = new FakeMembers([{ member: "m1", kind: "alpha" }], (m, k, u, p) =>
      doc({ kind: k, id: `${k}-1`, unit: u, project: p, produced_by: `acme/${m}` }),
    );
    const repo = makeRepo({
      teams: [team({ name: "acme", produces: ["alpha"], members: ["m1"], flow: [{ kind: "step", step: "alpha" }] })],
      types: [type("t", ["alpha"])],
      projects: [project("p", "step")],
      units: [unit({ unit: "u", project: "p", type: "t" })],
    });
    const result = new Runner(repo, {
      members,
      decisions: new Script([{ expect: "pace: alpha", verb: "approve" }]),
    }).run();
    expect(result.events.some((e) => e.t === "pace" && e.step === "alpha")).toBe(true);
    expect(result.events.some((e) => e.t === "produce")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Boundary contract + step resolution
// ---------------------------------------------------------------------------

describe("boundary contract enforcement", () => {
  test("off-contract member output is rejected at the boundary", () => {
    const members = new FakeMembers([{ member: "m1", kind: "alpha" }], () => "---\nkind: alpha\n---\nno id, off contract\n");
    const repo = makeRepo({
      teams: [team({ name: "acme", produces: ["alpha"], members: ["m1"], flow: [{ kind: "step", step: "alpha" }] })],
      types: [type("t", ["alpha"])],
      projects: [project("p")],
      units: [unit({ unit: "u", project: "p", type: "t" })],
    });
    expect(() => new Runner(repo, { members, decisions: new Script([]) }).run()).toThrow(/off-contract/);
  });

  test("an ambiguous flow step fails loudly", () => {
    const members = new FakeMembers(
      [
        { member: "m1", kind: "alpha" },
        { member: "m2", kind: "alpha" },
      ],
      (m, k, u, p) => doc({ kind: k, id: `${k}-1`, unit: u, project: p, produced_by: `acme/${m}` }),
    );
    const repo = makeRepo({
      teams: [team({ name: "acme", produces: ["alpha"], members: ["m1", "m2"], flow: [{ kind: "step", step: "alpha" }] })],
      types: [type("t", ["alpha"])],
      projects: [project("p")],
      units: [unit({ unit: "u", project: "p", type: "t" })],
    });
    expect(() => new Runner(repo, { members, decisions: new Script([]) }).run()).toThrow(/ambiguous/);
  });
});

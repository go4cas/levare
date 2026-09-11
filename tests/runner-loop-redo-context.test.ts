import { test, expect, describe } from "bun:test";
import { Runner, type Decision, type DecisionSource, type Gate, type MemberRunner, type Verb } from "../src/runner.ts";
import type { Repo } from "../src/repo.ts";
import type { FlowNode, Project, Team, TypeTemplate, WorkUnit } from "../src/types.ts";

// Goal REDO-CONTEXT, batch engine half: runner.ts#runLoop's own request-changes redo must agree with
// board/gateops.ts#doRequest — the round's own live review (still in-review at the moment of
// resolution) in the author's `extraConsumes`, and the Conductor's `note` threaded through as a
// distinct, labelled seam, not silently dropped. Drives the real `Runner` (never a hand-rolled
// stand-in for it) with a `MemberRunner` double that records exactly what `produce()` was called
// with — the same technique `tests/loop-c14.test.ts#pressRunner` already uses for the live path.

const CAS = "cas 2026-09-11";

class Script implements DecisionSource {
  private i = 0;
  constructor(private readonly entries: Array<{ expect: string; verb: Verb; by?: string; note?: string }>) {}
  decide(gate: Gate): Decision {
    const e = this.entries[this.i++];
    if (!e) throw new Error(`no scripted decision for gate '${gate.label}'`);
    expect(gate.label).toBe(e.expect);
    return { verb: e.verb, by: e.by, note: e.note };
  }
}

interface Call {
  member: string;
  kind: string;
  extraConsumes?: string[];
  requestChangesNote?: { note: string; on: string };
}

class RecordingMembers implements MemberRunner {
  calls: Call[] = [];
  capabilities() {
    return [
      { member: "scribe", kind: "product-brief" },
      { member: "corvid", kind: "review" },
    ];
  }
  produce(member: string, kind: string, unit: string, project: string, extraConsumes?: string[], requestChangesNote?: { note: string; on: string }) {
    this.calls.push({ member, kind, extraConsumes: extraConsumes ? [...extraConsumes] : undefined, requestChangesNote });
    const doc = [
      "---",
      `kind: ${kind}`,
      `id: ${kind}-${unit}-v1`,
      `unit: ${unit}`,
      `project: ${project}`,
      "status: in-review",
      `produced_by: press/${member}`,
      "consumes: []",
      "supersedes: null",
      "approved_by: null",
      "created: 2026-09-11",
      "files: []",
      "---",
      "",
      `# ${kind}`,
      "",
      `Drafted by ${member}.`,
      "",
    ].join("\n");
    return { doc };
  }
}

function makeRepo(): { repo: Repo; unit: WorkUnit } {
  const team: Team = {
    name: "press",
    consumes: [],
    produces: ["product-brief", "review"],
    members: ["scribe", "corvid"],
    flow: [
      { kind: "loop", between: ["product-brief", "review"], until: "review.approved", maxRounds: 3, onExhaust: "gate" } as FlowNode,
    ],
    style: { color: "#000" },
    charter: "",
    learnings: "",
  };
  const type: TypeTemplate = { name: "feature", glyph: "?", expects: ["product-brief", "review"], gates: [] };
  const project: Project = { name: "acme", repo: "r", remote: null, default_branch: "main", deploy: null, pace: "auto", houseRules: "" };
  const unit: WorkUnit = { type: "feature", status: "active", project: "acme", unit: "announcement", dir: "/tmp/x" };
  const repo: Repo = {
    root: "/tmp/synthetic",
    teams: new Map([[team.name, team]]),
    types: new Map([[type.name, type]]),
    projects: new Map([[project.name, project]]),
    agents: new Map(),
    connectors: new Map(),
    units: [unit],
    artifacts: new Map(),
    studio: {},
  };
  return { repo, unit };
}

describe("runner.ts#runLoop's request-changes redo agrees with board/gateops.ts#doRequest", () => {
  test("round 2's author call carries round 1's own review in extraConsumes and the Conductor's note", () => {
    const { repo } = makeRepo();
    const members = new RecordingMembers();
    const NOTE = "Please add a citation for the pricing claim.";
    const decisions = new Script([
      { expect: "start", verb: "start", by: CAS },
      { expect: "product-brief review", verb: "request", by: CAS, note: NOTE },
      { expect: "product-brief review", verb: "approve", by: CAS },
    ]);
    const runner = new Runner(repo, { members, decisions });
    runner.run();

    expect(members.calls.map((c) => `${c.member}:${c.kind}`)).toEqual([
      "scribe:product-brief", // round 1 author
      "corvid:review", // round 1 critic
      "scribe:product-brief", // round 2 author redo
      "corvid:review", // round 2 critic
    ]);

    // Round 1 calls carry no redo seam at all — the round-1 (byte-for-byte-unchanged) case.
    expect(members.calls[0].extraConsumes).toBeUndefined();
    expect(members.calls[0].requestChangesNote).toBeUndefined();

    // The round-2 author redo is where the fix lives: it must receive round 1's own review (still
    // in-review at the moment `request` is resolved) via extraConsumes, and the Conductor's note.
    expect(members.calls[2].extraConsumes).toEqual(["review-announcement-v1"]);
    expect(members.calls[2].requestChangesNote).toEqual({ note: NOTE, on: "product-brief-announcement-v1" });

    // The critic never gets a note — only the author's redo does.
    expect(members.calls[3].requestChangesNote).toBeUndefined();
  });
});

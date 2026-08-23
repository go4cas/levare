// Phase 2 "gate card is where decisions happen" goal — items 1/2/3 (Findings 82/83/72/97). Pure
// function tests, no disk/git/daemon: `dispatchingFor` and `gateKindLabel` take only an `OpenGate` (and
// `DaemonInvocation[]` for the former) — the same in-memory-fixture idiom tests/board-merge-gate-card.
// test.ts already uses for `gateCardHtml` itself.

import { test, expect, describe } from "bun:test";
import { dispatchingFor, gateKindLabel, gateCardHtml } from "../src/board/render/shell.ts";
import type { OpenGate } from "../src/derive.ts";
import type { Artifact, Project, Team, TypeTemplate, WorkUnit } from "../src/types.ts";
import type { Repo } from "../src/repo.ts";
import type { DaemonInvocation } from "../src/daemon.ts";

function artifact(over: Partial<Artifact> = {}): Artifact {
  return {
    kind: "spec",
    id: "spec-flow-v1",
    unit: "flow",
    project: "acme",
    status: "in-review",
    produced_by: "kestrel/lyra",
    consumes: [],
    supersedes: null,
    approved_by: null,
    created: "2026-07-17T00:00:00.000Z",
    files: [],
    ...over,
  };
}

function inv(over: Partial<DaemonInvocation> = {}): DaemonInvocation {
  return { project: "acme", unit: "flow", member: "lyra", kind: "spec", startedAt: "2026-07-17T01:59:00.000Z", ...over };
}

describe("dispatchingFor — matches the running invocation to the gate it actually belongs to (Finding 82/83/72)", () => {
  test("a plain (non-loop) artifact gate matches a running invocation of its OWN kind", () => {
    const gate: OpenGate = { type: "artifact", project: "acme", unit: "flow", target: "spec-flow-v1", artifact: artifact(), label: "spec" };
    const d = dispatchingFor([inv({ kind: "spec" })], gate);
    expect(d).toEqual({ member: "lyra", kind: "spec", startedAt: "2026-07-17T01:59:00.000Z", loop: undefined });
  });

  test("a plain (non-loop) artifact gate does NOT match a running invocation of an unrelated kind for the same unit — the regression this fix guards against", () => {
    const gate: OpenGate = { type: "artifact", project: "acme", unit: "flow", target: "spec-flow-v1", artifact: artifact(), label: "spec" };
    const d = dispatchingFor([inv({ kind: "docs" })], gate);
    expect(d).toBeUndefined();
  });

  test("a loop's until-named gate matches a running invocation of the loop's COMPANION kind (F16 request-changes redo) — the case a naive kind-only match would break", () => {
    const gate: OpenGate = {
      type: "artifact",
      project: "acme",
      unit: "flow",
      target: "review-flow-v1",
      artifact: artifact({ kind: "review", id: "review-flow-v1" }),
      label: "review",
      loop: { round: 1, maxRounds: 3, until: "review.approved", exhausted: false, companionKind: "spec" },
    };
    // doRequest always re-invokes the AUTHOR kind ("spec"), never the gate's own kind ("review").
    const d = dispatchingFor([inv({ kind: "spec", member: "lyra" })], gate);
    expect(d).toEqual({ member: "lyra", kind: "spec", startedAt: "2026-07-17T01:59:00.000Z", loop: { round: 2, maxRounds: 3 } });
  });

  test("a loop gate does NOT match a kind that is neither its own nor its companion's", () => {
    const gate: OpenGate = {
      type: "artifact",
      project: "acme",
      unit: "flow",
      target: "review-flow-v1",
      artifact: artifact({ kind: "review", id: "review-flow-v1" }),
      label: "review",
      loop: { round: 1, maxRounds: 3, until: "review.approved", exhausted: false, companionKind: "spec" },
    };
    const d = dispatchingFor([inv({ kind: "docs" })], gate);
    expect(d).toBeUndefined();
  });

  test("a start gate (no kind of its own) matches ANY running invocation for the unit — unambiguous, since zero artifacts exist yet", () => {
    const gate: OpenGate = { type: "start", project: "acme", unit: "flow", target: "flow", label: "start" };
    const d = dispatchingFor([inv({ kind: "product-brief", member: "wren" })], gate);
    expect(d).toEqual({ member: "wren", kind: "product-brief", startedAt: "2026-07-17T01:59:00.000Z", loop: undefined });
  });

  test("no running invocation for the unit at all → undefined", () => {
    const gate: OpenGate = { type: "artifact", project: "acme", unit: "flow", target: "spec-flow-v1", artifact: artifact(), label: "spec" };
    expect(dispatchingFor([inv({ unit: "other-unit" })], gate)).toBeUndefined();
  });
});

describe("gateKindLabel — names which of start/step/loop/merge/blocked this gate is (Finding 97)", () => {
  test("start", () => {
    expect(gateKindLabel({ type: "start", project: "acme", unit: "flow", target: "flow", label: "start" })).toBe("start");
  });
  test("a studio-misconfiguration block", () => {
    expect(gateKindLabel({ type: "blocked", project: "acme", unit: "flow", target: "flow", label: "blocked", reason: "x" })).toBe("blocked");
  });
  test("a failed member's artifact-blocked gate", () => {
    expect(gateKindLabel({ type: "artifact-blocked", project: "acme", unit: "flow", target: "spec-flow-v1", artifact: artifact({ status: "blocked" }), label: "spec" })).toBe(
      "blocked",
    );
  });
  test("a plain non-loop review reads as a step, not the generic 'on you'", () => {
    expect(gateKindLabel({ type: "artifact", project: "acme", unit: "flow", target: "spec-flow-v1", artifact: artifact(), label: "spec" })).toBe("step");
  });
  test("a loop round names the round, not the generic 'on you'", () => {
    const gate: OpenGate = {
      type: "artifact",
      project: "acme",
      unit: "flow",
      target: "spec-flow-v2",
      artifact: artifact({ id: "spec-flow-v2" }),
      label: "spec",
      loop: { round: 2, maxRounds: 3, until: "spec.approved", exhausted: false, companionKind: "review" },
    };
    expect(gateKindLabel(gate)).toBe("loop · 2/3");
  });
  test("a merge gate reads 'merge', distinct from a plain step, even though both are type: artifact", () => {
    expect(gateKindLabel({ type: "artifact", project: "acme", unit: "flow", target: "merge-flow-v1", artifact: artifact({ kind: "merge" }), label: "merge" })).toBe("merge");
  });
});

// ---------------------------------------------------------------------------
// Rendering: the card's dispatching state uses the SAME elapsedLabel + round n/m vocabulary
// render/run.ts's Tier-3 live strip already uses (Phase 2 "gate card" goal, item 2) — not a
// re-invented one. Minimal in-memory Repo, same idiom as tests/board-merge-gate-card.test.ts.
// ---------------------------------------------------------------------------
function project(over: Partial<Project> = {}): Project {
  return { name: "acme", repo: "/tmp/acme", remote: null, default_branch: "main", deploy: null, pace: "auto", houseRules: "", ...over };
}
function unitType(): TypeTemplate {
  return { name: "feature", glyph: "&#9656;", expects: ["spec", "review"], gates: ["human"] };
}
function workUnit(): WorkUnit {
  return { type: "feature", status: "active", project: "acme", unit: "flow", dir: "/tmp/acme-studio/work/acme/flow" };
}
function makeRepo(art: Artifact, teams: Team[] = []): Repo {
  const p = project();
  const u = workUnit();
  const t = unitType();
  return {
    root: "/tmp/acme-studio",
    teams: new Map(teams.map((tm) => [tm.name, tm])),
    agents: new Map(),
    types: new Map([[t.name, t]]),
    projects: new Map([[p.name, p]]),
    connectors: new Map(),
    units: [u],
    artifacts: new Map([[`${p.name}/${u.unit}`, new Map([[art.id, art]])]]),
    studio: {},
  };
}

describe("gate card dispatching state renders elapsed + round n/m, not just static text", () => {
  const NOW = new Date("2026-07-17T02:00:00.000Z");

  test("a loop redo in flight shows the NEXT round (one past the still-open gate's own round) and real elapsed time", () => {
    const art = artifact({ kind: "review", id: "review-flow-v2" });
    const repo = makeRepo(art);
    const gate: OpenGate = {
      type: "artifact",
      project: "acme",
      unit: "flow",
      target: art.id,
      artifact: art,
      label: "review",
      loop: { round: 2, maxRounds: 3, until: "review.approved", exhausted: false, companionKind: "spec" },
    };
    const html = gateCardHtml(repo, gate, NOW, {
      dispatching: { member: "lyra", kind: "spec", startedAt: "2026-07-17T01:58:15.000Z", loop: { round: 3, maxRounds: 3 } },
    });
    expect(html).toContain("is-dispatching");
    expect(html).toContain("round 3/3");
    expect(html).toContain("1m 45s");
  });

  test("a non-loop dispatch shows elapsed with no round text at all", () => {
    const art = artifact();
    const repo = makeRepo(art);
    const gate: OpenGate = { type: "artifact", project: "acme", unit: "flow", target: art.id, artifact: art, label: "spec" };
    const html = gateCardHtml(repo, gate, NOW, { dispatching: { member: "lyra", kind: "spec", startedAt: "2026-07-17T01:59:30.000Z" } });
    expect(html).toContain("is-dispatching");
    expect(html).toContain('class="pending__label">dispatching lyra · spec… · 0m 30s</span>');
  });
});

// Phase 2 "gate card is where decisions happen" goal — items 1/2/3 (Findings 82/83/72/97). Pure
// function tests, no disk/git/daemon: `dispatchingFor` and `gateKindLabel` take only an `OpenGate` (and
// `DaemonInvocation[]` for the former) — the same in-memory-fixture idiom tests/board-merge-gate-card.
// test.ts already uses for `gateCardHtml` itself.

import { test, expect, describe } from "bun:test";
import { dispatchingFor, gateKindLabel, gateCardHtml } from "../src/board/render/shell.ts";
import type { OpenGate } from "../src/derive.ts";
import type { Agent, Artifact, Project, Team, TypeTemplate, WorkUnit } from "../src/types.ts";
import type { Repo } from "../src/repo.ts";
import type { DaemonInvocation } from "../src/daemon.ts";

function agent(over: Partial<Agent> = {}): Agent {
  return { name: "lyra", kind: "native", produces: ["spec"], style: { avatar: "Ly" }, body: "", ...over };
}

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

// dispatchingFor only reads repo.agents (Finding 81 part 3: resolving each invocation's member to its
// declared timeout) — every other field is unused by the gate-matching logic under test here, so an
// empty agents map is enough; `timeoutS` on the result is then always undefined, matching every
// existing `toEqual` expectation below (toEqual treats an absent key and an explicit undefined alike).
const repo = { root: "/tmp", teams: new Map(), agents: new Map(), types: new Map(), projects: new Map(), connectors: new Map(), units: [], artifacts: new Map(), studio: {} } as unknown as Repo;

describe("dispatchingFor — matches the running invocation to the gate it actually belongs to (Finding 82/83/72)", () => {
  test("a plain (non-loop) artifact gate matches a running invocation of its OWN kind", () => {
    const gate: OpenGate = { type: "artifact", project: "acme", unit: "flow", target: "spec-flow-v1", artifact: artifact(), label: "spec" };
    const d = dispatchingFor(repo, [inv({ kind: "spec" })], gate);
    expect(d).toEqual({ member: "lyra", kind: "spec", startedAt: "2026-07-17T01:59:00.000Z", loop: undefined });
  });

  test("a plain (non-loop) artifact gate does NOT match a running invocation of an unrelated kind for the same unit — the regression this fix guards against", () => {
    const gate: OpenGate = { type: "artifact", project: "acme", unit: "flow", target: "spec-flow-v1", artifact: artifact(), label: "spec" };
    const d = dispatchingFor(repo, [inv({ kind: "docs" })], gate);
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
    const d = dispatchingFor(repo, [inv({ kind: "spec", member: "lyra" })], gate);
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
    const d = dispatchingFor(repo, [inv({ kind: "docs" })], gate);
    expect(d).toBeUndefined();
  });

  test("a start gate (no kind of its own) matches ANY running invocation for the unit — unambiguous, since zero artifacts exist yet", () => {
    const gate: OpenGate = { type: "start", project: "acme", unit: "flow", target: "flow", label: "start" };
    const d = dispatchingFor(repo, [inv({ kind: "product-brief", member: "wren" })], gate);
    expect(d).toEqual({ member: "wren", kind: "product-brief", startedAt: "2026-07-17T01:59:00.000Z", loop: undefined });
  });

  test("no running invocation for the unit at all → undefined", () => {
    const gate: OpenGate = { type: "artifact", project: "acme", unit: "flow", target: "spec-flow-v1", artifact: artifact(), label: "spec" };
    expect(dispatchingFor(repo, [inv({ unit: "other-unit" })], gate)).toBeUndefined();
  });

  // Finding 81 part 3: the board must show the exact bound a real dispatch would enforce, not a
  // second guess at it — dispatchingFor resolves it the same way adapters.ts#resolveMemberTimeoutS
  // would for a real dispatch of this member.
  test("resolves timeoutS from the member's own declared agent.timeout", () => {
    const withAgent = { root: "/tmp", teams: new Map(), agents: new Map([["lyra", agent({ timeout: 90 })]]), types: new Map(), projects: new Map(), connectors: new Map(), units: [], artifacts: new Map(), studio: {} } as unknown as Repo;
    const gate: OpenGate = { type: "artifact", project: "acme", unit: "flow", target: "spec-flow-v1", artifact: artifact(), label: "spec" };
    const d = dispatchingFor(withAgent, [inv({ kind: "spec" })], gate);
    expect(d?.timeoutS).toBe(90);
  });

  test("falls back to the native default (1200s) when the agent declares no timeout of its own", () => {
    const withAgent = { root: "/tmp", teams: new Map(), agents: new Map([["lyra", agent()]]), types: new Map(), projects: new Map(), connectors: new Map(), units: [], artifacts: new Map(), studio: {} } as unknown as Repo;
    const gate: OpenGate = { type: "artifact", project: "acme", unit: "flow", target: "spec-flow-v1", artifact: artifact(), label: "spec" };
    const d = dispatchingFor(withAgent, [inv({ kind: "spec" })], gate);
    expect(d?.timeoutS).toBe(1200);
  });

  test("member no longer resolves to a known agent → timeoutS absent, not fabricated", () => {
    const gate: OpenGate = { type: "artifact", project: "acme", unit: "flow", target: "spec-flow-v1", artifact: artifact(), label: "spec" };
    const d = dispatchingFor(repo, [inv({ kind: "spec" })], gate); // `repo` above has an empty agents map
    expect(d?.timeoutS).toBeUndefined();
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
    // Finding 79: the elapsed text is wrapped in a `data-started-at`-carrying span (assets/app.js
    // ticks it client-side) rather than rendered as bare text — the label's other pieces are still
    // plain, escaped text around it.
    expect(html).toContain('class="pending__label">dispatching lyra · spec… · <span class="elapsed" data-started-at="2026-07-17T01:59:30.000Z">0m 30s</span></span>');
  });

  // Finding 81 part 3: "8m 20s / 20m" tells a Conductor whether a dispatch is near its own kill
  // bound — "8m 20s" alone does not. The bound renders as a static sibling span (never inside the
  // ticking `.elapsed` span itself, which app.js overwrites every second).
  //
  // 2026-08-25: the bound uses its own formatter (derive.ts#boundLabel), not the elapsed one. A bound
  // is a CONFIGURED value, not a measurement — `20m` is what the operator declared, and `20m 00s`
  // implies a precision the field does not carry. Observed live: the orphaned `00s` wrapped onto its
  // own line beside the ticking elapsed.
  test("a whole-minute bound renders bare — `20m`, not the elapsed formatter's `20m 00s`", () => {
    const art = artifact();
    const repo = makeRepo(art);
    const gate: OpenGate = { type: "artifact", project: "acme", unit: "flow", target: art.id, artifact: art, label: "spec" };
    const html = gateCardHtml(repo, gate, NOW, { dispatching: { member: "lyra", kind: "spec", startedAt: "2026-07-17T01:59:30.000Z", timeoutS: 1200 } });
    expect(html).toContain(
      '<span class="elapsed" data-started-at="2026-07-17T01:59:30.000Z">0m 30s</span> <span class="dim">/ 20m</span>',
    );
    expect(html).not.toContain("20m 00s");
  });

  test("a whole-hour bound renders as hours — `1h`, not `60m` and not `1h 00m`", () => {
    const art = artifact();
    const gate: OpenGate = { type: "artifact", project: "acme", unit: "flow", target: art.id, artifact: art, label: "spec" };
    const html = gateCardHtml(makeRepo(art), gate, NOW, { dispatching: { member: "lyra", kind: "spec", startedAt: "2026-07-17T01:59:30.000Z", timeoutS: 3600 } });
    expect(html).toContain('<span class="dim">/ 1h</span>');
  });

  // Dropping SPURIOUS zeros, not real precision: a bound an operator actually declared with a
  // seconds component still shows it.
  test("a bound with a real seconds component keeps them — `timeout: 90` reads `1m 30s`", () => {
    const art = artifact();
    const gate: OpenGate = { type: "artifact", project: "acme", unit: "flow", target: art.id, artifact: art, label: "spec" };
    const html = gateCardHtml(makeRepo(art), gate, NOW, { dispatching: { member: "lyra", kind: "spec", startedAt: "2026-07-17T01:59:30.000Z", timeoutS: 90 } });
    expect(html).toContain('<span class="dim">/ 1m 30s</span>');
  });

  test("a dispatch with no known timeoutS (member no longer resolves to an agent) shows elapsed alone, never a fabricated bound", () => {
    const art = artifact();
    const repo = makeRepo(art);
    const gate: OpenGate = { type: "artifact", project: "acme", unit: "flow", target: art.id, artifact: art, label: "spec" };
    const html = gateCardHtml(repo, gate, NOW, { dispatching: { member: "lyra", kind: "spec", startedAt: "2026-07-17T01:59:30.000Z" } });
    expect(html).not.toContain("dim");
  });
});

// Ruling 2026-08-23 ("the gate card is where decisions happen", Findings 104/105): the review's own
// verdict, declared in frontmatter, renders directly on the card — never buried in truncated prose,
// never silently omitted, and never guessed when absent. A card is a pure function of on-disk data
// (gateCardHtml, Repo+OpenGate+now), so a fabricated `verdict` field is enough to exercise all three
// states without a real critic dispatch.
describe("gate card renders the review's own verdict, declared — never extracted, never guessed", () => {
  const NOW = new Date("2026-07-17T02:00:00.000Z");

  function reviewGate(art: Artifact): OpenGate {
    return { type: "artifact", project: "acme", unit: "flow", target: art.id, artifact: art, label: "review" };
  }

  test("verdict: CHANGES REQUESTED renders plainly, not read off status", () => {
    const art = artifact({ kind: "review", id: "review-flow-v1", verdict: "CHANGES REQUESTED" });
    const html = gateCardHtml(makeRepo(art), reviewGate(art), NOW);
    expect(html).toContain("Verdict: CHANGES REQUESTED");
    expect(html).not.toContain("Verdict not recorded");
    expect(html).not.toContain("Verdict: APPROVED");
  });

  test("verdict: APPROVED renders plainly", () => {
    const art = artifact({ kind: "review", id: "review-flow-v1", verdict: "APPROVED", status: "approved" });
    const html = gateCardHtml(makeRepo(art), reviewGate(art), NOW);
    expect(html).toContain("Verdict: APPROVED");
    expect(html).not.toContain("Verdict not recorded");
  });

  // The exact hazard the ruling named: `status: approved` means the CONDUCTOR approved the review
  // artifact, never that the critic's own verdict was positive. review-find-entries-v1 (the real
  // artifact this finding is drawn from) is `status: approved` with no verdict recorded at all (it
  // predates the field) and CHANGES REQUESTED in its body — the card must not read `status` as a
  // stand-in for verdict, in either direction.
  test("status: approved with no verdict recorded renders 'not recorded' — never inferred as APPROVED from status", () => {
    const art = artifact({ kind: "review", id: "review-find-entries-v1", status: "approved", approved_by: "cas 2026-08-21" });
    const html = gateCardHtml(makeRepo(art), reviewGate(art), NOW);
    expect(html).toContain("Verdict not recorded");
    expect(html).not.toContain("Verdict: APPROVED");
    expect(html).not.toContain("Verdict: CHANGES REQUESTED");
  });

  test("no verdict field at all (every review this product has ever produced, pre-ruling) renders 'not recorded', not silence", () => {
    const art = artifact({ kind: "review", id: "review-flow-v1" });
    expect(art.verdict).toBeUndefined();
    const html = gateCardHtml(makeRepo(art), reviewGate(art), NOW);
    expect(html).toContain("Verdict not recorded");
  });

  test("a non-review kind never shows a verdict slot at all", () => {
    const art = artifact({ kind: "spec", id: "spec-flow-v1" });
    const gate: OpenGate = { type: "artifact", project: "acme", unit: "flow", target: art.id, artifact: art, label: "spec" };
    const html = gateCardHtml(makeRepo(art), gate, NOW);
    expect(html).not.toContain("gate__verdict");
    expect(html).not.toContain("Verdict");
  });

  test("the same three states render identically in the Orchestrator's cta card", () => {
    const changesRequested = artifact({ kind: "review", id: "review-flow-v1", verdict: "CHANGES REQUESTED" });
    const html = gateCardHtml(makeRepo(changesRequested), reviewGate(changesRequested), NOW, { cta: true });
    expect(html).toContain("Verdict: CHANGES REQUESTED");
  });
});

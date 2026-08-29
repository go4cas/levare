import { test, expect, describe } from "bun:test";
import { gateBriefingSentence, type OpenGate } from "../src/derive.ts";

// NOTES ORCH-STALE-CARD (content fault, independent of the propagation fix): the Orchestrator
// briefing used to name the artifact's kind with a fixed "is ready for review below" suffix
// regardless of `gate.type` — true for an in-review artifact, a lie for everything else a gate can be.
// Observed live: a blocked `review` artifact's briefing read "review is ready for review below.", and
// a failed `product-brief` read "product-brief is ready for review below." — confidently announcing
// work that did not exist. These are pure unit tests against synthetic gates, one per `OpenGate.type`,
// so each branch is pinned independently of any repo/fixture setup.

const BASE = { project: "acme", unit: "widget" };

describe("gateBriefingSentence — states what's actually true about the gate's own kind", () => {
  test("an in-review artifact really is ready for review", () => {
    const gate: OpenGate = { ...BASE, type: "artifact", target: "spec-v1", label: "spec" };
    expect(gateBriefingSentence(gate)).toBe("spec is ready for review below.");
  });

  test("a blocked (failed) artifact never claims to be ready for review — it failed and needs a decision", () => {
    const gate: OpenGate = { ...BASE, type: "artifact-blocked", target: "review-v1", label: "review" };
    expect(gateBriefingSentence(gate)).toBe("review failed and needs your decision below.");
    expect(gateBriefingSentence(gate)).not.toContain("ready for review");
  });

  test("a failed product-brief — the exact case observed live — reads honestly too", () => {
    const gate: OpenGate = { ...BASE, type: "artifact-blocked", target: "product-brief-v1", label: "product-brief" };
    expect(gateBriefingSentence(gate)).toBe("product-brief failed and needs your decision below.");
  });

  test("a start gate has nothing to review yet — it's ready to START, not ready for review", () => {
    const gate: OpenGate = { ...BASE, type: "start", target: "widget", label: "start" };
    expect(gateBriefingSentence(gate)).toBe("This unit is ready to start below.");
    expect(gateBriefingSentence(gate)).not.toContain("ready for review");
  });

  test("a unit the walk could not bind at all is blocked, not awaiting review", () => {
    const gate: OpenGate = { ...BASE, type: "blocked", target: "widget", label: "blocked", reason: "no team produces it" };
    expect(gateBriefingSentence(gate)).toBe("This unit is blocked and needs your attention below.");
  });

  test("the artifact kind is HTML-escaped — a `<`/`>`/`&` in a kind name never breaks out of the sentence", () => {
    const gate: OpenGate = { ...BASE, type: "artifact", target: "x", label: "<b>&hack</b>" };
    expect(gateBriefingSentence(gate)).toBe("&lt;b&gt;&amp;hack&lt;/b&gt; is ready for review below.");
  });
});

// Finding 145 site 3 sibling: the gate card directly below this sentence (run.ts's orchestrator
// panel) already swaps to "dispatching" the instant `dispatchingFor` finds a live redo — this sentence
// must not go on claiming the completed-state text while that card says otherwise.
describe("gateBriefingSentence(gate, dispatching) — follows a live dispatch, not the stale gate state", () => {
  test("an in-review artifact's re-dispatch in flight reads dispatching, not ready for review", () => {
    const gate: OpenGate = { ...BASE, type: "artifact", target: "spec-v1", label: "spec" };
    expect(gateBriefingSentence(gate, true)).toBe("spec is dispatching a redo right now &mdash; check back below.");
    expect(gateBriefingSentence(gate, true)).not.toContain("ready for review");
  });

  test("a blocked artifact's retry in flight reads retrying, not failed", () => {
    const gate: OpenGate = { ...BASE, type: "artifact-blocked", target: "review-v1", label: "review" };
    expect(gateBriefingSentence(gate, true)).toBe("review is retrying right now &mdash; check back below.");
    expect(gateBriefingSentence(gate, true)).not.toContain("failed");
  });

  test("a start gate's dispatch in flight reads dispatching, not ready to start", () => {
    const gate: OpenGate = { ...BASE, type: "start", target: "widget", label: "start" };
    expect(gateBriefingSentence(gate, true)).toBe("This unit is dispatching right now &mdash; check back below.");
  });

  test("no dispatch in flight (dispatching omitted) reads exactly as before", () => {
    const gate: OpenGate = { ...BASE, type: "artifact", target: "spec-v1", label: "spec" };
    expect(gateBriefingSentence(gate)).toBe("spec is ready for review below.");
  });
});

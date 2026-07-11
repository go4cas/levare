import { test, expect, describe } from "bun:test";
import { loadRepo } from "../src/repo.ts";
import { loopMembershipFor, responsibleTeamFor, resolveStep, unmetAfter } from "../src/gates.ts";
import { CAPABILITIES } from "../fixtures/stubs/member-stub.ts";

// gates.ts (ruling C7) is the shared home for the flow/gate-resolution helpers the Runner's walk and
// the board/Orchestrator's single-shot resolution must agree on. These pin the pure derivations
// directly, independent of any HTTP or Runner-walk plumbing.

const repo = loadRepo("fixtures/golden");
const kestrel = repo.teams.get("kestrel")!;

describe("loopMembershipFor", () => {
  test("the loop's first kind (spec) reports its companion (review)", () => {
    const m = loopMembershipFor(kestrel, "spec", CAPABILITIES);
    expect(m).toBeDefined();
    expect(m!.role).toBe("first");
    expect(m!.companionKind).toBe("review");
  });

  test("the loop's second kind (review) reports its companion (spec)", () => {
    const m = loopMembershipFor(kestrel, "review", CAPABILITIES);
    expect(m).toBeDefined();
    expect(m!.role).toBe("second");
    expect(m!.companionKind).toBe("spec");
  });

  test("a kind outside any loop (e.g. product-brief) reports no membership", () => {
    expect(loopMembershipFor(kestrel, "product-brief", CAPABILITIES)).toBeUndefined();
  });
});

describe("responsibleTeamFor", () => {
  test("kestrel is responsible for the feature-typed checkout-flow unit", () => {
    const unit = repo.units.find((u) => u.unit === "checkout-flow")!;
    expect(responsibleTeamFor(repo, unit)!.name).toBe("kestrel");
  });

  test("kestrel is also responsible for loyalty-flow (same feature type)", () => {
    const unit = repo.units.find((u) => u.unit === "loyalty-flow")!;
    expect(responsibleTeamFor(repo, unit)!.name).toBe("kestrel");
  });
});

describe("resolveStep", () => {
  test("resolves the flow's first step label ('brief') to wren's product-brief kind", () => {
    expect(resolveStep(kestrel, "brief", CAPABILITIES)).toEqual({ member: "wren", kind: "product-brief" });
  });

  test("an unresolvable step throws", () => {
    expect(() => resolveStep(kestrel, "ghost-step", CAPABILITIES)).toThrow(/no member/);
  });
});

describe("unmetAfter", () => {
  test("loyalty-flow's after: [cart-icon-fix] is satisfied (cart-icon-fix has shipped)", () => {
    const unit = repo.units.find((u) => u.unit === "loyalty-flow")!;
    expect(unmetAfter(repo, unit)).toEqual([]);
  });

  test("checkout-flow has no after: — trivially satisfied", () => {
    const unit = repo.units.find((u) => u.unit === "checkout-flow")!;
    expect(unmetAfter(repo, unit)).toEqual([]);
  });
});

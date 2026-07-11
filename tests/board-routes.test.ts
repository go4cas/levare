import { test, expect, describe } from "bun:test";
import { ROUTES, MUTATING_ROUTES } from "../src/board/serve.ts";

// PRD invariant 9 / §9: "the board's write surface is exactly three routes... a test asserts the
// route table." ROUTES is the single source of truth the router itself dispatches from (not a
// second, hand-maintained list), so this test can never drift from actual server behaviour.

describe("route table", () => {
  test("exactly three mutating (write) routes exist", () => {
    expect(MUTATING_ROUTES.length).toBe(3);
  });

  test("the three mutating routes are exactly the §9 route table, enumerated", () => {
    expect(MUTATING_ROUTES).toEqual([
      { method: "POST", pattern: "/gates/:project/:artifact/:verb" },
      { method: "POST", pattern: "/registry/*path" },
      { method: "POST", pattern: "/orchestrator/message" },
    ]);
  });

  test("every non-mutating route is a GET", () => {
    const nonMutating = ROUTES.filter((r) => !r.mutating);
    expect(nonMutating.every((r) => r.method === "GET")).toBe(true);
    expect(nonMutating.length).toBeGreaterThan(0);
  });

  test("no route is declared twice", () => {
    const keys = ROUTES.map((r) => `${r.method} ${r.pattern}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

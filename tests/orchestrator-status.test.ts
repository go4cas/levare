import { test, expect, describe } from "bun:test";
import { resolveOrchestratorStatus, ORCHESTRATOR_ENV_VAR } from "../src/orchestrator-status.ts";

// NOTES DIST4: a compiled `dist/levare` can never actually run the Orchestrator (its SDK worker spawn
// requires a real `bun` interpreter — see orchestrator-boundary.ts's `selectOrchestratorBoundary`),
// so `resolveOrchestratorStatus` must report "off" under a compiled binary regardless of what the
// local credential/native-binary precondition says — this module's own job is to keep "the badge says
// on" and "the route actually answers" from ever disagreeing.
describe("resolveOrchestratorStatus — refuses under a compiled binary regardless of credentials (NOTES DIST4)", () => {
  test("compiled=true → unavailable even with a present ANTHROPIC_API_KEY", () => {
    const status = resolveOrchestratorStatus({ ANTHROPIC_API_KEY: "sk-ant-test-not-real" }, {}, true);
    expect(status.available).toBe(false);
    expect(status.reason).toContain("compiled binary");
    expect(status.envVar).toBe(ORCHESTRATOR_ENV_VAR);
  });

  test("compiled=true → unavailable even with no key set (still the compiled reason, not the missing-key one)", () => {
    const status = resolveOrchestratorStatus({}, {}, true);
    expect(status.available).toBe(false);
    expect(status.reason).toContain("compiled binary");
  });

  test("compiled=false (a source run) falls through to the ordinary credential/binary precondition", () => {
    const status = resolveOrchestratorStatus({}, {}, false);
    expect(status.reason).not.toContain("compiled binary");
  });
});

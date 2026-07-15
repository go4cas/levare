import { test, expect, describe, beforeEach } from "bun:test";
import { resolveOrchestratorStatus, ORCHESTRATOR_ENV_VAR } from "../src/orchestrator-status.ts";
import { resetSdkPreconditionCache } from "../src/sdk-transport.ts";

// The precondition cache (sdk-transport.ts) is a module-level singleton shared across every test file
// in this `bun test` process — reset it before each test so no test's result depends on what ran
// before it (same discipline tests/orchestrator-sdk.test.ts already applies).
beforeEach(() => {
  resetSdkPreconditionCache();
});

// NOTES DIST5: `resolveOrchestratorStatus` no longer forces "off" under a compiled binary — DIST4's
// forced-off special-case existed only because the SDK worker spawn genuinely could not run under
// `--compile` (a script-path spawn against the running executable's own path). Now that the worker
// self-invokes (sdk-transport.ts's `workerSpawnArgv`), that spawn works identically compiled or
// source, so this function reports exactly what the credential/native-binary precondition says,
// with no run-mode branch left to test.
describe("resolveOrchestratorStatus — reflects the local precondition only, no compiled/source branch (NOTES DIST5)", () => {
  test("no ANTHROPIC_API_KEY → unavailable, with the missing-key reason", () => {
    const status = resolveOrchestratorStatus({});
    expect(status.available).toBe(false);
    expect(status.reason).not.toContain("compiled binary");
    expect(status.envVar).toBe(ORCHESTRATOR_ENV_VAR);
  });

  test("empty-string ANTHROPIC_API_KEY is treated as absent, same as missing", () => {
    const status = resolveOrchestratorStatus({ ANTHROPIC_API_KEY: "" });
    expect(status.available).toBe(false);
  });

  // Drives the SAME local check `selectOrchestratorBoundary` uses — a genuinely unresolvable native
  // binary (simulated via `requireFrom` pointed at an empty scratch dir, never touching the real
  // installed packages) reports unavailable with that specific reason, regardless of the credential.
  test("a present key but an unresolvable native binary → unavailable, with the binary reason", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "levare-status-nobinary-"));
    try {
      const status = resolveOrchestratorStatus({ ANTHROPIC_API_KEY: "sk-ant-test-not-real" }, { requireFrom: join(dir, "scratch.ts") });
      expect(status.available).toBe(false);
      expect(status.reason).toContain("native CLI binary");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

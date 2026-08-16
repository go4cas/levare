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
  // NOTES DOCS-WALKTHROUGH-2: `resolveOrchestratorStatus` proves presence + binary resolvability, never
  // validity — a live cold-start walkthrough hit exactly this gap (doctor reported "on", the first real
  // dispatch then failed with a 401 for an expired key). The reason text must say only what's actually
  // known (presence) and must not claim the credential works.
  test("a present key with a resolvable native binary → available, reason names presence, never claims validity", () => {
    const status = resolveOrchestratorStatus({ ANTHROPIC_API_KEY: "sk-ant-test" });
    expect(status.available).toBe(true);
    expect(status.reason).toContain(`${ORCHESTRATOR_ENV_VAR} is present`);
    expect(status.reason.toLowerCase()).not.toContain("live");
  });

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

// DOCS-WALKTHROUGH-3 item 4: every OTHER credential `levare doctor` reports on already names its source
// (dotenv.ts#applyStudioEnv's provenance, threaded through diagnose()'s own `env` lines) — the
// Orchestrator's own ANTHROPIC_API_KEY was the one exception, a gap real enough to cost a debugging
// session ("a shell export silently outranking the .env a user just edited looks identical to a correct
// load"). `envSource` closes it: optional, so every board render call site (none of which pass it) keeps
// the exact reason text it always had.
describe("resolveOrchestratorStatus — envSource names where ANTHROPIC_API_KEY came from (DOCS-WALKTHROUGH-3 item 4)", () => {
  test("envSource 'dotenv' is folded into the reason", () => {
    const status = resolveOrchestratorStatus({ ANTHROPIC_API_KEY: "sk-ant-test" }, {}, "dotenv");
    expect(status.reason).toBe(`${ORCHESTRATOR_ENV_VAR} is present (dotenv) — its validity isn't checked until the Orchestrator makes a real request.`);
  });

  test("envSource 'shell' is folded into the reason", () => {
    const status = resolveOrchestratorStatus({ ANTHROPIC_API_KEY: "sk-ant-test" }, {}, "shell");
    expect(status.reason).toBe(`${ORCHESTRATOR_ENV_VAR} is present (shell) — its validity isn't checked until the Orchestrator makes a real request.`);
  });

  test("no envSource given (every board render call site) — reason is exactly as before, no empty parens", () => {
    const status = resolveOrchestratorStatus({ ANTHROPIC_API_KEY: "sk-ant-test" });
    expect(status.reason).toBe(`${ORCHESTRATOR_ENV_VAR} is present — its validity isn't checked until the Orchestrator makes a real request.`);
    expect(status.reason).not.toContain("()");
  });

  test("envSource is ignored when the key is absent — never claims a source for a credential that isn't there", () => {
    const status = resolveOrchestratorStatus({}, {}, "dotenv");
    expect(status.available).toBe(false);
    expect(status.reason).not.toContain("dotenv");
  });
});

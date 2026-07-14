import { test, expect, describe, beforeEach } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as orchestratorModule from "../src/orchestrator.ts";
import { selectOrchestratorBoundary } from "../src/orchestrator-boundary.ts";
import { resetSdkPreconditionCache } from "../src/sdk-transport.ts";

// NOTES C11 part 1: the deterministic regex boundary that used to stand in for the Orchestrator
// whenever no ANTHROPIC_API_KEY was present has been DELETED, not demoted or renamed. It answered in
// levare's own voice ("Noted: <text>. Nothing changes state until you act on a gate.") without being
// the Orchestrator, and it fooled the Conductor twice in one live session while documenting it. There
// is no "offline mode" for a chat agent — there is the Orchestrator, present or absent.

// Ambient-environment pattern (NOTES.md "assert about the code, not the shell"): `checkSdkPrecondition
// sCached` (sdk-transport.ts) memoizes its result in a MODULE-LEVEL cache for a 30s TTL, keyed by
// nothing but time — not by the `env` argument. Any earlier test in this same process that resolved
// the boundary against the real `process.env` (which, on any machine with ANTHROPIC_API_KEY exported,
// reports viable) leaves that verdict cached; `selectOrchestratorBoundary({})` below would silently
// read that STALE, wrong-env result instead of re-evaluating the empty env this test actually passes.
// The assertion becomes true or false depending on which developer's shell happened to run it in,
// never on the code under test. `resetSdkPreconditionCache()` (also test-only, already the established
// fix for this exact leak — see tests/orchestrator-sdk.test.ts's own `beforeEach`) forces every call
// below to evaluate the env this file actually injects.
beforeEach(() => {
  resetSdkPreconditionCache();
});

function walkSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkSourceFiles(full));
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("NOTES C11: no deterministic Orchestrator boundary exists in the codebase", () => {
  test("no source file under src/ mentions a deterministic/offline stand-in boundary", () => {
    for (const file of walkSourceFiles("src")) {
      const src = readFileSync(file, "utf8");
      expect(src).not.toContain("deterministicBoundary");
    }
  });

  test("orchestrator.ts exports no deterministic boundary value", () => {
    expect((orchestratorModule as Record<string, unknown>).deterministicBoundary).toBeUndefined();
  });

  test("selectOrchestratorBoundary returns null — never a stand-in object — when the Orchestrator is unavailable", () => {
    expect(selectOrchestratorBoundary({})).toBeNull();
    expect(selectOrchestratorBoundary({ ANTHROPIC_API_KEY: "" })).toBeNull();
  });
});

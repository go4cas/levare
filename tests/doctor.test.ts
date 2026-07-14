import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { loadRepo } from "../src/repo.ts";
import { runDoctor, formatDoctor, diagnose, type CliProbe, type EnvProbe } from "../src/doctor.ts";
import type { OrchestratorStatus } from "../src/orchestrator-status.ts";

// `levare doctor` walks connectors and reports env presence + CLI/MCP reachability (§6). The fixture
// has two connectors — github (cli, needs GITHUB_TOKEN) and linear (mcp, needs LINEAR_API_KEY). With
// GITHUB_TOKEN present and LINEAR_API_KEY absent, doctor reports exactly one ok and one missing-env,
// matching the frozen fixtures/doctor/expected.txt.

const connectors = [...loadRepo("fixtures/golden").connectors.values()];

// Deterministic probes: GITHUB_TOKEN present, LINEAR_API_KEY absent; gh not on PATH (advisory only).
const env: EnvProbe = { has: (name) => name === "GITHUB_TOKEN" };
const noGh: CliProbe = () => "not-found";

describe("doctor", () => {
  test("output matches the frozen expected fixture byte-for-byte", () => {
    const out = runDoctor(connectors, env, noGh);
    expect(out).toBe(readFileSync("fixtures/doctor/expected.txt", "utf8"));
  });

  test("reports exactly one ok and one missing-env", () => {
    const health = diagnose(connectors, env, noGh);
    const byStatus = health.map((h) => `${h.name}:${h.status}`).sort();
    expect(byStatus).toEqual(["github:ok", "linear:missing-env"]);
  });

  test("env presence drives status; a missing CLI binary is advisory, not a failure", () => {
    const health = diagnose(connectors, env, noGh);
    const github = health.find((h) => h.name === "github")!;
    expect(github.status).toBe("ok"); // env present → ok, even though gh is not on PATH
    expect(github.cli).toEqual({ command: "gh", probe: "not-found" });
  });

  test("a connector whose env var is absent reports missing-env", () => {
    const health = diagnose(connectors, env, noGh);
    const linear = health.find((h) => h.name === "linear")!;
    expect(linear.status).toBe("missing-env");
    expect(linear.env).toEqual([{ name: "LINEAR_API_KEY", present: false }]);
    expect(linear.mcp).toEqual({ server: "linear-mcp" });
  });

  test("when both env vars are present, both are ok", () => {
    const allPresent: EnvProbe = { has: () => true };
    const health = diagnose(connectors, allPresent, noGh);
    expect(health.every((h) => h.status === "ok")).toBe(true);
  });

  test("connectors are reported in a stable (name-sorted) order", () => {
    expect(diagnose(connectors, env, noGh).map((h) => h.name)).toEqual(["github", "linear"]);
  });
});

// NOTES C11 part 4: doctor reports the PROVENANCE of each present variable — '.env' or shell — so "why
// does this work on my machine and not in CI" has a visible answer.
describe("doctor: env provenance (NOTES C11)", () => {
  test("a variable loaded from .env is reported as such", () => {
    const provenance = new Map([["GITHUB_TOKEN", "dotenv" as const]]);
    const health = diagnose(connectors, env, noGh, provenance);
    const github = health.find((h) => h.name === "github")!;
    expect(github.env).toEqual([{ name: "GITHUB_TOKEN", present: true, provenance: "dotenv" }]);
  });

  test("a present variable with no entry in the provenance map defaults to shell", () => {
    const health = diagnose(connectors, env, noGh); // no provenance map at all
    const github = health.find((h) => h.name === "github")!;
    expect(github.env[0].provenance).toBe("shell");
  });

  test("an absent variable carries no provenance", () => {
    const health = diagnose(connectors, env, noGh);
    const linear = health.find((h) => h.name === "linear")!;
    expect(linear.env[0].provenance).toBeUndefined();
  });

  test("formatDoctor prints the provenance inline", () => {
    const provenance = new Map([["GITHUB_TOKEN", "dotenv" as const]]);
    const out = formatDoctor(diagnose(connectors, env, noGh, provenance));
    expect(out).toContain("env GITHUB_TOKEN present (dotenv)");
    expect(out).toContain("env LINEAR_API_KEY missing");
  });
});

// NOTES C11 part 3: `levare doctor` reports the Orchestrator's own boundary state — the same status
// the board's header indicator shows (orchestrator-status.ts), so the two can never disagree.
describe("doctor: reports the Orchestrator boundary (NOTES C11)", () => {
  test("formatDoctor prints an 'on' line ahead of the connector report when given an available status", () => {
    const status: OrchestratorStatus = { available: true, reason: "The Orchestrator is live.", envVar: "ANTHROPIC_API_KEY" };
    const out = formatDoctor(diagnose(connectors, env, noGh), status);
    expect(out.split("\n")[0]).toBe("orchestrator: on · The Orchestrator is live.");
  });

  test("formatDoctor prints an 'off' line naming the missing env var", () => {
    const status: OrchestratorStatus = { available: false, reason: "ANTHROPIC_API_KEY is not set", envVar: "ANTHROPIC_API_KEY" };
    const out = formatDoctor(diagnose(connectors, env, noGh), status);
    expect(out.split("\n")[0]).toBe("orchestrator: off · ANTHROPIC_API_KEY is not set");
  });

  test("with no orchestrator status given, the report is unchanged (pre-C11 callers keep working)", () => {
    const out = formatDoctor(diagnose(connectors, env, noGh));
    expect(out.startsWith("orchestrator:")).toBe(false);
    expect(out.startsWith("levare doctor")).toBe(true);
  });

  test("`levare doctor` prints the Orchestrator's boundary state on the real CLI", () => {
    const p = Bun.spawnSync(["./levare", "doctor", "fixtures/golden"], { env: { ...process.env, ANTHROPIC_API_KEY: "" } });
    expect(p.exitCode).toBe(0);
    const out = p.stdout.toString();
    expect(out).toContain("orchestrator: off");
    expect(out).toContain("ANTHROPIC_API_KEY");
  });
});

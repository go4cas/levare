import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { loadRepo } from "../src/repo.ts";
import { runDoctor, diagnose, type CliProbe, type EnvProbe } from "../src/doctor.ts";

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

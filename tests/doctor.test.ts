import { test, expect, describe } from "bun:test";
import { readFileSync, mkdtempSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRepo } from "../src/repo.ts";
import { runDoctor, formatDoctor, diagnose, type CliProbe, type EnvProbe, type PromptCheck } from "../src/doctor.ts";
import type { OrchestratorStatus } from "../src/orchestrator-status.ts";
import type { Connector } from "../src/types.ts";
import type { VersionInfo } from "../src/version.ts";

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

// NOTES DIST1: a compiled binary and the source tree it was built from can drift, so `levare
// doctor` states its own run mode up front — compiled (with the build commit) or source/dev — so
// "is this the code I think it is?" has a visible answer. A full staleness check (comparing the
// build commit against the studio/source HEAD) is deferred, per NOTES.
describe("doctor: reports its own run mode — compiled vs source (NOTES DIST1)", () => {
  const compiled: VersionInfo = { version: "1.2.3", build: { commit: "2b0610f" } };
  const source: VersionInfo = { version: "1.2.3", build: null };

  test("formatDoctor prints the run mode first, ahead of the orchestrator line, when given a compiled VersionInfo", () => {
    const out = formatDoctor(diagnose(connectors, env, noGh), undefined, compiled);
    expect(out.split("\n")[0]).toBe("run mode: compiled (build 2b0610f)");
  });

  test("formatDoctor reports source/dev for an unstamped VersionInfo", () => {
    const out = formatDoctor(diagnose(connectors, env, noGh), undefined, source);
    expect(out.split("\n")[0]).toBe("run mode: source/dev");
  });

  test("with no VersionInfo given, the report is unchanged (pre-DIST1 callers keep working)", () => {
    const out = formatDoctor(diagnose(connectors, env, noGh));
    expect(out.startsWith("run mode:")).toBe(false);
    expect(out.startsWith("levare doctor")).toBe(true);
  });

  test("`levare doctor` reports source/dev on the real (unbuilt) CLI", () => {
    const p = Bun.spawnSync(["./levare", "doctor", "fixtures/golden"]);
    expect(p.exitCode).toBe(0);
    expect(p.stdout.toString()).toContain("run mode: source/dev");
  });
});

// NOTES DIST4: `docs/orchestrator-prompt.md` used to break under `bun build --compile` (it resolved
// via `import.meta.url`, which points into Bun's virtual `$bunfs` tree once compiled — the same class
// of bug DIST1 fixed for the version chip and the board's assets). This line is independent of the
// `orchestrator: on/off` line above — it proves the PROMPT READ itself, regardless of whether the
// Orchestrator's SDK worker can otherwise run (which, under a compiled binary, it currently can't —
// also NOTES DIST4).
describe("doctor: reports whether the orchestrator prompt actually loaded (NOTES DIST4)", () => {
  test("formatDoctor prints a 'readable' line with the byte count, ahead of the connector report", () => {
    const check: PromptCheck = { path: "/some/path/orchestrator-prompt.md", ok: true, bytes: 4251 };
    const out = formatDoctor(diagnose(connectors, env, noGh), undefined, undefined, check);
    expect(out.split("\n")[0]).toBe("orchestrator prompt: readable (4251 bytes) at /some/path/orchestrator-prompt.md");
  });

  test("formatDoctor prints an ERROR line naming the failure when the read failed", () => {
    const check: PromptCheck = { path: "/$bunfs/docs/orchestrator-prompt.md", ok: false, error: "ENOENT: no such file or directory" };
    const out = formatDoctor(diagnose(connectors, env, noGh), undefined, undefined, check);
    expect(out.split("\n")[0]).toBe("orchestrator prompt: ERROR — ENOENT: no such file or directory (/$bunfs/docs/orchestrator-prompt.md)");
  });

  test("with no PromptCheck given, the report is unchanged (pre-DIST4 callers keep working)", () => {
    const out = formatDoctor(diagnose(connectors, env, noGh));
    expect(out.startsWith("orchestrator prompt:")).toBe(false);
    expect(out.startsWith("levare doctor")).toBe(true);
  });

  test("`levare doctor` reports the real prompt file as readable, matching its actual on-disk size", () => {
    const onDisk = readFileSync("docs/orchestrator-prompt.md", "utf8");
    const bytes = Buffer.byteLength(onDisk, "utf8");
    const p = Bun.spawnSync(["./levare", "doctor", "fixtures/golden"]);
    expect(p.exitCode).toBe(0);
    expect(p.stdout.toString()).toContain(`orchestrator prompt: readable (${bytes} bytes)`);
  });
});

// NOTES C13: connectors declare how they authenticate. `auth: env` connectors are unchanged; an
// `auth: subscription` connector's credential is NOT scoped by levare — doctor must say so plainly,
// every time, so the board never implies an enforcement guarantee it isn't providing.
describe("doctor: reports auth mode, and warns plainly for auth: subscription (NOTES C13)", () => {
  const withSubscription: Connector[] = [
    ...connectors,
    { name: "codex", kind: "cli", command: "codex", env: [], auth: "subscription", plan: "ChatGPT Plus — flat monthly rate" },
  ];
  const allPresent: EnvProbe = { has: () => true };
  const foundGh: CliProbe = () => "found";

  test("every connector's health record carries its auth mode", () => {
    const health = diagnose(withSubscription, allPresent, foundGh);
    const byAuth = Object.fromEntries(health.map((h) => [h.name, h.auth]));
    expect(byAuth).toEqual({ github: "env", linear: "env", codex: "subscription" });
  });

  test("an auth: subscription connector carries a warning naming its command; auth: env connectors carry none", () => {
    const health = diagnose(withSubscription, allPresent, foundGh);
    const codex = health.find((h) => h.name === "codex")!;
    expect(codex.warning).toBe(
      "levare cannot scope this credential — any member that can spawn `codex` can use this login. The grant is documentation, not enforcement.",
    );
    expect(health.find((h) => h.name === "github")!.warning).toBeUndefined();
    expect(health.find((h) => h.name === "linear")!.warning).toBeUndefined();
  });

  test("a subscription connector with no env vars to check is trivially 'ok' — env presence was never the thing being enforced", () => {
    const health = diagnose(withSubscription, allPresent, foundGh);
    const codex = health.find((h) => h.name === "codex")!;
    expect(codex.status).toBe("ok");
    expect(codex.env).toEqual([]);
  });

  test("formatDoctor prints the auth line and the warning for a subscription connector", () => {
    const out = formatDoctor(diagnose(withSubscription, allPresent, foundGh));
    expect(out).toContain("codex · cli");
    expect(out).toContain("auth: subscription · ChatGPT Plus — flat monthly rate");
    expect(out).toContain("⚠ levare cannot scope this credential");
    expect(out).toContain("any member that can spawn `codex` can use this login");
    expect(out).toContain("The grant is documentation, not enforcement.");
  });

  test("formatDoctor prints a plain 'auth: env' line, with no warning, for the unchanged connectors", () => {
    const out = formatDoctor(diagnose(withSubscription, allPresent, foundGh));
    const githubBlock = out.split("\n\n").find((b) => b.startsWith("github"))!;
    expect(githubBlock).toContain("auth: env");
    expect(githubBlock).not.toContain("⚠");
  });
});

// NOTES REV1 finding 2: `checkGuardrails` (guardrails.ts) has zero production call sites — the merge
// phase that would enforce a team's declared guardrails is deferred to v1.1 (docs/prd-amendment-1.md
// §2, invariant 6). Doctor must state the gap plainly for any studio that declares guardrails, never
// let a Conductor believe levare already enforces `protected_branches`/`protected_paths`/`never`.
describe("doctor: guardrails-declared-but-not-yet-enforced telling (NOTES REV1 finding 2)", () => {
  test("formatDoctor prints the not-yet-enforced warning, naming every team, when guardrailsTeams is non-empty", () => {
    const out = formatDoctor(diagnose(connectors, env, noGh), undefined, undefined, undefined, ["kestrel", "atelier"]);
    expect(out).toContain("⚠ guardrails are declared but not yet enforced — enforcement lands with the merge phase (v1.1): kestrel, atelier");
  });

  test("with no team declaring guardrails, no such line appears", () => {
    const out = formatDoctor(diagnose(connectors, env, noGh), undefined, undefined, undefined, []);
    expect(out).not.toContain("not yet enforced");
  });

  test("omitting guardrailsTeams entirely leaves the report unchanged (pre-REV1 callers keep working)", () => {
    const out = formatDoctor(diagnose(connectors, env, noGh));
    expect(out).not.toContain("not yet enforced");
  });

  test("`levare doctor fixtures/golden` names kestrel on the real CLI — the fixture team declares guardrails", () => {
    const p = Bun.spawnSync(["./levare", "doctor", "fixtures/golden"], { env: { ...process.env, ANTHROPIC_API_KEY: "" } });
    expect(p.exitCode).toBe(0);
    const out = p.stdout.toString();
    expect(out).toContain("guardrails are declared but not yet enforced");
    expect(out).toContain("merge phase (v1.1)");
    expect(out).toContain("kestrel");
  });
});

// NOTES REV1 finding 3: `kind: remote` validates cleanly but adapters.ts's `RemoteBoundary` is a
// documented mock in every path today. Doctor repeats the same telling `levare validate` already
// gives, naming every agent in the studio that declares it.
describe("doctor: remote-member-not-implemented telling (NOTES REV1 finding 3)", () => {
  test("formatDoctor prints the not-implemented warning, naming every remote agent, when remoteAgents is non-empty", () => {
    const out = formatDoctor(diagnose(connectors, env, noGh), undefined, undefined, undefined, undefined, ["echo", "relay"]);
    expect(out).toContain("⚠ remote members are not yet implemented — these will not produce real work: echo, relay");
  });

  test("with no remote agent declared, no such line appears", () => {
    const out = formatDoctor(diagnose(connectors, env, noGh), undefined, undefined, undefined, undefined, []);
    expect(out).not.toContain("not yet implemented");
  });

  test("omitting remoteAgents entirely leaves the report unchanged (pre-REV1 callers keep working)", () => {
    const out = formatDoctor(diagnose(connectors, env, noGh));
    expect(out).not.toContain("not yet implemented");
  });

  test("`levare doctor` on a studio with a remote agent names it on the real CLI", () => {
    const dir = mkdtempSync(join(tmpdir(), "levare-doctor-remote-"));
    try {
      cpSync("fixtures/golden", dir, { recursive: true });
      writeFileSync(
        join(dir, "agents", "echo.md"),
        ["---", "name: echo", "kind: remote", "produces: [report]", "server: echo-mcp", "style:", "  avatar: Ec", "---", "", "A remote member.", ""].join("\n"),
      );
      const p = Bun.spawnSync(["./levare", "doctor", dir], { env: { ...process.env, ANTHROPIC_API_KEY: "" } });
      expect(p.exitCode).toBe(0);
      const out = p.stdout.toString();
      expect(out).toContain("remote members are not yet implemented");
      expect(out).toContain("echo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

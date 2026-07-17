import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRepo } from "../src/repo.ts";
import { buildMemberEnv, buildConnectorEnv, ENV_BASELINE } from "../src/env.ts";
import { validatePath, validateArtifactSource } from "../src/validate.ts";
import { assembleContext } from "../src/context.ts";
import { executeProposal, substituteTemplate, REMOTE_NOT_IMPLEMENTED_EXEC_WARNING, type ConnectorSpawn } from "../src/execution.ts";
import { resolveGate } from "../src/board/gateops.ts";
import type { AsyncMemberRunner } from "../src/dagwalk.ts";
import type { Connector } from "../src/types.ts";

// NOTES CAP-A (v1.1 capability layer, part A): side-effecting connectors are gated as proposals — the
// member drafts, the Conductor approves, levare acts. These tests exercise every acceptance item named
// in the goal: env withholding both ways, the proposal artifact's structural + cross-entity validation,
// execution.ts's substitution/env-scoping/mcp-honesty, and a full round-trip through board/gateops.ts
// that executes a real stub cli binary and commits the resolution + execution record together.

const ROOT = "fixtures/golden";

// ---------------------------------------------------------------------------
// item 2 — env withholding: buildMemberEnv (a member's own process) vs buildConnectorEnv (levare's own
// execution step, execution.ts's only caller).
// ---------------------------------------------------------------------------
describe("item 2 — env withholding (write+proposal withheld, trusted injected)", () => {
  const HOSTILE = { PATH: "/usr/bin:/bin", HOME: "/home/member", GITHUB_TOKEN: "ghp_secret", LINEAR_API_KEY: "lin_secret" };

  test("a member granted an effects: write, gate: proposal (default) connector sees NONE of its env", () => {
    const repo = loadRepo(ROOT);
    repo.connectors.set("github", { ...repo.connectors.get("github")!, effects: "write", gate: "proposal" });
    repo.agents.get("finch")!.connectors = ["github"];
    const env = buildMemberEnv(repo, "finch", HOSTILE);
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(Object.keys(env).sort()).toEqual([...ENV_BASELINE].sort());
  });

  test("a member granted an effects: write, gate: trusted connector is injected exactly as a read connector would be", () => {
    const repo = loadRepo(ROOT);
    repo.connectors.set("github", { ...repo.connectors.get("github")!, effects: "write", gate: "trusted" });
    repo.agents.get("finch")!.connectors = ["github"];
    const env = buildMemberEnv(repo, "finch", HOSTILE);
    expect(env.GITHUB_TOKEN).toBe("ghp_secret");
  });

  test("effects: read is unchanged regardless of any gate value (gate is meaningless there)", () => {
    const repo = loadRepo(ROOT);
    repo.connectors.set("github", { ...repo.connectors.get("github")!, effects: "read" });
    repo.agents.get("finch")!.connectors = ["github"];
    const env = buildMemberEnv(repo, "finch", HOSTILE);
    expect(env.GITHUB_TOKEN).toBe("ghp_secret");
  });

  test("buildConnectorEnv (levare's own execution step) sees the withheld connector's own vars, and ONLY that connector's — no member grant involved at all", () => {
    const repo = loadRepo(ROOT);
    const github = { ...repo.connectors.get("github")!, effects: "write" as const, gate: "proposal" as const };
    const env = buildConnectorEnv(github, HOSTILE);
    expect(env.GITHUB_TOKEN).toBe("ghp_secret");
    expect(env.LINEAR_API_KEY).toBeUndefined();
    expect(Object.keys(env).sort()).toEqual(["GITHUB_TOKEN", ...ENV_BASELINE].sort());
  });
});

// ---------------------------------------------------------------------------
// item 1 — schema: effects/gate/actions validation
// ---------------------------------------------------------------------------
function scratchStudio(): string {
  const root = mkdtempSync(join(tmpdir(), "levare-cap-a-"));
  for (const d of ["connectors", "agents", "teams", "types", "projects"]) mkdirSync(join(root, d), { recursive: true });
  return root;
}

function writeConnector(root: string, name: string, extra: string): void {
  writeFileSync(join(root, "connectors", `${name}.md`), `---\nname: ${name}\nkind: cli\ncommand: ${name}\nenv: [TOKEN]\n${extra}---\n\n# ${name}\n`);
}

describe("item 1 — connector schema: effects, gate, actions", () => {
  test("gate: on an effects: read (default) connector is a definition error", () => {
    const root = scratchStudio();
    writeConnector(root, "x", "gate: trusted\n");
    const result = validatePath(root);
    expect(result.errors.map((e) => e.code)).toContain("GATE_ON_READ_CONNECTOR");
  });

  test("effects: write with no actions is a definition error", () => {
    const root = scratchStudio();
    writeConnector(root, "x", "effects: write\n");
    const result = validatePath(root);
    expect(result.errors.map((e) => e.code)).toContain("MISSING_ACTIONS");
  });

  test("actions: on an effects: read connector is a definition error", () => {
    const root = scratchStudio();
    writeConnector(root, "x", 'actions:\n  do-thing: ["x", "--flag"]\n');
    const result = validatePath(root);
    expect(result.errors.map((e) => e.code)).toContain("ACTIONS_ON_READ_CONNECTOR");
  });

  test("effects: write with a declared, well-shaped actions map validates clean", () => {
    const root = scratchStudio();
    writeConnector(root, "x", 'effects: write\ngate: proposal\nactions:\n  create-issue: ["gh", "issue", "create", "--title", "{title}"]\n');
    const result = validatePath(root);
    expect(result.ok).toBe(true);
  });

  test("an action's argv template must be a non-empty array of non-empty strings", () => {
    const root = scratchStudio();
    writeConnector(root, "x", "effects: write\nactions:\n  create-issue: []\n");
    const result = validatePath(root);
    expect(result.errors.some((e) => e.code === "BAD_TYPE" && e.message.includes("actions.create-issue"))).toBe(true);
  });

  test("gate: trusted on an effects: write connector (the declared, visible opt-out) validates clean", () => {
    const root = scratchStudio();
    writeConnector(root, "x", 'effects: write\ngate: trusted\nactions:\n  do-thing: ["x"]\n');
    const result = validatePath(root);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// item 3 — the proposal artifact: structural + cross-entity validation
// ---------------------------------------------------------------------------

// NOTES: WorkUnit.type is a fixed enum (inception|feature|fix|spike|research, validate.ts's
// WORK_UNIT_SCHEMA) — independent of the types/ registry's own free-form `name:`. "feature" satisfies
// both.
const TYPE_TASK = `---
name: feature
glyph: "▸"
expects: [proposal]
gates: [proposal]
---

# Feature
`;

const PROJECT_ACME = `---
name: acme
repo: .
remote: null
default_branch: main
deploy: null
pace: auto
---

# Acme
`;

const TEAM_OPS = `---
name: ops
consumes: []
produces: [proposal]
members: [scout]
flow:
  - step: proposal
  - gate: human
style:
  color: "#000000"
---

# Ops
`;

function agentScout(connectors: string[]): string {
  return `---
name: scout
kind: native
produces: [proposal]
model: claude-sonnet-5
connectors: [${connectors.join(", ")}]
style:
  avatar: Sc
---

# Scout
`;
}

function proposalArtifact(opts: { connector?: string; action?: string; params?: string; extraKeys?: string }): string {
  const connectorLine = opts.connector !== undefined ? `connector: ${opts.connector}\n` : "";
  const actionLine = opts.action !== undefined ? `action: ${opts.action}\n` : "";
  const paramsBlock = opts.params !== undefined ? `params:\n${opts.params}\n` : "";
  return `---
kind: proposal
id: proposal-work-v1
unit: work
project: acme
status: in-review
produced_by: ops/scout
consumes: []
supersedes: null
approved_by: null
created: 2026-07-17
files: []
${connectorLine}${actionLine}${paramsBlock}${opts.extraKeys ?? ""}---

# Proposal
`;
}

function seedProposalStudio(connectorFile: string, connectors: string[]): string {
  const root = scratchStudio();
  mkdirSync(join(root, "work/acme/work"), { recursive: true });
  writeFileSync(join(root, "types/feature.md"), TYPE_TASK);
  writeFileSync(join(root, "projects/acme.md"), PROJECT_ACME);
  writeFileSync(join(root, "teams/ops.md"), TEAM_OPS);
  writeFileSync(join(root, "agents/scout.md"), agentScout(connectors));
  writeFileSync(join(root, "connectors/writer.md"), connectorFile);
  writeFileSync(
    join(root, "work/acme/work/unit.md"),
    `---\ntype: feature\nstatus: active\nproject: acme\nunit: work\n---\n\n# Work\n`,
  );
  return root;
}

const WRITE_CONNECTOR = `---
name: writer
kind: cli
command: writer
env: [WRITER_TOKEN]
effects: write
gate: proposal
actions:
  create-issue: ["writer", "--title", "{title}", "--body", "{body}"]
---

# Writer
`;

const READ_CONNECTOR = `---
name: writer
kind: cli
command: writer
env: [WRITER_TOKEN]
---

# Writer
`;

describe("item 3 — proposal artifact validation", () => {
  test("connector/action/params are all required for kind: proposal", () => {
    const root = seedProposalStudio(WRITE_CONNECTOR, ["writer"]);
    writeFileSync(join(root, "work/acme/work/proposal-work-v1.md"), proposalArtifact({}));
    const result = validatePath(root);
    const codes = result.errors.map((e) => e.code);
    expect(codes.filter((c) => c === "MISSING_FIELD").length).toBeGreaterThanOrEqual(3);
  });

  test("connector/action/params on a NON-proposal kind is a definition error", () => {
    const root = seedProposalStudio(WRITE_CONNECTOR, ["writer"]);
    const doc = proposalArtifact({ connector: "writer", action: "create-issue", params: "  title: Ship it\n  body: text" }).replace("kind: proposal", "kind: spec");
    writeFileSync(join(root, "work/acme/work/proposal-work-v1.md"), doc);
    const result = validatePath(root);
    expect(result.errors.map((e) => e.code)).toContain("PROPOSAL_FIELDS_ON_NON_PROPOSAL");
  });

  test("an unknown connector is a definition error", () => {
    const root = seedProposalStudio(WRITE_CONNECTOR, ["writer"]);
    writeFileSync(join(root, "work/acme/work/proposal-work-v1.md"), proposalArtifact({ connector: "nope", action: "create-issue", params: "  title: x\n  body: y" }));
    const result = validatePath(root);
    expect(result.errors.map((e) => e.code)).toContain("UNKNOWN_CONNECTOR");
  });

  test("a proposal against an effects: read connector is a definition error", () => {
    const root = seedProposalStudio(READ_CONNECTOR, ["writer"]);
    writeFileSync(join(root, "work/acme/work/proposal-work-v1.md"), proposalArtifact({ connector: "writer", action: "create-issue", params: "  title: x" }));
    const result = validatePath(root);
    expect(result.errors.map((e) => e.code)).toContain("PROPOSAL_AGAINST_READ_CONNECTOR");
  });

  test("an undeclared action is a definition error", () => {
    const root = seedProposalStudio(WRITE_CONNECTOR, ["writer"]);
    writeFileSync(join(root, "work/acme/work/proposal-work-v1.md"), proposalArtifact({ connector: "writer", action: "close-issue", params: "  title: x" }));
    const result = validatePath(root);
    expect(result.errors.map((e) => e.code)).toContain("UNDECLARED_ACTION");
  });

  test("a missing param for a declared placeholder is a definition error", () => {
    const root = seedProposalStudio(WRITE_CONNECTOR, ["writer"]);
    writeFileSync(join(root, "work/acme/work/proposal-work-v1.md"), proposalArtifact({ connector: "writer", action: "create-issue", params: "  title: x" }));
    const result = validatePath(root);
    expect(result.errors.map((e) => e.code)).toContain("MISSING_PARAM");
  });

  test("an unused param not in the template is a definition error", () => {
    const root = seedProposalStudio(WRITE_CONNECTOR, ["writer"]);
    writeFileSync(
      join(root, "work/acme/work/proposal-work-v1.md"),
      proposalArtifact({ connector: "writer", action: "create-issue", params: "  title: x\n  body: y\n  extra: z" }),
    );
    const result = validatePath(root);
    expect(result.errors.map((e) => e.code)).toContain("UNKNOWN_PARAM");
  });

  test("a connector not granted to the producing member/team is a definition error", () => {
    const root = seedProposalStudio(WRITE_CONNECTOR, []); // scout granted nothing
    writeFileSync(
      join(root, "work/acme/work/proposal-work-v1.md"),
      proposalArtifact({ connector: "writer", action: "create-issue", params: "  title: x\n  body: y" }),
    );
    const result = validatePath(root);
    expect(result.errors.map((e) => e.code)).toContain("CONNECTOR_NOT_GRANTED");
  });

  test("a well-formed proposal, granted, with complete params, validates clean", () => {
    const root = seedProposalStudio(WRITE_CONNECTOR, ["writer"]);
    writeFileSync(
      join(root, "work/acme/work/proposal-work-v1.md"),
      proposalArtifact({ connector: "writer", action: "create-issue", params: "  title: x\n  body: y" }),
    );
    const result = validatePath(root);
    expect(result.ok).toBe(true);
  });

  test("fail-open: validateArtifactSource with no root given skips the cross-entity check (structural checks still run)", () => {
    const doc = proposalArtifact({ connector: "nope-does-not-exist", action: "whatever", params: "  x: y" });
    const errs = validateArtifactSource(doc); // no dir, no root — the plain member-output boundary shape.
    expect(errs.map((e) => e.code)).not.toContain("UNKNOWN_CONNECTOR");
    expect(errs).toEqual([]); // connector/action/params are all present — nothing structural to flag either.
  });
});

// ---------------------------------------------------------------------------
// item 4a — execution.ts: substitution, env scoping, mcp honesty
// ---------------------------------------------------------------------------

function stubScript(root: string, exitCode: number): { path: string; outFile: string } {
  const path = join(root, "stub.sh");
  const outFile = join(root, "captured.txt");
  writeFileSync(
    path,
    `#!/bin/sh\n{ echo "ARGV:$@"; env | sort; } > "${outFile}"\nexit ${exitCode}\n`,
  );
  chmodSync(path, 0o755);
  return { path, outFile };
}

function writeConnectorObj(overrides: Partial<Connector> = {}): Connector {
  return {
    name: "writer",
    kind: "cli",
    command: "writer",
    env: ["WRITER_TOKEN"],
    auth: "env",
    role: "tool",
    effects: "write",
    gate: "proposal",
    actions: { "create-issue": ["writer", "--title", "{title}"] },
    ...overrides,
  };
}

describe("item 4a — execution.ts", () => {
  test("substituteTemplate fills {placeholder} slots one-per-argv-element, never re-splitting a value", () => {
    const argv = substituteTemplate(["gh", "issue", "create", "--title", "{title}"], { title: "has spaces and \"quotes\"" });
    expect(argv).toEqual(["gh", "issue", "create", "--title", 'has spaces and "quotes"']);
    expect(argv.length).toBe(5);
  });

  test("a cli action spawns with ONLY the connector's own env (baseline + its named var), and the argv is substituted", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "levare-cap-a-exec-"));
    const { path, outFile } = stubScript(scratch, 0);
    const connector = writeConnectorObj({ actions: { "create-issue": [path, "--title", "{title}"] } });
    const baseEnv = { PATH: process.env.PATH, HOME: process.env.HOME, WRITER_TOKEN: "secret-token", UNRELATED_SECRET: "must-not-leak" };
    const record = await executeProposal(connector, "create-issue", { title: "Ship it" }, { baseEnv, now: () => "2026-07-17T00:00:00.000Z" });
    expect(record.status).toBe("ok");
    expect(record.exit).toBe(0);
    expect(record.output_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(record.warning).toBeNull();
    expect(record.executed_at).toBe("2026-07-17T00:00:00.000Z");

    const captured = readFileSync(outFile, "utf8");
    expect(captured).toContain("ARGV:--title Ship it");
    expect(captured).toContain("WRITER_TOKEN=secret-token");
    expect(captured).not.toContain("UNRELATED_SECRET");
  });

  test("a non-zero exit records status: failed with the exit code and a digest", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "levare-cap-a-exec-"));
    const { path } = stubScript(scratch, 3);
    const connector = writeConnectorObj({ actions: { "create-issue": [path, "--title", "{title}"] } });
    const record = await executeProposal(connector, "create-issue", { title: "x" }, { baseEnv: { PATH: process.env.PATH } });
    expect(record.status).toBe("failed");
    expect(record.exit).toBe(3);
    expect(record.output_digest).not.toBeNull();
  });

  test("an mcp connector never executes — records executed: skipped with the REMOTE_NOT_IMPLEMENTED warning, never pretends", async () => {
    const connector = writeConnectorObj({ kind: "mcp", command: undefined, server: "writer-mcp" });
    const record = await executeProposal(connector, "create-issue", { title: "x" });
    expect(record.status).toBe("skipped");
    expect(record.exit).toBeNull();
    expect(record.output_digest).toBeNull();
    expect(record.warning).toBe(REMOTE_NOT_IMPLEMENTED_EXEC_WARNING);
  });

  test("a timeout records status: failed, never hangs the caller", async () => {
    const hangingSpawn: ConnectorSpawn = {
      run: () => new Promise((resolve) => setTimeout(() => resolve({ stdout: "", stderr: "", exitCode: -1, timedOut: true }), 5)),
    };
    const connector = writeConnectorObj();
    const record = await executeProposal(connector, "create-issue", { title: "x" }, { spawn: hangingSpawn, timeoutMs: 10 });
    expect(record.status).toBe("failed");
    expect(record.exit).toBeNull();
    expect(record.warning).toContain("timed out");
  });
});

// ---------------------------------------------------------------------------
// item 4b — full round-trip through board/gateops.ts: a member-produced proposal validates at the
// boundary → gate approval spawns the REAL stub binary with substituted argv and only the connector's
// env → the execution record lands in the SAME commit as the resolution.
// ---------------------------------------------------------------------------

function git(root: string, args: string[]) {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
  const r = spawnSync("git", ["-C", root, "-c", "user.name=seed", "-c", "user.email=seed@levare.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "init.defaultBranch=main", ...args], { encoding: "utf8", env });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}${r.stdout}`);
  return r;
}

function seedGitProposalStudio(connectorFile: string, connectors: string[]): string {
  const root = seedProposalStudio(connectorFile, connectors);
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "seed proposal studio"]);
  return root;
}

function scoutRunner(doc: string): AsyncMemberRunner {
  return {
    capabilities: () => [{ member: "scout", kind: "proposal" }],
    produce: () => ({ doc }),
  };
}

describe("item 4b — proposal round-trip (member drafts → Conductor approves → levare acts)", () => {
  test("cli connector: approval executes the real stub binary, substituted argv, only the connector's env, and the execution record commits with the resolution", async () => {
    const root = seedGitProposalStudio(WRITE_CONNECTOR, ["writer"]);
    const { path, outFile } = stubScript(root, 0);
    const actionsWriter = WRITE_CONNECTOR.replace('actions:\n  create-issue: ["writer", "--title", "{title}", "--body", "{body}"]', `actions:\n  create-issue: ["${path}", "--title", "{title}", "--body", "{body}"]`);
    writeFileSync(join(root, "connectors/writer.md"), actionsWriter);

    const doc = proposalArtifact({ connector: "writer", action: "create-issue", params: "  title: Ship it\n  body: now" });
    const runner = scoutRunner(doc);

    const started = await resolveGate(root, "acme", "work", "start", { memberRunner: runner, today: "2026-07-17" });
    expect(started.ok).toBe(true);
    const artFile = join(root, "work/acme/work/proposal-work-v1.md");
    expect(existsSync(artFile)).toBe(true);
    expect(readFileSync(artFile, "utf8")).toContain("status: in-review");

    const before = git(root, ["rev-parse", "HEAD"]).stdout.trim();
    const approved = await resolveGate(root, "acme", "proposal-work-v1", "approve", {
      memberRunner: runner,
      today: "2026-07-17",
      now: () => "2026-07-17T12:00:00.000Z",
      connectorBaseEnv: { PATH: process.env.PATH, HOME: process.env.HOME, WRITER_TOKEN: "the-real-token", DECOY_SECRET: "must-not-leak" },
    });
    expect(approved.ok).toBe(true);
    if (!approved.ok) throw new Error("unreachable");
    expect(approved.changedFiles).toEqual([artFile]);

    // One commit for the resolution AND the execution record (REV2: same transaction).
    const after = git(root, ["rev-parse", "HEAD"]).stdout.trim();
    expect(after).not.toBe(before);
    expect(approved.commit).toBe(after);

    const finalSrc = readFileSync(artFile, "utf8");
    expect(finalSrc).toContain("status: approved");
    expect(finalSrc).toContain("execution:");
    expect(finalSrc).toContain("status: ok");
    expect(finalSrc).toContain("exit: 0");
    expect(finalSrc).toMatch(/output_digest: "?sha256:[0-9a-f]{64}"?/);

    const captured = readFileSync(outFile, "utf8");
    expect(captured).toContain("ARGV:--title Ship it --body now");
    expect(captured).toContain("WRITER_TOKEN=the-real-token");
    expect(captured).not.toContain("DECOY_SECRET");

    // Unit was never blocked — a successful execution leaves it exactly as it was.
    const unitSrc = readFileSync(join(root, "work/acme/work/unit.md"), "utf8");
    expect(unitSrc).toContain("status: active");
  });

  test("a failed execution never un-approves the proposal, but blocks the unit with a named reason", async () => {
    const root = seedGitProposalStudio(WRITE_CONNECTOR, ["writer"]);
    const { path } = stubScript(root, 1);
    const actionsWriter = WRITE_CONNECTOR.replace('actions:\n  create-issue: ["writer", "--title", "{title}", "--body", "{body}"]', `actions:\n  create-issue: ["${path}", "--title", "{title}", "--body", "{body}"]`);
    writeFileSync(join(root, "connectors/writer.md"), actionsWriter);

    const doc = proposalArtifact({ connector: "writer", action: "create-issue", params: "  title: Ship it\n  body: now" });
    const runner = scoutRunner(doc);
    await resolveGate(root, "acme", "work", "start", { memberRunner: runner, today: "2026-07-17" });

    const approved = await resolveGate(root, "acme", "proposal-work-v1", "approve", {
      memberRunner: runner,
      today: "2026-07-17",
      connectorBaseEnv: { PATH: process.env.PATH },
    });
    expect(approved.ok).toBe(true);
    if (!approved.ok) throw new Error("unreachable");
    expect(approved.changedFiles.sort()).toEqual([join(root, "work/acme/work/proposal-work-v1.md"), join(root, "work/acme/work/unit.md")].sort());

    const artSrc = readFileSync(join(root, "work/acme/work/proposal-work-v1.md"), "utf8");
    expect(artSrc).toContain("status: approved"); // never un-approved
    expect(artSrc).toContain("status: failed");
    expect(artSrc).toContain("exit: 1");

    const unitSrc = readFileSync(join(root, "work/acme/work/unit.md"), "utf8");
    expect(unitSrc).toContain("status: blocked");
    expect(unitSrc).toContain("blocked_reason:");
    expect(unitSrc).toContain("proposal-work-v1");
  });

  test("an mcp connector's proposal approval records executed: skipped with the REMOTE_NOT_IMPLEMENTED warning — never pretends, never blocks the unit", async () => {
    const MCP_CONNECTOR = `---
name: writer
kind: mcp
server: writer-mcp
env: [WRITER_TOKEN]
effects: write
gate: proposal
actions:
  create-issue: ["create-issue", "{title}"]
---

# Writer (mcp)
`;
    const root = seedGitProposalStudio(MCP_CONNECTOR, ["writer"]);
    const doc = proposalArtifact({ connector: "writer", action: "create-issue", params: "  title: Ship it" });
    const runner = scoutRunner(doc);
    await resolveGate(root, "acme", "work", "start", { memberRunner: runner, today: "2026-07-17" });

    const approved = await resolveGate(root, "acme", "proposal-work-v1", "approve", { memberRunner: runner, today: "2026-07-17" });
    expect(approved.ok).toBe(true);
    if (!approved.ok) throw new Error("unreachable");

    const artSrc = readFileSync(join(root, "work/acme/work/proposal-work-v1.md"), "utf8");
    expect(artSrc).toContain("status: approved");
    expect(artSrc).toContain("status: skipped");
    expect(artSrc).toContain(REMOTE_NOT_IMPLEMENTED_EXEC_WARNING);

    const unitSrc = readFileSync(join(root, "work/acme/work/unit.md"), "utf8");
    expect(unitSrc).toContain("status: active"); // skipped never blocks — only a genuine failure does.
  });
});

// ---------------------------------------------------------------------------
// item 5 — §6 context assembly tells a member granted a write+proposal connector how to act
// ---------------------------------------------------------------------------
describe("item 5 — context assembly names the proposal-gated connector's action vocabulary", () => {
  test("a member with no write+proposal grant gets no capability section — the frozen recipe is untouched", () => {
    const repo = loadRepo(ROOT);
    const out = assembleContext(repo, { root: ROOT, agent: "lyra", unit: "checkout-flow", capabilities: [{ member: "lyra", kind: "spec" }, { member: "lyra", kind: "design" }] });
    expect(out).not.toContain("── 8.");
  });

  test("a member granted an effects: write, gate: proposal connector is told direct calls are unavailable and shown its action vocabulary", () => {
    const repo = loadRepo(ROOT);
    repo.connectors.set("github", {
      ...repo.connectors.get("github")!,
      effects: "write",
      gate: "proposal",
      actions: { "create-issue": ["gh", "issue", "create", "--title", "{title}", "--body", "{body}"] },
    });
    repo.agents.get("finch")!.connectors = ["github"];
    const out = assembleContext(repo, { root: ROOT, agent: "finch", unit: "checkout-flow", capabilities: [{ member: "finch", kind: "review" }] });
    expect(out).toContain("── 8. capability: proposal-gated connectors ──");
    expect(out).toContain("direct calls are unavailable");
    expect(out).toContain("### github (cli)");
    expect(out).toContain("create-issue: params [title, body]");
  });

  test("a gate: trusted write connector grants no capability section — the member holds the credential directly, nothing to propose", () => {
    const repo = loadRepo(ROOT);
    repo.connectors.set("github", { ...repo.connectors.get("github")!, effects: "write", gate: "trusted" });
    repo.agents.get("finch")!.connectors = ["github"];
    const out = assembleContext(repo, { root: ROOT, agent: "finch", unit: "checkout-flow", capabilities: [{ member: "finch", kind: "review" }] });
    expect(out).not.toContain("── 8.");
  });
});

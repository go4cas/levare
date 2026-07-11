import { test, expect, describe } from "bun:test";
import { loadRepo } from "../src/repo.ts";
import { buildMemberEnv, grantedConnectors, ENV_BASELINE } from "../src/env.ts";

// Security posture (§6, invariant 11): a member's spawned environment is an ALLOWLIST — only the
// vars its granted connectors name, plus a minimal PATH/HOME baseline. Never a denylist over
// process.env. A secret for an ungranted connector can never leak.

const ROOT = "fixtures/golden";

// A hostile base environment: it carries the github secret plus an unrelated secret. Neither may
// reach a member that wasn't granted them.
const HOSTILE = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/member",
  GITHUB_TOKEN: "ghp_secret_value",
  LINEAR_API_KEY: "lin_secret_value",
  AWS_SECRET_ACCESS_KEY: "totally-unrelated-secret",
};

describe("env scoping — allowlist only", () => {
  test("a member WITHOUT the github grant has no GITHUB_* var in its spawned env", () => {
    const repo = loadRepo(ROOT);
    // lyra grants no connectors (nor does team kestrel in the fixture).
    const env = buildMemberEnv(repo, "lyra", HOSTILE);
    const githubVars = Object.keys(env).filter((k) => k.startsWith("GITHUB_"));
    expect(githubVars).toEqual([]);
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  test("only the baseline (PATH/HOME) is carried through when no connector is granted", () => {
    const repo = loadRepo(ROOT);
    const env = buildMemberEnv(repo, "lyra", HOSTILE);
    expect(Object.keys(env).sort()).toEqual([...ENV_BASELINE].sort());
    // The unrelated secret never leaks — this is an allowlist, not a denylist.
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.LINEAR_API_KEY).toBeUndefined();
  });

  test("an agent-level github grant admits exactly GITHUB_TOKEN, nothing more", () => {
    const repo = loadRepo(ROOT);
    repo.agents.get("finch")!.connectors = ["github"]; // grant in-memory
    const env = buildMemberEnv(repo, "finch", HOSTILE);
    expect(env.GITHUB_TOKEN).toBe("ghp_secret_value");
    // The allowlist still excludes every other secret.
    expect(env.LINEAR_API_KEY).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(Object.keys(env).sort()).toEqual(["GITHUB_TOKEN", ...ENV_BASELINE].sort());
  });

  test("a team-level grant reaches every member of the team", () => {
    const repo = loadRepo(ROOT);
    repo.teams.get("kestrel")!.connectors = ["linear"]; // team grants linear to all members
    expect(grantedConnectors(repo, "lyra").map((c) => c.name)).toContain("linear");
    const env = buildMemberEnv(repo, "lyra", HOSTILE);
    expect(env.LINEAR_API_KEY).toBe("lin_secret_value");
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  test("agent grants ∪ team grants (both connectors' vars appear)", () => {
    const repo = loadRepo(ROOT);
    repo.teams.get("kestrel")!.connectors = ["linear"];
    repo.agents.get("finch")!.connectors = ["github"];
    const env = buildMemberEnv(repo, "finch", HOSTILE);
    expect(env.GITHUB_TOKEN).toBe("ghp_secret_value");
    expect(env.LINEAR_API_KEY).toBe("lin_secret_value");
  });

  test("a baseline var absent from the base env is simply not invented", () => {
    const repo = loadRepo(ROOT);
    const env = buildMemberEnv(repo, "lyra", { PATH: "/bin" }); // no HOME in base
    expect(env.PATH).toBe("/bin");
    expect("HOME" in env).toBe(false);
  });
});

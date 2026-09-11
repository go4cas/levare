import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRepo } from "../src/repo.ts";
import { buildMemberEnv, scopeHome } from "../src/env.ts";
import { buildDispatchSandboxPolicy, type InvokeRequest } from "../src/adapters.ts";
import { buildSandboxExecProfile } from "../src/sandbox.ts";
import { allowedTools } from "../src/guardrails.ts";
import type { Connector } from "../src/types.ts";

// Goal: honour a connector's `home:` for every granted connector, not only the `auth: subscription`
// one. Today env.ts#scopeHome and adapters.ts#buildDispatchSandboxPolicy (and buildNativeSandboxPolicy)
// derive the scratch-HOME symlinks and the sandbox's `grantedHomeTargets` from
// `subscriptionConnector(repo, member)` alone — so an `auth: env` connector declaring `home:` (e.g.
// connectors/gemini.md: `home: [".gemini", ".volta"]`) validates and passes doctor but is inert: the
// member spawns with the operator's real HOME under a profile that denies it.

const ROOT = "fixtures/golden";

function fakeRealHome(): string {
  const home = mkdtempSync(join(tmpdir(), "levare-real-home-"));
  mkdirSync(join(home, ".gemini"), { recursive: true });
  writeFileSync(join(home, ".gemini", "installation_id"), "the-live-id");
  return home;
}

function repoWithEnvHomeConnector(dotpaths: string[], member = "finch"): ReturnType<typeof loadRepo> {
  const repo = loadRepo(ROOT);
  const connector: Connector = {
    name: "gemini-test",
    kind: "cli",
    command: "gemini",
    env: ["GEMINI_API_KEY"],
    auth: "env",
    role: "model",
    effects: "read",
    gate: "proposal",
    home: dotpaths,
  };
  repo.connectors.set("gemini-test", connector);
  repo.agents.get(member)!.connectors = ["gemini-test"];
  return repo;
}

describe("home: on an auth: env connector (not just auth: subscription)", () => {
  test("(a) scopeHome gives a scratch HOME symlinking the env connector's declared dotpath", () => {
    const realHome = fakeRealHome();
    try {
      const repo = repoWithEnvHomeConnector([".gemini"]);
      const env = buildMemberEnv(repo, "finch", { PATH: "/bin", HOME: realHome });
      const scoped = scopeHome(repo, "finch", env);
      try {
        // FAILS today: scopeHome resolves only subscriptionConnector(repo, member), finds none for an
        // auth: env connector, and returns `env` completely unchanged — real, unscoped HOME.
        expect(scoped.env.HOME).not.toBe(realHome);
        expect(existsSync(join(scoped.env.HOME, ".gemini", "installation_id"))).toBe(true);
      } finally {
        scoped.cleanup();
      }
    } finally {
      rmSync(realHome, { recursive: true, force: true });
    }
  });

  test("(b) the darwin sandbox profile re-allows (read+write) the env connector's declared home: target", () => {
    const realHome = fakeRealHome();
    try {
      const repo = repoWithEnvHomeConnector([".gemini"]);
      const agent = repo.agents.get("finch")!;
      const baseEnv = { PATH: "/bin", HOME: realHome };
      const env = buildMemberEnv(repo, "finch", baseEnv);
      const req: InvokeRequest = { agent, member: "finch", kind: "review", unit: "u", project: "p", context: "", env, tools: allowedTools(agent) };
      const policy = buildDispatchSandboxPolicy(repo, req, "/work/scratch-wt", "gemini", baseEnv);
      const target = join(realHome, ".gemini");

      // FAILS today: buildDispatchSandboxPolicy derives `grantedHomeTargets` from
      // subscriptionConnector(repo, req.member) alone, so an auth: env connector's home: never
      // contributes a target — the real HOME stays denied under a "full"-tier sandbox.
      expect(policy.grantedHomeTargets).toContain(target);

      // buildSandboxExecProfile's own canon() resolves every granted path through realpathSync before
      // emitting it — on macOS, tmpdir() sits under a symlink (/var/folders/... -> /private/var/...), so
      // the profile's own re-allow line names the REALPATH form, not the raw tmpdir()-derived `target`
      // above (sandbox.test.ts's own "canonicalized through a symlink" tests use this identical
      // realpathSync-before-matching pattern for the same reason).
      const targetCanonical = join(realpathSync(realHome), ".gemini");
      const profile = buildSandboxExecProfile({ ...policy, operatorHome: realHome });
      expect(profile).toContain(`(allow file-read* (subpath ${JSON.stringify(targetCanonical)}))`);
      expect(profile).toContain(`(allow file-write* (subpath ${JSON.stringify(targetCanonical)}))`);
    } finally {
      rmSync(realHome, { recursive: true, force: true });
    }
  });
});

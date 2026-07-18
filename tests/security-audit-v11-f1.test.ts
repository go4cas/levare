// Security audit v1.1, F1 (HIGH) — home: traversal escapes scoped HOME (docs/security-audit-v11.md,
// NOTES SEC-V11). A finding here is a failing test against the pre-fix code, not an opinion.

import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePath } from "../src/validate.ts";
import { loadRepo } from "../src/repo.ts";
import { buildMemberEnv, scopeHome } from "../src/env.ts";
import type { Connector } from "../src/types.ts";

function rmrf(p: string): void {
  rmSync(p, { recursive: true, force: true });
}

describe("F1 — validate.ts rejects an unsafe home: dotpath", () => {
  function connectorStudio(homeLine: string): string {
    const dir = mkdtempSync(join(tmpdir(), "levare-f1-validate-"));
    mkdirSync(join(dir, "connectors"), { recursive: true });
    writeFileSync(
      join(dir, "connectors", "codex.md"),
      ["---", "name: codex", "kind: cli", "command: codex", "auth: subscription", "env: []", homeLine, "---", "", "# Codex connector", ""].join("\n"),
    );
    return dir;
  }

  for (const bad of ["../../.ssh", "..", ".", "/etc/passwd", "foo/../../bar", ""]) {
    test(`home: [${JSON.stringify(bad)}] is rejected, naming the offending value`, () => {
      const dir = connectorStudio(`home: [${JSON.stringify(bad)}]`);
      try {
        const r = validatePath(dir);
        expect(r.ok).toBe(false);
        const err = r.errors.find((e) => e.code === "UNSAFE_HOME_PATH");
        expect(err).toBeDefined();
        expect(err!.message).toContain("codex");
        expect(err!.message).toContain(`'${bad}'`);
      } finally {
        rmrf(dir);
      }
    });
  }

  test("a nested valid dotpath like '.config/gh' still validates clean", () => {
    const dir = connectorStudio('home: [".config/gh"]');
    try {
      const r = validatePath(dir);
      expect(r.errors.filter((e) => e.code === "UNSAFE_HOME_PATH")).toEqual([]);
    } finally {
      rmrf(dir);
    }
  });

  test("a mix of one safe and one traversal entry reports only the traversal one", () => {
    const dir = connectorStudio('home: [".codex", "../../.ssh"]');
    try {
      const r = validatePath(dir);
      const errs = r.errors.filter((e) => e.code === "UNSAFE_HOME_PATH");
      expect(errs).toHaveLength(1);
      expect(errs[0].message).toContain("../../.ssh");
    } finally {
      rmrf(dir);
    }
  });
});

describe("F1 — env.ts#scopeHome fails closed regardless of validation", () => {
  const ROOT = "fixtures/golden";

  /** A real home directory, plus a decoy planted ONE LEVEL UP (outside the home entirely) — a
   * traversal dotpath's TARGET resolves exactly there, deterministically (no reliance on tmp-dir
   * depth reaching filesystem root). Nothing must ever symlink to it. */
  function fakeRealHomeWithOuterDecoy(): { outerDir: string; realHome: string } {
    const outerDir = mkdtempSync(join(tmpdir(), "levare-f1-outer-"));
    const realHome = join(outerDir, "home");
    mkdirSync(join(realHome, ".codex"), { recursive: true });
    writeFileSync(join(realHome, ".codex", "auth.json"), "the-live-token");
    writeFileSync(join(outerDir, "decoy-secret.txt"), "should-never-be-linked-to");
    return { outerDir, realHome };
  }

  function repoWithHome(realHome: string, dotpaths: string[]): ReturnType<typeof loadRepo> {
    const repo = loadRepo(ROOT);
    // Built in-memory and never passed through validate.ts — this is the "bypassing validate, calling
    // the function directly" case the goal asks for: scopeHome must fail closed on its own.
    const connector: Connector = {
      name: "codex-test",
      kind: "cli",
      command: "codex",
      env: [],
      auth: "subscription",
      role: "model",
      effects: "read",
      gate: "proposal",
      home: dotpaths,
    };
    repo.connectors.set("codex-test", connector);
    repo.agents.get("finch")!.connectors = ["codex-test"];
    return repo;
  }

  test("a traversal home: entry creates NO escaping symlink, and cleanup leaves nothing behind (decoy-outside-scratch proof)", () => {
    const { outerDir, realHome } = fakeRealHomeWithOuterDecoy();
    try {
      const repo = repoWithHome(realHome, ["../decoy-secret.txt", ".codex"]);
      const env = buildMemberEnv(repo, "finch", { PATH: "/bin", HOME: realHome });
      const scoped = scopeHome(repo, "finch", env);
      try {
        // The traversal entry is refused, recorded, never symlinked.
        expect(scoped.skipped).toEqual(["../decoy-secret.txt"]);
        // The scratch HOME contains ONLY the safe dotpath — nothing named after the traversal target.
        expect(readdirSync(scoped.env.HOME)).toEqual([".codex"]);
        expect(existsSync(join(scoped.env.HOME, "decoy-secret.txt"))).toBe(false);
        // The safe dotpath alongside it still resolves normally.
        expect(readFileSync(join(scoped.env.HOME, ".codex", "auth.json"), "utf8")).toBe("the-live-token");
        // The decoy itself was never touched — no symlink anywhere points at it, no write landed on it.
        expect(readFileSync(join(outerDir, "decoy-secret.txt"), "utf8")).toBe("should-never-be-linked-to");
      } finally {
        scoped.cleanup();
      }
      // Cleanup removed the scratch dir...
      expect(existsSync(scoped.env.HOME)).toBe(false);
      // ...and never touched anything outside it — the decoy (and its containing dir) survive untouched.
      expect(existsSync(join(outerDir, "decoy-secret.txt"))).toBe(true);
    } finally {
      rmrf(outerDir);
    }
  });

  test("an absolute-path home: entry is also refused, never symlinked", () => {
    const { outerDir, realHome } = fakeRealHomeWithOuterDecoy();
    try {
      const repo = repoWithHome(realHome, ["/etc/passwd"]);
      const env = buildMemberEnv(repo, "finch", { PATH: "/bin", HOME: realHome });
      const scoped = scopeHome(repo, "finch", env);
      try {
        expect(scoped.skipped).toEqual(["/etc/passwd"]);
        expect(readdirSync(scoped.env.HOME)).toEqual([]);
      } finally {
        scoped.cleanup();
      }
    } finally {
      rmrf(outerDir);
    }
  });

  test("nested valid dotpaths (e.g. '.config/gh') still work", () => {
    const { outerDir, realHome } = fakeRealHomeWithOuterDecoy();
    try {
      mkdirSync(join(realHome, ".config", "gh"), { recursive: true });
      writeFileSync(join(realHome, ".config", "gh", "hosts.yml"), "github.com: {}\n");
      const repo = repoWithHome(realHome, [".config/gh"]);
      const env = buildMemberEnv(repo, "finch", { PATH: "/bin", HOME: realHome });
      const scoped = scopeHome(repo, "finch", env);
      try {
        expect(scoped.skipped).toEqual([]);
        expect(readFileSync(join(scoped.env.HOME, ".config", "gh", "hosts.yml"), "utf8")).toBe("github.com: {}\n");
      } finally {
        scoped.cleanup();
      }
    } finally {
      rmrf(outerDir);
    }
  });
});

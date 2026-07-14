import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePath } from "../src/validate.ts";

// NOTES C11 part 4, hard rule (a): a committed `.env` in a studio that will be shared is a
// catastrophe — every credential it held becomes visible to anyone who clones the repo, forever, even
// after the file is later removed. `levare validate` must fail closed on this, naming the file and why.
// A hermetic scratch git repo, same posture as immutability.test.ts: no host git config is read, every
// commit carries explicit identity/signing/hook overrides.

const HERMETIC_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0", HOME: tmpdir() };

function git(repoRoot: string, args: string[]): ReturnType<typeof spawnSync> {
  const r = spawnSync(
    "git",
    ["-C", repoRoot, "-c", "user.name=levare-test", "-c", "user.email=test@levare.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "init.defaultBranch=main", ...args],
    { encoding: "utf8", env: HERMETIC_ENV },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}${r.stdout}`);
  return r;
}

function scratchStudio(): string {
  const root = mkdtempSync(join(tmpdir(), "levare-env-tracked-"));
  mkdirSync(join(root, "teams"), { recursive: true });
  mkdirSync(join(root, "agents"), { recursive: true });
  git(root, ["init", "-q"]);
  return root;
}

describe("NOTES C11 part 4: levare validate fails closed on a tracked .env", () => {
  test("a .env committed at the studio root fails validation, naming the file", () => {
    const root = scratchStudio();
    try {
      writeFileSync(join(root, ".env"), "ANTHROPIC_API_KEY=sk-ant-super-secret\n");
      git(root, ["add", "-A"]);
      git(root, ["commit", "-q", "-m", "oops, committed the .env"]);

      const result = validatePath(root);
      expect(result.ok).toBe(false);
      const envErrors = result.errors.filter((e) => e.code === "ENV_FILE_TRACKED");
      expect(envErrors).toHaveLength(1);
      expect(envErrors[0].file).toBe(join(root, ".env"));
      expect(envErrors[0].message).toContain(".env");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("`levare validate` exits 1 and reports ENV_FILE_TRACKED on the CLI", () => {
    const root = scratchStudio();
    try {
      writeFileSync(join(root, ".env"), "GEMINI_API_KEY=leaked\n");
      git(root, ["add", "-A"]);
      git(root, ["commit", "-q", "-m", "oops"]);

      const p = Bun.spawnSync(["./levare", "validate", root]);
      expect(p.exitCode).toBe(1);
      expect(p.stderr.toString()).toContain("ENV_FILE_TRACKED");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an UNTRACKED .env at the studio root is not an error", () => {
    const root = scratchStudio();
    try {
      writeFileSync(join(root, ".gitignore"), ".env\n");
      git(root, ["add", "-A"]);
      git(root, ["commit", "-q", "-m", "gitignore the .env"]);
      writeFileSync(join(root, ".env"), "ANTHROPIC_API_KEY=sk-ant-not-committed\n");

      const result = validatePath(root);
      const envErrors = result.errors.filter((e) => e.code === "ENV_FILE_TRACKED");
      expect(envErrors).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("no .env at all is not an error, and a non-git target is not an error either", () => {
    const root = scratchStudio();
    try {
      const result = validatePath(root);
      expect(result.errors.filter((e) => e.code === "ENV_FILE_TRACKED")).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    const nonGit = mkdtempSync(join(tmpdir(), "levare-env-tracked-nongit-"));
    try {
      writeFileSync(join(nonGit, ".env"), "FOO=bar\n");
      const result = validatePath(nonGit);
      expect(result.errors.filter((e) => e.code === "ENV_FILE_TRACKED")).toHaveLength(0);
    } finally {
      rmSync(nonGit, { recursive: true, force: true });
    }
  });
});

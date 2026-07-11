import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePath } from "../src/validate.ts";

// PRD §4: "an approved artifact's file content may not change in a later commit (checked at
// validation time against git)." This can only be exercised against a live git repo, so it lives
// in its own throwaway repo rather than a static on-disk fixture (see NOTES.md A4).
//
// The scratch repo is HERMETIC: it must behave identically on a bare CI container and on a
// developer host with a real global/system git config (gpg signing, commit hooks, a non-`main`
// init.defaultBranch, etc). We achieve that two ways at once:
//   1. GIT_CONFIG_GLOBAL / GIT_CONFIG_SYSTEM are pointed at /dev/null so no host config is read.
//   2. Every git invocation carries explicit -c overrides for identity, signing, hooks, and the
//      default branch — belt-and-suspenders in case a hostile setting slips through the env.
// The `git()` helper throws on non-zero status, so a failed commit fails the suite loudly at setup
// rather than silently leaving an empty repo that would make the mutation check a false negative.

const HERMETIC_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  HOME: tmpdir(), // last-resort isolation for any config path derived from HOME
};

let root: string;
let artifactPath: string;

function git(args: string[], opts: { allowFail?: boolean } = {}): ReturnType<typeof spawnSync> {
  const r = spawnSync(
    "git",
    [
      "-C",
      root,
      "-c",
      "user.name=levare-test",
      "-c",
      "user.email=test@levare.test",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "tag.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    { encoding: "utf8", env: HERMETIC_ENV },
  );
  if (!opts.allowFail && r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (status ${r.status}):\n${r.stderr ?? ""}${r.stdout ?? ""}`);
  }
  return r;
}

const APPROVED = [
  "---",
  "kind: spec",
  "id: spec-immutable-v1",
  "unit: checkout-flow",
  "project: storefront",
  "status: approved",
  "produced_by: kestrel/lyra",
  "consumes: []",
  "supersedes: null",
  'approved_by: "cas 2026-07-11"',
  "created: 2026-07-11",
  "files: []",
  "---",
  "Original approved body.",
  "",
].join("\n");

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "levare-immutability-"));
  git(["init", "-q"]);
  const dir = join(root, "work", "storefront", "checkout-flow");
  mkdirSync(dir, { recursive: true });
  artifactPath = join(dir, "spec-immutable-v1.md");
  writeFileSync(artifactPath, APPROVED);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "approve spec"]);
  // Fail loudly if the commit did not actually produce a HEAD — otherwise the mutation check below
  // would be a false negative (nothing committed → nothing to compare → wrongly "valid").
  const head = git(["rev-parse", "HEAD"]);
  if (!/^[0-9a-f]{40}/.test((head.stdout ?? "").trim())) {
    throw new Error("hermetic setup failed: no commit was created");
  }
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("approved-immutability against git", () => {
  test("an unmodified committed approved artifact validates clean", () => {
    const r = validatePath(root);
    expect(r.errors.map((e) => e.code)).not.toContain("MODIFIED_AFTER_APPROVAL");
  });

  test("mutating an approved artifact after commit is rejected", () => {
    writeFileSync(artifactPath, APPROVED.replace("Original approved body.", "Silently edited body."));
    const r = validatePath(root);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.code)).toContain("MODIFIED_AFTER_APPROVAL");
  });
});

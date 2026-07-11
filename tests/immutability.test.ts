import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { validatePath, type ImmutabilityState } from "../src/validate.ts";

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

// Run git hermetically inside `repoRoot` and throw (unless allowFail) on non-zero status, so a
// failed commit fails the suite loudly at setup rather than leaving an empty repo.
function git(repoRoot: string, args: string[], opts: { allowFail?: boolean } = {}): ReturnType<typeof spawnSync> {
  const r = spawnSync(
    "git",
    [
      "-C",
      repoRoot,
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

// Look up the immutability state the validator recorded for a given artifact file basename.
function stateOf(r: ReturnType<typeof validatePath>, name: string): ImmutabilityState | undefined {
  return r.immutability.find((c) => basename(c.file) === name)?.state;
}

// Stand up a scratch repo at `root` with one approved artifact committed; returns the artifact path.
function seedApprovedRepo(root: string): string {
  git(root, ["init", "-q"]);
  const dir = join(root, "work", "storefront", "checkout-flow");
  mkdirSync(dir, { recursive: true });
  const artifactPath = join(dir, "spec-immutable-v1.md");
  writeFileSync(artifactPath, APPROVED);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "approve spec"]);
  const head = git(root, ["rev-parse", "HEAD"]);
  if (!/^[0-9a-f]{40}/.test((head.stdout ?? "").trim())) {
    throw new Error("hermetic setup failed: no commit was created");
  }
  return artifactPath;
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

let root: string;
let artifactPath: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "levare-immutability-"));
  artifactPath = seedApprovedRepo(root);
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("approved-immutability against git", () => {
  test("an unmodified committed approved artifact is state S2a (valid)", () => {
    const r = validatePath(root);
    expect(stateOf(r, "spec-immutable-v1.md")).toBe("S2a");
    expect(r.errors.map((e) => e.code)).not.toContain("MODIFIED_AFTER_APPROVAL");
  });

  test("mutating an approved artifact after commit is state S2b + MODIFIED_AFTER_APPROVAL", () => {
    writeFileSync(artifactPath, APPROVED.replace("Original approved body.", "Silently edited body."));
    const r = validatePath(root);
    // Assert the STATE, not merely ok:false — a wrong-state exit (e.g. S1 masking the mutation)
    // could otherwise leave the artifact "valid" and slip past.
    expect(stateOf(r, "spec-immutable-v1.md")).toBe("S2b");
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.code)).toContain("MODIFIED_AFTER_APPROVAL");
  });
});

// Container repro of the macOS /var → /private/var canonicalization bug: the repo is reached
// through a symlinked path, so `git rev-parse --show-toplevel` returns a canonical path that
// differs from the one the validator holds. Before the realpath fix this exited via S1 ("no
// history → valid"), masking the mutation. It must now correctly reach S2b.
describe("approved-immutability across a symlinked repo path", () => {
  let realBase: string;
  let aliasRoot: string;

  beforeAll(() => {
    realBase = mkdtempSync(join(tmpdir(), "levare-symlink-real-"));
    const realRoot = join(realBase, "repo");
    mkdirSync(realRoot, { recursive: true });
    seedApprovedRepo(realRoot);
    // A sibling symlink whose target is the real base dir; the repo is then addressed *through* it.
    const aliasBase = join(tmpdir(), `levare-symlink-alias-${basename(realBase)}`);
    symlinkSync(realBase, aliasBase);
    aliasRoot = join(aliasBase, "repo");
  });

  afterAll(() => {
    if (realBase) rmSync(realBase, { recursive: true, force: true });
  });

  test("unmodified via symlinked path is S2a", () => {
    const r = validatePath(aliasRoot);
    expect(stateOf(r, "spec-immutable-v1.md")).toBe("S2a");
  });

  test("mutation via symlinked path is correctly detected as S2b (not masked as S1)", () => {
    writeFileSync(join(aliasRoot, "work", "storefront", "checkout-flow", "spec-immutable-v1.md"),
      APPROVED.replace("Original approved body.", "Edited through the symlink."));
    const r = validatePath(aliasRoot);
    expect(stateOf(r, "spec-immutable-v1.md")).toBe("S2b");
    expect(r.errors.map((e) => e.code)).toContain("MODIFIED_AFTER_APPROVAL");
  });
});

// A git diff that errors (status > 1) must never be recorded as a verified-unchanged S2a. We reach
// S2 (cat-file -e HEAD:rel succeeds, worktree file stays readable so discovery parses it) but make
// `git diff` fail by corrupting .git/index — a git error, not a real diff. The result is S2e:
// unverifiable, fail-open for `ok` (consistent with S0/S1) but distinct from "verified unchanged".
describe("approved-immutability when git diff errors", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "levare-diff-error-"));
    seedApprovedRepo(root);
    // Corrupt the index so `git diff --quiet HEAD -- <rel>` exits 128, while the committed blob
    // (cat-file -e) and the on-disk worktree file both remain intact and readable.
    writeFileSync(join(root, ".git", "index"), "GARBAGE-NOT-AN-INDEX");
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("a git diff error is recorded as S2e, fails open, and is not S2a", () => {
    const r = validatePath(root);
    const state = stateOf(r, "spec-immutable-v1.md");
    expect(state).toBe("S2e");
    expect(state).not.toBe("S2a");
    // Fail-open: an environment hiccup must not fabricate a MODIFIED_AFTER_APPROVAL violation.
    expect(r.errors.map((e) => e.code)).not.toContain("MODIFIED_AFTER_APPROVAL");
  });
});

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePath } from "../src/validate.ts";

// PRD §4: "an approved artifact's file content may not change in a later commit (checked at
// validation time against git)." This can only be exercised against a live git repo, so it lives
// in its own throwaway repo rather than a static on-disk fixture (see NOTES.md A4).

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

function git(args: string[]) {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "levare-immutability-"));
  spawnSync("git", ["-C", root, "init", "-q"], { encoding: "utf8" });
  git(["config", "user.email", "test@levare.test"]);
  git(["config", "user.name", "test"]);
  const dir = join(root, "work", "storefront", "checkout-flow");
  mkdirSync(dir, { recursive: true });
  artifactPath = join(dir, "spec-immutable-v1.md");
  writeFileSync(artifactPath, APPROVED);
  git(["add", "-A"]);
  git(["-c", "user.email=test@levare.test", "-c", "user.name=test", "commit", "-q", "-m", "approve spec"]);
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

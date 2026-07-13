import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, cpSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRepo } from "../src/repo.ts";
import { AdapterRunner, bunSpawn, type NativeBoundary, type RemoteBoundary } from "../src/adapters.ts";
import { loadPricing } from "../src/pricing.ts";
import { render } from "../fixtures/stubs/member-stub.ts";

// Ruling C9 (NOTES D6): `context_artifacts: paths | inline` is a per-agent declaration read straight
// off disk — this proves `levare context --dry-run` prints EXACTLY what a REAL spawned CLI member
// receives, in both modes, against a real (unmocked) subprocess (`cat`, echoing its stdin back), not
// an internal flag. Mirrors the F7 dry-run/live parity proof (tests/serve-real-cli-e2e.test.ts), for
// the new delivery-mode axis.

const REPO_ROOT = join(import.meta.dir, "..");
const nativeMock: NativeBoundary = { invoke: (r) => ({ doc: render(r.member, r.kind, r.unit, r.project) }) };
const remoteMock: RemoteBoundary = { call: (r) => ({ doc: render(r.member, r.kind, r.unit, r.project) }) };

function finchAgent(mode: "paths" | "inline" | undefined): string {
  const contextArtifacts = mode ? `\ncontext_artifacts: ${mode}` : "";
  return [
    "---",
    "name: finch",
    "kind: cli",
    "produces: [review]",
    'command: ["cat"]',
    "context_via: stdin" + contextArtifacts,
    "timeout: 30",
    'result: "Emits a review artifact markdown file to stdout."',
    "style:",
    "  avatar: Fi",
    "---",
    "",
    "# Finch — real CLI member (C9 dry-run/live parity)",
    "",
  ].join("\n");
}

describe("ruling C9: `levare context --dry-run` matches a REAL spawned member, in both modes", () => {
  let pathsRoot: string;
  let inlineRoot: string;
  let defaultRoot: string;

  beforeAll(() => {
    pathsRoot = mkdtempSync(join(tmpdir(), "levare-c9-paths-"));
    inlineRoot = mkdtempSync(join(tmpdir(), "levare-c9-inline-"));
    defaultRoot = mkdtempSync(join(tmpdir(), "levare-c9-default-"));
    for (const [root, mode] of [
      [pathsRoot, "paths"],
      [inlineRoot, "inline"],
      [defaultRoot, undefined],
    ] as const) {
      cpSync(join(REPO_ROOT, "fixtures/golden"), root, { recursive: true });
      writeFileSync(join(root, "agents/finch.md"), finchAgent(mode));
    }
  });

  afterAll(() => {
    for (const root of [pathsRoot, inlineRoot, defaultRoot]) rmSync(root, { recursive: true, force: true });
  });

  function dryRun(root: string): string {
    const p = Bun.spawnSync(["./levare", "context", "finch", "--unit", "checkout-flow", "--root", root, "--dry-run"], { cwd: REPO_ROOT });
    expect(p.exitCode).toBe(0);
    return p.stdout.toString();
  }

  function realSpawned(root: string): string {
    const repo = loadRepo(root);
    const runner = new AdapterRunner(repo, { pricing: loadPricing(root), native: nativeMock, remote: remoteMock, spawn: bunSpawn });
    const { doc } = runner.produce("finch", "review", "checkout-flow", "storefront");
    return doc;
  }

  test("context_artifacts: paths — dry-run equals the real spawned member's stdin, paths only", () => {
    const dry = dryRun(pathsRoot);
    const real = realSpawned(pathsRoot);
    expect(dry).toBe(real);
    expect(dry).toContain("── 7. consumed artifacts (paths only — never contents) ──");
    expect(dry).toContain("work/storefront/checkout-flow/product-brief-v1.md");
    expect(dry).not.toContain("saved-card fallback");
  });

  test("context_artifacts: inline — dry-run equals the real spawned member's stdin, full text", () => {
    const dry = dryRun(inlineRoot);
    const real = realSpawned(inlineRoot);
    expect(dry).toBe(real);
    expect(dry).toContain("── 7. consumed artifacts (inline — full text, per agent declaration `context_artifacts: inline`, ruling C9) ──");
    expect(dry).toContain("work/storefront/checkout-flow/product-brief-v1.md");
    expect(dry).toContain("saved-card fallback"); // the consumed brief's body, now inlined
    expect(dry).toContain("abandoned at that wall");
  });

  test("undeclared `context_artifacts` (absent field) still defaults to paths — dry-run equals real spawn", () => {
    const dry = dryRun(defaultRoot);
    const real = realSpawned(defaultRoot);
    expect(dry).toBe(real);
    expect(dry).toContain("── 7. consumed artifacts (paths only — never contents) ──");
    expect(dry).not.toContain("saved-card fallback");
  });
});

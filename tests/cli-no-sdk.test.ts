import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// NOTES REV1 finding 1 — CRITICAL: every CLI command used to require @anthropic-ai/claude-agent-sdk
// to be installed, even commands (`validate`, `doctor`, `context`) that never touch a model. Root
// cause: `cli.ts` had a top-level `import { runSdkWorkerFromStdin } from "./sdk-worker.ts"`, and
// `sdk-worker.ts` has its own top-level `import { query } from "@anthropic-ai/claude-agent-sdk"` — ES
// module imports run at load time regardless of which command actually gets dispatched, so on a fresh
// checkout with no `bun install` (no node_modules at all), EVERY command failed before reaching its
// own logic with "Cannot find module '@anthropic-ai/claude-agent-sdk'".
//
// The fix (cli.ts#runCli): the sdk-worker.ts import is now a dynamic `await import()` inside the
// WORKER_COMMAND branch only, so the SDK is required to resolve exactly when `__worker` actually runs
// — never for any other command.
//
// The cleanest honest simulation of "environment where the SDK cannot resolve" is a real fresh
// checkout: copy just the source tree (src/, assets/, docs/, fixtures/, package.json) into a scratch
// directory with NO node_modules at all, and no ancestor directory that has one either (a tmpdir root
// has no node_modules anywhere above it) — Node/Bun module resolution walks up from cwd looking for
// node_modules, so this is a genuine "SDK unresolvable" environment, not a mock. `package.json`
// declares exactly one dependency (the SDK) and nothing else in src/ requires a third-party package
// (see deps:check, invariant 10) — every non-SDK import here is a Bun/Node builtin or a relative file
// path, both of which resolve with no node_modules present at all.
//
// One wrinkle, confirmed empirically: Bun's OWN runtime defaults to `--install=auto` — "auto-installs
// when no node_modules" — so simply deleting node_modules is not enough; left alone, Bun silently
// fetches the missing package from its global cache/registry and the SDK resolves anyway, masking
// exactly the bug this test exists to catch. Every invocation below passes `--no-install` explicitly,
// which is the honest equivalent of the described failure environments ("a fresh checkout without
// `bun install`" in an offline CI runner, a locked-down registry, or any host where Bun's own
// auto-install is disabled) — the scenario `cli.ts:16`'s old top-level import broke, not "no
// node_modules AND no way for Bun to ever find the package by any means".

const REPO_ROOT = process.cwd();
const scratchRoot = mkdtempSync(join(tmpdir(), "levare-no-sdk-"));

// A fresh checkout with no `bun install` yet — no node_modules directory anywhere in or above it.
for (const dir of ["src", "assets", "docs", "fixtures"]) {
  cpSync(join(REPO_ROOT, dir), join(scratchRoot, dir), { recursive: true });
}
cpSync(join(REPO_ROOT, "package.json"), join(scratchRoot, "package.json"));

afterAll(() => {
  rmSync(scratchRoot, { recursive: true, force: true });
});

function run(argv: string[]) {
  const p = Bun.spawnSync(["bun", "--no-install", join(scratchRoot, "src", "cli.ts"), ...argv], {
    cwd: scratchRoot,
    env: { PATH: process.env.PATH }, // deliberately minimal — no NODE_PATH, no inherited node_modules hint
    stdin: Buffer.from(""),
  });
  return { exitCode: p.exitCode, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}

describe("offline commands run with the SDK genuinely unresolvable (NOTES REV1 finding 1)", () => {
  test("`levare validate` succeeds and never mentions the SDK package", () => {
    const { exitCode, stdout, stderr } = run(["validate", "fixtures/golden"]);
    expect(stderr).not.toContain("claude-agent-sdk");
    expect(stderr).not.toContain("Cannot find module");
    expect(stdout).toContain("valid");
    expect(exitCode).toBe(0);
  });

  test("`levare doctor` succeeds and never mentions the SDK package", () => {
    const { exitCode, stdout, stderr } = run(["doctor", "fixtures/golden"]);
    expect(stderr).not.toContain("claude-agent-sdk");
    expect(stderr).not.toContain("Cannot find module");
    expect(stdout).toContain("levare doctor");
    expect(exitCode).toBe(0);
  });

  test("`levare context <agent> --unit <unit> --dry-run` succeeds and never mentions the SDK package", () => {
    const { exitCode, stdout, stderr } = run(["context", "lyra", "--unit", "checkout-flow", "--dry-run"]);
    expect(stderr).not.toContain("claude-agent-sdk");
    expect(stderr).not.toContain("Cannot find module");
    expect(stdout.length).toBeGreaterThan(0);
    expect(exitCode).toBe(0);
  });

  // Proves the premise: this scratch checkout genuinely cannot resolve the SDK — so the three passes
  // above are proof the commands never even attempt to load it, not an accident of a lenient
  // environment. `__worker` is the one command that IS supposed to need the SDK; it must still fail
  // here, with the exact "unresolvable module" shape, never "unknown command" (that would mean
  // dispatch itself broke) and never a silent success (that would mean the SDK was found some other
  // way, invalidating the whole premise of this test file).
  test("`levare __worker` (the one command that DOES need the SDK) fails with a module-resolution error, proving the premise", () => {
    const { exitCode, stderr } = run(["__worker"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).not.toContain("unknown command");
    expect(stderr.toLowerCase()).toMatch(/cannot find (package|module)/);
    expect(stderr).toContain("claude-agent-sdk");
  });
});

// The other half of NOTES REV1 finding 1's "achieved when": making the import lazy must not break
// WORKER_COMMAND when the SDK genuinely IS installed. tests/orchestrator-compiled-smoke.test.ts
// already proves this for a COMPILED binary; this is the source-run counterpart — real repo, real
// installed node_modules, real `bun src/cli.ts __worker` self-invocation (the same dispatch path
// `sdk-transport.ts#workerSpawnArgv` uses for a source run).
describe("`__worker` still dispatches correctly in source mode when the SDK IS installed (NOTES REV1 finding 1)", () => {
  test("piping a malformed request returns the worker's own error shape, never 'unknown command' or a module-resolution failure", () => {
    const p = Bun.spawnSync(["bun", join(REPO_ROOT, "src", "cli.ts"), "__worker"], {
      cwd: REPO_ROOT,
      env: process.env,
      stdin: Buffer.from(""),
    });
    expect(p.exitCode).toBe(0);
    const out = p.stdout.toString().trim();
    expect(out).not.toContain("unknown command");
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("malformed request JSON");
  });
});

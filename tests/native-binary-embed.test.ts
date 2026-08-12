import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// NOTES DIST7: proof against a REAL `scripts/build.sh` output, run from a REAL foreign cwd — the one
// variable that makes this bug real and that `tests/orchestrator-compiled-smoke.test.ts` (NOTES
// DIST4/DIST5) never varies. That file's own `doctor` assertions spawn with no explicit `cwd` (so it
// inherits `bun test`'s own cwd, the repo root); its `serve`-based assertions explicitly pin
// `cwd: process.cwd()` (repo root again) while passing the studio path only as a CLI argument. Both
// shapes happen to succeed pre-fix, because the pre-fix bug is a `require.resolve` fallback that walks
// from `process.cwd()`, and the repo root is exactly where `node_modules/@anthropic-ai/claude-agent-
// sdk-*` really lives on disk — a coincidence a real release binary, invoked from a scaffolded studio
// nowhere near this repo, never gets. This file spawns with `cwd` pointed at a directory that is
// genuinely outside the repo tree, mirroring a real user's `levare init` scaffold, so it fails against
// today's pre-fix compiled artifact and passes once the native binary is embedded (not looked up).

const scratchOut = join(mkdtempSync(join(tmpdir(), "levare-native-embed-")), "levare");

function buildScratchBinary(): void {
  const p = Bun.spawnSync(["bash", "scripts/build.sh", scratchOut], { cwd: process.cwd() });
  if (p.exitCode !== 0) {
    throw new Error(`scripts/build.sh failed: ${p.stderr.toString()}${p.stdout.toString()}`);
  }
}

buildScratchBinary();

afterAll(() => {
  rmSync(scratchOut, { force: true });
});

// A real, git-backed scratch studio (mirroring `orchestrator-compiled-smoke.test.ts`'s own
// `seedScratchStudio`) — located under the OS temp dir, structurally nowhere near this repo's
// node_modules, exactly like a real `levare init` scaffold.
function seedForeignStudio(): string {
  const root = mkdtempSync(join(tmpdir(), "levare-native-embed-studio-"));
  Bun.spawnSync(["cp", "-r", "fixtures/golden/.", root], { cwd: process.cwd() });
  Bun.spawnSync(["git", "init", "-q"], { cwd: root });
  Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t.com", "-c", "commit.gpgsign=false", "add", "-A"], { cwd: root });
  Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t.com", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "seed"], { cwd: root });
  return root;
}

describe("a compiled binary resolves its embedded native SDK binary from a real user's cwd, not just this repo's own (NOTES DIST7)", () => {
  test("`<compiled> doctor` invoked with cwd OUTSIDE the repo reports 'orchestrator: on' with a credential present", () => {
    const studio = seedForeignStudio();
    try {
      // The whole point: `cwd` here is the scratch studio, genuinely outside the repo tree — not
      // `process.cwd()` (this test runner's own cwd, the repo root, which is what let the pre-fix bug
      // hide from every earlier compiled-binary test).
      const p = Bun.spawnSync([scratchOut, "doctor", "."], {
        cwd: studio,
        env: { ...process.env, ANTHROPIC_API_KEY: "sk-ant-test-not-real" },
      });
      expect(p.exitCode).toBe(0);
      const out = p.stdout.toString();
      expect(out).toContain("run mode: compiled");
      expect(out).toContain("orchestrator: on");
      // The old failure text, gone — not merely absent from a passing assertion elsewhere. (Doctor's
      // output legitimately contains other, unrelated "not found" lines — an unconfigured `github`/
      // `linear` connector — so this checks the specific phrase, not the bare substring.)
      expect(out).not.toContain("native CLI binary");
    } finally {
      rmSync(studio, { recursive: true, force: true });
    }
  });

  test("the scratch binary embeds the exact bytes of this host's own platform native binary (scripts/verify-embedded-binary.ts)", () => {
    const platformArch = `${process.platform}-${process.arch}`;
    const p = Bun.spawnSync(["bun", "scripts/verify-embedded-binary.ts", scratchOut, platformArch], { cwd: process.cwd() });
    const out = p.stdout.toString() + p.stderr.toString();
    expect(p.exitCode).toBe(0);
    expect(out).toContain("OK —");
  }, 30_000);
});

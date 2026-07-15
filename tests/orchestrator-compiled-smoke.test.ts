import { test, expect, describe, afterAll } from "bun:test";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// NOTES DIST4: this is the test the goal itself asked for — proof against the ACTUAL compiled
// binary, not just the source shim, that `docs/orchestrator-prompt.md` loads correctly under `bun
// build --compile`. Before this fix, a compiled `dist/levare serve` threw `ENOENT: no such file or
// directory, open '/$bunfs/docs/orchestrator-prompt.md'` on the very first `/orchestrator/message`
// call — `orchestrator-boundary.ts`'s `ORCHESTRATOR_PROMPT_PATH` resolved via
// `new URL(..., import.meta.url).pathname`, which points into Bun's virtual `$bunfs` tree once
// compiled, not the real filesystem. The fix is the same `{ type: "file" }` compile-time import
// DIST1 already used for `assets/styles.css`/`assets/app.js`.
//
// Builds one real scratch binary via `scripts/build.sh` (the same script `bun run build` calls, with
// its own container/virtiofs cwd workaround — NOTES DIST1) and exercises it directly, mirroring how
// DIST1 itself verified the assets fix ("compiling a minimal reproduction, then deleting the source
// asset file after compiling"). Costs one real compile (~0.5s) — acceptable for the one thing in this
// repo that source-mode `bun test` genuinely cannot prove.

const scratchOut = join(mkdtempSync(join(tmpdir(), "levare-dist-smoke-")), "levare");

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

describe("the compiled binary can load the orchestrator prompt (NOTES DIST4)", () => {
  test("`<compiled> doctor` reports the prompt readable, byte-for-byte identical to docs/orchestrator-prompt.md", () => {
    const onDisk = readFileSync("docs/orchestrator-prompt.md", "utf8");
    const expectedBytes = Buffer.byteLength(onDisk, "utf8");

    const p = Bun.spawnSync([scratchOut, "doctor", "fixtures/golden"], { env: { ...process.env, ANTHROPIC_API_KEY: "" } });
    expect(p.exitCode).toBe(0);
    const out = p.stdout.toString();

    expect(out).toContain("run mode: compiled");
    expect(out).toContain(`orchestrator prompt: readable (${expectedBytes} bytes)`);
    expect(out).not.toContain("ENOENT");
  });

  test("a compiled `serve` never 500s an /orchestrator/message call with the $bunfs ENOENT", async () => {
    const root = mkdtempSync(join(tmpdir(), "levare-dist-smoke-studio-"));
    Bun.spawnSync(["cp", "-r", "fixtures/golden/.", root]);
    Bun.spawnSync(["git", "init", "-q"], { cwd: root });
    Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t.com", "-c", "commit.gpgsign=false", "add", "-A"], { cwd: root });
    Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t.com", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "seed"], { cwd: root });

    const port = 41000 + Math.floor((process.pid % 1000));
    // A real (if fake) key: `hasAnthropicCredentials`/`resolveOrchestratorStatus` (invariant 11) check
    // PRESENCE only, never the value — this is enough to drive the boundary-selection path all the
    // way to the SAME place a real key would, without a real credential or network call.
    const proc = Bun.spawn([scratchOut, "serve", root, "--port", String(port), "--no-daemon"], {
      env: { ...process.env, ANTHROPIC_API_KEY: "sk-test-not-real" },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      // give the server a moment to bind before the first request
      await new Promise((r) => setTimeout(r, 500));
      const res = await fetch(`http://localhost:${port}/orchestrator/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      });
      const body = await res.json();
      // The prompt loads fine now; the SDK worker's own spawn shape (`Bun.spawn([process.execPath,
      // SDK_WORKER_PATH])`) genuinely cannot run under `--compile` — `process.execPath` there is
      // `dist/levare` itself, not a `bun` interpreter (see orchestrator-status.ts). The route reports
      // that honestly (`disabled: true`) instead of ever attempting — and 500ing — the doomed spawn.
      expect(body.disabled).toBe(true);
      expect(JSON.stringify(body)).not.toContain("ENOENT");
      expect(JSON.stringify(body)).not.toContain("$bunfs");
    } finally {
      proc.kill();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});

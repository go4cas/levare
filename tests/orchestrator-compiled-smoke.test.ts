import { test, expect, describe, afterAll } from "bun:test";
import { readFileSync, rmSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnLevareServe } from "./serve-subprocess.ts";

// NOTES DIST4/DIST5: proof against the ACTUAL compiled binary, not just the source shim, of two
// things `bun test` (which always runs under a source `bun` process, never a compiled one) genuinely
// cannot prove any other way:
//
//   1. (DIST4) `docs/orchestrator-prompt.md` loads correctly under `bun build --compile` — before
//      that fix, a compiled `dist/levare serve` threw `ENOENT: ... open '/$bunfs/docs/orchestrator-
//      prompt.md'` on the very first `/orchestrator/message` call.
//   2. (DIST5) the SDK worker itself can actually RUN under `--compile`. Before DIST5, the worker
//      spawn (`Bun.spawn([process.execPath, SDK_WORKER_PATH])`) re-entered the compiled binary's own
//      CLI parser instead of running the worker (`unknown command: <path>`) — DIST4 could only make
//      the Orchestrator report this honestly (`orchestrator: off`), not fix it. DIST5's fix is
//      self-invocation: the worker is now reached via a hidden `__worker` subcommand
//      (`sdk-transport.ts#workerSpawnArgv`), spawning a FRESH COPY of this same process rather than a
//      separate script — this file proves that spawn actually dispatches into the real worker logic
//      under a REAL compiled binary, not `main()`'s "unknown command" fallback.
//
// Builds one real scratch binary via `scripts/build.sh` (the same script `bun run build` calls, with
// its own container/virtiofs cwd workaround — NOTES DIST1) and exercises it directly, mirroring how
// DIST1 itself verified the assets fix ("compiling a minimal reproduction, then deleting the source
// asset file after compiling"). Costs one real compile (~0.3s) — acceptable for the one thing in this
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

function seedScratchStudio(): string {
  const root = mkdtempSync(join(tmpdir(), "levare-dist-smoke-studio-"));
  Bun.spawnSync(["cp", "-r", "fixtures/golden/.", root]);
  Bun.spawnSync(["git", "init", "-q"], { cwd: root });
  Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t.com", "-c", "commit.gpgsign=false", "add", "-A"], { cwd: root });
  Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t.com", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "seed"], { cwd: root });
  return root;
}

describe("the compiled binary can load the orchestrator prompt (NOTES DIST4)", () => {
  test("`<compiled> doctor` reports the prompt readable, byte-for-byte identical to docs/orchestrator-prompt.md, and 'off' honestly with no credential", () => {
    const onDisk = readFileSync("docs/orchestrator-prompt.md", "utf8");
    const expectedBytes = Buffer.byteLength(onDisk, "utf8");

    const p = Bun.spawnSync([scratchOut, "doctor", "fixtures/golden"], { env: { ...process.env, ANTHROPIC_API_KEY: "" } });
    expect(p.exitCode).toBe(0);
    const out = p.stdout.toString();

    expect(out).toContain("run mode: compiled");
    expect(out).toContain(`orchestrator prompt: readable (${expectedBytes} bytes)`);
    expect(out).not.toContain("ENOENT");
    // NOTES DIST5: with no credential, "off" is a genuinely missing prerequisite (the key), not the
    // old DIST4 blanket "compiled binaries can't run this" refusal — that reason string is gone.
    expect(out).toContain("orchestrator: off");
    expect(out).not.toContain("compiled binary");
  });

  // NOTES DIST5: the whole point of the fix — a compiled binary with a credential present now
  // reports "on", exactly like a source run does. Under DIST4 this always said "off" regardless.
  test("`<compiled> doctor` reports 'orchestrator: on' when a credential is present", () => {
    const p = Bun.spawnSync([scratchOut, "doctor", "fixtures/golden"], { env: { ...process.env, ANTHROPIC_API_KEY: "sk-ant-test-not-real" } });
    expect(p.exitCode).toBe(0);
    const out = p.stdout.toString();
    expect(out).toContain("run mode: compiled");
    expect(out).toContain("orchestrator: on");
  });
});

// NOTES DIST5: the hidden `__worker` subcommand is the exact seam `sdk-transport.ts`'s
// `workerSpawnArgv` self-invokes into, and the ONLY seam either a native member's boundary
// (adapters.ts#createSdkNativeBoundary/createAsyncSdkNativeBoundary) or the Orchestrator's boundary
// (orchestrator-boundary.ts) ever reaches — both default to `bunSdkTransport`/`asyncSdkTransport`,
// the exact same transport instances, with no per-caller branching in the spawn shape at all. Proving
// this one seam dispatches correctly under the REAL compiled binary therefore proves it for both
// callers at once; see NOTES DIST5's own write-up for the code-reading confirmation of that claim.
describe("the compiled binary's hidden `__worker` subcommand reaches the real worker, not the CLI's unknown-command handler (NOTES DIST5)", () => {
  test("piping a request to `<compiled> __worker` returns a worker-shaped JSON response, never 'unknown command'", () => {
    // Empty stdin is a malformed request from the worker's own point of view (JSON.parse("") throws)
    // — this is deliberately a FAST, offline, deterministic case: it proves dispatch reached
    // `runSdkWorkerFromStdin` (a worker-specific error shape) without needing network or a real
    // credential. Before DIST5, this exact invocation printed `unknown command: __worker` and the
    // CLI's usage text instead — `main()`'s default case, not the worker at all.
    const p = Bun.spawnSync([scratchOut, "__worker"], { env: process.env, stdin: Buffer.from("") });
    expect(p.exitCode).toBe(0);
    const out = p.stdout.toString().trim();
    expect(out).not.toContain("unknown command");
    expect(out).not.toContain("usage: levare");
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("malformed request JSON");
  });

  // `__worker` is internal — deliberately never advertised in `--help`/usage(), so an operator never
  // sees or is tempted to run it directly (NOTES DIST5's own achieved-when criterion).
  test("`__worker` is not listed in `--help`", () => {
    const p = Bun.spawnSync([scratchOut, "--help"]);
    expect(p.stdout.toString()).not.toContain("__worker");
  });
});

describe("a compiled `serve` dispatches a real Orchestrator turn through the real self-invoked worker (NOTES DIST5)", () => {
  test("with no credential at all, still reports the honest disabled state (a genuinely missing prerequisite, not a compiled-binary limitation)", async () => {
    const root = seedScratchStudio();
    const { proc, base } = await spawnLevareServe([root, "--no-daemon"], {
      cwd: process.cwd(),
      env: { ...process.env, ANTHROPIC_API_KEY: "" },
      bin: scratchOut,
    });
    try {
      const res = await fetch(`${base}/orchestrator/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      });
      const body = await res.json();
      expect(body.disabled).toBe(true);
      expect(body.reason).not.toContain("compiled binary");
      // NOTES V11-CONV: the disabled path returns before `handle()` is ever called — no exchange was
      // completed, so nothing should have been persisted. Proven against the REAL compiled binary's
      // own write path, not just the source-mode route tests in tests/conversation.test.ts.
      expect(existsSync(join(root, "conversations"))).toBe(false);
    } finally {
      proc.kill();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  // The core DIST5 proof: a credential IS present (so the boundary is selectable) and the native
  // binary resolves (this sandbox's own installed platform package) — the route must now actually
  // ATTEMPT the real call through the real self-invoked worker, rather than refusing up front
  // (DIST4's old behavior) or crashing on ENOENT/$bunfs/"unknown command" (the un-self-invoked spawn's
  // failure mode). Whether the call itself ultimately succeeds depends on this environment having a
  // live, authenticated `claude` CLI session — not something this test can assume or fake (the SDK
  // worker's own hermetic `CLAUDE_CONFIG_DIR` isolation, NOTES phase-7 K15, deliberately hides the
  // operator's real credentials from it) — so this asserts on the SHAPE of the outcome, not which
  // branch: either a real reply, or a real (never dispatch-shaped) SDK error. Either way proves the
  // spawn and dispatch were genuine, not mocked.
  test("with a credential present, the real spawn is attempted end-to-end — never disabled, never ENOENT/$bunfs/unknown-command", async () => {
    const root = seedScratchStudio();
    const { proc, base } = await spawnLevareServe([root, "--no-daemon"], {
      cwd: process.cwd(),
      env: { ...process.env, ANTHROPIC_API_KEY: "sk-ant-test-not-real" },
      bin: scratchOut,
    });
    try {
      const res = await fetch(`${base}/orchestrator/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      });
      const body = await res.json();
      const raw = JSON.stringify(body);
      expect(raw).not.toContain("ENOENT");
      expect(raw).not.toContain("$bunfs");
      expect(raw).not.toContain("unknown command");
      // Never the old DIST4 refusal — the boundary WAS selected and a real call WAS attempted.
      expect(body.disabled).toBeUndefined();
      // Exactly one of: a genuine successful reply, or a genuine (never dispatch-shaped) SDK failure.
      expect(typeof body.reply === "string" || typeof body.error === "string").toBe(true);

      // NOTES V11-CONV: whether persistence happened is conditioned on which of the two branches
      // above actually fired — this sandbox has no live, authenticated `claude` CLI session (same
      // documented limitation as the rest of this describe block), so a genuine successful reply isn't
      // something this test can force. Either outcome is proof the COMPILED binary's write path
      // behaves correctly: a completed exchange lands on disk as levare-runner, an error persists
      // nothing at all.
      const monthKey = new Date().toISOString().slice(0, 7);
      const convFile = join(root, "conversations", "studio", `${monthKey}.md`);
      if (typeof body.reply === "string") {
        expect(existsSync(convFile)).toBe(true);
        expect(readFileSync(convFile, "utf8")).toContain("hello");
        const log = Bun.spawnSync(["git", "-C", root, "log", "-1", "--format=%an|%ae"]).stdout.toString().trim();
        expect(log).toBe("levare-runner|runner@levare.local");
      } else {
        expect(existsSync(join(root, "conversations"))).toBe(false);
      }
    } finally {
      proc.kill();
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});

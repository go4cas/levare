import { test, expect, describe, afterAll } from "bun:test";
import { readFileSync, rmSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnLevareServe, COMPILED_BINARY_BIND_TIMEOUT_MS } from "./serve-subprocess.ts";
import { assertExitCode, spawnStdout } from "./spawn-helpers.ts";
import { DEFAULT_INTERPRET_TIMEOUT_MS } from "../src/orchestrator-boundary.ts";

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
  assertExitCode("scripts/build.sh", p, 0);
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
  test("`<compiled> doctor` reports the prompt readable, byte-for-byte identical to docs/orchestrator-prompt.md, and 'on' even with no credential (Finding 149)", () => {
    const onDisk = readFileSync("docs/orchestrator-prompt.md", "utf8");
    const expectedBytes = Buffer.byteLength(onDisk, "utf8");

    const p = Bun.spawnSync([scratchOut, "doctor", "fixtures/golden"], { env: { ...process.env, ANTHROPIC_API_KEY: "" } });
    assertExitCode("<compiled> doctor fixtures/golden (no credential)", p, 0);
    const out = p.stdout.toString();

    expect(out).toContain("run mode: compiled");
    expect(out).toContain(`orchestrator prompt: readable (${expectedBytes} bytes)`);
    expect(out).not.toContain("ENOENT");
    // Finding 149: a missing ANTHROPIC_API_KEY no longer reports "off" at all — a subscription
    // session (macOS Keychain, or a Linux OAuth credentials file) authenticates identically and
    // leaves no env var to check locally, so credential presence is no longer a local precondition;
    // only a genuinely unresolvable native binary is. This scratch binary DOES embed one for this
    // host platform, so "on" here is the fix working, not a stale assertion.
    expect(out).toContain("orchestrator: on");
    expect(out).not.toContain("compiled binary");
  });

  // NOTES DIST5: the whole point of the fix — a compiled binary with a credential present now
  // reports "on", exactly like a source run does. Under DIST4 this always said "off" regardless.
  test("`<compiled> doctor` reports 'orchestrator: on' when a credential is present", () => {
    const p = Bun.spawnSync([scratchOut, "doctor", "fixtures/golden"], { env: { ...process.env, ANTHROPIC_API_KEY: "sk-ant-test-not-real" } });
    assertExitCode("<compiled> doctor fixtures/golden (with credential)", p, 0);
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
    assertExitCode("<compiled> __worker", p, 0);
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
  // Finding 149: no credential at all no longer means disabled — a subscription session
  // authenticates identically to ANTHROPIC_API_KEY but leaves no env var to detect, so credential
  // presence no longer gates boundary selection (sdk-transport.ts#checkSdkPreconditions). This
  // scratch binary embeds a real native SDK asset for this host platform, so the route now proceeds
  // to a REAL call attempt — same shape as the "with a credential present" test below (this sandbox
  // has no live, authenticated `claude` CLI session either way, so a genuine successful reply isn't
  // something either test can force; the point is that a call is genuinely ATTEMPTED, never refused
  // up front for lack of an env var).
  test("with no credential at all, the real spawn is still attempted end-to-end — never disabled for lack of ANTHROPIC_API_KEY", async () => {
    const root = seedScratchStudio();
    // NOTES DIST5-HANG-2 (readBoundPort cold-start flake): `spawnLevareServe`'s own bound-port wait
    // must use `COMPILED_BINARY_BIND_TIMEOUT_MS`, not the source-shim-sized default, because `bin`
    // below is a freshly `bun build --compile`d binary — see serve-subprocess.ts's own comment on that
    // constant for why. This test's own outer Bun `test()` timeout (3rd arg) is derived from it, the
    // same rule DEFAULT_INTERPRET_TIMEOUT_MS's callers already follow: comfortably longer, never
    // shorter, with margin for the rest of the test's own work (the fetch call, assertions, cleanup).
    const { proc, base } = await spawnLevareServe([root, "--no-daemon"], {
      cwd: process.cwd(),
      env: { ...process.env, ANTHROPIC_API_KEY: "" },
      bin: scratchOut,
      timeoutMs: COMPILED_BINARY_BIND_TIMEOUT_MS,
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
      // Never the old refusal — the boundary WAS selected (no credential check blocks it any more)
      // and a real call WAS attempted.
      expect(body.disabled).toBeUndefined();
      // Exactly one of: a genuine successful reply, or a genuine (never dispatch-shaped) SDK failure
      // — this sandbox's real failure here is the SDK's own "Not logged in" (no session, no key).
      expect(typeof body.reply === "string" || typeof body.error === "string").toBe(true);

      // NOTES V11-CONV: whether persistence happened is conditioned on which of the two branches
      // above actually fired. Proven against the REAL compiled binary's own write path, not just the
      // source-mode route tests in tests/conversation.test.ts.
      const monthKey = new Date().toISOString().slice(0, 7);
      const convFile = join(root, "conversations", "studio", `${monthKey}.md`);
      if (typeof body.reply === "string") {
        expect(existsSync(convFile)).toBe(true);
      } else {
        expect(existsSync(join(root, "conversations"))).toBe(false);
      }
    } finally {
      proc.kill();
      rmSync(root, { recursive: true, force: true });
    }
    // Comfortably longer than `COMPILED_BINARY_BIND_TIMEOUT_MS + DEFAULT_INTERPRET_TIMEOUT_MS` — same
    // reasoning as the "with a credential present" test below, since this now drives the identical
    // real-call code path.
  }, COMPILED_BINARY_BIND_TIMEOUT_MS + DEFAULT_INTERPRET_TIMEOUT_MS + 15_000);

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
  //
  // NOTES DIST5-HANG: the fake credential used below (`sk-ant-test-not-real`) makes `POST
  // /orchestrator/message`'s FIRST boundary call, `interpret()`, always fail (the CLI reports "Not
  // logged in", or times out) — `orchestrator.ts#handle` never reaches `narrate()`/`converse()` for a
  // call that never got a valid classification back (it `await`s `interpret()` directly and a throw
  // there exits `handle()` immediately, before either later call). So the one internal bound this test
  // must out-wait is `interpret()`'s own transport timeout, `orchestrator-boundary.ts`'s
  // `DEFAULT_INTERPRET_TIMEOUT_MS` (45s) — proven to reliably kill its whole process tree and return a
  // named error within that bound by `tests/sdk-transport-hermetic.test.ts`'s hung-worker tests, so this
  // is a real, working bound, not a hopeful one. This test's own Bun `test()` timeout (the 3rd argument
  // below) MUST stay comfortably longer than that bound, never shorter — the exact rule
  // `orchestrator-boundary.ts`'s own comment on `timeoutMs` already states for every OTHER caller of
  // this boundary, just not previously audited for THIS one. Before this fix it was a flat `20_000` —
  // shorter than the 45s bound the real call path it drives is entitled to use — so IF the real call ever
  // needs somewhere between 20s and 45s, Bun's own test-runner would kill the test first, at exactly its
  // own declared bound, never letting `interpret()`'s already-working internal timeout-and-report actually
  // fire. That is the "hangs at exactly 20000ms, never varying" signature this investigation was opened to
  // explain — the harness's `proc.kill()` in `finally` then only reaches the direct `levare serve` child,
  // never the detached, still-running worker+CLI process group `interpret()`'s own timer would have
  // reaped had it been given the chance to fire, which matches the "killed 1 dangling process" teardown
  // report every failing run left behind. NOTES DIST5-HANG is explicit that WHY a real call took 20-45s
  // on the affected hosts is still open, not established here: direct, instrumented measurement on this
  // container (a real worker call against this same fake credential, both the source and compiled-binary
  // self-invocation paths, and the native CLI's own `--debug` log) consistently completed in under 1.1s
  // with zero SDK retries and zero real network round trip (`duration_api_ms: 0` — this literal key is
  // rejected locally, before any request is built) — so the specific "SDK retry-storm on this fake key"
  // explanation is refuted for the currently-pinned SDK version, not confirmed. This fix is justified
  // independent of that open question: a test's own outer bound must never be shorter than a bound the
  // code it drives is contractually allowed to use, regardless of whether this literal run ever exercises
  // the slow path — and `sdk-worker.ts` now logs every SDK-reported retry plus real elapsed time
  // unconditionally, so if/when a real host DOES take 20-45s, the reason is in stderr, not re-derived.
  test("with a credential present, the real spawn is attempted end-to-end — never disabled, never ENOENT/$bunfs/unknown-command", async () => {
    const root = seedScratchStudio();
    // NOTES DIST5-HANG-2: see the sibling test's identical comment — `timeoutMs` must be
    // `COMPILED_BINARY_BIND_TIMEOUT_MS` here too, since this also spawns the freshly-compiled
    // `scratchOut` binary, not the fast source shim.
    const { proc, base } = await spawnLevareServe([root, "--no-daemon"], {
      cwd: process.cwd(),
      env: { ...process.env, ANTHROPIC_API_KEY: "sk-ant-test-not-real" },
      bin: scratchOut,
      timeoutMs: COMPILED_BINARY_BIND_TIMEOUT_MS,
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
        const log = spawnStdout("git log -1", Bun.spawnSync(["git", "-C", root, "log", "-1", "--format=%an|%ae"])).trim();
        expect(log).toBe("levare-runner|runner@levare.local");
      } else {
        expect(existsSync(join(root, "conversations"))).toBe(false);
      }
    } finally {
      proc.kill();
      rmSync(root, { recursive: true, force: true });
    }
    // Comfortably longer than `COMPILED_BINARY_BIND_TIMEOUT_MS + DEFAULT_INTERPRET_TIMEOUT_MS` — the
    // two bounds this test's own call chain is entitled to use IN SEQUENCE (readBoundPort's own wait,
    // then `interpret()`'s own timeout-and-report) — plus margin for the HTTP round trip and
    // assertions, never the reverse (see this test's own comment above, and orchestrator-boundary.ts's
    // identical rule for every other caller of that boundary).
  }, COMPILED_BINARY_BIND_TIMEOUT_MS + DEFAULT_INTERPRET_TIMEOUT_MS + 15_000);
});

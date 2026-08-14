import { test, expect, describe } from "bun:test";
import { readBoundPort } from "./serve-subprocess.ts";

// NOTES DIST5-HANG-2: `readBoundPort`'s own bound-port wait, used by every `spawnLevareServe` caller,
// intermittently killed a still-healthy (never hung, never crashed) `levare serve` process — a
// freshly `bun build --compile`d binary's real, one-time cold-start cost sometimes exceeding the old
// flat 10s default, most acutely under this project's own memory-constrained (2.8GB) container. That
// is the exact DIST5-HANG shape: a wait whose bound is shorter than the operation it drives is
// legitimately allowed to take. Reproducing the real container-timing variance on demand isn't
// possible (it depends on host memory/scheduling state at the moment of the run, not on anything this
// test controls) — so instead this drives `readBoundPort` directly against a FAKE subprocess with a
// deterministic, controlled delay, at a scaled-down timeout. The mechanism under test — "a bound that
// is shorter than a real, still-healthy delay kills the wait; a bound that is longer accommodates the
// identical delay" — is timeout-scale-invariant, so proving it at hundreds of milliseconds proves the
// same defect-and-fix shape production's 10s/30s bounds encode, without spending 30 real seconds per
// run.

/** A fake `levare serve` subprocess: sleeps `delayMs`, then prints a bound-port log line matching
 * `runServeCmd`'s real shape, exactly like a real cold-starting compiled binary eventually would. */
function fakeSlowServe(delayMs: number, port: number): Bun.Subprocess<"ignore", "pipe", "pipe"> {
  return Bun.spawn(["bash", "-c", `sleep ${delayMs / 1000}; echo "levare serve · /scratch → http://localhost:${port} (read-only) · daemon: off"`], {
    stdout: "pipe",
    stderr: "pipe",
  });
}

/** A fake subprocess that exits immediately WITHOUT ever printing a bound-port line — the genuinely
 * unhealthy case `readBoundPort`'s diagnostic must tell apart from "still running, just slow". */
function fakeDeadServe(exitCode: number): Bun.Subprocess<"ignore", "pipe", "pipe"> {
  return Bun.spawn(["bash", "-c", `exit ${exitCode}`], { stdout: "pipe", stderr: "pipe" });
}

describe("readBoundPort — the DIST5-HANG-2 fix", () => {
  test("resolves the real bound port once the process prints its log line, well before the deadline", async () => {
    const proc = fakeSlowServe(50, 12345);
    const port = await readBoundPort(proc, 2000, "fakebin");
    expect(port).toBe(12345);
    proc.kill();
  });

  test("a process that is still healthy — just slower than a too-tight bound — is killed by that bound, and the error says so, not a bare timeout", async () => {
    const proc = fakeSlowServe(600, 22222);
    try {
      await expect(readBoundPort(proc, 200, "fakebin")).rejects.toThrow(/still running — healthy but slow, not hung or crashed/);
    } finally {
      proc.kill();
    }
  });

  test("THE FIX, proven by construction: the identical slow-but-healthy delay that fails a tight bound succeeds once the bound is widened past it — no run-to-run luck involved", async () => {
    const delayMs = 600;
    // Old-shaped bound: shorter than the real delay — fails every time, deterministically (not a
    // flake that happens to reproduce — this IS the failure mode, forced).
    const tooTight = fakeSlowServe(delayMs, 33333);
    let tightFailed = false;
    try {
      await readBoundPort(tooTight, 200, "fakebin");
    } catch {
      tightFailed = true;
    } finally {
      tooTight.kill();
    }
    expect(tightFailed).toBe(true);

    // Fixed-shaped bound: comfortably longer than the same real delay — succeeds every time,
    // deterministically. Same mechanism as COMPILED_BINARY_BIND_TIMEOUT_MS (30s) vs a real cold start
    // observed up to ~20001ms: a bound with real margin above the worst legitimate duration.
    const widened = fakeSlowServe(delayMs, 33333);
    try {
      const port = await readBoundPort(widened, 2000, "fakebin");
      expect(port).toBe(33333);
    } finally {
      widened.kill();
    }
  });

  test("a process that actually exited is reported as exited, with its code — never conflated with 'still running'", async () => {
    const proc = fakeDeadServe(3);
    // `proc.exitCode` is populated asynchronously — Bun's own reaping, not synchronous with the OS
    // process actually exiting (confirmed directly: immediately after spawn it reads `null` even for
    // an instant `exit 3`). Await the subprocess's own `exited` promise first so this test asserts a
    // real, settled state rather than racing Bun's reaping against readBoundPort's deadline.
    await proc.exited;
    await expect(readBoundPort(proc, 300, "fakebin")).rejects.toThrow(/process already exited \(code 3\)/);
  });
});

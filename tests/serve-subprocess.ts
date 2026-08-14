// Shared helper for tests that boot a REAL `levare serve` binary as a subprocess — the source shim
// (`./levare`) or a compiled `bun build --compile` output (e.g. orchestrator-compiled-smoke's
// scratch binary), both accept the identical CLI flags. Every such test used to pass a "spread but
// still fixed" `--port` (a base + process.pid % 400, e.g. 4100-4499, or 41000-41999) — a range that
// can still collide with the CLI's own hardcoded default port (4173, cli.ts's `runServeCmd`) or with
// another such test's range, so a `levare serve` already running on the machine (normal during a UI
// review) makes whichever subprocess-booting test races to that port fail spuriously. The fix: always
// bind an OS-assigned ephemeral port (`--port 0`) and read back the actual bound port from the
// process's own startup log line (`runServeCmd`'s `console.log`), rather than betting on any port
// number chosen ahead of time.

/** Default bound-port wait — see `readBoundPort`'s own comment for why this rarely needs to be
 * large: a real bind normally completes in well under a second, on either the source shim or a
 * compiled binary. */
export const DEFAULT_BOUND_PORT_TIMEOUT_MS = 10_000;

// A freshly `bun build --compile`d binary's FIRST `serve` invocation pays a real one-time cost (disk
// write, OS file-cache cold, whatever `bun build --compile`'s own runtime does on first exec) that a
// source-mode `./levare` spawn never pays, and this project's own container is memory-constrained
// (2.8GB, already swapping under load) — direct measurement (this round) put a fresh binary's own
// bind time anywhere from ~35ms to ~250ms across repeated builds, comfortably under
// `DEFAULT_BOUND_PORT_TIMEOUT_MS` on its own. This wider bound exists as defense in depth for a
// genuinely slower real host under full-suite contention, not because 10s was ever established to be
// too tight for the compiled-binary case specifically — see NOTES DIST5-HANG-2 for what the readback
// flake actually was (a bug in this file's own read loop, fixed below), which is the thing that made
// 10s look too tight in the first place.
export const COMPILED_BINARY_BIND_TIMEOUT_MS = 30_000;

/** Spawn `<bin> serve <...args> --port 0` and resolve once its actual bound port is known. */
export async function spawnLevareServe(
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; bin?: string },
): Promise<{ proc: Bun.Subprocess<"ignore", "pipe", "pipe">; port: number; base: string }> {
  const bin = opts.bin ?? "./levare";
  const proc = Bun.spawn([bin, "serve", ...args, "--port", "0"], {
    cwd: opts.cwd,
    env: opts.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const port = await readBoundPort(proc, opts.timeoutMs ?? DEFAULT_BOUND_PORT_TIMEOUT_MS, bin);
  return { proc, port, base: `http://localhost:${port}` };
}

// `runServeCmd` logs `levare serve · <root> → http://localhost:<port> ...` exactly once, after
// `Bun.serve` has already bound (Bun.serve resolves the actual port synchronously) — so the port in
// that line is real and already listening by the time it appears.
//
// NOTES DIST5-HANG-2: this loop used to issue a FRESH `reader.read()` every ~200ms tick, racing it
// against a timer to keep checking the deadline — but `Promise.race`'s losing promise is not
// cancelled, so once the log line took more than one tick to appear, the loop had TWO (or more)
// concurrent `read()` calls outstanding on the same reader. When the process finally wrote its line,
// the Streams spec resolves queued reads in FIFO order: an earlier, already-abandoned tick's `read()`
// silently consumed the real chunk, and the CURRENT iteration's own `read()` — the one actually being
// awaited — saw the stream already drained, later reporting `done: true` with no value once the
// process exited. The loop then spun to the deadline and failed, no matter how long that deadline
// was: NOT a cold-start-duration problem (widening the timeout never fixes a bug that discards the
// data), and reproduced deterministically at ANY delay past ~200ms (tests/serve-subprocess.test.ts),
// not intermittently — the "roughly 1 in 7" real-world rate is just how often a real bind happened to
// cross that one 200ms boundary. The fix: keep exactly ONE outstanding `read()` at a time, reusing it
// across ticks that lose the race instead of issuing a new one, so no chunk is ever handed to a
// promise nothing is still listening to.
//
// Exported (not just used internally) so a test can drive it directly against a fake, deliberately
// slow/dead process — see tests/serve-subprocess.test.ts — rather than only proving it indirectly
// through a real compiled binary's own non-deterministic cold-start timing.
export async function readBoundPort(proc: Bun.Subprocess<"ignore", "pipe", "pipe">, timeoutMs: number, bin: string): Promise<number> {
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const start = performance.now();
  const deadline = Date.now() + timeoutMs;
  // `pendingOutcome` memoizes the wrapped form of `pendingRead` too — not just the base `read()` call
  // — so a tick that loses the race reuses the exact same promise next iteration rather than wrapping
  // a fresh `.then()` around it each time (which would itself pile up abandoned intermediate promises).
  let pendingRead: ReturnType<typeof reader.read> | null = null;
  let pendingOutcome: ReturnType<typeof wrapRead> | null = null;
  function wrapRead(p: NonNullable<typeof pendingRead>) {
    return p.then((r) => ({ tag: "read" as const, r }));
  }
  try {
    while (Date.now() < deadline) {
      if (!pendingRead) {
        pendingRead = reader.read();
        pendingOutcome = wrapRead(pendingRead);
      }
      const outcome = await Promise.race([
        pendingOutcome!,
        new Promise<{ tag: "tick" }>((resolve) =>
          setTimeout(() => resolve({ tag: "tick" }), Math.max(1, Math.min(200, deadline - Date.now()))),
        ),
      ]);
      if (outcome.tag === "tick") continue; // pendingRead/pendingOutcome stay outstanding — reused next iteration, never abandoned
      pendingRead = null;
      pendingOutcome = null;
      const { value, done } = outcome.r;
      if (value) buf += decoder.decode(value, { stream: true });
      const m = buf.match(/https?:\/\/localhost:(\d+)/);
      if (m) {
        // The DIST5/DIST5-HANG-established practice: a constraint-dependent wait surfaces which side
        // of its own bound it actually ran on, every run, not only on failure — so a slow-but-healthy
        // run leaves a real number in the log instead of a silent "3 pass".
        console.log(`[serve-subprocess] ${bin} serve bound port ${m[1]} in ${Math.round(performance.now() - start)}ms (bound ${timeoutMs}ms)`);
        return Number(m[1]);
      }
      if (done) break;
    }
  } finally {
    // `releaseLock()` rejects a still-outstanding `read()` (AbortError) — expected whenever the
    // deadline is hit mid-read; swallow it here so it's never reported as an unhandled rejection.
    if (pendingOutcome) pendingOutcome.catch(() => {});
    reader.releaseLock();
  }
  // A timeout here answers a genuinely different question depending on which side of it the process
  // is actually on: `exitCode === null` means the process is still alive — slow, but never established
  // to be unhealthy — while a non-null code means it actually died. Collapsing both into "did not
  // print its bound port" (the old message) is exactly the failure this project has already hit
  // multiple times (NOTES DIST7/ORCH-B-DATE-FLAKE/DIST5-HANG-2): a bare timeout that never says which
  // side of the constraint it ran on.
  const alive = proc.exitCode === null && !proc.killed;
  const status = alive ? "process is still running — healthy but slow, not hung or crashed" : `process already exited (code ${proc.exitCode})`;
  throw new Error(`${bin} serve did not print its bound port within ${timeoutMs}ms (${status}); stdout so far: ${buf}`);
}

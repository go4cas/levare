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
  const port = await readBoundPort(proc, opts.timeoutMs ?? 10_000, bin);
  return { proc, port, base: `http://localhost:${port}` };
}

// `runServeCmd` logs `levare serve · <root> → http://localhost:<port> ...` exactly once, after
// `Bun.serve` has already bound (Bun.serve resolves the actual port synchronously) — so the port in
// that line is real and already listening by the time it appears.
async function readBoundPort(proc: Bun.Subprocess<"ignore", "pipe", "pipe">, timeoutMs: number, bin: string): Promise<number> {
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const slice = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: false }>((resolve) =>
          setTimeout(() => resolve({ value: undefined, done: false }), Math.max(1, Math.min(200, deadline - Date.now()))),
        ),
      ]);
      if (slice.value) buf += decoder.decode(slice.value, { stream: true });
      const m = buf.match(/https?:\/\/localhost:(\d+)/);
      if (m) return Number(m[1]);
      if (slice.done) break;
    }
  } finally {
    reader.releaseLock();
  }
  throw new Error(`${bin} serve did not print its bound port within ${timeoutMs}ms; stdout so far: ${buf}`);
}

// A failing assertion on a spawned process's exit status is only as useful as what it reports.
// `expect(result.status).toBe(0)` on failure says "expected 0, got 128" and throws away everything
// the process itself said about why — the same defect `tests/guide-workflow-blocks.test.ts`'s clone
// assertion and `tests/daemon.test.ts`'s `commitAuthor` read-back had before both were fixed by hand.
// These three helpers are the shared fix: every remaining subprocess-status assertion in the suite
// (both `node:child_process#spawnSync` and `Bun.spawnSync` results) reports exit status, signal (if
// any), and stderr on failure — without re-running anything to find out why.

type SpawnLike = {
  status?: number | null;
  exitCode?: number | null;
  signal?: string | null;
  signalCode?: string | null;
  stderr?: string | Buffer | null;
  stdout?: string | Buffer | null;
};

function toText(v: string | Buffer | null | undefined): string {
  if (v == null) return "";
  return typeof v === "string" ? v : v.toString();
}

/** The exit code, whichever field this result shape carries it under. `null` means killed by signal. */
function exitCodeOf(r: SpawnLike): number | null {
  return r.status !== undefined ? r.status : (r.exitCode ?? null);
}

function signalOf(r: SpawnLike): string | null {
  return r.signal ?? r.signalCode ?? null;
}

/** `<command> exited <status> (signal <sig>): <stderr>` — everything needed to diagnose a failed spawn. */
export function describeSpawnFailure(command: string, r: SpawnLike): string {
  const signal = signalOf(r);
  const stderr = toText(r.stderr);
  return `${command} exited ${exitCodeOf(r) ?? "null"}${signal ? ` (signal ${signal})` : ""}: ${stderr || "(no stderr captured)"}`;
}

/** Throws a diagnostic error (status, signal, stderr) if `r`'s exit code isn't 0. */
export function assertSpawnOk(command: string, r: SpawnLike): void {
  if (exitCodeOf(r) !== 0) throw new Error(describeSpawnFailure(command, r));
}

/** Throws a diagnostic error (status, signal, stderr) if `r`'s exit code isn't exactly `expected`. */
export function assertExitCode(command: string, r: SpawnLike, expected: number): void {
  if (exitCodeOf(r) !== expected) {
    throw new Error(`${describeSpawnFailure(command, r)} (expected ${expected})`);
  }
}

/** Throws if `r` unexpectedly exited 0 — for assertions expecting a real failure, not a specific code. */
export function assertSpawnFailed(command: string, r: SpawnLike): void {
  if (exitCodeOf(r) === 0) {
    const stdout = toText(r.stdout);
    throw new Error(`${command} exited 0 (expected non-zero)${stdout ? `: ${stdout}` : ""}`);
  }
}

/** Returns `r.stdout` as text, but only once confirming `r` actually succeeded — never a blind read. */
export function spawnStdout(command: string, r: SpawnLike): string {
  assertSpawnOk(command, r);
  return toText(r.stdout);
}

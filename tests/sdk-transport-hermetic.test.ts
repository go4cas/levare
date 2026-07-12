import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildQueryOptions } from "../src/sdk-worker.ts";
import { createAsyncSdkTransport, hermeticSpawnEnv, LEVARE_CLAUDE_CONFIG_DIR } from "../src/sdk-transport.ts";

// Phase-7 live-gate fix-up (NOTES K15): a real host hung indefinitely on every call because the
// spawned CLI inherited the operator's personal Claude Code configuration — a user-installed
// SessionEnd hook that never completed in a TTY-less spawned subprocess — and the transport's own
// timeout-kill didn't reach the resulting grandchild process, so Bun reported a dangling process at
// the outer 60s test timeout. This file proves both fixes directly.

// ---------------------------------------------------------------------------
// (1) The spawn is hermetic — no user hooks/plugins/settings, no session persistence
// ---------------------------------------------------------------------------

describe("the worker's query() call is hermetic — never inherits the operator's Claude Code config", () => {
  test("settingSources is empty (SDK isolation mode) and persistSession is false", () => {
    const opts = buildQueryOptions({ prompt: "hi" });
    // [] is the SDK's own documented "isolation mode" — no ~/.claude/settings.json (user hooks/
    // plugins), no .claude/settings.json (project), no .claude/settings.local.json (local) are ever
    // loaded, so a hook like the one that hung the live host has nothing to fire from.
    expect(opts.settingSources).toEqual([]);
    // No session transcript is written to ~/.claude/projects/ — nothing this hermetic call does
    // touches the operator's real, persistent Claude Code state.
    expect(opts.persistSession).toBe(false);
  });

  test("an explicit pathToClaudeCodeExecutable and other request fields still pass through unchanged", () => {
    const opts = buildQueryOptions({ prompt: "hi", model: "claude-sonnet-5", pathToClaudeCodeExecutable: "/resolved/claude", tools: ["Read"] });
    expect(opts.model).toBe("claude-sonnet-5");
    expect(opts.pathToClaudeCodeExecutable).toBe("/resolved/claude");
    expect(opts.tools).toEqual(["Read"]);
    // Hermetic isolation doesn't touch tool/permission behavior — bypassPermissions is unrelated to
    // settingSources and must still be set so a member/orchestrator call never blocks on approval.
    expect(opts.permissionMode).toBe("bypassPermissions");
    expect(opts.allowDangerouslySkipPermissions).toBe(true);
  });

  test("hermeticSpawnEnv fills in an isolated CLAUDE_CONFIG_DIR, never the operator's real one", () => {
    const env = hermeticSpawnEnv({ PATH: "/bin" });
    expect(env.CLAUDE_CONFIG_DIR).toBe(LEVARE_CLAUDE_CONFIG_DIR);
    // Never accidentally the operator's real HOME-relative config dir.
    expect(env.CLAUDE_CONFIG_DIR).not.toContain(process.env.HOME ?? "\0impossible\0");
  });

  test("hermeticSpawnEnv never overrides an explicitly-set CLAUDE_CONFIG_DIR", () => {
    const env = hermeticSpawnEnv({ PATH: "/bin", CLAUDE_CONFIG_DIR: "/explicit/scratch" });
    expect(env.CLAUDE_CONFIG_DIR).toBe("/explicit/scratch");
  });
});

// ---------------------------------------------------------------------------
// (2) A hung transport kills the WHOLE process tree and leaves nothing dangling
// ---------------------------------------------------------------------------

function writeHangingWorkerWithStubbornGrandchild(dir: string): { workerPath: string; pidFile: string } {
  // Reproduces the confirmed live shape: the worker spawns a grandchild (standing in for the CLI's
  // own SessionEnd-hook child) that explicitly ignores SIGTERM — exactly the process a plain
  // `proc.kill()` (SIGTERM to the direct child only) cannot reach — then the worker itself also hangs
  // forever, exactly like the real, unresponsive CLI process did.
  const pidFile = join(dir, "grandchild.pid");
  const grandchildPath = join(dir, "grandchild.ts");
  const workerPath = join(dir, "hanging-worker.ts");
  writeFileSync(
    grandchildPath,
    [
      `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      `process.on("SIGTERM", () => {});`, // ignore SIGTERM, like the real hook did
      `setInterval(() => {}, 1000);`,
    ].join("\n"),
  );
  writeFileSync(
    workerPath,
    [
      `await Bun.stdin.text();`,
      `Bun.spawn([process.execPath, ${JSON.stringify(grandchildPath)}], { stdout: "ignore", stderr: "ignore" });`,
      `await new Promise(() => {});`, // the worker itself also never exits, like the real hang
    ].join("\n"),
  );
  return { workerPath, pidFile };
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0: existence check only, sends nothing
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return predicate();
}

describe("a hung worker (with a hanging grandchild) is fully reaped on timeout", () => {
  test("the transport returns a timeout error within its own timeout, and NO process survives — not the worker, not its grandchild", async () => {
    const dir = mkdtempSync(join(tmpdir(), "levare-hang-tree-"));
    try {
      const { workerPath, pidFile } = writeHangingWorkerWithStubbornGrandchild(dir);
      const transport = createAsyncSdkTransport(workerPath);

      const start = Date.now();
      const timeoutMs = 500;
      const res = await transport.run({ prompt: "hi" }, { env: {}, timeoutMs });
      const elapsed = Date.now() - start;

      // Returns within (a small margin over) its own configured timeout — never left pending, and
      // never anywhere near a caller's much longer outer timeout (the original bug: the transport's
      // internal kill never fired before a 60s outer test timeout did).
      expect(elapsed).toBeLessThan(timeoutMs + 1500);
      expect(res).toEqual({ ok: false, error: `sdk worker timed out after ${timeoutMs}ms` });

      // The grandchild must have gotten far enough to record its own PID before the tree was killed —
      // wait briefly for that file to appear (spawn + one writeFileSync, well under our margin).
      const pidFileAppeared = await waitFor(() => existsSync(pidFile), 2000);
      expect(pidFileAppeared).toBe(true);
      const grandchildPid = Number(readFileSync(pidFile, "utf8"));

      // The actual assertion: the grandchild — which ignores plain SIGTERM — must be genuinely gone,
      // not merely disowned/orphaned. Poll briefly since the kill and this check are not perfectly
      // synchronous with OS-level process teardown.
      const reaped = await waitFor(() => !pidIsAlive(grandchildPid), 2000);
      expect(reaped).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

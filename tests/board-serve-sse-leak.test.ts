import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBoard, debugSubscriberCount } from "../src/board/serve.ts";
import { spawnLevareServe } from "./serve-subprocess.ts";

// BLOCKING stability bug: every `/events` connection called `subscribe()`, captured the returned
// `unsubscribe`, and then discarded it (`void unsubscribe`) — a navigated-away or closed client's
// Sender was NEVER removed from the board's subscriber set. Live, this was observed as the server
// process's own open file descriptor count climbing with every page navigation (each page load opens
// a fresh EventSource) until the OS's per-process handle limit was exhausted and the server stopped
// responding — exactly "something goes wrong after a few navigations, I constantly restart the
// server". The fs.watch handle itself was already correct — ONE watcher per board, created once at
// startup and shared by every subscriber — the defect was purely in never releasing a disconnected
// client's registration.
//
// Two tests, deliberately different in kind:
//  - the first is IN-PROCESS and deterministic: it asserts the subscriber SET itself returns to
//    empty after a churn of connect/cancel cycles. This is the one that actually discriminates a
//    fixed board from a broken one — a broadcast-still-reaches-a-fresh-client check alone would pass
//    either way, because a dead subscriber's `send` just throws-and-is-caught silently, whether or
//    not it was ever removed (verified directly: this test fails against the pre-fix code, see NOTES).
//  - the second spawns the REAL `./levare serve` subprocess (the literal scenario reported) and reads
//    its own /proc/<pid>/fd count as a real-environment sanity check.

const REPO_ROOT = join(import.meta.dir, "..");

const HERMETIC_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

function git(repoRoot: string, args: string[]): void {
  const r = spawnSync(
    "git",
    ["-C", repoRoot, "-c", "user.name=seed", "-c", "user.email=seed@levare.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "init.defaultBranch=main", ...args],
    { encoding: "utf8", env: HERMETIC_ENV },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}${r.stdout}`);
}

function seedScratchRepo(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  cpSync(join(REPO_ROOT, "fixtures/golden"), root, { recursive: true });
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "seed golden fixture"]);
  return root;
}

function req(url: string, init?: RequestInit): Request {
  return new Request(`http://localhost${url}`, init);
}

async function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(message)), ms))]);
}

describe("SSE subscriber cleanup — the leak must be provably gone, not just smaller", () => {
  test("50 connect/cancel cycles leave zero live subscribers, and a fresh client still gets a broadcast", async () => {
    const root = seedScratchRepo("levare-sse-leak-inproc-");
    const board = createBoard(root);
    try {
      expect(debugSubscriberCount(board.ctx)).toBe(0);

      const N = 50;
      for (let i = 0; i < N; i++) {
        const res = await board.fetch(req("/events"));
        const reader = res.body!.getReader();
        await reader.read(); // drain ": connected" — proves the subscription genuinely registered
        await reader.cancel(); // simulate the client disconnecting (browser tab navigated away)
      }

      // The actual proof: the subscriber set is empty again, not merely "small" or "still works".
      expect(debugSubscriberCount(board.ctx)).toBe(0);

      // And the shared broadcast mechanism still functions for a brand new connection after all that
      // churn — the cleanup path must never have torn down more than just the disconnected entries.
      const res = await board.fetch(req("/events"));
      const reader = res.body!.getReader();
      await reader.read(); // drain ": connected"
      expect(debugSubscriberCount(board.ctx)).toBe(1);

      board.ctx.broadcast("reload");
      const { value } = await withTimeout(reader.read(), 2000, "broadcast never reached the fresh connection");
      expect(new TextDecoder().decode(value)).toContain("data: reload");
      await reader.cancel();
      expect(debugSubscriberCount(board.ctx)).toBe(0);
    } finally {
      board.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an abandoned connection (never explicitly cancelled by the test, only aborted via req.signal) is still cleaned up", async () => {
    const root = seedScratchRepo("levare-sse-leak-abort-");
    const board = createBoard(root);
    try {
      const controller = new AbortController();
      const res = await board.fetch(req("/events", { signal: controller.signal }));
      const reader = res.body!.getReader();
      await reader.read();
      expect(debugSubscriberCount(board.ctx)).toBe(1);

      controller.abort();
      // The abort listener runs as a microtask/event off the signal, not synchronously with .abort().
      await new Promise((r) => setTimeout(r, 20));
      expect(debugSubscriberCount(board.ctx)).toBe(0);
    } finally {
      board.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("board.close() closes every still-open SSE stream, not just the watcher", async () => {
    const root = seedScratchRepo("levare-sse-leak-shutdown-");
    const board = createBoard(root);
    const res = await board.fetch(req("/events"));
    const reader = res.body!.getReader();
    await reader.read();
    expect(debugSubscriberCount(board.ctx)).toBe(1);

    board.close();
    expect(debugSubscriberCount(board.ctx)).toBe(0);

    // The stream itself was actually closed server-side (not just forgotten) — reading it again
    // resolves with done:true rather than hanging forever.
    const { done } = await withTimeout(reader.read(), 2000, "stream was not actually closed by board.close()");
    expect(done).toBe(true);

    rmSync(root, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Portable OS-level handle counting (gate-review fix). The original version of this check hardcoded
// `readdirSync('/proc/<pid>/fd')` — Linux-only; macOS has no /proc at all, so on darwin this didn't
// fail the leak assertion, it threw ENOENT before ever reaching it. That crash is itself proof the
// original failure mode was a test-portability bug, not evidence of a real leak: the three in-process
// tests above (subscriber-Set-to-zero, abandoned-connection cleanup, board.close()) are the actual
// proof the fix works, are pure JS with no OS branching, and pass identically on every platform —
// confirmed to still pass on darwin. This subprocess check is a real-environment sanity check on TOP
// of that proof, not a substitute for it; it must never crash on a platform it can't measure, and it
// must not assume a settled fd/handle count is byte-for-byte flat (closed sockets can legitimately
// linger — TIME_WAIT and platform-specific equivalents — for a moment after both peers have moved on,
// more visible through `lsof` on darwin than through /proc on linux).
// ---------------------------------------------------------------------------

type HandleMechanism = "procfs" | "lsof";

/** Which mechanism (if any) can count this process's open handles on the current platform. Computed
 * once, at module load — a pure environment probe, no side effects beyond a stat/PATH lookup. */
function detectHandleMechanism(): HandleMechanism | null {
  if (process.platform === "linux") {
    try {
      readdirSync(`/proc/${process.pid}/fd`);
      return "procfs";
    } catch {
      /* fall through — an unusual sandbox without /proc even on linux */
    }
  }
  if (Bun.which("lsof")) return "lsof";
  return null;
}

const HANDLE_MECHANISM = detectHandleMechanism();

function countOpenHandles(pid: number, mechanism: HandleMechanism): number {
  if (mechanism === "procfs") return readdirSync(`/proc/${pid}/fd`).length;
  // lsof exits 0 when it lists open files, 1 when it finds none for the target (rare but not an
  // error) — anything else (a bad flag, lsof itself missing despite the earlier probe, permission
  // trouble) is a real failure and must surface loudly rather than being silently read as "0 handles".
  const r = spawnSync("lsof", ["-p", String(pid)], { encoding: "utf8" });
  if (r.status !== 0 && r.status !== 1) throw new Error(`lsof -p ${pid} failed (status ${r.status}): ${r.stderr}`);
  const lines = r.stdout.split("\n").filter((l) => l.trim().length > 0);
  return Math.max(0, lines.length - 1); // minus the header row
}

/** The minimum of a few readings taken a short interval apart — absorbs a socket that hasn't finished
 * settling yet (TIME_WAIT and friends) without ever letting a genuinely growing count hide behind a
 * single lucky low sample (the MINIMUM of several samples can only ever UNDER-report a real leak). */
async function settledHandleCount(pid: number, mechanism: HandleMechanism, settleMs = 150, samples = 4): Promise<number> {
  let min = Infinity;
  for (let i = 0; i < samples; i++) {
    await new Promise((r) => setTimeout(r, settleMs));
    min = Math.min(min, countOpenHandles(pid, mechanism));
  }
  return min;
}

describe("SSE handle leak — real subprocess sanity check", () => {
  let root: string;
  let proc: ReturnType<typeof Bun.spawn>;
  let base: string;

  beforeAll(async () => {
    if (!HANDLE_MECHANISM) return; // nothing to spawn for — see the skipped test's own name for why.
    root = seedScratchRepo("levare-sse-leak-proc-");
    ({ proc, base } = await spawnLevareServe([root], { cwd: REPO_ROOT }));
    const deadline = Date.now() + 10_000;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${base}/`);
        await r.arrayBuffer();
        return;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new Error(`server never came up at ${base}/: ${lastErr}`);
  });

  afterAll(() => {
    if (!HANDLE_MECHANISM) return;
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already exited */
    }
    rmSync(root, { recursive: true, force: true });
  });

  // The test's own name carries the skip reason when there's no supported mechanism — never a silent
  // pass, never a crash: "skip cleanly with a clear message" per the gate review.
  const testName = HANDLE_MECHANISM
    ? `repeated SSE connect/disconnect cycles do not leak process handles (${HANDLE_MECHANISM}, monotonic-growth check)`
    : "repeated SSE connect/disconnect cycles do not leak process handles — SKIPPED: no /proc and no lsof on this platform";

  test.skipIf(!HANDLE_MECHANISM)(
    testName,
    async () => {
      const mechanism = HANDLE_MECHANISM!;
      const openAndAbort = async () => {
        const controller = new AbortController();
        const res = await fetch(`${base}/events`, { signal: controller.signal });
        const reader = res.body!.getReader();
        await reader.read(); // drain ": connected"
        controller.abort();
        try {
          await reader.cancel();
        } catch {
          /* already dead once aborted — expected */
        }
      };

      const ROUNDS = 5;
      const CYCLES_PER_ROUND = 20;

      await openAndAbort();
      await openAndAbort();
      const samples: number[] = [await settledHandleCount(proc.pid, mechanism)];

      for (let round = 0; round < ROUNDS; round++) {
        for (let i = 0; i < CYCLES_PER_ROUND; i++) await openAndAbort();
        samples.push(await settledHandleCount(proc.pid, mechanism));
      }
      console.log(`levare: SSE handle-count samples (${mechanism}, pid ${proc.pid}): ${samples.join(", ")}`);

      // A real per-connection leak (the literal shape of the original bug: one retained Set entry,
      // and whatever it holds onto, per never-cleaned-up connection) is MONOTONIC and scales with
      // total connections — every round's settled reading would be >= the previous one, drifting up
      // by roughly one handle per cycle, forever. Transient socket linger instead produces a bounded
      // wobble the settle window (settledHandleCount's own min-of-N) already absorbs; asserting
      // "never exceeds round 0's count" would be too strict on darwin, so the real assertion is that
      // the sequence does not exhibit sustained, leak-scale monotonic growth.
      const monotonic = samples.every((s, i) => i === 0 || s >= samples[i - 1]);
      const totalDrift = samples[samples.length - 1] - samples[0];
      const leakShaped = monotonic && totalDrift >= CYCLES_PER_ROUND; // ~1/cycle would clear this by ~20x
      expect(leakShaped).toBe(false);
      // Backstop regardless of the monotonicity pattern: generous slack, far short of "roughly one
      // handle leaked per connection cycle" across the whole run — not an exact-flat-number pin.
      expect(totalDrift).toBeLessThan(ROUNDS * CYCLES_PER_ROUND);

      // The shared watcher survives the churn: a fresh client still gets a real reload on a repo change.
      const finalRes = await fetch(`${base}/events`);
      const finalReader = finalRes.body!.getReader();
      await finalReader.read();
      const unitPath = join(root, "work/storefront/checkout-flow/unit.md");
      writeFileSync(unitPath, readFileSync(unitPath, "utf8") + "\n");
      const { value } = await withTimeout(finalReader.read(), 5000, "no SSE reload within 5s — the shared watcher did not survive the churn");
      expect(new TextDecoder().decode(value)).toContain("data: reload");
      await finalReader.cancel();
    },
    20_000,
  );
});

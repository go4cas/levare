import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBoard, debugSubscriberCount } from "../src/board/serve.ts";

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

describe("SSE handle leak — real subprocess sanity check", () => {
  let root: string;
  let proc: ReturnType<typeof Bun.spawn>;
  const PORT = 4500 + (process.pid % 400);
  const base = `http://localhost:${PORT}`;

  beforeAll(async () => {
    root = seedScratchRepo("levare-sse-leak-proc-");
    proc = Bun.spawn(["./levare", "serve", root, "--port", String(PORT)], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
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
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already exited */
    }
    rmSync(root, { recursive: true, force: true });
  });

  test("50 SSE connect/disconnect cycles over real sockets leave the process's fd count flat", async () => {
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
    const fdCount = () => readdirSync(`/proc/${proc.pid}/fd`).length;

    await openAndAbort();
    await openAndAbort();
    await new Promise((r) => setTimeout(r, 200));
    const baseline = fdCount();

    for (let i = 0; i < 50; i++) await openAndAbort();
    await new Promise((r) => setTimeout(r, 500));

    // Generous slack — this check's job is to catch a leak that SCALES with connection count (the
    // literal defect: ~1 handle per connection), not to pin an exact number; the in-process tests
    // above are what actually prove the subscriber-set cleanup itself.
    expect(fdCount()).toBeLessThan(baseline + 20);

    // The shared watcher survives the churn: a fresh client still gets a real reload on a repo change.
    const finalRes = await fetch(`${base}/events`);
    const finalReader = finalRes.body!.getReader();
    await finalReader.read();
    const unitPath = join(root, "work/storefront/checkout-flow/unit.md");
    writeFileSync(unitPath, readFileSync(unitPath, "utf8") + "\n");
    const { value } = await withTimeout(finalReader.read(), 5000, "no SSE reload within 5s — the shared watcher did not survive the churn");
    expect(new TextDecoder().decode(value)).toContain("data: reload");
    await finalReader.cancel();
  }, 20_000);
});

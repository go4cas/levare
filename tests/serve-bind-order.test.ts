import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, cpSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "../src/board/serve.ts";
import { Daemon } from "../src/daemon.ts";

// NOTES REV2, finding 2: `serve()` used to call `daemon.start()` (which opens a `work/` fs.watch)
// BEFORE `Bun.serve` attempted to bind the port. A bind failure (port already in use) threw past that
// point with the daemon's watcher already live and no handle ever returned to stop it — a failed
// startup that leaked a running background watcher. The fix binds first and only starts the daemon
// once the bind succeeds, so a failed bind leaves nothing running.

const HERMETIC_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" };

function git(root: string, args: string[]): ReturnType<typeof spawnSync> {
  const r = spawnSync(
    "git",
    ["-C", root, "-c", "user.name=seed", "-c", "user.email=seed@levare.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "init.defaultBranch=main", ...args],
    { encoding: "utf8", env: HERMETIC_ENV },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}${r.stdout}`);
  return r;
}

function seedScratchRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "levare-bind-order-"));
  cpSync("fixtures/golden", root, { recursive: true });
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "seed golden fixture"]);
  return root;
}

test("a failed bind leaves no daemon running", () => {
  const root = seedScratchRepo();
  // Occupy an ephemeral port first, so the real serve() call below is guaranteed to collide.
  const occupied = Bun.serve({ port: 0, fetch: () => new Response("occupied") });
  const port = occupied.port;

  const startCalls: unknown[] = [];
  const origStart = Daemon.prototype.start;
  // biome-ignore lint: test-only monkeypatch to observe whether serve() ever starts the daemon.
  Daemon.prototype.start = function (this: Daemon, ...args: unknown[]) {
    startCalls.push(args);
    return (origStart as (...a: unknown[]) => void).apply(this, args);
  };

  try {
    // `readOnly` defaults to `isUnderFixtures(root)`, which is false for this scratch copy, so
    // serve() would construct + start a real Daemon here if the ordering fix weren't in place.
    expect(() => serve(root, port, { keepProcessAlive: false })).toThrow();
    expect(startCalls.length).toBe(0);
  } finally {
    Daemon.prototype.start = origStart;
    occupied.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});

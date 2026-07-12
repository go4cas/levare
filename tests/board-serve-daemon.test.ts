import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, cpSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBoard } from "../src/board/serve.ts";
import { Daemon } from "../src/daemon.ts";
import { renderStudio } from "../src/board/render.ts";
import { stubAdapterRunner } from "../src/replay.ts";

// Phase 8, deliverable (c): "Members running" / "Running now" are a true projection of the daemon's
// in-flight invocations, retiring NOTES E2 — exercised here through the actual board wiring
// (createBoard's `daemon` option → serve.ts's route handlers → render.ts), not just the Daemon class
// in isolation (see tests/daemon.test.ts for that).

const HERMETIC_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
function git(root: string, args: string[]) {
  const r = spawnSync(
    "git",
    ["-C", root, "-c", "user.name=seed", "-c", "user.email=seed@levare.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "init.defaultBranch=main", ...args],
    { encoding: "utf8", env: HERMETIC_ENV },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}${r.stdout}`);
}
function seedScratchRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "levare-board-daemon-"));
  cpSync("fixtures/golden", dir, { recursive: true });
  git(dir, ["init", "-q"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "seed golden fixture"]);
  return dir;
}
function req(url: string, init?: RequestInit): Request {
  return new Request(`http://localhost${url}`, init);
}

let root: string;
beforeEach(() => {
  root = seedScratchRepo();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("board without a daemon (createBoard's default) keeps the honest empty projection", () => {
  test("GET /studio shows 0 members running and no fabricated activity", async () => {
    const board = createBoard(root);
    const res = await board.fetch(req("/studio"));
    const html = await res.text();
    expect(html).toContain('data-runningstat="0"');
    expect(html).toContain("Nothing running right now.");
    board.close();
  });
});

describe("board with a daemon attached projects its real in-flight/completed state", () => {
  test("GET /studio's stat + Running-now section render a real in-flight invocation while one is in progress", async () => {
    // A fresh unit with no after: is immediately walkable (see tests/daemon.test.ts case b) — the
    // simplest way to force a real in-flight production without a separate authorization step.
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const unitDir = join(root, "work/storefront/widget-tweak");
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(unitDir + "/unit.md", "---\ntype: feature\nstatus: active\n---\n\n# widget-tweak\n\nBoard-daemon test fixture.\n");

    let mid: string | null = null;
    const daemon = new Daemon(root, {
      memberRunner: (repo) => {
        const inner = stubAdapterRunner(repo);
        return {
          capabilities: () => inner.capabilities(),
          produce: (member, kind, unit, project) => {
            // Render directly (renderStudio is what serve.ts's route calls) to assert the exact
            // wiring this deliverable is about, at the precise moment a member call is in flight.
            mid = renderStudio(repo, root, new Date(), daemon.running());
            return inner.produce(member, kind, unit, project);
          },
        };
      },
    });
    const board = createBoard(root, { daemon });

    daemon.tick();
    expect(mid).not.toBeNull();
    expect(mid!).toContain('data-runningstat="1"');
    expect(mid!).toContain("wren");
    expect(mid!).toContain("producing");
    expect(mid!).toContain("product-brief");

    // After the tick completes, the board's own live GET reflects the cleared state.
    const res = await board.fetch(req("/studio"));
    const html = await res.text();
    expect(html).toContain('data-runningstat="0"');
    board.close();
  });

  test("resolving a gate over HTTP nudges the daemon (ctx.daemon.notify) instead of waiting out its debounce", async () => {
    const daemon = new Daemon(root);
    let notified = 0;
    const origNotify = daemon.notify.bind(daemon);
    daemon.notify = () => {
      notified++;
      origNotify();
    };
    const board = createBoard(root, { daemon });
    const res = await board.fetch(req("/gates/storefront/loyalty-flow/start", { method: "POST" }));
    expect(res.status).toBe(200);
    expect(notified).toBe(1);
    board.close();
  });
});

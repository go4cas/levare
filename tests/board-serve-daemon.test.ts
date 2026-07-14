import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, cpSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBoard } from "../src/board/serve.ts";
import { Daemon } from "../src/daemon.ts";
import { renderStudio } from "../src/board/render.ts";
import { stubAdapterRunner } from "../src/replay.ts";
import { loadRepo } from "../src/repo.ts";

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
    // loyalty-flow's after: [cart-icon-fix] is already satisfied in the golden fixture (E5). Ruling
    // C8: every unit's first production still needs an explicit Conductor start regardless of
    // `after:` — get it past that start gate and its brief approved first (over HTTP, the board's own
    // write surface), then the daemon can advance it on its own for the step under observation here.
    const preBoard = createBoard(root, { memberRunner: stubAdapterRunner(loadRepo(root)) });
    await preBoard.fetch(req("/gates/storefront/loyalty-flow/start", { method: "POST" }));
    await preBoard.fetch(req("/gates/storefront/product-brief-loyalty-flow-v1/approve", { method: "POST" }));
    preBoard.close();

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

    await daemon.tick();
    expect(mid).not.toBeNull();
    expect(mid!).toContain('data-runningstat="1"');
    expect(mid!).toContain("lyra");
    expect(mid!).toContain("producing");
    expect(mid!).toContain("design");

    // After the tick completes, the board's own live GET reflects the cleared state.
    const res = await board.fetch(req("/studio"));
    const html = await res.text();
    expect(html).toContain('data-runningstat="0"');
    board.close();
  });

  test("resolving a gate over HTTP lets the daemon advance the unit — asserted by the artifact it then writes, not by counting notify() calls", async () => {
    // The point of ctx.daemon.notify() is an EFFECT: a gate resolution unblocks the walk, so the
    // daemon should be able to advance the unit rather than sit idle. Assert that effect against the
    // filesystem (a real member-produced artifact, authored by the runner), not the invocation of a
    // method — a no-op notify() would pass an invocation-counter but fail this.
    const daemon = new Daemon(root, { memberRunner: stubAdapterRunner });
    const board = createBoard(root, { daemon, memberRunner: stubAdapterRunner(loadRepo(root)) });

    // Start over HTTP (doStart produces the brief in-review), then approve the brief over HTTP — the
    // route handler calls ctx.daemon.notify() on each. Both are the board's own write surface.
    expect((await board.fetch(req("/gates/storefront/loyalty-flow/start", { method: "POST" }))).status).toBe(200);
    expect((await board.fetch(req("/gates/storefront/product-brief-loyalty-flow-v1/approve", { method: "POST" }))).status).toBe(200);

    // With the brief approved, the daemon's next look advances the unit and writes the next kind
    // (design) to disk — the observable outcome a working notify() exists to bring forward.
    const designFile = join(root, "work", "storefront", "loyalty-flow", "design-loyalty-flow-v1.md");
    expect(existsSync(designFile)).toBe(false);
    await daemon.tick();
    expect(existsSync(designFile)).toBe(true);
    // And the daemon — not the Conductor — authored it (invariant-2 audit trail; see daemon.test.ts).
    const author = spawnSync("git", ["-C", root, "log", "-1", "--format=%an|%ae", "--", designFile], { encoding: "utf8" }).stdout.trim();
    expect(author).toBe("levare-runner|runner@levare.local");
    board.close();
  });
});

// NOTES F10 defect 3: a Conductor's own `start`/`request-changes` click drives production directly
// (board/gateops.ts#doStart/#doRequest), inside the SAME request — a completely separate code path
// from the daemon's own autonomous tick tested above. Before this fix, NOTHING registered that
// dispatch anywhere: `daemon.running()` (and so the board's "Members running"/gate-dispatching render)
// stayed at its honest-looking-but-wrong zero for the entire window a real model call was thinking,
// even though a member was, in fact, actively running.
describe("a Conductor-triggered start/request-changes is visible in the daemon's running() projection while in flight", () => {
  test("POST /gates/.../start registers with the daemon before the member call returns, and clears it after", async () => {
    let mid: string | null = null;
    let sawRunningDuringDispatch = false;
    const daemon = new Daemon(root, { memberRunner: stubAdapterRunner });
    const memberRunner = {
      capabilities: () => stubAdapterRunner(loadRepo(root)).capabilities(),
      produce: async (member: string, kind: string, unit: string, project: string) => {
        // The exact moment the board's gate route is inside the member call — asserted the same way
        // the daemon-tick test above asserts its own in-flight window.
        sawRunningDuringDispatch = daemon.running().some((r) => r.project === "storefront" && r.unit === "loyalty-flow" && r.member === "wren");
        mid = renderStudio(loadRepo(root), root, new Date(), daemon.running());
        return stubAdapterRunner(loadRepo(root)).produce(member, kind, unit, project);
      },
    };
    const board = createBoard(root, { daemon, memberRunner });

    const res = await board.fetch(req("/gates/storefront/loyalty-flow/start", { method: "POST" }));
    expect(res.status).toBe(200);

    expect(sawRunningDuringDispatch).toBe(true);
    expect(mid).not.toBeNull();
    expect(mid!).toContain('data-runningstat="1"');
    expect(mid!).toContain("is-dispatching");

    // After the request completes, the invocation is cleared — never left dangling.
    expect(daemon.running()).toEqual([]);
    const after = await board.fetch(req("/studio"));
    expect(await after.text()).toContain('data-runningstat="0"');
    board.close();
  });
});

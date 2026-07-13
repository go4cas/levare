import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, cpSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

// NOTES F5 — the live-dogfood defect this file exists to pin down for good: a real 10-minute Gemini
// member run left `levare serve`'s console completely unresponsive, because CLI member invocation used
// `Bun.spawnSync`, which blocks Bun's single JS thread — and therefore every OTHER concurrent request,
// including a plain `GET /` with no member involvement at all — for the member's entire run. Phase 7
// fixed the identical defect for the SDK transport by isolating an async spawn at the boundary
// (sdk-transport.ts's `AsyncSdkTransport`, proven non-blocking by tests/board-serve-nonblocking.test.ts
// in-process); this file proves the CLI path's fix the same way board-serve-nonblocking.test.ts and
// serve-real-cli-e2e.test.ts already prove their own pieces — but end to end, against the REAL `./levare
// serve` binary and a REAL, unmocked child process, not an in-process board.fetch() or an injected
// CliSpawn double.

const REPO_ROOT = join(import.meta.dir, "..");
const PORT = 5300 + (process.pid % 400);

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

async function waitUntilUp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      await res.arrayBuffer();
      return;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`server never came up at ${url}: ${lastErr}`);
}

const SLEEP_SECONDS = 3;

describe("`levare serve` never blocks on a real CLI member's run (NOTES F5)", () => {
  let root: string;
  let proc: ReturnType<typeof Bun.spawn>;
  const base = `http://localhost:${PORT}`;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "levare-cli-nonblocking-e2e-"));
    cpSync(join(REPO_ROOT, "fixtures/golden"), root, { recursive: true });

    // Rewire wren (kestrel's first flow-step producer) to a real CLI member whose ENTIRE job is to
    // sleep for several seconds — a real, unmocked subprocess, standing in for a slow real-world member
    // (a real 10-minute Gemini call, in the dogfood run this fixes) with nothing else going on that
    // could confound the timing assertion below.
    const wrenFile = join(root, "agents/wren.md");
    writeFileSync(
      wrenFile,
      [
        "---",
        "name: wren",
        "kind: cli",
        "produces: [product-brief]",
        `command: ["sleep", "${SLEEP_SECONDS}"]`,
        "timeout: 30",
        'result: "Emits a product-brief artifact markdown file to stdout."',
        "style:",
        "  avatar: Wr",
        "---",
        "",
        "# Wren — a real, slow CLI member (F5 e2e)",
      ].join("\n"),
    );

    git(root, ["init", "-q"]);
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "seed golden fixture with a slow real CLI wren"]);

    proc = Bun.spawn(["./levare", "serve", root, "--port", String(PORT)], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    await waitUntilUp(`${base}/`, 10_000);
  });

  afterAll(() => {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already exited */
    }
    rmSync(root, { recursive: true, force: true });
  });

  test(`GET / responds in under a second while a real CLI member sleeps for ${SLEEP_SECONDS}s`, async () => {
    // loyalty-flow's `after: [cart-icon-fix]` is already satisfied in the golden fixture (E5) — its
    // start gate is immediately actionable. This request will not itself resolve until wren's `sleep`
    // finishes (the board's own "start → produced artifact" contract is unchanged by F5 — only the
    // BLOCKING is fixed), so it is fired but not awaited yet.
    const startedAt = Date.now();
    const startPromise = fetch(`${base}/gates/storefront/loyalty-flow/start`, { method: "POST" });

    // Give the POST above a moment to actually reach the spawn (past context assembly, env scoping,
    // preflight) before racing a concurrent GET against it — otherwise this GET might win a race that
    // was never actually contended.
    await new Promise((r) => setTimeout(r, 500));

    const getStart = Date.now();
    const rootRes = await fetch(`${base}/`);
    const getElapsed = Date.now() - getStart;
    await rootRes.arrayBuffer();

    expect(rootRes.status).toBe(200);
    // The whole point of F5: a concurrent, unrelated GET must never queue behind the member's run. If
    // `Bun.spawnSync` were still in use, this GET would block for the remainder of wren's 3s sleep.
    expect(getElapsed).toBeLessThan(1000);

    // Let the start request finish and confirm the member's run really did take the full duration —
    // proving the fast GET above raced a GENUINELY slow, in-flight member call, not a fast/no-op one.
    // `sleep` emits no artifact doc, so the start route itself reports a member/boundary failure
    // (502) rather than a produced artifact — irrelevant to F5, which is only about the event loop
    // staying responsive DURING the call, not the outcome of a deliberately content-free member.
    const startRes = await startPromise;
    const totalStartElapsed = Date.now() - startedAt;
    expect(startRes.status).toBe(502);
    expect(totalStartElapsed).toBeGreaterThanOrEqual(SLEEP_SECONDS * 1000);
  });
});

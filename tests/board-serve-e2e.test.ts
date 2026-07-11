import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, cpSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

// PRD §9 acceptance gap (see NOTES.md E12): every prior board test called the router's fetch(req)
// handler in-process, or drove `bun run src/cli.ts serve` manually — neither exercises the actual
// `./levare` entry point over a real socket. That let a real defect (the wrapper unconditionally
// called `process.exit(main(argv))`, so `./levare serve` printed its URL and exited immediately)
// pass a fully green suite. This file spawns the real `./levare` binary as a subprocess and talks to
// it over HTTP/SSE, so "the process never actually served anything" can never slip through silently
// again.

const REPO_ROOT = join(import.meta.dir, "..");
const PORT = 4100 + (process.pid % 400); // spread across runs to avoid colliding with a stale listener

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

function seedScratchRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "levare-e2e-"));
  cpSync(join(REPO_ROOT, "fixtures/golden"), root, { recursive: true });
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "seed golden fixture"]);
  return root;
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

async function waitUntilDown(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(300) });
      await new Promise((r) => setTimeout(r, 100));
    } catch {
      return; // connection refused / aborted — the listener is gone
    }
  }
  throw new Error(`server still accepting connections at ${url} after ${timeoutMs}ms`);
}

describe("`./levare serve` — real subprocess over a real socket", () => {
  let root: string;
  let proc: ReturnType<typeof Bun.spawn>;
  const base = `http://localhost:${PORT}`;

  beforeAll(async () => {
    root = seedScratchRepo();
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

  test("the process is still alive after boot — it did not exit after printing its URL", () => {
    // Bun.spawn's exitCode is null while the child is still running; a `serve` process that called
    // process.exit(0) right after logging its URL (the regression this test exists to catch) would
    // already have a non-null exitCode by the time we get here.
    expect(proc.exitCode).toBeNull();
    expect(proc.killed).toBe(false);
  });

  test("GET / returns 200 with the studio HTML (derivation line + a gate card)", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('class="deriv"');
    expect(text).toContain('class="gate"');
    expect(text).toContain("<!doctype html>");
  });

  test("GET /styles.css and /app.js actually serve the asset bytes, not just a reference", async () => {
    const css = await fetch(`${base}/styles.css`);
    expect(css.status).toBe(200);
    expect(await css.text()).toBe(readFileSync(join(REPO_ROOT, "assets/styles.css"), "utf8"));

    const js = await fetch(`${base}/app.js`);
    expect(js.status).toBe(200);
    expect(await js.text()).toBe(readFileSync(join(REPO_ROOT, "assets/app.js"), "utf8"));
  });

  test("POST approve on the open gate flips the file on disk and pushes an SSE reload", async () => {
    const sse = await fetch(`${base}/events`);
    expect(sse.headers.get("content-type")).toContain("text/event-stream");
    const reader = sse.body!.getReader();
    await reader.read(); // drain ": connected"

    const artifactPath = join(root, "work/storefront/checkout-flow/spec-checkout-flow-v1.md");
    expect(readFileSync(artifactPath, "utf8")).toContain("status: in-review");

    const res = await fetch(`${base}/gates/storefront/spec-checkout-flow-v1/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "e2e approve" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    expect(readFileSync(artifactPath, "utf8")).toMatch(/status: approved/);

    const { value } = await Promise.race([
      reader.read(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("no SSE reload within 5s")), 5000)),
    ]);
    expect(new TextDecoder().decode(value)).toContain("data: reload");
  });

  test("SIGINT stops the server cleanly", async () => {
    proc.kill("SIGINT");
    const exitCode = await Promise.race([
      proc.exited,
      new Promise<number>((_, rej) => setTimeout(() => rej(new Error("process did not exit within 5s of SIGINT")), 5000)),
    ]);
    expect(exitCode).toBe(0);
    await waitUntilDown(`${base}/`, 3000);
  });
});

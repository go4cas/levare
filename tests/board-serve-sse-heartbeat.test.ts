import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, cpSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { assertSpawnOk } from "./spawn-helpers.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "../src/board/serve.ts";

// NOTES "score rail reload" — a runner-side (daemon-driven) commit's only path to the browser is the
// SSE `/events` stream. That path was proven sound at the fs.watch/broadcast layer (a real daemon-only
// commit, deliberately delayed to simulate a slow `kind: cli` dispatch, still produces exactly one
// `reload`), but the CONNECTION it travels over was not durable: `serve()`'s own `idleTimeout` (default
// 180s) silently resets a connection Bun has sent nothing on for that long — no error the client can
// distinguish from an ordinary close, and (unlike a POST that carries a body — NOTES K17, this file's
// neighbor `board-serve-idletimeout.test.ts`) this DOES reliably fire for a bodyless GET stream, which
// is exactly what `/events` is. A quiet studio (nothing changing while a real member call — especially
// a slow local CLI dispatch — is thinking) crosses that in minutes, not hours, in production.
//
// This is a genuinely real-socket concept — invisible to the in-process `board.fetch()` helper every
// other board/SSE test uses, and to `createBoard`'s own reload-signature tests (`tests/board-serve-
// reload-signature.test.ts`), neither of which ever goes through an actual `Bun.serve` listener — so it
// is tested here through a real listening server, mirroring `board-serve-idletimeout.test.ts`'s own
// precedent for exactly this reason. `idleTimeoutSeconds`/`sseHeartbeatMs` are both test-only overrides
// (`serve()`'s own opts) so this proves the mechanism in seconds, not the real 180s/60s.
//
// Empirically, Bun's idle-timeout enforcement in this version is unreliable below roughly 5 real
// seconds regardless of heartbeat activity (observed directly while writing this test: idleTimeoutSeconds:
// 3 with a 500ms heartbeat still reset at ~4s) — the same "this Bun version's idleTimeout doesn't behave
// exactly as documented" caveat board-serve-idletimeout.test.ts's own header already names. Both tests
// below use idleTimeoutSeconds values comfortably above that floor, proven reliable across repeated runs.

const HERMETIC_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
function git(root: string, args: string[]): void {
  const r = spawnSync(
    "git",
    ["-C", root, "-c", "user.name=seed", "-c", "user.email=seed@levare.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "init.defaultBranch=main", ...args],
    { encoding: "utf8", env: HERMETIC_ENV },
  );
  assertSpawnOk(`git ${args.join(" ")}`, r);
}

function seedScratchRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "levare-sse-heartbeat-"));
  cpSync("fixtures/golden", root, { recursive: true });
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "seed golden fixture"]);
  return root;
}

test("without a heartbeat inside the idle window, a quiet /events connection is silently reset — the bug, reproduced", async () => {
  const root = seedScratchRepo();
  // sseHeartbeatMs deliberately far outside the idle window — the pre-fix behavior (no heartbeat at all).
  const handle = serve(root, 0, { keepProcessAlive: false, idleTimeoutSeconds: 5, sseHeartbeatMs: 999_000, noDaemon: true });
  try {
    const res = await fetch(`${handle.url}/events`);
    const reader = res.body!.getReader();
    await reader.read(); // drain ": connected"
    await expect(reader.read()).rejects.toThrow();
  } finally {
    handle.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);

test("a heartbeat well inside the idle window keeps /events alive past what idleTimeout alone would allow", async () => {
  const root = seedScratchRepo();
  // 5s idle timeout, heartbeat every 800ms (>3x margin) — run long enough to cross idleTimeout TWICE
  // with zero resets, proving this isn't a lucky single reset-avoidance.
  const handle = serve(root, 0, { keepProcessAlive: false, idleTimeoutSeconds: 5, sseHeartbeatMs: 800, noDaemon: true });
  try {
    const res = await fetch(`${handle.url}/events`);
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe(": connected\n\n");

    let heartbeats = 0;
    const deadline = Date.now() + 12_000; // > 2x idleTimeoutSeconds
    while (Date.now() < deadline && heartbeats < 10) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`stream closed early after ${heartbeats} heartbeat(s) — the connection was reset despite the heartbeat`);
      const chunk = new TextDecoder().decode(value);
      // A heartbeat is an SSE comment line (`:`-prefixed) — never `data: `, so a real EventSource's
      // onmessage never fires for it; this asserts the wire shape, not just "something arrived".
      expect(chunk.startsWith(": ")).toBe(true);
      expect(chunk).not.toContain("data:");
      heartbeats++;
    }
    expect(heartbeats).toBeGreaterThanOrEqual(10);
    reader.cancel().catch(() => {});
  } finally {
    handle.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

test("a real reload broadcast still reaches the client normally alongside heartbeats — the heartbeat never masks a real change", async () => {
  const root = seedScratchRepo();
  const handle = serve(root, 0, { keepProcessAlive: false, idleTimeoutSeconds: 30, sseHeartbeatMs: 400, noDaemon: true });
  try {
    const res = await fetch(`${handle.url}/events`);
    const reader = res.body!.getReader();
    await reader.read(); // drain ": connected"

    // A real board write route (registry-independent — approving the golden fixture's own open gate)
    // broadcasts "reload" directly; assert it is delivered as a genuine data frame, distinguishable
    // from the comment-only heartbeat frames that may interleave with it.
    const approve = fetch(`${handle.url}/gates/storefront/spec-checkout-flow-v1/approve`, { method: "POST" });
    let sawReload = false;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !sawReload) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = new TextDecoder().decode(value);
      if (chunk === "data: reload\n\n") sawReload = true;
    }
    await approve;
    expect(sawReload).toBe(true);
    reader.cancel().catch(() => {});
  } finally {
    handle.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBoard } from "../src/board/serve.ts";
import type { OrchestratorBoundary } from "../src/orchestrator.ts";

// Phase-7 live-gate regression (NOTES K9): a real run showed `Bun.spawnSync` inside the SDK
// transport freezing the ENTIRE `levare serve` event loop — GET /styles.css (a plain static file
// read with no SDK involvement) timed out while an unrelated /orchestrator/message call was in
// flight. This test proves the fix end to end through `board.fetch()` (the same in-process router
// every other board test drives — NOTES E12 Learnings): a deliberately slow (but async, non-blocking)
// OrchestratorBoundary must never delay a concurrent, unrelated GET.

function seedScratchRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "levare-nonblocking-"));
  cpSync("fixtures/golden", root, { recursive: true });
  return root;
}

// A boundary whose narrate()/interpret() take a while (simulating a slow or hung real SDK call) but
// are genuinely async (a setTimeout-backed Promise, not a blocking sleep) — exactly what the real
// AsyncSdkTransport looks like from the caller's side.
function slowBoundary(delayMs: number): OrchestratorBoundary {
  return {
    async interpret(text) {
      await new Promise((r) => setTimeout(r, delayMs));
      return { kind: "unknown", text };
    },
    async narrate(prompt) {
      await new Promise((r) => setTimeout(r, delayMs));
      return prompt;
    },
    async converse(text) {
      await new Promise((r) => setTimeout(r, delayMs));
      return `(slow reply) ${text}`;
    },
  };
}

test("a slow /orchestrator/message call never delays a concurrent GET / or GET /styles.css", async () => {
  const root = seedScratchRepo();
  const board = createBoard(root, { orchestratorBoundary: slowBoundary(300) });
  try {
    const start = Date.now();
    const slowOrchestratorCall = board.fetch(
      new Request("http://localhost/orchestrator/message", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "what needs me" }),
      }),
    );

    // Fired concurrently, while the orchestrator call above is still pending — must not queue behind it.
    const [rootRes, cssRes] = await Promise.all([board.fetch(new Request("http://localhost/")), board.fetch(new Request("http://localhost/styles.css"))]);
    const fastElapsed = Date.now() - start;

    expect(rootRes.status).toBe(200);
    expect(cssRes.status).toBe(200);
    // Both plain GETs resolved well before the 300ms slow orchestrator call could have finished —
    // if the transport were blocking, they would have queued behind it and this would be >= 300ms.
    expect(fastElapsed).toBeLessThan(250);

    const orchestratorRes = await slowOrchestratorCall; // let it finish so nothing leaks past the test
    expect(orchestratorRes.status).toBe(200);
    expect(Date.now() - start).toBeGreaterThanOrEqual(300);
  } finally {
    board.close();
    rmSync(root, { recursive: true, force: true });
  }
});

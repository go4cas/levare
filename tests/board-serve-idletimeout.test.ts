import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "../src/board/serve.ts";
import type { OrchestratorBoundary } from "../src/orchestrator.ts";

// Phase-7 live-gate fix-up (NOTES K17): Bun.serve's own default idleTimeout is 10 seconds — far
// shorter than a real SDK round trip (interpret/narrate/converse, up to 90s) can take. `serve()` now
// pins idleTimeout explicitly (180s, overridable for tests) instead of inheriting that default.
//
// This is a genuinely real socket concept (invisible to the in-process `board.fetch()` helper every
// other board test uses), so it's tested here through an actual listening server. While chasing this,
// two things were confirmed empirically that shape what's tested below:
//  - Bun's idle-timeout enforcement, in this Bun version, does not reliably fire for a POST request
//    that carries a body (the shape of every real /orchestrator/message call) — it fires cleanly for
//    GET/bodyless requests. Bun's idleTimeout is therefore NOT the mechanism this codebase leans on to
//    guarantee "a request always produces a reply" for /orchestrator/message; that guarantee comes
//    from the SDK transport's own setTimeout-based kill (sdk-transport.ts, proven end to end in
//    tests/sdk-transport-hermetic.test.ts's hung-worker tests) plus the route's degrade-to-offline
//    catch (tests/board-serve.test.ts's "broken SDK boundary" test). idleTimeout here is defense in
//    depth for the HTTP layer itself, not the primary guarantee.
//  - `server.hostname` is "0.0.0.0" (needed to bind all interfaces for container port-forwarding), but
//    connecting to the literal string "0.0.0.0" as a destination is OS/resolver-dependent and was
//    observed to sometimes bypass idle-timeout enforcement entirely. `serve()` now always returns a
//    `localhost`-based URL instead — see its own comment — which is what this test (and the CLI's
//    printed message, and any real client) should use to reach the server.

function seedScratchRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "levare-idletimeout-"));
  cpSync("fixtures/golden", root, { recursive: true });
  return root;
}

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

test("serve() returns a localhost URL, never the literal 0.0.0.0 bind address", () => {
  const root = seedScratchRepo();
  const handle = serve(root, 0, { keepProcessAlive: false });
  try {
    expect(handle.url.startsWith("http://localhost:")).toBe(true);
  } finally {
    handle.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a slow real-socket /orchestrator/message call still completes normally with a custom idleTimeoutSeconds", async () => {
  const root = seedScratchRepo();
  const handle = serve(root, 0, {
    keepProcessAlive: false,
    orchestratorBoundary: slowBoundary(500),
    idleTimeoutSeconds: 5,
  });
  try {
    const res = await fetch(`${handle.url}/orchestrator/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "what needs me" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reply).toContain("slow reply");
  } finally {
    handle.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 8000);


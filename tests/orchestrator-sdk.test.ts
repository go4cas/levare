import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { deterministicBoundary } from "../src/orchestrator.ts";
import {
  createSdkOrchestratorBoundary,
  selectOrchestratorBoundary,
  loadOrchestratorPromptSource,
  coerceIntent,
  ORCHESTRATOR_PROMPT_PATH,
  OrchestratorSdkError,
} from "../src/orchestrator-boundary.ts";
import { createAsyncSdkTransport, hasAnthropicCredentials } from "../src/sdk-transport.ts";
import type { AsyncSdkTransport, SdkWorkerRequest, SdkWorkerResponse } from "../src/sdk-transport.ts";

// Phase 7 acceptance: the real OrchestratorBoundary is driven by the Claude Agent SDK, but every
// test here mocks the SDK at the TRANSPORT level (a fake `AsyncSdkTransport`, exactly like
// adapters.test.ts injects a fake CliSpawn for the "cli" agent kind) — no test in this file spawns
// the real worker subprocess, touches the network, or requires ANTHROPIC_API_KEY.
//
// interpret()/narrate() are async (NOTES phase-7 K9 — the real transport is non-blocking I/O so a
// slow/hung SDK call never freezes `levare serve`'s event loop for other requests), so every call
// below is awaited.

function fakeTransport(handler: (req: SdkWorkerRequest) => SdkWorkerResponse): { transport: AsyncSdkTransport; calls: SdkWorkerRequest[] } {
  const calls: SdkWorkerRequest[] = [];
  return {
    calls,
    transport: {
      async run(req) {
        calls.push(req);
        return handler(req);
      },
    },
  };
}

// ---------------------------------------------------------------------------
// docs/orchestrator-prompt.md is loaded from disk, not embedded
// ---------------------------------------------------------------------------

describe("the Orchestrator's system prompt is loaded from disk verbatim", () => {
  test("loadOrchestratorPromptSource matches docs/orchestrator-prompt.md byte-for-byte", () => {
    const onDisk = readFileSync("docs/orchestrator-prompt.md", "utf8");
    expect(loadOrchestratorPromptSource()).toBe(onDisk);
    expect(loadOrchestratorPromptSource(ORCHESTRATOR_PROMPT_PATH)).toBe(onDisk);
  });

  test("the real boundary hands that exact string to the transport as systemPrompt, unmodified", async () => {
    const onDisk = readFileSync("docs/orchestrator-prompt.md", "utf8");
    const { transport, calls } = fakeTransport(() => ({ ok: true, result: "narrated." }));
    const boundary = createSdkOrchestratorBoundary({ transport });
    await boundary.narrate("3 gates open.");
    expect(calls).toHaveLength(1);
    expect(calls[0].systemPrompt).toBe(onDisk);
  });
});

// ---------------------------------------------------------------------------
// interpret(): structured-output JSON in, a coerced Intent out
// ---------------------------------------------------------------------------

describe("createSdkOrchestratorBoundary#interpret (mocked transport)", () => {
  test("a well-formed structured_output round-trips to the matching Intent", async () => {
    const { transport, calls } = fakeTransport((req) => {
      expect(req.outputFormat?.type).toBe("json_schema");
      return { ok: true, result: "{}", structuredOutput: { kind: "gate-decision", target: "spec-checkout-flow-v1", verb: "approve" } };
    });
    const boundary = createSdkOrchestratorBoundary({ transport });
    const intent = await boundary.interpret("approve the spec");
    expect(intent).toEqual({ kind: "gate-decision", target: "spec-checkout-flow-v1", verb: "approve", note: undefined });
    expect(calls[0].prompt).toBe("approve the spec");
    expect(calls[0].tools).toEqual([]);
  });

  test("briefing/stats intents need no extra fields", async () => {
    const { transport } = fakeTransport(() => ({ ok: true, result: "{}", structuredOutput: { kind: "briefing" } }));
    expect(await createSdkOrchestratorBoundary({ transport }).interpret("what needs me")).toEqual({ kind: "briefing" });
  });

  test("capture-idea, open-unit, promote-idea round-trip their fields", async () => {
    const idea = fakeTransport(() => ({
      ok: true,
      result: "{}",
      structuredOutput: { kind: "capture-idea", name: "faster-checkout", pitch: "Skip confirmation.", tags: ["speed"] },
    }));
    expect(await createSdkOrchestratorBoundary({ transport: idea.transport }).interpret("capture idea")).toEqual({
      kind: "capture-idea",
      name: "faster-checkout",
      pitch: "Skip confirmation.",
      tags: ["speed"],
    });

    const unit = fakeTransport(() => ({
      ok: true,
      result: "{}",
      structuredOutput: { kind: "open-unit", project: "storefront", unit: "perf-spike", type: "spike" },
    }));
    expect(await createSdkOrchestratorBoundary({ transport: unit.transport }).interpret("open a spike")).toEqual({
      kind: "open-unit",
      project: "storefront",
      unit: "perf-spike",
      type: "spike",
      after: undefined,
    });

    const promote = fakeTransport(() => ({
      ok: true,
      result: "{}",
      structuredOutput: { kind: "promote-idea", idea: "loyalty-program", project: "storefront", unit: "loyalty-inception" },
    }));
    expect(await createSdkOrchestratorBoundary({ transport: promote.transport }).interpret("promote that idea")).toEqual({
      kind: "promote-idea",
      idea: "loyalty-program",
      project: "storefront",
      unit: "loyalty-inception",
    });
  });

  // A transport failure must never be indistinguishable from a real, working model call that just
  // classified the phrase as "unknown" — see NOTES phase-7 K8. interpret() raises loudly instead.
  test("a transport failure throws OrchestratorSdkError — it never masquerades as {kind:'unknown'}", async () => {
    const { transport } = fakeTransport(() => ({ ok: false, error: "worker timed out" }));
    const boundary = createSdkOrchestratorBoundary({ transport });
    await expect(boundary.interpret("approve x")).rejects.toThrow(OrchestratorSdkError);
    await expect(boundary.interpret("approve x")).rejects.toThrow(/worker timed out/);
  });

  // The acceptance criterion's own suggested repro: a bad worker path, driven through the REAL
  // (non-blocking) async transport — a genuine, deterministic, network-free transport failure that
  // needs no ANTHROPIC_API_KEY, exercising createAsyncSdkTransport's own existsSync guard.
  test("a real transport pointed at a nonexistent worker script throws, not {kind:'unknown'}", async () => {
    const brokenTransport = createAsyncSdkTransport("/nonexistent/path/sdk-worker.ts");
    const boundary = createSdkOrchestratorBoundary({ transport: brokenTransport, env: {} });
    await expect(boundary.interpret("what needs me")).rejects.toThrow(OrchestratorSdkError);
    await expect(boundary.interpret("what needs me")).rejects.toThrow(/sdk worker script not found/);
  });

  // Same real transport, missing credential — the SDK worker script itself is never even reached
  // (existsSync fails first for a bogus path), so this stays fast/offline/deterministic too.
  test("no ANTHROPIC_API_KEY is not silently treated as a successful call either", async () => {
    expect(hasAnthropicCredentials({})).toBe(false);
    const brokenTransport = createAsyncSdkTransport("/nonexistent/path/sdk-worker.ts");
    const boundary = createSdkOrchestratorBoundary({ transport: brokenTransport, env: {} });
    await expect(boundary.interpret("stats")).rejects.toThrow(OrchestratorSdkError);
  });

  test("malformed structured_output (missing required fields, bad verb) falls back to unknown, never throws", async () => {
    const missing = fakeTransport(() => ({ ok: true, result: "{}", structuredOutput: { kind: "gate-decision" } }));
    expect(await createSdkOrchestratorBoundary({ transport: missing.transport }).interpret("approve x")).toEqual({ kind: "unknown", text: "approve x" });

    const badVerb = fakeTransport(() => ({ ok: true, result: "{}", structuredOutput: { kind: "gate-decision", target: "t", verb: "yeet" } }));
    expect(await createSdkOrchestratorBoundary({ transport: badVerb.transport }).interpret("approve x")).toEqual({ kind: "unknown", text: "approve x" });

    const notAnObject = fakeTransport(() => ({ ok: true, result: "{}", structuredOutput: "not an object" }));
    expect(await createSdkOrchestratorBoundary({ transport: notAnObject.transport }).interpret("hi")).toEqual({ kind: "unknown", text: "hi" });
  });
});

describe("coerceIntent (pure narrowing, no transport)", () => {
  test("null/undefined/array structured output all fall back to unknown", () => {
    expect(coerceIntent(null, "t")).toEqual({ kind: "unknown", text: "t" });
    expect(coerceIntent(undefined, "t")).toEqual({ kind: "unknown", text: "t" });
    expect(coerceIntent([], "t")).toEqual({ kind: "unknown", text: "t" });
  });
});

// ---------------------------------------------------------------------------
// narrate(): the computed factual line goes to the model under the verbatim voice prompt
// ---------------------------------------------------------------------------

describe("createSdkOrchestratorBoundary#narrate (mocked transport)", () => {
  test("returns the model's final text", async () => {
    const { transport, calls } = fakeTransport(() => ({ ok: true, result: "Nothing needs a decision right now." }));
    const boundary = createSdkOrchestratorBoundary({ transport });
    expect(await boundary.narrate("Nothing needs you right now.")).toBe("Nothing needs a decision right now.");
    expect(calls[0].tools).toEqual([]);
    expect(calls[0].outputFormat).toBeUndefined();
  });

  test("a transport failure falls back to the plain computed fact, never a fabricated line", async () => {
    const { transport } = fakeTransport(() => ({ ok: false, error: "network unreachable" }));
    const boundary = createSdkOrchestratorBoundary({ transport });
    expect(await boundary.narrate("3 gates open.")).toBe("3 gates open.");
  });
});

// ---------------------------------------------------------------------------
// boundary selection: real SDK vs. deterministic offline fallback
// ---------------------------------------------------------------------------

describe("selectOrchestratorBoundary — key-present vs. key-absent", () => {
  test("no ANTHROPIC_API_KEY → exactly the deterministic boundary (identity, not just behavior)", () => {
    const boundary = selectOrchestratorBoundary({});
    expect(boundary).toBe(deterministicBoundary);
  });

  test("empty-string ANTHROPIC_API_KEY is treated as absent", () => {
    const boundary = selectOrchestratorBoundary({ ANTHROPIC_API_KEY: "" });
    expect(boundary).toBe(deterministicBoundary);
  });

  test("ANTHROPIC_API_KEY present → the real SDK-driven boundary, proven by it actually invoking the transport", async () => {
    const { transport, calls } = fakeTransport(() => ({ ok: true, result: "{}", structuredOutput: { kind: "stats" } }));
    const boundary = selectOrchestratorBoundary({ ANTHROPIC_API_KEY: "sk-ant-test-not-real" }, { transport });
    expect(boundary).not.toBe(deterministicBoundary);
    const intent = await boundary.interpret("stats");
    expect(intent).toEqual({ kind: "stats" });
    expect(calls).toHaveLength(1); // proves this call actually went through the (fake) SDK transport
  });
});

// ---------------------------------------------------------------------------
// The live-gate regression itself: a blocking transport must never block the event loop
// (NOTES phase-7 K9). These stay fast, deterministic, and fully offline.
// ---------------------------------------------------------------------------

describe("the async transport does not block the event loop while a call is in flight", () => {
  test("a slow-but-eventually-resolving real spawn does not delay an unrelated concurrent timer", async () => {
    // A tiny real worker script that sleeps ~250ms then responds — run through the REAL
    // createAsyncSdkTransport (Bun.spawn, non-blocking), not a fake, so this exercises the actual
    // mechanism the live-gate bug was in (Bun.spawnSync freezing the whole process).
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "levare-slow-worker-"));
    const slowWorkerPath = join(dir, "slow-worker.ts");
    writeFileSync(
      slowWorkerPath,
      `await Bun.stdin.text();\nawait new Promise((r) => setTimeout(r, 250));\nconsole.log(JSON.stringify({ok: true, result: "slow but done"}));\n`,
    );
    try {
      const transport = createAsyncSdkTransport(slowWorkerPath);
      const start = Date.now();
      let timerResolvedAt: number | null = null;
      const unrelatedTimer = new Promise<void>((resolve) => {
        setTimeout(() => {
          timerResolvedAt = Date.now();
          resolve();
        }, 10);
      });
      const slowCall = transport.run({ prompt: "hi" }, { env: {}, timeoutMs: 5000 });
      // If the transport were blocking (Bun.spawnSync), this await would not resolve until the
      // 250ms child exits — proving the event loop was frozen the whole time. It resolves at ~10ms.
      await unrelatedTimer;
      expect(timerResolvedAt! - start).toBeLessThan(150);
      const res = await slowCall; // let the slow call finish so nothing leaks past the test
      expect(res).toEqual({ ok: true, result: "slow but done" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a hung worker is killed after timeoutMs, not left pending forever", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "levare-hung-worker-"));
    const hungWorkerPath = join(dir, "hung-worker.ts");
    writeFileSync(hungWorkerPath, `await Bun.stdin.text();\nawait new Promise(() => {});\n`); // never resolves
    try {
      const transport = createAsyncSdkTransport(hungWorkerPath);
      const start = Date.now();
      const res = await transport.run({ prompt: "hi" }, { env: {}, timeoutMs: 200 });
      expect(Date.now() - start).toBeLessThan(2000); // killed well short of "forever"
      expect(res).toEqual({ ok: false, error: "sdk worker timed out after 200ms" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

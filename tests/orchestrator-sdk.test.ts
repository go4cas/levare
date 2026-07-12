import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { deterministicBoundary } from "../src/orchestrator.ts";
import {
  createSdkOrchestratorBoundary,
  selectOrchestratorBoundary,
  loadOrchestratorPromptSource,
  coerceIntent,
  ORCHESTRATOR_PROMPT_PATH,
} from "../src/orchestrator-boundary.ts";
import type { SdkTransport, SdkWorkerRequest, SdkWorkerResponse } from "../src/sdk-transport.ts";

// Phase 7 acceptance: the real OrchestratorBoundary is driven by the Claude Agent SDK, but every
// test here mocks the SDK at the TRANSPORT level (a fake `SdkTransport`, exactly like adapters.test.ts
// injects a fake CliSpawn for the "cli" agent kind) — no test in this file spawns the real worker
// subprocess, touches the network, or requires ANTHROPIC_API_KEY.

function fakeTransport(handler: (req: SdkWorkerRequest) => SdkWorkerResponse): { transport: SdkTransport; calls: SdkWorkerRequest[] } {
  const calls: SdkWorkerRequest[] = [];
  return {
    calls,
    transport: {
      run(req) {
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

  test("the real boundary hands that exact string to the transport as systemPrompt, unmodified", () => {
    const onDisk = readFileSync("docs/orchestrator-prompt.md", "utf8");
    const { transport, calls } = fakeTransport(() => ({ ok: true, result: "narrated." }));
    const boundary = createSdkOrchestratorBoundary({ transport });
    boundary.narrate("3 gates open.");
    expect(calls).toHaveLength(1);
    expect(calls[0].systemPrompt).toBe(onDisk);
  });
});

// ---------------------------------------------------------------------------
// interpret(): structured-output JSON in, a coerced Intent out
// ---------------------------------------------------------------------------

describe("createSdkOrchestratorBoundary#interpret (mocked transport)", () => {
  test("a well-formed structured_output round-trips to the matching Intent", () => {
    const { transport, calls } = fakeTransport((req) => {
      expect(req.outputFormat?.type).toBe("json_schema");
      return { ok: true, result: "{}", structuredOutput: { kind: "gate-decision", target: "spec-checkout-flow-v1", verb: "approve" } };
    });
    const boundary = createSdkOrchestratorBoundary({ transport });
    const intent = boundary.interpret("approve the spec");
    expect(intent).toEqual({ kind: "gate-decision", target: "spec-checkout-flow-v1", verb: "approve", note: undefined });
    expect(calls[0].prompt).toBe("approve the spec");
    expect(calls[0].tools).toEqual([]);
  });

  test("briefing/stats intents need no extra fields", () => {
    const { transport } = fakeTransport(() => ({ ok: true, result: "{}", structuredOutput: { kind: "briefing" } }));
    expect(createSdkOrchestratorBoundary({ transport }).interpret("what needs me")).toEqual({ kind: "briefing" });
  });

  test("capture-idea, open-unit, promote-idea round-trip their fields", () => {
    const idea = fakeTransport(() => ({
      ok: true,
      result: "{}",
      structuredOutput: { kind: "capture-idea", name: "faster-checkout", pitch: "Skip confirmation.", tags: ["speed"] },
    }));
    expect(createSdkOrchestratorBoundary({ transport: idea.transport }).interpret("capture idea")).toEqual({
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
    expect(createSdkOrchestratorBoundary({ transport: unit.transport }).interpret("open a spike")).toEqual({
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
    expect(createSdkOrchestratorBoundary({ transport: promote.transport }).interpret("promote that idea")).toEqual({
      kind: "promote-idea",
      idea: "loyalty-program",
      project: "storefront",
      unit: "loyalty-inception",
    });
  });

  test("a transport failure never fabricates an intent — falls back to unknown", () => {
    const { transport } = fakeTransport(() => ({ ok: false, error: "worker timed out" }));
    const boundary = createSdkOrchestratorBoundary({ transport });
    expect(boundary.interpret("approve x")).toEqual({ kind: "unknown", text: "approve x" });
  });

  test("malformed structured_output (missing required fields, bad verb) falls back to unknown, never throws", () => {
    const missing = fakeTransport(() => ({ ok: true, result: "{}", structuredOutput: { kind: "gate-decision" } }));
    expect(createSdkOrchestratorBoundary({ transport: missing.transport }).interpret("approve x")).toEqual({ kind: "unknown", text: "approve x" });

    const badVerb = fakeTransport(() => ({ ok: true, result: "{}", structuredOutput: { kind: "gate-decision", target: "t", verb: "yeet" } }));
    expect(createSdkOrchestratorBoundary({ transport: badVerb.transport }).interpret("approve x")).toEqual({ kind: "unknown", text: "approve x" });

    const notAnObject = fakeTransport(() => ({ ok: true, result: "{}", structuredOutput: "not an object" }));
    expect(createSdkOrchestratorBoundary({ transport: notAnObject.transport }).interpret("hi")).toEqual({ kind: "unknown", text: "hi" });
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
  test("returns the model's final text", () => {
    const { transport, calls } = fakeTransport(() => ({ ok: true, result: "Nothing needs a decision right now." }));
    const boundary = createSdkOrchestratorBoundary({ transport });
    expect(boundary.narrate("Nothing needs you right now.")).toBe("Nothing needs a decision right now.");
    expect(calls[0].tools).toEqual([]);
    expect(calls[0].outputFormat).toBeUndefined();
  });

  test("a transport failure falls back to the plain computed fact, never a fabricated line", () => {
    const { transport } = fakeTransport(() => ({ ok: false, error: "network unreachable" }));
    const boundary = createSdkOrchestratorBoundary({ transport });
    expect(boundary.narrate("3 gates open.")).toBe("3 gates open.");
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

  test("ANTHROPIC_API_KEY present → the real SDK-driven boundary, proven by it actually invoking the transport", () => {
    const { transport, calls } = fakeTransport(() => ({ ok: true, result: "{}", structuredOutput: { kind: "stats" } }));
    const boundary = selectOrchestratorBoundary({ ANTHROPIC_API_KEY: "sk-ant-test-not-real" }, { transport });
    expect(boundary).not.toBe(deterministicBoundary);
    const intent = boundary.interpret("stats");
    expect(intent).toEqual({ kind: "stats" });
    expect(calls).toHaveLength(1); // proves this call actually went through the (fake) SDK transport
  });
});

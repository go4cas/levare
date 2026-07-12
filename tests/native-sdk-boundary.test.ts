import { test, expect, describe } from "bun:test";
import { createSdkNativeBoundary, AdapterError, type InvokeRequest } from "../src/adapters.ts";
import type { SdkTransport, SdkWorkerRequest, SdkWorkerResponse } from "../src/sdk-transport.ts";
import type { Agent } from "../src/types.ts";

// Phase 7: NativeBoundary backed by the real SDK, mocked at the transport level (same pattern as
// tests/orchestrator-sdk.test.ts) — no test here spawns the worker subprocess or needs a real key.

function fakeTransport(handler: (req: SdkWorkerRequest) => SdkWorkerResponse): { transport: SdkTransport; calls: SdkWorkerRequest[] } {
  const calls: SdkWorkerRequest[] = [];
  return { calls, transport: { run: (req) => (calls.push(req), handler(req)) } };
}

function agent(over: Partial<Agent> = {}): Agent {
  return { name: "lyra", kind: "native", model: "claude-opus-4-8", style: { avatar: "L" }, body: "You design flows.", ...over };
}

function req(over: Partial<InvokeRequest> = {}): InvokeRequest {
  return {
    agent: agent(),
    member: "lyra",
    kind: "spec",
    unit: "checkout-flow",
    project: "storefront",
    context: "── 1. agent · lyra ──\nYou design flows.\n",
    env: { PATH: "/bin", HOME: "/h" },
    tools: ["read", "write"],
    ...over,
  };
}

describe("createSdkNativeBoundary (mocked transport)", () => {
  test("invokes the transport with the assembled context, model, and tool allowlist; returns the doc", () => {
    const { transport, calls } = fakeTransport(() => ({ ok: true, result: "---\nkind: spec\n---\n\nbody" }));
    const boundary = createSdkNativeBoundary({ transport, env: { PATH: "/bin" } });
    const { doc } = boundary.invoke(req());
    expect(doc).toBe("---\nkind: spec\n---\n\nbody");
    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toBe("── 1. agent · lyra ──\nYou design flows.\n");
    expect(calls[0].model).toBe("claude-opus-4-8");
    expect(calls[0].tools).toEqual(["read", "write"]);
    expect(calls[0].allowedTools).toEqual(["read", "write"]);
  });

  test("forwards ANTHROPIC_API_KEY into the spawn env even though it is never a connector grant", () => {
    let seenEnv: Record<string, string | undefined> = {};
    const transport: SdkTransport = {
      run(_r, opts) {
        seenEnv = opts.env;
        return { ok: true, result: "doc" };
      },
    };
    const boundary = createSdkNativeBoundary({ transport, env: { ANTHROPIC_API_KEY: "sk-ant-fake-for-test" } });
    boundary.invoke(req({ env: { PATH: "/bin", HOME: "/h" } }));
    expect(seenEnv.ANTHROPIC_API_KEY).toBe("sk-ant-fake-for-test");
    expect(seenEnv.PATH).toBe("/bin");
    // GITHUB_TOKEN was never in req.env (lyra grants no connector) and must not appear either.
    expect(seenEnv.GITHUB_TOKEN).toBeUndefined();
  });

  test("a transport failure is a hard AdapterError, never a fabricated doc", () => {
    const { transport } = fakeTransport(() => ({ ok: false, error: "worker exited 1" }));
    const boundary = createSdkNativeBoundary({ transport });
    expect(() => boundary.invoke(req())).toThrow(AdapterError);
    expect(() => boundary.invoke(req())).toThrow(/worker exited 1/);
  });
});

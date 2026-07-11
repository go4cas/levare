import { test, expect, describe } from "bun:test";
import { loadRepo } from "../src/repo.ts";
import { loadPricing } from "../src/pricing.ts";
import { AdapterRunner, AdapterError, type CliSpawn, type InvokeRequest, type NativeBoundary, type RemoteBoundary, type SpawnResult } from "../src/adapters.ts";
import { render } from "../fixtures/stubs/member-stub.ts";

// The three adapters dispatch by agent kind. CLI is tested against the fixture stub (real spawn path
// via an injected CliSpawn); native against a mocked SDK boundary; remote against a mocked MCP call.
// All three normalize a §10 receipt, recording `unreported` when the member gives nothing.

const ROOT = "fixtures/golden";
const pricing = loadPricing(ROOT);

// A native boundary that returns the canned stub artifact — the "mocked SDK boundary" of §11 phase 3.
const nativeMock: NativeBoundary = { invoke: (r) => ({ doc: render(r.member, r.kind, r.unit, r.project) }) };
const remoteMock: RemoteBoundary = { call: (r) => ({ doc: render(r.member, r.kind, r.unit, r.project) }) };

// A CliSpawn that runs the stub renderer in-process (no real subprocess), capturing what argv/env it
// was handed so tests can assert the adapter drove it correctly.
function fakeSpawn(capture?: { argv?: string[]; env?: Record<string, string> }): CliSpawn {
  return {
    run(argv, opts): SpawnResult {
      if (capture) {
        capture.argv = argv;
        capture.env = opts.env;
      }
      // argv = [interp, stub, member, kind, --unit, u, --project, p]
      const [, , member, kind, , unit, , project] = argv;
      return { stdout: render(member, kind, unit, project), exitCode: 0, timedOut: false };
    },
  };
}

const stubCliCommand = (r: InvokeRequest) => ["bun", "stub", r.member, r.kind, "--unit", r.unit, "--project", r.project];

describe("native adapter (mocked SDK boundary)", () => {
  test("invokes the native boundary and normalizes a priced receipt", () => {
    const repo = loadRepo(ROOT);
    const runner = new AdapterRunner(repo, {
      pricing,
      capabilities: [{ member: "lyra", kind: "spec" }],
      native: nativeMock,
      remote: remoteMock,
    });
    const { doc, receipt } = runner.produce("lyra", "spec", "checkout-flow", "storefront");
    expect(doc).toContain("id: spec-checkout-flow-v1");
    expect(receipt.unreported).toBe(false);
    expect(receipt.usd).toBe(0.24); // derived from the pricing table
    expect(receipt.wall_clock_s).toBe(480);
  });

  test("passes the agent's tool allowlist and scoped env to the boundary", () => {
    const repo = loadRepo(ROOT);
    let seen: InvokeRequest | null = null;
    const spy: NativeBoundary = { invoke: (r) => ((seen = r), { doc: render(r.member, r.kind, r.unit, r.project) }) };
    const runner = new AdapterRunner(repo, {
      pricing,
      capabilities: [{ member: "lyra", kind: "spec" }],
      native: spy,
      remote: remoteMock,
      baseEnv: { PATH: "/bin", HOME: "/h", GITHUB_TOKEN: "secret" },
    });
    runner.produce("lyra", "spec", "checkout-flow", "storefront");
    expect(seen!.tools).toEqual(["read", "write"]);
    // lyra grants no connector → GITHUB_TOKEN must not appear in its scoped env.
    expect(seen!.env.GITHUB_TOKEN).toBeUndefined();
    expect(seen!.env.PATH).toBe("/bin");
  });
});

describe("cli adapter (against the fixture stub)", () => {
  test("spawns the stub and records an `unreported` receipt for the silent Codex member", () => {
    const repo = loadRepo(ROOT);
    const runner = new AdapterRunner(repo, {
      pricing,
      capabilities: [{ member: "finch", kind: "review" }],
      native: nativeMock,
      remote: remoteMock,
      spawn: fakeSpawn(),
      cliCommand: stubCliCommand,
    });
    const { doc, receipt } = runner.produce("finch", "review", "checkout-flow", "storefront");
    expect(doc).toContain("id: review-checkout-flow-v1");
    expect(receipt.unreported).toBe(true);
    expect(receipt.usd).toBe(null);
  });

  test("spawns with the allowlisted env only (finch grants no connectors)", () => {
    const repo = loadRepo(ROOT);
    const cap: { argv?: string[]; env?: Record<string, string> } = {};
    const runner = new AdapterRunner(repo, {
      pricing,
      capabilities: [{ member: "finch", kind: "review" }],
      native: nativeMock,
      remote: remoteMock,
      spawn: fakeSpawn(cap),
      cliCommand: stubCliCommand,
      baseEnv: { PATH: "/bin", HOME: "/h", GITHUB_TOKEN: "secret" },
    });
    runner.produce("finch", "review", "checkout-flow", "storefront");
    expect(cap.env!.GITHUB_TOKEN).toBeUndefined();
    expect(Object.keys(cap.env!).sort()).toEqual(["HOME", "PATH"]);
  });

  test("a non-zero exit is a hard error (the contract is enforced at the boundary)", () => {
    const repo = loadRepo(ROOT);
    const failing: CliSpawn = { run: () => ({ stdout: "", exitCode: 3, timedOut: false }) };
    const runner = new AdapterRunner(repo, {
      pricing,
      capabilities: [{ member: "finch", kind: "review" }],
      native: nativeMock,
      remote: remoteMock,
      spawn: failing,
      cliCommand: stubCliCommand,
    });
    expect(() => runner.produce("finch", "review", "checkout-flow", "storefront")).toThrow(/exited 3/);
  });

  test("a timeout kills the member and escalates", () => {
    const repo = loadRepo(ROOT);
    const slow: CliSpawn = { run: () => ({ stdout: "", exitCode: -1, timedOut: true }) };
    const runner = new AdapterRunner(repo, {
      pricing,
      capabilities: [{ member: "finch", kind: "review" }],
      native: nativeMock,
      remote: remoteMock,
      spawn: slow,
      cliCommand: stubCliCommand,
    });
    expect(() => runner.produce("finch", "review", "checkout-flow", "storefront")).toThrow(/timed out/);
  });

  test("the real Bun.spawn path executes the stub end-to-end", () => {
    // No injected spawn: uses the default bunSpawn against the actual stub CLI file.
    const repo = loadRepo(ROOT);
    const stubPath = Bun.fileURLToPath(new URL("../fixtures/stubs/member-stub.ts", import.meta.url));
    const runner = new AdapterRunner(repo, {
      pricing,
      capabilities: [{ member: "finch", kind: "review" }],
      native: nativeMock,
      remote: remoteMock,
      cliCommand: (r) => [process.execPath, stubPath, r.member, r.kind, "--unit", r.unit, "--project", r.project],
    });
    const { doc } = runner.produce("finch", "review", "checkout-flow", "storefront");
    expect(doc).toContain("kind: review");
  });
});

describe("remote adapter (mocked MCP)", () => {
  test("routes a remote agent through the MCP boundary and normalizes the receipt", () => {
    const repo = loadRepo(ROOT);
    // Synthesize a remote agent by cloning lyra's def with kind swapped.
    repo.agents.set("echo", { ...repo.agents.get("lyra")!, name: "echo", kind: "remote", server: "echo-mcp", model: undefined });
    let called = false;
    const remote: RemoteBoundary = {
      call: (r) => {
        called = true;
        expect(r.agent.kind).toBe("remote");
        return { doc: render("lyra", "spec", r.unit, r.project) };
      },
    };
    const runner = new AdapterRunner(repo, {
      pricing,
      capabilities: [{ member: "echo", kind: "spec" }],
      native: nativeMock,
      remote,
    });
    const { receipt } = runner.produce("echo", "spec", "checkout-flow", "storefront");
    expect(called).toBe(true);
    expect(receipt.usd).toBe(0.24);
  });
});

describe("dispatch errors", () => {
  test("producing for an unknown member is a hard error", () => {
    const repo = loadRepo(ROOT);
    const runner = new AdapterRunner(repo, { pricing, capabilities: [], native: nativeMock, remote: remoteMock });
    expect(() => runner.produce("ghost", "spec", "u", "storefront")).toThrow(AdapterError);
  });
});

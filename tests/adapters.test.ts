import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    // Synthesize a remote agent by cloning lyra's def with kind swapped, and enrol it in the team so
    // context assembly resolves cleanly (no genuine recipe error).
    repo.agents.set("echo", { ...repo.agents.get("lyra")!, name: "echo", kind: "remote", server: "echo-mcp", model: undefined });
    repo.teams.get("kestrel")!.members.push("echo");
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

// ---------------------------------------------------------------------------
// Command injection — a substituted {placeholder} is always exactly one argv element
// ---------------------------------------------------------------------------

describe("cli argv is structured — no shell re-splitting (BLOCKING)", () => {
  // A runner over finch, whose command template is [codex, review, --input, {task}, --repo, {feature_repo}].
  // The default (non-stub) cliCommand builder does the substitution; a spy CliSpawn captures the argv.
  function finchRunner(capture: { argv?: string[] }) {
    const repo = loadRepo(ROOT);
    const spy: CliSpawn = {
      run(argv): SpawnResult {
        capture.argv = argv;
        return { stdout: render("finch", "review", "checkout-flow", "storefront"), exitCode: 0, timedOut: false };
      },
    };
    return new AdapterRunner(repo, {
      pricing,
      capabilities: [{ member: "finch", kind: "review" }],
      native: nativeMock,
      remote: remoteMock,
      spawn: spy,
      // NB: no cliCommand override — this exercises the real defaultCliCommand substitution path.
    });
  }

  // Each hostile task string must land in exactly the `--input` slot as ONE argument, untouched.
  for (const task of ["a b", 'a"b', "; rm -rf .", "$(whoami)", "a\tb", "&& echo pwned"]) {
    test(`task ${JSON.stringify(task)} arrives as a single argv element, never re-split`, () => {
      const cap: { argv?: string[] } = {};
      finchRunner(cap).produce("finch", task, "checkout-flow", "storefront");
      const argv = cap.argv!;
      // The template has 6 slots; substitution must not change the element count.
      expect(argv.length).toBe(6);
      expect(argv).toEqual(["codex", "review", "--input", task, "--repo", "{feature_repo}"]);
      // The dangerous string is one element — it never leaks into adjacent slots.
      expect(argv[3]).toBe(task);
    });
  }

  test("shell-less spawn executes nothing — a metacharacter task deletes no file", () => {
    // A cli agent whose command echoes {task}. Run it for real via the default bunSpawn.
    const repo = loadRepo(ROOT);
    const dir = mkdtempSync(join(tmpdir(), "levare-inject-"));
    const marker = join(dir, "MARKER");
    writeFileSync(marker, "intact");
    repo.agents.set("echoer", { ...repo.agents.get("finch")!, name: "echoer", command: ["echo", "{task}"], cwd: undefined });
    repo.teams.get("kestrel")!.members.push("echoer");
    const runner = new AdapterRunner(repo, {
      pricing,
      capabilities: [{ member: "echoer", kind: "review" }],
      native: nativeMock,
      remote: remoteMock,
    });
    try {
      const task = `hello ; rm -f ${marker}`;
      const { doc } = runner.produce("echoer", task, "checkout-flow", "storefront");
      // echo printed the whole task as one argument; the embedded `rm` never ran.
      expect(doc.trim()).toBe(task);
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf8")).toBe("intact");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Timeout is a DISTINCT failure from a non-zero exit (§6, phase-3 fix-up)
// ---------------------------------------------------------------------------

describe("timeout vs. exit-code, kept distinct", () => {
  const baseOpts = (spawn: CliSpawn) => ({
    pricing,
    capabilities: [{ member: "finch", kind: "review" }],
    native: nativeMock,
    remote: remoteMock,
    spawn,
    cliCommand: stubCliCommand,
  });

  test("a slow-but-SUCCESSFUL member (exit 0, not timed out) is NOT misread as timed out", () => {
    const repo = loadRepo(ROOT);
    const slowOk: CliSpawn = { run: () => ({ stdout: render("finch", "review", "checkout-flow", "storefront"), exitCode: 0, timedOut: false }) };
    const { receipt } = new AdapterRunner(repo, baseOpts(slowOk)).produce("finch", "review", "checkout-flow", "storefront");
    expect(receipt.unreported).toBe(true); // finch reports nothing, but it SUCCEEDED
  });

  test("a genuine timeout throws a timeout error, distinct from a non-zero exit", () => {
    const repo = loadRepo(ROOT);
    const timedOut: CliSpawn = { run: () => ({ stdout: "", exitCode: -1, timedOut: true }) };
    expect(() => new AdapterRunner(repo, baseOpts(timedOut)).produce("finch", "review", "checkout-flow", "storefront")).toThrow(/timed out/);
    const nonZero: CliSpawn = { run: () => ({ stdout: "", exitCode: 7, timedOut: false }) };
    expect(() => new AdapterRunner(repo, baseOpts(nonZero)).produce("finch", "review", "checkout-flow", "storefront")).toThrow(/exited 7/);
  });

  test("the real bunSpawn maps Bun's own timeout flag (a sleeping member is killed and reported)", () => {
    const repo = loadRepo(ROOT);
    // A cli agent that sleeps far longer than its 1s timeout.
    repo.agents.set("sleeper", { ...repo.agents.get("finch")!, name: "sleeper", command: ["sleep", "10"], cwd: undefined, timeout: 1 });
    repo.teams.get("kestrel")!.members.push("sleeper");
    const runner = new AdapterRunner(repo, { pricing, capabilities: [{ member: "sleeper", kind: "review" }], native: nativeMock, remote: remoteMock });
    expect(() => runner.produce("sleeper", "review", "checkout-flow", "storefront")).toThrow(/timed out/);
  });
});

// ---------------------------------------------------------------------------
// readUsage validates the usage block shape (§10 fix-up)
// ---------------------------------------------------------------------------

describe("malformed usage records unreported, never a fabricated/crashing receipt", () => {
  function runnerFor(doc: string) {
    const repo = loadRepo(ROOT);
    const native: NativeBoundary = { invoke: () => ({ doc }) };
    return new AdapterRunner(repo, { pricing, capabilities: [{ member: "lyra", kind: "spec" }], native, remote: remoteMock });
  }
  const frame = (usageBlock: string) =>
    ["---", "kind: spec", "id: spec-x", "unit: checkout-flow", "project: storefront", "status: in-review", "produced_by: kestrel/lyra", "consumes: []", "supersedes: null", "approved_by: null", "created: 2026-07-11", "files: []", usageBlock, "---", "", "# spec", "", "body"].join("\n");

  test("a usage field that is a scalar (not a map) → unreported", () => {
    const { receipt } = runnerFor(frame("usage: not-a-map")).produce("lyra", "spec", "checkout-flow", "storefront");
    expect(receipt.unreported).toBe(true);
    expect(receipt.usd).toBe(null);
  });

  test("a usage map with a wrong-typed numeric field → unreported (no NaN estimate)", () => {
    const { receipt } = runnerFor(frame("usage:\n  model: claude-sonnet\n  tokens_in: lots\n  tokens_out: 10\n  usd: null\n  wall_clock_s: 5")).produce("lyra", "spec", "checkout-flow", "storefront");
    expect(receipt.unreported).toBe(true);
    expect(Number.isNaN(receipt.usd as number)).toBe(false);
    expect(receipt.usd).toBe(null);
  });

  test("a well-formed usage map is still priced normally", () => {
    const { receipt } = runnerFor(frame("usage:\n  model: claude-sonnet\n  tokens_in: 8200\n  tokens_out: 2100\n  usd: null\n  wall_clock_s: 95")).produce("lyra", "spec", "checkout-flow", "storefront");
    expect(receipt.unreported).toBe(false);
    expect(receipt.usd).toBe(0.06);
  });
});

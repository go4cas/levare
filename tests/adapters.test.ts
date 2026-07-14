import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRepo } from "../src/repo.ts";
import { assembleContext } from "../src/context.ts";
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
  // Ruling C12: levare authors the id (unit-scoped convention), never trusting whatever the mocked
  // boundary's own doc claims. The boundary reports no receipt here, so the doc's own canned usage
  // block (self-reported) is discarded unread — never re-derived into a fabricated priced receipt.
  test("invokes the native boundary; levare authors the id, and an unreported boundary receipt is never re-derived from the doc's own usage block", () => {
    const repo = loadRepo(ROOT);
    const runner = new AdapterRunner(repo, {
      pricing,
      capabilities: [{ member: "lyra", kind: "spec" }],
      native: nativeMock,
      remote: remoteMock,
    });
    const { doc, receipt } = runner.produce("lyra", "spec", "checkout-flow", "storefront");
    expect(doc).toContain("id: spec-checkout-flow-v1");
    expect(receipt.unreported).toBe(true);
    expect(receipt.usd).toBe(null);
    expect(doc).not.toContain("usage:");
    expect(doc).not.toContain("31000"); // the stub's own canned token count never leaks in.
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

  // NOTES F8 — the fabricated-usage dogfood defect: a native member's receipt must come from the SDK's
  // own report (whatever the boundary returns), never re-derived from the doc's frontmatter/pricing
  // table when the boundary actually reported one.
  test("a receipt reported by the native boundary is used verbatim, not re-priced from the doc", () => {
    const repo = loadRepo(ROOT);
    // Matches lyra's own declared model (fixtures/golden/agents/lyra.md) — this test is about receipt
    // FIDELITY (verbatim passthrough, never re-priced), not the NOTES F11 requested-vs-actual guard;
    // see the dedicated describe block below for that.
    const sdkReceipt = { model: "claude-sonnet-5", tokens_in: 9001, tokens_out: 42, wall_clock_s: 3.5, usd: 0.0007, unreported: false };
    const native: NativeBoundary = { invoke: (r) => ({ doc: render(r.member, r.kind, r.unit, r.project), receipt: sdkReceipt }) };
    const runner = new AdapterRunner(repo, { pricing, capabilities: [{ member: "lyra", kind: "spec" }], native, remote: remoteMock });
    const { receipt } = runner.produce("lyra", "spec", "checkout-flow", "storefront");
    expect(receipt).toEqual(sdkReceipt);
    // Not the pricing-table-derived figure the doc's own canned usage block would produce (0.24, 480s).
    expect(receipt.usd).not.toBe(0.24);
    expect(receipt.wall_clock_s).not.toBe(480);
  });

  // NOTES F11: end-to-end — the agent's OWN declared model reaches the native boundary's request, and
  // the resulting artifact's usage receipt names that SAME model, never a boundary/SDK default that
  // silently diverges from what the agent declared.
  test("the native boundary is invoked with the agent's declared model, and the produced artifact's usage receipt names that same model", () => {
    const repo = loadRepo(ROOT);
    let seen: InvokeRequest | null = null;
    const native: NativeBoundary = {
      invoke: (r) => {
        seen = r;
        // A real SDK call reports back the model it actually ran — here, exactly what it was asked for.
        return { doc: render(r.member, r.kind, r.unit, r.project), receipt: { model: r.agent.model!, tokens_in: 100, tokens_out: 50, wall_clock_s: 2, usd: 0.01, unreported: false } };
      },
    };
    const runner = new AdapterRunner(repo, { pricing, capabilities: [{ member: "lyra", kind: "spec" }], native, remote: remoteMock });
    const { doc, receipt } = runner.produce("lyra", "spec", "checkout-flow", "storefront");
    expect(seen!.agent.model).toBe("claude-sonnet-5"); // lyra's own declared model (fixtures/golden/agents/lyra.md)
    expect(receipt.model).toBe("claude-sonnet-5");
    expect(doc).toContain("model: claude-sonnet-5");
  });

  // NOTES F11 part 2 — THE GUARD: the SDK can silently substitute its own default model when a call
  // doesn't run on the one requested, with no error and no warning; the only honest defence is
  // comparing what levare asked for against what its own receipt reports. Never a warning, never an
  // in-review artifact carrying unauthorised/unbudgeted work — a hard failure (AdapterError), which
  // dagwalk.ts#produceOne's existing member-failure handling turns into a `blocked` artifact naming
  // both models — proven end to end in tests/daemon.test.ts's own describe block for this guard.
  describe("a native member's receipt naming a DIFFERENT model than declared is a hard failure, never a silent in-review artifact", () => {
    test("produce() throws AdapterError naming both the declared and the actually-reported model", () => {
      const repo = loadRepo(ROOT);
      const native: NativeBoundary = {
        invoke: (r) => ({ doc: render(r.member, r.kind, r.unit, r.project), receipt: { model: "claude-haiku-4-5-20251001", tokens_in: 10, tokens_out: 5, wall_clock_s: 1, usd: 0.001, unreported: false } }),
      };
      const runner = new AdapterRunner(repo, { pricing, capabilities: [{ member: "lyra", kind: "spec" }], native, remote: remoteMock });
      expect(() => runner.produce("lyra", "spec", "checkout-flow", "storefront")).toThrow(AdapterError);
      try {
        runner.produce("lyra", "spec", "checkout-flow", "storefront");
        throw new Error("expected produce() to throw");
      } catch (e) {
        expect(e).toBeInstanceOf(AdapterError);
        const msg = (e as Error).message;
        expect(msg).toContain("claude-sonnet-5"); // declared (fixtures/golden/agents/lyra.md)
        expect(msg).toContain("claude-haiku-4-5-20251001"); // what the receipt actually reported
      }
    });

    test("produceAsync() applies the same guard", async () => {
      const repo = loadRepo(ROOT);
      const asyncNative = {
        invoke: async (r: InvokeRequest) => ({ doc: render(r.member, r.kind, r.unit, r.project), receipt: { model: "claude-opus-4-8", tokens_in: 10, tokens_out: 5, wall_clock_s: 1, usd: 0.001, unreported: false } }),
      };
      const runner = new AdapterRunner(repo, { pricing, capabilities: [{ member: "lyra", kind: "spec" }], native: nativeMock, asyncNative, remote: remoteMock });
      await expect(runner.produceAsync("lyra", "spec", "checkout-flow", "storefront")).rejects.toThrow(AdapterError);
      await expect(runner.produceAsync("lyra", "spec", "checkout-flow", "storefront")).rejects.toThrow(/claude-sonnet-5.*claude-opus-4-8|claude-opus-4-8.*claude-sonnet-5/);
    });

    test("an UNREPORTED receipt (no model claim at all) is never treated as a mismatch — nothing to compare against", () => {
      const repo = loadRepo(ROOT);
      const native: NativeBoundary = { invoke: (r) => ({ doc: render(r.member, r.kind, r.unit, r.project) }) }; // no receipt at all → unreported
      const runner = new AdapterRunner(repo, { pricing, capabilities: [{ member: "lyra", kind: "spec" }], native, remote: remoteMock });
      const { receipt } = runner.produce("lyra", "spec", "checkout-flow", "storefront");
      expect(receipt.unreported).toBe(true);
    });

    test("a matching model never triggers the guard", () => {
      const repo = loadRepo(ROOT);
      const native: NativeBoundary = {
        invoke: (r) => ({ doc: render(r.member, r.kind, r.unit, r.project), receipt: { model: r.agent.model!, tokens_in: 10, tokens_out: 5, wall_clock_s: 1, usd: 0.001, unreported: false } }),
      };
      const runner = new AdapterRunner(repo, { pricing, capabilities: [{ member: "lyra", kind: "spec" }], native, remote: remoteMock });
      expect(() => runner.produce("lyra", "spec", "checkout-flow", "storefront")).not.toThrow();
    });
  });

  test("produceAsync prefers `asyncNative` over `native` for a native member, and its receipt passes through the same way", async () => {
    const repo = loadRepo(ROOT);
    const sdkReceipt = { model: "claude-sonnet-5", tokens_in: 111, tokens_out: 22, wall_clock_s: 1.1, usd: 0.003, unreported: false };
    const syncNative: NativeBoundary = { invoke: () => { throw new Error("must not be called — asyncNative takes precedence"); } };
    const asyncNative = { invoke: async (r: InvokeRequest) => ({ doc: render(r.member, r.kind, r.unit, r.project), receipt: sdkReceipt }) };
    const runner = new AdapterRunner(repo, { pricing, capabilities: [{ member: "lyra", kind: "spec" }], native: syncNative, asyncNative, remote: remoteMock });
    const { doc, receipt } = await runner.produceAsync("lyra", "spec", "checkout-flow", "storefront");
    expect(doc).toContain("id: spec-checkout-flow-v1");
    expect(receipt).toEqual(sdkReceipt);
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

  // -------------------------------------------------------------------------
  // NOTES F3: "exited N" is a symptom, not a diagnosis — the member's own stderr and the argv it was
  // handed must reach the thrown error (and, from there, the blocked artifact — see dagwalk.ts's
  // writeBlocked, which uses this message verbatim).
  // -------------------------------------------------------------------------

  test("a non-zero exit's stderr reaches the thrown error, alongside the argv", () => {
    const repo = loadRepo(ROOT);
    const failing: CliSpawn = { run: () => ({ stdout: "", exitCode: 1, timedOut: false, stderr: "rook: license check failed\nexiting\n" }) };
    const runner = new AdapterRunner(repo, {
      pricing,
      capabilities: [{ member: "finch", kind: "review" }],
      native: nativeMock,
      remote: remoteMock,
      spawn: failing,
      cliCommand: stubCliCommand,
    });
    let caught: unknown;
    try {
      runner.produce("finch", "review", "checkout-flow", "storefront");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AdapterError);
    const msg = (caught as Error).message;
    expect(msg).toContain("exited 1");
    expect(msg).toContain("rook: license check failed");
    expect(msg).toContain('"bun"'); // the argv (stubCliCommand's first element) is present too.
  });

  test("stderr is truncated to the last 2000 chars — an unbounded member never grows the reason without bound", () => {
    const repo = loadRepo(ROOT);
    const longStderr = "x".repeat(3000) + "TAIL-MARKER";
    const failing: CliSpawn = { run: () => ({ stdout: "", exitCode: 1, timedOut: false, stderr: longStderr }) };
    const runner = new AdapterRunner(repo, {
      pricing,
      capabilities: [{ member: "finch", kind: "review" }],
      native: nativeMock,
      remote: remoteMock,
      spawn: failing,
      cliCommand: stubCliCommand,
    });
    let caught: unknown;
    try {
      runner.produce("finch", "review", "checkout-flow", "storefront");
    } catch (e) {
      caught = e;
    }
    const msg = (caught as Error).message;
    expect(msg).toContain("TAIL-MARKER");
    // The leading "x"*3000 is truncated to (at most) 2000 chars — the whole message stays well under
    // stderr's own 3011-char length plus the rest of the message scaffolding.
    expect(msg.length).toBeLessThan(longStderr.length);
  });

  test("a timeout's stderr is also surfaced — a killed member's last words are not thrown away", () => {
    const repo = loadRepo(ROOT);
    const slow: CliSpawn = { run: () => ({ stdout: "", exitCode: -1, timedOut: true, stderr: "still waiting on upstream...\n" }) };
    const runner = new AdapterRunner(repo, {
      pricing,
      capabilities: [{ member: "finch", kind: "review" }],
      native: nativeMock,
      remote: remoteMock,
      spawn: slow,
      cliCommand: stubCliCommand,
    });
    expect(() => runner.produce("finch", "review", "checkout-flow", "storefront")).toThrow(/still waiting on upstream/);
  });

  // -------------------------------------------------------------------------
  // NOTES F3: pre-flight the spawn. This guards ONLY the real `bunSpawn` boundary — the one that
  // actually hands argv to the OS and can fail with an opaque, contextless nonzero exit (or, for a bad
  // cwd, a bare filesystem error with no member context at all). A test-injected `CliSpawn` (used
  // throughout the rest of this file, including with intentionally-unreal argv like "codex", which
  // this sandbox never installs) is a pure stand-in and never touches the filesystem or PATH, so it is
  // never subject to the failure mode this guards against — see adapters.ts#runCli's `this.spawn ===
  // bunSpawn` check.
  // -------------------------------------------------------------------------

  describe("pre-flight checks the real spawn boundary before invoking it (NOTES F3)", () => {
    test("a nonexistent cwd blocks with a precise reason, and Bun.spawn never runs", () => {
      const repo = loadRepo(ROOT);
      const dir = mkdtempSync(join(tmpdir(), "levare-preflight-"));
      const marker = join(dir, "MARKER");
      writeFileSync(marker, "intact");
      const missingCwd = join(dir, "does-not-exist");
      repo.agents.set("ghostcwd", { ...repo.agents.get("finch")!, name: "ghostcwd", command: ["rm", "-f", marker], cwd: missingCwd });
      repo.teams.get("kestrel")!.members.push("ghostcwd");
      const runner = new AdapterRunner(repo, { pricing, capabilities: [{ member: "ghostcwd", kind: "review" }], native: nativeMock, remote: remoteMock });
      try {
        expect(() => runner.produce("ghostcwd", "review", "checkout-flow", "storefront")).toThrow(`agent 'ghostcwd': cwd '${missingCwd}' does not exist`);
        expect(existsSync(marker)).toBe(true); // the `rm` argv was never spawned.
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("a cwd that is a file, not a directory, blocks with a precise reason", () => {
      const repo = loadRepo(ROOT);
      const dir = mkdtempSync(join(tmpdir(), "levare-preflight-"));
      const notADir = join(dir, "im-a-file");
      writeFileSync(notADir, "not a directory");
      repo.agents.set("ghostfilecwd", { ...repo.agents.get("finch")!, name: "ghostfilecwd", command: ["echo", "hi"], cwd: notADir });
      repo.teams.get("kestrel")!.members.push("ghostfilecwd");
      const runner = new AdapterRunner(repo, { pricing, capabilities: [{ member: "ghostfilecwd", kind: "review" }], native: nativeMock, remote: remoteMock });
      try {
        expect(() => runner.produce("ghostfilecwd", "review", "checkout-flow", "storefront")).toThrow(`agent 'ghostfilecwd': cwd '${notADir}' is not a directory`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("an unresolvable bare argv[0] (not on PATH) blocks with a precise reason before spawn", () => {
      const repo = loadRepo(ROOT);
      repo.agents.set("ghostcmd", {
        ...repo.agents.get("finch")!,
        name: "ghostcmd",
        command: ["levare-definitely-not-a-real-binary-xyz", "--version"],
        cwd: undefined,
      });
      repo.teams.get("kestrel")!.members.push("ghostcmd");
      const runner = new AdapterRunner(repo, { pricing, capabilities: [{ member: "ghostcmd", kind: "review" }], native: nativeMock, remote: remoteMock });
      expect(() => runner.produce("ghostcmd", "review", "checkout-flow", "storefront")).toThrow(
        "agent 'ghostcmd': command 'levare-definitely-not-a-real-binary-xyz' not found on PATH",
      );
    });

    test("an absolute argv[0] that does not exist blocks with a precise reason before spawn", () => {
      const repo = loadRepo(ROOT);
      const bogus = "/tmp/levare-does-not-exist-xyz-dir/rook-cli";
      repo.agents.set("ghostabs", { ...repo.agents.get("finch")!, name: "ghostabs", command: [bogus], cwd: undefined });
      repo.teams.get("kestrel")!.members.push("ghostabs");
      const runner = new AdapterRunner(repo, { pricing, capabilities: [{ member: "ghostabs", kind: "review" }], native: nativeMock, remote: remoteMock });
      expect(() => runner.produce("ghostabs", "review", "checkout-flow", "storefront")).toThrow(`agent 'ghostabs': command '${bogus}' is not an executable file`);
    });

    test("a valid, resolvable cwd and argv[0] pass pre-flight — spawn proceeds normally", () => {
      // Regression guard: pre-flight must not falsely reject the ordinary "the real Bun.spawn path
      // executes the stub end-to-end" shape (an absolute interpreter path, no cwd template).
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
    // The remote boundary reports no receipt (§10/ruling C12) — never re-priced from the doc's own
    // self-reported usage block.
    expect(receipt.unreported).toBe(true);
    expect(receipt.usd).toBe(null);
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
// NOTES F7: {task} substitutes the FULL §6-assembled context, never the bare step label — and,
// regardless of what that context contains, a substituted {placeholder} is always exactly one argv
// element (no shell re-splitting).
// ---------------------------------------------------------------------------

describe("cli argv carries the assembled context via {task} — no shell re-splitting (NOTES F7, BLOCKING)", () => {
  // A runner over finch, whose command template is [codex, review, --input, {task}, --repo, {feature_repo}].
  // The default (non-stub) cliCommand builder does the substitution; a spy CliSpawn captures the argv.
  // `agentOverrides` lets a test embed hostile content into a legitimate part of the context recipe
  // (the agent's own definition body, §6 item 1) — the realistic injection surface now that {task} is
  // the full context, not an isolated external string.
  function finchRunner(capture: { argv?: string[] }, agentOverrides: Partial<{ body: string }> = {}) {
    const repo = loadRepo(ROOT);
    if (agentOverrides.body !== undefined) {
      repo.agents.set("finch", { ...repo.agents.get("finch")!, body: agentOverrides.body });
    }
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

  test("{task} substitutes the FULL assembled context, never the bare kind/step label", () => {
    const cap: { argv?: string[] } = {};
    const repo = loadRepo(ROOT);
    const expectedContext = assembleContext(repo, {
      root: ROOT,
      agent: "finch",
      unit: "checkout-flow",
      capabilities: [{ member: "finch", kind: "review" }],
    });
    finchRunner(cap).produce("finch", "review", "checkout-flow", "storefront");
    const argv = cap.argv!;
    expect(argv.length).toBe(6);
    expect(argv).toEqual(["codex", "review", "--input", expectedContext, "--repo", "{feature_repo}"]);
    // The pre-F7 defect: {task} was the bare kind/label, never the assembled recipe.
    expect(argv[3]).not.toBe("review");
    expect(argv[3]).toContain("── 1. agent · finch");
  });

  // Each hostile string, embedded in the agent's own definition body (a real, legitimate part of the
  // context every CLI member receives), must land inside the `--input` slot without ever escaping it.
  for (const hostile of ["a b", 'a"b', "; rm -rf .", "$(whoami)", "a\tb", "&& echo pwned"]) {
    test(`hostile content ${JSON.stringify(hostile)} embedded in context arrives inside a single argv element, never re-split`, () => {
      const cap: { argv?: string[] } = {};
      finchRunner(cap, { body: `finch — a cli member.\n\nPAYLOAD: ${hostile}` }).produce("finch", "review", "checkout-flow", "storefront");
      const argv = cap.argv!;
      // The template has 6 slots; substitution must not change the element count.
      expect(argv.length).toBe(6);
      expect(argv[3]).toContain(hostile);
      // The dangerous string never leaks into an adjacent slot.
      expect(argv[0]).toBe("codex");
      expect(argv[2]).toBe("--input");
      expect(argv[4]).toBe("--repo");
      expect(argv[5]).toBe("{feature_repo}");
    });
  }

  test("shell-less spawn executes nothing — a metacharacter-laden context deletes no file", () => {
    // A cli agent whose command echoes {task} (now the full context). Run it for real via bunSpawn.
    const repo = loadRepo(ROOT);
    const dir = mkdtempSync(join(tmpdir(), "levare-inject-"));
    const marker = join(dir, "MARKER");
    writeFileSync(marker, "intact");
    const hostile = `hello ; rm -f ${marker}`;
    repo.agents.set("echoer", { ...repo.agents.get("finch")!, name: "echoer", command: ["echo", "{task}"], cwd: undefined, body: hostile });
    repo.teams.get("kestrel")!.members.push("echoer");
    const runner = new AdapterRunner(repo, {
      pricing,
      capabilities: [{ member: "echoer", kind: "review" }],
      native: nativeMock,
      remote: remoteMock,
    });
    try {
      const { doc } = runner.produce("echoer", "review", "checkout-flow", "storefront");
      // echo printed the whole context (containing the hostile fragment) as one argument; the
      // embedded `rm` never ran.
      expect(doc).toContain(hostile);
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf8")).toBe("intact");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// NOTES F11: a CLI member's declared `model:` reaches the vendor via a `{model}` argv placeholder,
// exactly like `{task}`/`{feature_repo}` — never silently dropped.
// ---------------------------------------------------------------------------

describe("cli argv carries the agent's declared model via {model} (NOTES F11)", () => {
  test("{model} substitutes the agent's own declared model into the command template", () => {
    const repo = loadRepo(ROOT);
    const cap: { argv?: string[] } = {};
    repo.agents.set("modeled", {
      ...repo.agents.get("finch")!,
      name: "modeled",
      command: ["codex", "review", "--model", "{model}", "--input", "{task}"],
      model: "claude-opus-4-8",
    });
    repo.teams.get("kestrel")!.members.push("modeled");
    const spy: CliSpawn = {
      run(argv): SpawnResult {
        cap.argv = argv;
        return { stdout: render("finch", "review", "checkout-flow", "storefront"), exitCode: 0, timedOut: false };
      },
    };
    const runner = new AdapterRunner(repo, { pricing, capabilities: [{ member: "modeled", kind: "review" }], native: nativeMock, remote: remoteMock, spawn: spy });
    runner.produce("modeled", "review", "checkout-flow", "storefront");
    expect(cap.argv![3]).toBe("claude-opus-4-8");
  });

  test("an agent that declares no model leaves an unused {model} placeholder substituted to empty, never a template literal", () => {
    const repo = loadRepo(ROOT);
    const cap: { argv?: string[] } = {};
    repo.agents.set("modelless", {
      ...repo.agents.get("finch")!,
      name: "modelless",
      command: ["codex", "review", "--model", "{model}"],
      model: undefined,
    });
    repo.teams.get("kestrel")!.members.push("modelless");
    const spy: CliSpawn = {
      run(argv): SpawnResult {
        cap.argv = argv;
        return { stdout: render("finch", "review", "checkout-flow", "storefront"), exitCode: 0, timedOut: false };
      },
    };
    const runner = new AdapterRunner(repo, { pricing, capabilities: [{ member: "modelless", kind: "review" }], native: nativeMock, remote: remoteMock, spawn: spy });
    runner.produce("modelless", "review", "checkout-flow", "storefront");
    expect(cap.argv![3]).toBe("");
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

  // NOTES F5: the daemon/gateops live path's timeout enforcement (asyncBunSpawn) must kill a hung
  // member exactly as the sync bunSpawn boundary already does above — this is the "that part already
  // works" the goal calls out, proven here for the NEW async transport specifically.
  test("the real asyncBunSpawn (non-blocking) also kills a sleeping member on timeout, promptly", async () => {
    const repo = loadRepo(ROOT);
    repo.agents.set("asyncSleeper", { ...repo.agents.get("finch")!, name: "asyncSleeper", command: ["sleep", "10"], cwd: undefined, timeout: 1 });
    repo.teams.get("kestrel")!.members.push("asyncSleeper");
    const runner = new AdapterRunner(repo, { pricing, capabilities: [{ member: "asyncSleeper", kind: "review" }], native: nativeMock, remote: remoteMock });
    const start = Date.now();
    let caught: unknown;
    try {
      await runner.produceAsync("asyncSleeper", "review", "checkout-flow", "storefront");
    } catch (e) {
      caught = e;
    }
    const elapsed = Date.now() - start;
    expect((caught as Error).message).toMatch(/timed out/);
    // Killed at the 1s timeout, not left running for the full 10s sleep — proves the timer-based kill
    // actually fired rather than the call merely eventually resolving on its own.
    expect(elapsed).toBeLessThan(5000);
  });
});

// ---------------------------------------------------------------------------
// Ruling C12: the member authors CONTENT, levare authors the ARTIFACT. A member's raw output is never
// trusted as a document — plain prose is wrapped in levare's own frontmatter; a self-declared
// frontmatter fence (right or wrong) is stripped and discarded before levare writes its own.
// ---------------------------------------------------------------------------

describe("levare authors the artifact frontmatter, never the member (ruling C12)", () => {
  test("a native member returning plain prose (no frontmatter) produces a valid artifact with levare-authored frontmatter and an SDK-reported usage receipt", () => {
    const repo = loadRepo(ROOT);
    const sdkReceipt = { model: "claude-sonnet-5", tokens_in: 500, tokens_out: 200, wall_clock_s: 4.2, usd: 0.012, unreported: false };
    const native: NativeBoundary = {
      invoke: () => ({ doc: "# Spec — checkout-flow\n\nServer-rendered `/checkout`; idempotent payment on an order key.\n", receipt: sdkReceipt }),
    };
    const runner = new AdapterRunner(repo, { pricing, capabilities: [{ member: "lyra", kind: "spec" }], native, remote: remoteMock, now: () => "2026-07-14" });
    const { doc, receipt } = runner.produce("lyra", "spec", "checkout-flow", "storefront");

    expect(doc).toContain("kind: spec");
    expect(doc).toContain("id: spec-checkout-flow-v1");
    expect(doc).toContain("unit: checkout-flow");
    expect(doc).toContain("project: storefront");
    expect(doc).toContain("status: in-review");
    expect(doc).toContain("produced_by: kestrel/lyra");
    // consumes: levare's own record of the unit's currently-approved artifacts — the golden fixture
    // seeds product-brief-v1/design-checkout-v1 as already approved on disk.
    expect(doc).toContain("consumes: [design-checkout-v1, product-brief-v1]");
    expect(doc).toContain("supersedes: null");
    expect(doc).toContain("approved_by: null");
    expect(doc).toContain("created: 2026-07-14");
    expect(doc).toContain("files: []");
    expect(doc).toContain("Server-rendered `/checkout`");
    expect(receipt).toEqual(sdkReceipt);
    expect(doc).toContain("usd: 0.012");
    expect(doc).toContain("tokens_in: 500");
  });

  test("a member that DOES emit a frontmatter fence has it stripped and replaced with levare's own values", () => {
    const repo = loadRepo(ROOT);
    // A "well-behaved" model that guessed at the contract — every field is WRONG (fabricated id,
    // wrong produced_by, a self-reported usage block) except the body, which is the only thing that
    // should survive.
    const hostileDoc = [
      "---",
      "kind: spec",
      "id: totally-made-up-id",
      "unit: some-other-unit",
      "project: some-other-project",
      "status: approved",
      "produced_by: nobody/ghost",
      "consumes: [fabricated-id]",
      "supersedes: spec-old",
      "approved_by: \"self-approved 2020-01-01\"",
      "created: 1999-01-01",
      "files: [fake.txt]",
      "usage:",
      "  model: made-up-model",
      "  tokens_in: 999999",
      "  tokens_out: 999999",
      "  usd: 999.99",
      "  wall_clock_s: 1",
      "---",
      "",
      "# Spec — checkout-flow",
      "",
      "The real body content.",
    ].join("\n");
    const native: NativeBoundary = { invoke: () => ({ doc: hostileDoc }) }; // no boundary-reported receipt.
    const runner = new AdapterRunner(repo, { pricing, capabilities: [{ member: "lyra", kind: "spec" }], native, remote: remoteMock, now: () => "2026-07-14" });
    const { doc, receipt } = runner.produce("lyra", "spec", "checkout-flow", "storefront");

    // The member's self-declared metadata is gone, replaced with levare's own.
    expect(doc).toContain("id: spec-checkout-flow-v1");
    expect(doc).not.toContain("totally-made-up-id");
    expect(doc).toContain("unit: checkout-flow");
    expect(doc).toContain("project: storefront");
    expect(doc).toContain("status: in-review");
    expect(doc).not.toContain("status: approved");
    expect(doc).toContain("produced_by: kestrel/lyra");
    expect(doc).not.toContain("nobody/ghost");
    expect(doc).toContain("supersedes: null");
    expect(doc).not.toContain("spec-old");
    expect(doc).toContain("approved_by: null");
    expect(doc).not.toContain("self-approved");
    expect(doc).toContain("files: []");
    expect(doc).not.toContain("fake.txt");
    // No boundary receipt was reported → unreported, never the member's own fabricated $999.99.
    expect(receipt.unreported).toBe(true);
    expect(doc).not.toContain("999.99");
    expect(doc).not.toContain("made-up-model");
    // Only the body survives, verbatim.
    expect(doc).toContain("The real body content.");
  });

  test("empty content after stripping is a hard error, not a blank artifact", () => {
    const repo = loadRepo(ROOT);
    const native: NativeBoundary = { invoke: () => ({ doc: "---\nkind: spec\n---\n\n   \n" }) };
    const runner = new AdapterRunner(repo, { pricing, capabilities: [{ member: "lyra", kind: "spec" }], native, remote: remoteMock });
    expect(() => runner.produce("lyra", "spec", "checkout-flow", "storefront")).toThrow(/produced no usable content/);
  });

  test("a cli member's raw stdout is likewise authored, never trusted verbatim", () => {
    const repo = loadRepo(ROOT);
    const spawn: CliSpawn = { run: () => ({ stdout: "Approved with one note: name the idempotency key column.", exitCode: 0, timedOut: false }) };
    const runner = new AdapterRunner(repo, { pricing, capabilities: [{ member: "finch", kind: "review" }], native: nativeMock, remote: remoteMock, spawn, cliCommand: stubCliCommand, now: () => "2026-07-14" });
    const { doc, receipt } = runner.produce("finch", "review", "checkout-flow", "storefront");
    expect(doc).toContain("kind: review");
    expect(doc).toContain("id: review-checkout-flow-v1");
    expect(doc).toContain("produced_by: kestrel/finch");
    expect(doc).toContain("Approved with one note");
    expect(receipt.unreported).toBe(true);
  });
});

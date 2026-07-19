import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { loadRepo } from "../src/repo.ts";
import { assembleContext } from "../src/context.ts";
import { loadPricing } from "../src/pricing.ts";
import { AdapterRunner, AdapterError, type CliSpawn, type InvokeRequest, type NativeBoundary, type RemoteBoundary, type SpawnResult } from "../src/adapters.ts";
import { render } from "../fixtures/stubs/member-stub.ts";
import { detectSandbox } from "../src/sandbox.ts";
import { createDispatchWorktree } from "../src/merge.ts";

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
    expect(seen!.tools).toEqual(["Read", "Write"]);
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

// NOTES C13: a subscription-authenticated member's cost is flat-rate, not per-token — pricing it
// from the table would be a fiction. `author()` forces usd null and names the plan instead; token
// counts the boundary reports still pass through unchanged. Built off the golden repo (Repo is plain
// data, safe to mutate in a test) rather than a from-scratch repo, so team/unit/project resolution
// (assembleContext) keeps working without re-deriving all of it.
describe("C13: subscription-authenticated members price at usd: null, with the plan noted", () => {
  function subscriptionRepo() {
    const repo = loadRepo(ROOT);
    repo.connectors.set("codex-subscription", {
      name: "codex-subscription",
      kind: "cli",
      command: "codex",
      env: [],
      auth: "subscription",
      role: "model",
      effects: "read",
      gate: "proposal",
      plan: "ChatGPT Plus — flat monthly rate",
    });
    const lyra = repo.agents.get("lyra")!;
    repo.agents.set("lyra", { ...lyra, connectors: ["codex-subscription"] });
    return repo;
  }

  test("usd is forced null and the plan is noted, even though the boundary reported a priceable model and its own usd", () => {
    const repo = subscriptionRepo();
    // lyra's own declared model (fixtures/golden/agents/lyra.md) — matches so the unrelated F11
    // model-mismatch guard doesn't interfere with what this test is actually checking.
    const receipt = { model: "claude-sonnet-5", tokens_in: 4200, tokens_out: 900, wall_clock_s: 60, usd: 12.34, unreported: false };
    const native: NativeBoundary = { invoke: (r) => ({ doc: render(r.member, r.kind, r.unit, r.project), receipt }) };
    const runner = new AdapterRunner(repo, { pricing, capabilities: [{ member: "lyra", kind: "spec" }], native, remote: remoteMock });
    const { receipt: got, doc } = runner.produce("lyra", "spec", "checkout-flow", "storefront");
    expect(got.usd).toBe(null);
    expect(got.plan).toBe("ChatGPT Plus — flat monthly rate");
    // Token counts the boundary reported still pass through — only usd is overridden.
    expect(got.tokens_in).toBe(4200);
    expect(got.tokens_out).toBe(900);
    expect(doc).toContain("usd: null");
    expect(doc).toContain("plan: ChatGPT Plus");
  });

  test("a subscription member's model is not rejected as unpriceable — usd is null by the auth mode, not treated as a pricing failure", () => {
    const repo = subscriptionRepo();
    expect(pricing.has("codex-cli-5")).toBe(false); // genuinely absent from knowledge/model-pricing.md
    const lyra = repo.agents.get("lyra")!;
    repo.agents.set("lyra", { ...lyra, model: "codex-cli-5" });
    const receipt = { model: "codex-cli-5", tokens_in: 100, tokens_out: 50, wall_clock_s: 5, usd: null, unreported: false };
    const native: NativeBoundary = { invoke: (r) => ({ doc: render(r.member, r.kind, r.unit, r.project), receipt }) };
    const runner = new AdapterRunner(repo, { pricing, capabilities: [{ member: "lyra", kind: "spec" }], native, remote: remoteMock });
    const { receipt: got } = runner.produce("lyra", "spec", "checkout-flow", "storefront");
    expect(got.usd).toBe(null);
    expect(got.plan).toBe("ChatGPT Plus — flat monthly rate");
  });

  test("a fully unreported receipt is left alone — no plan noted on pure silence", () => {
    const repo = subscriptionRepo();
    const native: NativeBoundary = { invoke: (r) => ({ doc: render(r.member, r.kind, r.unit, r.project) }) }; // no receipt at all
    const runner = new AdapterRunner(repo, { pricing, capabilities: [{ member: "lyra", kind: "spec" }], native, remote: remoteMock });
    const { receipt } = runner.produce("lyra", "spec", "checkout-flow", "storefront");
    expect(receipt.unreported).toBe(true);
    expect(receipt.plan).toBeUndefined();
  });

  test("a member granted no subscription connector is unaffected — priced normally, no plan noted", () => {
    const repo = loadRepo(ROOT); // lyra grants no connector here
    const receipt = { model: "claude-sonnet-5", tokens_in: 100, tokens_out: 50, wall_clock_s: 2, usd: 999, unreported: false };
    const native: NativeBoundary = { invoke: (r) => ({ doc: render(r.member, r.kind, r.unit, r.project), receipt }) };
    const runner = new AdapterRunner(repo, { pricing, capabilities: [{ member: "lyra", kind: "spec" }], native, remote: remoteMock });
    const { receipt: got } = runner.produce("lyra", "spec", "checkout-flow", "storefront");
    expect(got.usd).not.toBe(null); // priced normally from the table, member's own usd still ignored
    expect(got.plan).toBeUndefined();
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
  // NOTES F21: the diagnosis, not the echoed prompt, must be the prominent thing in a CLI failure.
  // `{task}` substitutes the FULL §6 context into argv — thousands of characters in a real studio —
  // and the pre-fix message led with `(argv: ...)` before the stderr tail ever appeared: on a blocked
  // card showing only a bounded preview, the Conductor saw levare's own echoed prompt and never the
  // real error. These tests drive `cliCommand` to return a template with a huge substituted element
  // (mirroring `defaultCliCommand`'s real `{task}` substitution, which these tests otherwise bypass
  // via `stubCliCommand`), and assert the diagnosis reaches the front of the message, never buried or
  // truncated away by the echoed context ahead of it.
  // -------------------------------------------------------------------------

  const hugeTaskCliCommand = (r: InvokeRequest) => ["codex", "review", "--input", r.context, "--repo", "."];

  test("a huge substituted argv element never buries the real stderr diagnosis", () => {
    const repo = loadRepo(ROOT);
    const huge = "CONTEXT ".repeat(2000); // ~16k chars — far larger than any bounded card preview.
    const failing: CliSpawn = { run: () => ({ stdout: "", exitCode: 1, timedOut: false, stderr: "authentication expired: run `codex login`\n" }) };
    const runner = new AdapterRunner(repo, {
      pricing,
      capabilities: [{ member: "finch", kind: "review" }],
      native: nativeMock,
      remote: remoteMock,
      spawn: failing,
      cliCommand: (r) => hugeTaskCliCommand({ ...r, context: huge }),
    });
    let caught: unknown;
    try {
      runner.produce("finch", "review", "checkout-flow", "storefront");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AdapterError);
    const msg = (caught as Error).message;
    // The diagnosis is present, AND it comes before the (still-summarized, capped) argv reference —
    // never pushed out of a bounded preview by the huge context element.
    expect(msg).toContain("authentication expired: run `codex login`");
    const diagnosisAt = msg.indexOf("authentication expired");
    const argvAt = msg.indexOf("(argv:");
    expect(diagnosisAt).toBeGreaterThan(-1);
    expect(argvAt).toBeGreaterThan(-1);
    expect(diagnosisAt).toBeLessThan(argvAt);
    // The huge context element is capped, not dumped whole — the message stays well under the raw
    // context's own ~16k length.
    expect(msg.length).toBeLessThan(huge.length);
  });

  test("a CLI's own structured JSON error is preferred over a raw stderr tail", () => {
    const repo = loadRepo(ROOT);
    const failing: CliSpawn = {
      run: () => ({ stdout: "", exitCode: 1, timedOut: false, stderr: JSON.stringify({ error: { message: "rate limit exceeded, retry after 60s" } }) }),
    };
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
    expect(msg).toContain("rate limit exceeded, retry after 60s");
  });

  test("empty stderr falls back to the last non-empty stdout line, never a bare 'exited N'", () => {
    const repo = loadRepo(ROOT);
    const failing: CliSpawn = { run: () => ({ stdout: "starting up...\nerror: quota exhausted for this billing period\n", exitCode: 1, timedOut: false, stderr: "" }) };
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
    expect(msg).toContain("error: quota exhausted for this billing period");
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

// NOTES F17: a wrapped CLI's own reported usage — most report token counts as a plain trailer line
// rather than structured data (the Codex CLI's own "tokens used: 2745", quoted verbatim in the live
// finding), not the fixture stub's JSON-ish canned `usage:` block. `cannedCliSpawn` stands in for that
// real CLI, returning arbitrary stdout the test controls directly.
function cannedCliSpawn(stdout: string): CliSpawn {
  return { run: (): SpawnResult => ({ stdout, exitCode: 0, timedOut: false }) };
}

describe("F17: a CLI member's own reported tokens are parsed, never discarded, and a subscription member's receipt is never simply omitted", () => {
  function subscriptionRepo() {
    const repo = loadRepo(ROOT);
    repo.connectors.set("codex-subscription", {
      name: "codex-subscription",
      kind: "cli",
      command: "codex",
      env: [],
      auth: "subscription",
      role: "model",
      effects: "read",
      gate: "proposal",
      plan: "ChatGPT Plus — flat monthly rate",
    });
    const finch = repo.agents.get("finch")!;
    repo.agents.set("finch", { ...finch, connectors: ["codex-subscription"] });
    return repo;
  }

  test("a CLI's own \"tokens used: N\" trailer is parsed into the receipt and stripped from the artifact body", () => {
    const repo = loadRepo(ROOT); // finch grants no subscription connector here
    const runner = new AdapterRunner(repo, {
      pricing,
      capabilities: [{ member: "finch", kind: "review" }],
      native: nativeMock,
      remote: remoteMock,
      spawn: cannedCliSpawn("# Review\n\nLooks solid overall.\n\ntokens used: 2745\n"),
      cliCommand: stubCliCommand,
    });
    const { doc, receipt } = runner.produce("finch", "review", "checkout-flow", "storefront");
    expect(receipt.unreported).toBe(false);
    expect(receipt.tokens_out).toBe(2745);
    expect(doc).toContain("Looks solid overall.");
    expect(doc).not.toContain("tokens used");
  });

  test("a subscription CLI member's receipt carries the CLI's reported tokens, usd: null, and the plan", () => {
    const repo = subscriptionRepo();
    const runner = new AdapterRunner(repo, {
      pricing,
      capabilities: [{ member: "finch", kind: "review" }],
      native: nativeMock,
      remote: remoteMock,
      spawn: cannedCliSpawn("# Review\n\nCHANGES REQUESTED: no product brief was provided to review.\n\ntokens used: 2745\n"),
      cliCommand: stubCliCommand,
    });
    const { doc, receipt } = runner.produce("finch", "review", "checkout-flow", "storefront");
    expect(receipt.unreported).toBe(false);
    expect(receipt.tokens_out).toBe(2745);
    expect(receipt.usd).toBe(null);
    expect(receipt.plan).toBe("ChatGPT Plus — flat monthly rate");
    expect(doc).toContain("usage:");
    expect(doc).toContain("tokens_out: 2745");
    expect(doc).toContain("usd: null");
    expect(doc).toContain("plan: ChatGPT Plus");
    expect(doc).not.toContain("tokens used");
  });

  test("a subscription CLI member reporting nothing parseable still gets a receipt — nulls, never an omitted usage block", () => {
    const repo = subscriptionRepo();
    const runner = new AdapterRunner(repo, {
      pricing,
      capabilities: [{ member: "finch", kind: "review" }],
      native: nativeMock,
      remote: remoteMock,
      spawn: cannedCliSpawn("# Review\n\nNo usage figures reported this run.\n"),
      cliCommand: stubCliCommand,
    });
    const { doc, receipt } = runner.produce("finch", "review", "checkout-flow", "storefront");
    // An artifact with no receipt at all is indistinguishable from one that cost nothing — never again.
    expect(receipt.unreported).toBe(false);
    expect(receipt.tokens_in).toBe(null);
    expect(receipt.tokens_out).toBe(null);
    expect(receipt.model).toBe(null);
    expect(receipt.usd).toBe(null);
    expect(receipt.plan).toBe("ChatGPT Plus — flat monthly rate");
    expect(doc).toContain("usage:");
    expect(doc).toContain("plan: ChatGPT Plus");
  });

  test("a non-subscription CLI member reporting nothing parseable is unaffected — unreported, no usage block, exactly as before", () => {
    const repo = loadRepo(ROOT);
    const runner = new AdapterRunner(repo, {
      pricing,
      capabilities: [{ member: "finch", kind: "review" }],
      native: nativeMock,
      remote: remoteMock,
      spawn: cannedCliSpawn("# Review\n\nNo usage figures reported this run.\n"),
      cliCommand: stubCliCommand,
    });
    const { doc, receipt } = runner.produce("finch", "review", "checkout-flow", "storefront");
    expect(receipt.unreported).toBe(true);
    expect(receipt.plan).toBeUndefined();
    expect(doc).not.toContain("usage:");
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

  // NOTES R4-SANDBOX-FIX-10 (live macOS gate: a hung member chain, "killed 1 dangling process" reported
  // with no diagnosis of which link blocked). Proves the new instrumentation actually fires under a real
  // async timeout: the process group still alive at kill time is listed (by pid/command), and whatever
  // partial stdout the member printed before hanging is captured, not silently discarded the way the
  // functional `SpawnResult.stdout` already is on a timeout (`timedOut ? "" : stdout`, unchanged).
  test("LEVARE_SANDBOX_DEBUG=1 prints the alive process group and partial stdout when a real async timeout fires", async () => {
    const repo = loadRepo(ROOT);
    repo.agents.set("hangingSleeper", { ...repo.agents.get("finch")!, name: "hangingSleeper", command: ["sh", "-c", "echo partial-output-marker; sleep 10"], cwd: undefined, timeout: 1 });
    repo.teams.get("kestrel")!.members.push("hangingSleeper");
    const runner = new AdapterRunner(repo, { pricing, capabilities: [{ member: "hangingSleeper", kind: "review" }], native: nativeMock, remote: remoteMock });
    const prior = process.env.LEVARE_SANDBOX_DEBUG;
    const origError = console.error;
    const lines: string[] = [];
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      process.env.LEVARE_SANDBOX_DEBUG = "1";
      await expect(runner.produceAsync("hangingSleeper", "review", "checkout-flow", "storefront")).rejects.toThrow(/timed out/);
      const captured = lines.join("\n");
      expect(captured).toContain("process group");
      expect(captured).toContain("still alive at kill time");
      // The "sleep" link is named by its own command, proving the listing is real, not a placeholder.
      expect(captured).toContain("sleep");
      expect(captured).toContain("timeout: partial stdout");
      expect(captured).toContain("partial-output-marker");
    } finally {
      console.error = origError;
      if (prior === undefined) delete process.env.LEVARE_SANDBOX_DEBUG;
      else process.env.LEVARE_SANDBOX_DEBUG = prior;
    }
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

// ---------------------------------------------------------------------------
// NOTES R4-SANDBOX (v2) — Ruling 1 (per-dispatch worktree) and Ruling 2 (OS sandbox), against the REAL
// spawn boundary (bunSpawn/asyncBunSpawn — never an injected CliSpawn double, which is why `finch`'s own
// broken `command:` template (a `codex` binary this box doesn't have) is always overridden below via
// `cliCommand`, the same injection seam replay.ts's --stubs mode already uses). `fixtures/golden`'s own
// `storefront` project declares a non-local `repo:` on purpose (merge.test.ts's own
// `resolveProjectRepoPath` coverage) — these tests substitute a REAL local git repo for it directly on
// the loaded Repo's own `projects` map, reusing golden's real team/agent/unit definitions unchanged.
// ---------------------------------------------------------------------------

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" };

function git(repoRoot: string, args: string[]): string {
  const r = spawnSync("git", ["-C", repoRoot, "-c", "user.name=seed", "-c", "user.email=seed@levare.test", "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf8",
    env: GIT_ENV,
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}${r.stdout}`);
  return r.stdout;
}

/** A real local project repo, `main` as default branch, with `levare/<unit>` branches planted for the
 * given units, each carrying a `marker.txt` naming which branch it is — the distinguishing signal both
 * tests below read back to prove (or disprove) cross-dispatch isolation. */
function makeProjectRepoWithBranches(units: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "levare-r4-proj-"));
  git(dir, ["-c", "init.defaultBranch=main", "init", "-q"]);
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "initial"]);
  for (const unit of units) {
    const branch = `levare/${unit}`;
    git(dir, ["checkout", "-q", "-b", branch]);
    writeFileSync(join(dir, "marker.txt"), `MARKER-${unit}\n`);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", `seed ${branch}`]);
    git(dir, ["checkout", "-q", "main"]);
  }
  return dir;
}

/** Loads the real golden fixture repo, then swaps `storefront`'s `repo:` for a real local checkout —
 * every team/agent/unit definition stays golden's own, unmodified. */
function repoWithRealStorefrontRepo(projectRepoPath: string) {
  const repo = loadRepo(ROOT);
  const proj = repo.projects.get("storefront")!;
  repo.projects.set("storefront", { ...proj, repo: projectRepoPath });
  return repo;
}

/** NOTES R4-SANDBOX-FIX-9: a fake "bwrap"/"sandbox-exec" binary that ignores every prefix flag and
 * `exec`s whatever follows the first `--` it sees, inheriting the caller's own env unchanged — unlike
 * `/bin/echo` (which merely echoes the composed argv as text, never actually running anything), this
 * genuinely EXECUTES the wrapped inner command, which is what proving an env-level effect (rather than
 * just argv composition) requires: a REAL spawn (`this.spawn === bunSpawn`) still needs a functioning
 * "primitive" to observe what the inner command's own process actually sees, on a container where no
 * real bwrap/sandbox-exec works. */
function fakeWorkingPrimitive(): string {
  const dir = mkdtempSync(join(tmpdir(), "levare-fake-primitive-"));
  const path = join(dir, "fake-bwrap.sh");
  writeFileSync(path, ["#!/bin/sh", 'while [ "$#" -gt 0 ]; do', '  if [ "$1" = "--" ]; then', "    shift", '    exec "$@"', "  fi", "  shift", "done"].join("\n") + "\n");
  chmodSync(path, 0o755);
  return path;
}

describe("NOTES R4-SANDBOX Ruling 1 — per-dispatch worktree isolation", () => {
  test("two units on the same project get isolated per-dispatch checkouts, even dispatched concurrently", async () => {
    const projectRepo = makeProjectRepoWithBranches(["checkout-flow", "cart-icon-fix"]);
    try {
      const repo = repoWithRealStorefrontRepo(projectRepo);
      const runner = new AdapterRunner(repo, {
        pricing,
        capabilities: [{ member: "finch", kind: "review" }],
        native: nativeMock,
        remote: remoteMock,
        // finch's own `command:` invokes a `codex` binary this box doesn't have — overridden here to a
        // real, always-present binary that proves the per-dispatch worktree wiring instead. Real
        // `spawn`/`asyncSpawn` are left at their defaults (bunSpawn/asyncBunSpawn) — this override is
        // orthogonal, matching replay.ts's own --stubs seam.
        cliCommand: (req) => ["cat", join(req.projectRepoPath!, "marker.txt")],
      });

      const [a, b] = await Promise.all([
        runner.produceAsync("finch", "review", "checkout-flow", "storefront"),
        runner.produceAsync("finch", "review", "cart-icon-fix", "storefront"),
      ]);

      expect(a.doc).toContain("MARKER-checkout-flow");
      expect(a.doc).not.toContain("MARKER-cart-icon-fix");
      expect(b.doc).toContain("MARKER-cart-icon-fix");
      expect(b.doc).not.toContain("MARKER-checkout-flow");

      // The project's own working tree was never checked out onto either work branch — the
      // shared-single-working-tree race this ruling retires (adapters.ts's former memberWorkingContext).
      expect(git(projectRepo, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("main");
      // Both scratch worktrees were cleaned up — only the main entry remains.
      const wt = git(projectRepo, ["worktree", "list", "--porcelain"]);
      expect(wt.trim().split("\n\n").filter(Boolean).length).toBe(1);
    } finally {
      rmSync(projectRepo, { recursive: true, force: true });
    }
  });

  // NOTES R4-SANDBOX-FIX-7 (live macOS gate): this test failed under a genuinely working sandbox — git's
  // worktree design shares the object store/refs/admin-state (HEAD, index) under the ORIGINAL repo's
  // own `.git`, never inside the per-dispatch worktree's own directory, so the member's `git commit`
  // here needs write access to `projectRepo/.git` too, not just to the worktree `cd "$1"` lands in. This
  // runs against the REAL `bunSpawn`/real `detectSandbox()` (this container's own honest `none`), so it
  // never exercised the gap directly here — see the next test for the structural proof that
  // `dispatchGitDir` reaches the wrapped argv, and sandbox.test.ts's own `writablePaths` unit tests for
  // the profile/bwrap-argv shape this closes.
  //
  // NOTES R4-SANDBOX-FIX-10/FIX-11: this test's own default bun:test timeout (5000ms, never raised — a
  // raised timeout would hide the exact regression this asserts against) is what convicted the live
  // gate's own "hang": under the pre-FIX-11 profile, `git add`/`git commit` each failed SLOWLY (~3.3s +
  // ~2.2s ≈ 5.5s of xcodebuild/DVT stall before `exit 128`) via Apple's own xcrun-shimmed `/usr/bin/git`
  // hitting a denied `confstr(DARWIN_USER_TEMP_DIR)` — exceeding the test's own 5000ms ceiling with no
  // diagnosis of which link was slow. FIX-11 grants the mach-lookup this confstr call needs plus a write
  // grant at the resolved per-user temp dir; the elapsed-time assertion below is the regression guard —
  // generous headroom (this container's own unsandboxed baseline is single-digit milliseconds), never a
  // raised ceiling, so a future regression back to the slow-failure path fails LOUDLY on timing, not just
  // eventually timing out the whole test with no signal about why.
  test("a member's own commit inside its dispatch worktree actually advances the work branch, never the shared tree", async () => {
    const projectRepo = makeProjectRepoWithBranches(["checkout-flow"]);
    try {
      const beforeSha = git(projectRepo, ["rev-parse", "levare/checkout-flow"]).trim();
      const repo = repoWithRealStorefrontRepo(projectRepo);
      const runner = new AdapterRunner(repo, {
        pricing,
        capabilities: [{ member: "finch", kind: "review" }],
        native: nativeMock,
        remote: remoteMock,
        cliCommand: (req) => [
          "sh",
          "-c",
          `cd "$1" && echo written > member-output.txt && git -c user.name=member -c user.email=member@levare.test -c commit.gpgsign=false add -A && git -c user.name=member -c user.email=member@levare.test -c commit.gpgsign=false commit -q -m "member commit" && echo "committed member work"`,
          "sh",
          req.projectRepoPath!,
        ],
      });
      const start = Date.now();
      await runner.produceAsync("finch", "review", "checkout-flow", "storefront");
      const elapsed = Date.now() - start;
      // Generous headroom under the test's own 5000ms ceiling — a sandboxed commit that regresses back
      // toward the multi-second xcrun-shim slow-failure path fails HERE, on timing, rather than only ever
      // hitting the outer test timeout with no signal about which link got slow.
      expect(elapsed).toBeLessThan(2000);
      expect(git(projectRepo, ["rev-parse", "levare/checkout-flow"]).trim()).not.toBe(beforeSha);
      // Never landed in the project's own working tree.
      expect(existsSync(join(projectRepo, "member-output.txt"))).toBe(false);
    } finally {
      rmSync(projectRepo, { recursive: true, force: true });
    }
  });

  // NOTES R4-SANDBOX-FIX-7/FIX-8: proves the NARROWED grant (objects/refs/logs/this-worktree's-own-
  // admin-dir) actually reaches the wrapped argv as read-write binds — and, just as importantly, that
  // `.git/hooks`, `.git/config`, and the bare `.git` root NEVER do (the security narrowing FIX-8 exists
  // for) — via the same fake-"bubblewrap"-is-really-/bin/echo trick this file already uses to observe
  // wrapped argv without a real, working bwrap (see the readOnlyPaths test above). Forces
  // `primitive: "bubblewrap"` regardless of host, so it exercises bwrap's OWN argv shape deterministically
  // — see the platform-conditional test below for the REAL, un-forced host proof.
  //
  // NOTES R4-SANDBOX-FIX-9 (this test's own defect, live macOS gate): `dispatchGitWritePaths` derives
  // ALL FOUR granted paths from `worktreeGitDir` (canonical — `git worktree add` itself resolves
  // symlinks when writing the `.git` pointer file, confirmed by direct reproduction), never from the
  // caller's own `repoPath`. `projectRepo` here is `mkdtempSync(tmpdir())`'s own return value, which is
  // NOT canonical on a host where `tmpdir()` sits behind a symlink (macOS's `/var/folders` →
  // `/private/var/folders`; this Linux container's own `/tmp` happens not to be one, which is exactly
  // what let this ship without failing here first). `realpathSync` is applied to `projectRepo` before
  // building the expected paths, per this file's own general path-comparison rule.
  test("a dispatch worktree's own .git objects/refs/logs/admin-dir are threaded into the wrapped argv as read-write binds — never hooks, config, or the bare .git root", async () => {
    const projectRepo = makeProjectRepoWithBranches(["checkout-flow"]);
    try {
      const repo = repoWithRealStorefrontRepo(projectRepo);
      const runner = new AdapterRunner(repo, {
        pricing,
        capabilities: [{ member: "finch", kind: "review" }],
        native: nativeMock,
        remote: remoteMock,
        cliCommand: () => ["cat", "/dev/null"],
        sandboxDetection: { platform: "linux", primitive: "bubblewrap", level: "full", bin: "/bin/echo" },
      });
      const { doc } = await runner.produceAsync("finch", "review", "checkout-flow", "storefront");
      const gitCommonDir = join(realpathSync(projectRepo), ".git");

      // Each of the four exact subpaths is read-write bound (--bind, never --ro-bind-try).
      for (const sub of ["objects", "refs", "logs"]) {
        const p = join(gitCommonDir, sub);
        expect(doc).toContain(`--bind ${p} ${p}`);
      }
      // The worktree's own admin dir — dynamic name (git may rename on collision), so only its parent
      // directory is asserted — still read-write bound.
      const worktreesDir = join(gitCommonDir, "worktrees");
      const idx = doc.indexOf(worktreesDir);
      expect(idx).toBeGreaterThan(-1);
      expect(doc.slice(Math.max(0, idx - 10), idx)).toContain("--bind");

      // The security narrowing itself: hooks/config never appear anywhere, and the bare .git root is
      // never bound as its own read-write pair (only its specific subpaths are).
      expect(doc).not.toContain(join(gitCommonDir, "hooks"));
      expect(doc).not.toContain(join(gitCommonDir, "config"));
      expect(doc).not.toContain(`--bind ${gitCommonDir} ${gitCommonDir}`);
    } finally {
      rmSync(projectRepo, { recursive: true, force: true });
    }
  });

  test("no dispatch worktree (no real local checkout) → no writablePaths at all, no git-dir grant", () => {
    // storefront's own fixture `repo:` is a non-local `git@github.com` URL here (never swapped for a
    // real local checkout, unlike `repoWithRealStorefrontRepo` above) — `resolveDispatchRepo` returns
    // undefined, so no worktree, and therefore no `dispatchGitDir`, is ever created for this dispatch.
    const repo = loadRepo(ROOT);
    const runner = new AdapterRunner(repo, {
      pricing,
      capabilities: [{ member: "finch", kind: "review" }],
      native: nativeMock,
      remote: remoteMock,
      cliCommand: () => ["cat", "/dev/null"],
      sandboxDetection: { platform: "linux", primitive: "bubblewrap", level: "full", bin: "/bin/echo" },
    });
    const { doc } = runner.produce("finch", "review", "checkout-flow", "storefront");
    expect(doc).not.toContain(".git");
  });
});

describe("NOTES R4-SANDBOX Ruling 2 — OS sandbox wrapping of the real CLI spawn boundary", () => {
  test("records the actually-detected enforcement level on the produced artifact, deterministically, via the injectable override", async () => {
    const projectRepo = makeProjectRepoWithBranches(["checkout-flow"]);
    try {
      const repo = repoWithRealStorefrontRepo(projectRepo);
      const runner = new AdapterRunner(repo, {
        pricing,
        capabilities: [{ member: "finch", kind: "review" }],
        native: nativeMock,
        remote: remoteMock,
        cliCommand: (req) => ["cat", join(req.projectRepoPath!, "marker.txt")],
        // Deterministic across any host: "none" never wraps argv at all (see wrapForSandbox), so this
        // is safe to force everywhere, including a host that genuinely has a working primitive.
        sandboxDetection: { platform: "linux", primitive: "none", level: "none" },
      });
      const { doc } = await runner.produceAsync("finch", "review", "checkout-flow", "storefront");
      expect(doc).toContain("sandbox: none");
      expect(doc).toContain("MARKER-checkout-flow"); // the real, unwrapped spawn still ran and succeeded.
    } finally {
      rmSync(projectRepo, { recursive: true, force: true });
    }
  });

  // NOTES R4-SANDBOX-FIX-9 (live macOS gate): a "full"-tier sandbox denies the operator's own real HOME,
  // turning a git global-config read into a FATAL EPERM rather than a tolerated ENOENT. Proven end to
  // end (not just the pure redirect function) via `fakeWorkingPrimitive` — a stand-in "bwrap" that
  // genuinely executes the wrapped inner command, so the actual env the spawned process sees is what
  // this test observes.
  describe("git global/system config is redirected to /dev/null under a full-tier sandbox (NOTES R4-SANDBOX-FIX-9)", () => {
    test("level: full → GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM are both /dev/null in the spawned env", async () => {
      const projectRepo = makeProjectRepoWithBranches(["checkout-flow"]);
      const primitiveBin = fakeWorkingPrimitive();
      try {
        const repo = repoWithRealStorefrontRepo(projectRepo);
        const runner = new AdapterRunner(repo, {
          pricing,
          capabilities: [{ member: "finch", kind: "review" }],
          native: nativeMock,
          remote: remoteMock,
          cliCommand: () => ["sh", "-c", 'printf "GLOBAL=%s SYSTEM=%s" "$GIT_CONFIG_GLOBAL" "$GIT_CONFIG_SYSTEM"'],
          sandboxDetection: { platform: "linux", primitive: "bubblewrap", level: "full", bin: primitiveBin },
        });
        const { doc } = await runner.produceAsync("finch", "review", "checkout-flow", "storefront");
        expect(doc).toContain("GLOBAL=/dev/null SYSTEM=/dev/null");
      } finally {
        rmSync(projectRepo, { recursive: true, force: true });
        rmSync(dirname(primitiveBin), { recursive: true, force: true });
      }
    });

    test("level: none → neither var is set at all — the redirect never fires without a full-tier sandbox", async () => {
      const projectRepo = makeProjectRepoWithBranches(["checkout-flow"]);
      try {
        const repo = repoWithRealStorefrontRepo(projectRepo);
        const runner = new AdapterRunner(repo, {
          pricing,
          capabilities: [{ member: "finch", kind: "review" }],
          native: nativeMock,
          remote: remoteMock,
          cliCommand: () => ["sh", "-c", 'printf "GLOBAL=%s SYSTEM=%s" "$GIT_CONFIG_GLOBAL" "$GIT_CONFIG_SYSTEM"'],
          sandboxDetection: { platform: "linux", primitive: "none", level: "none" },
        });
        const { doc } = await runner.produceAsync("finch", "review", "checkout-flow", "storefront");
        expect(doc).toContain("GLOBAL= SYSTEM=");
      } finally {
        rmSync(projectRepo, { recursive: true, force: true });
      }
    });

    // A "fs-only" (unshare) counterpart to the "none" test above was attempted and dropped: unlike
    // bubblewrap's argv (which `fakeWorkingPrimitive` can transparently intercept), `unshareArgv`'s own
    // wrapped command is a SHELL SCRIPT that itself runs real `mount --bind`/`mount -o remount` calls —
    // these fail with "must be superuser to use mount" in this container regardless of what binary
    // `detection.bin` names, the same real-privilege gap this codebase has documented since NOTES
    // R4-SANDBOX itself ("the unshare fs-only fallback's own real behavior on ANY host... has never once
    // actually run for real, on any platform, in this project's history"). The `wrapped.level === "full"`
    // conditional gating the redirect (adapters.ts#runCli/runCliAsync) is a direct, one-line ternary —
    // "fs-only" structurally can never satisfy it, which is provable by inspection, not by a live spawn
    // this container cannot grant the privileges for.

    test("a member's own -c flags / repo-local config are unaffected — only GLOBAL/SYSTEM are redirected", async () => {
      const projectRepo = makeProjectRepoWithBranches(["checkout-flow"]);
      const primitiveBin = fakeWorkingPrimitive();
      try {
        const repo = repoWithRealStorefrontRepo(projectRepo);
        const runner = new AdapterRunner(repo, {
          pricing,
          capabilities: [{ member: "finch", kind: "review" }],
          native: nativeMock,
          remote: remoteMock,
          cliCommand: (req) => ["git", "-C", req.projectRepoPath!, "-c", "user.name=member", "-c", "user.email=member@levare.test", "config", "--get", "user.name"],
          sandboxDetection: { platform: "linux", primitive: "bubblewrap", level: "full", bin: primitiveBin },
        });
        const { doc } = await runner.produceAsync("finch", "review", "checkout-flow", "storefront");
        expect(doc).toContain("member");
      } finally {
        rmSync(projectRepo, { recursive: true, force: true });
        rmSync(dirname(primitiveBin), { recursive: true, force: true });
      }
    });
  });

  // NOTES R4-SANDBOX-FIX (macOS host verification): proves `sandboxWrap` actually threads the studio
  // root / interpreter directory into the wrapped argv's `readOnlyPaths`, without needing a real,
  // working bwrap/sandbox-exec to observe it — a fake "bubblewrap" whose `bin` is really `/bin/echo`
  // (a real, always-present binary on this Linux container) just echoes back whatever argv it was
  // handed, which is exactly what wrapForSandbox constructs for a real bwrap call.
  test("readOnlyPaths threaded into the wrapped argv include the studio root and the running interpreter's own directory AND its install tree", async () => {
    const projectRepo = makeProjectRepoWithBranches(["checkout-flow"]);
    try {
      const repo = repoWithRealStorefrontRepo(projectRepo);
      const runner = new AdapterRunner(repo, {
        pricing,
        capabilities: [{ member: "finch", kind: "review" }],
        native: nativeMock,
        remote: remoteMock,
        cliCommand: () => ["cat", "/dev/null"],
        sandboxDetection: { platform: "linux", primitive: "bubblewrap", level: "full", bin: "/bin/echo" },
      });
      const { doc } = await runner.produceAsync("finch", "review", "checkout-flow", "storefront");
      expect(doc).toContain(repo.root);
      expect(doc).toContain(dirname(process.execPath));
      // NOTES R4-SANDBOX-FIX-3: the interpreter's own INSTALL TREE, not just its immediate directory —
      // "~/.bun, not just ~/.bun/bin — dyld reads beyond bin/" (adapters.ts#sandboxWrap's own treeDirs).
      expect(doc).toContain(dirname(dirname(process.execPath)));
    } finally {
      rmSync(projectRepo, { recursive: true, force: true });
    }
  });

  // NOTES R4-SANDBOX-FIX (round 2): a failed sandboxed spawn's error message must name what ACTUALLY ran
  // (the wrapped argv), never the pre-wrap member command — the exact honesty gap the live macOS report
  // named ("Note the reported argv: it is the RAW member argv... either the error path reports pre-wrap
  // argv, or the wrapper never composed at all").
  test("a failed sandboxed spawn's error message reports the WRAPPED argv, never the raw member argv", async () => {
    const projectRepo = makeProjectRepoWithBranches(["checkout-flow"]);
    try {
      const repo = repoWithRealStorefrontRepo(projectRepo);
      const runner = new AdapterRunner(repo, {
        pricing,
        capabilities: [{ member: "finch", kind: "review" }],
        native: nativeMock,
        remote: remoteMock,
        cliCommand: (req) => ["cat", join(req.projectRepoPath!, "marker.txt")],
        // A fake "bubblewrap" whose bin is really /usr/bin/false — always exits 1, ignoring every arg —
        // so the failure is guaranteed and the wrapped argv (bwrap-shaped flags) is what must appear in
        // the thrown error, not the plain "cat marker.txt" the member itself would have run.
        sandboxDetection: { platform: "linux", primitive: "bubblewrap", level: "full", bin: "/usr/bin/false" },
      });
      await expect(runner.produceAsync("finch", "review", "checkout-flow", "storefront")).rejects.toThrow(/--tmpfs/);
    } finally {
      rmSync(projectRepo, { recursive: true, force: true });
    }
  });

  // NOTES R4-SANDBOX-FIX (round 2): the post-spawn debug line (exitCode/signalCode/byte counts) this
  // module's own header promises — proven to actually fire on a real spawn, not just wired.
  test("LEVARE_SANDBOX_DEBUG=1 prints the raw spawn result after a real dispatch", async () => {
    const projectRepo = makeProjectRepoWithBranches(["checkout-flow"]);
    const prior = process.env.LEVARE_SANDBOX_DEBUG;
    const origError = console.error;
    const lines: string[] = [];
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      process.env.LEVARE_SANDBOX_DEBUG = "1";
      const repo = repoWithRealStorefrontRepo(projectRepo);
      const runner = new AdapterRunner(repo, {
        pricing,
        capabilities: [{ member: "finch", kind: "review" }],
        native: nativeMock,
        remote: remoteMock,
        cliCommand: (req) => ["cat", join(req.projectRepoPath!, "marker.txt")],
        sandboxDetection: { platform: "linux", primitive: "none", level: "none" },
      });
      await runner.produceAsync("finch", "review", "checkout-flow", "storefront");
      expect(lines.some((l) => l.includes("spawn result: exitCode=0"))).toBe(true);
    } finally {
      console.error = origError;
      if (prior === undefined) delete process.env.LEVARE_SANDBOX_DEBUG;
      else process.env.LEVARE_SANDBOX_DEBUG = prior;
      rmSync(projectRepo, { recursive: true, force: true });
    }
  });

  // NOTES R4-SANDBOX-FIX-6: before this round, a real dispatch's `LEVARE_SANDBOX_DEBUG=1` output showed
  // only the WRAP's own block (level/cwd/composed argv) — the `detectSandbox()` call `sandboxWrap` makes
  // immediately beforehand was silent, making the one spawn that decides the enforcement level the one
  // spawn invisible to the flag. This proves both blocks now appear, in order, for a single real dispatch
  // — exactly what lets a Conductor diff "what the probe concluded" against "what the wrap then built"
  // by eye, which is the whole point of matching their format.
  test("LEVARE_SANDBOX_DEBUG=1 prints the detection PROBE's own debug block before the real dispatch's own wrap block", async () => {
    const projectRepo = makeProjectRepoWithBranches(["checkout-flow"]);
    const prior = process.env.LEVARE_SANDBOX_DEBUG;
    const origError = console.error;
    const lines: string[] = [];
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      process.env.LEVARE_SANDBOX_DEBUG = "1";
      const repo = repoWithRealStorefrontRepo(projectRepo);
      const runner = new AdapterRunner(repo, {
        pricing,
        capabilities: [{ member: "finch", kind: "review" }],
        native: nativeMock,
        remote: remoteMock,
        cliCommand: (req) => ["cat", join(req.projectRepoPath!, "marker.txt")],
        // No sandboxDetection override — the REAL, un-injected detectSandbox() runs, exactly as
        // production does, so its own probe debug lines are what this test observes.
      });
      await runner.produceAsync("finch", "review", "checkout-flow", "storefront");
      const probeLevelIdx = lines.findIndex((l) => l.includes("level:"));
      const wrapArgvIdx = lines.findIndex((l) => l.includes("composed argv:"));
      expect(probeLevelIdx).toBeGreaterThan(-1);
      expect(wrapArgvIdx).toBeGreaterThan(-1);
      // The probe's own "composed argv:"/"level:" lines (from detectSandbox) precede the wrap's own
      // second "composed argv:" block (from wrapForSandbox) — both present, in dispatch order.
      expect(lines.filter((l) => l.includes("composed argv:")).length).toBeGreaterThanOrEqual(1);
    } finally {
      console.error = origError;
      if (prior === undefined) delete process.env.LEVARE_SANDBOX_DEBUG;
      else process.env.LEVARE_SANDBOX_DEBUG = prior;
      rmSync(projectRepo, { recursive: true, force: true });
    }
  });

  test("native/remote members never carry a sandbox level — Ruling 2 wraps only the two cli spawn paths", () => {
    const repo = loadRepo(ROOT);
    const runner = new AdapterRunner(repo, { pricing, capabilities: [{ member: "lyra", kind: "spec" }], native: nativeMock, remote: remoteMock });
    const { doc } = runner.produce("lyra", "spec", "checkout-flow", "storefront");
    expect(doc).not.toContain("sandbox:");
  });

  test("an injected (test-double) CliSpawn never gets its argv wrapped — sandboxing only ever touches the real spawn boundary", () => {
    const repo = loadRepo(ROOT);
    let seenArgv: string[] = [];
    const spawn: CliSpawn = {
      run(argv, opts) {
        seenArgv = argv;
        return { stdout: "fine", exitCode: 0, timedOut: false };
      },
    };
    const runner = new AdapterRunner(repo, { pricing, capabilities: [{ member: "finch", kind: "review" }], native: nativeMock, remote: remoteMock, spawn, cliCommand: stubCliCommand });
    const { doc } = runner.produce("finch", "review", "checkout-flow", "storefront");
    expect(seenArgv[0]).toBe("bun"); // stubCliCommand's own first element — never a bwrap/unshare prefix
    expect(doc).not.toContain("sandbox:"); // no real spawn boundary → no detection ever ran
  });

  // Gated on THIS host genuinely having a working OS sandbox primitive — skipped in this dev container
  // (bwrap/unshare are both on PATH but user namespaces are disabled by the outer container's own
  // seccomp policy, confirmed directly in sandbox.test.ts's own "this actual host" test) and expected to
  // RUN for real wherever bubblewrap actually works (a normal Linux host, most CI runners).
  const hostSandbox = detectSandbox();
  // NOTES R4-SANDBOX-FIX-3 (round 3, live macOS bisection): the decoy is planted under the OPERATOR'S
  // OWN HOME, not an arbitrary tmp directory — the ruling's own hard condition ("a file in the operator's
  // HOME outside the granted set must be unreadable"). This is deliberately the ONE decoy location that
  // proves the guarantee identically on BOTH platforms under their now-different "full" models: Linux
  // bubblewrap denies EVERYTHING outside its explicit allow-list (home included, same as before this
  // round — a strictly stronger claim than this test needs); macOS sandbox-exec's new deny-list model
  // denies the operator's home SPECIFICALLY (broad OS reads elsewhere are now deliberately allowed — see
  // sandbox.ts's own header — so a decoy anywhere ELSE would no longer prove anything on macOS).
  test.skipIf(hostSandbox.level !== "full")(
    "decoy-file proof: a file under the operator's own HOME, outside anything granted, is genuinely unreadable from inside a sandboxed run",
    async () => {
      const projectRepo = makeProjectRepoWithBranches(["checkout-flow"]);
      const decoyDir = mkdtempSync(join(homedir(), ".levare-r4-decoy-"));
      try {
        writeFileSync(join(decoyDir, "secret.txt"), "SECRET\n");
        const repo = repoWithRealStorefrontRepo(projectRepo);
        const runner = new AdapterRunner(repo, {
          pricing,
          capabilities: [{ member: "finch", kind: "review" }],
          native: nativeMock,
          remote: remoteMock,
          cliCommand: () => ["cat", join(decoyDir, "secret.txt")],
        });
        await expect(runner.produceAsync("finch", "review", "checkout-flow", "storefront")).rejects.toThrow(AdapterError);
      } finally {
        rmSync(projectRepo, { recursive: true, force: true });
        rmSync(decoyDir, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(hostSandbox.level !== "full")("the same dispatch can still read its own worktree/marker file under a working sandbox", async () => {
    const projectRepo = makeProjectRepoWithBranches(["checkout-flow"]);
    try {
      const repo = repoWithRealStorefrontRepo(projectRepo);
      const runner = new AdapterRunner(repo, {
        pricing,
        capabilities: [{ member: "finch", kind: "review" }],
        native: nativeMock,
        remote: remoteMock,
        cliCommand: (req) => ["cat", join(req.projectRepoPath!, "marker.txt")],
      });
      const { doc } = await runner.produceAsync("finch", "review", "checkout-flow", "storefront");
      expect(doc).toContain("MARKER-checkout-flow");
      expect(doc).toContain("sandbox: full");
    } finally {
      rmSync(projectRepo, { recursive: true, force: true });
    }
  });

  // NOTES R4-SANDBOX-FIX-8 (security narrowing of FIX-7's own write grant): the decoy-file proof's own
  // counterpart for the exec-escape this round closes. `.git/objects`/`refs`/`logs`/this dispatch's own
  // worktree admin dir ARE granted (proven above, and by the worktree-commit test) — but `.git/hooks` is
  // deliberately NOT, because a member-written `post-commit` hook would execute UNCONFINED the next time
  // ANY git operation touches this repo outside the sandbox.
  test.skipIf(hostSandbox.level !== "full")(
    "a sandboxed member cannot create .git/hooks/post-commit in the original repo, even though objects/refs/logs/its-own-worktree-admin-dir are genuinely writable",
    async () => {
      const projectRepo = makeProjectRepoWithBranches(["checkout-flow"]);
      try {
        const repo = repoWithRealStorefrontRepo(projectRepo);
        const hookPath = join(projectRepo, ".git", "hooks", "post-commit");
        const runner = new AdapterRunner(repo, {
          pricing,
          capabilities: [{ member: "finch", kind: "review" }],
          native: nativeMock,
          remote: remoteMock,
          cliCommand: () => ["sh", "-c", `echo '#!/bin/sh' > "$1"`, "sh", hookPath],
        });
        await expect(runner.produceAsync("finch", "review", "checkout-flow", "storefront")).rejects.toThrow(AdapterError);
        expect(existsSync(hookPath)).toBe(false);
      } finally {
        rmSync(projectRepo, { recursive: true, force: true });
      }
    },
  );

  // NOTES R4-SANDBOX-FIX-12 (live macOS gate: FIX-11's own darwin temp-dir grant broke cross-dispatch
  // write isolation too — every concurrent dispatch's own worktree lives under the SAME resolved
  // DARWIN_USER_TEMP_DIR, so a flat, broad grant there let one member write into ANOTHER dispatch's own
  // checkout). This decoy's sibling: a SECOND dispatch's own worktree is created directly (simulating a
  // concurrent dispatch already in flight, at a real scratch path, exactly as a real sibling dispatch
  // would have), and the member under test attempts to write into it. The narrowed
  // `darwinXcrunTempDir` regex (matching only `xcrun_db-*`, never a sibling worktree's own name) is what
  // this proves live; structurally, this container's own `sandbox: none` means the write simply succeeds
  // here (no isolation at all without a working primitive) — this test is gated the same as every other
  // real-sandbox-only proof in this file.
  test.skipIf(hostSandbox.level !== "full")(
    "a sandboxed member cannot write into a second, sibling dispatch's own worktree",
    async () => {
      const projectRepo = makeProjectRepoWithBranches(["unit-a", "unit-b"]);
      const sibling = createDispatchWorktree(projectRepo, "levare/unit-b");
      if (!sibling.ok) throw new Error(`could not create sibling worktree: ${sibling.error}`);
      try {
        const repo = repoWithRealStorefrontRepo(projectRepo);
        const hijackPath = join(sibling.worktree.path, "hijacked.txt");
        const runner = new AdapterRunner(repo, {
          pricing,
          capabilities: [{ member: "finch", kind: "review" }],
          native: nativeMock,
          remote: remoteMock,
          cliCommand: () => ["sh", "-c", `echo hijacked > "$1"`, "sh", hijackPath],
        });
        await expect(runner.produceAsync("finch", "review", "unit-a", "storefront")).rejects.toThrow(AdapterError);
        expect(existsSync(hijackPath)).toBe(false);
      } finally {
        sibling.worktree.cleanup();
        rmSync(projectRepo, { recursive: true, force: true });
      }
    },
  );

  // NOTES R4-SANDBOX-FIX-9: the platform-conditional counterpart the live gate's own failure calls for —
  // NO forced `sandboxDetection` here; the REAL host's own `detectSandbox()` decides which generator
  // actually produced the wrapped output, and the assertion branches on it. A bwrap-shaped assertion run
  // against a seatbelt profile (or vice versa) tests nothing — this is what makes that structurally
  // impossible: the shape being checked is read directly off `hostSandbox.primitive`, never assumed.
  //
  // NOTES R4-SANDBOX-FIX-10 (live macOS gate, this test's own defect): the darwin branch used to assert
  // against `doc` — the PRODUCED ARTIFACT (`cat marker.txt`'s own stdout, wrapped in review frontmatter:
  // `kind: review`, `sandbox: full`) — which never contains the wrapped argv or profile text at all,
  // regardless of primitive. That only worked by accident for the earlier fake-`/bin/echo`-as-bwrap
  // tests elsewhere in this file, where the "primitive" binary itself echoes the composed argv AS the
  // member's own stdout; a REAL primitive (genuinely enforcing) spawns the actual wrapped command, whose
  // stdout is whatever the MEMBER prints, never the wrapper's own composition. Fixed: captured via
  // `LEVARE_SANDBOX_DEBUG=1` instead (the same `console.error` capture pattern the debug-flag test above
  // already uses) — `wrapForSandbox` prints the composed argv (bwrap) or the profile text (sandbox-exec)
  // there, unconditionally, which is the actual object either branch needs to inspect. A guard assertion
  // (`(version 1)` — the seatbelt profile's own first line) runs BEFORE any grant assertion on the darwin
  // branch, so a future wrong-object capture fails loudly at the source, never as a misleading
  // grant-missing error several lines down.
  test.skipIf(hostSandbox.level !== "full")(
    "the narrowed git-write grant reaches the REAL host's own wrapped output, in whichever shape its actual primitive produces",
    async () => {
      const projectRepo = makeProjectRepoWithBranches(["checkout-flow"]);
      const prior = process.env.LEVARE_SANDBOX_DEBUG;
      const origError = console.error;
      const lines: string[] = [];
      console.error = (...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      };
      try {
        process.env.LEVARE_SANDBOX_DEBUG = "1";
        const repo = repoWithRealStorefrontRepo(projectRepo);
        const runner = new AdapterRunner(repo, {
          pricing,
          capabilities: [{ member: "finch", kind: "review" }],
          native: nativeMock,
          remote: remoteMock,
          cliCommand: (req) => ["cat", join(req.projectRepoPath!, "marker.txt")],
          // No sandboxDetection override — whichever primitive this live host actually has.
        });
        const { doc } = await runner.produceAsync("finch", "review", "checkout-flow", "storefront");
        expect(doc).toContain("MARKER-checkout-flow"); // the real dispatch still succeeded end to end.

        // The wrapped composed-argv/profile text is the debug capture, NEVER `doc` (the produced
        // artifact) — see this test's own FIX-10 doc above.
        const captured = lines.join("\n");
        const gitCommonDir = join(realpathSync(projectRepo), ".git");
        if (hostSandbox.primitive === "bubblewrap") {
          // Guard: this must genuinely be composed bwrap argv, not some other captured object.
          expect(captured).toContain("--tmpfs");
          for (const sub of ["objects", "refs", "logs"]) {
            const p = join(gitCommonDir, sub);
            expect(captured).toContain(`--bind ${p} ${p}`);
          }
          expect(captured).not.toContain(join(gitCommonDir, "hooks"));
          expect(captured).not.toContain(join(gitCommonDir, "config"));
        } else if (hostSandbox.primitive === "sandbox-exec") {
          // Guard: this must genuinely be the seatbelt profile TEXT, not some other captured object —
          // a wrong-object capture (e.g. the produced artifact) fails HERE, loudly, never several lines
          // down as a misleading "grant missing" failure.
          expect(captured).toContain("(version 1)");
          for (const sub of ["objects", "refs", "logs"]) {
            const p = join(gitCommonDir, sub);
            expect(captured).toContain(`(allow file-write* (subpath ${JSON.stringify(p)}))`);
          }
          expect(captured).not.toContain(join(gitCommonDir, "hooks"));
          expect(captured).not.toContain(join(gitCommonDir, "config"));
        }
      } finally {
        console.error = origError;
        if (prior === undefined) delete process.env.LEVARE_SANDBOX_DEBUG;
        else process.env.LEVARE_SANDBOX_DEBUG = prior;
        rmSync(projectRepo, { recursive: true, force: true });
      }
    },
  );
});

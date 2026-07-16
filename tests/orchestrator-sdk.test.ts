import { test, expect, describe, beforeEach } from "bun:test";
import { readFileSync, mkdtempSync, rmSync, cpSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSdkOrchestratorBoundary,
  selectOrchestratorBoundary,
  loadOrchestratorPromptSource,
  coerceIntent,
  ORCHESTRATOR_PROMPT_PATH,
  OrchestratorSdkError,
} from "../src/orchestrator-boundary.ts";
import {
  createAsyncSdkTransport,
  hasAnthropicCredentials,
  resolveNativeBinary,
  checkSdkPreconditions,
  checkSdkPreconditionsCached,
  resetSdkPreconditionCache,
} from "../src/sdk-transport.ts";
import type { AsyncSdkTransport, SdkWorkerRequest, SdkWorkerResponse } from "../src/sdk-transport.ts";

// The precondition cache (sdk-transport.ts) is a module-level singleton shared across every test file
// in this `bun test` process — reset it before each test in this file so no test's result depends on
// what ran before it (this is also what surfaced a real, reproducible finding during development: see
// NOTES phase-7 K13 for a spontaneous, un-caused recurrence of the wrong platform-binary package being
// installed in this very sandbox, unrelated to any code here).
beforeEach(() => {
  resetSdkPreconditionCache();
});

// converse() (ruling C10) grounds itself in a real `loadRepo(root)` of the studio it's given, so —
// unlike interpret()/narrate(), which never touch disk — its tests need a real, valid, committed
// studio tree, not an arbitrary string. Mirrors orchestrator.test.ts's own `seedScratchRepo`.
const HERMETIC_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
function git(repoRoot: string, args: string[]): void {
  const r = spawnSync("git", ["-C", repoRoot, "-c", "user.name=seed", "-c", "user.email=seed@levare.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "init.defaultBranch=main", ...args], {
    encoding: "utf8",
    env: HERMETIC_ENV,
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}${r.stdout}`);
}
function seedScratchRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "levare-orch-sdk-"));
  cpSync("fixtures/golden", root, { recursive: true });
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "seed golden fixture"]);
  return root;
}

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
// NOTES F11: the Orchestrator's model is a studio-level declaration (`studio.md#orchestrator_model`),
// not an environment variable — `LEVARE_ORCHESTRATOR_MODEL` remains a runtime OVERRIDE, checked first,
// but the studio's own file is the source of truth when no override is set.
// ---------------------------------------------------------------------------

describe("the Orchestrator's model resolves from studio.md, with LEVARE_ORCHESTRATOR_MODEL as an override (NOTES F11)", () => {
  test("with no studio.md and no env override, the built-in cheap default is used", async () => {
    const root = seedScratchRepo(); // fixtures/golden carries no studio.md
    try {
      const { transport, calls } = fakeTransport(() => ({ ok: true, result: "narrated." }));
      const boundary = createSdkOrchestratorBoundary({ transport, root, env: {} });
      await boundary.narrate("hi");
      expect(calls[0].model).toBe("claude-sonnet-5"); // DEFAULT_MODEL
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("studio.md#orchestrator_model is the source of truth when no env override is set", async () => {
    const root = seedScratchRepo();
    writeFileSync(join(root, "studio.md"), "---\norchestrator_model: claude-opus-4-8\n---\n\n# Studio\n");
    try {
      const { transport, calls } = fakeTransport(() => ({ ok: true, result: "narrated." }));
      const boundary = createSdkOrchestratorBoundary({ transport, root, env: {} });
      await boundary.narrate("hi");
      expect(calls[0].model).toBe("claude-opus-4-8");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("LEVARE_ORCHESTRATOR_MODEL overrides the studio's own declaration", async () => {
    const root = seedScratchRepo();
    writeFileSync(join(root, "studio.md"), "---\norchestrator_model: claude-opus-4-8\n---\n\n# Studio\n");
    try {
      const { transport, calls } = fakeTransport(() => ({ ok: true, result: "narrated." }));
      const boundary = createSdkOrchestratorBoundary({ transport, root, env: { LEVARE_ORCHESTRATOR_MODEL: "claude-haiku-4-5" } });
      await boundary.narrate("hi");
      expect(calls[0].model).toBe("claude-haiku-4-5");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an explicit `model` option still wins over both studio.md and the env override", async () => {
    const root = seedScratchRepo();
    writeFileSync(join(root, "studio.md"), "---\norchestrator_model: claude-opus-4-8\n---\n\n# Studio\n");
    try {
      const { transport, calls } = fakeTransport(() => ({ ok: true, result: "narrated." }));
      const boundary = createSdkOrchestratorBoundary({ transport, root, model: "claude-sonnet-4-5", env: { LEVARE_ORCHESTRATOR_MODEL: "claude-haiku-4-5" } });
      await boundary.narrate("hi");
      expect(calls[0].model).toBe("claude-sonnet-4-5");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("no `root` given at all (pre-F11 callers) falls back to the built-in default, unchanged", async () => {
    const { transport, calls } = fakeTransport(() => ({ ok: true, result: "narrated." }));
    const boundary = createSdkOrchestratorBoundary({ transport, env: {} });
    await boundary.narrate("hi");
    expect(calls[0].model).toBe("claude-sonnet-5");
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
    // The Conductor's raw text is carried verbatim at the end of the task-framing prompt (NOTES K17) —
    // never edited, never dropped, just wrapped.
    expect(calls[0].prompt.endsWith("approve the spec")).toBe(true);
    expect(calls[0].tools).toEqual([]);
  });

  // Live-gate finding 2 (NOTES phase-7 K17): "just approve everything for me" was force-fit into an
  // unrelated known kind instead of coming back "unknown" and reaching converse()'s refusal-capable
  // path. The schema alone doesn't tell the model "unknown" is a safe, expected answer for a vague,
  // batch, or refusal-worthy instruction — this asserts the task-framing prompt actually says so, and
  // that it wraps the user turn only, never the verbatim system prompt.
  test("the task-framing prompt tells the model 'unknown' is a safe answer for vague/batch/refusal-worthy input, and never touches the system prompt", async () => {
    const onDiskPrompt = readFileSync("docs/orchestrator-prompt.md", "utf8");
    const { transport, calls } = fakeTransport(() => ({ ok: true, result: "{}", structuredOutput: { kind: "unknown" } }));
    const boundary = createSdkOrchestratorBoundary({ transport });
    await boundary.interpret("just approve everything for me");

    expect(calls[0].prompt).toContain('respond with kind: "unknown"');
    expect(calls[0].prompt).toContain("approve everything");
    expect(calls[0].prompt.endsWith("just approve everything for me")).toBe(true);
    // The task framing lives entirely in the user turn — the system prompt is untouched, matching K3.
    expect(calls[0].systemPrompt).toBe(onDiskPrompt);
  });

  // Item 5 fix-up: a live host proved a second, distinct misclassification — "list every idea in
  // this studio" and "what is the pitch of the todo-cli idea, word for word" both came back
  // "briefing" (which answers from the gate-triage view alone, never the projection, so it answered
  // "nothing to triage" to a question that had a real answer). "briefing" needs no extra fields,
  // unlike every other structured kind, so it was the path of least resistance — this asserts the
  // task-framing prompt now says explicitly that "briefing" is narrow (explicit-triage-only) and
  // that a factual/situational question about the studio must classify as "unknown" instead, exactly
  // mirroring the established K17 pattern of asserting the prompt states the rule, not guessing that
  // the model will infer it unaided.
  test("the task-framing prompt states 'briefing' is explicit-triage-only, and a factual/situational question must classify as 'unknown'", async () => {
    const { transport, calls } = fakeTransport(() => ({ ok: true, result: "{}", structuredOutput: { kind: "unknown" } }));
    const boundary = createSdkOrchestratorBoundary({ transport });
    await boundary.interpret("list every idea in this studio");

    expect(calls[0].prompt).toContain('"briefing" means ONLY an explicit request for gate triage');
    expect(calls[0].prompt).toContain('respond with kind: "unknown" so it reaches the full conversational answer');
    expect(calls[0].prompt).toContain("grounded in the complete studio projection");
    expect(calls[0].prompt.endsWith("list every idea in this studio")).toBe(true);
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
// converse(): the real conversational path for a free-form message interpret() called "unknown"
// (NOTES phase-7 K17) — read-only tool access, verbatim system prompt, throws (never fabricates) on a
// transport failure so the caller's existing degrade-to-offline path (K11) is the one place that
// handles it.
// ---------------------------------------------------------------------------

describe("createSdkOrchestratorBoundary#converse (mocked transport)", () => {
  test("grants ZERO tools (ruling C10 — no Read/Grep/Glob, no cwd sandbox) and grounds the prompt in a real projection of the given studio, with the Conductor's text verbatim at the end", async () => {
    const root = seedScratchRepo();
    try {
      const onDiskPrompt = readFileSync("docs/orchestrator-prompt.md", "utf8");
      const { transport, calls } = fakeTransport(() => ({ ok: true, result: "The loyalty flow is in review, waiting on the spec gate." }));
      const boundary = createSdkOrchestratorBoundary({ transport });
      const reply = await boundary.converse("what's the story with the loyalty flow?", root);

      expect(reply).toBe("The loyalty flow is in review, waiting on the spec gate.");
      expect(calls).toHaveLength(1);
      expect(calls[0].systemPrompt).toBe(onDiskPrompt);
      // The Orchestrator holds no filesystem tools at all — the exact fix for the live bug where
      // Read/Grep/Glob let the model wander into levare's OWN source tree instead of the studio.
      expect(calls[0].tools).toEqual([]);
      expect(calls[0].allowedTools).toEqual([]);
      expect(calls[0].cwd).toBeUndefined();
      // The Conductor's raw text is carried verbatim at the very end (never edited), same pattern as
      // interpret()'s INTERPRET_TASK_PREFIX — everything before it is the assembled studio projection.
      expect(calls[0].prompt.endsWith("Conductor: what's the story with the loyalty flow?")).toBe(true);
      // The projection is real, derived from THIS studio's own fixture content, not a stub.
      expect(calls[0].prompt).toContain("kestrel");
      expect(calls[0].prompt).toContain("storefront/checkout-flow");
      expect(calls[0].prompt).toContain("loyalty-program");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a transport failure throws OrchestratorSdkError — it never fabricates a conversational reply", async () => {
    const root = seedScratchRepo();
    try {
      const { transport } = fakeTransport(() => ({ ok: false, error: "worker timed out after 90000ms" }));
      const boundary = createSdkOrchestratorBoundary({ transport });
      await expect(boundary.converse("summarize the loyalty-program idea", root)).rejects.toThrow(OrchestratorSdkError);
      await expect(boundary.converse("summarize the loyalty-program idea", root)).rejects.toThrow(/worker timed out/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("converse() gets its own (longer) timeout, independent of interpret()/narrate()'s", async () => {
    const root = seedScratchRepo();
    try {
      const seen: Array<number | undefined> = [];
      const transport: AsyncSdkTransport = {
        async run(_req, opts) {
          seen.push(opts.timeoutMs);
          return { ok: true, result: "ok" };
        },
      };
      const boundary = createSdkOrchestratorBoundary({ transport, timeoutMs: 45_000, converseTimeoutMs: 12_345 });
      await boundary.interpret("stats");
      await boundary.converse("hi", root);
      expect(seen).toEqual([45_000, 12_345]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Ruling C10's wiring fix: every boundary call must receive the served studio root explicitly —
  // a call constructed without one is an error, never a silent default (e.g. to LEVARE_ROOT or cwd).
  test("called without an explicit studio root, throws rather than defaulting to anything", async () => {
    const { transport } = fakeTransport(() => ({ ok: true, result: "should never be reached" }));
    const boundary = createSdkOrchestratorBoundary({ transport });
    await expect(boundary.converse("hi", "")).rejects.toThrow(/studio root/);
    await expect(boundary.converse("hi", undefined as unknown as string)).rejects.toThrow(/studio root/);
  });

  // The projection must contain ONLY the served studio's own content — nothing from any other
  // directory (the exact live bug: the Orchestrator reported reading levare's own src/, tests/, and
  // a fixture idea that doesn't exist in the studio it was actually serving).
  test("the projection contains only the served studio's own teams/units/gates/ideas — never another studio's", async () => {
    const golden = seedScratchRepo();
    // A second, independently-seeded studio — copied from the same golden fixture (so it's
    // guaranteed to validate) but with its idea swapped for one that exists ONLY here, proving the
    // golden fixture's own projection never leaks into a DIFFERENT studio's, and vice versa.
    const scratch = mkdtempSync(join(tmpdir(), "levare-orch-sdk-scratch-"));
    try {
      cpSync("fixtures/golden", scratch, { recursive: true });
      rmSync(join(scratch, "ideas", "loyalty-program.md"));
      writeFileSync(
        join(scratch, "ideas", "underwater-basket-weaving.md"),
        ["---", "name: underwater-basket-weaving", 'pitch: "A pitch that exists ONLY in the scratch studio."', "---", "", "# Underwater basket weaving", ""].join("\n"),
      );
      git(scratch, ["init", "-q"]);
      git(scratch, ["add", "-A"]);
      git(scratch, ["commit", "-q", "-m", "seed scratch studio"]);

      const { transport: t1, calls: c1 } = fakeTransport(() => ({ ok: true, result: "ok" }));
      await createSdkOrchestratorBoundary({ transport: t1 }).converse("what ideas do we have?", golden);
      expect(c1[0].prompt).toContain("loyalty-program");
      expect(c1[0].prompt).not.toContain("underwater-basket-weaving");

      const { transport: t2, calls: c2 } = fakeTransport(() => ({ ok: true, result: "ok" }));
      await createSdkOrchestratorBoundary({ transport: t2 }).converse("what ideas do we have?", scratch);
      expect(c2[0].prompt).toContain("underwater-basket-weaving");
      expect(c2[0].prompt).not.toContain("loyalty-program");
    } finally {
      rmSync(golden, { recursive: true, force: true });
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// boundary selection: real SDK vs. deterministic offline fallback
// ---------------------------------------------------------------------------

// NOTES C11: there is no second, deterministic boundary implementation any more — "unavailable" is
// `null`, not a stand-in object with its own behavior.
describe("selectOrchestratorBoundary — key-present vs. key-absent", () => {
  test("no ANTHROPIC_API_KEY → null (the Orchestrator is unavailable, not a fallback voice)", () => {
    const boundary = selectOrchestratorBoundary({});
    expect(boundary).toBeNull();
  });

  test("empty-string ANTHROPIC_API_KEY is treated as absent", () => {
    const boundary = selectOrchestratorBoundary({ ANTHROPIC_API_KEY: "" });
    expect(boundary).toBeNull();
  });

  test("ANTHROPIC_API_KEY present → the real SDK-driven boundary, proven by it actually invoking the transport", async () => {
    const { transport, calls } = fakeTransport(() => ({ ok: true, result: "{}", structuredOutput: { kind: "stats" } }));
    const boundary = selectOrchestratorBoundary({ ANTHROPIC_API_KEY: "sk-ant-test-not-real" }, { transport });
    expect(boundary).not.toBeNull();
    const intent = await boundary!.interpret("stats");
    expect(intent).toEqual({ kind: "stats" });
    expect(calls).toHaveLength(1); // proves this call actually went through the (fake) SDK transport
  });
});

// NOTES DIST5: `selectOrchestratorBoundary` no longer takes (or needs) a `compiled` parameter.
// DIST4's forced-`null`-under-compiled special-case existed only because `createAsyncSdkTransport`'s
// worker spawn (`Bun.spawn([process.execPath, SDK_WORKER_PATH])`) genuinely could not work under
// `bun build --compile` — `process.execPath` there was the compiled binary itself, not a `bun`
// interpreter, so the spawn re-entered levare's own CLI parser instead of running the worker script.
// That spawn now self-invokes this same process in worker mode (`workerSpawnArgv`, sdk-transport.ts),
// which works identically compiled or source — so there is no run-mode branch left for
// `selectOrchestratorBoundary` to special-case; the credential/native-binary precondition is the only
// thing that decides its outcome, and this file's other describe blocks already cover that. The
// PROOF that a compiled binary's real self-invoked spawn actually works lives in
// tests/orchestrator-compiled-smoke.test.ts — this test only pins the API surface (no third
// `compiled` argument exists any more).
describe("selectOrchestratorBoundary — no compiled/source branch, only the credential/binary precondition matters (NOTES DIST5)", () => {
  test("a present key and a fake transport (bypassing the real spawn) select a real boundary, unconditionally", async () => {
    const { transport, calls } = fakeTransport(() => ({ ok: true, result: "{}", structuredOutput: { kind: "stats" } }));
    const boundary = selectOrchestratorBoundary({ ANTHROPIC_API_KEY: "sk-ant-test-not-real" }, { transport });
    expect(boundary).not.toBeNull();
    await boundary!.interpret("stats");
    expect(calls).toHaveLength(1);
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

// ---------------------------------------------------------------------------
// Fast, local SDK-viability precondition check (NOTES phase-7 K13): a missing binary or absent
// credential is knowable in milliseconds, without ever attempting (and timing out on) a real spawn.
// ---------------------------------------------------------------------------

// Computed once at module load, independent of resolveNativeBinary itself (a plain existsSync probe,
// not a call to the function under test), so the skip decision below can't be circular.
const platformPackageInstalled = (() => {
  try {
    const req = require("node:module").createRequire(import.meta.url);
    req.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`);
    return true;
  } catch {
    return false;
  }
})();

describe("resolveNativeBinary — mirrors the SDK's own require.resolve-based check exactly", () => {
  // Acceptance ask: "a test asserting the transport can resolve the native CLI on the host platform
  // (skipped when the platform package is absent)" — this repo's own optional-dependency install can
  // genuinely be absent (a pruned CI install, or the K13 spontaneous-swap flakiness recurring), so this
  // must skip rather than fail in that case; when the package IS present, it must actually resolve —
  // this is the literal regression test for the K14 finding (a present sibling package that the SDK's
  // OWN implicit resolution failed to find on at least one host).
  test.skipIf(!platformPackageInstalled)("resolves the real, currently-installed platform binary for this host", () => {
    const resolved = resolveNativeBinary();
    expect(resolved).not.toBeNull();
    expect(resolved).toContain(`claude-agent-sdk-${process.platform}-${process.arch}`);
  });

  test("returns null for a platform/arch combination with no published optional package", () => {
    expect(resolveNativeBinary("nonexistent-platform", "nonexistent-arch")).toBeNull();
  });

  test("returns null when scoped to an empty scratch directory, even for the real platform/arch", () => {
    // requireFrom lets a test simulate 'genuinely missing' without touching the real installed
    // packages — createRequire scoped to a location with no node_modules ancestry finds nothing.
    const dir = mkdtempSync(join(tmpdir(), "levare-empty-require-root-"));
    try {
      expect(resolveNativeBinary(process.platform, process.arch, join(dir, "scratch.ts"))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("checkSdkPreconditions — credential presence + binary resolvability, no network", () => {
  test("no ANTHROPIC_API_KEY → not viable, reason names the credential", () => {
    const check = checkSdkPreconditions({});
    expect(check.viable).toBe(false);
    expect(check.reason).toContain("ANTHROPIC_API_KEY");
  });

  test("credential present but binary unresolvable → not viable, reason names the platform and the fix", () => {
    const dir = mkdtempSync(join(tmpdir(), "levare-empty-require-root-"));
    try {
      const check = checkSdkPreconditions({ ANTHROPIC_API_KEY: "sk-ant-test" }, { requireFrom: join(dir, "scratch.ts") });
      expect(check.viable).toBe(false);
      expect(check.reason).toContain(`${process.platform}-${process.arch}`);
      expect(check.reason).toContain("reinstall");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("credential present and binary resolvable → viable, and the resolved path is surfaced", () => {
    const check = checkSdkPreconditions({ ANTHROPIC_API_KEY: "sk-ant-test" });
    expect(check.viable).toBe(true);
    expect(check.binaryPath).toBe(resolveNativeBinary() ?? undefined);
  });
});

describe("checkSdkPreconditionsCached — probed once, not on every call", () => {
  test("a cached result is returned verbatim within the TTL, even if the underlying params would now differ", () => {
    const dir = mkdtempSync(join(tmpdir(), "levare-empty-require-root-"));
    try {
      const t0 = 1_000_000;
      const first = checkSdkPreconditionsCached({ ANTHROPIC_API_KEY: "sk-ant-test" }, { requireFrom: join(dir, "scratch.ts") }, t0);
      expect(first.viable).toBe(false);
      // Called again 5s later (well inside the 30s TTL) with params that WOULD now resolve — the
      // cached (stale) result must win, proving this genuinely skips recomputation, not just
      // coincidentally agrees.
      const second = checkSdkPreconditionsCached({ ANTHROPIC_API_KEY: "sk-ant-test" }, {}, t0 + 5_000);
      expect(second).toEqual(first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("past the TTL, the check re-runs with the new params", () => {
    const dir = mkdtempSync(join(tmpdir(), "levare-empty-require-root-"));
    try {
      const t0 = 2_000_000;
      const first = checkSdkPreconditionsCached({ ANTHROPIC_API_KEY: "sk-ant-test" }, { requireFrom: join(dir, "scratch.ts") }, t0);
      expect(first.viable).toBe(false);
      const second = checkSdkPreconditionsCached({ ANTHROPIC_API_KEY: "sk-ant-test" }, {}, t0 + 30_001);
      expect(second.viable).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("selectOrchestratorBoundary — the fast-fail precondition, end to end", () => {
  test("credential present but the binary is unresolvable → null, WITHOUT ever touching the injected transport", () => {
    const dir = mkdtempSync(join(tmpdir(), "levare-empty-require-root-"));
    try {
      let transportCalled = false;
      const neverCalledTransport: AsyncSdkTransport = {
        async run() {
          transportCalled = true;
          return { ok: true, result: "should never happen" };
        },
      };
      const boundary = selectOrchestratorBoundary(
        { ANTHROPIC_API_KEY: "sk-ant-test" },
        { transport: neverCalledTransport, precondition: { requireFrom: join(dir, "scratch.ts") } },
      );
      expect(boundary).toBeNull();
      expect(transportCalled).toBe(false); // proves this short-circuited before any spawn attempt
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("credential present and binary resolvable → the real SDK boundary, transport reachable", async () => {
    const { transport, calls } = fakeTransport(() => ({ ok: true, result: "{}", structuredOutput: { kind: "stats" } }));
    const boundary = selectOrchestratorBoundary({ ANTHROPIC_API_KEY: "sk-ant-test" }, { transport });
    expect(boundary).not.toBeNull();
    await boundary!.interpret("stats");
    expect(calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// K14: the real invocation NEVER relies on the SDK's own implicit binary resolution — it always
// carries an explicitly-resolved pathToClaudeCodeExecutable, resolved by THIS repo's own code, the
// same code the fast-precondition probe already proved viable. A live host showed the SDK's own
// internal require.resolve-based lookup fail to find a platform binary that genuinely existed as a
// sibling node_modules package — "the probe works, what it probed for did not" was actually "the
// probe and the real call used two different resolution attempts that could disagree"; passing an
// explicit path collapses them into the same one, by construction.
// ---------------------------------------------------------------------------

describe("pathToClaudeCodeExecutable is resolved explicitly and threaded to every real request", () => {
  test("createSdkOrchestratorBoundary resolves once and sends the same path on interpret() and narrate()", async () => {
    const { transport, calls } = fakeTransport(() => ({ ok: true, result: "{}", structuredOutput: { kind: "stats" } }));
    const boundary = createSdkOrchestratorBoundary({ transport });
    await boundary.interpret("stats");
    await boundary.narrate("hi");
    expect(calls).toHaveLength(2);
    // Both requests carry the identical resolved value (present or undefined depending on this
    // sandbox's own install state — either way, the SAME value both times, never re-derived per call).
    expect(calls[0].pathToClaudeCodeExecutable).toBe(calls[1].pathToClaudeCodeExecutable);
  });

  test.skipIf(!platformPackageInstalled)("when the binary IS resolvable, the exact resolved path is threaded through", async () => {
    const { transport, calls } = fakeTransport(() => ({ ok: true, result: "{}", structuredOutput: { kind: "stats" } }));
    const boundary = createSdkOrchestratorBoundary({ transport });
    await boundary.interpret("stats");
    expect(calls[0].pathToClaudeCodeExecutable).toBe(resolveNativeBinary() ?? undefined);
  });

  test("an explicit pathToClaudeCodeExecutable override wins over resolution", async () => {
    const { transport, calls } = fakeTransport(() => ({ ok: true, result: "{}", structuredOutput: { kind: "stats" } }));
    const boundary = createSdkOrchestratorBoundary({ transport, pathToClaudeCodeExecutable: "/explicit/override/claude" });
    await boundary.interpret("stats");
    expect(calls[0].pathToClaudeCodeExecutable).toBe("/explicit/override/claude");
  });

  test("selectOrchestratorBoundary reuses the EXACT path its own precondition probe resolved — not a second, separate resolution", async () => {
    const { transport, calls } = fakeTransport(() => ({ ok: true, result: "{}", structuredOutput: { kind: "stats" } }));
    const boundary = selectOrchestratorBoundary({ ANTHROPIC_API_KEY: "sk-ant-test" }, { transport });
    expect(boundary).not.toBeNull();
    await boundary!.interpret("stats");
    const check = checkSdkPreconditionsCached({ ANTHROPIC_API_KEY: "sk-ant-test" });
    expect(calls[0].pathToClaudeCodeExecutable).toBe(check.binaryPath);
  });
});

describe("the missing-binary case is fast end to end (the acceptance criterion itself)", () => {
  test("POST /orchestrator/message reports disabled in well under a second, not at the timeout boundary", async () => {
    const { createBoard } = await import("../src/board/serve.ts");
    const dir = mkdtempSync(join(tmpdir(), "levare-fast-fail-board-"));
    const scratchDir = mkdtempSync(join(tmpdir(), "levare-empty-require-root-"));
    try {
      const { cpSync } = await import("node:fs");
      cpSync("fixtures/golden", dir, { recursive: true });
      const board = createBoard(dir, {
        orchestratorSelectOpts: { precondition: { requireFrom: join(scratchDir, "scratch.ts") } },
      });
      try {
        const start = Date.now();
        const res = await board.fetch(
          new Request("http://localhost/orchestrator/message", {
            method: "POST",
            headers: { "content-type": "application/json", "x-fake-key": "1" },
            body: JSON.stringify({ text: "stats" }),
          }),
        );
        // Note: the route reads process.env for the real key check, not the request — this test's
        // point is the SELECTION path's speed once credentials + a broken precondition combine, which
        // is exercised directly above; this end-to-end pass additionally confirms the route itself
        // never introduces its own slow path (e.g. an accidental extra spawn) on top of selection.
        const elapsed = Date.now() - start;
        // NOTES C11: no credential + a broken precondition → the route reports the disabled state
        // (503), never a 200 with a fabricated reply — the fast-fail acceptance criterion is unchanged,
        // only the status this now honestly reports.
        expect(res.status).toBe(503);
        const body = await res.json();
        expect(body.disabled).toBe(true);
        expect(elapsed).toBeLessThan(1000);
      } finally {
        board.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });
});

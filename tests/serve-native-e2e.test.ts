import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBoard } from "../src/board/serve.ts";
import { loadRepo } from "../src/repo.ts";
import { loadPricing } from "../src/pricing.ts";
import { validateArtifactSource } from "../src/validate.ts";
import { AdapterRunner, createSdkNativeBoundary, createAsyncSdkNativeBoundary, type RemoteBoundary } from "../src/adapters.ts";
import type { AsyncSdkTransport, SdkWorkerRequest, SdkWorkerResponse } from "../src/sdk-transport.ts";
import type { AsyncMemberRunner } from "../src/dagwalk.ts";

// NOTES F8 — the second time a fixture leaked into production (F4 was the first): a live dogfood run
// showed a NATIVE member's artifact was the golden fixture's canned stub content verbatim, attributed
// to an agent not even on the invoking team, with a fabricated usage block and zero real spend. This
// proves the fix end to end: `createBoard` (the same router `levare serve` mounts) driven against a
// scratch studio, resolving a real `start` gate for `wren` (kind: native, team kestrel, golden fixture)
// through the REAL AdapterRunner/native-boundary/env-scoping/tool-allowlist machinery — only the SDK
// TRANSPORT is faked (this sandbox has no live ANTHROPIC_API_KEY, the same K12 deferral every other SDK
// e2e test in this repo already records) — and asserts the produced artifact's body is what the "model"
// (the fake transport) actually returned, grounded in the unit's own pitch, never the fixture's
// checkout-flow product-brief prose.

const HERMETIC_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" };

function git(root: string, args: string[]): void {
  const r = spawnSync(
    "git",
    ["-C", root, "-c", "user.name=seed", "-c", "user.email=seed@levare.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "init.defaultBranch=main", ...args],
    { encoding: "utf8", env: HERMETIC_ENV },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}${r.stdout}`);
}

function seedScratchRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "levare-native-e2e-"));
  cpSync("fixtures/golden", root, { recursive: true });
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "seed golden fixture"]);
  return root;
}

function req(url: string, init?: RequestInit): Request {
  return new Request(`http://localhost${url}`, init);
}

// The "model's" own artifact — grounded in loyalty-flow's own unit description/pitch ("Reward repeat
// storefront buyers with points redeemable at checkout", unit.md), never the golden fixture's
// checkout-flow product-brief prose (fixtures/stubs/member-stub.ts's canned "wren:product-brief" body).
const MODEL_BODY_MARKER = "MODEL-AUTHORED-NOT-FIXTURE";
const MODEL_BODY = [
  `# Product brief — loyalty-flow (${MODEL_BODY_MARKER})`,
  "",
  "**Problem.** Repeat storefront buyers have no reason to come back sooner than they otherwise would.",
  "**Job to be done.** Reward repeat storefront buyers with points redeemable at checkout.",
  "**Success signal.** Repeat purchase rate up, measured 30 days post-ship.",
  "",
].join("\n");

// Ruling C12: a model was never told the artifact contract, so it never emits plain prose ONLY — no
// frontmatter fence at all. This is the actual bug this test suite reproduces (NOTES C12): a native
// member's SDK call succeeded and its plain-prose output was then rejected with "document has no
// frontmatter fence" by levare's own boundary validator.
const FAKE_MODEL_DOC = MODEL_BODY;

// A second, deliberately-hostile shape: a model that DID guess at the schema and wrapped its own
// (wrong, fabricated) frontmatter around the same content — every field is wrong except the body, to
// prove levare strips and re-authors it rather than trusting any of it.
const HOSTILE_FRONTMATTER_MODEL_DOC = [
  "---",
  "kind: product-brief",
  "id: totally-fabricated-id",
  "unit: some-other-unit",
  "project: some-other-project",
  "status: approved",
  "produced_by: nobody/ghost",
  "consumes: [made-up-artifact]",
  "supersedes: brief-old",
  'approved_by: "self-approved 2020-01-01"',
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
  MODEL_BODY,
].join("\n");

const REAL_SDK_RECEIPT = { model: "claude-sonnet", tokens_in: 6412, tokens_out: 1180, wall_clock_s: 22.4, usd: 0.0891, unreported: false };

describe("`levare serve` invokes a native member through the real SDK boundary (NOTES F8)", () => {
  test("starting loyalty-flow's satisfied start gate produces an artifact authored by the fake model, not the fixture stub", async () => {
    const root = seedScratchRepo();
    try {
      const calls: SdkWorkerRequest[] = [];
      const fakeAsyncTransport: AsyncSdkTransport = {
        async run(request: SdkWorkerRequest): Promise<SdkWorkerResponse> {
          calls.push(request);
          return { ok: true, result: FAKE_MODEL_DOC, receipt: REAL_SDK_RECEIPT };
        },
      };
      const unusedRemote: RemoteBoundary = {
        call: () => {
          throw new Error("not used — loyalty-flow's first step is wren (native)");
        },
      };
      // Exactly what productionAdapterRunner (replay.ts) wires in production, except the SDK transport
      // is faked — the real AdapterRunner drives context assembly, env scoping, and the tool allowlist.
      const repo = loadRepo(root);
      const adapterRunner = new AdapterRunner(repo, {
        pricing: loadPricing(root),
        native: createSdkNativeBoundary({ transport: { run: () => ({ ok: false, error: "sync transport must not be called by produceAsync" }) } }),
        asyncNative: createAsyncSdkNativeBoundary({ transport: fakeAsyncTransport, env: { PATH: "/usr/bin", HOME: "/home/test" } }),
        remote: unusedRemote,
      });
      const memberRunner: AsyncMemberRunner = {
        capabilities: () => adapterRunner.capabilities(),
        produce: (member, kind, unit, project) => adapterRunner.produceAsync(member, kind, unit, project),
      };

      const board = createBoard(root, { memberRunner });
      const res = await board.fetch(req("/gates/storefront/loyalty-flow/start", { method: "POST" }));
      board.close();
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);

      // The SDK was actually invoked exactly once, with wren's own model and the real §6-assembled
      // context (unit/agent-specific — never a generic or fixture-borrowed prompt).
      expect(calls).toHaveLength(1);
      expect(calls[0].model).toBe("claude-sonnet");
      expect(calls[0].prompt).toContain("kestrel/wren");
      expect(calls[0].prompt).toContain("storefront/loyalty-flow");

      const artifactPath = join(root, "work/storefront/loyalty-flow/product-brief-loyalty-flow-v1.md");
      const doc = readFileSync(artifactPath, "utf8");

      // The artifact's body came from the fake model, grounded in the unit's own pitch.
      expect(doc).toContain(MODEL_BODY_MARKER);
      expect(doc).toContain("Reward repeat storefront buyers with points redeemable at checkout");
      // ...and NEVER the golden fixture's canned checkout-flow product-brief prose (the F8 bug: the
      // fixture's own body leaking into a live studio's artifact).
      expect(doc).not.toContain("three-page checkout loses buyers between address and payment");
      expect(doc).not.toContain("checkout-flow");

      // produced_by names the agent that ACTUALLY ran (kestrel/wren, the team invoking it) — never a
      // fabricated attribution to an agent outside the team, as the live dogfood bug showed.
      expect(doc).toContain("produced_by: kestrel/wren");
      expect(doc).toContain("unit: loyalty-flow");
      expect(doc).toContain("project: storefront");

      // Ruling C12: the model was never told the artifact contract and returned plain prose — no
      // frontmatter fence at all (FAKE_MODEL_DOC === MODEL_BODY). levare authored the whole wrapper
      // itself: a valid document, a unit-scoped id, consumes: [] (nothing approved yet), status
      // in-review, approved_by: null, and the SDK's own reported usage receipt — never a model's
      // guess at any of it.
      expect(doc).toContain("id: product-brief-loyalty-flow-v1");
      expect(doc).toContain("status: in-review");
      expect(doc).toContain("consumes: []");
      expect(doc).toContain("supersedes: null");
      expect(doc).toContain("approved_by: null");
      expect(doc).toContain("files: []");
      expect(doc).toContain("usage:");
      expect(doc).toContain("tokens_in: 6412");
      expect(doc).toContain("usd: 0.0891");
      const parsed = validateArtifactSource(doc);
      expect(parsed).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a model that DOES wrap its output in a frontmatter fence has it stripped and replaced with levare's own values", async () => {
    const root = seedScratchRepo();
    try {
      const fakeAsyncTransport: AsyncSdkTransport = {
        async run(): Promise<SdkWorkerResponse> {
          return { ok: true, result: HOSTILE_FRONTMATTER_MODEL_DOC, receipt: REAL_SDK_RECEIPT };
        },
      };
      const repo = loadRepo(root);
      const adapterRunner = new AdapterRunner(repo, {
        pricing: loadPricing(root),
        native: createSdkNativeBoundary({ transport: { run: () => ({ ok: false, error: "sync transport must not be called by produceAsync" }) } }),
        asyncNative: createAsyncSdkNativeBoundary({ transport: fakeAsyncTransport, env: { PATH: "/usr/bin", HOME: "/home/test" } }),
        remote: { call: () => { throw new Error("not used"); } },
      });
      const memberRunner: AsyncMemberRunner = {
        capabilities: () => adapterRunner.capabilities(),
        produce: (member, kind, unit, project) => adapterRunner.produceAsync(member, kind, unit, project),
      };

      const board = createBoard(root, { memberRunner });
      const res = await board.fetch(req("/gates/storefront/loyalty-flow/start", { method: "POST" }));
      board.close();
      expect(res.status).toBe(200);

      const artifactPath = join(root, "work/storefront/loyalty-flow/product-brief-loyalty-flow-v1.md");
      const doc = readFileSync(artifactPath, "utf8");

      // Every self-declared field the model guessed at is gone, replaced with levare's own facts.
      expect(doc).toContain("id: product-brief-loyalty-flow-v1");
      expect(doc).not.toContain("totally-fabricated-id");
      expect(doc).toContain("unit: loyalty-flow");
      expect(doc).toContain("project: storefront");
      expect(doc).toContain("status: in-review");
      expect(doc).not.toContain("status: approved");
      expect(doc).toContain("produced_by: kestrel/wren");
      expect(doc).not.toContain("nobody/ghost");
      expect(doc).toContain("supersedes: null");
      expect(doc).not.toContain("brief-old");
      expect(doc).toContain("approved_by: null");
      expect(doc).not.toContain("self-approved");
      expect(doc).toContain("files: []");
      expect(doc).not.toContain("fake.txt");
      // The SDK's own reported receipt is used verbatim — never the model's fabricated $999.99.
      expect(doc).toContain("usd: 0.0891");
      expect(doc).not.toContain("999.99");
      expect(doc).not.toContain("made-up-model");
      // Only the body survives.
      expect(doc).toContain(MODEL_BODY_MARKER);
      expect(validateArtifactSource(doc)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the spawned SDK call receives ONLY wren's allowlisted env and ONLY its declared tools", async () => {
    const root = seedScratchRepo();
    try {
      let seenEnv: Record<string, string | undefined> = {};
      const calls: SdkWorkerRequest[] = [];
      const fakeAsyncTransport: AsyncSdkTransport = {
        async run(request, opts) {
          calls.push(request);
          seenEnv = opts.env;
          return { ok: true, result: FAKE_MODEL_DOC, receipt: REAL_SDK_RECEIPT };
        },
      };
      const repo = loadRepo(root);
      // A hostile base env: real secrets that wren was never granted (wren declares no `connectors:`
      // in the golden fixture) — none of these may reach the spawned SDK call.
      const hostileBaseEnv = { PATH: "/usr/bin", HOME: "/home/test", GITHUB_TOKEN: "ghp_should_never_leak", ANTHROPIC_API_KEY: "sk-ant-platform-key" };
      const adapterRunner = new AdapterRunner(repo, {
        pricing: loadPricing(root),
        baseEnv: hostileBaseEnv,
        native: createSdkNativeBoundary({ transport: { run: () => ({ ok: false, error: "sync must not be called" }) }, env: hostileBaseEnv }),
        asyncNative: createAsyncSdkNativeBoundary({ transport: fakeAsyncTransport, env: hostileBaseEnv }),
        remote: { call: () => { throw new Error("not used"); } },
      });
      const memberRunner: AsyncMemberRunner = {
        capabilities: () => adapterRunner.capabilities(),
        produce: (member, kind, unit, project) => adapterRunner.produceAsync(member, kind, unit, project),
      };
      const board = createBoard(root, { memberRunner });
      const res = await board.fetch(req("/gates/storefront/loyalty-flow/start", { method: "POST" }));
      board.close();
      expect(res.status).toBe(200);

      expect(calls).toHaveLength(1);
      // Tool allowlist: exactly wren's declared `tools: [read, write]` — both fields, never implicit.
      expect(calls[0].tools).toEqual(["read", "write"]);
      expect(calls[0].allowedTools).toEqual(["read", "write"]);

      // Env allowlist: PATH/HOME baseline plus the forwarded platform credential — GITHUB_TOKEN (a
      // connector wren was never granted) never reaches the spawned call.
      expect(seenEnv.PATH).toBe("/usr/bin");
      expect(seenEnv.HOME).toBe("/home/test");
      expect(seenEnv.ANTHROPIC_API_KEY).toBe("sk-ant-platform-key");
      expect(seenEnv.GITHUB_TOKEN).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an agent declaring no `tools:` reaches the SDK with an empty allowlist end to end", async () => {
    const root = seedScratchRepo();
    try {
      // Rewire wren to declare no `tools:` at all — the studio-level equivalent of the boundary-level
      // unit test, proving the empty allowlist survives the full context-assembly/env-scoping path.
      const wrenFile = join(root, "agents/wren.md");
      const original = readFileSync(wrenFile, "utf8");
      const noTools = original.replace("tools: [read, write]\n", "");
      writeFileSync(wrenFile, noTools);
      git(root, ["add", "-A"]);
      git(root, ["commit", "-q", "-m", "wren declares no tools"]);

      const calls: SdkWorkerRequest[] = [];
      const fakeAsyncTransport: AsyncSdkTransport = {
        async run(request) {
          calls.push(request);
          return { ok: true, result: FAKE_MODEL_DOC, receipt: REAL_SDK_RECEIPT };
        },
      };
      const repo = loadRepo(root);
      const adapterRunner = new AdapterRunner(repo, {
        pricing: loadPricing(root),
        native: createSdkNativeBoundary({ transport: { run: () => ({ ok: false, error: "sync must not be called" }) } }),
        asyncNative: createAsyncSdkNativeBoundary({ transport: fakeAsyncTransport }),
        remote: { call: () => { throw new Error("not used"); } },
      });
      const memberRunner: AsyncMemberRunner = {
        capabilities: () => adapterRunner.capabilities(),
        produce: (member, kind, unit, project) => adapterRunner.produceAsync(member, kind, unit, project),
      };
      const board = createBoard(root, { memberRunner });
      const res = await board.fetch(req("/gates/storefront/loyalty-flow/start", { method: "POST" }));
      board.close();
      expect(res.status).toBe(200);

      expect(calls).toHaveLength(1);
      expect(calls[0].tools).toEqual([]);
      expect(calls[0].allowedTools).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBoard } from "../src/board/serve.ts";
import { createSdkOrchestratorBoundary } from "../src/orchestrator-boundary.ts";
import type { AsyncSdkTransport } from "../src/sdk-transport.ts";
import { stubAdapterRunner } from "../src/replay.ts";
import { loadRepo } from "../src/repo.ts";

// Phase-4 acceptance (PRD §11): "an integration test POSTs approve on the fixture's open gate and
// asserts the artifact file shows approved_by and `git log -1` shows the commit." Exercised against
// a scratch git repo seeded from fixtures/golden — hermetic in the same way tests/immutability.test.ts
// is, so the suite behaves identically on a bare container and a developer host with real git config.

const HERMETIC_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

function git(repoRoot: string, args: string[]): ReturnType<typeof spawnSync> {
  const r = spawnSync(
    "git",
    ["-C", repoRoot, "-c", "user.name=seed", "-c", "user.email=seed@levare.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "init.defaultBranch=main", ...args],
    { encoding: "utf8", env: HERMETIC_ENV },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}${r.stdout}`);
  return r;
}

function seedScratchRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "levare-board-"));
  cpSync("fixtures/golden", root, { recursive: true });
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "seed golden fixture"]);
  return root;
}

function req(url: string, init?: RequestInit): Request {
  return new Request(`http://localhost${url}`, init);
}

describe("levare serve — GET screens (in-process, no socket)", () => {
  let root: string;
  let board: ReturnType<typeof createBoard>;

  beforeAll(() => {
    root = seedScratchRepo();
    board = createBoard(root);
  });
  afterAll(() => {
    board.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("GET / renders studio directly (200, not a redirect)", async () => {
    const res = await board.fetch(req("/"));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('class="apphead"');
    expect(text).toContain('class="gate"');
  });

  test("GET /studio, /project/:name, /run/:project/:unit, /registry all 200", async () => {
    for (const url of ["/studio", "/project/storefront", "/run/storefront/checkout-flow", "/registry"]) {
      const res = await board.fetch(req(url));
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("<!doctype html>");
    }
  });

  // Item 1 + 6, phase 7.5: the artifact render view is a real, routed screen — not just a pure
  // function tested in isolation.
  test("GET /artifact/:project/:unit/:id and /idea/:name render the artifact render view", async () => {
    const artifactRes = await board.fetch(req("/artifact/storefront/checkout-flow/spec-checkout-flow-v1"));
    expect(artifactRes.status).toBe(200);
    const artifactText = await artifactRes.text();
    expect(artifactText).toContain("<!doctype html>");
    expect(artifactText).toContain("spec-checkout-flow-v1");
    expect(artifactText).toContain("Lineage");

    const ideaRes = await board.fetch(req("/idea/loyalty-program"));
    expect(ideaRes.status).toBe(200);
    const ideaText = await ideaRes.text();
    expect(ideaText).toContain("<!doctype html>");
    expect(ideaText).toContain("loyalty-program");
  });

  test("GET /styles.css and /app.js serve the verbatim assets", async () => {
    const css = await board.fetch(req("/styles.css"));
    expect(css.status).toBe(200);
    expect(await css.text()).toBe(readFileSync("assets/styles.css", "utf8"));

    const js = await board.fetch(req("/app.js"));
    expect(js.status).toBe(200);
    const served = await js.text();
    // app.js carries minimal, documented network wiring on top of the frozen interaction vocabulary
    // (see NOTES.md) — assert the frozen parts (theme toggle, gate-card anatomy) are untouched.
    expect(served).toContain("levare-theme");
    expect(served).toContain("function resolveGate(card, label, cls)");
  });

  test("unknown route is 404", async () => {
    const res = await board.fetch(req("/nope"));
    expect(res.status).toBe(404);
  });
});

// UI4 item 4: registry URLs as path segments (/registry/<kind>, /registry/<kind>/<name>), matching
// /project/<name> and /idea/<name> elsewhere in the product. The named risk: a COLD GET of a deep
// link (someone pastes /registry/agents/corvid straight into the address bar) must render the
// registry with the right kind shown and that entity highlighted — never a 404, never a blank
// fallback — and the legacy `?entity=` query-param form must keep resolving so no existing link or
// bookmark breaks.
describe("levare serve — GET /registry/<kind> and /registry/<kind>/<name> (path-segment routing)", () => {
  let root: string;
  let board: ReturnType<typeof createBoard>;

  beforeAll(() => {
    root = seedScratchRepo();
    board = createBoard(root);
  });
  afterAll(() => {
    board.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("a cold GET of /registry/teams renders the registry with the teams kind active", async () => {
    const res = await board.fetch(req("/registry/teams"));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("<!doctype html>");
    expect(text).toContain("<h1>Teams</h1>");
    expect(text).toContain('data-goto="teams" class="is-active"');
    expect(text).not.toContain("data-highlight"); // no specific entity named — no highlight target
  });

  test("a cold GET of /registry/connectors/linear renders the registry, connectors active, linear as the highlight target — not a 404, not blank", async () => {
    const res = await board.fetch(req("/registry/connectors/linear"));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("<!doctype html>");
    expect(text).toContain("<h1>Connectors</h1>");
    expect(text).toContain('data-goto="connectors" class="is-active"');
    expect(text).toContain('data-highlight="connectors-linear"');
    // still the list view, not a detail screen — every connector's card is present, not just linear's.
    expect(text).toContain('id="connectors-github"');
    expect(text).toContain('id="connectors-linear"');
  });

  test("every registry entity kind resolves as a cold path GET", async () => {
    for (const kind of ["teams", "agents", "skills", "knowledge", "types", "connectors", "evals"]) {
      const res = await board.fetch(req(`/registry/${kind}`));
      expect(res.status).toBe(200);
      expect(await res.text()).toContain(`data-goto="${kind}" class="is-active"`);
    }
  });

  test("the legacy ?entity= query-param form still resolves, unchanged", async () => {
    const res = await board.fetch(req("/registry?entity=connectors"));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('data-goto="connectors" class="is-active"');
  });

  test("the rail emits path-form links, never the old ?entity= form", async () => {
    const res = await board.fetch(req("/registry/agents"));
    const text = await res.text();
    expect(text).toContain('href="/registry/teams"');
    expect(text).toContain('href="/registry/connectors/github"');
    expect(text).not.toContain("/registry?entity=");
  });
});

describe("levare serve — POST /gates approve round trip", () => {
  let root: string;
  let board: ReturnType<typeof createBoard>;

  beforeAll(() => {
    root = seedScratchRepo();
    board = createBoard(root);
  });
  afterAll(() => {
    board.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("approving the fixture's open gate flips frontmatter, validates, and commits as the Conductor", async () => {
    const artifactPath = join(root, "work/storefront/checkout-flow/spec-checkout-flow-v1.md");
    const before = readFileSync(artifactPath, "utf8");
    expect(before).toContain("status: in-review");
    expect(before).toContain("approved_by: null");

    const res = await board.fetch(
      req("/gates/storefront/spec-checkout-flow-v1/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note: "looks good" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.commit).toBe("string");
    expect(body.commit.length).toBe(40);

    const after = readFileSync(artifactPath, "utf8");
    expect(after).toContain("status: approved");
    expect(after).toMatch(/approved_by: "cas \d{4}-\d{2}-\d{2}"/);

    const log = spawnSync("git", ["-C", root, "log", "-1", "--format=%H|%an|%ae|%s"], { encoding: "utf8" });
    expect(log.status).toBe(0);
    const [sha, author, email, subject] = log.stdout.trim().split("|");
    expect(sha).toBe(body.commit);
    expect(author).toBe("cas");
    expect(email).toBe("cas@levare.local");
    expect(subject).toContain("approve spec-checkout-flow-v1");

    // approving does not touch any other artifact's file.
    const brief = readFileSync(join(root, "work/storefront/checkout-flow/product-brief-v1.md"), "utf8");
    expect(brief).toContain('approved_by: "cas 2026-07-08"');
  });

  test("re-approving an already-resolved gate is rejected (409), not silently repeated", async () => {
    const res = await board.fetch(req("/gates/storefront/spec-checkout-flow-v1/approve", { method: "POST" }));
    expect(res.status).toBe(409);
  });

  test("approving an unknown artifact id is 404", async () => {
    const res = await board.fetch(req("/gates/storefront/does-not-exist/approve", { method: "POST" }));
    expect(res.status).toBe(404);
  });
});

describe("levare serve — POST /gates reject and request", () => {
  let root: string;
  let board: ReturnType<typeof createBoard>;

  beforeAll(() => {
    root = seedScratchRepo();
    // spec-checkout-flow-v1 is produced by lyra (kind: native) — request-changes re-invokes it
    // (board/gateops.ts#doRequest) through the real MemberRunner boundary; mocked here (NOTES F8) so
    // this gate-mechanics test doesn't need a live ANTHROPIC_API_KEY.
    board = createBoard(root, { memberRunner: stubAdapterRunner(loadRepo(root)) });
  });
  afterAll(() => {
    board.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("request-changes without a note is rejected", async () => {
    const res = await board.fetch(req("/gates/storefront/spec-checkout-flow-v1/request", { method: "POST" }));
    expect(res.status).toBe(400);
  });

  test("request-changes with a note supersedes the artifact with a new version", async () => {
    const res = await board.fetch(
      req("/gates/storefront/spec-checkout-flow-v1/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note: "clarify the idempotency key" }),
      }),
    );
    expect(res.status).toBe(200);
    const oldDoc = readFileSync(join(root, "work/storefront/checkout-flow/spec-checkout-flow-v1.md"), "utf8");
    expect(oldDoc).toContain("status: superseded");
    const newDoc = readFileSync(join(root, "work/storefront/checkout-flow/spec-checkout-flow-v2.md"), "utf8");
    expect(newDoc).toContain("status: in-review");
    expect(newDoc).toContain("supersedes: spec-checkout-flow-v1");
  });
});

describe("levare serve — POST /registry validate → write → commit", () => {
  let root: string;
  let board: ReturnType<typeof createBoard>;

  beforeAll(() => {
    root = seedScratchRepo();
    board = createBoard(root);
  });
  afterAll(() => {
    board.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("a valid edit is written and committed", async () => {
    const file = join(root, "knowledge/house-style.md");
    const content = readFileSync(file, "utf8").replace("Calm, factual, slightly dry.", "Calm, factual, dry, and precise.");
    const res = await board.fetch(
      req("/registry/knowledge/house-style.md", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content }),
      }),
    );
    expect(res.status).toBe(200);
    expect(readFileSync(file, "utf8")).toBe(content);
  });

  test("an invalid edit (same validator) is rejected and the file is rolled back", async () => {
    const file = join(root, "knowledge/house-style.md");
    const before = readFileSync(file, "utf8");
    const res = await board.fetch(
      req("/registry/knowledge/house-style.md", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: before + "\nbogus: not-a-declared-field\n" }),
      }),
    );
    // The bogus text lands in the body, not frontmatter (past the closing ---), so this specific
    // payload stays schema-valid; assert instead with a genuinely invalid frontmatter document.
    void res;
    const badFrontmatter = "---\nname: house-style\nbogus_key: 1\n---\nbroken\n";
    const res2 = await board.fetch(
      req("/registry/knowledge/house-style.md", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: badFrontmatter }),
      }),
    );
    expect(res2.status).toBe(422);
    expect(readFileSync(file, "utf8")).not.toBe(badFrontmatter);
  });
});

// UI3: the registry overlay editor's live-validation route. The critical property (goal item 3): it
// must run the exact same validator `levare validate` and the save route both use, against the
// UNSAVED buffer — including cross-reference checks that read other files off disk (here,
// UNKNOWN_MODEL, which cross-references knowledge/model-pricing.md across every agent in the tree) —
// without ever writing the candidate content to disk first.
describe("levare serve — POST /registry/check/*path (live validation of an unsaved buffer)", () => {
  let root: string;
  let board: ReturnType<typeof createBoard>;

  beforeAll(() => {
    root = seedScratchRepo();
    board = createBoard(root);
  });
  afterAll(() => {
    board.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("a buffer that would pass `levare validate` reports ok:true, unchanged from disk", async () => {
    const file = join(root, "knowledge/house-style.md");
    const content = readFileSync(file, "utf8");
    const res = await board.fetch(
      req("/registry/check/knowledge/house-style.md", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; errors: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.errors).toEqual([]);
    // Never written — a live-typing check has no write side effect at all.
    expect(readFileSync(file, "utf8")).toBe(content);
  });

  test("a buffer that would fail `levare validate` (malformed frontmatter) reports ok:false with the real error, and writes nothing to disk", async () => {
    const file = join(root, "knowledge/house-style.md");
    const before = readFileSync(file, "utf8");
    const badFrontmatter = "---\nname: house-style\nbogus_key: 1\n---\nbroken\n";
    const res = await board.fetch(
      req("/registry/check/knowledge/house-style.md", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: badFrontmatter }),
      }),
    );
    expect(res.status).toBe(200); // a live check reports its verdict in the body, never a write-route status code
    const body = (await res.json()) as { ok: boolean; errors: Array<{ code: string; message: string; file: string }> };
    expect(body.ok).toBe(false);
    expect(body.errors.some((e) => e.code === "UNKNOWN_KEY")).toBe(true);
    // Untouched on disk — the whole point of validating the buffer, not the file.
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  // The CRITICAL case: a cross-reference check (UNKNOWN_MODEL, validate.ts#validateKnownModels) reads
  // EVERY agent file off disk to build its known-model set check — for the entity being edited
  // (agents/lyra.md) to be checked against its OWN unsaved edit, the overlay has to reach into that
  // cross-entity walk, not just the single-file schema pass. This is exactly "overlaid on the real
  // repo for cross-reference checks" from the goal, exercised end to end through the real route.
  test("cross-reference checks (UNKNOWN_MODEL) see the unsaved buffer, not the on-disk agent file", async () => {
    const file = join(root, "agents/lyra.md");
    const original = readFileSync(file, "utf8");
    expect(original).toContain("model: claude-sonnet-5");
    const withFakeModel = original.replace("model: claude-sonnet-5", "model: totally-fake-model-xyz");

    const res = await board.fetch(
      req("/registry/check/agents/lyra.md", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: withFakeModel }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; errors: Array<{ code: string; message: string }> };
    expect(body.ok).toBe(false);
    const unknownModel = body.errors.find((e) => e.code === "UNKNOWN_MODEL");
    expect(unknownModel).toBeTruthy();
    expect(unknownModel!.message).toContain("lyra");
    expect(unknownModel!.message).toContain("totally-fake-model-xyz");
    // The buffer was never written — `levare validate` run directly against the repo right now would
    // still say valid, proving this checked the unsaved candidate, not the file on disk.
    expect(readFileSync(file, "utf8")).toBe(original);

    // And the original, unedited content reports ok:true through the identical route/entity.
    const res2 = await board.fetch(
      req("/registry/check/agents/lyra.md", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: original }),
      }),
    );
    const body2 = (await res2.json()) as { ok: boolean };
    expect(body2.ok).toBe(true);
  });

  test("an unknown entity path 404s; a path outside the registry allowlist 400s", async () => {
    const res1 = await board.fetch(
      req("/registry/check/agents/does-not-exist.md", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "anything" }),
      }),
    );
    expect(res1.status).toBe(404);

    const res2 = await board.fetch(
      req("/registry/check/.git/hooks/pre-commit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "anything" }),
      }),
    );
    expect(res2.status).toBe(400);
  });

  // Not a write route (see board-routes.test.ts): a read-only server still answers it, since checking
  // an unsaved buffer never mutates the repo it's pointed at.
  test("answers even against a read-only board", async () => {
    const roRoot = seedScratchRepo();
    const roBoard = createBoard(roRoot, { readOnly: true });
    try {
      const file = join(roRoot, "knowledge/house-style.md");
      const res = await roBoard.fetch(
        req("/registry/check/knowledge/house-style.md", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: readFileSync(file, "utf8") }),
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
    } finally {
      roBoard.close();
      rmSync(roRoot, { recursive: true, force: true });
    }
  });
});

describe("levare serve — POST /orchestrator/message", () => {
  // NOTES C11: with no ANTHROPIC_API_KEY (the case for this whole test suite — see the top-of-file
  // hermetic env), there is no deterministic stand-in boundary to answer in the Orchestrator's voice
  // any more. The route reports the honest disabled state and touches nothing.
  test("with no credential, the route reports a disabled state — never a canned reply — and mutates nothing", async () => {
    const root = seedScratchRepo();
    const board = createBoard(root);
    try {
      const before = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
      const res = await board.fetch(
        req("/orchestrator/message", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "what needs me?" }),
        }),
      );
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.disabled).toBe(true);
      expect(body.reply).toBeUndefined(); // never a fabricated reply
      expect(typeof body.reason).toBe("string");
      expect(body.envVar).toBe("ANTHROPIC_API_KEY");
      const after = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
      expect(after).toBe(before);
    } finally {
      board.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The board is a projection of files; the Orchestrator's SDK voice is an enhancement on top of it
  // (§7), never a dependency the write surface can fail on. NOTES C11: a genuine transport failure
  // AFTER the boundary was selected (credential + binary both resolved, but the live call itself
  // failed) is a real error, surfaced as one — never dressed up as an Orchestrator reply, and never
  // silently downgraded to a deterministic canned voice (that voice no longer exists at all).
  test("a broken SDK boundary surfaces as a real error, never a fabricated reply — and the board still renders", async () => {
    const root = seedScratchRepo();
    // The real createSdkOrchestratorBoundary, driven by a deliberately broken transport (a stand-in
    // for the live-gate finding: "Native CLI binary for darwin-arm64 not found") — exercises the
    // actual OrchestratorSdkError interpret() throws, not a hand-rolled stand-in error type.
    const brokenTransport: AsyncSdkTransport = {
      async run() {
        return { ok: false, error: "Native CLI binary for darwin-arm64 not found" };
      },
    };
    const brokenBoundary = createSdkOrchestratorBoundary({ transport: brokenTransport, env: { ANTHROPIC_API_KEY: "sk-ant-test-not-real" } });
    const board = createBoard(root, { orchestratorBoundary: brokenBoundary });
    try {
      const res = await board.fetch(
        req("/orchestrator/message", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "stats" }),
        }),
      );
      expect(res.status).toBe(502); // a real transport error — never a 500, never a masked 200
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.reply).toBeUndefined(); // never a fabricated reply standing in for the failure
      expect(body.error).toContain("Native CLI binary for darwin-arm64 not found"); // names the reason

      // The board itself must still be fully functional — a broken Orchestrator boundary is not a
      // broken board.
      const studio = await board.fetch(req("/"));
      expect(studio.status).toBe(200);
    } finally {
      board.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("levare serve — SSE re-render trigger", () => {
  test("a repo change under the watched root pushes a reload event to /events", async () => {
    const root = seedScratchRepo();
    const board = createBoard(root);
    try {
      const res = await board.fetch(req("/events"));
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const reader = res.body!.getReader();
      // Drain the initial ": connected" comment.
      await reader.read();

      writeFileSync(join(root, "work/storefront/checkout-flow/unit.md"), readFileSync(join(root, "work/storefront/checkout-flow/unit.md"), "utf8") + "\n");

      const { value } = await Promise.race([
        reader.read(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timed out waiting for SSE reload")), 5000)),
      ]);
      const chunk = new TextDecoder().decode(value);
      expect(chunk).toContain("data: reload");
    } finally {
      board.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 8000);
});

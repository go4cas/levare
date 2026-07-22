import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBoard } from "../src/board/serve.ts";
import { validateArtifactSource, validatePath } from "../src/validate.ts";

// MCP Phase 1b acceptance test (PRD Amendment 3, ruling R5, docs/prd-amendment-3.md §5) — the proof
// that matters: a REAL `kind: remote` member, dispatched through the REAL production wiring
// (`createBoard`'s default `productionAdapterRunner`, no memberRunner override, no mock), calls a REAL
// stdio MCP server's `tools/call`, and the result becomes a REAL artifact that flows through
// `validate.ts` and a REAL gate — exactly the invocation-to-artifact path ruling R5 stages as Phase 1b.
//
// NOTES MCP-1C addendum 6: this test USED to fetch a live, third-party server via `npx -y`/`bunx`
// (Bun.which("npx") ?? Bun.which("bunx")), skipping honestly when neither was on PATH. That live-fetch
// shape is exactly MCP-1C item #4's own root cause — a package-runner spawning a bare package spec
// hangs for 60s under a working sandbox, because the fetched server's real code lands in an npm/npx/bun
// cache the sandbox never grants (see NOTES MCP-1C addendum 6, validate.ts#detectFetchAtDispatchLauncher,
// adapters.ts#createAsyncStdioRemoteBoundary's own dispatch-time refusal). The Conductor's ruling closes
// this by NOT supporting fetch-at-dispatch under the sandbox at all — so this test no longer tries to
// prove that shape works. It proves the SUPPORTED shape instead: a real stdio MCP server, spawned by a
// resolved, PATH-REFERENCED argv (this repo's own `fixtures/stubs/fake-mcp-server.ts`, the same fixture
// tests/adapters.test.ts's own sandboxed-real-spawn suite already proves works live under a working
// sandbox — NOTES MCP-1C addenda 3-5) — deterministic, offline, no live registry fetch, no 60s ceiling.
// The fetch-at-dispatch case gets its own, second test below: proof that it is correctly WARNED at
// validate time rather than silently accepted, turning item #4 from "unsupported hang" into "correctly
// refused, with the supported path proven."

const FAKE_MCP_SERVER = join(import.meta.dir, "..", "fixtures", "stubs", "fake-mcp-server.ts");

const HERMETIC_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" };

function git(root: string, args: string[]): void {
  const r = spawnSync(
    "git",
    ["-C", root, "-c", "user.name=seed", "-c", "user.email=seed@levare.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "init.defaultBranch=main", ...args],
    { encoding: "utf8", env: HERMETIC_ENV },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}${r.stdout}`);
}

// Rewires wren (kestrel's first flow step, produces `product-brief`) from `kind: native` to `kind:
// remote`, calling a real stdio MCP server's own generic tool-call echo — for real. Everything else
// about the golden fixture (the team, the flow, the gate) is untouched. `connectorArgv` lets a caller
// swap in a different (e.g. fetch-at-dispatch) connector shape without duplicating the whole seed.
function seedScratchRepo(connectorArgv: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "levare-mcp-remote-e2e-"));
  cpSync("fixtures/golden", root, { recursive: true });

  writeFileSync(
    join(root, "agents", "wren.md"),
    [
      "---",
      "name: wren",
      "kind: remote",
      "produces: [product-brief]",
      "server: everything",
      "tool: echo",
      "params:",
      '  message: "MCP-1B-LIVE {task}"',
      "connectors: [everything]",
      "style:",
      "  avatar: Wr",
      "---",
      "",
      "You are Wren, dispatched through a real MCP tool call instead of the SDK (NOTES MCP-1B).",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "connectors", "everything.md"),
    [
      "---",
      "name: everything",
      "kind: mcp",
      `argv: ${JSON.stringify(connectorArgv)}`,
      "env: [EVERYTHING_TOKEN]",
      "role: tool",
      "---",
      "",
      "An mcp connector (NOTES MCP-1B/1C).",
      "",
    ].join("\n"),
  );

  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "seed golden fixture, wren rewired to kind: remote"]);
  return root;
}

function req(url: string, init?: RequestInit): Request {
  return new Request(`http://localhost${url}`, init);
}

describe("a real kind: remote member dispatched against a real stdio MCP server (NOTES MCP-1B/1C)", () => {
  test("a real kind: remote member calls a real, PATH-REFERENCED stdio MCP server's tool and produces a real, gated artifact", async () => {
    const root = seedScratchRepo([process.execPath, FAKE_MCP_SERVER, "normal"]);
    try {
      // No memberRunner override: exactly the wiring `levare serve` uses in production
      // (resolveGate's own default, `productionAdapterRunner`), including the real
      // `createAsyncStdioRemoteBoundary` this goal adds.
      const board = createBoard(root);
      const res = await board.fetch(req("/gates/storefront/loyalty-flow/start", { method: "POST" }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);

      const artifactPath = join(root, "work/storefront/loyalty-flow/product-brief-loyalty-flow-v1.md");
      const doc = readFileSync(artifactPath, "utf8");

      // fake-mcp-server.ts's own generic tools/call handler echoes the call's own arguments back as
      // text (`called <tool> with <json args>`) — proof the real MCP call happened, on a real spawned
      // process, with the real, {task}-substituted params.
      expect(doc).toContain('called echo with {"message":"MCP-1B-LIVE');
      expect(doc).toContain("kestrel/wren");

      // levare authored the artifact wrapper itself, exactly like every other producer's artifact.
      expect(doc).toContain("kind: product-brief");
      expect(doc).toContain("id: product-brief-loyalty-flow-v1");
      expect(doc).toContain("unit: loyalty-flow");
      expect(doc).toContain("project: storefront");
      expect(doc).toContain("produced_by: kestrel/wren");
      expect(doc).toContain("status: in-review");
      expect(doc).toContain("consumes: []");
      expect(doc).toContain("supersedes: null");
      expect(doc).toContain("approved_by: null");

      // Flows through validate.ts, structurally, unchanged from every other producer's artifact.
      expect(validateArtifactSource(doc)).toEqual([]);

      // Flows through a real gate: approve it via the exact same board route a Conductor would use.
      const approveRes = await board.fetch(req("/gates/storefront/product-brief-loyalty-flow-v1/approve", { method: "POST" }));
      board.close();
      expect(approveRes.status).toBe(200);
      const approveBody = (await approveRes.json()) as { ok: boolean };
      expect(approveBody.ok).toBe(true);
      const approvedDoc = readFileSync(artifactPath, "utf8");
      expect(approvedDoc).toContain("status: approved");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// NOTES MCP-1C addendum 6: the negative half of item #4's closure — a fetch-at-dispatch connector
// (npx -y over a bare package spec, this repo's own original hanging shape) must be correctly WARNED at
// validate time, never silently accepted as equivalent to the supported, path-referenced shape proven
// above. Pure validatePath() call, no live process spawned — deterministic, no network, no timeout risk.
describe("a fetch-at-dispatch connector is correctly warned, never silently accepted (NOTES MCP-1C addendum 6)", () => {
  test("wren's connector rewired to npx -y a bare package spec validates ok but carries MCP_FETCH_AT_DISPATCH", () => {
    const root = seedScratchRepo(["npx", "-y", "@modelcontextprotocol/server-everything", "stdio"]);
    try {
      const r = validatePath(root);
      expect(r.ok).toBe(true); // legal declaration — REV1's own "tell plainly, never reject" posture.
      expect(r.warnings.map((w) => w.code)).toContain("MCP_FETCH_AT_DISPATCH");
      const w = r.warnings.find((w) => w.code === "MCP_FETCH_AT_DISPATCH")!;
      expect(w.message).toContain("everything");
      expect(w.message).toContain("npx");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

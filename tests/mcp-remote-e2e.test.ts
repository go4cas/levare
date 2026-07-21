import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBoard } from "../src/board/serve.ts";
import { validateArtifactSource } from "../src/validate.ts";
import { connectStdioMcpServer } from "../src/mcp-client.ts";

// MCP Phase 1b acceptance test (PRD Amendment 3, ruling R5, docs/prd-amendment-3.md §5) — the proof
// that matters: a REAL `kind: remote` member, dispatched through the REAL production wiring
// (`createBoard`'s default `productionAdapterRunner`, no memberRunner override, no mock), calls a REAL
// stdio MCP server's `tools/call`, and the result becomes a REAL artifact that flows through
// `validate.ts` and a REAL gate — exactly the invocation-to-artifact path ruling R5 stages as Phase 1b.
// Mirrors tests/mcp-handshake.test.ts's own gating discipline (FIX-5's "weak canary" lesson: a mocked
// invocation proves nothing) — resolved ONCE at module load by actually attempting the live handshake,
// so a run without `npx`/`bunx` or without registry access skips HONESTLY, by name, never silently.

const LIVE_TIMEOUT_MS = 60_000;

interface LiveAttempt {
  ok: boolean;
  reason: string;
  runner?: string;
}

async function tryLiveMcp(): Promise<LiveAttempt> {
  const runner = Bun.which("npx") ?? Bun.which("bunx");
  if (!runner) return { ok: false, reason: "neither npx nor bunx found on PATH" };
  try {
    const session = await connectStdioMcpServer({ argv: [runner, "-y", "@modelcontextprotocol/server-everything", "stdio"] }, { timeoutMs: LIVE_TIMEOUT_MS });
    await session.close();
    return { ok: true, reason: "", runner };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

const live = await tryLiveMcp();

const testName = live.ok
  ? "live: a real kind: remote member calls a real stdio MCP server's tool and produces a real, gated artifact"
  : `live MCP remote dispatch SKIPPED (${live.reason}) — real kind: remote member -> real artifact -> validate + gate`;

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
// remote`, calling `@modelcontextprotocol/server-everything`'s own `echo` tool for real — the MCP
// project's reference/demo server, the same one tests/mcp-handshake.test.ts proves a real handshake
// against. Everything else about the golden fixture (the team, the flow, the gate) is untouched.
function seedScratchRepo(runner: string): string {
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
      `argv: ["${runner}", "-y", "@modelcontextprotocol/server-everything", "stdio"]`,
      "env: [EVERYTHING_TOKEN]",
      "role: tool",
      "---",
      "",
      "The MCP project's own reference/demo server (unauthenticated — env declared for schema shape only).",
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

describe("a real kind: remote member dispatched against a real stdio MCP server (NOTES MCP-1B)", () => {
  test.skipIf(!live.ok)(
    testName,
    async () => {
      if (!live.ok || !live.runner) throw new Error("unreachable: gated on live.ok");
      const root = seedScratchRepo(live.runner);
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

        // A real tools/call round trip: the everything server's own "echo" tool round-trips the
        // {task}-substituted message verbatim ("Echo: MCP-1B-LIVE <the real §6 context>") — proof the
        // real MCP call actually happened, on the real server, with the real assembled context.
        expect(doc).toContain("Echo: MCP-1B-LIVE");
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
    },
    LIVE_TIMEOUT_MS,
  );
});

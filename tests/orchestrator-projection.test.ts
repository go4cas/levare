// Ruling C10: the Orchestrator gets no filesystem tools — instead every `converse()` call is
// grounded in a deterministic projection of the STUDIO IT WAS SERVING, assembled by levare
// (orchestrator-projection.ts#buildStudioProjection), never fetched by the model. This file covers
// the acceptance criteria the ruling names directly:
//   - the projection contains the served studio's teams, work units, open gates, and ideas
//   - it contains nothing from any other directory (the live bug: the Orchestrator answered about
//     levare's OWN source tree and a fixture idea that isn't even in the studio it was serving)
//   - an end-to-end run of the real board route names the served studio's own idea, never another
//     studio's — see `tests/orchestrator-sdk.test.ts` for the zero-tools/root-required-throws cases.

import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, cpSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRepo } from "../src/repo.ts";
import { buildStudioProjection } from "../src/orchestrator-projection.ts";
import { createBoard } from "../src/board/serve.ts";
import { createSdkOrchestratorBoundary } from "../src/orchestrator-boundary.ts";
import type { AsyncSdkTransport, SdkWorkerRequest } from "../src/sdk-transport.ts";

const HERMETIC_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
function git(repoRoot: string, args: string[]): void {
  const r = spawnSync("git", ["-C", repoRoot, "-c", "user.name=seed", "-c", "user.email=seed@levare.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "init.defaultBranch=main", ...args], {
    encoding: "utf8",
    env: HERMETIC_ENV,
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}${r.stdout}`);
}
function seedScratchRepo(prefix = "levare-proj-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  cpSync("fixtures/golden", root, { recursive: true });
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "seed golden fixture"]);
  return root;
}
function req(url: string, init?: RequestInit): Request {
  return new Request(`http://localhost${url}`, init);
}

describe("buildStudioProjection — contains the served studio, nothing from anywhere else", () => {
  test("the golden fixture's own teams, work units, open gates, and ideas are all present", () => {
    const root = seedScratchRepo();
    try {
      const projection = buildStudioProjection(loadRepo(root));
      // registry
      expect(projection).toContain("kestrel");
      expect(projection).toContain("lyra");
      // work units + lineage
      expect(projection).toContain("storefront/checkout-flow");
      expect(projection).toContain("product-brief-v1");
      // open gates (the fixture's own open spec gate)
      expect(projection).toContain("spec-checkout-flow-v1");
      // ideas
      expect(projection).toContain("loyalty-program");
      expect(projection).toContain("Reward repeat storefront buyers");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("never contains levare's own source tree — the exact live bug this ruling closes", () => {
    const root = seedScratchRepo();
    try {
      const projection = buildStudioProjection(loadRepo(root));
      // The live bug: the Orchestrator reported reading levare's own src/, tests/. Neither is a
      // registry/work-unit/idea concept, so a correct projection can never mention them.
      expect(projection).not.toContain("src/orchestrator");
      expect(projection).not.toContain("tests/orchestrator");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("two independently-seeded studios never leak each other's ideas", () => {
    const a = seedScratchRepo("levare-proj-a-");
    const b = mkdtempSync(join(tmpdir(), "levare-proj-b-"));
    try {
      cpSync("fixtures/golden", b, { recursive: true });
      rmSync(join(b, "ideas", "loyalty-program.md"));
      writeFileSync(join(b, "ideas", "zero-gravity-yoga.md"), ["---", "name: zero-gravity-yoga", 'pitch: "A pitch that exists ONLY in studio b."', "---", "", "# Zero-gravity yoga", ""].join("\n"));
      git(b, ["init", "-q"]);
      git(b, ["add", "-A"]);
      git(b, ["commit", "-q", "-m", "seed studio b"]);

      const projA = buildStudioProjection(loadRepo(a));
      const projB = buildStudioProjection(loadRepo(b));
      expect(projA).toContain("loyalty-program");
      expect(projA).not.toContain("zero-gravity-yoga");
      expect(projB).toContain("zero-gravity-yoga");
      expect(projB).not.toContain("loyalty-program");
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });
});

// The end-to-end acceptance case: boot the real board (createBoard, the same router `levare serve`
// mounts — see the project's own established preference for driving `board.fetch` in-process over a
// real socket, tests/board-serve.test.ts) against a scratch studio in a temp dir, POST a free-form
// message to the real `/orchestrator/message` route, and assert the reply names ONLY that studio's
// idea. The real `createSdkOrchestratorBoundary` is used (so the real `buildStudioProjection` runs);
// only the SDK TRANSPORT is faked — this repo has no live ANTHROPIC_API_KEY (NOTES/security-audit
// Surface 1's K12 live-gate deferral), so the fake stands in for "a model that answers from exactly
// the context it was given," which is precisely the property under test.
describe("end-to-end: levare serve against a scratch studio names ITS idea, never the fixture's", () => {
  test("POST /orchestrator/message answers from the served studio's own projection only", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "levare-proj-e2e-"));
    try {
      cpSync("fixtures/golden", scratch, { recursive: true });
      rmSync(join(scratch, "ideas", "loyalty-program.md"));
      writeFileSync(
        join(scratch, "ideas", "midnight-snack-tracker.md"),
        ["---", "name: midnight-snack-tracker", 'pitch: "Log 2am fridge raids and gently judge them."', "---", "", "# Midnight snack tracker", ""].join("\n"),
      );
      git(scratch, ["init", "-q"]);
      git(scratch, ["add", "-A"]);
      git(scratch, ["commit", "-q", "-m", "seed scratch studio"]);

      // A transport that answers purely by reading the studio projection it was handed — never a
      // canned string — so the final HTTP reply is real evidence of what the projection contained.
      const transport: AsyncSdkTransport = {
        async run(request: SdkWorkerRequest) {
          if (request.outputFormat) return { ok: true, result: "{}", structuredOutput: { kind: "unknown" } };
          const ideasBlock = request.prompt.split("── ideas ──")[1]?.split("──")[0]?.trim() ?? "(no ideas section found)";
          return { ok: true, result: `Ideas on file: ${ideasBlock}` };
        },
      };
      const boundary = createSdkOrchestratorBoundary({ transport, env: { ANTHROPIC_API_KEY: "sk-ant-test-not-real" } });
      const board = createBoard(scratch, { orchestratorBoundary: boundary });
      try {
        const res = await board.fetch(
          req("/orchestrator/message", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "what ideas do we have?" }) }),
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.ok).toBe(true);
        expect(body.reply).toContain("midnight-snack-tracker");
        expect(body.reply).not.toContain("loyalty-program");
      } finally {
        board.close();
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

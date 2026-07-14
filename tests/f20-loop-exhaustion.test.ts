import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, cpSync, existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.ts";
import { resolveGate } from "../src/board/gateops.ts";
import { stubAdapterRunner } from "../src/replay.ts";
import { loadRepo } from "../src/repo.ts";
import { openGates } from "../src/board/derive.ts";
import { renderStudio } from "../src/board/render.ts";
import type { Verb } from "../src/runner.ts";

// NOTES F20: at max_rounds, the server correctly refuses a further `request` (409, no spend, no extra
// round — ruling C14/F16) but the board's gate card was unaware entirely: it still offered "Request
// changes", opened the note composer, took the Conductor's text, and silently discarded it on the
// refused round-trip. The card now states the round count up front, drops "Request changes" (it can
// never succeed), and presents the loop's actual on_exhaust decision: approve anyway, reject, or
// re-scope (a new verb that rejects the artifact AND pauses the unit for deliberate re-planning).

const HERMETIC_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" };

function git(root: string, args: string[]) {
  const r = spawnSync(
    "git",
    ["-C", root, "-c", "user.name=seed", "-c", "user.email=seed@levare.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "init.defaultBranch=main", ...args],
    { encoding: "utf8", env: HERMETIC_ENV },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}${r.stdout}`);
  return r;
}

function seedGoldenScratch(): string {
  const root = mkdtempSync(join(tmpdir(), "levare-f20-"));
  cpSync("fixtures/golden", root, { recursive: true });
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "seed golden fixture"]);
  return root;
}

/** Drives loyalty-flow's kestrel loop (spec/review, until: spec.approved, max_rounds: 3) to its
 * final, exhausted round — mirroring tests/loop-c14.test.ts's own non-converging-loop scenario. */
async function driveToExhaustion(root: string): Promise<Daemon> {
  const runner = stubAdapterRunner(loadRepo(root));
  const daemon = new Daemon(root, { memberRunner: () => runner });

  await resolveGate(root, "storefront", "loyalty-flow", "start", { memberRunner: runner, today: "2026-07-12" });
  await resolveGate(root, "storefront", "product-brief-loyalty-flow-v1", "approve" as Verb, { today: "2026-07-12" });
  await daemon.tick(); // design
  await resolveGate(root, "storefront", "design-loyalty-flow-v1", "approve" as Verb, { today: "2026-07-12" });
  await daemon.tick(); // spec round 1
  await daemon.tick(); // review round 1
  await resolveGate(root, "storefront", "spec-loyalty-flow-v1", "request" as Verb, { memberRunner: runner, note: "round 1", today: "2026-07-12" });
  await daemon.tick(); // review round 2
  await resolveGate(root, "storefront", "spec-loyalty-flow-v2", "request" as Verb, { memberRunner: runner, note: "round 2", today: "2026-07-12" });
  await daemon.tick(); // review round 3 — the loop's max_rounds (kestrel.md)
  return daemon;
}

describe("F20: an exhausted loop's card states the round count and disables request-changes", () => {
  test("openGates annotates the round-3-of-3 gate as exhausted", async () => {
    const root = seedGoldenScratch();
    try {
      await driveToExhaustion(root);
      const repo = loadRepo(root, { validate: false });
      const gate = openGates(repo).find((g) => g.target === "spec-loyalty-flow-v3");
      expect(gate).toBeDefined();
      expect(gate!.loop).toEqual({ round: 3, maxRounds: 3, until: "spec.approved", exhausted: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the rendered card states the round count, has no Request-changes verb, and offers approve/reject/re-scope", async () => {
    const root = seedGoldenScratch();
    try {
      await driveToExhaustion(root);
      const repo = loadRepo(root, { validate: false });
      const html = renderStudio(repo, root, new Date("2026-07-12T00:00:00Z"), []);
      expect(html).toContain("gate--exhausted"); // unique to this one card in this scenario
      const cardStart = html.indexOf('data-gate-target="spec-loyalty-flow-v3"');
      expect(cardStart).toBeGreaterThan(-1);
      const cardEnd = html.indexOf("</article>", cardStart);
      const card = html.slice(cardStart, cardEnd);

      expect(card).toContain("3 of 3 rounds used");
      expect(card).not.toContain('data-verb="request"'); // disabled: it can never succeed now
      expect(card).toContain('data-verb="approve"');
      expect(card).toContain('data-verb="reject"');
      expect(card).toContain('data-verb="rescope"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a non-exhausted loop round's card still offers Request changes, with a round indicator", async () => {
    const root = seedGoldenScratch();
    try {
      const runner = stubAdapterRunner(loadRepo(root));
      const daemon = new Daemon(root, { memberRunner: () => runner });
      await resolveGate(root, "storefront", "loyalty-flow", "start", { memberRunner: runner, today: "2026-07-12" });
      await resolveGate(root, "storefront", "product-brief-loyalty-flow-v1", "approve" as Verb, { today: "2026-07-12" });
      await daemon.tick(); // design
      await resolveGate(root, "storefront", "design-loyalty-flow-v1", "approve" as Verb, { today: "2026-07-12" });
      await daemon.tick(); // spec round 1
      await daemon.tick(); // review round 1

      const repo = loadRepo(root, { validate: false });
      const gate = openGates(repo).find((g) => g.target === "spec-loyalty-flow-v1");
      expect(gate!.loop).toEqual({ round: 1, maxRounds: 3, until: "spec.approved", exhausted: false });

      const html = renderStudio(repo, root, new Date("2026-07-12T00:00:00Z"), []);
      const cardStart = html.indexOf('data-gate-target="spec-loyalty-flow-v1"');
      const card = html.slice(cardStart, html.indexOf("</article>", cardStart));
      expect(card).toContain("round 1/3");
      expect(card).toContain('data-verb="request"');
      expect(card).not.toContain("gate--exhausted");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("re-scope rejects the exhausted artifact AND pauses the unit, in one commit", async () => {
    const root = seedGoldenScratch();
    try {
      await driveToExhaustion(root);
      const result = await resolveGate(root, "storefront", "spec-loyalty-flow-v3", "rescope" as Verb, { note: "cannot converge; re-planning", today: "2026-07-12" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const unitDir = join(root, "work/storefront/loyalty-flow");
      const spec = readFileSync(join(unitDir, "spec-loyalty-flow-v3.md"), "utf8");
      expect(spec).toContain("status: rejected");
      const unitMd = readFileSync(join(unitDir, "unit.md"), "utf8");
      expect(unitMd).toContain("status: paused");
      expect(result.changedFiles.length).toBe(2);

      const repo = loadRepo(root, { validate: false });
      expect(repo.units.find((u) => u.unit === "loyalty-flow")!.status).toBe("paused");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("request-changes at the final round is STILL refused server-side (409, no new round) — the card's disabling matches reality, not just cosmetics", async () => {
    const root = seedGoldenScratch();
    try {
      const runner = stubAdapterRunner(loadRepo(root));
      await driveToExhaustion(root);
      const req = await resolveGate(root, "storefront", "spec-loyalty-flow-v3", "request" as Verb, { memberRunner: runner, note: "one more try", today: "2026-07-12" });
      expect(req.ok).toBe(false);
      if (req.ok) return;
      expect(req.status).toBe(409);
      expect(existsSync(join(root, "work/storefront/loyalty-flow", "spec-loyalty-flow-v4.md"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

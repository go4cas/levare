import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, cpSync, writeFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRepo, repoCapabilities } from "../src/repo.ts";
import { loadPricing } from "../src/pricing.ts";
import { AdapterRunner, type InvokeRequest, type NativeBoundary, type RemoteBoundary } from "../src/adapters.ts";
import { advanceUnit, nextAction } from "../src/dagwalk.ts";
import { responsibleTeamFor } from "../src/gates.ts";
import { openGates } from "../src/board/derive.ts";
import { renderStudio } from "../src/board/render.ts";
import { Daemon } from "../src/daemon.ts";
import { render } from "../fixtures/stubs/member-stub.ts";
import { stubAdapterRunner } from "../src/replay.ts";
import type { MemberRunner } from "../src/runner.ts";

// NOTES F1 — the dogfood defect. A real studio (two teams, four agents, a research unit) validated
// clean and could not run a single step: agent definitions had no field to declare what they produce,
// so the only capability map in the codebase was `CAPABILITIES` in fixtures/stubs, injected into
// AdapterRunner at construction. A real studio's map came out EMPTY, `resolveStep` threw "no member
// of team X can produce a kind for flow step Y", the daemon converted that to a `halt` in a ring
// buffer, and the unit sat silent forever. These tests pin the three halves of the fix: capabilities
// come from the agent definitions ON DISK; an unbindable step BLOCKS the unit loudly; and the block
// is visible — on disk and on the board — rather than being a no-op no one is told about.

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

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "levare-binding-"));
  cpSync("fixtures/golden", root, { recursive: true });
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "seed golden fixture"]);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const nativeMock: NativeBoundary = { invoke: (r: InvokeRequest) => ({ doc: render(r.member, r.kind, r.unit, r.project) }) };
const remoteMock: RemoteBoundary = { call: (r: InvokeRequest) => ({ doc: render(r.member, r.kind, r.unit, r.project) }) };

// ---------------------------------------------------------------------------
// (1) Capabilities are DERIVED FROM THE REPO — the agent definitions on disk — not injected.
// ---------------------------------------------------------------------------

describe("capabilities are derived from the agent definitions on disk", () => {
  test("repoCapabilities reads every agent's declared `produces`", () => {
    const repo = loadRepo(root);
    expect(repoCapabilities(repo)).toEqual([
      { member: "finch", kind: "review" },
      { member: "lyra", kind: "design" },
      { member: "lyra", kind: "spec" },
      { member: "wren", kind: "product-brief" },
    ]);
  });

  test("an AdapterRunner constructed with NO capabilities option still binds every flow step", () => {
    const repo = loadRepo(root);
    // No `capabilities:` — the pre-F1 seam. Before the fix this produced an empty map and every step
    // failed to resolve; now the map comes from the repo itself.
    const runner = new AdapterRunner(repo, { pricing: loadPricing(root), native: nativeMock, remote: remoteMock });
    expect(runner.capabilities()).toEqual(repoCapabilities(repo));

    const unit = repo.units.find((u) => u.unit === "loyalty-flow")!;
    const team = responsibleTeamFor(repo, unit)!;
    const action = nextAction(repo, unit, team, runner.capabilities());
    expect(action).toEqual({ type: "produce", member: "wren", kind: "product-brief", stepLabel: "brief" });
  });

  test("editing an agent's `produces` on disk changes the capability map — the file is the truth", () => {
    const file = join(root, "agents", "wren.md");
    writeFileSync(file, readFileSync(file, "utf8").replace("produces: [product-brief]", "produces: [pitch]"));
    const repo = loadRepo(root, { validate: false }); // the studio is now unbindable; that's the point
    const caps = repoCapabilities(repo);
    expect(caps).toContainEqual({ member: "wren", kind: "pitch" });
    expect(caps).not.toContainEqual({ member: "wren", kind: "product-brief" });

    // And a runner built over that repo reports exactly what the file now says.
    const runner = new AdapterRunner(repo, { pricing: loadPricing(root), native: nativeMock, remote: remoteMock });
    expect(runner.capabilities()).toEqual(caps);
  });
});

// ---------------------------------------------------------------------------
// (2) An unbindable step at runtime BLOCKS the unit loudly — never a silent no-op.
// ---------------------------------------------------------------------------

// Break the binding the way a real studio does: wren stops declaring `product-brief`, so kestrel's
// first flow step (`brief`) resolves to no member. Everything else about the studio is untouched.
function breakBriefBinding(): void {
  const file = join(root, "agents", "wren.md");
  writeFileSync(file, readFileSync(file, "utf8").replace("produces: [product-brief]", "produces: [pitch]"));
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "break wren's brief capability"]);
}

describe("an unbindable flow step blocks the unit, with the reason visible", () => {
  test("advanceUnit blocks the unit on disk with the resolution error as its reason", () => {
    breakBriefBinding();
    const repo = loadRepo(root, { validate: false });
    const unit = repo.units.find((u) => u.unit === "loyalty-flow")!;
    const runner = stubAdapterRunner(repo);

    const result = advanceUnit(root, repo, unit, runner, { startAuthorized: true });
    expect(result.outcome).toBe("unbindable");
    if (result.outcome !== "unbindable") throw new Error("unreachable");
    expect(result.reason).toContain("no member of team 'kestrel' can produce a kind for flow step 'brief'");
    expect(result.stepLabel).toBe("brief");

    // The block is on disk (files are the truth), committed, and explains itself.
    const unitMd = readFileSync(join(root, "work/storefront/loyalty-flow/unit.md"), "utf8");
    expect(unitMd).toContain("status: blocked");
    expect(unitMd).toContain("blocked_reason:");
    expect(unitMd).toContain("flow step 'brief'");
    expect(git(root, ["log", "-1", "--pretty=%s"]).stdout).toContain("block loyalty-flow");

    // ...and no artifact was produced: nothing ran, because nothing could be bound.
    const after = loadRepo(root, { validate: false });
    expect(after.artifacts.get("storefront/loyalty-flow")?.size ?? 0).toBe(0);
  });

  test("the blocked unit surfaces as a gate on the board, carrying the reason", () => {
    breakBriefBinding();
    const repo = loadRepo(root, { validate: false });
    const unit = repo.units.find((u) => u.unit === "loyalty-flow")!;
    advanceUnit(root, repo, unit, stubAdapterRunner(repo), { startAuthorized: true });

    const after = loadRepo(root, { validate: false });
    const gate = openGates(after).find((g) => g.type === "blocked" && g.unit === "loyalty-flow");
    expect(gate).toBeDefined();
    expect(gate!.reason).toContain("flow step 'brief'");

    // The board renders it — the Conductor sees the block and why, not an empty inbox.
    const html = renderStudio(after, root, new Date("2026-07-12T00:00:00Z"), []);
    expect(html).toContain("gate--blocked");
    expect(html).toContain("Blocked:");
    expect(html).toContain("flow step 'brief'"); // the reason itself, on the card
  });

  test("the daemon BLOCKS a unit whose step cannot bind at runtime — the pre-F1 silent halt is gone", () => {
    // The runtime path, on a studio that VALIDATES: the member boundary reports no capability for the
    // step (an adapter that cannot reach the member, a stub, a capability map narrowed at the
    // boundary). Validation cannot pre-empt this one — it is exactly where the pre-F1 code caught the
    // RunnerError, downgraded it to a `halt`, and left the unit sitting silent forever.
    const unitDir = join(root, "work/storefront/loyalty-flow");
    seedStartedUnit(unitDir);

    const blindRunner: MemberRunner = {
      capabilities: () => [],
      produce: () => {
        throw new Error("must never be called: nothing could be bound");
      },
    };
    const daemon = new Daemon(root, { memberRunner: () => blindRunner });
    const entry = daemon.tick().entries.find((e) => e.unit === "loyalty-flow")!;
    expect(entry.outcome.outcome).toBe("unbindable");
    if (entry.outcome.outcome !== "unbindable") throw new Error("unreachable");
    expect(entry.outcome.reason).toContain("no member of team 'kestrel' can produce a kind for flow step 'brief'");

    // The reason is on disk, on the unit it blocked.
    const unitMd = readFileSync(join(unitDir, "unit.md"), "utf8");
    expect(unitMd).toContain("status: blocked");
    expect(unitMd).toContain("no member of team 'kestrel' can produce a kind for flow step 'brief'");

    // And the next tick does not re-fail in a loop: the unit is blocked, so the walk skips it.
    const next = daemon.tick().entries.find((e) => e.unit === "loyalty-flow");
    expect(next?.outcome.outcome).toBe("nothing");
  });

  test("a studio that cannot bind never loads at all: the daemon refuses the tick and says why", () => {
    // Belt and braces on top of the runtime block: since F1 an unbindable studio fails validation, so
    // the daemon's own `loadRepo` rejects it before any unit is walked — and records why, rather than
    // ticking over an unrunnable repo forever.
    breakBriefBinding();
    const daemon = new Daemon(root, { memberRunner: (r) => stubAdapterRunner(r) });
    expect(daemon.tick().entries).toEqual([]);
    const last = daemon.recentActivity().at(-1)!;
    expect(last.outcome.outcome).toBe("halted");
    if (last.outcome.outcome !== "halted") throw new Error("unreachable");
    expect(last.outcome.reason).toContain("does not validate");
    expect(last.outcome.reason).toContain("UNBINDABLE_STEP");
  });
});

/** Give a unit a prior approved artifact, so it is past its start gate and the daemon walks it. */
function seedStartedUnit(unitDir: string): void {
  writeFileSync(
    join(unitDir, "seed-note-v1.md"),
    [
      "---",
      "kind: note",
      "id: seed-note-v1",
      "unit: loyalty-flow",
      "project: storefront",
      "status: approved",
      "produced_by: kestrel/wren",
      "consumes: []",
      "supersedes: null",
      'approved_by: "cas 2026-07-11"',
      "created: 2026-07-11",
      "files: []",
      "---",
      "",
      "A prior approved artifact, so the unit is past its start gate.",
      "",
    ].join("\n"),
  );
  git(unitDir.split("/work/")[0], ["add", "-A"]);
  git(unitDir.split("/work/")[0], ["commit", "-q", "-m", "seed a started unit"]);
}

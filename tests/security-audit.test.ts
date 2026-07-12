// Security audit — demonstrating tests (docs/security-audit.md). A finding here is a failing test,
// not an opinion (per docs/security-audit-brief.md). Tests that demonstrate a CLOSED vulnerability
// pass green (the fix holds); tests that demonstrate a DEFERRED vulnerability requiring a Conductor
// ruling are `test.failing` — they assert the DESIRED (secure) behavior, which currently throws, so
// bun records them as an expected failure (xfail) and the suite stays green. If a future change
// closes the gap, the `test.failing` flips to a real failure, flagging that the deferral is stale.
//
// Every test name below is prefixed with its surface number and severity for the report's audit trail.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, cpSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBoard, isCrossOriginWrite, isRegistryEditablePath } from "../src/board/serve.ts";
import { Daemon } from "../src/daemon.ts";
import { stubAdapterRunner } from "../src/replay.ts";
import { validatePath } from "../src/validate.ts";

const HERMETIC_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" };

function git(root: string, args: string[]): ReturnType<typeof spawnSync> {
  const r = spawnSync(
    "git",
    ["-C", root, "-c", "user.name=seed", "-c", "user.email=seed@levare.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "init.defaultBranch=main", ...args],
    { encoding: "utf8", env: HERMETIC_ENV },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}${r.stdout}`);
  return r;
}

function seedScratchRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "levare-audit-"));
  cpSync("fixtures/golden", root, { recursive: true });
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "seed golden fixture"]);
  return root;
}

const SPEC_REL = "work/storefront/checkout-flow/spec-checkout-flow-v1.md";

// ---------------------------------------------------------------------------
// Surface 6 — the write surface: CSRF (CRITICAL, fixed). Any web page open in the operator's browser
// can POST to the unauthenticated localhost board. A CORS "simple request" (text/plain body, no
// preflight) reaches the handler, and Bun's req.json() parses the body regardless of content-type —
// so with no origin check a cross-site page could forge a Conductor approval (invariant 4), start a
// member (invariant 1, real money), or write a registry file. The fix refuses a cross-origin write
// structurally, ahead of every handler.
// ---------------------------------------------------------------------------

describe("[surface 6 · CRITICAL · FIXED] CSRF on the three write routes", () => {
  let root: string;
  let board: ReturnType<typeof createBoard>;
  beforeEach(() => {
    root = seedScratchRepo();
    board = createBoard(root); // a real writable board (not under fixtures/)
  });
  afterEach(() => {
    board.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("a cross-origin POST from a malicious page cannot approve a gate (no forged Conductor approval)", async () => {
    const before = readFileSync(join(root, SPEC_REL), "utf8");
    expect(before).toContain("status: in-review");
    // The exact shape a malicious page uses: a text/plain "simple request" (no CORS preflight),
    // carrying a JSON string body the handler's req.json() would happily parse.
    const res = await board.fetch(
      new Request("http://localhost/gates/storefront/spec-checkout-flow-v1/approve", {
        method: "POST",
        headers: { "content-type": "text/plain;charset=UTF-8", origin: "https://evil.example.com" },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(403);
    // The file on disk is untouched — no forged approval, no forged approved_by, no commit.
    const after = readFileSync(join(root, SPEC_REL), "utf8");
    expect(after).toBe(before);
    expect(after).not.toContain("approved_by: \"cas");
  });

  test("a cross-origin POST cannot start a unit (invariant 1: no member invoked by a foreign page)", async () => {
    const res = await board.fetch(
      new Request("http://localhost/gates/storefront/loyalty-flow/start", {
        method: "POST",
        headers: { "content-type": "text/plain", origin: "https://evil.example.com" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(403);
  });

  test("a same-origin POST from the board's own page still works (the fix does not break the real UI)", async () => {
    const res = await board.fetch(
      new Request("http://localhost/gates/storefront/spec-checkout-flow-v1/approve", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(200);
    expect(readFileSync(join(root, SPEC_REL), "utf8")).toContain("status: approved");
  });

  test("a no-Origin client (curl / the CLI / tests) is not treated as CSRF and reaches the handler", async () => {
    const res = await board.fetch(
      new Request("http://localhost/gates/storefront/spec-checkout-flow-v1/approve", { method: "POST", body: "{}" }),
    );
    expect(res.status).not.toBe(403); // reaches the real handler (200 here)
  });

  test("isCrossOriginWrite: unit truth table", () => {
    const url = new URL("http://localhost:4173/gates/x/y/approve");
    const mk = (h: Record<string, string>) => new Request(url, { method: "POST", headers: h });
    expect(isCrossOriginWrite(mk({}), url)).toBe(false); // no origin → allowed (not a browser CSRF)
    expect(isCrossOriginWrite(mk({ origin: "http://localhost:4173" }), url)).toBe(false); // same origin
    expect(isCrossOriginWrite(mk({ origin: "https://evil.example.com" }), url)).toBe(true); // cross site
    expect(isCrossOriginWrite(mk({ origin: "http://localhost:5000" }), url)).toBe(true); // same host, other port
    expect(isCrossOriginWrite(mk({ "sec-fetch-site": "cross-site" }), url)).toBe(true); // header-only signal
  });
});

// ---------------------------------------------------------------------------
// Surface 4 + 6 — path scope: the registry edit route wrote to any in-root path (CRITICAL, fixed).
// `POST /registry/*path` joined the remainder onto root with only a textual `..` scan; `.git/hooks/
// pre-commit` (no `..`) slipped straight through, planting an executable git hook (code execution the
// next time the operator runs git) — and, because the file is written to disk BEFORE the validate/
// commit step, it persisted even when the subsequent commit failed. The fix confines writes to real
// registry entity directories by resolved-path containment plus a top-level-segment allowlist.
// ---------------------------------------------------------------------------

describe("[surface 4/6 · CRITICAL · FIXED] registry edit route escaping the registry namespace", () => {
  let root: string;
  let board: ReturnType<typeof createBoard>;
  beforeEach(() => {
    root = seedScratchRepo();
    board = createBoard(root);
  });
  afterEach(() => {
    board.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("cannot plant a .git/hooks/pre-commit via the registry route, and nothing is written to disk", async () => {
    const hook = join(root, ".git/hooks/pre-commit");
    const res = await board.fetch(
      new Request("http://localhost/registry/.git/hooks/pre-commit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "#!/bin/sh\ntouch /tmp/levare-pwned\n" }),
      }),
    );
    expect(res.status).toBe(400);
    expect(existsSync(hook)).toBe(false); // not merely un-committed — never written at all
  });

  test("cannot write outside the registry entity dirs (e.g. src/ or a bare top-level file)", async () => {
    for (const p of ["src/evil.ts", "evil.md", "work/storefront/checkout-flow/unit.md"]) {
      const res = await board.fetch(
        new Request(`http://localhost/registry/${p}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: "x" }),
        }),
      );
      expect(res.status).toBe(400);
    }
  });

  test("a legitimate registry entity edit still works (the fix does not break real use)", async () => {
    const src = readFileSync(join(root, "knowledge/house-style.md"), "utf8");
    const res = await board.fetch(
      new Request("http://localhost/registry/knowledge/house-style.md", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: src + "\n<!-- audited edit -->\n" }),
      }),
    );
    expect(res.status).toBe(200);
  });

  test("isRegistryEditablePath: unit truth table", () => {
    const r = "/studio";
    expect(isRegistryEditablePath(r, "teams/kestrel.md")).toBe(true);
    expect(isRegistryEditablePath(r, "knowledge/house-style.md")).toBe(true);
    expect(isRegistryEditablePath(r, ".git/hooks/pre-commit")).toBe(false);
    expect(isRegistryEditablePath(r, "../../etc/passwd")).toBe(false);
    expect(isRegistryEditablePath(r, "src/cli.ts")).toBe(false);
    expect(isRegistryEditablePath(r, "work/x/y/unit.md")).toBe(false);
    expect(isRegistryEditablePath(r, "teams/../.git/x.md")).toBe(false);
    expect(isRegistryEditablePath(r, "teams/kestrel.txt")).toBe(false); // definitions are .md
  });
});

// ---------------------------------------------------------------------------
// Surface 5 + 1 — the daemon's blast radius / invariant 1 (HIGH, FIXED — ruling C8). Was: the daemon
// auto-advanced any `active` unit that had no `after:` and no artifacts yet — invoking its first
// member (real money, the real SDK) with NO gate and NO click. The only thing standing between "a
// unit.md appears on disk" and "a member runs unattended" was that the file was `active` and lacked
// `after:`. Any non-Conductor write into work/ (a member escaping its unit dir, a prompt-injected
// Orchestrator, a merged PR, a vendored skill's file write) could therefore autostart a member.
// NOTES O3 recorded this as "the single most debatable call in this phase" and deliberately took the
// loose reading; ruling C8 (NOTES.md) supersedes it: EVERY unit's first flow step raises a start
// gate, regardless of `after:` — there is no auto-start path. `after:` remains only a precondition on
// when the gate may be raised, never a licence to begin work. Fixed in src/dagwalk.ts (the daemon's
// single-step advance), src/runner.ts (the in-memory walk), and src/board/derive.ts (the board's own
// gate projection).
// ---------------------------------------------------------------------------

describe("[surface 5/1 · HIGH · FIXED — ruling C8] daemon autostart without approval", () => {
  let root: string;
  beforeEach(() => {
    root = seedScratchRepo();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("PREVENTED: daemon must NOT invoke a member for an injected active/no-after unit with no Conductor approval", () => {
    // A non-Conductor path drops a brand-new active unit — no after:, no artifacts, no gate, no click.
    // This is exactly the "foreign or hand-written unit.md" scenario: it must cause NO member
    // invocation, only a start gate.
    const unitDir = join(root, "work/storefront/injected-unit");
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(join(unitDir, "unit.md"), ["---", "type: feature", "status: active", "---", "", "# injected", ""].join("\n"));
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "adversary drops a unit.md"]);

    const invoked: string[] = [];
    const daemon = new Daemon(root, {
      now: () => "2026-07-12T00:00:00Z",
      memberRunner: (repo) => {
        const inner = stubAdapterRunner(repo);
        return {
          capabilities: () => inner.capabilities(),
          produce: (m, k, u, p) => {
            invoked.push(`${m}:${k}:${u}`);
            return inner.produce(m, k, u, p);
          },
        };
      },
    });
    try {
      // Multiple ticks: the start gate must never be crossed by the autonomous walk, ever.
      for (let i = 0; i < 3; i++) daemon.tick();
    } finally {
      daemon.stop();
    }
    expect(invoked.filter((i) => i.endsWith(":injected-unit"))).toEqual([]);
    // The unit directory holds nothing but the unit.md an adversary planted — no artifact was
    // produced, only an (invisible-from-disk) start gate.
    expect(readFileSync(join(unitDir, "unit.md"), "utf8")).toContain("status: active");
  });
});

// ---------------------------------------------------------------------------
// Surface 7 + 10 — fail-open / audit-trail: the committed-mutation immutability gap (A7) (HIGH,
// DEFERRED — known/documented). Invariant 3 says an approved artifact is immutable; §4 says its content
// "may not change in a later commit". The check only diffs the working tree against HEAD, so a mutation
// that is itself committed advances HEAD and the check reports valid (S2a). This lets an adversary with
// repo write (or the daemon/CSRF write paths) rewrite an APPROVED artifact's content and have `levare
// validate` still pass — laundering a machine/adversary edit as an intact Conductor-approved artifact.
// Closing it requires recording each artifact's approval commit ref (NOTES A7) — deferred by design.
// ---------------------------------------------------------------------------

describe("[surface 7/10 · HIGH · DEFERRED — known gap A7] approved artifact mutated in a later commit", () => {
  let root: string;
  beforeEach(() => {
    root = seedScratchRepo();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test.failing("EXPECTED-TO-FAIL: validate must reject an approved artifact whose content changed in a later commit", () => {
    // Approve an artifact and commit that approval.
    const specAbs = join(root, SPEC_REL);
    let src = readFileSync(specAbs, "utf8").replace("status: in-review", "status: approved").replace(
      "approved_by: null",
      'approved_by: "cas 2026-07-11"',
    );
    writeFileSync(specAbs, src);
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "approve spec"]);

    // Now mutate the APPROVED artifact's body and commit the change (advancing HEAD).
    writeFileSync(specAbs, src + "\n\nAdversary-inserted paragraph after approval.\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "tamper with approved spec"]);

    // SECURE behavior (currently violated): the immutability check should flag the post-approval edit.
    const result = validatePath(root);
    expect(result.ok).toBe(false);
  });
});

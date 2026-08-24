// Findings 86/88: timeline.ts's own unit coverage — none existed before this goal even though
// board/render/run.ts and orchestrator-projection.ts both depend on it. Two things exercised here
// directly, without the full board/gateops machinery: `gitLogRows`' registry-touch marker (Finding 88)
// and the `ledgerRows`/`appendBranchEvent` round trip for a branch-creation event (Finding 86).
// board/gateops.ts's own call site — that `doStart` actually invokes `appendBranchEvent` — is covered
// live in tests/merge-gate.test.ts's "M1" describe block instead, where a real project repo already
// exists.

import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { assertSpawnOk } from "./spawn-helpers.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitLogRows, ledgerRows, appendBranchEvent } from "../src/timeline.ts";
import { CONDUCTOR_NAME } from "../src/git.ts";

const HERMETIC_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" };

function git(root: string, args: string[]): string {
  const r = spawnSync("git", ["-C", root, "-c", "user.name=seed", "-c", "user.email=seed@levare.test", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], {
    encoding: "utf8",
    env: HERMETIC_ENV,
  });
  assertSpawnOk(`git ${args.join(" ")}`, r);
  return r.stdout;
}

function writeFile(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

function rmrf(p: string): void {
  rmSync(p, { recursive: true, force: true });
}

describe("gitLogRows: Finding 88 registry-touch marker", () => {
  test("a commit touching only the unit's own directory is not marked", () => {
    const root = mkdtempSync(join(tmpdir(), "levare-tl-studio-"));
    try {
      git(root, ["init", "-q"]);
      const unitDir = join(root, "work", "acme", "widget-1");
      writeFile(join(unitDir, "unit.md"), "# widget-1\n");
      git(root, ["add", "-A"]);
      git(root, ["commit", "-q", "-m", "open widget-1"]);

      const rows = gitLogRows(root, unitDir);
      expect(rows.length).toBe(1);
      expect(rows[0].registry).toBeFalsy();
    } finally {
      rmrf(root);
    }
  });

  test("a commit that ALSO touches a governing registry path is marked, even though the pathspec is scoped to the unit", () => {
    const root = mkdtempSync(join(tmpdir(), "levare-tl-studio-"));
    try {
      git(root, ["init", "-q"]);
      const unitDir = join(root, "work", "acme", "widget-1");
      writeFile(join(unitDir, "unit.md"), "# widget-1\n");
      writeFile(join(root, "projects", "acme.md"), "repo: /abs/path\n");
      git(root, ["add", "-A"]);
      git(root, ["commit", "-q", "-m", "register acme's repo path while opening widget-1"]);

      const rows = gitLogRows(root, unitDir);
      expect(rows.length).toBe(1);
      expect(rows[0].registry).toBe(true);
    } finally {
      rmrf(root);
    }
  });

  test("a later, unrelated registry-only commit never appears in the unit's own timeline (pathspec still scopes which commits are selected)", () => {
    const root = mkdtempSync(join(tmpdir(), "levare-tl-studio-"));
    try {
      git(root, ["init", "-q"]);
      const unitDir = join(root, "work", "acme", "widget-1");
      writeFile(join(unitDir, "unit.md"), "# widget-1\n");
      git(root, ["add", "-A"]);
      git(root, ["commit", "-q", "-m", "open widget-1"]);

      writeFile(join(root, "teams", "shipteam.md"), "name: shipteam\n");
      git(root, ["add", "-A"]);
      git(root, ["commit", "-q", "-m", "unrelated registry edit"]);

      const rows = gitLogRows(root, unitDir);
      expect(rows.length).toBe(1);
      expect(rows[0].text).toContain("open widget-1");
    } finally {
      rmrf(root);
    }
  });
});

describe("ledgerRows + appendBranchEvent: Finding 86", () => {
  test("a branch event round-trips as a Conductor-attributed row, distinct from a produce row", () => {
    const unitDir = mkdtempSync(join(tmpdir(), "levare-tl-unit-"));
    try {
      writeFileSync(join(unitDir, "ledger.ndjson"), `${JSON.stringify({ ts: "2026-08-19T08:00:00.000Z", event: "produce", member: "worker", kind: "task" })}\n`);
      appendBranchEvent(unitDir, "levare/widget-1", "2026-08-19T08:05:00.000Z");

      const rows = ledgerRows(unitDir);
      expect(rows.length).toBe(2);
      const produceRow = rows.find((r) => r.kind === "produce")!;
      expect(produceRow.actor).toEqual({ kind: "member", name: "worker" });

      const branchRow = rows.find((r) => r.kind === "branch")!;
      expect(branchRow.actor).toEqual({ kind: "conductor", name: CONDUCTOR_NAME });
      expect(branchRow.text).toContain("levare/widget-1");
      expect(branchRow.ts).toBe("2026-08-19T08:05:00.000Z");
    } finally {
      rmrf(unitDir);
    }
  });
});

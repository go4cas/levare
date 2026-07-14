import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, cpSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePath, formatValidationErrors } from "../src/validate.ts";
import { createBoard } from "../src/board/serve.ts";
import { advanceUnit } from "../src/dagwalk.ts";
import { loadRepo } from "../src/repo.ts";
import type { AsyncMemberRunner } from "../src/dagwalk.ts";

// NOTES F22: `validate.ts`'s own per-file, per-field accumulation was always correct — the gap was
// every DOWNSTREAM caller that turned a `ValidationError[]` into one human-facing message and kept
// only `errors[0]`: a project pointer (or a produced artifact) with three simultaneous problems
// reported one, the Conductor fixed it, ran again, got told about the second, and so on — three
// round-trips to learn what one message could have said. `formatValidationErrors` is now the one
// place a `ValidationError[]` becomes a string, used by orchestrator.ts, board/gateops.ts,
// board/serve.ts's registry route, dagwalk.ts, and runner.ts alike.

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

function seedScratchRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "levare-f22-"));
  cpSync("fixtures/golden", root, { recursive: true });
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "seed golden fixture"]);
  return root;
}

function req(url: string, init?: RequestInit): Request {
  return new Request(`http://localhost${url}`, init);
}

describe("F22: a project pointer missing three required fields reports all three in one pass", () => {
  test("validatePath itself: the underlying mechanism already accumulates (regression pin)", () => {
    const root = mkdtempSync(join(tmpdir(), "levare-f22-project-"));
    try {
      mkdirSync(join(root, "projects"), { recursive: true });
      writeFileSync(join(root, "projects/acme.md"), "---\nname: acme\n---\n\n# Acme\n");
      const result = validatePath(root);
      expect(result.ok).toBe(false);
      const missingCodes = result.errors.filter((e) => e.code === "MISSING_FIELD").map((e) => e.message);
      expect(missingCodes.some((m) => m.includes("repo"))).toBe(true);
      expect(missingCodes.some((m) => m.includes("remote"))).toBe(true);
      expect(missingCodes.some((m) => m.includes("default_branch"))).toBe(true);
      expect(missingCodes.length).toBeGreaterThanOrEqual(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the board's registry edit route surfaces every missing field at once, not one per round-trip", async () => {
    const root = seedScratchRepo();
    try {
      const board = createBoard(root, {});
      const res = await board.fetch(
        req("/registry/projects/storefront.md", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: "---\nname: storefront\n---\n\n# Storefront\n" }),
        }),
      );
      board.close();
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toContain("repo");
      expect(body.error).toContain("remote");
      expect(body.error).toContain("default_branch");
      expect(body.error).toContain("deploy");
      expect(body.error).toContain("pace");
      // Every problem is ONE string with multiple MISSING_FIELD codes, not a single truncated one.
      expect((body.error.match(/MISSING_FIELD/g) ?? []).length).toBeGreaterThanOrEqual(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("formatValidationErrors joins every error, in order, never just the first", () => {
    const joined = formatValidationErrors([
      { code: "MISSING_FIELD", message: "missing required field 'repo' in project", file: "x" },
      { code: "MISSING_FIELD", message: "missing required field 'remote' in project", file: "x" },
      { code: "BAD_ENUM", message: "field 'pace' must be one of [auto, step] in project, got 'bogus'", file: "x" },
    ]);
    expect(joined).toContain("repo");
    expect(joined).toContain("remote");
    expect(joined).toContain("pace");
  });
});

describe("F22: a produced artifact with multiple simultaneous contract violations blocks with every reason, not just the first", () => {
  test("dagwalk.ts#writeBlocked's reason names every accumulated validation error", async () => {
    const root = seedScratchRepo();
    try {
      const badRunner: AsyncMemberRunner = {
        capabilities: () => [{ member: "wren", kind: "product-brief" }],
        produce: () => ({
          doc: [
            "---",
            "kind: product-brief",
            "id: placeholder",
            "unit: loyalty-flow",
            "project: storefront",
            "status: in-review",
            "produced_by: kestrel/wren",
            "consumes: []",
            "supersedes: null",
            "approved_by: null",
            "created: 2026-07-12",
            "files: [ghost-attachment.md]", // MISSING_FILE — doesn't exist beside the artifact
            "bogus_extra_key: nonsense", // UNKNOWN_KEY — simultaneously
            "---",
            "",
            "# product brief",
            "",
            "Two problems at once.",
            "",
          ].join("\n"),
        }),
      };
      const repo = loadRepo(root);
      const unit = repo.units.find((u) => u.unit === "loyalty-flow")!;
      const result = await advanceUnit(root, repo, unit, badRunner, { startAuthorized: true, today: "2026-07-12" });
      expect(result.outcome).toBe("blocked");
      if (result.outcome !== "blocked") return;
      expect(result.error).toContain("UNKNOWN_KEY");
      expect(result.error).toContain("MISSING_FILE");

      const blockedDoc = readFileSync(join(root, "work/storefront/loyalty-flow", `${result.artifactId}.md`), "utf8");
      expect(blockedDoc).toContain("UNKNOWN_KEY");
      expect(blockedDoc).toContain("MISSING_FILE");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, cpSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { assertSpawnOk } from "./spawn-helpers.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBoard } from "../src/board/serve.ts";

// Findings 31/32 acceptance: a `.env` correction reaches process.env on the very next board request —
// no `levare serve` restart required. `applyStudioEnv` itself is unit-tested (dotenv.test.ts) against
// its own re-invocation semantics; this proves the wiring — that `board.fetch()` actually re-invokes
// it per request against the REAL process.env (the default target every production request uses),
// not just that the function is safe to call twice in isolation.

const HERMETIC_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" };

function git(repoRoot: string, args: string[]): ReturnType<typeof spawnSync> {
  const r = spawnSync(
    "git",
    ["-C", repoRoot, "-c", "user.name=seed", "-c", "user.email=seed@levare.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "init.defaultBranch=main", ...args],
    { encoding: "utf8", env: HERMETIC_ENV },
  );
  assertSpawnOk(`git ${args.join(" ")}`, r);
  return r;
}

function seedScratchRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "levare-board-dotenv-"));
  cpSync("fixtures/golden", root, { recursive: true });
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "seed golden fixture"]);
  return root;
}

function req(url: string): Request {
  return new Request(`http://localhost${url}`, { headers: { origin: "http://localhost" } });
}

// Two distinct names, deliberately never reused between the two tests below: dotenv.ts's per-target
// ownership memory is keyed by object identity, and `process.env` is a true process-wide singleton —
// reusing one name across both tests would let the first test's dotenv-ownership of that name leak
// into the second, faking a "shell value mutated after dotenv already owned it" case that can never
// happen for a real `levare serve` process (nothing but applyStudioEnv itself ever writes to
// process.env at runtime; a real shell export is only ever present at process start, before the first
// applyStudioEnv call of a fresh process ever runs).
const HOT_RELOAD_PROBE_VAR = "LEVARE_TEST_SERVE_DOTENV_HOT_RELOAD_PROBE";
const SHELL_WINS_PROBE_VAR = "LEVARE_TEST_SERVE_DOTENV_SHELL_WINS_PROBE";
const DELETED_PROBE_VAR = "LEVARE_TEST_SERVE_DOTENV_DELETED_PROBE";

describe("levare serve — a corrected .env takes effect without a restart", () => {
  afterEach(() => {
    delete process.env[HOT_RELOAD_PROBE_VAR];
    delete process.env[SHELL_WINS_PROBE_VAR];
    delete process.env[DELETED_PROBE_VAR];
  });

  test("a GET to a page route re-derives .env into the real process.env, picking up a later edit", async () => {
    const root = seedScratchRepo();
    const board = createBoard(root);
    try {
      writeFileSync(join(root, ".env"), `${HOT_RELOAD_PROBE_VAR}=first\n`);
      await board.fetch(req("/"));
      expect(process.env[HOT_RELOAD_PROBE_VAR]).toBe("first");

      writeFileSync(join(root, ".env"), `${HOT_RELOAD_PROBE_VAR}=second\n`);
      await board.fetch(req("/"));
      expect(process.env[HOT_RELOAD_PROBE_VAR]).toBe("second"); // picked up without restarting the board
    } finally {
      board.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a genuinely shell-exported value still always wins, even across repeated board requests", async () => {
    const root = seedScratchRepo();
    process.env[SHELL_WINS_PROBE_VAR] = "from-shell"; // present BEFORE this name has ever been touched
    const board = createBoard(root);
    try {
      writeFileSync(join(root, ".env"), `${SHELL_WINS_PROBE_VAR}=from-dotenv\n`);
      await board.fetch(req("/"));
      expect(process.env[SHELL_WINS_PROBE_VAR]).toBe("from-shell");

      writeFileSync(join(root, ".env"), `${SHELL_WINS_PROBE_VAR}=still-from-dotenv\n`);
      await board.fetch(req("/"));
      expect(process.env[SHELL_WINS_PROBE_VAR]).toBe("from-shell"); // never shadowed, not even on a second request
    } finally {
      board.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Finding 138 acceptance: deleting a line from .env must unset it from process.env on the very next
  // request, the same way an edited line hot-reloads — not just at the unit level (dotenv.test.ts) but
  // through the real board.fetch() -> applyStudioEnv(root) wiring against the real process.env.
  test("deleting a line from .env unsets it from process.env on the next request, without a restart", async () => {
    const root = seedScratchRepo();
    const board = createBoard(root);
    try {
      writeFileSync(join(root, ".env"), `${DELETED_PROBE_VAR}=present\n`);
      await board.fetch(req("/"));
      expect(process.env[DELETED_PROBE_VAR]).toBe("present");

      writeFileSync(join(root, ".env"), ""); // the operator deletes the line
      await board.fetch(req("/"));
      expect(process.env[DELETED_PROBE_VAR]).toBeUndefined();
    } finally {
      board.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

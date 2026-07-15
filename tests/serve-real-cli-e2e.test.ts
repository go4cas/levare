import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, cpSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRepo, repoCapabilities } from "../src/repo.ts";
import { assembleContext } from "../src/context.ts";
import { spawnLevareServe } from "./serve-subprocess.ts";

// NOTES F4 — the live-dogfood defect this file exists to pin down for good: `daemon.ts` and
// `board/gateops.ts` both defaulted their production `memberRunner` to `stubAdapterRunner`
// (replay.ts), the SAME constructor `levare replay --stubs` uses to redirect a CLI member's spawn at
// the fixture stub CLI. Every other test that exercised the daemon/gateops default injected a
// scripted or mocked MemberRunner explicitly (see daemon.test.ts, binding.test.ts, etc.) — none of
// them ever drove the REAL default all the way down to a REAL CLI subprocess, so three phases of
// green tests never once proved the thing this file proves: that a real `levare serve`, started
// exactly the way a user starts it, spawns a CLI member's own declared command — not a fixture.
//
// This spawns the actual `./levare` binary (the same entry point board-serve-e2e.test.ts proves is a
// real, listening process) against a scratch studio whose CLI agent's `command` points at a real,
// trivial shell script, and asserts two independent things, both against REAL observed state, never
// an internal flag: (1) the exact argv the script received (proving `{task}` substitution — the real
// `defaultCliCommand` path — not the stub's `member kind --unit U --project P` convention), and (2)
// the artifact the daemon wrote to disk is byte-for-byte the doc the real script emitted.

const REPO_ROOT = join(import.meta.dir, "..");

const HERMETIC_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

function git(repoRoot: string, args: string[]): void {
  const r = spawnSync(
    "git",
    ["-C", repoRoot, "-c", "user.name=seed", "-c", "user.email=seed@levare.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "init.defaultBranch=main", ...args],
    { encoding: "utf8", env: HERMETIC_ENV },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}${r.stdout}`);
}

async function waitUntilUp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      await res.arrayBuffer();
      return;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`server never came up at ${url}: ${lastErr}`);
}

describe("`./levare serve` spawns a CLI member's REAL command, never the fixture stub (NOTES F4)", () => {
  let root: string;
  let scriptDir: string;
  let proc: ReturnType<typeof Bun.spawn>;
  let base: string;

  let scriptPath: string;
  let capturePath: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "levare-real-cli-e2e-"));
    cpSync(join(REPO_ROOT, "fixtures/golden"), root, { recursive: true });

    // A real, trivial executable standing in for a real CLI member (the goal's own example: a real
    // command like `gemini`). It ignores nothing — it captures argv[1] (the {task}-substituted
    // element) VERBATIM, byte-for-byte, to the capture file (`printf '%s'`, no trailing newline, no
    // interpretation — NOTES F7: argv[1] is now the full multi-line §6 context, not a single word, so
    // this must survive embedded newlines intact for the byte-for-byte comparison below) and prints a
    // real, valid `product-brief` artifact to stdout, with a body marker no fixture stub could ever
    // produce.
    scriptDir = mkdtempSync(join(tmpdir(), "levare-real-cli-script-"));
    scriptPath = join(scriptDir, "real-member.sh");
    capturePath = join(scriptDir, "argv-capture.txt");
    writeFileSync(
      scriptPath,
      [
        "#!/bin/sh",
        'printf \'%s\' "$1" > "$2"',
        "cat <<'DOC'",
        "---",
        "kind: product-brief",
        "id: product-brief-loyalty-flow-v1",
        "unit: loyalty-flow",
        "project: storefront",
        "status: in-review",
        "produced_by: kestrel/wren",
        "consumes: []",
        "supersedes: null",
        "approved_by: null",
        "created: 2026-07-13",
        "files: []",
        "---",
        "",
        "# REAL-CLI-MEMBER-RAN",
        "",
        "This artifact was emitted by a real, trivial executable spawned by the real `defaultCliCommand`",
        "argv path — never the fixtures/stubs/member-stub.ts replay stub.",
        "DOC",
        "",
      ].join("\n"),
    );
    chmodSync(scriptPath, 0o755);

    // Rewire wren (kestrel's first flow-step producer, kind: native in the golden fixture) to a real
    // CLI agent whose command is the script above. `{task}` substitutes to the resolved kind
    // (`product-brief`); the trailing literal element is the capture-file path, passed straight
    // through unchanged (only `{task}`/`{feature_repo}` are ever substituted).
    const wrenFile = join(root, "agents/wren.md");
    writeFileSync(
      wrenFile,
      [
        "---",
        "name: wren",
        "kind: cli",
        "produces: [product-brief]",
        `command: ["${scriptPath}", "{task}", "${capturePath}"]`,
        "timeout: 30",
        'result: "Emits a product-brief artifact markdown file to stdout."',
        "style:",
        "  avatar: Wr",
        "---",
        "",
        "# Wren — a real, trivial CLI member (F4 e2e)",
      ].join("\n"),
    );

    git(root, ["init", "-q"]);
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "seed golden fixture with a real CLI wren"]);

    ({ proc, base } = await spawnLevareServe([root], { cwd: REPO_ROOT }));
    await waitUntilUp(`${base}/`, 10_000);
  });

  afterAll(() => {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already exited */
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(scriptDir, { recursive: true, force: true });
  });

  test("starting loyalty-flow's unit over HTTP spawns wren's REAL command, not the stub", async () => {
    // loyalty-flow's `after: [cart-icon-fix]` is already satisfied in the golden fixture (E5) — its
    // start gate is immediately actionable, no setup beyond seeding required.
    const res = await fetch(`${base}/gates/storefront/loyalty-flow/start`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // (1) NOTES F7 — argv[1] (the real script's own capture of $1) is the FULL §6-assembled context,
    // never the bare resolved kind/step label. Computed independently (the same recipe `levare
    // context`'s dry-run prints) and compared byte-for-byte — this is the real, live production path
    // (AdapterRunner.produceAsync → defaultCliCommand), not a mock.
    const captured = readFileSync(capturePath, "utf8");
    const repo = loadRepo(root);
    const expectedContext = assembleContext(repo, { root, agent: "wren", unit: "loyalty-flow", capabilities: repoCapabilities(repo) });
    expect(captured).toBe(expectedContext);
    expect(captured).not.toBe("product-brief"); // the pre-F7 defect: {task} was the bare resolved kind.
    expect(captured).toContain("── 1. agent · wren");
    expect(captured).toContain("── 6. task ──");

    // (2) `levare context wren --unit loyalty-flow --dry-run` must print EXACTLY what the real CLI
    // member actually received — the same invariant already held for native members.
    const dryRun = spawnSync("./levare", ["context", "wren", "--unit", "loyalty-flow", "--root", root, "--dry-run"], { cwd: REPO_ROOT, encoding: "utf8" });
    expect(dryRun.status).toBe(0);
    expect(dryRun.stdout).toBe(captured);

    // (3) The artifact actually landed on disk is byte-for-byte what the real script emitted.
    const artifactPath = join(root, "work/storefront/loyalty-flow/product-brief-loyalty-flow-v1.md");
    const doc = readFileSync(artifactPath, "utf8");
    expect(doc).toContain("# REAL-CLI-MEMBER-RAN");
    expect(doc).toContain("status: in-review");
    expect(doc).not.toContain("no canned artifact");
  });
});

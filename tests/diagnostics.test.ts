import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, cpSync, writeFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.ts";
import { resolveGate } from "../src/board/gateops.ts";
import { repoCapabilities } from "../src/repo.ts";
import { loadPricing } from "../src/pricing.ts";
import { AdapterRunner, type NativeBoundary, type RemoteBoundary } from "../src/adapters.ts";
import type { Verb } from "../src/runner.ts";

// NOTES F3 — the dogfood defect this file pins: a real CLI member's failure reported nothing but
// "cli member 'rook' exited 1". Diagnosing it live took an hour and an ad hoc, externally-built
// environment-dumping spy — which is itself a secret-leak hazard. These tests drive a REAL failing
// subprocess (not a mock) through the daemon's actual production path and assert two things at once:
// (1) the member's own stderr reaches the blocked artifact, the AdvanceResult, and the daemon's own
// console output; (2) a secret VALUE granted to that same member via a connector never appears
// anywhere levare writes — not the artifact, not the git commit, not the console — only its NAME
// ever needs to travel through levare's own plumbing.

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
  const root = mkdtempSync(join(tmpdir(), "levare-diagnostics-"));
  cpSync("fixtures/golden", root, { recursive: true });
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "seed golden fixture"]);
  return root;
}

const unusedBoundary: NativeBoundary & RemoteBoundary = {
  invoke: () => {
    throw new Error("not used by this test — lyra is a CLI member here");
  },
  call: () => {
    throw new Error("not used by this test");
  },
};

describe("F3: a real failing CLI member's stderr reaches the blocked reason, and a granted secret's VALUE never does", () => {
  let root: string;
  const secretValue = "SECRET_VALUE_9f3a2b1c7d4e";
  const stderrMarker = "lyra-cli: house-style lint failed on 3 files";

  beforeEach(async () => {
    root = seedScratchRepo();
    // loyalty-flow's first step (`brief`, wren) is produced and approved through the ordinary golden
    // stub path — untouched — so the walk reaches `design` exactly as the existing daemon tests do.
    await resolveGate(root, "storefront", "loyalty-flow", "start", { today: "2026-07-12" });
    await resolveGate(root, "storefront", "product-brief-loyalty-flow-v1", "approve" as Verb, { today: "2026-07-12" });

    // Now turn lyra (the SECOND step, `design`) into a real CLI member: a genuine subprocess that
    // writes ordinary failure text to stderr and exits non-zero, and is granted the `github`
    // connector — so its env carries a real secret value that nothing in levare's own diagnostics may
    // ever repeat. The script itself never touches its env — any leak downstream is levare's fault,
    // never the member's.
    const scriptPath = join(root, "lyra-fail.mjs");
    writeFileSync(scriptPath, `process.stderr.write(${JSON.stringify(stderrMarker + "\n")});\nprocess.exit(4);\n`);
    writeFileSync(
      join(root, "agents/lyra.md"),
      [
        "---",
        "name: lyra",
        "kind: cli",
        "produces: [design, spec]",
        `command: ["${process.execPath}", "${scriptPath}"]`,
        "timeout: 5",
        "connectors: [github]",
        'result: "test double — always fails"',
        "style:",
        "  avatar: Ly",
        "---",
        "",
        "# Lyra (test double — a real, deliberately failing CLI member)",
        "",
      ].join("\n"),
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("blocked artifact + daemon console carry the real stderr; the secret's value appears nowhere", async () => {
    const logs: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      const daemon = new Daemon(root, {
        memberRunner: (repo) =>
          new AdapterRunner(repo, {
            pricing: loadPricing(root),
            capabilities: repoCapabilities(repo),
            native: unusedBoundary,
            remote: unusedBoundary,
            // Real process.env plus a synthetic secret — proves the allowlist genuinely carries a real
            // value through to the spawned process (the member's env, not levare's own logging).
            baseEnv: { ...process.env, GITHUB_TOKEN: secretValue },
          }),
      });

      const result = await daemon.tick();
      const entry = result.entries.find((e) => e.unit === "loyalty-flow")!;
      expect(entry.outcome.outcome).toBe("blocked");
      if (entry.outcome.outcome !== "blocked") throw new Error("unreachable");

      // (1) diagnosis: the real stderr and exit code reached the blocked outcome, not a bare "exited 4".
      expect(entry.outcome.error).toContain(stderrMarker);
      expect(entry.outcome.error).toContain("exited 4");
      const artifactBody = readFileSync(entry.outcome.file, "utf8");
      expect(artifactBody).toContain(stderrMarker);
      expect(artifactBody).toContain("exited 4");

      // ...and it reached the daemon's own console output too (previously only the F1 `unbindable`
      // case did; a member that ran and failed logged nothing).
      const consoleOutput = logs.join("\n");
      expect(consoleOutput).toContain("BLOCKED");
      expect(consoleOutput).toContain(stderrMarker);

      // (3) redaction: the secret's VALUE is granted to the member's real env (proven above the member
      // ran genuinely), but never appears in anything levare itself writes or prints.
      expect(artifactBody).not.toContain(secretValue);
      expect(entry.outcome.error).not.toContain(secretValue);
      expect(consoleOutput).not.toContain(secretValue);
      const commitMsg = git(root, ["log", "-1", "--pretty=%B"]).stdout;
      expect(commitMsg).not.toContain(secretValue);
      const commitDiff = git(root, ["show", "--stat", "-1"]).stdout;
      expect(commitDiff).not.toContain(secretValue);
    } finally {
      console.error = originalError;
    }
  });
});

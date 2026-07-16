import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDotenv, loadDotenvFile, applyStudioEnv } from "../src/dotenv.ts";
import { buildMemberEnv } from "../src/env.ts";
import { loadRepo } from "../src/repo.ts";

// NOTES C11 part 4: `levare serve`/`levare doctor` load `<studio root>/.env` into the process
// environment on startup — exactly as if the operator had exported those variables in their shell.
// This must change nothing about connector scoping: env.ts's `buildMemberEnv` allowlist governs what
// any member's spawned process sees regardless of where a variable in `process.env` came from.

function scratchRoot(): string {
  return mkdtempSync(join(tmpdir(), "levare-dotenv-"));
}

describe("parseDotenv", () => {
  test("parses KEY=VALUE lines, skips blanks and comments", () => {
    const entries = parseDotenv(
      [
        "# a comment",
        "",
        "ANTHROPIC_API_KEY=sk-ant-abc123",
        "  GEMINI_API_KEY = leading-and-trailing-space ",
        "export GITHUB_TOKEN=ghp_exported",
        'QUOTED="a value with spaces"',
        "SINGLE='single quoted'",
        "not a valid line",
        "1INVALID=nope",
      ].join("\n"),
    );
    expect(entries).toEqual([
      { name: "ANTHROPIC_API_KEY", value: "sk-ant-abc123" },
      { name: "GEMINI_API_KEY", value: "leading-and-trailing-space" },
      { name: "GITHUB_TOKEN", value: "ghp_exported" },
      { name: "QUOTED", value: "a value with spaces" },
      { name: "SINGLE", value: "single quoted" },
    ]);
  });

  test("an absent .env file yields no entries", () => {
    const root = scratchRoot();
    try {
      expect(loadDotenvFile(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("applyStudioEnv", () => {
  test("loads .env variables into the target environment", () => {
    const root = scratchRoot();
    try {
      writeFileSync(join(root, ".env"), "GEMINI_API_KEY=from-dotenv\nANTHROPIC_API_KEY=also-from-dotenv\n");
      const target: Record<string, string | undefined> = {};
      const provenance = applyStudioEnv(root, target);
      expect(target.GEMINI_API_KEY).toBe("from-dotenv");
      expect(target.ANTHROPIC_API_KEY).toBe("also-from-dotenv");
      expect(provenance.get("GEMINI_API_KEY")).toBe("dotenv");
      expect(provenance.get("ANTHROPIC_API_KEY")).toBe("dotenv");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a variable already present (exported) in the target wins over .env, and is reported as shell", () => {
    const root = scratchRoot();
    try {
      writeFileSync(join(root, ".env"), "GEMINI_API_KEY=from-dotenv\n");
      const target: Record<string, string | undefined> = { GEMINI_API_KEY: "from-shell" };
      const provenance = applyStudioEnv(root, target);
      expect(target.GEMINI_API_KEY).toBe("from-shell"); // never shadowed
      expect(provenance.get("GEMINI_API_KEY")).toBe("shell");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("no .env at the root leaves the target untouched", () => {
    const root = scratchRoot();
    try {
      const target: Record<string, string | undefined> = { PATH: "/usr/bin" };
      const provenance = applyStudioEnv(root, target);
      expect(target).toEqual({ PATH: "/usr/bin" });
      expect(provenance.size).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// The acceptance criterion itself: a .env-loaded credential is visible to process.env-reading code
// (the same as if the operator had exported it), but the connector allowlist still governs what any
// individual MEMBER's spawned process actually sees — a member without the granting connector cannot
// see a variable this only just added to the environment.
describe("NOTES C11 part 4 acceptance: .env loads into the process env, but connector scoping is unaffected", () => {
  test("a member without a gemini grant still cannot see GEMINI_API_KEY loaded from .env", () => {
    const root = scratchRoot();
    try {
      writeFileSync(join(root, ".env"), "GEMINI_API_KEY=sk-gemini-secret\nANTHROPIC_API_KEY=sk-ant-secret\n");
      // A minimal on-disk studio: one connector (gemini), one agent NOT granted it.
      mkdirSync(join(root, "connectors"), { recursive: true });
      writeFileSync(join(root, "connectors/gemini.md"), "---\nname: gemini\nkind: cli\ncommand: gemini\nenv: [GEMINI_API_KEY]\n---\n");
      mkdirSync(join(root, "agents"), { recursive: true });
      writeFileSync(
        join(root, "agents/ungranted.md"),
        "---\nname: ungranted\nkind: cli\nproduces: [spec]\ncommand: [echo]\nresult: stdout\nstyle:\n  avatar: un\n---\n",
      );
      mkdirSync(join(root, "teams"), { recursive: true });
      writeFileSync(
        join(root, "teams/solo.md"),
        "---\nname: solo\nconsumes: []\nproduces: [spec]\nmembers: [ungranted]\nflow: []\nstyle:\n  color: '#000'\n---\n",
      );

      // Load .env into a scratch env object standing in for process.env — never mutate the real
      // process.env in this test (other tests in the same run must not observe this credential).
      const target: Record<string, string | undefined> = { PATH: "/usr/bin", HOME: "/home/test" };
      applyStudioEnv(root, target);
      expect(target.GEMINI_API_KEY).toBe("sk-gemini-secret"); // it IS in the process env now...

      const repo = loadRepo(root);
      const memberEnv = buildMemberEnv(repo, "ungranted", target);
      expect(memberEnv.GEMINI_API_KEY).toBeUndefined(); // ...but this ungranted member still can't see it
      expect(memberEnv.ANTHROPIC_API_KEY).toBeUndefined(); // no connector at all grants this one
      expect(memberEnv.PATH).toBe("/usr/bin"); // the baseline still passes through
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a member WITH the gemini grant sees the .env-loaded GEMINI_API_KEY", () => {
    const root = scratchRoot();
    try {
      writeFileSync(join(root, ".env"), "GEMINI_API_KEY=sk-gemini-secret\n");
      mkdirSync(join(root, "connectors"), { recursive: true });
      writeFileSync(join(root, "connectors/gemini.md"), "---\nname: gemini\nkind: cli\ncommand: gemini\nenv: [GEMINI_API_KEY]\n---\n");
      mkdirSync(join(root, "agents"), { recursive: true });
      writeFileSync(
        join(root, "agents/granted.md"),
        "---\nname: granted\nkind: cli\nproduces: [spec]\ncommand: [echo]\nresult: stdout\nconnectors: [gemini]\nstyle:\n  avatar: gr\n---\n",
      );
      mkdirSync(join(root, "teams"), { recursive: true });
      writeFileSync(
        join(root, "teams/solo.md"),
        "---\nname: solo\nconsumes: []\nproduces: [spec]\nmembers: [granted]\nflow: []\nstyle:\n  color: '#000'\n---\n",
      );

      const target: Record<string, string | undefined> = { PATH: "/usr/bin" };
      applyStudioEnv(root, target);
      const repo = loadRepo(root);
      const memberEnv = buildMemberEnv(repo, "granted", target);
      expect(memberEnv.GEMINI_API_KEY).toBe("sk-gemini-secret");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the real levare serve/doctor entrypoint loads .env into the actual process.env (default target)", () => {
    const root = scratchRoot();
    const savedValue = process.env.LEVARE_TEST_DOTENV_PROBE;
    try {
      writeFileSync(join(root, ".env"), "LEVARE_TEST_DOTENV_PROBE=present\n");
      delete process.env.LEVARE_TEST_DOTENV_PROBE;
      applyStudioEnv(root); // default target = process.env, exactly what cli.ts's runServeCmd/runDoctorCmd call
      expect(process.env.LEVARE_TEST_DOTENV_PROBE ?? "").toBe("present");
    } finally {
      if (savedValue === undefined) delete process.env.LEVARE_TEST_DOTENV_PROBE;
      else process.env.LEVARE_TEST_DOTENV_PROBE = savedValue;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

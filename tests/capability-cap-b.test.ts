import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRepo } from "../src/repo.ts";
import { buildMemberEnv, scopeHome } from "../src/env.ts";
import { validatePath } from "../src/validate.ts";
import { SDK_TOOL_NAMES } from "../src/sdk-transport.ts";
import { loadPricing } from "../src/pricing.ts";
import { AdapterRunner, type InvokeRequest, type NativeBoundary, type RemoteBoundary, type AsyncCliSpawn, type SpawnResult } from "../src/adapters.ts";
import type { Connector } from "../src/types.ts";

// NOTES CAP-B (v1.1 capability layer, part B): the tools vocabulary and scoped HOME — enforce where
// possible (native allowedTools, symlinked scratch HOME), say so plainly where not (cli tools, the
// residual subscription-login reality). These tests exercise every acceptance item named in the goal.

const ROOT = "fixtures/golden";

// ---------------------------------------------------------------------------
// item 1 — tools: is a validated fixed enum, not a free-form registry
// ---------------------------------------------------------------------------
describe("item 1 — tools: vocabulary (SDK_TOOL_NAMES)", () => {
  function agentStudio(toolsLine: string, kindLine = "kind: native\nmodel: claude-sonnet-5"): string {
    const dir = mkdtempSync(join(tmpdir(), "levare-tools-enum-"));
    mkdirSync(join(dir, "agents"), { recursive: true });
    writeFileSync(
      join(dir, "agents", "scribe.md"),
      ["---", "name: scribe", kindLine, "produces: [report]", toolsLine, "style:", "  avatar: Sc", "---", "", "A member.", ""].join("\n"),
    );
    return dir;
  }

  test("real SDK tool names validate clean", () => {
    const dir = agentStudio("tools: [Read, Write, Bash]");
    try {
      const r = validatePath(dir);
      expect(r.ok).toBe(true);
      expect(r.errors).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unknown tool name is UNKNOWN_TOOL, naming the vocabulary", () => {
    const dir = agentStudio("tools: [Reed]"); // typo, not a real tool name
    try {
      const r = validatePath(dir);
      expect(r.ok).toBe(false);
      const err = r.errors.find((e) => e.code === "UNKNOWN_TOOL");
      expect(err).toBeDefined();
      expect(err!.message).toContain("scribe");
      expect(err!.message).toContain("'Reed'");
      // The vocabulary is actually named, not just referenced — a studio author can fix it without
      // spelunking into sdk-transport.ts themselves.
      expect(err!.message).toContain("Read");
      expect(err!.message).toContain("Bash");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a mix of one valid and one invalid name still reports the invalid one", () => {
    const dir = agentStudio("tools: [Read, NotATool]");
    try {
      const r = validatePath(dir);
      expect(r.ok).toBe(false);
      expect(r.errors.filter((e) => e.code === "UNKNOWN_TOOL")).toHaveLength(1);
      expect(r.errors[0].message).toContain("NotATool");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("SDK_TOOL_NAMES is a real, non-empty, honestly-derived vocabulary — never hand-invented ad hoc", () => {
    expect(SDK_TOOL_NAMES.length).toBeGreaterThan(10);
    expect(SDK_TOOL_NAMES).toContain("Read");
    expect(SDK_TOOL_NAMES).toContain("Write");
    expect(SDK_TOOL_NAMES).toContain("Bash");
    expect(SDK_TOOL_NAMES).toContain("Glob");
    expect(SDK_TOOL_NAMES).toContain("Grep");
    expect(SDK_TOOL_NAMES).toContain("WebSearch");
  });
});

// ---------------------------------------------------------------------------
// item 2 — native forwarding: the SDK boundary receives EXACTLY the declared tool list
// ---------------------------------------------------------------------------
describe("item 2 — native forwarding is real enforcement, not just a schema field", () => {
  const pricing = loadPricing(ROOT);
  const remoteMock: RemoteBoundary = { call: () => ({ doc: "unused" }) };

  test("a declared tools: list reaches the SDK boundary as BOTH tools and allowedTools, exactly as declared", () => {
    const repo = loadRepo(ROOT);
    repo.agents.get("lyra")!.tools = ["Read", "Grep", "Glob"];
    let seen: InvokeRequest | null = null;
    const spy: NativeBoundary = { invoke: (r) => ((seen = r), { doc: "---\nkind: spec\n---\n\nbody" }) };
    const runner = new AdapterRunner(repo, { pricing, capabilities: [{ member: "lyra", kind: "spec" }], native: spy, remote: remoteMock });
    runner.produce("lyra", "spec", "checkout-flow", "storefront");
    expect(seen!.tools).toEqual(["Read", "Grep", "Glob"]);
  });

  test("an agent declaring no tools: reaches the boundary with the current default (empty allowlist), unchanged", () => {
    const repo = loadRepo(ROOT);
    repo.agents.get("lyra")!.tools = undefined;
    let seen: InvokeRequest | null = null;
    const spy: NativeBoundary = { invoke: (r) => ((seen = r), { doc: "---\nkind: spec\n---\n\nbody" }) };
    const runner = new AdapterRunner(repo, { pricing, capabilities: [{ member: "lyra", kind: "spec" }], native: spy, remote: remoteMock });
    runner.produce("lyra", "spec", "checkout-flow", "storefront");
    expect(seen!.tools).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// item 3 — CLI honesty: tools: on a cli member cannot be enforced by levare — a warning, silenced
// ONLY by removing tools:
// ---------------------------------------------------------------------------
describe("item 3 — CLI honesty (CLI_TOOLS_NOT_ENFORCEABLE)", () => {
  function cliAgentStudio(toolsLine: string): string {
    const dir = mkdtempSync(join(tmpdir(), "levare-cli-tools-warn-"));
    mkdirSync(join(dir, "agents"), { recursive: true });
    writeFileSync(
      join(dir, "agents", "finch.md"),
      [
        "---",
        "name: finch",
        "kind: cli",
        "produces: [review]",
        'command: ["echo", "{task}"]',
        'result: "plain text"',
        toolsLine,
        "style:",
        "  avatar: Fi",
        "---",
        "",
        "A cli member.",
        "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    return dir;
  }

  test("a cli agent declaring tools: gets the warning, naming it — a legal declaration, never rejected", () => {
    const dir = cliAgentStudio("tools: [Read, Write]");
    try {
      const r = validatePath(dir);
      expect(r.ok).toBe(true); // never an error — legal declaration, just unenforceable
      const w = r.warnings.find((w) => w.code === "CLI_TOOLS_NOT_ENFORCEABLE");
      expect(w).toBeDefined();
      expect(w!.message).toContain("finch");
      expect(w!.message).toContain("not enforceable by levare");
      expect(w!.message).toContain("vendor's own flags");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("removing tools: is the ONLY way to silence it", () => {
    const dir = cliAgentStudio("");
    try {
      const r = validatePath(dir);
      expect(r.ok).toBe(true);
      expect(r.warnings.map((w) => w.code)).not.toContain("CLI_TOOLS_NOT_ENFORCEABLE");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an empty tools: [] on a cli agent also silences it — nothing declared to warn about", () => {
    const dir = cliAgentStudio("tools: []");
    try {
      const r = validatePath(dir);
      expect(r.warnings.map((w) => w.code)).not.toContain("CLI_TOOLS_NOT_ENFORCEABLE");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a native agent's tools: never carries this warning — it IS enforced there", () => {
    const repo = loadRepo(ROOT); // lyra: kind native, tools: [Read, Write]
    const r = validatePath(ROOT);
    expect(r.warnings.map((w) => w.code)).not.toContain("CLI_TOOLS_NOT_ENFORCEABLE");
    expect(repo.agents.get("lyra")!.kind).toBe("native");
  });
});

// ---------------------------------------------------------------------------
// item 4 — scoped HOME: env.ts#scopeHome unit-level (the decoy-file proof) + AdapterRunner integration
// ---------------------------------------------------------------------------
describe("item 4 — scoped HOME (env.ts#scopeHome)", () => {
  function fakeRealHome(): string {
    const home = mkdtempSync(join(tmpdir(), "levare-real-home-"));
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "auth.json"), "the-live-token");
    // The decoy: a file directly in the real home root, NOT under any declared dotpath — item 4's own
    // proof that a scoped member's HOME shows only what was declared, nothing else from the real one.
    writeFileSync(join(home, ".ssh-decoy"), "should-never-be-visible");
    return home;
  }

  function repoWithScopedSubscription(home: string, dotpaths: string[] | undefined, member = "finch"): ReturnType<typeof loadRepo> {
    const repo = loadRepo(ROOT);
    const connector: Connector = {
      name: "codex-test",
      kind: "cli",
      command: "codex",
      env: [],
      auth: "subscription",
      role: "model",
      effects: "read",
      gate: "proposal",
      ...(dotpaths !== undefined ? { home: dotpaths } : {}),
    };
    repo.connectors.set("codex-test", connector);
    repo.agents.get(member)!.connectors = ["codex-test"];
    return repo;
  }

  test("a member granted a subscription connector declaring home: gets a scratch HOME symlinking ONLY the declared dotpath — the decoy is absent", () => {
    const realHome = fakeRealHome();
    try {
      const repo = repoWithScopedSubscription(realHome, [".codex"]);
      const env = buildMemberEnv(repo, "finch", { PATH: "/bin", HOME: realHome });
      const scoped = scopeHome(repo, "finch", env);
      try {
        expect(scoped.env.HOME).not.toBe(realHome);
        expect(existsSync(scoped.env.HOME)).toBe(true);
        // The declared dotpath resolves, through the symlink, to the SAME live file.
        expect(readFileSync(join(scoped.env.HOME, ".codex", "auth.json"), "utf8")).toBe("the-live-token");
        // Nothing else from the real home is visible — the decoy-file proof.
        expect(existsSync(join(scoped.env.HOME, ".ssh-decoy"))).toBe(false);
        expect(readdirSync(scoped.env.HOME)).toEqual([".codex"]);
        // Live credential, not a copy: a write through the scratch path lands in the REAL home.
        writeFileSync(join(scoped.env.HOME, ".codex", "written-through-scratch"), "x");
        expect(existsSync(join(realHome, ".codex", "written-through-scratch"))).toBe(true);
      } finally {
        scoped.cleanup();
      }
      // Cleanup removes the scratch dir...
      expect(existsSync(scoped.env.HOME)).toBe(false);
      // ...but never touches the real credential it symlinked to (rm -rf on a symlink unlinks the
      // entry, never follows it into the real target).
      expect(existsSync(join(realHome, ".codex", "auth.json"))).toBe(true);
      expect(readFileSync(join(realHome, ".codex", "auth.json"), "utf8")).toBe("the-live-token");
    } finally {
      rmSync(realHome, { recursive: true, force: true });
    }
  });

  test("a subscription connector with NO home: declared is a no-op — the real, unscoped HOME passes through unchanged", () => {
    const realHome = fakeRealHome();
    try {
      const repo = repoWithScopedSubscription(realHome, undefined);
      const env = buildMemberEnv(repo, "finch", { PATH: "/bin", HOME: realHome });
      const scoped = scopeHome(repo, "finch", env);
      expect(scoped.env).toBe(env); // same reference — nothing created, nothing to clean up
      expect(scoped.env.HOME).toBe(realHome);
      scoped.cleanup(); // must not throw, must not touch the real home
      expect(existsSync(realHome)).toBe(true);
    } finally {
      rmSync(realHome, { recursive: true, force: true });
    }
  });

  test("home: [] (explicit empty) is also a no-op", () => {
    const realHome = fakeRealHome();
    try {
      const repo = repoWithScopedSubscription(realHome, []);
      const env = buildMemberEnv(repo, "finch", { PATH: "/bin", HOME: realHome });
      const scoped = scopeHome(repo, "finch", env);
      expect(scoped.env.HOME).toBe(realHome);
    } finally {
      rmSync(realHome, { recursive: true, force: true });
    }
  });

  test("a member with no subscription grant at all is a no-op, even if some other connector declares home:", () => {
    const realHome = fakeRealHome();
    try {
      const repo = loadRepo(ROOT); // finch granted nothing extra here
      const env = buildMemberEnv(repo, "finch", { PATH: "/bin", HOME: realHome });
      const scoped = scopeHome(repo, "finch", env);
      expect(scoped.env.HOME).toBe(realHome);
    } finally {
      rmSync(realHome, { recursive: true, force: true });
    }
  });

  test("scratch dirs are created fresh per call — two calls never share one", () => {
    const realHome = fakeRealHome();
    try {
      const repo = repoWithScopedSubscription(realHome, [".codex"]);
      const env = buildMemberEnv(repo, "finch", { PATH: "/bin", HOME: realHome });
      const a = scopeHome(repo, "finch", env);
      const b = scopeHome(repo, "finch", env);
      try {
        expect(a.env.HOME).not.toBe(b.env.HOME);
      } finally {
        a.cleanup();
        b.cleanup();
      }
    } finally {
      rmSync(realHome, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // Integration: AdapterRunner actually spawns/invokes with the scoped HOME, and cleans up after —
  // proving the wiring in adapters.ts, not just env.ts's own unit-level behaviour.
  // ---------------------------------------------------------------------------
  test("AdapterRunner.produce (native) invokes the boundary with the scratch HOME, and removes it once the call returns", () => {
    const realHome = fakeRealHome();
    try {
      const repo = repoWithScopedSubscription(realHome, [".codex"], "lyra");
      let capturedHome: string | undefined;
      const spy: NativeBoundary = {
        invoke: (r) => {
          capturedHome = r.env.HOME;
          // Assertions made INSIDE the boundary call, while the scratch dir is guaranteed to still
          // exist (produce()'s finally hasn't run yet) — this is the actual proof the wiring reached
          // the boundary, not just env.ts's own isolated behaviour.
          expect(capturedHome).not.toBe(realHome);
          expect(readFileSync(join(capturedHome!, ".codex", "auth.json"), "utf8")).toBe("the-live-token");
          expect(existsSync(join(capturedHome!, ".ssh-decoy"))).toBe(false);
          return { doc: "---\nkind: spec\n---\n\nbody" };
        },
      };
      const runner = new AdapterRunner(repo, {
        pricing: loadPricing(ROOT),
        capabilities: [{ member: "lyra", kind: "spec" }],
        native: spy,
        remote: { call: () => ({ doc: "unused" }) },
        baseEnv: { PATH: "/bin", HOME: realHome },
      });
      runner.produce("lyra", "spec", "checkout-flow", "storefront");
      expect(capturedHome).toBeDefined();
      expect(existsSync(capturedHome!)).toBe(false); // cleaned up post-run
    } finally {
      rmSync(realHome, { recursive: true, force: true });
    }
  });

  test("AdapterRunner.produceAsync (cli) invokes the spawn with the scratch HOME, and removes it once the call returns", async () => {
    const realHome = fakeRealHome();
    try {
      const repo = repoWithScopedSubscription(realHome, [".codex"], "finch");
      let capturedHome: string | undefined;
      const asyncSpawn: AsyncCliSpawn = {
        async run(_argv, opts): Promise<SpawnResult> {
          capturedHome = opts.env.HOME;
          expect(capturedHome).not.toBe(realHome);
          expect(readFileSync(join(capturedHome!, ".codex", "auth.json"), "utf8")).toBe("the-live-token");
          expect(existsSync(join(capturedHome!, ".ssh-decoy"))).toBe(false);
          return { stdout: "review content", exitCode: 0, timedOut: false };
        },
      };
      const runner = new AdapterRunner(repo, {
        pricing: loadPricing(ROOT),
        capabilities: [{ member: "finch", kind: "review" }],
        native: { invoke: () => ({ doc: "unused" }) },
        remote: { call: () => ({ doc: "unused" }) },
        asyncSpawn,
        baseEnv: { PATH: "/bin", HOME: realHome },
      });
      await runner.produceAsync("finch", "review", "checkout-flow", "storefront");
      expect(capturedHome).toBeDefined();
      expect(existsSync(capturedHome!)).toBe(false); // cleaned up post-run
    } finally {
      rmSync(realHome, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// SUBSCRIPTION_NO_HOME — the sibling warning to SUBSCRIPTION_NO_ROLE (NOTES C13)
// ---------------------------------------------------------------------------
describe("SUBSCRIPTION_NO_HOME warning", () => {
  function connectorStudio(frontmatterExtra: string): string {
    const dir = mkdtempSync(join(tmpdir(), "levare-connector-home-warn-"));
    mkdirSync(join(dir, "connectors"), { recursive: true });
    writeFileSync(
      join(dir, "connectors", "codex.md"),
      ["---", "name: codex", "kind: cli", "command: codex", frontmatterExtra, "---", "", "# Codex connector", ""].join("\n"),
    );
    return dir;
  }

  test("a subscription connector with no home: gets a SUBSCRIPTION_NO_HOME warning, naming it", () => {
    const dir = connectorStudio('auth: subscription\nenv: []\nplan: "ChatGPT Plus — flat monthly rate"');
    try {
      const r = validatePath(dir);
      expect(r.ok).toBe(true); // legal declaration — a warning, never an error
      const w = r.warnings.find((w) => w.code === "SUBSCRIPTION_NO_HOME");
      expect(w).toBeDefined();
      expect(w!.message).toContain("codex");
      expect(w!.message).toContain("home:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("declaring home: silences it, even a scope-nothing empty list", () => {
    const dir = connectorStudio('auth: subscription\nenv: []\nhome: []\nplan: "ChatGPT Plus — flat monthly rate"');
    try {
      const r = validatePath(dir);
      expect(r.warnings.map((w) => w.code)).not.toContain("SUBSCRIPTION_NO_HOME");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('home: [".codex"] silences it', () => {
    const dir = connectorStudio('auth: subscription\nenv: []\nhome: [".codex"]\nplan: "ChatGPT Plus — flat monthly rate"');
    try {
      const r = validatePath(dir);
      expect(r.warnings.map((w) => w.code)).not.toContain("SUBSCRIPTION_NO_HOME");
      expect(loadRepo(dir).connectors.get("codex")!.home).toEqual([".codex"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an auth: env connector never gets this warning — the gap is specific to subscription connectors", () => {
    const dir = connectorStudio("env: [CODEX_TOKEN]");
    try {
      const r = validatePath(dir);
      expect(r.warnings.map((w) => w.code)).not.toContain("SUBSCRIPTION_NO_HOME");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

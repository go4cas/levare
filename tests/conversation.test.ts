import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, cpSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendExchange, loadConversationTail, parseConversation, sanitizeScope, conversationPath, STUDIO_SCOPE, TAIL_EXCHANGES } from "../src/conversation.ts";
import { validatePath } from "../src/validate.ts";
import { loadRepo } from "../src/repo.ts";
import { createBoard } from "../src/board/serve.ts";
import { createSdkOrchestratorBoundary } from "../src/orchestrator-boundary.ts";
import type { AsyncSdkTransport } from "../src/sdk-transport.ts";
import type { OrchestratorBoundary, Intent } from "../src/orchestrator.ts";

// NOTES V11-CONV: the Orchestrator conversation persists to files (conversations/<scope>/<YYYY-MM>.md),
// closing the last invariant-2 exception UI10 left open (docs/current-gaps.md's former "Conversation
// persistence" entry). This suite covers the whole loop: the append+commit write path
// (conversation.ts#appendExchange, driven end-to-end through POST /orchestrator/message), the
// validate.ts/loadRepo exemption (item 1 — the trap the goal itself flags as easy to miss), the
// tail-cap read path, month rotation, and "a failed/errored reply is never persisted."

const HERMETIC_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

function git(repoRoot: string, args: string[]): ReturnType<typeof spawnSync> {
  const r = spawnSync(
    "git",
    ["-C", repoRoot, "-c", "user.name=seed", "-c", "user.email=seed@levare.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "init.defaultBranch=main", ...args],
    { encoding: "utf8", env: HERMETIC_ENV },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}${r.stdout}`);
  return r;
}

function seedScratchRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "levare-conv-"));
  cpSync("fixtures/golden", root, { recursive: true });
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "seed golden fixture"]);
  return root;
}

function req(url: string, init?: RequestInit): Request {
  return new Request(`http://localhost${url}`, init);
}

function gitLog1(root: string): { author: string; email: string; subject: string } {
  const out = spawnSync("git", ["-C", root, "log", "-1", "--format=%an|%ae|%s"], { encoding: "utf8" }).stdout.trim();
  const [author, email, ...rest] = out.split("|");
  return { author, email, subject: rest.join("|") };
}

// ---------------------------------------------------------------------------
// conversation.ts unit-level coverage
// ---------------------------------------------------------------------------

describe("sanitizeScope — never trusts the client wholesale", () => {
  test("a normal project-name-shaped string passes through unchanged", () => {
    expect(sanitizeScope("storefront")).toBe("storefront");
  });
  for (const bad of [undefined, null, 123, "", "  ", ".", "..", "a/b", "a\\b", "../../etc"]) {
    test(`rejects ${JSON.stringify(bad)} → falls back to studio scope`, () => {
      expect(sanitizeScope(bad)).toBe(STUDIO_SCOPE);
    });
  }
});

describe("parseConversation — round-trips what appendExchange writes", () => {
  test("a fresh file's two turns parse back with the right speaker, timestamp, and text", () => {
    const root = mkdtempSync(join(tmpdir(), "levare-conv-parse-"));
    try {
      const now = new Date("2026-07-16T14:32:05.000Z");
      appendExchangeRaw(root, STUDIO_SCOPE, "what needs me?", "3 gates are on you.", now);
      const content = readFileSync(conversationPath(root, STUDIO_SCOPE, now), "utf8");
      const turns = parseConversation(content);
      expect(turns.length).toBe(2);
      expect(turns[0]).toEqual({ speaker: "conductor", at: "2026-07-16T14:32:05.000Z", text: "what needs me?" });
      expect(turns[1].speaker).toBe("orchestrator");
      expect(turns[1].text).toBe("3 gates are on you.");
      // The Orchestrator's turn is stamped strictly later than the Conductor's own — file order and
      // timestamp order can never disagree for a future reader.
      expect(new Date(turns[1].at).getTime()).toBeGreaterThan(new Date(turns[0].at).getTime());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the format is pleasant to cat: a title line, then '## speaker · timestamp' headers with a blank line before the text", () => {
    const root = mkdtempSync(join(tmpdir(), "levare-conv-cat-"));
    try {
      const now = new Date("2026-07-16T14:32:05.000Z");
      appendExchangeRaw(root, STUDIO_SCOPE, "hello", "hi there", now);
      const content = readFileSync(conversationPath(root, STUDIO_SCOPE, now), "utf8");
      expect(content.startsWith("# studio — 2026-07\n\n")).toBe(true);
      expect(content).toContain("## conductor · 2026-07-16T14:32:05.000Z\n\nhello\n\n");
      expect(content).toContain("## orchestrator · ");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("appending a second exchange never rewrites earlier bytes — a clean git diff, additive only", () => {
    const root = mkdtempSync(join(tmpdir(), "levare-conv-append-"));
    try {
      const now = new Date("2026-07-16T14:32:05.000Z");
      appendExchangeRaw(root, STUDIO_SCOPE, "first", "first reply", now);
      const before = readFileSync(conversationPath(root, STUDIO_SCOPE, now), "utf8");
      const later = new Date("2026-07-16T15:00:00.000Z");
      appendExchangeRaw(root, STUDIO_SCOPE, "second", "second reply", later);
      const after = readFileSync(conversationPath(root, STUDIO_SCOPE, now), "utf8");
      expect(after.startsWith(before)).toBe(true);
      const turns = parseConversation(after);
      expect(turns.length).toBe(4);
      expect(turns.map((t) => t.text)).toEqual(["first", "first reply", "second", "second reply"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("month rotation — a new month opens a new file", () => {
  test("two exchanges in different months land in two different segments", () => {
    const root = mkdtempSync(join(tmpdir(), "levare-conv-rotate-"));
    try {
      const july = new Date("2026-07-30T23:00:00.000Z");
      const august = new Date("2026-08-01T00:00:00.000Z");
      appendExchangeRaw(root, STUDIO_SCOPE, "july message", "july reply", july);
      appendExchangeRaw(root, STUDIO_SCOPE, "august message", "august reply", august);

      const julyPath = conversationPath(root, STUDIO_SCOPE, july);
      const augustPath = conversationPath(root, STUDIO_SCOPE, august);
      expect(julyPath).not.toBe(augustPath);
      expect(julyPath.endsWith("2026-07.md")).toBe(true);
      expect(augustPath.endsWith("2026-08.md")).toBe(true);
      expect(existsSync(julyPath)).toBe(true);
      expect(existsSync(augustPath)).toBe(true);

      const julyTurns = parseConversation(readFileSync(julyPath, "utf8"));
      expect(julyTurns.map((t) => t.text)).toEqual(["july message", "july reply"]);
      const augustTurns = parseConversation(readFileSync(augustPath, "utf8"));
      expect(augustTurns.map((t) => t.text)).toEqual(["august message", "august reply"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("tail cap — loadConversationTail never returns more than the configured window", () => {
  test(`with ${TAIL_EXCHANGES + 5} exchanges on disk, only the last ${TAIL_EXCHANGES} render`, () => {
    const root = mkdtempSync(join(tmpdir(), "levare-conv-tail-"));
    try {
      const base = new Date("2026-07-01T00:00:00.000Z");
      for (let i = 0; i < TAIL_EXCHANGES + 5; i++) {
        appendExchangeRaw(root, STUDIO_SCOPE, `msg ${i}`, `reply ${i}`, new Date(base.getTime() + i * 60000));
      }
      const tail = loadConversationTail(root, STUDIO_SCOPE, new Date(base.getTime() + (TAIL_EXCHANGES + 5) * 60000));
      expect(tail.length).toBe(TAIL_EXCHANGES * 2);
      // The tail is the MOST RECENT exchanges — the earliest surviving message is exchange index 5.
      expect(tail[0].text).toBe("msg 5");
      expect(tail[tail.length - 1].text).toBe(`reply ${TAIL_EXCHANGES + 4}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("no conversation file yet → empty history, not an error", () => {
    const root = mkdtempSync(join(tmpdir(), "levare-conv-empty-"));
    try {
      expect(loadConversationTail(root, STUDIO_SCOPE, new Date())).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// A raw, no-git-repo-required helper for the pure conversation.ts tests above — `appendExchange`
// itself always calls into `transactionalWrite`/`runnerCommit`, which need a real git repo; the tests
// in this block only care about the FILE content it produces, not the commit, so they seed a minimal
// git repo once and reuse `appendExchange` directly rather than hand-rolling file writes that could
// drift from the real format.
function appendExchangeRaw(root: string, scope: string, conductorText: string, orchestratorText: string, now: Date): void {
  if (!existsSync(join(root, ".git"))) {
    git(root, ["init", "-q"]);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, ".gitkeep"), "");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "seed"]);
  }
  const result = appendExchange(root, scope, conductorText, orchestratorText, now);
  if (!result.ok) throw new Error(`appendExchange failed: ${result.error}`);
}

// ---------------------------------------------------------------------------
// Item 1 — validate.ts / loadRepo must never choke on, or even see, conversations/
// ---------------------------------------------------------------------------

describe("validate.ts and loadRepo — conversations/ is invisible to both (NOTES V11-CONV item 1)", () => {
  test("a studio with conversation files under conversations/<scope>/<month>.md validates clean", () => {
    const root = seedScratchRepo();
    try {
      const now = new Date("2026-07-16T14:32:05.000Z");
      appendExchangeRaw(root, "storefront", "what needs me?", "3 gates are on you.", now);
      appendExchangeRaw(root, STUDIO_SCOPE, "hello", "hi", now);
      const result = validatePath(root);
      expect(result.ok).toBe(true);
      expect(result.errors).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a MALFORMED conversation file (no frontmatter, arbitrary prose) still validates clean — it is never classified as an entity", () => {
    const root = seedScratchRepo();
    try {
      const dir = join(root, "conversations", "storefront");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "2026-07.md"), "not even a turn block, just prose\nand more prose\n");
      const result = validatePath(root);
      expect(result.ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("loadRepo never reads conversations/ — a repo with conversation files loads byte-identical to one without", () => {
    const root = seedScratchRepo();
    try {
      const before = loadRepo(root);
      appendExchangeRaw(root, "storefront", "what needs me?", "3 gates are on you.", new Date("2026-07-16T14:32:05.000Z"));
      const after = loadRepo(root);
      expect(JSON.stringify(after.projects)).toBe(JSON.stringify(before.projects));
      expect(JSON.stringify(after.units)).toBe(JSON.stringify(before.units));
      expect(JSON.stringify(after.artifacts)).toBe(JSON.stringify(before.artifacts));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The write path, end to end through POST /orchestrator/message
// ---------------------------------------------------------------------------

function fakeBoundary(reply: string): OrchestratorBoundary {
  return {
    async interpret(text: string): Promise<Intent> {
      return { kind: "unknown", text };
    },
    async narrate(prompt: string): Promise<string> {
      return prompt;
    },
    async converse(): Promise<string> {
      return reply;
    },
  };
}

describe("POST /orchestrator/message — persists the completed exchange (NOTES V11-CONV item 2)", () => {
  test("a successful exchange lands in conversations/<scope>/<YYYY-MM>.md and git log -1 shows a levare-runner commit touching it", async () => {
    const root = seedScratchRepo();
    const board = createBoard(root, { orchestratorBoundary: fakeBoundary("3 gates are on you.") });
    try {
      const res = await board.fetch(
        req("/orchestrator/message", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "what needs me?", scope: "storefront" }),
        }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.reply).toBe("3 gates are on you.");

      const monthKey = new Date().toISOString().slice(0, 7);
      const filePath = join(root, "conversations", "storefront", `${monthKey}.md`);
      expect(existsSync(filePath)).toBe(true);
      const turns = parseConversation(readFileSync(filePath, "utf8"));
      expect(turns.length).toBe(2);
      expect(turns[0]).toMatchObject({ speaker: "conductor", text: "what needs me?" });
      expect(turns[1]).toMatchObject({ speaker: "orchestrator", text: "3 gates are on you." });

      const log = gitLog1(root);
      expect(log.author).toBe("levare-runner");
      expect(log.email).toBe("runner@levare.local");
      expect(log.subject).toContain("storefront");

      const show = spawnSync("git", ["-C", root, "show", "--stat", "-1", "--format="], { encoding: "utf8" }).stdout;
      expect(show).toContain(`conversations/storefront/${monthKey}.md`);
    } finally {
      board.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("no scope in the request body → falls back to the studio scope", async () => {
    const root = seedScratchRepo();
    const board = createBoard(root, { orchestratorBoundary: fakeBoundary("hi there") });
    try {
      const res = await board.fetch(
        req("/orchestrator/message", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "hello" }),
        }),
      );
      expect(res.status).toBe(200);
      const monthKey = new Date().toISOString().slice(0, 7);
      expect(existsSync(join(root, "conversations", "studio", `${monthKey}.md`))).toBe(true);
    } finally {
      board.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("two exchanges commit twice — one commit per completed exchange, not one per turn", async () => {
    const root = seedScratchRepo();
    const board = createBoard(root, { orchestratorBoundary: fakeBoundary("reply") });
    try {
      const before = spawnSync("git", ["-C", root, "rev-list", "--count", "HEAD"], { encoding: "utf8" }).stdout.trim();
      await board.fetch(req("/orchestrator/message", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "one", scope: "studio" }) }));
      await board.fetch(req("/orchestrator/message", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "two", scope: "studio" }) }));
      const after = spawnSync("git", ["-C", root, "rev-list", "--count", "HEAD"], { encoding: "utf8" }).stdout.trim();
      expect(Number(after) - Number(before)).toBe(2);
    } finally {
      board.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("POST /orchestrator/message — a failed or errored reply is never persisted (NOTES V11-CONV)", () => {
  test("the disabled-boundary 503 path writes no conversation file and makes no commit", async () => {
    const root = seedScratchRepo();
    const board = createBoard(root);
    try {
      const before = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
      const res = await board.fetch(
        req("/orchestrator/message", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "what needs me?", scope: "storefront" }),
        }),
      );
      expect(res.status).toBe(503);
      const after = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
      expect(after).toBe(before);
      expect(existsSync(join(root, "conversations"))).toBe(false);
    } finally {
      board.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a broken SDK transport (502) writes no conversation file and makes no commit", async () => {
    const root = seedScratchRepo();
    const brokenTransport: AsyncSdkTransport = {
      async run() {
        return { ok: false, error: "Native CLI binary for darwin-arm64 not found" };
      },
    };
    const brokenBoundary = createSdkOrchestratorBoundary({ transport: brokenTransport, env: { ANTHROPIC_API_KEY: "sk-ant-test-not-real" } });
    const board = createBoard(root, { orchestratorBoundary: brokenBoundary });
    try {
      const before = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
      const res = await board.fetch(
        req("/orchestrator/message", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "stats", scope: "storefront" }),
        }),
      );
      expect(res.status).toBe(502);
      const after = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
      expect(after).toBe(before);
      expect(existsSync(join(root, "conversations"))).toBe(false);
    } finally {
      board.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The read path — mount / restart renders the persisted tail
// ---------------------------------------------------------------------------

describe("the read path — a fresh page render shows the persisted tail (NOTES V11-CONV item 3)", () => {
  test("a restart test: history written to disk by a PRIOR process (simulated: written directly, no live board) renders on the very next GET, from a brand-new board instance", async () => {
    const root = seedScratchRepo();
    try {
      const now = new Date();
      appendExchangeRaw(root, "storefront", "what needs me?", "3 gates are on you, restart-proof.", now);

      // A brand-new board — nothing in memory carries over from the write above; the only way this
      // text can appear is if the GET handler re-reads the file from disk (PRD §9, invariant 2).
      const board = createBoard(root);
      try {
        const res = await board.fetch(req("/project/storefront"));
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain("what needs me?");
        expect(html).toContain("3 gates are on you, restart-proof.");
        expect(html).toContain('data-scope="storefront"');
      } finally {
        board.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the studio screen (studio scope) does not show a project-scoped conversation, and vice versa", async () => {
    const root = seedScratchRepo();
    try {
      const now = new Date();
      appendExchangeRaw(root, "storefront", "storefront-only question", "storefront-only reply", now);
      const board = createBoard(root);
      try {
        const studioHtml = await (await board.fetch(req("/studio"))).text();
        expect(studioHtml).not.toContain("storefront-only question");
        const projectHtml = await (await board.fetch(req("/project/storefront"))).text();
        expect(projectHtml).toContain("storefront-only question");
      } finally {
        board.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a tail-cap test at the render layer: only the last N exchanges appear in the rendered HTML", async () => {
    const root = seedScratchRepo();
    try {
      const base = new Date();
      for (let i = 0; i < TAIL_EXCHANGES + 3; i++) {
        appendExchangeRaw(root, "storefront", `q${i}`, `a${i}`, new Date(base.getTime() + i * 1000));
      }
      const board = createBoard(root);
      try {
        const html = await (await board.fetch(req("/project/storefront"))).text();
        expect(html).not.toContain(">q0<");
        expect(html).not.toContain(">q2<");
        expect(html).toContain(`>q${TAIL_EXCHANGES + 2}<`);
      } finally {
        board.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Client-nav scope-change fragment plumbing (extractFragment's new fields)
// ---------------------------------------------------------------------------

describe("fragment response carries scope + orchTail for client-nav resync", () => {
  test("a fragment GET for a project page reports that project's own scope and its persisted tail", async () => {
    const root = seedScratchRepo();
    try {
      appendExchangeRaw(root, "storefront", "fragment question", "fragment reply", new Date());
      const board = createBoard(root);
      try {
        const res = await board.fetch(req("/project/storefront", { headers: { "X-Levare-Fragment": "1" } }));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.ok).toBe(true);
        expect(body.scope).toBe("storefront");
        expect(body.orchTail).toContain("fragment question");
        expect(body.orchTail).toContain("fragment reply");
      } finally {
        board.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

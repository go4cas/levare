// Finding 90: `cas` (levare's own `commitAs` identity) and the operator's own git identity render as
// two different actors, with no way for a reader to know they're the same human. `resolveGitActor`
// (timeline.ts) is the fix — an exhaustive classifier over every identity shape the app itself
// produces, plus an optional studio-declared human identity for the Conductor. It unifies the PERSON
// (same `kind`/avatar) without ever rewriting `name` — a first version of this fix rewrote the
// displayed author to the declared name, which silently relabeled a hand-committed edit as if it were
// levare's own `commitAs` output (live-verification catch, not caught by the tests before it). No
// dedicated test file existed for timeline.ts before this goal.

import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { assertSpawnOk } from "./spawn-helpers.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGitActor, gitLogRows, buildTimeline } from "../src/timeline.ts";
import { loadStudioSettings } from "../src/repo.ts";
import { CONDUCTOR_NAME, CONDUCTOR_EMAIL, RUNNER_NAME, RUNNER_EMAIL } from "../src/git.ts";
import { workBranchName } from "../src/merge.ts";
import { timelineDirectTag } from "../src/board/render/run.ts";

const HERMETIC_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" };

function git(root: string, args: string[]): string {
  const r = spawnSync("git", ["-C", root, "-c", "user.name=seed", "-c", "user.email=seed@levare.test", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], {
    encoding: "utf8",
    env: HERMETIC_ENV,
  });
  assertSpawnOk(`git ${args.join(" ")}`, r);
  return r.stdout;
}

function commitAs(root: string, name: string, email: string, message: string): void {
  writeFileSync(join(root, "work", "acme", "widget-1", `note-${name}.txt`), "x\n");
  spawnSync("git", ["-C", root, "-c", `user.name=${name}`, "-c", `user.email=${email}`, "-c", "commit.gpgsign=false", "add", "-A"], { encoding: "utf8", env: HERMETIC_ENV });
  const r = spawnSync("git", ["-C", root, "-c", `user.name=${name}`, "-c", `user.email=${email}`, "-c", "commit.gpgsign=false", "commit", "-q", "-m", message], { encoding: "utf8", env: HERMETIC_ENV });
  assertSpawnOk(`git commit as ${name}`, r);
}

function writeFile(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

function rmrf(p: string): void {
  rmSync(p, { recursive: true, force: true });
}

const DECLARED = { name: "go4cas", email: "go4cas@gmail.com" };

describe("resolveGitActor: Finding 90 exhaustive classification", () => {
  test("CONDUCTOR_EMAIL, no declared identity → conductor, raw name, stamped", () => {
    expect(resolveGitActor(CONDUCTOR_NAME, CONDUCTOR_EMAIL)).toEqual({ kind: "conductor", name: CONDUCTOR_NAME, stamped: true });
  });

  test("CONDUCTOR_EMAIL WITH a declared identity → still conductor/stamped, but `name` stays the raw git author, never the declared one", () => {
    expect(resolveGitActor(CONDUCTOR_NAME, CONDUCTOR_EMAIL, DECLARED)).toEqual({ kind: "conductor", name: CONDUCTOR_NAME, stamped: true });
  });

  test("the declared identity's own email (a direct hand-commit) → conductor/unstamped, `name` is the operator's own raw git author", () => {
    expect(resolveGitActor(DECLARED.name, DECLARED.email, DECLARED)).toEqual({ kind: "conductor", name: DECLARED.name, stamped: false });
  });

  test("RUNNER_EMAIL → runner, never unified with anything", () => {
    expect(resolveGitActor(RUNNER_NAME, RUNNER_EMAIL, DECLARED)).toEqual({ kind: "runner", name: RUNNER_NAME });
  });

  test("a memberIdentity-shaped commit (<name>@levare.local) → member, confirming Finding 90's own broadened scope", () => {
    expect(resolveGitActor("alex", "alex@levare.local")).toEqual({ kind: "member", name: "alex" });
  });

  test("an unrecognized human identity, with no declaration → unknown", () => {
    expect(resolveGitActor("random-dev", "random-dev@example.com")).toEqual({ kind: "unknown", name: "random-dev" });
  });

  test("an unrecognized human identity, even WITH a declaration for someone else → still unknown, never swept in", () => {
    expect(resolveGitActor("random-dev", "random-dev@example.com", DECLARED)).toEqual({ kind: "unknown", name: "random-dev" });
  });
});

describe("gitLogRows: Finding 90 identity resolution end-to-end", () => {
  test("an app-mediated (cas) commit and the operator's own direct commit unify to one PERSON (same kind) once declared, while `name`/text keep showing exactly what git recorded, and `stamped` still tells them apart", () => {
    const root = mkdtempSync(join(tmpdir(), "levare-tl90-studio-"));
    try {
      git(root, ["init", "-q"]);
      const unitDir = join(root, "work", "acme", "widget-1");
      writeFile(join(unitDir, "unit.md"), "# widget-1\n");
      git(root, ["add", "-A"]);
      git(root, ["commit", "-q", "-m", "open widget-1"]);

      commitAs(root, CONDUCTOR_NAME, CONDUCTOR_EMAIL, "approved via the board");
      commitAs(root, DECLARED.name, DECLARED.email, "hand-edited directly");

      // Without a declared identity: the direct hand-edit falls to "unknown" — Finding 90's own bug.
      const undeclared = gitLogRows(root, unitDir);
      const stampedRow = undeclared.find((r) => r.text.includes("approved via the board"))!;
      const directRow = undeclared.find((r) => r.text.includes("hand-edited directly"))!;
      expect(stampedRow.actor).toEqual({ kind: "conductor", name: CONDUCTOR_NAME, stamped: true });
      expect(directRow.actor.kind).toBe("unknown");

      // With the identity declared: both resolve to the SAME kind (one person, one avatar)...
      const declared = gitLogRows(root, unitDir, DECLARED);
      const stampedRow2 = declared.find((r) => r.text.includes("approved via the board"))!;
      const directRow2 = declared.find((r) => r.text.includes("hand-edited directly"))!;
      expect(stampedRow2.actor.kind).toBe("conductor");
      expect(directRow2.actor.kind).toBe("conductor");
      // ...but the raw git author is NEVER rewritten — the row text still says exactly what git
      // recorded, "cas" for the app-mediated commit and "go4cas" for the direct one.
      expect(stampedRow2.actor.name).toBe(CONDUCTOR_NAME);
      expect(stampedRow2.text).toContain(`<span class="who">${CONDUCTOR_NAME}</span>`);
      expect(directRow2.actor.name).toBe(DECLARED.name);
      expect(directRow2.text).toContain(`<span class="who">${DECLARED.name}</span>`);
      // ...and `stamped` still tells them apart: one went through levare's own commitAs, one didn't.
      expect(stampedRow2.actor.stamped).toBe(true);
      expect(directRow2.actor.stamped).toBe(false);
    } finally {
      rmrf(root);
    }
  });
});

describe("timelineDirectTag: Finding 90's visible provenance marker (live-verification fix)", () => {
  test("a direct (unstamped) conductor commit gets the visible tag", () => {
    expect(timelineDirectTag({ kind: "conductor", name: "go4cas", stamped: false })).toContain(">direct<");
  });

  test("an app-mediated (stamped) conductor commit — the ordinary case — stays unmarked", () => {
    expect(timelineDirectTag({ kind: "conductor", name: "cas", stamped: true })).toBe("");
  });

  test("no tag outside kind: conductor, even if stamped happened to be false", () => {
    expect(timelineDirectTag({ kind: "member", name: "alex" })).toBe("");
    expect(timelineDirectTag({ kind: "unknown", name: "random-dev" })).toBe("");
  });

  test("wording is neutral (\"direct\"), not judgmental (\"unverified\"/\"manual\") — a hand edit is ordinary, not irregular", () => {
    const tag = timelineDirectTag({ kind: "conductor", name: "go4cas", stamped: false });
    expect(tag).not.toMatch(/unverified|manual|invalid|suspicious/i);
  });
});

describe("loadStudioSettings: Finding 90 declaration parsing", () => {
  test("a declared conductor_git_identity block round-trips", () => {
    const root = mkdtempSync(join(tmpdir(), "levare-tl90-settings-"));
    try {
      writeFile(join(root, "studio.md"), ["---", "conductor_git_identity:", "  name: go4cas", "  email: go4cas@gmail.com", "---", ""].join("\n"));
      expect(loadStudioSettings(root).conductorGitIdentity).toEqual(DECLARED);
    } finally {
      rmrf(root);
    }
  });

  test("no declaration → undefined, exactly as before this field existed", () => {
    const root = mkdtempSync(join(tmpdir(), "levare-tl90-settings-"));
    try {
      writeFile(join(root, "studio.md"), ["---", "orchestrator_model: claude-sonnet-5", "---", ""].join("\n"));
      expect(loadStudioSettings(root).conductorGitIdentity).toBeUndefined();
    } finally {
      rmrf(root);
    }
  });
});

// Findings 86/89 (RELEASE R3): the project repo as a second timeline source. `buildTimeline` now
// returns `{ rows, unavailable? }` rather than a bare array — `unavailable` is set exactly when the
// project source could not be read at all (no usable `repo:`, or the work branch doesn't exist yet),
// never when it was read and simply came back empty.
describe("buildTimeline: the project repo as a second git source (Findings 86/89)", () => {
  function writeLedgerLine(unitDir: string, member: string, ts: string): void {
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(join(unitDir, "ledger.ndjson"), `${JSON.stringify({ ts, member, event: "produce", kind: "spec" })}\n`, { flag: "a" });
  }

  /** A real, local project repo — `default_branch` = "main" — with one committed file. */
  function makeProjectRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "levare-tl-proj-"));
    git(dir, ["-c", "init.defaultBranch=main", "init", "-q"]);
    writeFileSync(join(dir, "README.md"), "hello\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "initial"]);
    return dir;
  }

  /** A commit on `branch` with an explicit author/committer date, so ordering across sources can be
   * asserted precisely rather than relying on wall-clock timing. */
  function commitDated(repo: string, branch: string, message: string, isoDate: string): void {
    spawnSync("git", ["-C", repo, "checkout", "-q", branch], { encoding: "utf8", env: HERMETIC_ENV });
    writeFileSync(join(repo, `${message.replace(/\W+/g, "-")}.txt`), "x\n");
    const env = {
      ...HERMETIC_ENV,
      GIT_AUTHOR_NAME: "member",
      GIT_AUTHOR_EMAIL: "member@levare.local",
      GIT_COMMITTER_NAME: "member",
      GIT_COMMITTER_EMAIL: "member@levare.local",
      GIT_AUTHOR_DATE: isoDate,
      GIT_COMMITTER_DATE: isoDate,
    };
    spawnSync("git", ["-C", repo, "add", "-A"], { encoding: "utf8", env });
    const r = spawnSync("git", ["-C", repo, "-c", "commit.gpgsign=false", "commit", "-q", "-m", message], { encoding: "utf8", env });
    assertSpawnOk(`git commit ${message}`, r);
    spawnSync("git", ["-C", repo, "checkout", "-q", "main"], { encoding: "utf8", env: HERMETIC_ENV });
  }

  test("project commits interleave with studio rows in correct time order", () => {
    const studio = mkdtempSync(join(tmpdir(), "levare-tl-studio-"));
    const projectRepo = makeProjectRepo();
    try {
      const unitDir = join(studio, "work", "acme", "widget-1");
      writeLedgerLine(unitDir, "lyra", "2024-01-01T10:00:00.000Z");

      const branch = workBranchName("widget-1");
      git(projectRepo, ["branch", branch, "main"]);
      commitDated(projectRepo, branch, "earliest project commit", "2024-01-01T09:00:00+00:00");
      commitDated(projectRepo, branch, "latest project commit", "2024-01-01T11:00:00+00:00");

      const result = buildTimeline(studio, { dir: unitDir, unit: "widget-1" }, { repo: projectRepo, default_branch: "main" });

      expect(result.unavailable).toBeUndefined();
      expect(result.rows.map((r) => r.text)).toEqual([expect.stringContaining("earliest project commit"), expect.stringContaining("lyra"), expect.stringContaining("latest project commit")]);
    } finally {
      rmrf(studio);
      rmrf(projectRepo);
    }
  });

  test("no repo: declared → today's rows plus that reason, never an empty project section", () => {
    const studio = mkdtempSync(join(tmpdir(), "levare-tl-studio-"));
    try {
      const unitDir = join(studio, "work", "acme", "widget-1");
      writeLedgerLine(unitDir, "lyra", "2024-01-01T10:00:00.000Z");

      const result = buildTimeline(studio, { dir: unitDir, unit: "widget-1" }, { repo: "", default_branch: "main" });

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.text).toContain("lyra");
      expect(result.unavailable).toBeDefined();
      expect(result.unavailable).toMatch(/repo/i);
    } finally {
      rmrf(studio);
    }
  });

  test("a resolvable repo with a missing work branch → today's rows plus that reason, never an empty project section", () => {
    const studio = mkdtempSync(join(tmpdir(), "levare-tl-studio-"));
    const projectRepo = makeProjectRepo();
    try {
      const unitDir = join(studio, "work", "acme", "widget-1");
      writeLedgerLine(unitDir, "lyra", "2024-01-01T10:00:00.000Z");

      // Deliberately never create `levare/widget-1` on projectRepo.
      const result = buildTimeline(studio, { dir: unitDir, unit: "widget-1" }, { repo: projectRepo, default_branch: "main" });

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.text).toContain("lyra");
      expect(result.unavailable).toBeDefined();
      expect(result.unavailable).toContain(workBranchName("widget-1"));
    } finally {
      rmrf(studio);
      rmrf(projectRepo);
    }
  });

  test("mixed-offset timestamps sort by instant, not by string", () => {
    const studio = mkdtempSync(join(tmpdir(), "levare-tl-studio-"));
    try {
      const unitDir = join(studio, "work", "acme", "widget-1");
      // Lexicographically "T09" > "T08", but +02:00 puts this instant an hour BEFORE the +00:00 one
      // (07:00Z vs 08:00Z) — a plain string sort gets this backwards; only an instant-aware sort
      // (Date.parse) gets it right. Nothing pins TZ in this env, so this reproduces even locally.
      writeLedgerLine(unitDir, "later-by-string-earlier-by-instant", "2024-06-01T09:00:00+02:00");
      writeLedgerLine(unitDir, "earlier-by-string-later-by-instant", "2024-06-01T08:00:00+00:00");

      const result = buildTimeline(studio, { dir: unitDir, unit: "widget-1" }, { repo: "", default_branch: "main" });

      expect(result.rows.map((r) => r.actor.name)).toEqual(["later-by-string-earlier-by-instant", "earlier-by-string-later-by-instant"]);
    } finally {
      rmrf(studio);
    }
  });
});

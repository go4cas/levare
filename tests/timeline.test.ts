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
import { resolveGitActor, gitLogRows } from "../src/timeline.ts";
import { loadStudioSettings } from "../src/repo.ts";
import { CONDUCTOR_NAME, CONDUCTOR_EMAIL, RUNNER_NAME, RUNNER_EMAIL } from "../src/git.ts";
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

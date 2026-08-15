// docs/guide/04-workflow's fenced `cat > … <<'EOF'` blocks are pasted verbatim by a reader building
// a real studio — they are executable content, not prose, and a prose-only review of the chapter
// text can't catch a block that the real parser rejects (this is exactly how the codex connector's
// broken multi-line `scope:` shipped once already — see docs/current-gaps.md, NOTES DOCS-WALKTHROUGH-1).
//
// This test replays every such block, in document order, into a scratch studio scaffolded the same
// way `2 · Quickstart`'s `levare init .` leaves one — the guide's own stated precondition (see
// 04-workflow/README.md's "Before you start") — and runs the REAL frontmatter parser and validator
// (not a mock) after each paste, the same way a reader running `levare validate .` after every step
// would. A chapter that shows no output after a block is expected to validate clean with zero
// warnings; where a chapter documents a warning explicitly, it's asserted here too, so this test
// breaks the moment prose and reality drift apart again.

import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { scaffoldStudio, initStudio } from "../src/init.ts";
import { validatePath } from "../src/validate.ts";

const HEREDOC_RE = /cat > (\S+) <<'EOF'\n([\s\S]*?)\nEOF/g;

function extractHeredocs(src: string): Array<{ path: string; body: string }> {
  const out: Array<{ path: string; body: string }> = [];
  let m: RegExpExecArray | null;
  HEREDOC_RE.lastIndex = 0;
  while ((m = HEREDOC_RE.exec(src))) {
    out.push({ path: m[1], body: m[2] });
  }
  return out;
}

const GUIDE_DIR = "docs/guide/04-workflow";

// Reading order a reader actually follows — README's precondition setup, then 4.1 through 4.8.
const CHAPTERS = [
  "README.md",
  "01-capture-an-idea.md",
  "02-promote-to-a-project.md",
  "03-first-team-and-member.md",
  "04-first-gate.md",
  "05-foreign-agent.md",
  "06-first-loop.md",
  "07-the-daemon.md",
  "08-when-a-member-fails.md",
];

describe("docs/guide/04-workflow's pasteable blocks produce a valid studio", () => {
  const root = mkdtempSync(join(tmpdir(), "levare-guide-blocks-"));
  // What `2 · Quickstart`'s `levare init .` leaves behind — the walkthrough's own stated starting point.
  scaffoldStudio(root);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  for (const chapter of CHAPTERS) {
    const src = readFileSync(join(GUIDE_DIR, chapter), "utf8");
    const blocks = extractHeredocs(src);
    for (const { path, body } of blocks) {
      test(`${chapter} → ${path} parses and validates clean`, () => {
        const full = join(root, path);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, body + "\n");

        const r = validatePath(root);
        if (!r.ok) {
          const detail = r.errors
            .map((e) => `  ${e.code} ${e.file}${e.line ? ":" + e.line : ""} — ${e.message}`)
            .join("\n");
          throw new Error(`after pasting ${chapter}'s ${path} block, \`levare validate\` fails:\n${detail}`);
        }
        expect(r.errors).toEqual([]);
        // A chapter's own narration is the source of truth for which warnings a reader should expect
        // at this point — SUBSCRIPTION_NO_ROLE/SUBSCRIPTION_NO_HOME are the two this suite exists to
        // guard, since both were silently absent from a heredoc the chapter never flagged as warning.
        const codes = r.warnings.map((w) => w.code);
        expect(codes).not.toContain("SUBSCRIPTION_NO_ROLE");
        expect(codes).not.toContain("SUBSCRIPTION_NO_HOME");
      });
    }
  }

  // Fault 1 (NOTES RAIL-UNREACHABLE): the finished studio is, byte for byte, the scenario that
  // motivated the fix — `add-command` (type `feature`, expecting product-brief/design/spec/code/
  // review) is pinned to `team: press`, and 4.6's press only ever grows to `produces: [product-brief,
  // review]` with members scribe (product-brief) and corvid (review). design/spec/code are genuinely
  // uncoverable by this studio as the guide leaves it — a legitimate configuration for a walkthrough
  // that never asked the reader to build a design/spec/code-producing member, but one `levare
  // validate` should name rather than stay silent about (see validate.ts#validateUncoverableExpectedKinds).
  test("the finished studio validates with zero warnings, other than the one this branch intentionally added", () => {
    const r = validatePath(root);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([
      {
        code: "UNCOVERABLE_EXPECTED_KIND",
        message:
          "unit 'add-command' (type 'feature') expects kind(s) [design, spec, code], but no member of its responsible team (press) declares producing any of them — this may be a legitimate configuration (a unit that only ever needs part of its type's shape), but the board's score rail will show these stage(s) as not covered, never as merely queued",
        file: join(root, "work", "todo-cli", "add-command", "unit.md"),
      },
    ]);
  });
});

// NOTES DOCS-WALKTHROUGH-2: `work/` vanished on clone before this fix — git never tracks an empty
// directory, and the scaffold's own README overstated the layout (it marked work/, alongside
// evals/ and ideas/, as merely "created on first use", when work/ is where the job actually happens).
// This drives a REAL `git init` + founding commit, then a REAL `git clone` into a second directory —
// the only way to prove a directory is actually tracked, not just present before the first commit —
// and asserts work/ (with its tracked .gitkeep) survives while evals/ and ideas/, genuinely
// empty-until-used, do not.
describe("a freshly-initialized studio's work/ survives a clone (NOTES DOCS-WALKTHROUGH-2)", () => {
  test("git clone of a freshly-`levare init`'d studio keeps work/, but not the still-empty evals/ or ideas/", () => {
    const source = mkdtempSync(join(tmpdir(), "levare-clone-src-"));
    const clone = mkdtempSync(join(tmpdir(), "levare-clone-dst-"));
    const configFile = join(tmpdir(), `levare-clone-gitconfig-${Math.random().toString(36).slice(2)}`);
    try {
      // NOTES "dubious clone ownership": v0.2.5's tag sat unpublished for an hour on this exact line
      // (`git clone` exit 128, "fatal: detected dubious ownership") — confirmed by direct repro (a
      // root-owned local repo, this exact env shape: GIT_CONFIG_SYSTEM discarded, GIT_CONFIG_GLOBAL
      // pointed at a config with no safe.directory entry) to be git's real, well-known
      // ownership-mismatch refusal, not a coincidentally-matching different failure.
      // `GIT_CONFIG_SYSTEM: "/dev/null"` is deliberate hermeticity (this test must not depend on
      // whatever the ambient environment's system gitconfig happens to contain) — but that SAME
      // discard also throws away any `safe.directory` entry the ambient environment (a CI runner
      // image, actions/checkout, a contributor's own machine) may have been relying on to cover this
      // test's own scratch paths, which is exactly what makes the ownership check's actual verdict
      // depend on runner-specific provisioning this test never controls — "environmental either way,
      // stable in neither": passed on CI's own run of this exact commit, failed on Release's, two
      // minutes apart, nothing in either workflow's own steps differs up to this point. Declaring
      // these paths safe IN THIS TEST'S OWN CONFIG closes that gap the same way the rest of this file
      // already discards ambient config for identity: hermetic all the way, dependent on nothing
      // inherited, regardless of the exact runner-instance condition that tips the ambient check.
      //
      // The `.git`-suffixed form is load-bearing, confirmed by direct repro — NOT the working-tree
      // root a plain `git config --add safe.directory <path>` example usually shows and what a first
      // attempt at this fix used, which still failed identically: `git clone` of a local path opens
      // the SOURCE via its `.git` directory directly (the same code path a bare/object-store access
      // takes), checking ITS ownership — distinct from every other git.ts command in this codebase,
      // which uses `-C <root>` against the WORKING TREE root and needs no such entry at all (confirmed
      // by the fact that only this clone line was ever reported failing, never `initStudio`'s own
      // `git -C source init/add/commit` calls immediately above it, against the identical directory).
      writeFileSync(
        configFile,
        `[user]\n\tname = Clone Test\n\temail = clone@example.com\n[safe]\n\tdirectory = ${join(source, ".git")}\n\tdirectory = ${join(clone, ".git")}\n`,
      );
      const env = { ...process.env, GIT_CONFIG_GLOBAL: configFile, GIT_CONFIG_SYSTEM: "/dev/null" };

      const result = initStudio(source, env);
      expect(result.git.committed).toBe(true);

      rmSync(clone, { recursive: true, force: true }); // git clone requires the target not exist yet
      const cloneResult = spawnSync("git", ["clone", "-q", source, clone], { encoding: "utf8", env });
      // NOTES "dubious clone ownership" / the eighth instance of a test whose result depended on
      // something other than the behaviour it asserts: a bare `expect(status).toBe(0)` discarded git's
      // own stderr, so this exact failure cost a screenshot and an hour to even name, on a run whose
      // logs are already gone by the time anyone can look. Every failure path below states what
      // actually happened.
      if (cloneResult.status !== 0) {
        throw new Error(
          `git clone exited ${cloneResult.status ?? "null"}` +
            `${cloneResult.signal ? ` (signal ${cloneResult.signal})` : ""}: ${cloneResult.stderr || "(no stderr captured)"}`,
        );
      }

      expect(readdirSync(join(clone, "work"))).toEqual([".gitkeep"]);
      expect(() => readdirSync(join(clone, "evals"))).toThrow();
      expect(() => readdirSync(join(clone, "ideas"))).toThrow();
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(clone, { recursive: true, force: true });
      rmSync(configFile, { force: true });
    }
  });
});

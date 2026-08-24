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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
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
  //
  // Finding 75 (part 1, 2026-08-24): every kind: native member the walkthrough builds (lyra, scribe,
  // wren) now also carries its own SANDBOX_NOT_WRAPPED warning — a genuinely new, intentional telling
  // this branch adds, not drift; see validate.ts#validateAgentNativeSandboxWarning's own doc.
  test("the finished studio validates with zero warnings, other than the ones intentionally added (UNCOVERABLE_EXPECTED_KIND + SANDBOX_NOT_WRAPPED per native member)", () => {
    const r = validatePath(root);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    const sandboxWarnings = r.warnings.filter((w) => w.code === "SANDBOX_NOT_WRAPPED");
    const otherWarnings = r.warnings.filter((w) => w.code !== "SANDBOX_NOT_WRAPPED");
    expect(sandboxWarnings.map((w) => w.message.match(/agent '(\w+)'/)?.[1]).sort()).toEqual(["lyra", "scribe", "wren"]);
    for (const w of sandboxWarnings) expect(w.message).not.toMatch(/tried:|no working.*primitive|primitive was found/i);
    expect(otherWarnings).toEqual([
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
// This drives a REAL `git init` + founding commit and asserts, against the commit itself, that work/
// (with its tracked .gitkeep) is in it while evals/ and ideas/, genuinely empty-until-used, are not.
//
// 2026-08-22 (findings backlog #109, fourth occurrence): this used to perform a REAL `git clone` into
// a second directory, on the reasoning that cloning is "the only way to prove a directory is actually
// tracked, not just present before the first commit". That reasoning was sound about WHAT to prove and
// wrong about what to prove it WITH. `git clone` of a local path opens the source via its `.git`
// directory directly — the one code path in this whole file subject to git's ownership check — and this
// test deliberately discards ambient config (`GIT_CONFIG_SYSTEM: "/dev/null"`, a hermetic
// `GIT_CONFIG_GLOBAL`), which also discards whatever `safe.directory` entry a runner image was relying
// on. Three rounds of hardening (including the load-bearing `.git`-suffixed `safe.directory` form,
// confirmed by repro) never made it stable: it failed intermittently on Linux CI, and on 2026-08-22 it
// failed DETERMINISTICALLY on a hosted macOS runner the first time the suite ran there — retiring the
// "Linux-only quirk" framing entirely. The maintainer's own laptop was the only host it reliably passed
// on.
//
// What levare actually controls, and therefore what this test now asserts, is the CONTENT OF THE
// FOUNDING COMMIT: `git ls-tree -r HEAD` is exactly the set of paths a clone would materialise. A
// tracked `work/.gitkeep` in that tree IS the property ("survives a clone"); an untracked empty
// directory cannot appear in it. `git -C <working-tree-root>` needs no `safe.directory` entry — the
// prior comment already established that by observing only the clone line ever failed, never
// `initStudio`'s own `git -C source init/add/commit` calls against the identical directory.
//
// The trade, stated plainly rather than buried: this asserts the property one hop earlier, at the
// boundary levare owns, and no longer exercises git's own clone machinery. That machinery is not
// levare's to test, and testing it cost four investigations.
describe("a freshly-initialized studio's work/ is tracked in the founding commit (NOTES DOCS-WALKTHROUGH-2)", () => {
  test("the founding commit carries work/.gitkeep — so a clone keeps work/ — but not the still-empty evals/ or ideas/", () => {
    const source = mkdtempSync(join(tmpdir(), "levare-clone-src-"));
    const configFile = join(tmpdir(), `levare-clone-gitconfig-${Math.random().toString(36).slice(2)}`);
    try {
      // Hermetic identity only — `initStudio`'s own commit needs a user.name/user.email that does not
      // depend on whatever the ambient environment happens to carry. No `safe.directory` entry is
      // needed any more: nothing below opens a repository by its `.git` directory.
      writeFileSync(configFile, `[user]\n\tname = Clone Test\n\temail = clone@example.com\n`);
      const env = { ...process.env, GIT_CONFIG_GLOBAL: configFile, GIT_CONFIG_SYSTEM: "/dev/null" };

      const result = initStudio(source, env);
      expect(result.git.committed).toBe(true);

      // Every path in the founding commit — precisely what a clone of it would produce.
      const tree = spawnSync("git", ["-C", source, "ls-tree", "-r", "HEAD", "--name-only"], { encoding: "utf8", env });
      // The eighth instance of a test whose result depended on something other than the behaviour it
      // asserts (see this describe's own note) taught this: never let a bare status assertion discard
      // git's own stderr — a failure here must say what actually happened, on a CI run whose logs are
      // gone by the time anyone looks.
      if (tree.status !== 0) {
        throw new Error(
          `git ls-tree exited ${tree.status ?? "null"}` +
            `${tree.signal ? ` (signal ${tree.signal})` : ""}: ${tree.stderr || "(no stderr captured)"}`,
        );
      }
      const tracked = tree.stdout.split("\n").map((s) => s.trim()).filter(Boolean);

      expect(tracked).toContain("work/.gitkeep");
      // Empty-until-used: git cannot track an empty directory, so neither may appear under any path.
      expect(tracked.filter((p) => p.startsWith("evals/"))).toEqual([]);
      expect(tracked.filter((p) => p.startsWith("ideas/"))).toEqual([]);
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(configFile, { force: true });
    }
  });
});

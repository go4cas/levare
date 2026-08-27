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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { scaffoldStudio, initStudio } from "../src/init.ts";
import { validatePath } from "../src/validate.ts";

const HEREDOC_RE = /cat > (\S+) <<'EOF'\n([\s\S]*?)\nEOF/g;

type Action =
  | { pos: number; kind: "write"; path: string; body: string }
  | { pos: number; kind: "new"; args: string[] }
  | { pos: number; kind: "project-new"; args: string[]; stdin?: string };

function extractHeredocs(src: string): Array<{ pos: number; kind: "write"; path: string; body: string }> {
  const out: Array<{ pos: number; kind: "write"; path: string; body: string }> = [];
  let m: RegExpExecArray | null;
  HEREDOC_RE.lastIndex = 0;
  while ((m = HEREDOC_RE.exec(src))) {
    out.push({ pos: m.index, kind: "write", path: m[1], body: m[2] });
  }
  return out;
}

// `levare new` (Finding 93) is executable content exactly like a heredoc — a reader types it
// verbatim — but it's a real CLI invocation, not a file write, so it needs its own extraction.
// Scoped to ```sh fenced blocks specifically: 04-first-gate.md's own OUTPUT blocks (untagged ```)
// echo lines starting with "levare new · ..." (the command's own report) that would otherwise
// false-match a bare `/^levare new /` scan across the whole document.
const SH_BLOCK_RE = /```sh\n([\s\S]*?)```/g;
const LEVARE_NEW_RE = /^levare new (.+)$/gm;

function extractLevareNewCalls(src: string): Array<{ pos: number; kind: "new"; args: string[] }> {
  const out: Array<{ pos: number; kind: "new"; args: string[] }> = [];
  SH_BLOCK_RE.lastIndex = 0;
  let block: RegExpExecArray | null;
  while ((block = SH_BLOCK_RE.exec(src))) {
    LEVARE_NEW_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = LEVARE_NEW_RE.exec(block[1]))) {
      out.push({ pos: block.index + m.index, kind: "new", args: m[1].trim().split(/\s+/) });
    }
  }
  return out;
}

// `levare project new` (Finding 137, RELEASE R1b) is executable content exactly like `levare new`
// above, but its own house rules argument is piped in via a heredoc attached to the command itself
// (`levare project new ... <<'EOF' ... EOF`) rather than as a separate `cat >` file write — so it
// needs its own two-pass extraction: first pull out every heredoc-attached call (consuming its whole
// span, stdin included), then scan what's left for a plain (no-stdin) call the same way `levare new` is.
const LEVARE_PROJECT_NEW_HEREDOC_RE = /^levare project new (.+) <<'EOF'\n([\s\S]*?)\nEOF$/gm;
const LEVARE_PROJECT_NEW_PLAIN_RE = /^levare project new (.+)$/gm;

function extractLevareProjectNewCalls(src: string): Array<{ pos: number; kind: "project-new"; args: string[]; stdin?: string }> {
  const out: Array<{ pos: number; kind: "project-new"; args: string[]; stdin?: string }> = [];
  SH_BLOCK_RE.lastIndex = 0;
  let block: RegExpExecArray | null;
  while ((block = SH_BLOCK_RE.exec(src))) {
    const body = block[1];
    const consumed: Array<[number, number]> = [];
    LEVARE_PROJECT_NEW_HEREDOC_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = LEVARE_PROJECT_NEW_HEREDOC_RE.exec(body))) {
      out.push({ pos: block.index + m.index, kind: "project-new", args: m[1].trim().split(/\s+/), stdin: m[2] });
      consumed.push([m.index, m.index + m[0].length]);
    }
    let remainder = body;
    for (const [s, e] of consumed.slice().reverse()) remainder = remainder.slice(0, s) + remainder.slice(e);
    LEVARE_PROJECT_NEW_PLAIN_RE.lastIndex = 0;
    while ((m = LEVARE_PROJECT_NEW_PLAIN_RE.exec(remainder))) {
      out.push({ pos: block.index + m.index, kind: "project-new", args: m[1].trim().split(/\s+/) });
    }
  }
  return out;
}

function extractActions(src: string): Action[] {
  return [...extractHeredocs(src), ...extractLevareNewCalls(src), ...extractLevareProjectNewCalls(src)].sort((a, b) => a.pos - b.pos);
}

const GUIDE_DIR = "docs/guide/04-workflow";
const LEVARE_BIN = join(import.meta.dir, "..", "levare");

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

  // 4.2's own `levare project new todo-cli --repo ~/source/todo-cli ...` call is a real subprocess
  // (see the replay loop below) — `--repo` must resolve to a real git checkout or the new command's
  // own R1b guarantee ("say so immediately") makes it fail loudly, exactly as it should for a reader
  // who really hasn't cloned it yet. This suite is not that reader: it must pass deterministically on
  // every host regardless of whether the real `~/source/todo-cli` exists, so the subprocess is run
  // with `HOME` scoped to a scratch directory carrying a real, hermetic `source/todo-cli` checkout —
  // never the actual host home. `initStudio`/`scaffoldStudio` above don't touch `HOME` at all (`root`
  // itself is never `git init`'d in this whole suite), so this scoping affects nothing else here.
  const fakeHome = mkdtempSync(join(tmpdir(), "levare-guide-fakehome-"));
  const fakeTodoCliRepo = join(fakeHome, "source", "todo-cli");
  mkdirSync(fakeTodoCliRepo, { recursive: true });
  spawnSync("git", ["-c", "init.defaultBranch=main", "-C", fakeTodoCliRepo, "init", "-q"]);
  spawnSync("git", ["-C", fakeTodoCliRepo, "remote", "add", "origin", "git@github.com:you/todo-cli.git"]);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  });

  for (const chapter of CHAPTERS) {
    const src = readFileSync(join(GUIDE_DIR, chapter), "utf8");
    const actions = extractActions(src);
    for (const action of actions) {
      const label = action.kind === "write" ? action.path : action.kind === "new" ? `levare new ${action.args.join(" ")}` : `levare project new ${action.args.join(" ")}`;
      test(`${chapter} → ${label} parses and validates clean`, () => {
        if (action.kind === "write") {
          const full = join(root, action.path);
          mkdirSync(dirname(full), { recursive: true });
          writeFileSync(full, action.body + "\n");
        } else if (action.kind === "new") {
          // A real subprocess, exactly what a reader who pasted this line gets — not a call into
          // createUnit directly, for the same reason D10/D11 (init.test.ts) run `./levare init` as a
          // real subprocess rather than calling `initStudio`.
          const r = spawnSync(LEVARE_BIN, ["new", ...action.args], { cwd: root, encoding: "utf8" });
          if (r.status !== 0) {
            throw new Error(`after running \`levare new ${action.args.join(" ")}\` from ${chapter}, it exited ${r.status}:\n${r.stderr}`);
          }
        } else {
          // Same "real subprocess" reasoning as `levare new` above — `HOME` is scoped to this describe
          // block's own fake home (see its own comment) so `--repo ~/source/todo-cli` resolves
          // hermetically, on every host, without ever touching the real one.
          const r = spawnSync(LEVARE_BIN, ["project", "new", ...action.args], { cwd: root, encoding: "utf8", env: { ...process.env, HOME: fakeHome }, input: action.stdin ?? "" });
          if (r.status !== 0) {
            throw new Error(`after running \`levare project new ${action.args.join(" ")}\` from ${chapter}, it exited ${r.status}:\n${r.stderr}`);
          }
        }

        const r = validatePath(root);
        if (!r.ok) {
          const detail = r.errors
            .map((e) => `  ${e.code} ${e.file}${e.line ? ":" + e.line : ""} — ${e.message}`)
            .join("\n");
          throw new Error(`after pasting ${chapter}'s ${label} block, \`levare validate\` fails:\n${detail}`);
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
  // Finding 75 (part 2, 2026-08-24): the SANDBOX_NOT_WRAPPED warning this test used to also expect is
  // gone — `kind: native` is wired onto the sandbox mechanism now (adapters.ts#createSdkNativeBoundary/
  // createAsyncSdkNativeBoundary), so lyra/scribe/wren fold into the ordinary SANDBOX_UNAVAILABLE
  // eligibility list like any other sandboxed member. This call passes no `sandbox` detection at all
  // (validatePath(root), no third arg), so SANDBOX_UNAVAILABLE itself never fires either (see
  // validate.ts#validateSandboxTelling's own "never assumed" guard) — the finished studio is left with
  // two warnings.
  //
  // Finding 77 (2026-08-24): 02-promote-to-a-project.md's own pasted `projects/todo-cli.md` declares
  // `repo: ~/source/todo-cli` — the guide's illustrative product repo, never actually created by any
  // heredoc this suite replays (the guide assumes a reader who already has it cloned; this test never
  // fakes one). Tilde expansion now correctly resolves that against THIS process's real home. On most
  // hosts `~/source/todo-cli` genuinely doesn't exist, so PROJECT_REPO_UNRESOLVED correctly fires —
  // exactly the "config that looks right but the reader never ran `git clone`" case Finding 77 exists to
  // tell, and the silent no-op that predated this fix. Guarded on `existsSync` (rather than hard-coded
  // either way) because a real reader's own machine — or a dev host that genuinely has a `~/source/
  // todo-cli` checkout — sees neither this warning nor the old silent no-op.
  const todoCliRepo = join(homedir(), "source", "todo-cli");
  const todoCliRepoExists = existsSync(join(todoCliRepo, ".git"));
  test(`the finished studio validates with zero warnings, other than UNCOVERABLE_EXPECTED_KIND${todoCliRepoExists ? "" : " and PROJECT_REPO_UNRESOLVED"}`, () => {
    const r = validatePath(root);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    const expected = [
      {
        code: "UNCOVERABLE_EXPECTED_KIND",
        message:
          "unit 'add-command' (type 'feature') expects kind(s) [design, spec, code], but no member of its responsible team (press) declares producing any of them — this may be a legitimate configuration (a unit that only ever needs part of its type's shape), but the board's score rail will show these stage(s) as not covered, never as merely queued",
        file: join(root, "work", "todo-cli", "add-command", "unit.md"),
      },
    ];
    if (!todoCliRepoExists) {
      expected.push({
        code: "PROJECT_REPO_UNRESOLVED",
        message: `project 'todo-cli' declares repo: '~/source/todo-cli' which resolves to '${todoCliRepo}', but '${todoCliRepo}/.git' does not exist — no work branch or merge gate will be created for this project until repo: points at a real local checkout`,
        file: join(root, "projects", "todo-cli.md"),
      });
    }
    expect(r.warnings).toEqual(expected);
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

#!/usr/bin/env bun
// Guard: has CI actually run against THIS commit? (NOTES CI-HEAD-VERIFY)
//
// The release ritual used to read `gh run list --limit 2` and look for a green `CI main` row. That
// check answers "is the most recent run green", which is not the same question — the most recent run
// belongs to whichever commit last triggered one, not necessarily the tree about to be tagged.
//
// Observed 2026-08-21: PR #24 was squash-merged to main as `04ce6d0`, and
// `repos/go4cas/levare/commits/04ce6d0/check-runs` returned EMPTY — no CI run of any kind existed for
// the commit that was `main`. The PR's own check had run against the branch head (`765e947`); the
// squash produced a new commit nothing verified. Meanwhile `gh run list` showed a green `CI main` row
// from the *previous* merge, 23 hours earlier, and the ritual passed on it. Separately, `v0.2.7` was
// cut from a tree whose PR check had concluded `test failure` — merged anyway, because the green read
// afterwards was main's own (separate, older) run.
//
// A missing run and a passing run are indistinguishable to a recency check and obvious to a
// SHA-anchored one. That is the whole of this script.
//
// Usage: bun scripts/verify-head-checks.ts [sha]
//   bun scripts/verify-head-checks.ts              # HEAD
//   bun scripts/verify-head-checks.ts 04ce6d0      # a specific commit
//
// Exit codes: 0 every check run succeeded · 1 nothing ran, something is still running, or something
// failed · 2 this script could not ask the question (not a repo, no gh, no remote).

const NAME = "verify-head-checks";

function bail(message: string, code: 1 | 2): never {
  console.error(`${NAME}: ${message}`);
  process.exit(code);
}

function run(cmd: string[]): { ok: boolean; out: string; err: string } {
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return {
    ok: r.exitCode === 0,
    out: new TextDecoder().decode(r.stdout).trim(),
    err: new TextDecoder().decode(r.stderr).trim(),
  };
}

// --- resolve the commit ------------------------------------------------------------------------

const argSha = process.argv[2];

const rev = run(["git", "rev-parse", argSha ?? "HEAD"]);
if (!rev.ok) {
  bail(
    argSha
      ? `'${argSha}' is not a commit this repository knows (${rev.err || "git rev-parse failed"})`
      : `not a git repository, or HEAD is unresolvable (${rev.err || "git rev-parse failed"})`,
    2,
  );
}
const sha = rev.out;
const short = sha.slice(0, 7);

// `gh` resolves the repo from the cwd's own remote — surfaced explicitly so a failure here reads as
// "this script can't ask" rather than "the checks are bad".
const ghVersion = run(["gh", "--version"]);
if (!ghVersion.ok) bail("the GitHub CLI ('gh') is not on PATH — install it, or check this commit's runs on GitHub directly", 2);

// --- ask ---------------------------------------------------------------------------------------

const api = run([
  "gh",
  "api",
  `repos/{owner}/{repo}/commits/${sha}/check-runs`,
  "--jq",
  ".check_runs[] | {name, status, conclusion} | @json",
]);

if (!api.ok) {
  bail(
    `could not read check runs for ${short} — ${api.err || "gh api failed"}\n` +
      `  (is this repository pushed, and does the commit exist on the remote?)`,
    2,
  );
}

type Check = { name: string; status: string; conclusion: string | null };
const checks: Check[] = api.out
  .split("\n")
  .filter((l) => l.trim() !== "")
  .map((l) => JSON.parse(l) as Check);

// --- judge -------------------------------------------------------------------------------------

// The case a recency check cannot see. Not "the checks failed" — nothing ever asked.
if (checks.length === 0) {
  bail(
    `NO CHECK RUNS EXIST for ${short}.\n` +
      `  This commit has never been verified by CI. A squash-merge produces a new commit that the\n` +
      `  pull request's own checks never ran against; 'gh run list' will happily show you a green run\n` +
      `  belonging to some earlier commit.\n` +
      `  Push a commit to re-trigger the workflow, or dispatch it manually, before tagging.`,
    1,
  );
}

const pending = checks.filter((c) => c.status !== "completed");
if (pending.length > 0) {
  bail(
    `still running for ${short} — ${pending.map((c) => `${c.name} (${c.status})`).join(", ")}\n` +
      `  Wait for these to complete rather than reading a partial result.`,
    1,
  );
}

const failed = checks.filter((c) => c.conclusion !== "success");
if (failed.length > 0) {
  bail(
    `${failed.length} of ${checks.length} check(s) did not succeed for ${short}:\n` +
      failed.map((c) => `  ${c.name} — ${c.conclusion ?? "no conclusion"}`).join("\n"),
    1,
  );
}

console.log(`${NAME}: ${short} — ${checks.length} check(s), all green`);
for (const c of checks) console.log(`  ${c.name} — ${c.conclusion}`);

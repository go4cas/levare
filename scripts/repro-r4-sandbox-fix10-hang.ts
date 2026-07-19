// NOTES R4-SANDBOX-FIX-10 — hand-runnable repro ladder for the live macOS gate's own hang.
//
// The failing test (`tests/adapters.test.ts`, "a member's own commit inside its dispatch worktree
// actually advances the work branch") HANGS on the live macOS gate under a genuinely working
// `sandbox-exec` — 5000ms timeout, "killed 1 dangling process" — with no diagnosis of which link in the
// member's own chain (`sh -c "cd $1 && echo written > member-output.txt && git add -A && git commit -q
// -m ..."`) actually blocked. This container cannot reproduce it (no working sandbox-exec exists on
// Linux, and this container's own bwrap/unshare are both broken for an unrelated, already-documented
// reason). This script is the evidence-first alternative: it builds the EXACT SAME profile a real
// dispatch would (via `buildSandboxExecProfile`/`createDispatchWorktree`, the real, unmocked production
// functions — not a hand-copied approximation that could drift), then runs the member's chain LINK BY
// LINK, timing each one under `sandbox-exec -f <profile>` directly, so whichever link blocks is named by
// this run's own printed output — never assumed in advance.
//
// Run on the live macOS host: `bun run scripts/repro-r4-sandbox-fix10-hang.ts`
//
// The candidate space this ladder is structured to isolate (per the goal's own instruction — named to
// STRUCTURE the repro, never to pre-judge which one is guilty):
//   1. `sh` + `cd` alone — does the shell itself start and change directory under the profile?
//   2. The `echo ... > file` redirect — does a simple shell redirect into the granted `cwd` work?
//   3. A direct `stat` probe of `.git/hooks/pre-commit` and `.git/hooks/post-commit` — since `.git/hooks`
//      is DENIED (never granted, per FIX-8's own narrowing) while `.git/objects`/`refs`/`logs` and this
//      dispatch's own worktree admin dir ARE granted, this is where an EPERM-vs-ENOENT class defect (the
//      same class that struck twice already: the git-config read in FIX-9, and the `.git` root read in
//      earlier rounds) would show up cheaply, without running a real `git add`/`commit` at all. A stat
//      probe returning quickly (whether EPERM or ENOENT) ACQUITS this candidate; a probe that itself
//      hangs would be a genuinely new and separate finding.
//   4. `git add -A` alone, inside the worktree.
//   5. `git commit` alone, inside the worktree (after a real `git add`).
//   6. The FULL original chain, verbatim, as a baseline confirming the hang reproduces under this
//      harness at all.
//
// Each step runs with its own hard kill-timeout (mirroring `adapters.ts#asyncBunSpawn`'s own technique,
// not `timeout(1)` — not guaranteed present on a fresh macOS install). A step that hangs is KILLED (its
// whole process group, exactly like a real dispatch's own timeout) and reported as HANG, never left
// running past this script's own exit.

import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join } from "node:path";
import { buildSandboxExecProfile, type SandboxPolicy } from "../src/sandbox.ts";
import { createDispatchWorktree } from "../src/merge.ts";

const STEP_TIMEOUT_MS = 5_000;

function git(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync(["git", "-C", cwd, "-c", "user.name=seed", "-c", "user.email=seed@levare.test", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return { status: r.exitCode ?? -1, stdout: r.stdout ? new TextDecoder().decode(r.stdout) : "", stderr: r.stderr ? new TextDecoder().decode(r.stderr) : "" };
}

function killProcessGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    /* already exited */
  }
}

// Mirrors adapters.ts#asyncBunSpawn's own timeout technique exactly — a real dispatch's own kill
// mechanism, not a simulated stand-in, so a step reported HANG here is genuinely what a real dispatch
// would have killed too.
async function runStep(label: string, argv: string[]): Promise<void> {
  const start = Date.now();
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore", detached: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (proc.pid) killProcessGroup(proc.pid);
  }, STEP_TIMEOUT_MS);
  try {
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    const elapsed = Date.now() - start;
    if (timedOut) {
      console.log(`[HANG]  ${label} — killed after ${elapsed}ms, timeout=${STEP_TIMEOUT_MS}ms`);
      console.log(`        argv: ${JSON.stringify(argv)}`);
      if (stdout) console.log(`        partial stdout: ${JSON.stringify(stdout.slice(0, 500))}`);
      if (stderr) console.log(`        partial stderr: ${JSON.stringify(stderr.slice(0, 500))}`);
    } else {
      const ok = proc.exitCode === 0;
      console.log(`[${ok ? "OK  " : "FAIL"}]  ${label} — exit=${proc.exitCode} signal=${proc.signalCode ?? "null"} in ${elapsed}ms`);
      if (!ok) {
        if (stdout) console.log(`        stdout: ${JSON.stringify(stdout.slice(0, 500))}`);
        if (stderr) console.log(`        stderr: ${JSON.stringify(stderr.slice(0, 500))}`);
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  if (process.platform !== "darwin") {
    console.log(`This ladder is only meaningful on darwin (sandbox-exec) — running on '${process.platform}' would only prove what this container already knows (no working primitive here). Exiting.`);
    return;
  }
  const sbx = Bun.which("sandbox-exec") ?? (existsSync("/usr/bin/sandbox-exec") ? "/usr/bin/sandbox-exec" : null);
  if (!sbx) {
    console.log("sandbox-exec not found on PATH or at /usr/bin/sandbox-exec — cannot run this ladder at all.");
    return;
  }

  // 1. A real scratch project repo + work branch, exactly like tests/adapters.test.ts's own
  // `makeProjectRepoWithBranches` helper builds for the failing test.
  const projectRepo = mkdtempSync(join(tmpdir(), "levare-fix10-repro-proj-"));
  git(projectRepo, ["init", "-q"]);
  writeFileSync(join(projectRepo, "README.md"), "hello\n");
  git(projectRepo, ["add", "-A"]);
  git(projectRepo, ["commit", "-q", "-m", "initial"]);
  const branch = "levare/checkout-flow";
  git(projectRepo, ["checkout", "-q", "-b", branch]);
  writeFileSync(join(projectRepo, "marker.txt"), "MARKER-checkout-flow\n");
  git(projectRepo, ["add", "-A"]);
  git(projectRepo, ["commit", "-q", "-m", "seed"]);
  git(projectRepo, ["checkout", "-q", "main"]);

  // 2. The REAL per-dispatch worktree — the identical production function, not a hand-rolled `git
  // worktree add`.
  const created = createDispatchWorktree(projectRepo, branch);
  if (!created.ok) {
    console.log(`createDispatchWorktree failed: ${created.error}`);
    rmSync(projectRepo, { recursive: true, force: true });
    return;
  }
  const worktree = created.worktree;
  console.log(`worktree: ${worktree.path}`);
  console.log(`worktree gitDir: ${worktree.gitDir}`);

  // 3. The EXACT narrowed write grant adapters.ts#dispatchGitWritePaths computes (inlined here — the
  // computation is three lines, and duplicating it avoids exporting an internal helper solely for this
  // script; see adapters.ts's own doc for why these four paths specifically).
  const gitCommonDir = dirname(dirname(worktree.gitDir));
  const logs = join(gitCommonDir, "logs");
  if (!existsSync(logs)) mkdirSync(logs, { recursive: true });
  const writablePaths = [join(gitCommonDir, "objects"), join(gitCommonDir, "refs"), logs, worktree.gitDir];

  // 4. The real policy shape a plain (no subscription-connector, no scoped-home) dispatch gets —
  // `home: req.env.HOME` is always the OPERATOR's own real HOME in this common case (buildMemberEnv
  // allowlists HOME through unconditionally, scopeHome is a no-op with no grant) — matching the
  // `.gitconfig` EPERM FIX-9 already found and fixed via GIT_CONFIG_GLOBAL/SYSTEM redirection. This
  // script does NOT apply that env fix, deliberately — the point is to see the PROFILE's own raw
  // behavior on this chain, not to re-verify FIX-9 (already proven separately).
  const readOnlyPaths = [dirname(process.execPath), dirname(dirname(process.execPath))];
  const policy: SandboxPolicy = {
    cwd: worktree.path,
    home: process.env.HOME,
    allowNetwork: false,
    readOnlyPaths,
    operatorHome: homedir(),
    writablePaths,
  };
  const profile = buildSandboxExecProfile(policy);
  const profileScratchDir = mkdtempSync(join(tmpdir(), "levare-fix10-repro-profile-"));
  const profilePath = join(profileScratchDir, "profile.sb");
  writeFileSync(profilePath, profile);
  console.log(`profile written to: ${profilePath}`);
  console.log("");

  const sandboxed = (argv: string[]) => [sbx, "-f", profilePath, ...argv];

  // --- The ladder ---

  await runStep("1. sh + cd alone", sandboxed(["sh", "-c", `cd ${JSON.stringify(worktree.path)} && true`]));

  await runStep(
    "2. echo redirect into the granted cwd",
    sandboxed(["sh", "-c", `cd ${JSON.stringify(worktree.path)} && echo written > member-output.txt`]),
  );

  // Candidate 3: EPERM-vs-ENOENT on the DENIED hooks dir — cheap, isolated, run BEFORE any real git
  // command. This is squarely in the class that struck twice already (FIX-9's .gitconfig, and the
  // earlier .git-root read) but it must be CONVICTED here, not assumed — a probe returning promptly
  // (either error) acquits it as the hang's own cause, even if it prints an EPERM.
  await runStep(
    "3a. stat .git/hooks/pre-commit (denied dir — EPERM or ENOENT expected, NOT a hang)",
    sandboxed(["sh", "-c", `stat ${JSON.stringify(join(gitCommonDir, "hooks", "pre-commit"))} 2>&1; echo "EXIT:$?"`]),
  );
  await runStep(
    "3b. stat .git/hooks/post-commit (denied dir — EPERM or ENOENT expected, NOT a hang)",
    sandboxed(["sh", "-c", `stat ${JSON.stringify(join(gitCommonDir, "hooks", "post-commit"))} 2>&1; echo "EXIT:$?"`]),
  );

  await runStep("4. git add -A alone", sandboxed(["sh", "-c", `cd ${JSON.stringify(worktree.path)} && git -c user.name=member -c user.email=m@levare.test add -A`]));

  await runStep(
    "5. git commit alone (after a real add)",
    sandboxed(["sh", "-c", `cd ${JSON.stringify(worktree.path)} && git -c user.name=member -c user.email=m@levare.test -c commit.gpgsign=false commit -q -m repro`]),
  );

  // Reset the worktree back to a clean, uncommitted state before the baseline full-chain run, so it
  // reproduces the ORIGINAL failing test's own starting condition exactly.
  git(worktree.path, ["reset", "-q", "--hard", "HEAD~1"]);

  await runStep(
    "6. FULL original chain, verbatim (baseline — confirms the hang reproduces under this harness)",
    sandboxed([
      "sh",
      "-c",
      `cd "$1" && echo written > member-output.txt && git -c user.name=member -c user.email=member@levare.test -c commit.gpgsign=false add -A && git -c user.name=member -c user.email=member@levare.test -c commit.gpgsign=false commit -q -m "member commit" && echo "committed member work"`,
      "sh",
      worktree.path,
    ]),
  );

  console.log("");
  console.log(`profile text left at: ${profilePath} (inspect by hand if any step above is unclear — not auto-removed)`);
  console.log("cleaning up the scratch repo/worktree...");
  worktree.cleanup();
  rmSync(projectRepo, { recursive: true, force: true });
}

await main();

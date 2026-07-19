// NOTES R4-SANDBOX-FIX-10/FIX-11 — hand-runnable repro ladder for the live macOS gate.
//
// FIX-10's own report: the worktree-commit test (`tests/adapters.test.ts`, "a member's own commit inside
// its dispatch worktree actually advances the work branch") HANGS on the live macOS gate under a
// genuinely working `sandbox-exec` — 5000ms timeout, "killed 1 dangling process". This container cannot
// reproduce it directly (no working `sandbox-exec` exists on Linux, and this container's own `bwrap`/
// `unshare` are both broken for an unrelated, already-documented reason). Steps 1-6 below are the
// evidence-first alternative: build the EXACT SAME profile a real dispatch would (via
// `buildSandboxExecProfile`/`createDispatchWorktree`, the real, unmocked production functions — never a
// hand-copied approximation that could drift), then run the member's chain LINK BY LINK, timing each one
// under `sandbox-exec -f <profile>` directly, so whichever link blocks is named by this run's own printed
// output — never assumed in advance.
//
// FIX-11's own live run of steps 1-6 CONVICTED it: not a hang at all, but SLOW FATAL FAILURE — Apple's
// own xcrun-shimmed `/usr/bin/git` calls `confstr(DARWIN_USER_TEMP_DIR)` at startup, denied because the
// mach service backing it (`com.apple.bsd.dirhelper`) was never allowed; `confstr` fails, xcrun falls back
// to `/tmp`, that write is ALSO denied, and every git subcommand exits 128 after several seconds of
// xcodebuild/DVT stall (`git add` ~3.3s, `git commit` ~2.2s — together exceeding the test's own 5000ms
// ceiling). The fix-variant section after step 6 confirms the remedy: `buildSandboxExecProfile`'s own
// fixed preamble now unconditionally allows the `dirhelper` mach-lookup, and the caller threads a resolved
// per-user temp-dir write grant (`resolveDarwinUserTempDir`) into `writablePaths`. Three variants (A:
// profile grant only — this round's shipped fix; B: env-only, `XCRUN_DISABLE_CACHE=1`, no write grant; C:
// both) let ONE live run also tell a future round whether the write grant is droppable in favor of the
// narrower env-only path.
//
// Run on the live macOS host: `bun run scripts/repro-r4-sandbox-fix10-hang.ts`
//
// The candidate space steps 1-6 are structured to isolate (per FIX-10's own instruction — named to
// STRUCTURE the repro, never to pre-judge which one is guilty; CONVICTED above as `com.apple.bsd.
// dirhelper`, surfacing through steps 4/5/6 specifically, never steps 1-3):
//   1. `sh` + `cd` alone — does the shell itself start and change directory under the profile?
//   2. The `echo ... > file` redirect — does a simple shell redirect into the granted `cwd` work?
//   3. A direct `stat` probe of `.git/hooks/pre-commit` and `.git/hooks/post-commit` — since `.git/hooks`
//      is DENIED (never granted, per FIX-8's own narrowing) while `.git/objects`/`refs`/`logs` and this
//      dispatch's own worktree admin dir ARE granted, this is where an EPERM-vs-ENOENT class defect (the
//      same class that struck twice already: the git-config read in FIX-9, and the `.git` root read in
//      earlier rounds) would show up cheaply, without running a real `git add`/`commit` at all. Acquitted
//      by the live run: a probe returning promptly (whichever error) never blocked anything.
//   4. `git add -A` alone, inside the worktree — where CONVICTION 1 (dirhelper) first surfaces.
//   5. `git commit` alone, inside the worktree (after a real `git add`) — same conviction, second link.
//   6. The FULL original chain, verbatim, as a baseline confirming the failure reproduces under this
//      harness at all.
//
// Each step runs with its own hard kill-timeout (mirroring `adapters.ts#asyncBunSpawn`'s own technique,
// not `timeout(1)` — not guaranteed present on a fresh macOS install). A step that hangs is KILLED (its
// whole process group, exactly like a real dispatch's own timeout) and reported as HANG, never left
// running past this script's own exit; a step that fails fast or slow is reported as FAIL with its own
// elapsed time and captured stderr, distinguishable from a genuine HANG at a glance.

import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join } from "node:path";
import { buildSandboxExecProfile, resolveDarwinUserTempDir, type SandboxPolicy } from "../src/sandbox.ts";
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
// would have killed too. `env`, when given, is layered over `process.env` (never a strict allowlist —
// this is a standalone diagnostic script, not a production dispatch, so the full-fidelity env-scoping
// machinery in adapters.ts#buildMemberEnv is deliberately not reproduced here).
async function runStep(label: string, argv: string[], env?: Record<string, string>): Promise<void> {
  const start = Date.now();
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore", detached: true, env: env ? { ...process.env, ...env } : undefined });
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

  // --- Fix-variant confirmation (NOTES R4-SANDBOX-FIX-11) ---
  //
  // CONVICTION (from the round that ran this ladder first): `com.apple.bsd.dirhelper`'s mach-lookup
  // denial makes `confstr(DARWIN_USER_TEMP_DIR)` fail (code 5), xcrun falls back to `/tmp`, the fallback
  // write is ALSO denied, and every git subcommand exits 128 after several seconds of xcodebuild/DVT
  // stall — what the original test's own 5000ms timeout actually caught was SLOW FAILURE, not a hang.
  //
  // `buildSandboxExecProfile`'s own fixed preamble now unconditionally allows the `dirhelper` mach-lookup
  // (mirroring `sysctl-read`'s own precedent — there is no toggle to omit it, by design), so all three
  // variants below already have that half. What varies is ONLY the WRITE grant at the resolved per-user
  // temp dir and the `XCRUN_DISABLE_CACHE=1` env redirect — "whichever variant proves green with the
  // LEAST grant becomes the fix" (the goal's own instruction). Variant A is what this round actually
  // ships (`adapters.ts#sandboxWrap` threading `resolveDarwinUserTempDir()` into `writablePaths`); B and
  // C are here so ONE live run can also tell a future round whether the write grant is droppable.
  console.log("");
  console.log("=== Fix-variant confirmation (NOTES R4-SANDBOX-FIX-11) ===");

  const darwinTempDir = resolveDarwinUserTempDir();
  console.log(`resolved DARWIN_USER_TEMP_DIR: ${darwinTempDir ?? "(unresolved — variant A/C's own write grant will be empty)"}`);

  function writeVariantProfile(name: string, includeTempDirGrant: boolean): string {
    const p = join(profileScratchDir, `${name}.sb`);
    const variantProfile = buildSandboxExecProfile({
      cwd: worktree.path,
      home: process.env.HOME,
      allowNetwork: false,
      operatorHome: homedir(),
      readOnlyPaths,
      writablePaths: includeTempDirGrant && darwinTempDir ? [...writablePaths, darwinTempDir] : writablePaths,
    });
    writeFileSync(p, variantProfile);
    return p;
  }

  const profileWithGrant = writeVariantProfile("variant-with-grant", true);
  const profileNoGrant = writeVariantProfile("variant-no-grant", false);

  const fullChainArgv = (variantProfilePath: string) => [
    sbx,
    "-f",
    variantProfilePath,
    "sh",
    "-c",
    `cd "$1" && echo written > variant-output.txt && git -c user.name=member -c user.email=member@levare.test -c commit.gpgsign=false add -A && git -c user.name=member -c user.email=member@levare.test -c commit.gpgsign=false commit -q -m "variant commit" && echo "committed variant work"`,
    "sh",
    worktree.path,
  ];

  // Reset before EACH variant so every one starts from the identical, clean, uncommitted state — never
  // carrying over a previous variant's own commit.
  function resetWorktreeForVariant(): void {
    git(worktree.path, ["reset", "-q", "--hard", "HEAD~1"]);
    try {
      rmSync(join(worktree.path, "variant-output.txt"), { force: true });
    } catch {
      /* best-effort */
    }
  }

  resetWorktreeForVariant();
  await runStep("A. profile grant only — mach-lookup (always on) + write grant at resolved temp dir, NO env fix (this round's SHIPPED fix)", fullChainArgv(profileWithGrant));

  resetWorktreeForVariant();
  await runStep("B. env-only — XCRUN_DISABLE_CACHE=1, NO temp-dir write grant (tests whether the write grant is droppable)", fullChainArgv(profileNoGrant), { XCRUN_DISABLE_CACHE: "1" });

  resetWorktreeForVariant();
  await runStep("C. both together — profile grant AND env fix (belt-and-suspenders baseline)", fullChainArgv(profileWithGrant), { XCRUN_DISABLE_CACHE: "1" });

  console.log("");
  console.log(`profile text left at: ${profilePath} (inspect by hand if any step above is unclear — not auto-removed)`);
  console.log(`variant profiles left at: ${profileWithGrant} , ${profileNoGrant}`);
  console.log("cleaning up the scratch repo/worktree...");
  worktree.cleanup();
  rmSync(projectRepo, { recursive: true, force: true });
}

await main();

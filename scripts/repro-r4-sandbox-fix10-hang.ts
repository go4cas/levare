// NOTES R4-SANDBOX-FIX-10/FIX-11/FIX-12 — hand-runnable repro ladder for the live macOS gate.
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
// xcodebuild/DVT stall. FIX-11 shipped a fix — but that fix (a flat, broad write grant on the ENTIRE
// resolved temp directory) was itself a real security regression: the FIX-8 decoy test caught it live,
// on its very first execution, because every `mkdtempSync(tmpdir())`-based scratch repo in this codebase
// lives DIRECTLY under that same directory, so the broad grant recursively covered `.git/hooks` too — and
// broke cross-dispatch write isolation, since every CONCURRENT dispatch's own worktree lives under the
// SAME directory.
//
// FIX-12 (this round) narrows the xcrun grant to a `(regex ...)` matching ONLY xcrun's own `xcrun_db-*`
// cache-file naming, and moves the git-write grant to a dedicated `gitWriteGrant` field whose own
// deny-root-then-reallow-subpaths ordering reseals `.git/hooks`/`.git/config` regardless of what any
// OTHER grant in the profile covers. Steps 7-8 below prove the reseal AND the narrow xcrun grant
// directly; the fix-variant section confirms which shape of the xcrun grant is minimally sufficient.
//
// Run on the live macOS host: `bun run scripts/repro-r4-sandbox-fix10-hang.ts`
//
// The candidate space steps 1-6 are structured to isolate (per FIX-10's own instruction — named to
// STRUCTURE the repro, never to pre-judge which one is guilty; CONVICTED as `com.apple.bsd.dirhelper`,
// surfacing through steps 4/5/6 specifically, never steps 1-3):
//   1. `sh` + `cd` alone — does the shell itself start and change directory under the profile?
//   2. The `echo ... > file` redirect — does a simple shell redirect into the granted `cwd` work?
//   3. A direct `stat` probe of `.git/hooks/pre-commit` and `.git/hooks/post-commit` — since `.git/hooks`
//      is DENIED (never granted, per FIX-8's own narrowing) while `.git/objects`/`refs`/`logs` and this
//      dispatch's own worktree admin dir ARE granted, this is where an EPERM-vs-ENOENT class defect (the
//      same class that struck twice already: the git-config read in FIX-9, and the `.git` root read in
//      earlier rounds) would show up cheaply, without running a real `git add`/`commit` at all. Acquitted
//      by the live run: a probe returning promptly (whichever error) never blocked anything.
//   4. `git add -A` alone, inside the worktree — where CONVICTION 1 (dirhelper) first surfaced.
//   5. `git commit` alone, inside the worktree (after a real `git add`) — same conviction, second link.
//   6. The FULL original chain, verbatim, as a baseline confirming the failure reproduces under this
//      harness at all (and, post-FIX-12, that it no longer does).
//   7. NEW (FIX-12): a member attempting to write `.git/hooks/post-commit` under the FIXED profile —
//      MUST FAIL. This is the ladder's own version of the FIX-8 decoy test that caught FIX-11's own
//      regression live; it belongs in the ladder now precisely because a live run is what caught it.
//   8. NEW (FIX-12): a member attempting to write an `xcrun_db-*`-named file directly under the resolved
//      temp dir — MUST SUCCEED, proving the narrow regex grant actually admits what xcrun itself needs.
//
// ENV PARITY (FIX-12): every git-invoking step below now runs under the SAME `GIT_CONFIG_GLOBAL`/
// `GIT_CONFIG_SYSTEM` redirect a real dispatch applies (`adapters.ts#gitConfigRedirectEnv`, FIX-9) — the
// first run of this ladder, without it, produced a misleading 33ms `.gitconfig` EPERM failure on every
// git step that was pure harness noise (this script never applied FIX-9's own redirect), not a product
// failure; the real dispatch always has it, so the ladder must too, or its own results mean nothing about
// product behavior.
//
// Each step runs with its own hard kill-timeout (mirroring `adapters.ts#asyncBunSpawn`'s own technique,
// not `timeout(1)` — not guaranteed present on a fresh macOS install). A step that hangs is KILLED (its
// whole process group, exactly like a real dispatch's own timeout) and reported as HANG, never left
// running past this script's own exit; a step that fails fast or slow is reported as FAIL with its own
// elapsed time and captured stderr, distinguishable from a genuine HANG at a glance.

import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildSandboxExecProfile, resolveDarwinUserTempDir } from "../src/sandbox.ts";
import { createDispatchWorktree, resolveProjectRepoPath, workBranchName, branchExists } from "../src/merge.ts";
import { AdapterRunner, buildDispatchSandboxPolicy, type InvokeRequest, type NativeBoundary, type RemoteBoundary } from "../src/adapters.ts";
import { loadRepo } from "../src/repo.ts";
import { loadPricing } from "../src/pricing.ts";

const STEP_TIMEOUT_MS = 5_000;

// NOTES R4-SANDBOX-FIX-12: mirrors `adapters.ts#gitConfigRedirectEnv` exactly (not imported — that
// function is private to adapters.ts, and reproducing two lines here is simpler and less coupling than
// exporting an internal helper solely for this script). Every git-invoking step below must carry this,
// or its own result means nothing about product behavior — see this file's own "ENV PARITY" header note.
const GIT_ENV_FIX = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

function git(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync(["git", "-C", cwd, "-c", "user.name=seed", "-c", "user.email=seed@levare.test", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...GIT_ENV_FIX },
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
// machinery in adapters.ts#buildMemberEnv is deliberately not reproduced here). Returns the step's own
// exit code (or `null` on a hang/signal) so callers can assert MUST-FAIL/MUST-SUCCEED expectations.
async function runStep(label: string, argv: string[], env?: Record<string, string>): Promise<number | null> {
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
      return null;
    }
    const ok = proc.exitCode === 0;
    console.log(`[${ok ? "OK  " : "FAIL"}]  ${label} — exit=${proc.exitCode} signal=${proc.signalCode ?? "null"} in ${elapsed}ms`);
    if (!ok) {
      if (stdout) console.log(`        stdout: ${JSON.stringify(stdout.slice(0, 500))}`);
      if (stderr) console.log(`        stderr: ${JSON.stringify(stderr.slice(0, 500))}`);
    }
    return proc.exitCode;
  } finally {
    clearTimeout(timer);
  }
}

// A step whose SUCCESS is a security regression and whose FAILURE is correct — prints an explicit
// PASS/REGRESSION verdict on top of the raw OK/FAIL/HANG runStep already prints, so a Conductor scanning
// the ladder's own output can't miss which one this is.
async function runMustFailStep(label: string, argv: string[], env?: Record<string, string>): Promise<void> {
  const exitCode = await runStep(label, argv, env);
  if (exitCode === 0) console.log(`        >>> REGRESSION: this MUST fail (the write should be denied) but it SUCCEEDED <<<`);
  else console.log(`        >>> PASS: denied as expected <<<`);
}

async function runMustSucceedStep(label: string, argv: string[], env?: Record<string, string>): Promise<void> {
  const exitCode = await runStep(label, argv, env);
  if (exitCode !== 0) console.log(`        >>> REGRESSION: this MUST succeed (xcrun's own cache write needs this) but it FAILED/HUNG <<<`);
  else console.log(`        >>> PASS: succeeded as expected <<<`);
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

  // 3. The EXACT narrowed write grant adapters.ts#dispatchGitWriteGrant computes (inlined here — the
  // computation is three lines, and duplicating it avoids exporting an internal helper solely for this
  // script; see adapters.ts's own doc for why these four paths specifically). NOTES R4-SANDBOX-FIX-12:
  // `root` is carried alongside `subpaths` now — it's what `gitWriteGrant` needs to build its own
  // deny-then-reallow reseal.
  const gitCommonDir = dirname(dirname(worktree.gitDir));
  const logs = join(gitCommonDir, "logs");
  if (!existsSync(logs)) mkdirSync(logs, { recursive: true });
  const gitSubpaths = [join(gitCommonDir, "objects"), join(gitCommonDir, "refs"), logs, worktree.gitDir];

  // 4. NOTES R4-SANDBOX-FIX-13 (live macOS gate: THE parity gap this round exposed). The policy is now
  // built by calling `adapters.ts#buildDispatchSandboxPolicy` — the EXACT function `AdapterRunner#
  // sandboxWrap` calls internally — rather than hand-rolling the fields here. This is the fix for the
  // actual failure this round found: the ladder's own PREVIOUS hand-rolled policy never reproduced the
  // real `writablePaths`/`gitWriteGrant` duplication production actually sends (bubblewrap needs the
  // subpaths in `writablePaths` too; `sandboxWrap` populates BOTH fields from the same
  // `dispatchGitWriteGrant`), so the ladder never exercised the dedupe-ordering bug that shipped live —
  // it PASSED while production FAILED. Calling the identical, shared function makes that class of
  // divergence structurally impossible, not just currently absent.
  const studioRepo = loadRepo("fixtures/golden");
  const finchAgent = studioRepo.agents.get("finch")!;
  const dummyReq: InvokeRequest = {
    agent: finchAgent,
    member: "finch",
    kind: "review",
    unit: "repro",
    project: "storefront",
    context: "",
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    tools: [],
    dispatchGitWriteGrant: { root: gitCommonDir, subpaths: gitSubpaths },
  };
  const policy = buildDispatchSandboxPolicy(studioRepo, dummyReq, worktree.path, "sh", process.env);
  const darwinTempDir = resolveDarwinUserTempDir();
  console.log(`resolved DARWIN_USER_TEMP_DIR: ${darwinTempDir ?? "(unresolved — the xcrun grant will be empty)"}`);
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

  await runStep(
    "4. git add -A alone",
    sandboxed(["sh", "-c", `cd ${JSON.stringify(worktree.path)} && git -c user.name=member -c user.email=m@levare.test add -A`]),
    GIT_ENV_FIX,
  );

  await runStep(
    "5. git commit alone (after a real add)",
    sandboxed(["sh", "-c", `cd ${JSON.stringify(worktree.path)} && git -c user.name=member -c user.email=m@levare.test -c commit.gpgsign=false commit -q -m repro`]),
    GIT_ENV_FIX,
  );

  // Reset the worktree back to a clean, uncommitted state before the baseline full-chain run, so it
  // reproduces the ORIGINAL failing test's own starting condition exactly.
  git(worktree.path, ["reset", "-q", "--hard", "HEAD~1"]);

  await runStep(
    "6. FULL original chain, verbatim (baseline — confirms the fix under this harness)",
    sandboxed([
      "sh",
      "-c",
      `cd "$1" && echo written > member-output.txt && git -c user.name=member -c user.email=member@levare.test -c commit.gpgsign=false add -A && git -c user.name=member -c user.email=member@levare.test -c commit.gpgsign=false commit -q -m "member commit" && echo "committed member work"`,
      "sh",
      worktree.path,
    ]),
    GIT_ENV_FIX,
  );

  // --- Security regression checks (NOTES R4-SANDBOX-FIX-12) — run under the SAME fixed profile as
  // steps 1-6 above, proving the reseal and the narrow xcrun grant directly, not just inferring them
  // from the full chain's own exit code. ---
  console.log("");
  console.log("=== Security regression checks (NOTES R4-SANDBOX-FIX-12) ===");

  const hookPath = join(gitCommonDir, "hooks", "post-commit");
  await runMustFailStep(
    "7. write .git/hooks/post-commit under the FIXED profile — the FIX-8 decoy this ladder's own version of",
    sandboxed(["sh", "-c", `echo '#!/bin/sh' > ${JSON.stringify(hookPath)}`]),
  );
  console.log(`        hook file exists after: ${existsSync(hookPath)} (must be false)`);

  if (darwinTempDir) {
    const xcrunCachePath = join(darwinTempDir, "xcrun_db-repro-test");
    await runMustSucceedStep(
      "8. write an xcrun_db-* file directly under the resolved temp dir — the narrow regex grant this fix depends on",
      sandboxed(["sh", "-c", `echo ok > ${JSON.stringify(xcrunCachePath)}`]),
    );
    console.log(`        cache file exists after: ${existsSync(xcrunCachePath)} (must be true)`);
    try {
      rmSync(xcrunCachePath, { force: true });
    } catch {
      /* best-effort */
    }
  } else {
    console.log("8. SKIPPED — DARWIN_USER_TEMP_DIR did not resolve on this host, nothing to test.");
  }

  // --- Fix-variant confirmation (NOTES R4-SANDBOX-FIX-11/FIX-12) ---
  //
  // CONVICTION (FIX-11): `com.apple.bsd.dirhelper`'s mach-lookup denial makes `confstr(DARWIN_USER_TEMP_DIR)`
  // fail (code 5), xcrun falls back to `/tmp`, the fallback write is ALSO denied, and every git subcommand
  // exits 128 after several seconds of xcodebuild/DVT stall.
  //
  // `buildSandboxExecProfile`'s own fixed preamble unconditionally allows the `dirhelper` mach-lookup
  // (mirroring `sysctl-read`'s own precedent — there is no toggle to omit it, by design), so all three
  // variants below already have that half, and ALL THREE ALSO carry the FIX-12 `gitWriteGrant` reseal —
  // "regardless of which shape wins" (the goal's own instruction), the reseal is never conditional on
  // which xcrun-grant variant is under test. What varies is ONLY the narrow xcrun regex grant and the
  // `XCRUN_DISABLE_CACHE=1` env redirect. FIX-11's own variant question is ALREADY ANSWERED (banked, not
  // re-litigated by this run): env-only did NOT work on its own — the write grant is required, which is
  // exactly why FIX-12 narrows it rather than removing it. B and C remain in the ladder as a live
  // regression check that this conclusion still holds under the corrected (regex + reseal) shapes.
  console.log("");
  console.log("=== Fix-variant confirmation (NOTES R4-SANDBOX-FIX-11/FIX-12) ===");

  function buildVariantProfile(name: string, includeXcrunGrant: boolean): string {
    const p = join(profileScratchDir, `${name}.sb`);
    // NOTES R4-SANDBOX-FIX-13: same shared `buildDispatchSandboxPolicy` call as the main policy above —
    // the reseal is NEVER conditional (every variant carries it, per the goal's own "regardless of
    // which shape wins" instruction); only `darwinXcrunTempDir` toggles between variants.
    const variantPolicy = { ...buildDispatchSandboxPolicy(studioRepo, dummyReq, worktree.path, "sh", process.env), darwinXcrunTempDir: includeXcrunGrant ? darwinTempDir : undefined };
    const variantProfile = buildSandboxExecProfile(variantPolicy);
    writeFileSync(p, variantProfile);
    return p;
  }

  const profileWithXcrunGrant = buildVariantProfile("variant-with-grant", true);
  const profileNoXcrunGrant = buildVariantProfile("variant-no-grant", false);

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
  await runStep(
    "A. narrow xcrun regex grant + reseal, NO env fix (this round's SHIPPED fix)",
    fullChainArgv(profileWithXcrunGrant),
    GIT_ENV_FIX,
  );

  resetWorktreeForVariant();
  await runStep(
    "B. env-only — XCRUN_DISABLE_CACHE=1, NO xcrun grant at all (reself still present) — FIX-11's own question, banked: expected to still fail",
    fullChainArgv(profileNoXcrunGrant),
    { ...GIT_ENV_FIX, XCRUN_DISABLE_CACHE: "1" },
  );

  resetWorktreeForVariant();
  await runStep(
    "C. both together — narrow xcrun grant AND env fix (belt-and-suspenders baseline)",
    fullChainArgv(profileWithXcrunGrant),
    { ...GIT_ENV_FIX, XCRUN_DISABLE_CACHE: "1" },
  );

  console.log("");
  console.log(`profile text left at: ${profilePath} (inspect by hand if any step above is unclear — not auto-removed)`);
  console.log(`variant profiles left at: ${profileWithXcrunGrant} , ${profileNoXcrunGrant}`);
  console.log("cleaning up the scratch repo/worktree...");
  worktree.cleanup();
  rmSync(projectRepo, { recursive: true, force: true });

  // --- Ladder/production parity check (NOTES R4-SANDBOX-FIX-13, comparison-inputs fix NOTES
  // R4-SANDBOX-FIX-14) ---
  //
  // Everything above already calls `buildDispatchSandboxPolicy` — the SAME function `AdapterRunner#
  // sandboxWrap` calls internally — so the ladder's own policy construction can no longer silently drift
  // from production's. This section goes one step further: it drives a REAL, full `AdapterRunner.
  // produceAsync()` dispatch (the ENTIRE production call chain — prepare, withDispatchWorktreeAsync,
  // sandboxWrap, wrapForSandbox, buildSandboxExecProfile — never a partial simulation), captures the
  // profile it actually generates via `LEVARE_SANDBOX_DEBUG=1`, and diffs its STRUCTURE (fixed lines,
  // rule types, and relative ORDER — specific paths necessarily differ, since this dispatch creates its
  // OWN separate scratch worktree) against the ladder's own profile from step 4 above. Any structural
  // difference means the ladder and production have diverged again — the exact "weak canary" failure
  // mode FIX-5 first named, now caught here rather than assumed closed.
  //
  // NOTES R4-SANDBOX-FIX-14: the EQUALITY assertion below is only honest when BOTH sides are
  // repo-bearing (the ladder's own profile always is — step 2 above always builds a real scratch
  // worktree). The production side must be dispatched against an equally repo-bearing project, never the
  // golden fixture's own `storefront` UNTOUCHED (`repo:` there is a deliberate placeholder SSH URL — see
  // NOTES MERGE-1 — so that dispatch legitimately builds no worktree and carries no git-write section: a
  // shape difference, not a generator disagreement). A second, clearly-labeled INFORMATIONAL check below
  // drives that repo-less dispatch on purpose and pins the expected shape difference, so the repo-less
  // profile's own shape is under test too, never just assumed.
  console.log("");
  console.log("=== Ladder/production parity check (NOTES R4-SANDBOX-FIX-13/FIX-14) ===");

  function profileSkeleton(text: string): string {
    // Regex literals first (they also match the quoted-string pattern below) — both collapse every
    // path-specific literal to a single placeholder, leaving only the RULE STRUCTURE to compare.
    return text.replace(/#"(?:[^"\\]|\\.)*"/g, "#<PATH>").replace(/"(?:[^"\\]|\\.)*"/g, "<PATH>");
  }

  // NOTES R4-SANDBOX-FIX-14 (round 3 — live host): round 2's own instrumentation isolated the gap
  // precisely — the fixture satisfied `resolveDispatchRepo`'s own precondition (verified directly,
  // immediately pre-dispatch), yet the ACTUAL dispatch still declined the worktree, with no way to see
  // WHERE the divergence happened. `adapters.ts#withDispatchWorktree{,Async}` now prints its own
  // decision — "dispatch worktree created for '<member>' at '<path>' ..." or "dispatch worktree declined
  // for '<member>': <reason>" — under `LEVARE_SANDBOX_DEBUG=1`, for EVERY dispatch, unconditionally (this
  // line fires from plain decision logic inside `prepare()`/`withDispatchWorktree{,Async}`, never gated
  // on a live sandbox primitive — see `tests/adapters.test.ts`'s own three new regression tests pinning
  // this). The parity step now keys directly on THAT line — the adapter's own stated decision — rather
  // than inferring the decision from profile-text shape a second time.
  function profileSkeleton(text: string): string {
    // Regex literals first (they also match the quoted-string pattern below) — both collapse every
    // path-specific literal to a single placeholder, leaving only the RULE STRUCTURE to compare.
    return text.replace(/#"(?:[^"\\]|\\.)*"/g, "#<PATH>").replace(/"(?:[^"\\]|\\.)*"/g, "<PATH>");
  }

  // Mirrors `AdapterRunner#resolveDispatchRepo`'s own condition via the EXACT exported functions it
  // calls internally (`resolveProjectRepoPath`, `workBranchName`, `branchExists`) — pure git/fs logic,
  // zero sandbox-primitive dependency, meaning the same thing on this container as on a live darwin host.
  // Used as a pre-dispatch sanity check on the fixture this section builds (never as the parity verdict
  // itself — that now comes from the adapter's own decision line below, per this round's own lesson that
  // even an independently-correct precondition check can't stand in for observing the real decision).
  function diagnoseDispatchRepoCondition(
    repo: ReturnType<typeof loadRepo>,
    project: string,
    unit: string,
  ): { ok: true; repoPath: string; branch: string } | { ok: false; reason: string } {
    const proj = repo.projects.get(project);
    if (!proj) return { ok: false, reason: `project '${project}' not found in repo.projects` };
    const repoPath = resolveProjectRepoPath(repo.root, proj);
    if (!repoPath) {
      return {
        ok: false,
        reason: `resolveProjectRepoPath(repo.root=${JSON.stringify(repo.root)}, project.repo=${JSON.stringify(proj.repo)}) returned undefined — project.repo is unset, '<resolved>/.git' doesn't exist, or it resolved as self-referential to the studio root`,
      };
    }
    const branch = workBranchName(unit);
    if (!branchExists(repoPath, branch)) {
      return { ok: false, reason: `branchExists(${JSON.stringify(repoPath)}, ${JSON.stringify(branch)}) returned false — the work branch does not exist in the resolved repo` };
    }
    return { ok: true, repoPath, branch };
  }

  type WorktreeDecision = { kind: "created"; detail: string } | { kind: "declined"; reason: string };

  // Drives a real `AdapterRunner.produceAsync()` dispatch of finch/review against `repo`'s `project`/
  // `unit`, capturing (1) the adapter's own `dispatch worktree created/declined` decision line — the
  // AUTHORITATIVE signal this round's own fix keys on — and (2) the darwin sandbox-exec profile text,
  // when this host's own detected primitive reaches that far, for the structural equality check. Both are
  // read from `LEVARE_SANDBOX_DEBUG=1` output; a failed dispatch still prints both — built and logged
  // BEFORE the spawn itself runs, so the dispatch's own success/failure is irrelevant here. `decision` is
  // `null` only if NEITHER a created nor a declined line was captured at all (a setup error in this
  // capture harness itself, never a legitimate outcome — `withDispatchWorktree{,Async}` always prints
  // exactly one). Shared between the repo-bearing (primary) and repo-less (informational) checks below —
  // the only thing that differs between them is which `repo`/`project` is passed in.
  async function captureProductionDispatch(repo: ReturnType<typeof loadRepo>, project: string, unit: string): Promise<{ skeleton: string | null; decision: WorktreeDecision | null }> {
    const nativeMock: NativeBoundary = { invoke: () => ({ doc: "unused" }) };
    const remoteMock: RemoteBoundary = { call: () => ({ doc: "unused" }) };
    const pricing = loadPricing("fixtures/golden");
    const capturedLines: string[] = [];
    const origConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      capturedLines.push(args.map(String).join(" "));
    };
    const priorDebug = process.env.LEVARE_SANDBOX_DEBUG;
    process.env.LEVARE_SANDBOX_DEBUG = "1";
    try {
      const runner = new AdapterRunner(repo, {
        pricing,
        capabilities: [{ member: "finch", kind: "review" }],
        native: nativeMock,
        remote: remoteMock,
        cliCommand: () => ["cat", "/dev/null"],
      });
      await runner.produceAsync("finch", "review", unit, project);
    } catch (e) {
      console.log(`(dispatch itself reported: ${e instanceof Error ? e.message : String(e)} — expected/irrelevant, only its own printed debug lines matter here)`);
    } finally {
      console.error = origConsoleError;
      if (priorDebug === undefined) delete process.env.LEVARE_SANDBOX_DEBUG;
      else process.env.LEVARE_SANDBOX_DEBUG = priorDebug;
    }
    const createdLine = capturedLines.find((l) => l.startsWith("[levare:sandbox-debug] dispatch worktree created for"));
    const declinedLine = capturedLines.find((l) => l.startsWith("[levare:sandbox-debug] dispatch worktree declined for"));
    const decision: WorktreeDecision | null = createdLine
      ? { kind: "created", detail: createdLine.slice("[levare:sandbox-debug] ".length) }
      : declinedLine
        ? { kind: "declined", reason: declinedLine.slice("[levare:sandbox-debug] ".length) }
        : null;
    const profileTextLine = capturedLines.find((l) => l.startsWith("[levare:sandbox-debug] darwin sandbox-exec profile text:"));
    const skeleton = profileTextLine ? profileSkeleton(profileTextLine.slice(profileTextLine.indexOf("\n") + 1)) : null;
    return { skeleton, decision };
  }

  const ladderSkeleton = profileSkeleton(profile);

  // --- Primary check: REPO-BEARING vs REPO-BEARING, asserted for structural EQUALITY — gated on the
  // adapter's OWN "created" decision, never inferred a second time. ---
  const parityProjectRepo = mkdtempSync(join(tmpdir(), "levare-fix13-parity-proj-"));
  git(parityProjectRepo, ["init", "-q"]);
  writeFileSync(join(parityProjectRepo, "README.md"), "hello\n");
  git(parityProjectRepo, ["add", "-A"]);
  git(parityProjectRepo, ["commit", "-q", "-m", "initial"]);
  // NOTES R4-SANDBOX-FIX-14: capture whatever this host's own git actually named the initial branch
  // (never assumed) — this section used to hard-code `git branch levare/parity-unit main`, which
  // silently no-ops (branch never created, git's own error going unchecked) on any host whose git
  // initializes a fresh repo on a default branch other than "main".
  const parityDefaultBranch = git(parityProjectRepo, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
  // `checkout -q -b`, the SAME technique the MAIN ladder's own `projectRepo` above already uses to cut
  // its own work branch from whatever HEAD already is — no starting-point name to get wrong. Then
  // checkout BACK to the captured default branch, exactly like the main ladder does right after seeding
  // its own branch (`git(projectRepo, ["checkout", "-q", "main"])` above) — `createDispatchWorktree`'s own
  // `git worktree add` refuses to check out a branch that's already checked out in this primary worktree.
  git(parityProjectRepo, ["checkout", "-q", "-b", "levare/parity-unit"]);
  git(parityProjectRepo, ["checkout", "-q", parityDefaultBranch]);

  const parityRepo = loadRepo("fixtures/golden");
  const storefront = parityRepo.projects.get("storefront")!;
  parityRepo.projects.set("storefront", { ...storefront, repo: parityProjectRepo });

  // Pre-dispatch sanity check (never the verdict itself — see this section's own header comment). Runs
  // with zero sandbox dependency; verifiable in this container exactly as meaningfully as on a live
  // darwin host.
  const parityCondition = diagnoseDispatchRepoCondition(parityRepo, "storefront", "parity-unit");
  if (!parityCondition.ok) {
    throw new Error(`parity check setup failed — the fixture does not satisfy AdapterRunner#resolveDispatchRepo's own condition: ${parityCondition.reason}`);
  }
  console.log(`parity fixture satisfies resolveDispatchRepo's own condition: repoPath=${parityCondition.repoPath} branch=${parityCondition.branch}`);

  const production = await captureProductionDispatch(parityRepo, "storefront", "parity-unit");
  rmSync(parityProjectRepo, { recursive: true, force: true });

  if (!production.decision) {
    console.log("PARITY CHECK SETUP ERROR — neither a 'dispatch worktree created' nor 'declined' line was captured at all; the LEVARE_SANDBOX_DEBUG capture itself is broken, not the adapter's own decision.");
  } else if (production.decision.kind === "declined") {
    // The adapter's OWN stated reason, quoted verbatim — never re-derived or paraphrased. The
    // pre-dispatch condition above held, so a decline here means `withDispatchWorktreeAsync`/
    // `createDispatchWorktree` diverged from `resolveDispatchRepo`'s own precondition at dispatch time —
    // exactly the gap this round's own instrumentation exists to name instead of guess at.
    console.log(`>>> REGRESSION: the adapter itself declined the worktree despite the fixture satisfying resolveDispatchRepo's own precondition (verified immediately above). Reason (quoted verbatim): "${production.decision.reason}" <<<`);
  } else if (production.skeleton === null) {
    console.log(`PARITY CHECK PARTIAL — worktree WAS created (${production.decision.detail}), but no darwin sandbox-exec profile text was captured (this host's own detected primitive may not be sandbox-exec) — structural equality not checked this run.`);
  } else if (ladderSkeleton === production.skeleton) {
    console.log(`>>> PASS: worktree created (${production.decision.detail}); the ladder's own profile and production's own profile are structurally identical <<<`);
  } else {
    console.log(`>>> REGRESSION: worktree created (${production.decision.detail}), but the ladder's own profile and production's own profile DIFFER in structure <<<`);
    console.log("--- ladder skeleton ---");
    console.log(ladderSkeleton);
    console.log("--- production skeleton ---");
    console.log(production.skeleton);
  }

  // --- Secondary check (NOTES R4-SANDBOX-FIX-14): INFORMATIONAL, never a regression gate. Dispatches
  // against the golden fixture's own `storefront` project UNTOUCHED — deliberately repo-less (`repo:` is
  // a placeholder SSH URL never actually cloned locally, per NOTES MERGE-1) — and pins the EXPECTED
  // decision (declined, naming the missing repo resolution) rather than leaving that shape untested. If
  // this ever stops declining the way it's expected to, that means the repo-less DETECTION itself broke —
  // a real bug, but a different one than the primary check above guards against, so it is named and
  // printed distinctly rather than folded into "REGRESSION".
  console.log("");
  console.log("=== Repo-less dispatch shape check (NOTES R4-SANDBOX-FIX-14, informational — not a regression gate) ===");
  const repolessRepo = loadRepo("fixtures/golden");
  const repolessCondition = diagnoseDispatchRepoCondition(repolessRepo, "storefront", "repro");
  console.log(
    repolessCondition.ok
      ? `(unexpected: the untouched golden fixture's own 'storefront' satisfies resolveDispatchRepo's own condition — repoPath=${repolessCondition.repoPath} branch=${repolessCondition.branch})`
      : `golden fixture's own 'storefront' correctly does NOT satisfy resolveDispatchRepo's own condition: ${repolessCondition.reason}`,
  );
  const repoless = await captureProductionDispatch(repolessRepo, "storefront", "repro");
  if (!repoless.decision) {
    console.log("INFORMATIONAL CHECK SETUP ERROR — neither a 'dispatch worktree created' nor 'declined' line was captured at all.");
  } else if (repoless.decision.kind === "declined") {
    console.log(`>>> PASS (expected decision): the repo-less dispatch correctly declined the worktree. Reason (quoted verbatim): "${repoless.decision.reason}" <<<`);
  } else {
    console.log(`>>> UNEXPECTED SHAPE: this pinned expectation no longer holds — the repo-less dispatch CREATED a worktree (${repoless.decision.detail}); the repo-less DETECTION itself may have changed <<<`);
  }
}

await main();

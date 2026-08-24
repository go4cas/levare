// Finding 75 (part 2, 2026-08-24) — the native-worker equivalent of `scripts/repro-r4-sandbox-fix10-hang.ts`.
//
// Part 1 (PR #33) made the gap honest: `kind: native` was never wrapped by levare's OS sandbox, on any
// host. This unit wires it — `adapters.ts#createSdkNativeBoundary`/`createAsyncSdkNativeBoundary` now
// wrap the SDK worker's own OS-level self-invocation spawn (`sdk-transport.ts#workerSpawnArgv`) exactly
// like a `kind: cli` member's spawn, via the SAME `wrapForSandbox`/`buildSandboxExecProfile` generator.
//
// Every one of `cli`'s six R4-SANDBOX rounds (`(allow sysctl-read)`, the broad `file-read*` default,
// ancestor-metadata grants, the `dirhelper` mach-lookup, the `trustd.agent`/`SecurityServer` pair) was
// diagnosed from a LIVE macOS host's own crash signature or kernel log — none was predictable from
// source. This script does two things:
//
//   STEP A (runs on ANY host, including this project's own Linux container): a pure, construction-level
//   PARITY check — build a `cli`-shaped policy and a `native`-shaped policy from equivalent inputs, run
//   both through the SAME `buildSandboxExecProfile` generator, and assert every one of `cli`'s six
//   already-acquitted fixed-preamble lines appears IDENTICALLY in the native profile too — proving by
//   construction that native inherits them "for free" (this unit's own Phase 1 claim), never re-derived
//   or hand-approximated.
//
//   STEP B (only meaningful on darwin, with a genuinely working `sandbox-exec`): spawn the REAL wrapped
//   worker argv (`workerSpawnArgv()`, wrapped by the SAME `wrapForSandbox` a real dispatch calls) under
//   the generated profile, with a trivial `SdkWorkerRequest` on stdin — far short of a real API call (no
//   credential is assumed present), but enough to exercise the worker's OWN startup: module resolution,
//   `bun`'s sysctl reads, and (on a compiled build) `extractFromBunfs`'s own read/write into
//   `nativeBunfsExtractionBase()`. A kernel denial anywhere in that startup path is exactly the class of
//   defect no amount of source-reading ever caught in `cli`'s own six rounds.
//
// Run on the live macOS host: `bun run scripts/repro-r4-sandbox-native-worker.ts`. Cross-check with
// `log stream --style syslog --predicate 'eventMessage contains "deny"'` running alongside it — the same
// live-diagnosis technique every prior R4-SANDBOX round used, per NOTES R4-SANDBOX-FIX-3's own account.
//
// THIS SCRIPT HAS NOT BEEN RUN ON A LIVE HOST. This container is Linux — `detectSandbox()` here reports
// `none` (this repo's own sandbox.ts header: "this repo's own Linux dev container...only ever detects
// none"), so STEP B/STEP C degrade to printing the composed argv/profile (STEP C: to a SKIPPED report)
// and exit without ever asking the OS to enforce anything. STEP A/STEP A2's own construction checks are
// real and pass in this container, but a profile that PARSES correctly and a kernel that actually
// ENFORCES it are not the same fact — the exact lesson this whole R4-SANDBOX saga exists to keep
// re-learning. A live macOS run is a MERGE CONDITION for this unit, not a formality.
//
// Finding 75 (part 3 — a regression from part 2, this container's own live evidence): a live macOS
// `quill/builder` dispatch under part 2's own wiring produced NO code — every Bash invocation failed at
// sandbox setup with `EPERM ... mkdir '/private/tmp/claude-{uid}/<slugified-cwd>/<uuid>'`. Root cause:
// `adapters.ts#nativeBunfsExtractionBase` computed its grant with plain `node:os`'s `tmpdir()`, but the
// vendored `extractFromBunfs.js`'s OWN `tmpdir()` helper hardcodes `/tmp` on darwin (bypassing
// `os.tmpdir()`'s `$TMPDIR`, typically `/var/folders/...` — a genuinely different tree, never an alias of
// `/tmp`) — the inner CLI's Bash tool shares this identical per-uid base for its own per-session scratch
// dirs, so the wrong formula denied both. STEP A2 and STEP C below are this part's own addition: STEP B's
// `{prompt:"hi"}` payload dies on "Not logged in" before ever reaching a Bash-shaped filesystem op, which
// is exactly why the part 2 regression shipped past this very script unnoticed (this script's own
// pre-existing gap is part of this finding too) — STEP C never talks to the API at all, so it actually
// exercises the fixed code path on a live host, credential or not.

import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildSandboxExecProfile, detectSandbox, wrapForSandbox, resolveDarwinUserTempDir } from "../src/sandbox.ts";
import { createDispatchWorktree } from "../src/merge.ts";
import { buildDispatchSandboxPolicy, buildNativeSandboxPolicy, nativeBunfsExtractionBase, ensureNativeBunfsExtractionBase, type InvokeRequest } from "../src/adapters.ts";
import { workerSpawnArgv, workerSpawnCwd, LEVARE_CLAUDE_CONFIG_DIR } from "../src/sdk-transport.ts";
import { loadRepo } from "../src/repo.ts";
import { profileSkeleton } from "./repro-r4-sandbox-fix10-hang.ts";

const STEP_TIMEOUT_MS = 8_000;

// `cli`'s own six already-acquitted, unconditional grants (src/sandbox.ts's own header/round comments) —
// the exact lines this step asserts a native profile carries too, verbatim. `trustd.agent`/
// `SecurityServer` are network-gated (both policies below request `allowNetwork: true`, so both should
// carry them); the rest are unconditional for every "full"-tier darwin profile regardless of network.
export const CLI_ACQUITTED_LINES = [
  "(allow sysctl-read)",
  '(allow mach-lookup (global-name "com.apple.bsd.dirhelper"))',
  '(allow file-read* (subpath "/"))',
  '(allow mach-lookup (global-name "com.apple.trustd.agent"))',
  '(allow mach-lookup (global-name "com.apple.SecurityServer"))',
  "(allow network*)",
];

function git(cwd: string, args: string[]): void {
  const r = Bun.spawnSync(["git", "-C", cwd, "-c", "user.name=repro", "-c", "user.email=repro@levare.test", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(r.stderr)}`);
}

// Builds a real per-dispatch worktree (the identical production function, never hand-rolled) so both
// the cli-shaped and native-shaped policies below are compared against equivalent, real filesystem
// state — never synthetic paths that happen to not exist.
function buildRealWorktree(): { projectRepo: string; worktreePath: string; gitWriteGrant: { root: string; subpaths: string[] } } {
  const projectRepo = mkdtempSync(join(tmpdir(), "levare-native-worker-repro-proj-"));
  git(projectRepo, ["init", "-q"]);
  writeFileSync(join(projectRepo, "README.md"), "hello\n");
  git(projectRepo, ["add", "-A"]);
  git(projectRepo, ["commit", "-q", "-m", "initial"]);
  const branch = "levare/repro-native-worker";
  git(projectRepo, ["checkout", "-q", "-b", branch]);
  writeFileSync(join(projectRepo, "marker.txt"), "MARKER\n");
  git(projectRepo, ["add", "-A"]);
  git(projectRepo, ["commit", "-q", "-m", "seed"]);
  git(projectRepo, ["checkout", "-q", "main"]);

  const created = createDispatchWorktree(projectRepo, branch, { name: "member", email: "member@levare.local" });
  if (!created.ok) throw new Error(`createDispatchWorktree failed: ${created.error}`);
  const worktree = created.worktree;
  const gitCommonDir = dirname(dirname(worktree.gitDir));
  const logs = join(gitCommonDir, "logs");
  if (!existsSync(logs)) mkdirSync(logs, { recursive: true });
  return {
    projectRepo,
    worktreePath: worktree.path,
    gitWriteGrant: { root: gitCommonDir, subpaths: [join(gitCommonDir, "objects"), join(gitCommonDir, "refs"), logs, worktree.gitDir] },
  };
}

// STEP A — construction-level parity, runs on any host. Exported so `bun test` (this container never
// has a working sandbox primitive at all — STEP B always no-ops here) still gets REAL, always-run
// coverage of the parity claim, mirroring `scripts/repro-r4-sandbox-fix10-hang.ts`'s own exported,
// directly-unit-tested `profileSkeleton`/`selectDispatchProfileText`.
export function nativeInheritsCliAcquittedGrants(): boolean {
  console.log("=== STEP A: structural parity — does the native profile inherit cli's six acquitted grants? ===\n");

  const repo = loadRepo("fixtures/golden");
  const finchAgent = repo.agents.get("finch")!; // kind: cli
  const lyraAgent = repo.agents.get("lyra")!; // kind: native

  const { projectRepo, worktreePath, gitWriteGrant } = buildRealWorktree();
  try {
    const cliReq: InvokeRequest = {
      agent: finchAgent,
      member: "finch",
      kind: "review",
      unit: "repro",
      project: "storefront",
      context: "",
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      tools: [],
      projectRepoPath: worktreePath,
      dispatchGitWriteGrant: gitWriteGrant,
    };
    const nativeReq: InvokeRequest = { ...cliReq, agent: lyraAgent, member: "lyra", kind: "spec" };

    // The cli policy's own `cwd` IS the worktree (this unit's own goal item 2 — the thing that would
    // break a copy-paste); the native policy's `cwd` is the WORKER's own OS-level spawn cwd, a DIFFERENT
    // path by construction — `workerSpawnCwd(undefined)` (never `undefined` itself on a source run,
    // which this script always is).
    // `allowNetwork` is forced true on BOTH sides for this comparison specifically: native's own is
    // unconditionally true (goal item 3), while the fixture's `finch` may or may not hold a granted
    // connector — an apples-to-apples check of "does native get the SAME trustd.agent/SecurityServer/
    // network* lines cli gets when IT has network too" must not depend on which connectors this
    // fixture's `finch` happens to be granted.
    const cliPolicy = { ...buildDispatchSandboxPolicy(repo, cliReq, worktreePath, "sh", process.env), allowNetwork: true };
    const workerCwd = workerSpawnCwd(undefined) ?? process.cwd();
    const nativePolicy = buildNativeSandboxPolicy(repo, nativeReq, workerCwd, undefined, process.env);

    const cliProfile = buildSandboxExecProfile(cliPolicy);
    const nativeProfile = buildSandboxExecProfile(nativePolicy);

    let allPresent = true;
    for (const line of CLI_ACQUITTED_LINES) {
      const inCli = cliProfile.includes(line);
      const inNative = nativeProfile.includes(line);
      const ok = inCli === inNative && inNative;
      if (!ok) allPresent = false;
      console.log(`[${ok ? "OK  " : "FAIL"}] ${line}${inCli ? "" : " (not even in the cli profile — check CLI_ACQUITTED_LINES itself)"}`);
    }

    // The goal's own item 2, proven directly on the generated text: the native profile's own worktree
    // re-allow must appear (writablePaths), and its `cwd` re-allow must be the WORKER's cwd, not the
    // worktree — reusing `sandboxWrap`'s cli-shaped call verbatim would have bound the worktree as
    // `cwd`, which this assertion would catch.
    const skeletonCli = profileSkeleton(cliProfile);
    const skeletonNative = profileSkeleton(nativeProfile);
    const structurallyEquivalent = skeletonCli === skeletonNative;
    console.log(`\nrule-shape (path-erased skeleton) identical between cli and native profiles: ${structurallyEquivalent ? "yes" : "no (expected — see below)"}`);
    if (!structurallyEquivalent) {
      console.log("  (native additionally carries the worktree-as-a-plain-writable-grant + the LEVARE_CLAUDE_CONFIG_DIR");
      console.log("  grant that cli's own profile has no equivalent field for — a difference in SHAPE, not a missing fix.)");
    }
    console.log(`\nnative profile contains the worktree path (${worktreePath}): ${nativeProfile.includes(worktreePath)}`);
    console.log(`native profile contains LEVARE_CLAUDE_CONFIG_DIR (${LEVARE_CLAUDE_CONFIG_DIR}): ${nativeProfile.includes(LEVARE_CLAUDE_CONFIG_DIR)}`);
    console.log(`native profile's cwd re-allow is the WORKER's cwd (${workerCwd}), not the worktree: ${nativePolicy.cwd === workerCwd && nativePolicy.cwd !== worktreePath}`);

    return allPresent;
  } finally {
    rmSync(projectRepo, { recursive: true, force: true });
  }
}

// STEP A2 — Finding 75 part 3's own always-run coverage, mirroring STEP A's own "this container never has
// a working sandbox primitive at all" posture. Proves, by construction, that `ensureNativeBunfsExtractionBase`
// closes `sandbox.ts#canon`'s ENOENT fallback gap for this specific grant: the base is pre-created against
// a SCRATCH `CLAUDE_CODE_TMPDIR` (never the real host temp dir), then the generated darwin profile's own
// `(allow file-write* (subpath ...))` line for it is asserted to name the FULLY REALPATH'D form — proving
// `canon()` took the real-resolution branch, not the pre-resolution literal-string fallback that would
// silently defeat the grant once a symlinked base (`/tmp` → `/private/tmp` on a real macOS host) is
// involved. Runs identically on any host; darwin-specific symlink behavior isn't exercised in THIS
// container, but the property under test — "the profile names the realpath'd form, not the raw one, once
// the directory exists" — is host-independent by construction.
export function nativeBunfsGrantIsCanonicalized(): boolean {
  console.log("\n=== STEP A2: does the pre-created bunfs extraction base get canon()-resolved before it's granted? ===\n");
  const scratchRoot = mkdtempSync(join(tmpdir(), "levare-bunfs-canon-repro-"));
  try {
    const base = ensureNativeBunfsExtractionBase({ platform: "darwin", getuid: () => 999, env: { CLAUDE_CODE_TMPDIR: scratchRoot } });
    const realBase = realpathSync(base);
    const profile = buildSandboxExecProfile({ cwd: "/a/b", allowNetwork: true, writablePaths: [base] });
    const expectedLine = `(allow file-write* (subpath ${JSON.stringify(realBase)}))`;
    const ok = profile.includes(expectedLine);
    console.log(`[${ok ? "OK  " : "FAIL"}] profile contains the realpath'd grant: ${expectedLine}`);
    if (!ok && base !== realBase) {
      console.log(`  (base and its realpath differ on this host — ${base} vs ${realBase} — a genuine symlink case, good coverage)`);
    }
    return ok;
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
}

// STEP C — Finding 75 part 3's own fix for the goal's Phase 2 instruction: the probe must exercise TOOL
// USE, not just startup — STEP B's own `{prompt:"hi"}` payload dies on "Not logged in" before the worker
// ever reaches a Bash-shaped filesystem operation, which is exactly why the part 2 regression shipped
// unnoticed. This step never talks to the Anthropic API at all: it wraps a TRIVIAL shell command — never
// the real worker — through the SAME `buildNativeSandboxPolicy`/`wrapForSandbox` a real native dispatch
// uses, and has that command `mkdir -p` + write + read back a path shaped exactly like the evidence trace
// (`{nativeBunfsExtractionBase()}/<slugified-cwd>/<uuid>/`) — a fabricated slug/uuid, since the real
// values are opaque to this module and, per Phase 1 item 3, irrelevant: the grant is a subpath re-allow on
// the BASE, so any nested name must work. FAILS on `edd638c` (the wrong `os.tmpdir()`-based formula denies
// this write); PASSES after this unit's fix. Only meaningful on darwin with a working `sandbox-exec` —
// degrades honestly (like STEP B) when nothing enforces on this host.
async function stepC_bashShapedScratchDirProbe(): Promise<boolean | null> {
  console.log("\n=== STEP C: a Bash-shaped mkdir/write/read under the wrapped native policy — no API credential needed ===\n");

  const detection = detectSandbox();
  if (detection.level === "none") {
    console.log("no working primitive on this host — nothing for the OS to enforce here. Run this script on a");
    console.log("macOS host with a working sandbox-exec to get a real pass/fail for this step.");
    return null;
  }

  const repo = loadRepo("fixtures/golden");
  const lyraAgent = repo.agents.get("lyra")!;
  const { projectRepo, worktreePath } = buildRealWorktree();
  try {
    const req: InvokeRequest = {
      agent: lyraAgent,
      member: "lyra",
      kind: "spec",
      unit: "repro",
      project: "storefront",
      context: "",
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      tools: [],
      projectRepoPath: worktreePath,
    };
    const workerCwd = workerSpawnCwd(undefined) ?? process.cwd();
    const policy = buildNativeSandboxPolicy(repo, req, workerCwd, undefined, process.env);
    const darwinTempDir = resolveDarwinUserTempDir();
    // The exact shape the evidence trace's own EPERM names: base/<slugified-cwd>/<uuid>/, fabricated since
    // the real inner-CLI values aren't knowable from outside it — Phase 1 item 3's own claim under test.
    const fakeScratchDir = join(nativeBunfsExtractionBase(), "-Users-cas-source-jot-studio", "77d98e72-b1f6-4d2c-b0e2-163bf8eb7de1");
    const markerFile = join(fakeScratchDir, "probe.txt");
    const script = `mkdir -p ${JSON.stringify(fakeScratchDir)} && echo probe-ok > ${JSON.stringify(markerFile)} && cat ${JSON.stringify(markerFile)}`;
    const wrapped = wrapForSandbox(["/bin/sh", "-c", script], { ...policy, darwinXcrunTempDir: darwinTempDir }, detection);
    console.log(`probing: ${fakeScratchDir}`);
    console.log(`composed argv:\n${wrapped.argv.map((a, i) => `  [${i}] ${JSON.stringify(a)}`).join("\n")}`);

    const proc = Bun.spawn(wrapped.argv, { cwd: workerCwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    wrapped.cleanup?.();

    const ok = proc.exitCode === 0 && stdout.trim() === "probe-ok";
    console.log(`[exit ${proc.exitCode}] ${ok ? "PASS — mkdir/write/read all succeeded under the wrap" : "FAIL — denied (this is the regression this unit fixes)"}`);
    if (stdout) console.log(`stdout: ${stdout.slice(0, 500)}`);
    if (stderr) console.log(`stderr: ${stderr.slice(0, 500)}`);
    return ok;
  } finally {
    rmSync(projectRepo, { recursive: true, force: true });
  }
}

// STEP B — a real spawn attempt, only meaningful on darwin.
async function stepB_liveSpawnAttempt(): Promise<void> {
  console.log("\n=== STEP B: a real wrapped worker spawn (only meaningful on darwin) ===\n");

  const detection = detectSandbox();
  console.log(`detectSandbox(): ${JSON.stringify(detection)}`);
  if (detection.level === "none") {
    console.log("no working primitive on this host — nothing for the OS to enforce here. This is the honest");
    console.log("degradation every prior R4-SANDBOX round takes outside its required platform; it proves");
    console.log("nothing about live enforcement. Run this script on a macOS host with a working sandbox-exec.");
    return;
  }

  const repo = loadRepo("fixtures/golden");
  const lyraAgent = repo.agents.get("lyra")!;
  const { projectRepo, worktreePath } = buildRealWorktree();
  try {
    const req: InvokeRequest = {
      agent: lyraAgent,
      member: "lyra",
      kind: "spec",
      unit: "repro",
      project: "storefront",
      context: "",
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      tools: [],
      projectRepoPath: worktreePath,
    };
    const workerCwd = workerSpawnCwd(undefined) ?? process.cwd();
    const policy = buildNativeSandboxPolicy(repo, req, workerCwd, undefined, process.env);
    const darwinTempDir = resolveDarwinUserTempDir();
    console.log(`resolved DARWIN_USER_TEMP_DIR: ${darwinTempDir ?? "(unresolved — the xcrun grant will be empty)"}`);
    console.log(`nativeBunfsExtractionBase(): ${nativeBunfsExtractionBase()}`);
    const wrapped = wrapForSandbox(workerSpawnArgv(), { ...policy, darwinXcrunTempDir: darwinTempDir }, detection);
    console.log(`composed argv:\n${wrapped.argv.map((a, i) => `  [${i}] ${JSON.stringify(a)}`).join("\n")}`);

    const stdinPayload = JSON.stringify({ prompt: "hi" }); // no credential assumed present
    const proc = Bun.spawn(wrapped.argv, { cwd: workerCwd, stdout: "pipe", stderr: "pipe", stdin: Buffer.from(stdinPayload), detached: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (proc.pid) process.kill(-proc.pid, "SIGKILL");
      } catch {
        /* already exited */
      }
    }, STEP_TIMEOUT_MS);
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timer);
    wrapped.cleanup?.();

    if (timedOut) {
      console.log(`[HANG] worker spawn killed after ${STEP_TIMEOUT_MS}ms — this is the failure mode every prior R4-SANDBOX round found FIRST, before ever seeing a kernel log.`);
    } else {
      console.log(`[exit ${proc.exitCode}, signal ${proc.signalCode ?? "null"}]`);
    }
    if (stdout) console.log(`stdout: ${stdout.slice(0, 2000)}`);
    if (stderr) console.log(`stderr: ${stderr.slice(0, 2000)}`);
    console.log("\nCross-check the above against a concurrent `log stream --style syslog --predicate 'eventMessage");
    console.log('contains "deny"\'` run — any NEW denial not already named in src/sandbox.ts\'s own six-round');
    console.log("history is this round's own finding, evidence-first, exactly like every round before it.");
  } finally {
    rmSync(projectRepo, { recursive: true, force: true });
  }
}

async function main() {
  const parityOk = nativeInheritsCliAcquittedGrants();
  const canonOk = nativeBunfsGrantIsCanonicalized();
  const bashProbeOk = await stepC_bashShapedScratchDirProbe();
  await stepB_liveSpawnAttempt();
  console.log(`\n${"=".repeat(78)}`);
  console.log(parityOk ? "STEP A: PASS (construction-level parity confirmed)" : "STEP A: FAIL — see above");
  console.log(canonOk ? "STEP A2: PASS (bunfs extraction base grant is canon()-resolved)" : "STEP A2: FAIL — see above");
  console.log(bashProbeOk === null ? "STEP C: SKIPPED (no working sandbox primitive on this host)" : bashProbeOk ? "STEP C: PASS (Bash-shaped scratch-dir mkdir/write/read succeeded under the wrap)" : "STEP C: FAIL — see above (this is Finding 75 part 3's own regression)");
  console.log("THIS SCRIPT HAS NOT BEEN RUN ON A LIVE HOST. A live macOS run is a merge condition for");
  console.log("Finding 75 part 3, not a formality — see this file's own header.");
  console.log("=".repeat(78));
}

if (import.meta.main) {
  await main();
}

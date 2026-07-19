// levare OS-level sandboxing (v2, ratified R4 — see docs/current-gaps.md, NOTES R4-SANDBOX). This is
// the layer that sits BETWEEN a `kind: cli` member's spawned process and the operating system — the
// gap parts A/B of the capability layer (NOTES CAP-A/CAP-B) named but deliberately left unbuilt:
// env/credential/tool-allowlist/HOME scoping govern what a member's process can see reach FOR, this
// module governs what the process can reach ON DISK and over the NETWORK once it's running.
//
// The governing posture (a Conductor ruling, not a discovery): best-effort, per-OS, honestly reported.
// A working primitive is never assumed from the platform alone — `detectSandbox` PROBES an actual
// invocation (not just `which`), because a binary can be present and still non-functional (an
// unprivileged container with user namespaces disabled has `bwrap` on PATH that fails every call — the
// exact case this module's own tests run against). When nothing works, the spawn proceeds unsandboxed
// — never a hard failure — and every caller records which of the three levels actually applied:
//
//   "full"     — filesystem AND network confined (bubblewrap on Linux; sandbox-exec on macOS).
//   "fs-only"  — filesystem confined via a raw `unshare` mount-namespace fallback (no bubblewrap
//                binary, but the kernel still permits unprivileged user+mount namespaces); network is
//                NOT attempted at this tier — reconstructing a working net-namespace by hand without
//                bwrap's own machinery is real extra complexity for a fallback path whose own governing
//                ruling already calls network "best-effort", not a hard condition.
//   "none"     — no primitive worked at all. Recorded, never silently absent.
//
// Filesystem, at the "full" tier, is a HARD condition taken literally: the process can reach its
// per-dispatch worktree (merge.ts#createDispatchWorktree, read-write), its scopeHome scratch HOME
// (env.ts#scopeHome, read-write), a small ENUMERATED set of read-only system paths a vendor CLI's own
// interpreter/dynamic linker/libraries need to resolve, the studio root itself (read-only — a command
// checked into the studio, or a `context_artifacts: paths` member's consumed-artifact reads, both need
// this), and the currently-running levare binary's own directory plus wherever THIS dispatch's own
// argv[0] resolves to (read-only — the interpreter actually being spawned) — nothing else. A decoy
// anywhere outside that list — an unrelated scratch directory, the operator's own home, another user's
// files — is genuinely unreadable, proven directly by this module's own decoy-file test
// (tests/adapters.test.ts).
//
// NOTES R4-SANDBOX-FIX (macOS host verification, first live run): the original design excluded the
// studio root entirely, on the theory that "nothing else" should be as strict as possible. A live macOS
// run — where `sandbox-exec` actually engages, unlike this repo's own Linux dev container, which only
// ever detects `none` — proved that theory wrong in practice: most of this repo's OWN test fixtures spawn
// commands (stub scripts, `bun` itself) that live IN the studio tree, and every one of them broke. The
// studio root is now a deliberate, named exception to "nothing else" — narrower than the pre-fix
// "ro-bind the whole disk" design this module never shipped, but broader than the post-fix-attempt
// "enumerated system paths only" design that turned out to break ordinary, expected usage.
//
// Bubblewrap builds its root from an empty `--tmpfs /` rather than `--ro-bind / /`, so "nothing else" is
// still true of reads for everything NOT explicitly named above.
//
// "fs-only" (the unshare fallback) is honestly WEAKER, not merely net-less: reconstructing bubblewrap's
// own empty-root-plus-allowlist construction by hand, without bwrap's own tooling, is real additional
// complexity for a tier this ruling already treats as best-effort — so it takes the simpler, well-known
// "remount / read-only, bind cwd/home read-write on top" shape instead. That confines WRITES to exactly
// the declared roots, but a decoy elsewhere on disk remains READABLE (never writable) under this tier
// specifically — the decoy-file test therefore only asserts against "full", and this asymmetry is named
// here rather than implied to be uniform across tiers.
//
// macOS path canonicalization (NOTES R4-SANDBOX-FIX): `sandbox-exec`'s `(subpath ...)` rules match the
// KERNEL-RESOLVED (canonical) form of a path, not whatever string happened to be passed to it — and on
// macOS, `/tmp` and `/var/folders` (where `os.tmpdir()` lives) are themselves symlinks into `/private`.
// A profile written with the pre-resolution path silently never matches, denying access to exactly the
// worktree/scratch-HOME the sandbox exists to allow. `buildSandboxExecProfile` resolves every path
// through `realpathSync` (falling back to the literal string when the path doesn't exist, e.g. this
// module's own pure unit tests) before writing it into a `(subpath ...)` clause — the same lesson as the
// phase-1 immutability fix (commit b9ae0f1): a path comparison that ignores the filesystem's own symlink
// layer is comparing the wrong thing. Bubblewrap (Linux) is NOT given the same treatment: it constructs
// its sandboxed root by mounting SRC (kernel-resolved through symlinks automatically, by the ordinary
// semantics of `mount --bind`) onto DEST at the literal path string the spawned process will actually
// `chdir`/open — canonicalizing DEST would risk creating the bound directory at a DIFFERENT path than the
// one the process is told to use, which on a host where `/tmp` is a plain directory (the common Linux
// case, and this repo's own verified dev-container reality) is unnecessary, unverified-on-a-symlinked-Linux-
// host risk this fix does not take on.

// NOTES R4-SANDBOX-FIX (round 2 — live macOS host verification, second run): the FIRST macOS run (round 1,
// above) fixed path canonicalization and the read-only allowlist, but a second live run — this time with
// the kernel's own unified log checked directly for sandbox denials — proved the member process was dying
// BEFORE the sandbox ever judged anything: zero denial entries for bun/the member stub/any levare path,
// while a hand-run `sandbox-exec -f /tmp/allow.sb ~/.bun/bin/bun --version` on the SAME host succeeded
// cleanly. The defect is in how this module composes the wrapped argv/profile for `sandbox-exec`, not in
// what the profile allows. Two changes follow directly from that evidence:
//
// - The profile is now written to a TEMP FILE and passed via `-f <path>` (the exact form verified working
//   by hand on the live host) rather than inlined via `-p <string>` (never independently verified — the
//   live host's own manual check used `-f`, not `-p`, and this module had no evidence either way that a
//   long, multi-line profile string survives `-p` intact).
// - `LEVARE_SANDBOX_DEBUG=1` prints the fully composed argv (one element per line, unambiguous even with
//   embedded whitespace/newlines), the profile file's path and text, and the cwd — BEFORE the spawn even
//   runs — plus (adapters.ts) the raw spawn result (exitCode, signalCode, stdout/stderr byte counts, and
//   stderr's own text) after it returns. `adapters.ts#cliResultToDoc` also now receives the WRAPPED argv
//   for its own error message, never the pre-wrap member argv — a failed spawn used to report what the
//   MEMBER would have been invoked with had sandboxing never run, which is not what actually executed and
//   made "is the wrapper even engaging" impossible to tell from the error text alone.
//
// What this does NOT claim: the root cause is not yet conclusively isolated to `-p` vs. `-f` specifically —
// only that `-f` is the one form directly verified on the live host, and the debug output above is what a
// third live run needs to confirm or refute it precisely, rather than guessing again from a Linux-only
// vantage point. See NOTES R4-SANDBOX-FIX's own "still requires a live host" section for the full list of
// what remains unconfirmed.

import { existsSync, realpathSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type SandboxLevel = "full" | "fs-only" | "none";
export type SandboxPrimitive = "bubblewrap" | "unshare" | "sandbox-exec" | "none";

export interface SandboxDetection {
  platform: string;
  primitive: SandboxPrimitive;
  level: SandboxLevel;
  /** Resolved path to the primitive binary — undefined when `primitive === "none"`. Threaded from
   * detection into argv construction so the wrapper never re-resolves a bare name via a possibly
   * different PATH than the one detection just verified against. */
  bin?: string;
}

export interface SandboxDetectOptions {
  /** Test-only override — default `process.platform`. */
  platform?: string;
  /** Test-only override for binary resolution — default `Bun.which`. */
  which?: (cmd: string) => string | null;
  /** Test-only override for "does this primitive actually work" — default a real, silent spawnSync
   * checking exit 0. Never assumed from presence alone (a binary can be on PATH and still fail every
   * invocation — see this module's own header comment). */
  probe?: (argv: string[]) => boolean;
}

function realWhich(cmd: string): string | null {
  return Bun.which(cmd) ?? null;
}

function realProbe(argv: string[]): boolean {
  try {
    const r = Bun.spawnSync(argv, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

// NOTES R4-SANDBOX-FIX (round 2): a real temp-file probe, matching `sandboxExecArgv`'s own `-f`/no-`--`
// shape exactly — see `detectSandbox`'s own comment at its call site for why "probe what production
// actually runs" matters here specifically.
function probeSandboxExec(bin: string, probe: (argv: string[]) => boolean): boolean {
  const scratchDir = mkdtempSync(join(tmpdir(), "levare-sandbox-probe-"));
  try {
    const profilePath = join(scratchDir, "probe.sb");
    writeFileSync(profilePath, "(version 1)(allow default)");
    return probe([bin, "-f", profilePath, "true"]);
  } finally {
    try {
      rmSync(scratchDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Detect which OS sandbox primitive, if any, actually works on this host RIGHT NOW — never inferred
 * from `platform` alone (the goal's own instruction: "never assume one exists because the platform
 * suggests it should"). Called fresh at doctor time AND at every real spawn (adapters.ts) — no
 * process-lifetime caching, since a probe costs one cheap subprocess and the alternative (a stale
 * "works"/"doesn't" belief outliving a host's actual state) is the exact honesty gap this module exists
 * to close.
 */
export function detectSandbox(opts: SandboxDetectOptions = {}): SandboxDetection {
  const platform = opts.platform ?? process.platform;
  const which = opts.which ?? realWhich;
  const probe = opts.probe ?? realProbe;

  if (platform === "linux") {
    const bwrap = which("bwrap");
    if (bwrap && probe([bwrap, "--ro-bind", "/", "/", "--dev", "/dev", "--unshare-net", "--die-with-parent", "--", "true"])) {
      return { platform, primitive: "bubblewrap", level: "full", bin: bwrap };
    }
    const unshareBin = which("unshare");
    if (unshareBin && probe([unshareBin, "--user", "--map-root-user", "--mount", "--", "true"])) {
      return { platform, primitive: "unshare", level: "fs-only", bin: unshareBin };
    }
    return { platform, primitive: "none", level: "none" };
  }
  if (platform === "darwin") {
    const sbx = which("sandbox-exec") ?? (existsSync("/usr/bin/sandbox-exec") ? "/usr/bin/sandbox-exec" : null);
    // NOTES R4-SANDBOX-FIX (round 2): probes the EXACT invocation shape the real wrap now uses (`-f
    // <file>`, no `--`) — never a different shape than what a real spawn will actually run. Round 1's
    // probe used `-p <string> -- true`, which could report "functional" while the real, file-based,
    // `--`-less form (or vice versa) behaved differently; a probe that doesn't match production is a
    // probe that can't be trusted to mean what it says.
    if (sbx && probeSandboxExec(sbx, probe)) {
      return { platform, primitive: "sandbox-exec", level: "full", bin: sbx };
    }
    return { platform, primitive: "none", level: "none" };
  }
  return { platform, primitive: "none", level: "none" };
}

export interface SandboxPolicy {
  /** Read-write. The per-dispatch worktree (merge.ts) when one exists, else the process's own cwd. */
  cwd: string;
  /** Read-write. The (possibly scratch-scoped, env.ts#scopeHome) HOME the spawn's env already carries. */
  home?: string;
  /** Best-effort — denied unless the member holds at least one granted connector (env.ts#
   * memberNetworkAllowed): every connector this codebase has is levare's own declared way of naming an
   * external reach (an mcp server, a wrapped tool's remote backend, a subscription model's own API) —
   * holding none is the only case with nothing to reach for. */
  allowNetwork: boolean;
  /** Read-only. Extra paths this specific dispatch needs beyond the platform's own baseline system
   * paths — the studio root (adapters.ts always includes it: a command checked into the studio, or a
   * `context_artifacts: paths` member's consumed-artifact reads, both need it), the running levare
   * binary's own directory, and wherever this dispatch's own argv[0] resolves to (the interpreter
   * actually being spawned, which may live somewhere the platform baseline doesn't cover — a
   * Homebrew/user-local install, `~/.bun`, etc.). Absent/empty is a legal no-op. */
  readOnlyPaths?: string[];
}

export interface WrappedSpawn {
  argv: string[];
  level: SandboxLevel;
  /** Cleanup for any scratch resource this wrap created — currently only `sandbox-exec`'s own temp
   * profile file (see `sandboxExecArgv`). A no-op (or absent) for every other tier: bwrap/unshare/none
   * write nothing to disk. The caller (`adapters.ts`) MUST call this after the spawn completes, success
   * or thrown error alike — the same create-immediately-before/clean-up-immediately-after shape
   * `merge.ts#createDispatchWorktree`/`env.ts#scopeHome` already establish for their own scratch
   * resources. */
  cleanup?: () => void;
}

// NOTES R4-SANDBOX-FIX (round 2): gated on an env var, never on-by-default — this is diagnostic-only
// output for a live host investigation, not a feature a Conductor would ever want printed on an ordinary
// run. Checked fresh every call (not cached at module load) so a test can flip it mid-run without a
// process restart.
function sandboxDebugEnabled(): boolean {
  return process.env.LEVARE_SANDBOX_DEBUG === "1";
}

function debugLine(line: string): void {
  console.error(`[levare:sandbox-debug] ${line}`);
}

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// The enumerated read-only system paths every "full"-tier sandbox opens — what a vendor CLI's own
// interpreter/dynamic linker/shared libraries need to resolve, and nothing more. `/lib64` is absent on
// several distros (this container's own Debian merged-usr layout among them) and `/bin`/`/lib` are
// frequently symlinks INTO `/usr` rather than real directories — `--ro-bind-try` (vs. plain `--ro-bind`)
// silently skips a source that doesn't exist rather than failing the whole sandbox over a path shape
// that varies by distro.
const READONLY_SYSTEM_PATHS = ["/usr", "/bin", "/lib", "/lib64", "/etc"];

// Full: filesystem AND network confined, built from an EMPTY root (`--tmpfs /`) rather than binding the
// real one — "nothing else" (this module's own header) is true of reads, not just writes: nothing
// outside `READONLY_SYSTEM_PATHS` plus the two rw binds below is visible at all, proven directly by this
// module's own decoy-file test. `--die-with-parent` mirrors this codebase's existing process-group-
// kill-on-timeout precedent (adapters.ts#killProcessGroup, NOTES phase-7 K15): a sandboxed member never
// outlives the spawn that owns it.
function bubblewrapArgv(bin: string, argv: string[], policy: SandboxPolicy): string[] {
  const out = [bin, "--tmpfs", "/"];
  for (const p of READONLY_SYSTEM_PATHS) out.push("--ro-bind-try", p, p);
  for (const p of policy.readOnlyPaths ?? []) out.push("--ro-bind-try", p, p);
  out.push("--dev", "/dev", "--proc", "/proc", "--bind", policy.cwd, policy.cwd);
  if (policy.home) out.push("--bind", policy.home, policy.home);
  if (!policy.allowNetwork) out.push("--unshare-net");
  out.push("--die-with-parent", "--", ...argv);
  return out;
}

// fs-only fallback: no bubblewrap binary, but the kernel still allows an unprivileged user+mount
// namespace (the same mechanism bwrap itself relies on internally). Standard trick: bind-mount `/` onto
// itself first (so the later remount only touches this bind, never the real mount table), bind-mount
// the writable roots on TOP of that (still writable — mounted after, at their own path), then remount
// the outer `/` bind read-only. Network is deliberately not attempted here — see this module's header.
function unshareArgv(bin: string, argv: string[], policy: SandboxPolicy): string[] {
  const script = [
    "set -e",
    "mount --bind / /",
    `mount --bind ${shq(policy.cwd)} ${shq(policy.cwd)}`,
    policy.home ? `mount --bind ${shq(policy.home)} ${shq(policy.home)}` : "",
    "mount -o remount,bind,ro /",
    'exec "$@"',
  ]
    .filter(Boolean)
    .join(" && ");
  return [bin, "--user", "--map-root-user", "--mount", "--", "sh", "-c", script, "sh", ...argv];
}

function sbxq(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// The macOS equivalent of READONLY_SYSTEM_PATHS above — the paths dyld/the standard frameworks actually
// need to resolve a normal process, kept to the same "enumerated, not the whole disk" shape as the
// bubblewrap tier for the SAME "full" guarantee across platforms. `/opt/homebrew` (Apple Silicon) and
// `/usr/local` (Intel, and generic Unix-local installs) are included unconditionally — NOTES
// R4-SANDBOX-FIX's own live-host finding: a vendor CLI or the interpreter running it (`bun`, `git`,
// `node`, …) very commonly lives under one of these on a real macOS dev machine, and neither is under
// `/usr`/`/System`/`/Library`.
const SANDBOX_EXEC_READONLY_PATHS = ["/usr", "/bin", "/System", "/Library", "/private/etc", "/opt/homebrew", "/usr/local"];

/**
 * NOTES R4-SANDBOX-FIX: `realpathSync`, falling back to the literal string when the path doesn't exist
 * (this module's own pure unit tests pass fixture paths like `/work/scratch-wt` that are never actually
 * created on disk — those must keep resolving to themselves, not throw). `sandbox-exec`'s `(subpath ...)`
 * rules match the KERNEL-RESOLVED form of a path — on macOS, `/tmp` and `/var/folders` (where
 * `os.tmpdir()` lives, and therefore where every scratch worktree/HOME this module scopes actually sits)
 * are themselves symlinks into `/private`, so a profile written with the pre-resolution path silently
 * never matches. The same lesson as the phase-1 immutability fix (commit b9ae0f1): a path comparison that
 * ignores the filesystem's own symlink layer is comparing the wrong thing.
 */
function canon(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Exported for its own unit test — the profile TEXT is the thing worth asserting on. The canonicalization
 * this function performs is proven directly (a real symlinked tmp dir, asserting the profile names the
 * RESOLVED path); the rest of the macOS path — `sandbox-exec` actually enforcing what the profile says —
 * is exercised only by construction in this repo's own Linux-only test suite, never live (recorded
 * honestly, NOTES R4-SANDBOX/R4-SANDBOX-FIX, rather than claimed as verified). */
export function buildSandboxExecProfile(policy: SandboxPolicy): string {
  const readOnly = [...SANDBOX_EXEC_READONLY_PATHS, ...(policy.readOnlyPaths ?? [])];
  const cwd = canon(policy.cwd);
  const home = policy.home ? canon(policy.home) : undefined;
  const lines = [
    "(version 1)",
    "(deny default)",
    "(allow process-fork)",
    "(allow process-exec)",
    ...readOnly.map((p) => `(allow file-read* (subpath ${sbxq(canon(p))}))`),
    `(allow file-write* (subpath ${sbxq(cwd)}))`,
    home ? `(allow file-write* (subpath ${sbxq(home)}))` : "",
    '(allow file-read* (subpath "/dev"))',
    '(allow file-write* (subpath "/dev"))',
    policy.allowNetwork ? "(allow network*)" : "(deny network*)",
  ].filter(Boolean);
  return lines.join("\n");
}

// NOTES R4-SANDBOX-FIX (round 2): `-f <file>` — the exact invocation form verified working by hand on a
// live macOS host (`sandbox-exec -f /tmp/allow.sb ~/.bun/bin/bun --version`) — never `-p <string>`, which
// this module used before round 2 and which no live run ever independently confirmed. The temp file is
// written fresh per spawn (mirroring `merge.ts#createDispatchWorktree`/`env.ts#scopeHome`'s own per-spawn
// scratch resources) and removed by the returned `cleanup()`, which the caller MUST invoke after the spawn
// completes. No `--` before the command: `man sandbox-exec`'s own documented forms
// (`sandbox-exec -f file command [args...]`) never show one, and the live host's own manual verification
// didn't use one either — inserting an unverified separator between the profile and the command is exactly
// the kind of composition difference this round's own investigation exists to eliminate, not add another of.
function sandboxExecArgv(bin: string, argv: string[], policy: SandboxPolicy): { argv: string[]; cleanup: () => void } {
  const profile = buildSandboxExecProfile(policy);
  const scratchDir = mkdtempSync(join(tmpdir(), "levare-sandbox-profile-"));
  const profilePath = join(scratchDir, "profile.sb");
  writeFileSync(profilePath, profile);
  if (sandboxDebugEnabled()) {
    debugLine(`darwin sandbox-exec profile written to: ${profilePath}`);
    debugLine(`darwin sandbox-exec profile text:\n${profile}`);
  }
  let cleaned = false;
  return {
    argv: [bin, "-f", profilePath, ...argv],
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      try {
        rmSync(scratchDir, { recursive: true, force: true });
      } catch {
        /* best-effort — a leftover scratch profile file is not worth failing the run over */
      }
    },
  };
}

/**
 * Wrap `argv` for the primitive `detection` reports. `bubblewrap`/`unshare`/`none` are side-effect-free
 * and directly unit-testable without ever invoking a real sandbox; the `sandbox-exec` path additionally
 * reads the filesystem (`realpathSync`, to canonicalize a path before writing it into the profile — see
 * `buildSandboxExecProfile`'s own doc) and WRITES the generated profile to a scratch temp file (never
 * throws either way — a path that doesn't exist yet just resolves to itself, and the write target is
 * always a fresh directory this function itself just created). `detection.primitive === "none"` returns
 * `argv` unchanged, `level: "none"` — the honest unsandboxed-spawn case, never a thrown error (the goal's
 * own ruling: best-effort per OS, an unsandboxed platform is never escalated to a spawn failure).
 *
 * `LEVARE_SANDBOX_DEBUG=1` prints the fully composed argv (one element per line) and the cwd/home this
 * wrap targeted, for every tier including `none` — a live host investigation needs to see "the wrapper
 * decided not to wrap this" exactly as clearly as "here is what it wrapped it into".
 */
export function wrapForSandbox(argv: string[], policy: SandboxPolicy, detection: SandboxDetection): WrappedSpawn {
  let result: WrappedSpawn;
  if (detection.primitive === "bubblewrap" && detection.bin) {
    result = { argv: bubblewrapArgv(detection.bin, argv, policy), level: "full" };
  } else if (detection.primitive === "unshare" && detection.bin) {
    result = { argv: unshareArgv(detection.bin, argv, policy), level: "fs-only" };
  } else if (detection.primitive === "sandbox-exec" && detection.bin) {
    const wrapped = sandboxExecArgv(detection.bin, argv, policy);
    result = { argv: wrapped.argv, level: "full", cleanup: wrapped.cleanup };
  } else {
    result = { argv, level: "none" };
  }
  if (sandboxDebugEnabled()) {
    debugLine(`level: ${result.level} (primitive: ${detection.primitive})`);
    debugLine(`cwd: ${policy.cwd}`);
    if (policy.home) debugLine(`home: ${policy.home}`);
    debugLine("composed argv:");
    result.argv.forEach((a, i) => debugLine(`  [${i}] ${JSON.stringify(a)}`));
  }
  return result;
}

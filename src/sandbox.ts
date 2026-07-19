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

import { existsSync, realpathSync } from "node:fs";

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
    if (sbx && probe([sbx, "-p", "(version 1)(allow default)", "--", "true"])) {
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

function sandboxExecArgv(bin: string, argv: string[], policy: SandboxPolicy): string[] {
  return [bin, "-p", buildSandboxExecProfile(policy), "--", ...argv];
}

/**
 * Wrap `argv` for the primitive `detection` reports. Side-effect-free and directly unit-testable without
 * ever invoking a real sandbox (`detection` is an ordinary value, not a live probe) — the `sandbox-exec`
 * path does read the filesystem (`realpathSync`, to canonicalize a path before writing it into the
 * profile — see `buildSandboxExecProfile`'s own doc), never writes anything, and never throws (a path
 * that doesn't exist yet just resolves to itself). `detection.primitive === "none"` returns `argv`
 * unchanged, `level: "none"` — the honest unsandboxed-spawn case, never a thrown error (the goal's own
 * ruling: best-effort per OS, an unsandboxed platform is never escalated to a spawn failure).
 */
export function wrapForSandbox(argv: string[], policy: SandboxPolicy, detection: SandboxDetection): WrappedSpawn {
  if (detection.primitive === "bubblewrap" && detection.bin) return { argv: bubblewrapArgv(detection.bin, argv, policy), level: "full" };
  if (detection.primitive === "unshare" && detection.bin) return { argv: unshareArgv(detection.bin, argv, policy), level: "fs-only" };
  if (detection.primitive === "sandbox-exec" && detection.bin) return { argv: sandboxExecArgv(detection.bin, argv, policy), level: "full" };
  return { argv, level: "none" };
}

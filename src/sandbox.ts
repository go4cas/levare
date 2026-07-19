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
// (env.ts#scopeHome, read-write), and a small, ENUMERATED set of read-only system paths a vendor CLI's
// own interpreter/libraries need to resolve (`/usr`, `/bin`, `/lib`, `/lib64`, `/etc`, `/dev`, `/proc`)
// — nothing else. Bubblewrap builds this root from an empty `--tmpfs /` rather than `--ro-bind / /`,
// specifically so "nothing else" is true of READS too, not just writes: a decoy anywhere outside that
// list — including the studio root itself — is genuinely unreadable, proven directly by this module's
// own decoy-file test (tests/adapters.test.ts). The named, honest cost: a member declaring
// `context_artifacts: paths` (context.ts) that ALSO gets sandboxed can no longer read its consumed
// artifacts off the studio filesystem the way an unsandboxed member could — recorded as a residual
// (NOTES R4-SANDBOX), not silently papered over with a broader allowlist that would have defeated the
// decoy test's own point.
//
// "fs-only" (the unshare fallback) is honestly WEAKER, not merely net-less: reconstructing bubblewrap's
// own empty-root-plus-allowlist construction by hand, without bwrap's own tooling, is real additional
// complexity for a tier this ruling already treats as best-effort — so it takes the simpler, well-known
// "remount / read-only, bind cwd/home read-write on top" shape instead. That confines WRITES to exactly
// the declared roots, but a decoy elsewhere on disk remains READABLE (never writable) under this tier
// specifically — the decoy-file test therefore only asserts against "full", and this asymmetry is named
// here rather than implied to be uniform across tiers.

import { existsSync } from "node:fs";

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
// bubblewrap tier for the SAME "full" guarantee across platforms.
const SANDBOX_EXEC_READONLY_PATHS = ["/usr", "/bin", "/System", "/Library", "/private/etc"];

/** Exported for its own unit test — the profile TEXT is the thing worth asserting on, independent of
 * ever running `sandbox-exec` for real (this container is Linux; the macOS path is exercised only by
 * construction, never live — recorded honestly, NOTES R4-SANDBOX, rather than claimed as verified). */
export function buildSandboxExecProfile(policy: SandboxPolicy): string {
  const lines = [
    "(version 1)",
    "(deny default)",
    "(allow process-fork)",
    "(allow process-exec)",
    ...SANDBOX_EXEC_READONLY_PATHS.map((p) => `(allow file-read* (subpath ${sbxq(p)}))`),
    `(allow file-write* (subpath ${sbxq(policy.cwd)}))`,
    policy.home ? `(allow file-write* (subpath ${sbxq(policy.home)}))` : "",
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
 * Wrap `argv` for the primitive `detection` reports — a pure function (no I/O), so the argv SHAPE for
 * every tier is directly unit-testable without ever invoking a real sandbox. `detection.primitive ===
 * "none"` returns `argv` unchanged, `level: "none"` — the honest unsandboxed-spawn case, never a thrown
 * error (the goal's own ruling: best-effort per OS, an unsandboxed platform is never escalated to a
 * spawn failure).
 */
export function wrapForSandbox(argv: string[], policy: SandboxPolicy, detection: SandboxDetection): WrappedSpawn {
  if (detection.primitive === "bubblewrap" && detection.bin) return { argv: bubblewrapArgv(detection.bin, argv, policy), level: "full" };
  if (detection.primitive === "unshare" && detection.bin) return { argv: unshareArgv(detection.bin, argv, policy), level: "fs-only" };
  if (detection.primitive === "sandbox-exec" && detection.bin) return { argv: sandboxExecArgv(detection.bin, argv, policy), level: "full" };
  return { argv, level: "none" };
}

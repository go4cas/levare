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
//   "full"     — filesystem AND network confined — but NOT the identical SHAPE of confinement on both
//                OSes as of round 3 (NOTES R4-SANDBOX-FIX-3), and this is recorded honestly rather than
//                implied uniform: on LINUX (bubblewrap), it means an enumerated allow-list built from an
//                EMPTY root — nothing is reachable unless explicitly named, the strongest guarantee this
//                module makes. On MACOS (sandbox-exec), it means the OS is broadly readable (as an
//                unsandboxed process would see it) with the OPERATOR'S OWN USER DATA explicitly denied
//                except for a short, explicit re-allow list — a deny-list, not an allow-list, forced by a
//                live-host finding that an allow-list is unwinnable against dyld on this platform (see the
//                round 3 comment block below for the full bisection). Both satisfy the actual threat model
//                (a member must not read the operator's dotfiles, other projects, or the studio beyond its
//                grants) — they just satisfy it by different, non-equivalent means, and doctor/the
//                registry/a produced artifact's own `sandbox: full` must never be read as "these two
//                platforms enforce identically."
//   "fs-only"  — filesystem confined via a raw `unshare` mount-namespace fallback (no bubblewrap
//                binary, but the kernel still permits unprivileged user+mount namespaces); network is
//                NOT attempted at this tier — reconstructing a working net-namespace by hand without
//                bwrap's own machinery is real extra complexity for a fallback path whose own governing
//                ruling already calls network "best-effort", not a hard condition.
//   "none"     — no primitive worked at all. Recorded, never silently absent.
//
// Filesystem, at the "full" tier on LINUX, is a HARD condition taken literally: the process can reach its
// per-dispatch worktree (merge.ts#createDispatchWorktree, read-write), its scopeHome scratch HOME
// (env.ts#scopeHome, read-write), a small ENUMERATED set of read-only system paths a vendor CLI's own
// interpreter/dynamic linker/libraries need to resolve, the studio root itself (read-only — a command
// checked into the studio, or a `context_artifacts: paths` member's consumed-artifact reads, both need
// this), and the currently-running levare binary's own directory plus wherever THIS dispatch's own
// argv[0] resolves to (read-only — the interpreter actually being spawned) — nothing else. A decoy
// anywhere outside that list — an unrelated scratch directory, the operator's own home, another user's
// files — is genuinely unreadable, proven directly by this module's own decoy-file test
// (tests/adapters.test.ts). On MACOS at the "full" tier (round 3, below), the hard condition is narrower
// in scope: the operator's OWN user data (`$HOME`, `/Users`, `/Volumes`) is what a decoy must be planted
// under to prove denial — the rest of the OS is deliberately readable, by design, not by gap.
//
// NOTES R4-SANDBOX-FIX (macOS host verification, first live run): the original design excluded the
// studio root entirely, on the theory that "nothing else" should be as strict as possible. A live macOS
// run — where `sandbox-exec` actually engages, unlike this repo's own Linux dev container, which only
// ever detects `none` — proved that theory wrong in practice: most of this repo's OWN test fixtures spawn
// commands (stub scripts, `bun` itself) that live IN the studio tree, and every one of them broke. The
// studio root is now a deliberate, named exception to "nothing else" — narrower than the pre-fix
// "ro-bind the whole disk" design this module never shipped, but broader than the post-fix-attempt
// "enumerated system paths only" design that turned out to break ordinary, expected usage. (This
// enumerated-allowlist-plus-studio-root shape is what Linux/bubblewrap STILL uses today — round 3, below,
// only changes the macOS/sandbox-exec model; the studio root's inclusion in `readOnlyPaths` is shared by
// both platforms regardless, since macOS's broad `/` read trivially covers it either way.)
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

// NOTES R4-SANDBOX-FIX-3 (round 3 — live macOS bisection, 14 hand-run profiles): round 2's fix (the `-f`
// temp file, no `--`) made the wrapper compose correctly — `LEVARE_SANDBOX_DEBUG` confirmed the composed
// argv, and the sandbox DID apply. The process still died. The crash report's own stack (dyld4::
// CacheFinder → ignition_halt → abort_with_reason, SIGABRT before `main()` ever runs) named the actual
// failure: dyld's shared-cache lookup aborts when it cannot get the data-read access it needs, and that
// access path is not externally documented or discoverable — the round 1 design's own enumerated
// read-only allowlist (`/usr`, `/bin`, `/System`, `/System/Volumes`, `/System/Cryptexes`, `/Library`,
// every `/private/*` variant, `/opt/homebrew`, `/usr/local`, `~/.bun`, ancestor-directory metadata, even
// a blanket `file-read-metadata` on `/`) was bisected exhaustively on the live host — fourteen profiles,
// each verified by direct execution — and EVERY enumerated-allowlist variant aborts identically. A
// default-deny, explicitly-enumerate-every-read model is unwinnable against dyld on this macOS (26.5):
// there is no finite list of paths that satisfies it, because the actual need isn't expressible as a
// finite list at all.
//
// What DOES work, verified green on the same host: flip the model. `(allow file-read* (subpath "/"))` —
// the OS is broadly readable, by default, the same as an unsandboxed process — then explicitly DENY the
// operator's own user data (`$HOME`, `/Users`, `/Volumes`), then re-allow exactly the paths this dispatch
// actually needs (which, being a short, concrete list — a worktree, a scoped HOME grant, an interpreter's
// own install tree — IS expressible finitely, unlike "everything dyld might ever touch"). Seatbelt's own
// later-rule-wins semantics makes this a deny-LIST rather than an allow-list: broad OS read by default,
// user data denied except by explicit grant.
//
// This is a genuine model change, not a tuning of the same one: macOS's `full` and Linux's `full` no
// longer mean the same shape of confinement, and callers that render `sandbox: full` (doctor, the
// registry, a produced artifact's own frontmatter) must not imply otherwise. Linux `bubblewrap` KEEPS its
// original allow-list-from-empty-root construction, deliberately unchanged by this round: it is proven,
// it is stronger (a decoy ANYWHERE outside the explicit allow-list is unreadable, which the darwin model
// cannot claim for anything under `/usr`/`/System`/etc.), and nothing in this round's own live evidence
// argues against it — the bisection that forced macOS's hand is a macOS-specific fact about dyld's own
// shared-cache mechanism, not a general argument against enumerated allow-lists as such.
//
// The darwin decoy-file test's own meaning survives this change intact, just narrower in SCOPE, not
// weaker in KIND: a file under the operator's `$HOME` outside the explicitly re-allowed set is still
// genuinely unreadable — proven the identical way (plant it, try to read it, confirm failure) — it is
// simply no longer true that literally everything outside a short allow-list is unreadable, because nothing
// on this OS can make that claim survive contact with dyld.

// NOTES R4-SANDBOX-FIX-4 (round 4 — live macOS gate: 9 failures remaining, down from 20, with
// `LEVARE_SANDBOX_DEBUG` output convicting the generated profile directly): round 3's deny-list SHAPE was
// right, but the generator had two real bugs and one cosmetic one, all visible in a captured profile:
//
// DEFECT 1 (security — the deny was defeated, and is why the round-3 decoy-file test itself failed): a
// member with no genuinely SCOPED HOME has `req.env.HOME` resolve to the operator's own real HOME —
// `buildMemberEnv` allowlists it through unconditionally regardless of scoping — and the round-3 generator
// re-allowed `policy.home` unconditionally whenever present, which blanket re-allowed the operator's ENTIRE
// real home, read AND write, in exactly the common (no subscription grant) case. Fixed: `home` is only
// ever a genuine re-allow target when it's both present and, after canonicalization, DIFFERENT from
// `operatorHome` — a member with no scoped HOME gets exactly three things re-allowed: its dispatch
// worktree, `readOnlyPaths`, and `/dev`.
//
// DEFECT 2 (crash — a NEW, different signature than round 3's dyld abort): the profile denied `/Users`
// broadly and never re-allowed the intermediate path COMPONENTS between it and a re-allowed path further
// down (e.g. `/Users/cas/source/levare` needs `/Users` and `/Users/cas` to even be TRAVERSABLE before the
// target's own `subpath` re-allow is ever consulted) — path resolution dies at the first denied ancestor.
// The crash report's own signature is DIFFERENT from round 3's dyld abort and worth naming as its own
// recognizable symptom: `SIGTRAP` inside `std::__call_once` — bun is written in Zig, and Zig panics trap
// rather than raising a signal a Conductor would read as "the OS denied something"; it is bun itself
// panicking on an unexpected `EPERM` during early init. Fixed: every re-allowed path gets
// `(allow file-read-metadata (literal ...))` for each of its own ancestor directories, placed after the
// denies (`ancestorsOf`) — existence/stat access only, never contents, and `literal` rather than `subpath`
// so a sibling directory at the same level gains nothing from it.
//
// The design tension DEFECT 1 exposes, and its resolution: the dispatch worktree and `readOnlyPaths`
// (interpreter tree, member command directory, studio root) themselves routinely live UNDER the operator's
// real HOME on a real macOS dev machine (`/Users/cas/source/levare`, `/Users/cas/.bun`, …) — the exact
// thing DEFECT 1's fix now denies by default. This is not a contradiction: DEFECT 2's fix (ancestor
// metadata) is what makes DEFECT 1's fix VIABLE at all — without surgical per-path re-allows carved out
// with their own ancestor traversal restored, denying the operator's home broadly would have taken the
// worktree/readOnlyPaths down with it. Fixing the crash first is what makes fixing the security bug not
// also break every ordinary dispatch.
//
// DEFECT 3 (cosmetic): `adapters.ts#sandboxWrap` can legitimately compute the SAME resolved path twice
// (e.g. the running levare binary and the member's own resolved command are both `bun`) — every line the
// generator emits is now deduplicated (`dedupe`), not just the inputs, so duplication can't survive
// whichever upstream computation produced it.
//
// The decoy-file test's own meaning is UNCHANGED by this round: a file under the operator's `$HOME`
// outside the granted set must be unreadable — round 4 is what makes that claim actually TRUE for the
// common case again, having been silently false since round 3 shipped.

import { existsSync, realpathSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";

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
// NOTES R4-SANDBOX-FIX-5 (round 5, terminal live-host conviction — the weak-canary lesson): rounds 1-4's
// own probe ran `sandbox-exec -f <profile> <bin> --version` — and `--version` was the bug. A vendor
// binary's `--version` path exits before its own script-mode/child-spawn startup ever runs; a REAL
// dispatch (bun executing a member's own script file) reads a battery of sysctls at that startup
// (`kern.osproductversion`, `kern.bootargs`, `security.mac.lockdown_mode_state`, `kern.osvariant_status`,
// `hw.pagesize_compat`) that `--version` alone never touches — which is exactly why every earlier probe
// AND every earlier profile unit test passed while every real dispatch died. A probe that exercises a
// narrower code path than production is not a probe at all; it's a canary that never sings.
//
// Fixed: the probe now runs a trivial SCRIPT FILE through the SAME interpreter a real dispatch uses
// (`bun`, resolved via `Bun.which` — falling back to `process.execPath` only if bun genuinely isn't on
// PATH separately from this process, e.g. a fully standalone compiled deployment; noted, not solved,
// since that fallback can't distinguish "run this script" from "here are some CLI args" for the compiled
// `levare` binary itself), under a profile built by `buildSandboxExecProfile` ITSELF — the identical
// generator a real dispatch uses, with a policy shaped like a real one (`readOnlyPaths` naming the
// interpreter's own install tree, `operatorHome` set) — never a bespoke, weaker `(allow default)` profile
// that would prove nothing about what this module actually generates.
function probeSandboxExec(bin: string, probe: (argv: string[]) => boolean): boolean {
  const scratchDir = mkdtempSync(join(tmpdir(), "levare-sandbox-probe-"));
  try {
    const scriptPath = join(scratchDir, "probe.js");
    writeFileSync(scriptPath, "// levare sandbox probe — a trivial script, run through the real interpreter\n");
    const interpreter = Bun.which("bun") ?? process.execPath;
    const profile = buildSandboxExecProfile({
      cwd: scratchDir,
      allowNetwork: false,
      operatorHome: homedir(),
      readOnlyPaths: [dirname(interpreter), dirname(dirname(interpreter))],
    });
    const profilePath = join(scratchDir, "probe.sb");
    writeFileSync(profilePath, profile);
    return probe([bin, "-f", profilePath, interpreter, scriptPath]);
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
   * Homebrew/user-local install, `~/.bun`, etc.). Absent/empty is a legal no-op. On Linux (bubblewrap)
   * these are the entirety of what's readable beyond `cwd`/`home`; on macOS (round 3) they are RE-ALLOWS
   * layered on top of a broader OS-wide read default — see `buildSandboxExecProfile`'s own doc. */
  readOnlyPaths?: string[];
  /**
   * NOTES R4-SANDBOX-FIX-3 (macOS only — bubblewrap's own allow-list model never reads this field). The
   * operator's REAL, unscoped `$HOME` (e.g. `/Users/cas`) — denied broadly on the darwin deny-list model,
   * with `readOnlyPaths`/`home`/`grantedHomeTargets` layered back on top as explicit re-allows. Undefined
   * when the real HOME can't be determined (no deny is emitted for it in that case — `/Users`/`/Volumes`
   * still are, unconditionally).
   */
  operatorHome?: string;
  /**
   * NOTES R4-SANDBOX-FIX-3 (macOS only). The RESOLVED real filesystem paths a granted `auth: subscription`
   * connector's own `home:` dotpaths point at (e.g. `/Users/cas/.codex` for a connector declaring `home:
   * [".codex"]`) — distinct from `home` above (the member's own scratch-scoped `$HOME`, which may contain
   * SYMLINKS to these same real targets): denying the operator's `$HOME` broadly would also deny reading
   * THROUGH those symlinks to their real targets unless the targets themselves are explicitly re-allowed.
   * Absent/empty is a legal no-op (no subscription grant, or one declaring no `home:`).
   */
  grantedHomeTargets?: string[];
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

/**
 * NOTES R4-SANDBOX-FIX (round 1) / R4-SANDBOX-FIX-3 (round 3): `realpathSync`, falling back to the
 * literal string when the path doesn't exist (this module's own pure unit tests pass fixture paths like
 * `/work/scratch-wt` that are never actually created on disk — those must keep resolving to themselves,
 * not throw). `sandbox-exec`'s `(subpath ...)` rules match the KERNEL-RESOLVED form of a path — on macOS,
 * `/tmp`, `/var/folders` (where `os.tmpdir()` lives), and the operator's own `$HOME` can all sit behind
 * symlinks, so a profile written with the pre-resolution path silently never matches. The same lesson as
 * the phase-1 immutability fix (commit b9ae0f1): a path comparison that ignores the filesystem's own
 * symlink layer is comparing the wrong thing. Round 3 canonicalizes the DENY targets too (`operatorHome`),
 * not just the re-allows — a deny written against the wrong (symlinked) spelling would silently fail to
 * deny anything, which is the opposite failure mode from a re-allow that silently fails to re-allow.
 */
function canon(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function dedupe<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

// NOTES R4-SANDBOX-FIX-4 (round 4, live macOS gate — DEFECT 2): every re-allowed path needs its OWN
// ancestor directories to be metadata-readable, or the kernel's own path resolution dies at the first
// denied ancestor component before the re-allow rule for the target itself is ever consulted — a
// `(subpath ...)` re-allow only ever covers the named path and what's NESTED inside it, never anything
// ABOVE it. Returns every strict ancestor of `p` (excluding `/` itself, which is trivially always
// resolvable, and excluding `p`, whose OWN re-allow already covers it) — deliberately EXHAUSTIVE (every
// intermediate component, not only the ones between the nearest denied root and the target): over-
// granting harmless metadata (existence/stat, never contents) is a far smaller risk than a second crash
// from an under-covered ancestor the next level down.
function ancestorsOf(p: string): string[] {
  const parts = p.split("/").filter(Boolean);
  const out: string[] = [];
  let acc = "";
  for (let i = 0; i < parts.length - 1; i++) {
    acc += `/${parts[i]}`;
    out.push(acc);
  }
  return out;
}

/**
 * NOTES R4-SANDBOX-FIX-3 (round 3, live macOS bisection — see this module's own header for the full
 * evidence): a DENY-LIST, not an allow-list. Fourteen hand-run profiles on a live host proved that an
 * enumerated allow-list (however broad — every system path this module's own round-1 design tried, one at
 * a time and in combination) aborts identically: dyld's own shared-cache lookup needs a data-read access
 * path that is not externally discoverable or expressible as a finite list. The only verified-working
 * shape grants broad OS reads by default and denies the operator's own user data instead.
 *
 * NOTES R4-SANDBOX-FIX-4 (round 4, live macOS gate): round 3's own shape shipped with two further bugs,
 * both visible directly in a live `LEVARE_SANDBOX_DEBUG` capture and both fixed here:
 *
 * DEFECT 1 (security — the deny was defeated). A member with no scoped HOME (`env.ts#scopeHome` never
 * ran, or ran as a no-op) has `req.env.HOME` resolve to the operator's OWN real HOME — it's allowlisted
 * through unconditionally by `buildMemberEnv` regardless of scoping. Blindly re-allowing `policy.home`
 * therefore re-allowed the operator's ENTIRE real home, read AND write, defeating the whole deny-list
 * model for the common (no subscription grant) case — this is what the round-4 decoy-file test caught.
 * Fixed: `home` is only ever treated as a genuine re-allow target when it's both present AND DIFFERENT
 * from `operatorHome` (a real scratch/scoped path, never the same directory under a different spelling —
 * `canon()` on both sides is what makes "different" a filesystem fact, not a string comparison). A member
 * with no scoped HOME gets exactly three things re-allowed: its dispatch worktree, `readOnlyPaths`, and
 * `/dev` — nothing under the operator's home at all, read or write.
 *
 * DEFECT 2 (crash — see this function's own `ancestorsOf` doc). Fixed by emitting
 * `(allow file-read-metadata (literal ...))` for every ancestor of every re-allowed path, placed AFTER
 * the denies (rule order applies to these exactly as it does to the read/write re-allows below).
 *
 * DEFECT 3 (cosmetic — duplicate rule pairs). `adapters.ts#sandboxWrap` can legitimately compute the SAME
 * path twice (e.g. the running levare binary and the member's own resolved command are both `bun`) —
 * `dedupe()` on every generated line, not just the inputs, is what makes duplication impossible
 * regardless of which upstream computation produced it.
 *
 * RULE ORDER IS LOAD-BEARING. Seatbelt's `(allow ...)`/`(deny ...)` rules are evaluated with the LAST
 * matching rule winning for a given operation — never first-match, never "most specific wins" the way some
 * other policy languages work. Every `(deny file-read* ...)` line below MUST appear BEFORE the ancestor-
 * metadata AND the `(allow file-read* ...)` re-allow lines that are meant to carve exceptions back out of
 * it; reversing the order would make the re-allows silently inert (the LATER deny would win instead) —
 * this is exactly the kind of bug this file's own comment exists to prevent a future edit from
 * reintroducing.
 *
 * Exported for its own unit test — the profile TEXT is the thing worth asserting on, including rule
 * ORDER specifically. The actual enforcement (`sandbox-exec` denying what this profile says to deny) is
 * exercised only by construction in this repo's own Linux-only test suite, never live — recorded
 * honestly (NOTES R4-SANDBOX/R4-SANDBOX-FIX through -FIX-4) rather than claimed as verified beyond what
 * the live-host gate itself already confirmed (the shape below, not this exact generated text).
 */
export function buildSandboxExecProfile(policy: SandboxPolicy): string {
  const cwd = canon(policy.cwd);
  const operatorHome = policy.operatorHome ? canon(policy.operatorHome) : undefined;
  // DEFECT 1: only a genuinely DIFFERENT, scoped HOME is ever a re-allow target — never the operator's
  // own real home under whatever spelling it happened to arrive as.
  const rawHome = policy.home ? canon(policy.home) : undefined;
  const scopedHome = rawHome && rawHome !== operatorHome ? rawHome : undefined;
  const grantedTargets = (policy.grantedHomeTargets ?? []).map(canon);
  const readOnly = (policy.readOnlyPaths ?? []).map(canon);

  const reallowReads = dedupe([cwd, ...(scopedHome ? [scopedHome] : []), ...grantedTargets, ...readOnly]);
  const reallowWrites = dedupe([cwd, ...(scopedHome ? [scopedHome] : [])]);
  // DEFECT 2: ancestor metadata for every read re-allow — write re-allows are a subset of reallowReads
  // already, so their own ancestors are already covered here, not computed a second time.
  const ancestorMetadata = dedupe(reallowReads.flatMap(ancestorsOf));

  const lines = dedupe(
    [
      "(version 1)",
      "(deny default)",
      "(allow process-fork)",
      "(allow process-exec)",
      // NOTES R4-SANDBOX-FIX-5 (round 5, live-host conviction): process-bootstrap plumbing, not user
      // data — script-mode `bun` (and plausibly any modern runtime) reads a battery of sysctls at child-
      // spawn startup (`kern.osproductversion`, `kern.bootargs`, `security.mac.lockdown_mode_state`,
      // `kern.osvariant_status`, `hw.pagesize_compat`), and a denied sysctl-read there is what produced
      // the `SIGTRAP` inside `std::__call_once` — a cached OS-version initializer panicking on the
      // failed read, not a sandbox violation in the sense this profile's own denies are meant to express.
      // Exposes kernel PARAMETERS (OS version, page size, boot flags), never user data — allowing it does
      // not weaken the threat model this profile enforces (operator data still denied, network still
      // denied by default). `(allow file-ioctl)` was deliberately NOT added alongside it: live testing
      // proved `sysctl-read` alone is sufficient, and the tty/`dtracehelper` `file-ioctl` denials observed
      // are cosmetic soft denials (NOTES R4-SANDBOX-FIX-3's own finding 5), not a second gap to chase.
      "(allow sysctl-read)",
      // Broad OS read, same as an unsandboxed process would see — verified live: this is the only shape
      // that lets dyld's own shared-cache lookup succeed on this platform (see this module's header).
      '(allow file-read* (subpath "/"))',
      // --- Denies below, ancestor metadata + re-allows after: order is load-bearing (see this
      // function's own doc). ---
      operatorHome ? `(deny file-read* (subpath ${sbxq(operatorHome)}))` : "",
      '(deny file-read* (subpath "/Users"))',
      '(deny file-read* (subpath "/Volumes"))',
      // Ancestor metadata (DEFECT 2): lets path resolution TRAVERSE into a re-allowed path that sits
      // under a denied root, without granting anything about the ancestor's own contents.
      ...ancestorMetadata.map((p) => `(allow file-read-metadata (literal ${sbxq(p)}))`),
      // Re-allows: exactly what THIS dispatch needs, carved back out of the denies above. The dispatch
      // worktree, the member's own genuinely-scoped HOME (never the operator's real one — DEFECT 1), any
      // granted connector's OWN real home targets (env.ts#scopeHome may have symlinked to these — denying
      // $HOME broadly would otherwise deny reading THROUGH those symlinks too), and readOnlyPaths (the
      // studio root, the interpreter's install tree, the member command's own directory — see
      // adapters.ts#sandboxWrap's own doc for exactly what populates this list).
      ...reallowReads.map((p) => `(allow file-read* (subpath ${sbxq(p)}))`),
      ...reallowWrites.map((p) => `(allow file-write* (subpath ${sbxq(p)}))`),
      '(allow file-read* (subpath "/dev"))',
      '(allow file-write* (subpath "/dev"))',
      policy.allowNetwork ? "(allow network*)" : "(deny network*)",
    ].filter(Boolean),
  );
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

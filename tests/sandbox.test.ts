// NOTES R4-SANDBOX (v2, Ruling 2) — src/sandbox.ts. Two things are tested independently:
//   1. detectSandbox: given injected platform/which/probe seams, does it pick the right primitive and
//      NEVER assume one works just because a binary is present (the goal's own instruction)?
//   2. wrapForSandbox / buildSandboxExecProfile: given a detection result, is the constructed argv/
//      profile shape correct? This is pure and needs no real OS sandbox to verify.
//
// A separate, real end-to-end proof (an actual sandboxed spawn, a decoy file genuinely unreadable) lives
// in tests/adapters.test.ts, gated behind `test.skipIf` on this HOST's own real primitive availability —
// this file only proves detection/construction logic, which is host-independent by design.

import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { detectSandbox, wrapForSandbox, buildSandboxExecProfile, type SandboxDetection } from "../src/sandbox.ts";
import { validatePath } from "../src/validate.ts";
import { formatDoctor } from "../src/doctor.ts";

describe("detectSandbox — never assumed from the platform alone", () => {
  test("linux + working bubblewrap → full", () => {
    const d = detectSandbox({
      platform: "linux",
      which: (cmd) => (cmd === "bwrap" ? "/usr/bin/bwrap" : null),
      probe: () => true,
    });
    expect(d).toEqual({ platform: "linux", primitive: "bubblewrap", level: "full", bin: "/usr/bin/bwrap" });
  });

  test("linux + bwrap ON PATH but non-functional (e.g. user namespaces disabled) falls back to unshare", () => {
    const d = detectSandbox({
      platform: "linux",
      which: (cmd) => (cmd === "bwrap" ? "/usr/bin/bwrap" : cmd === "unshare" ? "/usr/bin/unshare" : null),
      probe: (argv) => argv[0] === "/usr/bin/unshare",
    });
    expect(d).toEqual({ platform: "linux", primitive: "unshare", level: "fs-only", bin: "/usr/bin/unshare" });
  });

  test("linux + neither bwrap nor unshare works → none (the exact reality of this dev container)", () => {
    const d = detectSandbox({
      platform: "linux",
      which: (cmd) => (cmd === "bwrap" ? "/usr/bin/bwrap" : cmd === "unshare" ? "/usr/bin/unshare" : null),
      probe: () => false,
    });
    expect(d).toEqual({ platform: "linux", primitive: "none", level: "none" });
  });

  test("linux + neither binary present at all → none", () => {
    const d = detectSandbox({ platform: "linux", which: () => null, probe: () => true });
    expect(d).toEqual({ platform: "linux", primitive: "none", level: "none" });
  });

  test("a present binary is never trusted without a probe — presence alone is not enough", () => {
    let probed = false;
    detectSandbox({
      platform: "linux",
      which: (cmd) => (cmd === "bwrap" ? "/usr/bin/bwrap" : null),
      probe: (argv) => {
        probed = true;
        return argv[0] === "/usr/bin/bwrap";
      },
    });
    expect(probed).toBe(true);
  });

  test("darwin + working sandbox-exec → full", () => {
    const d = detectSandbox({
      platform: "darwin",
      which: (cmd) => (cmd === "sandbox-exec" ? "/usr/bin/sandbox-exec" : null),
      probe: () => true,
    });
    expect(d).toEqual({ platform: "darwin", primitive: "sandbox-exec", level: "full", bin: "/usr/bin/sandbox-exec" });
  });

  test("darwin + non-functional sandbox-exec → none", () => {
    const d = detectSandbox({
      platform: "darwin",
      which: (cmd) => (cmd === "sandbox-exec" ? "/usr/bin/sandbox-exec" : null),
      probe: () => false,
    });
    expect(d).toEqual({ platform: "darwin", primitive: "none", level: "none" });
  });

  // NOTES R4-SANDBOX-FIX-5 (round 5, terminal live-host conviction — the weak-canary lesson): a probe
  // that exercises a NARROWER code path than production isn't a probe at all. `--version` (rounds 1-4's
  // own probe shape) skips a vendor binary's own child-spawn/sysctl-read startup path entirely — the
  // exact path that killed every real dispatch while every earlier probe passed. The probe must now run
  // a real script file through the real interpreter, under the SAME profile generator a real dispatch
  // uses — never a bespoke, weaker canary.
  test("darwin probe runs a real script file through the interpreter, under a generator-built profile — never --version", () => {
    let seenArgv: string[] | undefined;
    let scriptExistedAtProbeTime = false;
    let profileTextAtProbeTime = "";
    detectSandbox({
      platform: "darwin",
      which: (cmd) => (cmd === "sandbox-exec" ? "/usr/bin/sandbox-exec" : null),
      probe: (argv) => {
        seenArgv = argv;
        scriptExistedAtProbeTime = existsSync(argv[4]);
        profileTextAtProbeTime = readFileSync(argv[2], "utf8");
        return true;
      },
    });
    expect(seenArgv).toBeDefined();
    const argv = seenArgv!;
    expect(argv[0]).toBe("/usr/bin/sandbox-exec");
    expect(argv[1]).toBe("-f");
    expect(argv).not.toContain("--version");
    // argv[3] is the interpreter, argv[4] the script it's told to run — a real script-mode invocation,
    // not a flag that exits before script-mode's own startup path ever runs.
    expect(argv[4]).toMatch(/probe\.js$/);
    expect(scriptExistedAtProbeTime).toBe(true);
    // The profile handed to sandbox-exec is built by THIS module's own generator (the deny-list shape),
    // never a separate, weaker "(allow default)" canary profile.
    expect(profileTextAtProbeTime).toContain("(deny default)");
    expect(profileTextAtProbeTime).toContain("(allow sysctl-read)");
    // Script and profile live in the same scratch dir — one lifecycle, one cleanup.
    expect(dirname(argv[2])).toBe(dirname(argv[4]));
  });

  // NOTES R4-SANDBOX-FIX-6 (the probe/dispatch divergence proven live on the macOS gate: doctor reported
  // `none` on a host where real dispatches sandboxed successfully). Root cause: `probeSandboxExec` built
  // a profile that allows exactly its own scratch dir, but the actual spawned process was never told to
  // run there — it inherited the CALLING process's ambient cwd instead (wherever a Conductor happened to
  // invoke `./levare doctor` from), which the profile's deny-list has no reason to have re-allowed. A real
  // dispatch never has this gap (`adapters.ts#bunSpawn.run` always passes `cwd: opts.cwd` matching the
  // exact policy the profile was built for) — this proves the probe now gets the same discipline.
  test("the darwin probe threads its own scratch cwd to the actual spawn — a profile allowing scratchDir is worthless if the process never runs there (NOTES R4-SANDBOX-FIX-6)", () => {
    let seenArgv: string[] | undefined;
    let seenCwd: string | undefined;
    let profileText = "";
    detectSandbox({
      platform: "darwin",
      which: (cmd) => (cmd === "sandbox-exec" ? "/usr/bin/sandbox-exec" : null),
      probe: (argv, opts) => {
        seenArgv = argv;
        seenCwd = opts?.cwd;
        // Read the profile HERE, before probeSandboxExec's own `finally` cleans up the scratch dir.
        profileText = readFileSync(argv[2], "utf8");
        return true;
      },
    });
    expect(seenCwd).toBeDefined();
    // argv[4] is the probe script, written into the same scratch dir the profile allows — the spawn's
    // OWN cwd (opts.cwd) must be that identical directory, never left undefined/ambient.
    expect(dirname(seenArgv![4]!)).toBe(seenCwd!);
    // The profile handed to `-f` is built FOR that same cwd — the fix's whole point is that the profile's
    // own claim and the process's own reality now agree.
    expect(profileText).toContain(`(allow file-write* (subpath ${JSON.stringify(seenCwd)}))`);
  });

  // NOTES R4-SANDBOX-FIX-6: the second proven defect — the probe's own spawn (the ONE spawn that decides
  // every dispatch's enforcement level) was invisible to LEVARE_SANDBOX_DEBUG, unlike every real dispatch
  // spawn (sandboxExecArgv/wrapForSandbox/adapters.ts#logSpawnDebug all already printed under the flag).
  describe("LEVARE_SANDBOX_DEBUG now instruments the probe's OWN spawn, matching a real dispatch's own format", () => {
    function withEnv(fn: () => void): string[] {
      const prior = process.env.LEVARE_SANDBOX_DEBUG;
      const lines: string[] = [];
      const origError = console.error;
      console.error = (...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      };
      try {
        process.env.LEVARE_SANDBOX_DEBUG = "1";
        fn();
      } finally {
        console.error = origError;
        if (prior === undefined) delete process.env.LEVARE_SANDBOX_DEBUG;
        else process.env.LEVARE_SANDBOX_DEBUG = prior;
      }
      return lines;
    }

    test("darwin: prints profile written-to/text, cwd, level, and composed argv BEFORE the spawn — the identical block wrapForSandbox already prints for a real dispatch", () => {
      const lines = withEnv(() =>
        detectSandbox({
          platform: "darwin",
          which: (cmd) => (cmd === "sandbox-exec" ? "/usr/bin/sandbox-exec" : null),
          probe: () => true,
        }),
      );
      expect(lines.some((l) => l.includes("profile written to:"))).toBe(true);
      expect(lines.some((l) => l.includes("(deny default)"))).toBe(true);
      expect(lines.some((l) => l.includes("cwd:"))).toBe(true);
      expect(lines.some((l) => l.includes("level: full (primitive: sandbox-exec)"))).toBe(true);
      expect(lines.some((l) => l.includes("composed argv:"))).toBe(true);
    });

    // Proven with the REAL (un-injected) probe on THIS host — bwrap/unshare are on PATH but genuinely
    // fail here (this container's own seccomp policy), which is exactly what makes the post-spawn line a
    // real, non-trivial assertion: it must fire for a FAILING probe result too, not only a successful one.
    test("linux: the real, un-injected probe prints 'spawn result: exitCode=... signalCode=...' after each attempt — the exact field-for-field shape adapters.ts#logSpawnDebug already uses for a real dispatch", () => {
      const lines = withEnv(() => detectSandbox());
      if (process.platform !== "linux") return;
      const resultLines = lines.filter((l) => l.includes("spawn result: exitCode="));
      expect(resultLines.length).toBeGreaterThan(0);
      for (const l of resultLines) {
        expect(l).toMatch(/exitCode=-?\d+ signalCode=\S+ timedOut=false stdoutBytes=\d+ stderrBytes=\d+/);
      }
    });

    test("prints level/composed argv for bwrap/unshare probes too, before the real spawn — not only sandbox-exec's own block", () => {
      const lines = withEnv(() =>
        detectSandbox({
          platform: "linux",
          which: (cmd) => (cmd === "bwrap" ? "/usr/bin/bwrap" : null),
          probe: () => false,
        }),
      );
      expect(lines.some((l) => l.includes("level: full (primitive: bubblewrap)"))).toBe(true);
      expect(lines.some((l) => l.includes("composed argv:"))).toBe(true);
    });
  });

  // NOTES R4-SANDBOX-FIX-6 (regression item 3): the probe and a real dispatch must compute their
  // enforcement level through the literal SAME generator (`buildSandboxExecProfile`), never a bespoke
  // profile shape of its own — structurally assertable in-container without a live macOS host, since the
  // generator's own output is pure and host-independent (only Seatbelt's actual enforcement needs one).
  test("the probe's generated profile and a dispatch-shaped profile share the identical fixed preamble — same code path, not a parallel one", () => {
    let probeProfileText = "";
    detectSandbox({
      platform: "darwin",
      which: (cmd) => (cmd === "sandbox-exec" ? "/usr/bin/sandbox-exec" : null),
      probe: (argv) => {
        probeProfileText = readFileSync(argv[2], "utf8");
        return true;
      },
    });
    // A profile shaped like a REAL dispatch's own sandboxWrap call (a worktree cwd, a scoped operator
    // home, readOnlyPaths naming the studio root and an interpreter tree) — built directly via the same
    // exported generator, never through detectSandbox at all.
    const dispatchProfileText = buildSandboxExecProfile({
      cwd: "/Users/cas/.levare-worktrees/unit-1",
      allowNetwork: false,
      operatorHome: "/Users/cas",
      readOnlyPaths: ["/Users/cas/source/levare", "/Users/cas/.bun/bin", "/Users/cas/.bun"],
    });
    for (const fixedLine of ["(deny default)", "(allow sysctl-read)", '(allow file-read* (subpath "/"))', '(deny file-read* (subpath "/Users"))', '(deny file-read* (subpath "/Volumes"))']) {
      expect(probeProfileText).toContain(fixedLine);
      expect(dispatchProfileText).toContain(fixedLine);
    }
  });

  test("an unrecognized platform → none, never a guess", () => {
    const d = detectSandbox({ platform: "win32", which: () => "C:\\whatever.exe", probe: () => true });
    expect(d).toEqual({ platform: "win32", primitive: "none", level: "none" });
  });

  test("this actual host, right now — real bwrap/unshare on PATH but user namespaces disabled by the outer container's seccomp policy — detects none", () => {
    // No injected seams at all: exercises the REAL Bun.which/Bun.spawnSync path. Confirms, in-repo, the
    // exact honesty case this whole module exists for: a binary can be present and still not work.
    const d = detectSandbox();
    expect(d.platform).toBe(process.platform);
    if (process.platform === "linux") {
      expect(d.level).toBe("none");
      expect(d.primitive).toBe("none");
    }
  });
});

describe("wrapForSandbox — pure argv construction, no OS sandbox required to verify", () => {
  const policy = { cwd: "/work/scratch-wt", home: "/work/scratch-home", allowNetwork: false };

  test("bubblewrap: builds an EMPTY root, opens only the enumerated system paths + cwd/home read-write, denies network", () => {
    const detection: SandboxDetection = { platform: "linux", primitive: "bubblewrap", level: "full", bin: "/usr/bin/bwrap" };
    const wrapped = wrapForSandbox(["codex", "run"], policy, detection);
    expect(wrapped.level).toBe("full");
    expect(wrapped.argv[0]).toBe("/usr/bin/bwrap");
    expect(wrapped.argv).toEqual(
      expect.arrayContaining([
        "--tmpfs",
        "/",
        "--ro-bind-try",
        "/usr",
        "/usr",
        "--ro-bind-try",
        "/etc",
        "/etc",
        "--bind",
        "/work/scratch-wt",
        "/work/scratch-wt",
        "--bind",
        "/work/scratch-home",
        "/work/scratch-home",
        "--unshare-net",
      ]),
    );
    // Never a blanket bind of the real root — that would defeat the whole "nothing else" guarantee.
    expect(wrapped.argv).not.toContain("--ro-bind");
    // The wrapped member argv rides along verbatim, after the bwrap options.
    expect(wrapped.argv.slice(-2)).toEqual(["codex", "run"]);
  });

  test("bubblewrap: omits --unshare-net when the member holds a granted connector (network allowed)", () => {
    const detection: SandboxDetection = { platform: "linux", primitive: "bubblewrap", level: "full", bin: "/usr/bin/bwrap" };
    const wrapped = wrapForSandbox(["codex"], { ...policy, allowNetwork: true }, detection);
    expect(wrapped.argv).not.toContain("--unshare-net");
  });

  test("bubblewrap: no home to bind → no --bind for it, cwd still bound", () => {
    const detection: SandboxDetection = { platform: "linux", primitive: "bubblewrap", level: "full", bin: "/usr/bin/bwrap" };
    const wrapped = wrapForSandbox(["codex"], { cwd: "/work/scratch-wt", allowNetwork: false }, detection);
    expect(wrapped.argv).toContain("/work/scratch-wt");
    expect(wrapped.argv).not.toContain("/work/scratch-home");
  });

  test("bubblewrap: extra readOnlyPaths (studio root, interpreter dir) are ro-bind-try'd alongside the platform baseline", () => {
    const detection: SandboxDetection = { platform: "linux", primitive: "bubblewrap", level: "full", bin: "/usr/bin/bwrap" };
    const wrapped = wrapForSandbox(["codex"], { ...policy, readOnlyPaths: ["/studio/root", "/opt/homebrew/bin"] }, detection);
    expect(wrapped.argv).toEqual(expect.arrayContaining(["--ro-bind-try", "/studio/root", "/studio/root", "--ro-bind-try", "/opt/homebrew/bin", "/opt/homebrew/bin"]));
  });

  test("unshare fallback: fs-only, bind-mounts cwd/home, no network attempt at all", () => {
    const detection: SandboxDetection = { platform: "linux", primitive: "unshare", level: "fs-only", bin: "/usr/bin/unshare" };
    const wrapped = wrapForSandbox(["codex", "run"], policy, detection);
    expect(wrapped.level).toBe("fs-only");
    expect(wrapped.argv[0]).toBe("/usr/bin/unshare");
    expect(wrapped.argv).toEqual(expect.arrayContaining(["--user", "--map-root-user", "--mount"]));
    const script = wrapped.argv.find((a) => a.includes("mount --bind"));
    expect(script).toContain("/work/scratch-wt");
    expect(script).toContain("/work/scratch-home");
    expect(script).toContain("remount,bind,ro /");
    expect(script).not.toContain("net");
    expect(wrapped.argv.slice(-2)).toEqual(["codex", "run"]);
  });

  // NOTES R4-SANDBOX-FIX (round 2): the profile is written to a temp file and passed via `-f <path>` —
  // the exact form verified working by hand on a live macOS host — never `-p <string>` (this module's
  // pre-round-2 shape, never independently verified). No `--` before the command either: `man
  // sandbox-exec`'s own documented forms never show one, and the live host's manual check didn't use one.
  test("sandbox-exec: -f <tempfile>, never -p, never a -- separator before the command", () => {
    const detection: SandboxDetection = { platform: "darwin", primitive: "sandbox-exec", level: "full", bin: "/usr/bin/sandbox-exec" };
    const wrapped = wrapForSandbox(["codex", "run"], policy, detection);
    try {
      expect(wrapped.level).toBe("full");
      expect(wrapped.argv[0]).toBe("/usr/bin/sandbox-exec");
      expect(wrapped.argv[1]).toBe("-f");
      const profilePath = wrapped.argv[2];
      expect(profilePath).not.toContain("(version 1)"); // argv[2] is a PATH, not the profile text itself
      const profile = readFileSync(profilePath, "utf8");
      expect(profile).toContain("(deny network*)");
      expect(profile).toContain('(allow file-write* (subpath "/work/scratch-wt"))');
      expect(profile).toContain('(allow file-write* (subpath "/work/scratch-home"))');
      // The command follows the profile path directly — no "--" in between.
      expect(wrapped.argv.slice(3)).toEqual(["codex", "run"]);
    } finally {
      wrapped.cleanup?.();
    }
  });

  test("sandbox-exec: allows network when the member holds a granted connector", () => {
    const detection: SandboxDetection = { platform: "darwin", primitive: "sandbox-exec", level: "full", bin: "/usr/bin/sandbox-exec" };
    const wrapped = wrapForSandbox(["codex"], { ...policy, allowNetwork: true }, detection);
    try {
      const profile = readFileSync(wrapped.argv[2], "utf8");
      expect(profile).toContain("(allow network*)");
      expect(profile).not.toContain("(deny network*)");
    } finally {
      wrapped.cleanup?.();
    }
  });

  test("sandbox-exec: extra readOnlyPaths (studio root, interpreter dir) are opened for reads too", () => {
    const detection: SandboxDetection = { platform: "darwin", primitive: "sandbox-exec", level: "full", bin: "/usr/bin/sandbox-exec" };
    const wrapped = wrapForSandbox(["codex"], { ...policy, readOnlyPaths: ["/studio/root"] }, detection);
    try {
      const profile = readFileSync(wrapped.argv[2], "utf8");
      expect(profile).toContain('(allow file-read* (subpath "/studio/root"))');
    } finally {
      wrapped.cleanup?.();
    }
  });

  test("sandbox-exec: cleanup() removes the scratch profile file, and is idempotent", () => {
    const detection: SandboxDetection = { platform: "darwin", primitive: "sandbox-exec", level: "full", bin: "/usr/bin/sandbox-exec" };
    const wrapped = wrapForSandbox(["codex"], policy, detection);
    const profilePath = wrapped.argv[2];
    expect(existsSync(profilePath)).toBe(true);
    wrapped.cleanup?.();
    expect(existsSync(profilePath)).toBe(false);
    expect(() => wrapped.cleanup?.()).not.toThrow(); // calling it twice is safe
  });

  test("none: argv passes through completely unchanged — never a thrown error for an unsandboxed platform", () => {
    const detection: SandboxDetection = { platform: "linux", primitive: "none", level: "none" };
    const wrapped = wrapForSandbox(["codex", "run", "--flag"], policy, detection);
    expect(wrapped).toEqual({ argv: ["codex", "run", "--flag"], level: "none" });
  });
});

// NOTES R4-SANDBOX-FIX (round 2): LEVARE_SANDBOX_DEBUG=1 is the diagnostic tool the live-host
// investigation asked for — proven here to actually print the composed argv (never silent, never only
// wired), and proven OFF by default so an ordinary run stays quiet.
describe("LEVARE_SANDBOX_DEBUG — diagnostic argv/profile dump", () => {
  function withEnv(value: string | undefined, fn: () => void): string[] {
    const prior = process.env.LEVARE_SANDBOX_DEBUG;
    const lines: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      if (value === undefined) delete process.env.LEVARE_SANDBOX_DEBUG;
      else process.env.LEVARE_SANDBOX_DEBUG = value;
      fn();
    } finally {
      console.error = origError;
      if (prior === undefined) delete process.env.LEVARE_SANDBOX_DEBUG;
      else process.env.LEVARE_SANDBOX_DEBUG = prior;
    }
    return lines;
  }

  const policy = { cwd: "/work/scratch-wt", home: "/work/scratch-home", allowNetwork: false };

  test("prints nothing when unset", () => {
    const detection: SandboxDetection = { platform: "linux", primitive: "bubblewrap", level: "full", bin: "/usr/bin/bwrap" };
    const lines = withEnv(undefined, () => wrapForSandbox(["codex", "run"], policy, detection));
    expect(lines).toEqual([]);
  });

  test("prints the composed argv, one element per line, when set to 1", () => {
    const detection: SandboxDetection = { platform: "linux", primitive: "bubblewrap", level: "full", bin: "/usr/bin/bwrap" };
    const lines = withEnv("1", () => wrapForSandbox(["codex", "run"], policy, detection));
    expect(lines.some((l) => l.includes("level: full"))).toBe(true);
    expect(lines.some((l) => l.includes('"codex"'))).toBe(true);
    expect(lines.some((l) => l.includes('"run"'))).toBe(true);
    expect(lines.some((l) => l.includes("cwd: /work/scratch-wt"))).toBe(true);
  });

  test("prints even for level: none — 'the wrapper decided not to wrap this' is itself diagnostic", () => {
    const detection: SandboxDetection = { platform: "linux", primitive: "none", level: "none" };
    const lines = withEnv("1", () => wrapForSandbox(["codex", "run"], policy, detection));
    expect(lines.some((l) => l.includes("level: none"))).toBe(true);
  });

  test("darwin: also names the profile file path and dumps its full text", () => {
    const detection: SandboxDetection = { platform: "darwin", primitive: "sandbox-exec", level: "full", bin: "/usr/bin/sandbox-exec" };
    let wrapped: ReturnType<typeof wrapForSandbox> | undefined;
    const lines = withEnv("1", () => {
      wrapped = wrapForSandbox(["codex"], policy, detection);
    });
    try {
      expect(lines.some((l) => l.includes("profile written to:"))).toBe(true);
      expect(lines.some((l) => l.includes("(deny default)"))).toBe(true);
    } finally {
      wrapped?.cleanup?.();
    }
  });
});

// NOTES R4-SANDBOX-FIX-3 (round 3, live macOS bisection): the deny-list model — broad OS read by
// default, the operator's own user data denied, exactly what this dispatch needs re-allowed on top.
// Ratified by a Conductor after 14 hand-run profiles on a live host proved the round-1/round-2
// enumerated-allowlist model unwinnable against dyld on this platform (see sandbox.ts's own header).
describe("buildSandboxExecProfile — deny-list model (NOTES R4-SANDBOX-FIX-3)", () => {
  test("denies default, allows broad OS read, denies default and only re-opens what this dispatch needs", () => {
    const profile = buildSandboxExecProfile({ cwd: "/a/b", home: "/c/d", allowNetwork: false });
    expect(profile).toContain("(deny default)");
    expect(profile).toContain('(allow file-read* (subpath "/"))'); // broad OS read — verified live, see header
    expect(profile).toContain('(allow file-write* (subpath "/a/b"))');
    expect(profile).toContain('(allow file-write* (subpath "/c/d"))');
    expect(profile).toContain("(deny network*)");
  });

  // NOTES R4-SANDBOX-FIX-5 (round 5, live-host conviction): script-mode `bun` reads a battery of sysctls
  // at child-spawn startup — denying that path produced a bun/Zig panic (SIGTRAP inside
  // std::__call_once), not a logged sandbox denial, and every real dispatch died on it while every
  // profile unit test (none of which ever ran a real script-mode spawn) kept passing.
  test("the fixed preamble allows sysctl-read — process-bootstrap plumbing, not user data", () => {
    const profile = buildSandboxExecProfile({ cwd: "/a/b", allowNetwork: false });
    expect(profile).toContain("(allow sysctl-read)");
    // Deliberately NOT added: live testing proved sysctl-read alone suffices; the tty/dtracehelper
    // file-ioctl denials are cosmetic soft denials (NOTES R4-SANDBOX-FIX-3 finding 5), not a second gap.
    expect(profile).not.toContain("file-ioctl");
  });

  test("no home declared → no home write clause, cwd clause still present", () => {
    const profile = buildSandboxExecProfile({ cwd: "/a/b", allowNetwork: false });
    expect(profile).toContain('(allow file-write* (subpath "/a/b"))');
    expect(profile.match(/allow file-write\*/g)?.length).toBe(2); // cwd + /dev, no home
  });

  test("denies the operator's real HOME, /Users, and /Volumes broadly", () => {
    const profile = buildSandboxExecProfile({ cwd: "/a/b", allowNetwork: false, operatorHome: "/Users/cas" });
    expect(profile).toContain('(deny file-read* (subpath "/Users/cas"))');
    expect(profile).toContain('(deny file-read* (subpath "/Users"))');
    expect(profile).toContain('(deny file-read* (subpath "/Volumes"))');
  });

  test("no operatorHome given → /Users and /Volumes are still denied unconditionally, but no HOME-specific deny", () => {
    const profile = buildSandboxExecProfile({ cwd: "/a/b", allowNetwork: false });
    expect(profile).toContain('(deny file-read* (subpath "/Users"))');
    expect(profile).toContain('(deny file-read* (subpath "/Volumes"))');
    expect(profile.match(/deny file-read\*/g)?.length).toBe(2); // /Users, /Volumes — no third HOME-specific deny
  });

  // RULE ORDER IS LOAD-BEARING (Seatbelt: last matching rule wins) — a deny AFTER its own re-allow would
  // silently win instead, making the re-allow inert. This is the one property this fix must never regress.
  test("every deny precedes every read re-allow it's meant to be carved open by (rule order)", () => {
    const profile = buildSandboxExecProfile({
      cwd: "/work/wt",
      home: "/work/home",
      allowNetwork: false,
      operatorHome: "/Users/cas",
      grantedHomeTargets: ["/Users/cas/.codex"],
      readOnlyPaths: ["/studio/root"],
    });
    const lines = profile.split("\n");
    const lastDenyIdx = Math.max(
      lines.findIndex((l) => l === '(deny file-read* (subpath "/Users/cas"))'),
      lines.findIndex((l) => l === '(deny file-read* (subpath "/Users"))'),
      lines.findIndex((l) => l === '(deny file-read* (subpath "/Volumes"))'),
    );
    const reallows = ['(allow file-read* (subpath "/work/wt"))', '(allow file-read* (subpath "/work/home"))', '(allow file-read* (subpath "/Users/cas/.codex"))', '(allow file-read* (subpath "/studio/root"))'];
    for (const r of reallows) {
      const idx = lines.indexOf(r);
      expect(idx).toBeGreaterThan(-1);
      expect(idx).toBeGreaterThan(lastDenyIdx);
    }
  });

  // NOTES R4-SANDBOX-FIX-4 (round 4, live macOS gate) — DEFECT 1, security: a member with no genuinely
  // scoped HOME has `req.env.HOME` resolve to the operator's OWN real home (buildMemberEnv allowlists
  // HOME unconditionally); blindly re-allowing `policy.home` therefore re-allowed the operator's ENTIRE
  // real home, read AND write, defeating the whole deny-list model. This is the bug the live decoy-file
  // test caught directly.
  describe("DEFECT 1 — the operator's real HOME is never blanket re-allowed", () => {
    test("home === operatorHome (no genuine scoping) → no HOME re-allow at all, read or write", () => {
      const profile = buildSandboxExecProfile({ cwd: "/a/b", home: "/Users/cas", operatorHome: "/Users/cas", allowNetwork: false });
      expect(profile).not.toContain('(allow file-read* (subpath "/Users/cas"))');
      expect(profile).not.toContain('(allow file-write* (subpath "/Users/cas"))');
      // Only cwd + /dev are write-allowed — never the operator's home.
      expect(profile.match(/allow file-write\*/g)?.length).toBe(2);
    });

    test("a genuinely DIFFERENT (scoped) home is still re-allowed, read and write", () => {
      const profile = buildSandboxExecProfile({ cwd: "/a/b", home: "/private/var/folders/scratch-home", operatorHome: "/Users/cas", allowNetwork: false });
      expect(profile).toContain('(allow file-read* (subpath "/private/var/folders/scratch-home"))');
      expect(profile).toContain('(allow file-write* (subpath "/private/var/folders/scratch-home"))');
    });

    test("no operatorHome known at all → home is still re-allowed (nothing to defeat, nothing to compare against)", () => {
      const profile = buildSandboxExecProfile({ cwd: "/a/b", home: "/c/d", allowNetwork: false });
      expect(profile).toContain('(allow file-read* (subpath "/c/d"))');
      expect(profile).toContain('(allow file-write* (subpath "/c/d"))');
    });
  });

  // NOTES R4-SANDBOX-FIX-4 — DEFECT 2, crash: a `(subpath ...)` re-allow only ever covers the named path
  // and what's nested inside it — path resolution INTO it still traverses every ancestor component, and
  // an ancestor sitting under a denied root (e.g. `/Users`) dies there before the re-allow is ever
  // consulted. The live crash signature: SIGTRAP inside `std::__call_once` — bun (Zig) panicking on an
  // unexpected EPERM during early init — is the recognizable symptom of a traversal-denied profile,
  // never a sandbox denial a Conductor would see logged as such.
  describe("DEFECT 2 — ancestor metadata for every re-allowed path under a denied root", () => {
    test("emits (allow file-read-metadata (literal ...)) for every ancestor between a denied root and the re-allowed path", () => {
      const profile = buildSandboxExecProfile({ cwd: "/Users/cas/source/levare", operatorHome: "/Users/cas", allowNetwork: false });
      expect(profile).toContain('(allow file-read-metadata (literal "/Users"))');
      expect(profile).toContain('(allow file-read-metadata (literal "/Users/cas"))');
      expect(profile).toContain('(allow file-read-metadata (literal "/Users/cas/source"))');
      // The target itself is re-allowed via subpath, not metadata-literal — no redundant metadata line for it.
      expect(profile).not.toContain('(allow file-read-metadata (literal "/Users/cas/source/levare"))');
    });

    test("ancestor metadata lines are placed AFTER the denies (rule order)", () => {
      const profile = buildSandboxExecProfile({ cwd: "/Users/cas/source/levare", operatorHome: "/Users/cas", allowNetwork: false });
      const lines = profile.split("\n");
      const lastDenyIdx = Math.max(
        lines.indexOf('(deny file-read* (subpath "/Users/cas"))'),
        lines.indexOf('(deny file-read* (subpath "/Users"))'),
        lines.indexOf('(deny file-read* (subpath "/Volumes"))'),
      );
      const metadataIdx = lines.indexOf('(allow file-read-metadata (literal "/Users/cas"))');
      expect(metadataIdx).toBeGreaterThan(-1);
      expect(metadataIdx).toBeGreaterThan(lastDenyIdx);
    });

    test("a re-allowed path NOT under any denied root gets no spurious ancestor-metadata noise beyond its own real ancestors", () => {
      const profile = buildSandboxExecProfile({ cwd: "/opt/homebrew/bin", allowNetwork: false });
      // /opt/homebrew/bin's own ancestors are still named (harmless — metadata only, and this path isn't
      // under a deny anyway) — the key property is no crash-inducing GAP, over-granting is the safe side.
      expect(profile).toContain('(allow file-read-metadata (literal "/opt"))');
      expect(profile).toContain('(allow file-read-metadata (literal "/opt/homebrew"))');
    });
  });

  // NOTES R4-SANDBOX-FIX-4 — DEFECT 3, cosmetic: adapters.ts#sandboxWrap can legitimately compute the
  // same path twice (e.g. the running levare binary and the member's own resolved command are both `bun`).
  describe("DEFECT 3 — no duplicate rules", () => {
    test("the same path supplied twice (readOnlyPaths) produces exactly one re-allow line, not two", () => {
      const profile = buildSandboxExecProfile({ cwd: "/a/b", allowNetwork: false, readOnlyPaths: ["/Users/cas/.bun/bin", "/Users/cas/.bun", "/Users/cas/.bun/bin", "/Users/cas/.bun"] });
      const lines = profile.split("\n");
      expect(lines.filter((l) => l === '(allow file-read* (subpath "/Users/cas/.bun/bin"))').length).toBe(1);
      expect(lines.filter((l) => l === '(allow file-read* (subpath "/Users/cas/.bun"))').length).toBe(1);
    });

    test("no duplicate lines anywhere in the generated profile, full stop", () => {
      const profile = buildSandboxExecProfile({
        cwd: "/a/b",
        home: "/a/b", // deliberately overlapping with cwd
        operatorHome: "/Users/cas",
        allowNetwork: false,
        grantedHomeTargets: ["/Users/cas/.codex", "/Users/cas/.codex"],
        readOnlyPaths: ["/a/b", "/studio/root"],
      });
      const lines = profile.split("\n").filter(Boolean);
      expect(new Set(lines).size).toBe(lines.length);
    });
  });

  test("re-allows a granted connector's own real home target — reading THROUGH a scopeHome symlink to it", () => {
    const profile = buildSandboxExecProfile({ cwd: "/a/b", allowNetwork: false, operatorHome: "/Users/cas", grantedHomeTargets: ["/Users/cas/.codex"] });
    expect(profile).toContain('(allow file-read* (subpath "/Users/cas/.codex"))');
  });

  test("re-allows readOnlyPaths (studio root, interpreter tree, member command directory) for reads", () => {
    const profile = buildSandboxExecProfile({
      cwd: "/a/b",
      allowNetwork: false,
      readOnlyPaths: ["/studio/root", "/Users/cas/.bun", "/Users/cas/.bun/bin"],
    });
    expect(profile).toContain('(allow file-read* (subpath "/studio/root"))');
    expect(profile).toContain('(allow file-read* (subpath "/Users/cas/.bun"))');
    expect(profile).toContain('(allow file-read* (subpath "/Users/cas/.bun/bin"))');
  });

  test("quotes an embedded quote in a path safely rather than breaking the profile string", () => {
    const profile = buildSandboxExecProfile({ cwd: '/a/"b', allowNetwork: false });
    expect(profile).toContain('/a/\\"b');
  });

  // NOTES R4-SANDBOX-FIX (macOS host verification): sandbox-exec's own `(subpath ...)` rules match the
  // KERNEL-RESOLVED path — macOS's `/tmp`/`/var/folders` (where every scratch worktree/HOME this module
  // scopes actually lives) are themselves symlinks into `/private`, so a profile written with the
  // pre-resolution path silently never matched, denying the exact reach the sandbox exists to allow. This
  // is provable on ANY platform (Linux symlinks work identically for this purpose) without needing a live
  // macOS host — only whether `sandbox-exec` itself then enforces it needs one (see this file's own header).
  test("canonicalizes cwd/home/readOnlyPaths through a real symlink before writing them into the profile", () => {
    const real = mkdtempSync(join(tmpdir(), "levare-sandbox-real-"));
    const parent = mkdtempSync(join(tmpdir(), "levare-sandbox-linkparent-"));
    const link = join(parent, "tmp-like-symlink");
    symlinkSync(real, link);
    try {
      const cwd = join(link, "worktree");
      const home = join(link, "home");
      mkdirSync(cwd, { recursive: true });
      mkdirSync(home, { recursive: true });
      const profile = buildSandboxExecProfile({ cwd, home, allowNetwork: false, readOnlyPaths: [link] });
      // NOTES R4-SANDBOX-FIX (item 6): `real` itself must be canonicalized before comparison — on macOS
      // `os.tmpdir()` ALSO sits behind a symlink (`/var/folders/... -> /private/var/folders/...`), so the
      // value `mkdtempSync` returns is not yet the fully-resolved path either; comparing against it
      // directly would fail on exactly the host this fix targets.
      const realCanonical = realpathSync(real);
      // The SYMLINKED path never appears as its own subpath clause — only the resolved, real path does.
      expect(profile).not.toContain(`(subpath ${JSON.stringify(cwd)})`);
      expect(profile).toContain(`(allow file-write* (subpath ${JSON.stringify(join(realCanonical, "worktree"))}))`);
      expect(profile).toContain(`(allow file-write* (subpath ${JSON.stringify(join(realCanonical, "home"))}))`);
      expect(profile).toContain(`(allow file-read* (subpath ${JSON.stringify(realCanonical)}))`);
    } finally {
      rmSync(real, { recursive: true, force: true });
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("a path that doesn't exist on disk resolves to itself, never throws — this module's own pure unit tests above rely on exactly this", () => {
    expect(() => buildSandboxExecProfile({ cwd: "/definitely/does/not/exist/anywhere", allowNetwork: false })).not.toThrow();
    const profile = buildSandboxExecProfile({ cwd: "/definitely/does/not/exist/anywhere", allowNetwork: false });
    expect(profile).toContain('(allow file-write* (subpath "/definitely/does/not/exist/anywhere"))');
  });
});

// ---------------------------------------------------------------------------
// SANDBOX_UNAVAILABLE — the sibling to CLI_TOOLS_NOT_ENFORCEABLE (validate.ts#validateAgentSandboxWarning)
// ---------------------------------------------------------------------------

function cliAgentStudio(): string {
  const dir = mkdtempSync(join(tmpdir(), "levare-sandbox-warn-"));
  mkdirSync(join(dir, "agents"), { recursive: true });
  writeFileSync(
    join(dir, "agents", "finch.md"),
    ["---", "name: finch", "kind: cli", "produces: [review]", 'command: ["echo", "{task}"]', 'result: "plain text"', "style:", "  avatar: Fi", "---", "", "A cli member.", ""].join("\n"),
  );
  return dir;
}

const NONE: SandboxDetection = { platform: "linux", primitive: "none", level: "none" };
const FULL: SandboxDetection = { platform: "linux", primitive: "bubblewrap", level: "full", bin: "/usr/bin/bwrap" };

describe("validate.ts: SANDBOX_UNAVAILABLE (NOTES R4-SANDBOX, sibling to CLI_TOOLS_NOT_ENFORCEABLE)", () => {
  test("a cli agent gets the warning when the caller reports no working sandbox primitive, naming it", () => {
    const dir = cliAgentStudio();
    try {
      const r = validatePath(dir, undefined, NONE);
      expect(r.ok).toBe(true); // never an error — a legal, unavoidable-on-this-host reality, not a mistake
      const w = r.warnings.find((w) => w.code === "SANDBOX_UNAVAILABLE");
      expect(w).toBeDefined();
      expect(w!.message).toContain("finch");
      expect(w!.message).toContain("bubblewrap, unshare");
      expect(w!.message).toContain("levare doctor");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no warning when a working primitive IS reported", () => {
    const dir = cliAgentStudio();
    try {
      const r = validatePath(dir, undefined, FULL);
      expect(r.warnings.map((w) => w.code)).not.toContain("SANDBOX_UNAVAILABLE");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no warning when the caller passes no detection at all — never assumed, only reported when asked", () => {
    const dir = cliAgentStudio();
    try {
      const r = validatePath(dir);
      expect(r.warnings.map((w) => w.code)).not.toContain("SANDBOX_UNAVAILABLE");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a native agent never carries this warning — Ruling 2 wraps only cli spawns", () => {
    const dir = mkdtempSync(join(tmpdir(), "levare-sandbox-warn-native-"));
    try {
      mkdirSync(join(dir, "agents"), { recursive: true });
      writeFileSync(
        join(dir, "agents", "lyra.md"),
        ["---", "name: lyra", "kind: native", "produces: [spec]", "model: claude-sonnet-5", "style:", "  avatar: Ly", "---", "", "A native member.", ""].join("\n"),
      );
      const r = validatePath(dir, undefined, NONE);
      expect(r.warnings.map((w) => w.code)).not.toContain("SANDBOX_UNAVAILABLE");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("doctor.ts: sandbox status line + the sibling warning (NOTES R4-SANDBOX)", () => {
  test("prints the detected level plainly when a primitive works", () => {
    const out = formatDoctor([], undefined, undefined, undefined, undefined, undefined, FULL, ["finch"]);
    expect(out).toContain("sandbox: full (bubblewrap");
    expect(out).not.toContain("unconfined");
  });

  // NOTES R4-SANDBOX-FIX-3: `full` does not mean the same thing on both platforms after round 3 — the
  // model note is how a Conductor reading `levare doctor`'s output is told so, rather than left to assume
  // bubblewrap and sandbox-exec enforce identically just because both print "full".
  test("names the enforcement MODEL alongside the primitive — bubblewrap and sandbox-exec do not enforce identically", () => {
    const bwrapOut = formatDoctor([], undefined, undefined, undefined, undefined, undefined, FULL, ["finch"]);
    expect(bwrapOut).toContain("allow-list from an empty root");

    const sbxDetection: SandboxDetection = { platform: "darwin", primitive: "sandbox-exec", level: "full", bin: "/usr/bin/sandbox-exec" };
    const sbxOut = formatDoctor([], undefined, undefined, undefined, undefined, undefined, sbxDetection, ["finch"]);
    expect(sbxOut).toContain("OS-visible, operator HOME denied");

    // The two model notes are themselves distinct — never the same text for the two primitives.
    const bwrapNote = bwrapOut.match(/sandbox: full \(bubblewrap — (.+)\)/)?.[1];
    const sbxNote = sbxOut.match(/sandbox: full \(sandbox-exec — (.+)\)/)?.[1];
    expect(bwrapNote).toBeTruthy();
    expect(sbxNote).toBeTruthy();
    expect(bwrapNote).not.toBe(sbxNote);
  });

  test("prints none plainly and names every cli agent left unconfined", () => {
    const out = formatDoctor([], undefined, undefined, undefined, undefined, undefined, NONE, ["finch", "rook"]);
    expect(out).toContain("sandbox: none — unconfined cli spawns");
    expect(out).toContain("finch, rook");
    expect(out).toContain("bubblewrap, unshare");
  });

  test("no cli agents in the studio → the none status still prints, but no per-agent warning line", () => {
    const out = formatDoctor([], undefined, undefined, undefined, undefined, undefined, NONE, []);
    expect(out).toContain("sandbox: none");
    expect(out).not.toContain("run unconfined beyond env/HOME scoping:");
  });

  test("omitting sandbox entirely leaves the report unchanged — never assumed", () => {
    const out = formatDoctor([]);
    expect(out).not.toContain("sandbox:");
  });
});

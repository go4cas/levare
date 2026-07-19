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
import { join } from "node:path";
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

describe("buildSandboxExecProfile — text worth asserting on directly (never live-run on this Linux container)", () => {
  test("always denies by default and only opens the specific paths this dispatch needs", () => {
    const profile = buildSandboxExecProfile({ cwd: "/a/b", home: "/c/d", allowNetwork: false });
    expect(profile).toContain("(deny default)");
    expect(profile).toContain('(allow file-read* (subpath "/usr"))');
    expect(profile).not.toContain('(allow file-read* (subpath "/"))');
    expect(profile).toContain('(allow file-write* (subpath "/a/b"))');
    expect(profile).toContain('(allow file-write* (subpath "/c/d"))');
    expect(profile).toContain("(deny network*)");
  });

  test("no home declared → no home write clause, cwd clause still present", () => {
    const profile = buildSandboxExecProfile({ cwd: "/a/b", allowNetwork: false });
    expect(profile).toContain('(allow file-write* (subpath "/a/b"))');
    expect(profile.match(/allow file-write\*/g)?.length).toBe(2); // cwd + /dev, no home
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
    expect(out).toContain("sandbox: full (bubblewrap)");
    expect(out).not.toContain("unconfined");
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

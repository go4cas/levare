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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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

  test("sandbox-exec: builds a profile denying network and scoping writes to cwd/home", () => {
    const detection: SandboxDetection = { platform: "darwin", primitive: "sandbox-exec", level: "full", bin: "/usr/bin/sandbox-exec" };
    const wrapped = wrapForSandbox(["codex", "run"], policy, detection);
    expect(wrapped.level).toBe("full");
    expect(wrapped.argv[0]).toBe("/usr/bin/sandbox-exec");
    expect(wrapped.argv[1]).toBe("-p");
    const profile = wrapped.argv[2];
    expect(profile).toContain("(deny network*)");
    expect(profile).toContain('(allow file-write* (subpath "/work/scratch-wt"))');
    expect(profile).toContain('(allow file-write* (subpath "/work/scratch-home"))');
    expect(wrapped.argv.slice(-2)).toEqual(["codex", "run"]);
  });

  test("sandbox-exec: allows network when the member holds a granted connector", () => {
    const detection: SandboxDetection = { platform: "darwin", primitive: "sandbox-exec", level: "full", bin: "/usr/bin/sandbox-exec" };
    const wrapped = wrapForSandbox(["codex"], { ...policy, allowNetwork: true }, detection);
    expect(wrapped.argv[2]).toContain("(allow network*)");
    expect(wrapped.argv[2]).not.toContain("(deny network*)");
  });

  test("none: argv passes through completely unchanged — never a thrown error for an unsandboxed platform", () => {
    const detection: SandboxDetection = { platform: "linux", primitive: "none", level: "none" };
    const wrapped = wrapForSandbox(["codex", "run", "--flag"], policy, detection);
    expect(wrapped).toEqual({ argv: ["codex", "run", "--flag"], level: "none" });
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

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { main } from "../src/cli.ts";
import { getVersionInfo, formatVersion, isCompiledBuild, versionFromTag } from "../src/version.ts";

// levare --version / -v (NOTES DIST1). A binary that can't say what it is can't be trusted in the
// field — running under `bun test` is itself a source run (no `--define`-stamped build commit), so
// `getVersionInfo()` here always reports "source/dev"; the "compiled" half of the contract is
// exercised via `formatVersion` directly against a synthetic stamped `VersionInfo`, and via the real
// `dist/levare` binary in the build smoke test (package.json's `build` script; NOTES DIST1).

function capture(fn: () => number): { code: number; out: string } {
  const chunks: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    chunks.push(args.map(String).join(" "));
  };
  let code: number;
  try {
    code = fn();
  } finally {
    console.log = orig;
  }
  return { code, out: chunks.join("\n") };
}

describe("version info", () => {
  test("the package version comes from this repo's own package.json", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    expect(getVersionInfo().version).toBe(pkg.version);
  });

  test("running under `bun test` (a source run) reports no build stamp", () => {
    const info = getVersionInfo();
    expect(info.build).toBeNull();
    expect(isCompiledBuild(info)).toBe(false);
  });

  test("formatVersion prints '(source/dev)' when there is no build stamp", () => {
    expect(formatVersion({ version: "1.2.3", build: null })).toBe("levare 1.2.3 (source/dev)");
  });

  test("formatVersion prints the stamped commit when built", () => {
    const info = { version: "1.2.3", build: { commit: "2b0610f" } };
    expect(formatVersion(info)).toBe("levare 1.2.3 (build 2b0610f)");
    expect(isCompiledBuild(info)).toBe(true);
  });
});

describe("versionFromTag (release.yml's tag -> package.json version derivation)", () => {
  test("strips the semver 'v' prefix (v followed by a digit)", () => {
    expect(versionFromTag("v0.1.0")).toBe("0.1.0");
    expect(versionFromTag("v1.2.3-rc1")).toBe("1.2.3-rc1");
    expect(versionFromTag("v10.0.0")).toBe("10.0.0");
  });

  test("leaves a word-shaped tag intact — 'v' is a letter here, not a semver prefix", () => {
    expect(versionFromTag("vendor-cli-gh")).toBe("vendor-cli-gh");
    expect(versionFromTag("v11-conv")).toBe("v11-conv");
  });

  test("leaves a tag with no leading 'v' at all untouched", () => {
    expect(versionFromTag("0.1.0")).toBe("0.1.0");
    expect(versionFromTag("dist1")).toBe("dist1");
  });
});

describe("CLI dispatch: --version / -v", () => {
  test("`levare --version` prints the version and exits 0", () => {
    const { code, out } = capture(() => main(["--version"]));
    expect(code).toBe(0);
    expect(out).toBe(formatVersion(getVersionInfo()));
  });

  test("`levare -v` is the same as --version", () => {
    const { code, out } = capture(() => main(["-v"]));
    expect(code).toBe(0);
    expect(out).toBe(formatVersion(getVersionInfo()));
  });

  test("a source/dev run never fabricates a build commit", () => {
    const { out } = capture(() => main(["--version"]));
    expect(out).toContain("source/dev");
    expect(out).not.toContain("build");
  });
});

describe("the real `./levare` shim (source run)", () => {
  test("`./levare --version` prints a version and indicates source/dev, never a fabricated commit", () => {
    const p = Bun.spawnSync(["./levare", "--version"]);
    expect(p.exitCode).toBe(0);
    const out = p.stdout.toString().trim();
    expect(out).toMatch(/^levare \d+\.\d+\.\d+ \(source\/dev\)$/);
  });

  test("`./levare -v` behaves the same as --version", () => {
    const p = Bun.spawnSync(["./levare", "-v"]);
    expect(p.exitCode).toBe(0);
    expect(p.stdout.toString().trim()).toMatch(/^levare \d+\.\d+\.\d+ \(source\/dev\)$/);
  });

  test("every other command still runs unchanged (the shim adds a build path, it doesn't replace this one)", () => {
    const p = Bun.spawnSync(["./levare", "validate", "fixtures/golden"]);
    expect(p.exitCode).toBe(0);
    // NOTES R4-SANDBOX: on a host with no working sandbox primitive, fixtures/golden's real `kind: cli`
    // agents (finch, rook) now print SANDBOX_UNAVAILABLE warnings after "valid" — asserting the first
    // line, not exact whole-output equality (see tests/validate.test.ts's identical fix for the reasoning).
    expect(p.stdout.toString().trim().split("\n")[0]).toBe("valid");
  });
});

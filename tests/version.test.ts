import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { assertExitCode } from "./spawn-helpers.ts";
import { main } from "../src/cli.ts";
import { getVersionInfo, formatVersion, isCompiledBuild, versionFromTag, versionChip } from "../src/version.ts";

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

// NOTES "tree build version" (Conductor ruling): `package.json`'s version on `main` is permanently
// "0.0.1" — release.yml stamps the real version into an ephemeral checkout only, never committing it
// back — so a compiled TREE build (`bun run build` off main, not a release) carries a real, correctly
// stamped commit alongside that never-bumped placeholder, and used to report it as a real version.
describe("a tree build reports 'dev', never the unbumped package.json placeholder (NOTES 'tree build version')", () => {
  test("formatVersion (--version's own sentence) prints 'dev', not '0.0.1', when the placeholder is stamped with a build commit", () => {
    const info = { version: "0.0.1", build: { commit: "2b0610f" } };
    expect(formatVersion(info)).toBe("levare dev (build 2b0610f)");
  });

  test("versionChip (the board header's own chip) prints 'dev (build <hash>)' for the identical case", () => {
    const info = { version: "0.0.1", build: { commit: "2b0610f" } };
    expect(versionChip(info)).toBe("dev (build 2b0610f)");
  });

  test("a REAL release's version is never mistaken for the placeholder — '0.0.1' is the exact, only trigger", () => {
    // Not "any 0.0.x" or "any version starting with 0" — a real early-days release could legitimately
    // be tagged v0.0.2, v0.1.0, etc., and must report itself normally.
    const nearby = { version: "0.0.2", build: { commit: "2b0610f" } };
    expect(formatVersion(nearby)).toBe("levare 0.0.2 (build 2b0610f)");
    expect(versionChip(nearby)).toBe("v0.0.2");
    const real = { version: "1.4.0", build: { commit: "2b0610f" } };
    expect(formatVersion(real)).toBe("levare 1.4.0 (build 2b0610f)");
    expect(versionChip(real)).toBe("v1.4.0");
  });

  test("a source run (no build stamp) is out of this ruling's scope — the placeholder still shows, only 'bun run build''s own output changed", () => {
    const info = { version: "0.0.1", build: null };
    expect(formatVersion(info)).toBe("levare 0.0.1 (source/dev)");
    expect(versionChip(info)).toBe("v0.0.1");
  });

  test("this repo's own committed package.json really is still the placeholder — the regression this guards against is reachable, not hypothetical", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    expect(pkg.version).toBe("0.0.1");
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
    assertExitCode("./levare --version", p, 0);
    const out = p.stdout.toString().trim();
    expect(out).toMatch(/^levare \d+\.\d+\.\d+ \(source\/dev\)$/);
  });

  test("`./levare -v` behaves the same as --version", () => {
    const p = Bun.spawnSync(["./levare", "-v"]);
    assertExitCode("./levare -v", p, 0);
    expect(p.stdout.toString().trim()).toMatch(/^levare \d+\.\d+\.\d+ \(source\/dev\)$/);
  });

  test("every other command still runs unchanged (the shim adds a build path, it doesn't replace this one)", () => {
    const p = Bun.spawnSync(["./levare", "validate", "fixtures/golden"]);
    assertExitCode("./levare validate fixtures/golden", p, 0);
    // NOTES R4-SANDBOX: on a host with no working sandbox primitive, fixtures/golden's real `kind: cli`
    // agents (finch, rook) now print SANDBOX_UNAVAILABLE warnings after "valid" — asserting the first
    // line, not exact whole-output equality (see tests/validate.test.ts's identical fix for the reasoning).
    expect(p.stdout.toString().trim().split("\n")[0]).toBe("valid");
  });
});

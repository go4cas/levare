import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

// NOTES DIST6: scripts/install.sh downloads real GitHub Release assets in production. This suite
// never touches live GitHub — it builds a local fixture release layout (a temp dir shaped like
// `<base>/latest/download/<asset>` and `<base>/download/<version>/<asset>`, each with its own
// SHA256SUMS) and points the script at it via `file://` URLs through the internal
// LEVARE_RELEASE_BASE_URL test seam (undocumented for end users — see the script's own header).

const SCRIPT = join(process.cwd(), "scripts/install.sh");

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function fakeBinary(tag: string): string {
  return `#!/bin/sh\necho "levare 0.0.0-fixture (${tag})"\n`;
}

function writeAsset(dir: string, asset: string, tag: string) {
  mkdirSync(dir, { recursive: true });
  const content = fakeBinary(tag);
  const assetPath = join(dir, asset);
  writeFileSync(assetPath, content);
  chmodSync(assetPath, 0o755);
  writeFileSync(join(dir, "SHA256SUMS"), `${sha256(content)}  ${asset}\n`);
}

function makeFixtureRoot(): string {
  return mkdtempSync(join(tmpdir(), "levare-install-fixture-"));
}

function scratchDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `levare-install-${name}-`));
}

function stubUnameDir(os: string, arch: string): string {
  const dir = scratchDir("uname");
  const script = `#!/bin/sh\ncase "$1" in\n  -s) echo "${os}" ;;\n  -m) echo "${arch}" ;;\nesac\n`;
  const p = join(dir, "uname");
  writeFileSync(p, script);
  chmodSync(p, 0o755);
  return dir;
}

function runInstall(env: Record<string, string>) {
  return spawnSync("/bin/sh", [SCRIPT], { env, encoding: "utf8" });
}

// Every call builds a full, isolated env from scratch (never `process.env` merged in for the parts
// under test) so a stray LEVARE_* var in the ambient environment can't leak into a result.
function baseEnv(unameDir: string, extra: Record<string, string>): Record<string, string> {
  return {
    PATH: `${unameDir}:${process.env.PATH ?? ""}`,
    HOME: extra.HOME ?? scratchDir("home"),
    TMPDIR: extra.TMPDIR ?? scratchDir("tmpdir"),
    ...extra,
  };
}

describe("platform mapping (NOTES DIST6)", () => {
  const cases: { os: string; arch: string; platform: string }[] = [
    { os: "Darwin", arch: "arm64", platform: "darwin-arm64" },
    { os: "Darwin", arch: "x86_64", platform: "darwin-x64" },
    { os: "Linux", arch: "x86_64", platform: "linux-x64" },
    { os: "Linux", arch: "aarch64", platform: "linux-arm64" },
    { os: "Linux", arch: "amd64", platform: "linux-x64" },
  ];

  for (const { os, arch, platform } of cases) {
    test(`${os}/${arch} maps to levare-${platform}`, () => {
      const asset = `levare-${platform}`;
      const fixture = makeFixtureRoot();
      writeAsset(join(fixture, "latest", "download"), asset, platform);
      const unameDir = stubUnameDir(os, arch);
      const binDir = join(scratchDir("bin"), "bin");

      const result = runInstall(baseEnv(unameDir, { LEVARE_RELEASE_BASE_URL: `file://${fixture}`, LEVARE_BIN_DIR: binDir }));

      expect(result.status).toBe(0);
      const bin = spawnSync(join(binDir, "levare"), ["--version"], { encoding: "utf8" });
      expect(bin.stdout).toContain(platform);
    });
  }

  test("an unrecognized OS/arch combo fails, naming exactly what uname reported", () => {
    const unameDir = stubUnameDir("SunOS", "sun4u");
    const result = runInstall(
      baseEnv(unameDir, { LEVARE_RELEASE_BASE_URL: `file://${makeFixtureRoot()}`, LEVARE_BIN_DIR: join(scratchDir("bin"), "bin") }),
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unsupported platform");
    expect(result.stderr).toContain("SunOS");
    expect(result.stderr).toContain("sun4u");
  });
});

describe("version resolution (NOTES DIST6)", () => {
  test("with no LEVARE_VERSION, installs from the fixture's latest/download path", () => {
    const asset = "levare-linux-x64";
    const fixture = makeFixtureRoot();
    writeAsset(join(fixture, "latest", "download"), asset, "latest-marker");
    writeAsset(join(fixture, "download", "v9.9.9"), asset, "pinned-marker");
    const unameDir = stubUnameDir("Linux", "x86_64");
    const binDir = join(scratchDir("bin"), "bin");

    const result = runInstall(baseEnv(unameDir, { LEVARE_RELEASE_BASE_URL: `file://${fixture}`, LEVARE_BIN_DIR: binDir }));

    expect(result.status).toBe(0);
    const bin = spawnSync(join(binDir, "levare"), ["--version"], { encoding: "utf8" });
    expect(bin.stdout).toContain("latest-marker");
  });

  test("LEVARE_VERSION=vX.Y.Z pins to that release's download path instead of latest", () => {
    const asset = "levare-linux-x64";
    const fixture = makeFixtureRoot();
    writeAsset(join(fixture, "latest", "download"), asset, "latest-marker");
    writeAsset(join(fixture, "download", "v9.9.9"), asset, "pinned-marker");
    const unameDir = stubUnameDir("Linux", "x86_64");
    const binDir = join(scratchDir("bin"), "bin");

    const result = runInstall(
      baseEnv(unameDir, { LEVARE_RELEASE_BASE_URL: `file://${fixture}`, LEVARE_BIN_DIR: binDir, LEVARE_VERSION: "v9.9.9" }),
    );

    expect(result.status).toBe(0);
    const bin = spawnSync(join(binDir, "levare"), ["--version"], { encoding: "utf8" });
    expect(bin.stdout).toContain("pinned-marker");
  });

  test("a pinned version that doesn't exist in the fixture fails cleanly", () => {
    const asset = "levare-linux-x64";
    const fixture = makeFixtureRoot();
    writeAsset(join(fixture, "latest", "download"), asset, "latest-marker");
    const unameDir = stubUnameDir("Linux", "x86_64");
    const binDir = join(scratchDir("bin"), "bin");

    const result = runInstall(
      baseEnv(unameDir, { LEVARE_RELEASE_BASE_URL: `file://${fixture}`, LEVARE_BIN_DIR: binDir, LEVARE_VERSION: "v0.0.1-missing" }),
    );

    expect(result.status).not.toBe(0);
    expect(existsSync(binDir)).toBe(false);
  });
});

describe("LEVARE_BIN_DIR override and default (NOTES DIST6)", () => {
  test("LEVARE_BIN_DIR overrides where the binary lands", () => {
    const asset = "levare-linux-x64";
    const fixture = makeFixtureRoot();
    writeAsset(join(fixture, "latest", "download"), asset, "ok");
    const unameDir = stubUnameDir("Linux", "x86_64");
    const customBin = join(scratchDir("custom-bin"), "somewhere", "else");

    const result = runInstall(baseEnv(unameDir, { LEVARE_RELEASE_BASE_URL: `file://${fixture}`, LEVARE_BIN_DIR: customBin }));

    expect(result.status).toBe(0);
    expect(existsSync(join(customBin, "levare"))).toBe(true);
  });

  test("without LEVARE_BIN_DIR, installs to ~/.local/bin under HOME", () => {
    const asset = "levare-linux-x64";
    const fixture = makeFixtureRoot();
    writeAsset(join(fixture, "latest", "download"), asset, "ok");
    const unameDir = stubUnameDir("Linux", "x86_64");
    const home = scratchDir("home-default");

    const result = runInstall({
      PATH: `${unameDir}:${process.env.PATH ?? ""}`,
      HOME: home,
      TMPDIR: scratchDir("tmpdir"),
      LEVARE_RELEASE_BASE_URL: `file://${fixture}`,
    });

    expect(result.status).toBe(0);
    expect(existsSync(join(home, ".local", "bin", "levare"))).toBe(true);
  });
});

describe("checksum verification and failure behavior (NOTES DIST6)", () => {
  test("a checksum mismatch refuses the install and leaves the bin dir untouched", () => {
    const asset = "levare-linux-x64";
    const fixture = makeFixtureRoot();
    const dir = join(fixture, "latest", "download");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, asset), fakeBinary("tampered"));
    chmodSync(join(dir, asset), 0o755);
    // Deliberately wrong hash — the fixture's SHA256SUMS does not match the asset bytes above.
    writeFileSync(join(dir, "SHA256SUMS"), `${"0".repeat(64)}  ${asset}\n`);
    const unameDir = stubUnameDir("Linux", "x86_64");
    const binDir = join(scratchDir("bin"), "bin");

    const result = runInstall(baseEnv(unameDir, { LEVARE_RELEASE_BASE_URL: `file://${fixture}`, LEVARE_BIN_DIR: binDir }));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("checksum verification failed");
    expect(existsSync(binDir)).toBe(false);
  });

  test("a checksum mismatch leaves no scratch directory behind under TMPDIR", () => {
    const asset = "levare-linux-x64";
    const fixture = makeFixtureRoot();
    const dir = join(fixture, "latest", "download");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, asset), fakeBinary("tampered"));
    chmodSync(join(dir, asset), 0o755);
    writeFileSync(join(dir, "SHA256SUMS"), `${"0".repeat(64)}  ${asset}\n`);
    const unameDir = stubUnameDir("Linux", "x86_64");
    const tmp = scratchDir("tmpdir-clean-check");

    const result = runInstall({
      PATH: `${unameDir}:${process.env.PATH ?? ""}`,
      HOME: scratchDir("home"),
      TMPDIR: tmp,
      LEVARE_RELEASE_BASE_URL: `file://${fixture}`,
      LEVARE_BIN_DIR: join(scratchDir("bin"), "bin"),
    });

    expect(result.status).not.toBe(0);
    const leftovers = readdirSync(tmp).filter((name) => name.startsWith("levare-install."));
    expect(leftovers).toEqual([]);
  });

  test("an asset missing from SHA256SUMS fails cleanly, naming the asset", () => {
    const asset = "levare-linux-x64";
    const fixture = makeFixtureRoot();
    const dir = join(fixture, "latest", "download");
    mkdirSync(dir, { recursive: true });
    const content = fakeBinary("ok");
    writeFileSync(join(dir, asset), content);
    chmodSync(join(dir, asset), 0o755);
    // SHA256SUMS lists a different filename entirely, matching no asset actually downloaded.
    writeFileSync(join(dir, "SHA256SUMS"), `${sha256(content)}  levare-darwin-arm64\n`);
    const unameDir = stubUnameDir("Linux", "x86_64");

    const result = runInstall(
      baseEnv(unameDir, { LEVARE_RELEASE_BASE_URL: `file://${fixture}`, LEVARE_BIN_DIR: join(scratchDir("bin"), "bin") }),
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("does not list");
    expect(result.stderr).toContain(asset);
  });
});

describe("idempotency and PATH warning (NOTES DIST6)", () => {
  test("running install twice in a row succeeds both times with the same result", () => {
    const asset = "levare-linux-x64";
    const fixture = makeFixtureRoot();
    writeAsset(join(fixture, "latest", "download"), asset, "ok");
    const unameDir = stubUnameDir("Linux", "x86_64");
    const binDir = join(scratchDir("bin"), "bin");
    const env = baseEnv(unameDir, { LEVARE_RELEASE_BASE_URL: `file://${fixture}`, LEVARE_BIN_DIR: binDir });

    const first = runInstall(env);
    const second = runInstall(env);

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    const bin = spawnSync(join(binDir, "levare"), ["--version"], { encoding: "utf8" });
    expect(bin.stdout).toContain("ok");
  });

  test("warns on stderr, without failing, when the install dir is off PATH", () => {
    const asset = "levare-linux-x64";
    const fixture = makeFixtureRoot();
    writeAsset(join(fixture, "latest", "download"), asset, "ok");
    const unameDir = stubUnameDir("Linux", "x86_64");
    const binDir = join(scratchDir("off-path-bin"), "bin");

    const result = runInstall(baseEnv(unameDir, { LEVARE_RELEASE_BASE_URL: `file://${fixture}`, LEVARE_BIN_DIR: binDir }));

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("not on PATH");
  });

  test("does not warn when the install dir is already on PATH", () => {
    const asset = "levare-linux-x64";
    const fixture = makeFixtureRoot();
    writeAsset(join(fixture, "latest", "download"), asset, "ok");
    const unameDir = stubUnameDir("Linux", "x86_64");
    const binDir = join(scratchDir("on-path-bin"), "bin");
    mkdirSync(binDir, { recursive: true });

    const result = runInstall(
      baseEnv(unameDir, {
        LEVARE_RELEASE_BASE_URL: `file://${fixture}`,
        LEVARE_BIN_DIR: binDir,
        PATH: `${unameDir}:${binDir}:${process.env.PATH ?? ""}`,
      }),
    );

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("not on PATH");
  });
});

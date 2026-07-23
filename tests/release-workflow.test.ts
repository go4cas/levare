import { test, expect, describe } from "bun:test";
import { readFileSync, existsSync } from "node:fs";

// NOTES DIST2: the release workflow can only truly be exercised by GitHub Actions itself (pushing a
// tag and watching the run — see NOTES). This suite is the part that CAN be checked locally and in
// `bun test`: the YAML parses, the tag trigger is exactly the descriptive-tags-excluding
// semver-shaped glob, the four-platform matrix matches NOTES DIST2's list verbatim, the job
// dependency chain gates the release on a passing build, and the release job's token scope is the
// minimum needed.
//
// The trigger used to be the bare `v*` glob, which matches ANY tag starting with the letter "v" —
// not just semver ones. Combined with release.yml's old unconditional `${GITHUB_REF_NAME#v}` strip,
// pushing a word-shaped tag like `vendor-cli-gh` (itself starting with "v", so it matched `v*`)
// triggered a real release and stamped a mangled version (`endor-cli-gh`) into the published binary.
// The trigger is now the stricter `v[0-9]+.[0-9]+.[0-9]+*`, so a tag has to actually look like
// `vMAJOR.MINOR.PATCH[...]` to ever reach the release job — see src/version.ts#versionFromTag for
// the matching fix to the strip itself.

const WORKFLOW_PATH = ".github/workflows/release.yml";

function loadWorkflow(): any {
  return Bun.YAML.parse(readFileSync(WORKFLOW_PATH, "utf8"));
}

// A glob-to-regex conversion covering what this workflow's tag filter actually uses: `*` (any run of
// characters), and bracket character classes with a `+` quantifier (`[0-9]+`) — not a general GitHub
// Actions filter-pattern implementation.
function matchesTagGlob(pattern: string, tag: string): boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      re += ".*";
    } else if (c === "[") {
      const end = pattern.indexOf("]", i);
      re += pattern.slice(i, end + 1);
      i = end;
    } else if (c === "+") {
      re += "+";
    } else if (".^$()|\\{}?".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`).test(tag);
}

describe("release workflow (NOTES DIST2)", () => {
  test("the workflow file is valid YAML", () => {
    expect(() => loadWorkflow()).not.toThrow();
  });

  test("triggers on push of tags, with exactly the semver-shaped `v[0-9]+.[0-9]+.[0-9]+*` pattern", () => {
    const wf = loadWorkflow();
    expect(wf.on.push.tags).toEqual(["v[0-9]+.[0-9]+.[0-9]+*"]);
  });

  test("the trigger pattern matches semver-shaped release tags", () => {
    const pattern = loadWorkflow().on.push.tags[0];
    for (const tag of ["v0.1.0", "v1.2.3", "v0.1.0-rc1", "v10.20.30"]) {
      expect(matchesTagGlob(pattern, tag)).toBe(true);
    }
  });

  test("the trigger pattern does NOT match the descriptive waypoint tags used during development", () => {
    const pattern = loadWorkflow().on.push.tags[0];
    for (const tag of ["dist1", "f11", "ui6"]) {
      expect(matchesTagGlob(pattern, tag)).toBe(false);
    }
  });

  test("the trigger pattern does NOT match word-shaped tags that merely start with the letter 'v' (the actual incident)", () => {
    const pattern = loadWorkflow().on.push.tags[0];
    for (const tag of ["vendor-cli-gh", "v11-conv"]) {
      expect(matchesTagGlob(pattern, tag)).toBe(false);
    }
  });

  test("release.yml derives the stamped version via versionFromTag, not an inline shell strip", () => {
    const wf = loadWorkflow();
    const stampStep = wf.jobs.build.steps.find((s: { name?: string }) => s.name === "Stamp package.json version from the release tag");
    const smokeStep = wf.jobs.build.steps.find((s: { name?: string }) => s.name === "Smoke-test the version stamp");
    expect(stampStep.run).toContain("versionFromTag");
    expect(smokeStep.run).toContain("versionFromTag");
    expect(stampStep.run).not.toContain("GITHUB_REF_NAME#v");
    expect(smokeStep.run).not.toContain("GITHUB_REF_NAME#v");
  });

  test("builds exactly the four in-scope platform targets, none of them Windows", () => {
    const wf = loadWorkflow();
    const matrix = wf.jobs.build.strategy.matrix.include;
    const targets = matrix.map((m: { target: string }) => m.target).sort();
    expect(targets).toEqual(["bun-darwin-arm64", "bun-darwin-x64", "bun-linux-arm64", "bun-linux-x64"]);
    expect(targets.some((t: string) => /windows/i.test(t))).toBe(false);
  });

  test("each matrix leg names an asset that identifies its platform", () => {
    const wf = loadWorkflow();
    const matrix = wf.jobs.build.strategy.matrix.include;
    for (const { target, asset } of matrix as { target: string; asset: string }[]) {
      const platform = target.replace(/^bun-/, "");
      expect(asset).toBe(`levare-${platform}`);
    }
  });

  test("every build leg reuses scripts/build.sh (DIST1's build path), not a hand-rolled bun build invocation", () => {
    const wf = loadWorkflow();
    const buildStep = wf.jobs.build.steps.find((s: { run?: string }) => s.run?.includes("scripts/build.sh"));
    expect(buildStep).toBeDefined();
    expect(buildStep.run).toContain("./scripts/build.sh");
  });

  test("the build job is gated on the verify job (tests + deps:check) passing first", () => {
    const wf = loadWorkflow();
    expect(wf.jobs.build.needs).toBe("verify");
    const verifySteps = wf.jobs.verify.steps.map((s: { run?: string }) => s.run).filter(Boolean);
    expect(verifySteps.some((r: string) => r.includes("bun test"))).toBe(true);
    expect(verifySteps.some((r: string) => r.includes("deps:check"))).toBe(true);
  });

  test("the release job depends on build, and only it carries write permissions", () => {
    const wf = loadWorkflow();
    expect(wf.jobs.release.needs).toBe("build");
    expect(wf.jobs.release.permissions).toEqual({ contents: "write" });
    expect(wf.permissions).toEqual({ contents: "read" });
  });

  test("the release step publishes the checksums file alongside the binaries", () => {
    const wf = loadWorkflow();
    const releaseStep = wf.jobs.release.steps.find((s: { uses?: string }) => s.uses?.startsWith("softprops/action-gh-release"));
    expect(releaseStep).toBeDefined();
    expect(releaseStep.with.files).toContain("SHA256SUMS");
  });

  test("the release notes body states the runtime prerequisites plainly (git, and a model provider)", () => {
    const wf = loadWorkflow();
    const releaseStep = wf.jobs.release.steps.find((s: { uses?: string }) => s.uses?.startsWith("softprops/action-gh-release"));
    const body: string = releaseStep.with.body;
    expect(body).toContain("NOT zero-setup");
    expect(body.toLowerCase()).toContain("git");
    expect(body).toContain("ANTHROPIC_API_KEY");
    expect(body.toLowerCase()).toContain("model provider");
  });

  test("a checksums-generation step exists ahead of the release step", () => {
    const wf = loadWorkflow();
    const steps = wf.jobs.release.steps;
    const shaStepIdx = steps.findIndex((s: { run?: string }) => s.run?.includes("sha256sum"));
    const releaseStepIdx = steps.findIndex((s: { uses?: string }) => s.uses?.startsWith("softprops/action-gh-release"));
    expect(shaStepIdx).toBeGreaterThanOrEqual(0);
    expect(shaStepIdx).toBeLessThan(releaseStepIdx);
  });
});

// Achieved-when: "the README/docs install section matches what the workflow actually produces
// (asset names, checksum file, verify steps)" — asserted directly, so the two can never silently
// drift apart (e.g. a matrix asset renamed in the workflow without the README following).
describe("README install section matches the release workflow (NOTES DIST2)", () => {
  const readme = readFileSync("README.md", "utf8");

  test("every matrix asset name is named in the README", () => {
    const wf = loadWorkflow();
    const matrix = wf.jobs.build.strategy.matrix.include as { asset: string }[];
    for (const { asset } of matrix) expect(readme).toContain(asset);
  });

  test("the README names the same checksum file the workflow generates", () => {
    const wf = loadWorkflow();
    const releaseStep = wf.jobs.release.steps.find((s: { uses?: string }) => s.uses?.startsWith("softprops/action-gh-release"));
    expect(releaseStep.with.files).toContain("SHA256SUMS");
    expect(readme).toContain("SHA256SUMS");
  });

  test("the README's verify command matches the checksum tool the workflow uses", () => {
    const wf = loadWorkflow();
    const shaStep = wf.jobs.release.steps.find((s: { run?: string }) => s.run?.includes("sha256sum"));
    expect(shaStep.run).toContain("sha256sum");
    expect(readme).toContain("sha256sum -c SHA256SUMS");
  });

  test("the README states the same runtime prerequisites as the release notes: git and a model provider", () => {
    expect(readme.toLowerCase()).toContain("zero-setup");
    expect(readme).toContain("`git`");
    expect(readme).toContain("ANTHROPIC_API_KEY");
  });

  test("the README's curl|sh install claim points at a real file in this repo (NOTES DIST6)", () => {
    const match = readme.match(/curl[^\n`]*\|\s*sh/);
    expect(match).not.toBeNull();
    const line = match![0];
    const urlMatch = line.match(/https:\/\/raw\.githubusercontent\.com\/go4cas\/levare\/main\/(\S+)/);
    expect(urlMatch).not.toBeNull();
    const repoPath = urlMatch![1];
    expect(existsSync(repoPath)).toBe(true);
  });

  test("the README does not claim a Homebrew formula (declined, not deferred — NOTES DIST6)", () => {
    expect(readme.toLowerCase()).not.toContain("brew install");
  });
});

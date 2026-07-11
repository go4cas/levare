import { test, expect, describe } from "bun:test";
import { loadRepo } from "../src/repo.ts";
import { checkGuardrails, allowedTools, type DiffEntry } from "../src/guardrails.ts";

// Guardrails (§6) are deterministic diff inspection before a merge gate — no LLM. The golden team
// kestrel declares protected_paths [main, deploy/] and never [force-push, delete-branch].

const repo = loadRepo("fixtures/golden");
const kestrel = repo.teams.get("kestrel")!;

describe("protected-path / never guardrails", () => {
  test("a diff touching only ordinary files is clear to gate", () => {
    const diff: DiffEntry[] = [{ path: "src/checkout/page.tsx", action: "modify" }, { path: "README.md", action: "modify" }];
    expect(checkGuardrails(kestrel, diff)).toEqual([]);
  });

  test("touching a protected directory (deploy/) is a violation", () => {
    const v = checkGuardrails(kestrel, [{ path: "deploy/pipeline.yml", action: "modify" }]);
    expect(v.length).toBe(1);
    expect(v[0].rule).toBe("protected-path");
    expect(v[0].detail).toContain("deploy/");
  });

  test("a force-push to the protected main BRANCH fires branch + never (C6)", () => {
    const v = checkGuardrails(kestrel, [{ branch: "main", action: "force-push" }]);
    expect(v.map((x) => x.rule).sort()).toEqual(["never", "protected-branch"]);
    expect(v.find((x) => x.rule === "protected-branch")!.branch).toBe("main");
  });

  test("branches and paths are SEPARATE namespaces — a path with a 'main' segment is not a branch hit (C6)", () => {
    // Neither a file path containing 'main' nor a 'deploy' substring path may match a protected entry.
    expect(checkGuardrails(kestrel, [{ path: "src/main/app.ts", action: "modify" }])).toEqual([]);
    expect(checkGuardrails(kestrel, [{ path: "deploy-notes.md", action: "modify" }])).toEqual([]);
    // A protected BRANCH is not matched by a like-named file path, and vice-versa.
    expect(checkGuardrails(kestrel, [{ path: "main", action: "modify" }])).toEqual([]);
    expect(checkGuardrails(kestrel, [{ branch: "deploy/", action: "modify" }])).toEqual([]);
  });

  test("a `never` action (delete-branch) is flagged regardless of path", () => {
    const v = checkGuardrails(kestrel, [{ branch: "feature/x", action: "delete-branch" }]);
    expect(v.length).toBe(1);
    expect(v[0].rule).toBe("never");
    expect(v[0].detail).toContain("delete-branch");
  });

  test("a team with no guardrails passes everything", () => {
    const bare = { ...kestrel, guardrails: undefined };
    expect(checkGuardrails(bare, [{ path: "deploy/x", branch: "main", action: "force-push" }])).toEqual([]);
  });
});

describe("tool allowlist", () => {
  test("a native agent's allowlist is exactly its declared tools", () => {
    expect(allowedTools(repo.agents.get("lyra")!)).toEqual(["read", "write"]);
  });

  test("an agent with no declared tools gets an empty allowlist (nothing implicit)", () => {
    expect(allowedTools(repo.agents.get("finch")!)).toEqual([]);
  });
});

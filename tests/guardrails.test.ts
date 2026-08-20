import { test, expect, describe } from "bun:test";
import { loadRepo } from "../src/repo.ts";
import { checkGuardrails, allowedTools, violationLine, isBlockingViolationLine, type DiffEntry } from "../src/guardrails.ts";

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

// Actor-aware ruling (2026-08-20): Conductor approval at the merge gate is itself the authority to
// write to a protected branch — an entry carrying `approvedGate` proves that; one without it is treated
// exactly as before (a member pushing from its worktree, a cli member with shell access, or any other
// unapproved write to a protected ref stays blocked).
describe("protected-branch is actor-aware; protected-path and never are not", () => {
  const approvedGate = { approvedBy: "cas 2026-08-20", branchSha: "deadbeef" };

  test("a branch write with no approvedGate is blocked, exactly as before", () => {
    const v = checkGuardrails(kestrel, [{ branch: "main", action: "merge" }]);
    expect(v.length).toBe(1);
    expect(v[0].rule).toBe("protected-branch");
  });

  test("the SAME write carrying approvedGate is not a violation", () => {
    expect(checkGuardrails(kestrel, [{ branch: "main", action: "merge", approvedGate }])).toEqual([]);
  });

  test("approvedGate never exempts protected-path", () => {
    const v = checkGuardrails(kestrel, [{ path: "deploy/x", action: "modify", approvedGate }]);
    expect(v.length).toBe(1);
    expect(v[0].rule).toBe("protected-path");
  });

  test("approvedGate never exempts a never-listed action, even stamped on the same entry", () => {
    // mergeDiffEntries (merge.ts) never actually pairs approvedGate with a never-listed action —
    // approvedGate only ever accompanies action "merge"/"push" — so this is a synthetic combination.
    // It still proves the safety property the ruling requires: `never` does not consult `approvedGate`
    // at all, so it fires regardless of what else is stamped on the same entry.
    const v = checkGuardrails(kestrel, [{ branch: "main", action: "force-push", approvedGate }]);
    expect(v.map((x) => x.rule)).toContain("never");
  });

  test("the message names the actual action rather than always saying 'push'", () => {
    const v = checkGuardrails(kestrel, [{ branch: "main", action: "merge" }]);
    expect(v[0].detail).toContain("merge to protected branch");
    expect(v[0].detail).not.toContain("push to protected branch");
  });
});

describe("violation line helpers", () => {
  test("violationLine flattens rule and detail the same way every caller expects", () => {
    expect(violationLine({ rule: "protected-branch", detail: "merge to protected branch 'main' (team 'x')" })).toBe("protected-branch: merge to protected branch 'main' (team 'x')");
  });

  test("isBlockingViolationLine treats only protected-branch as non-blocking", () => {
    expect(isBlockingViolationLine("protected-branch: merge to protected branch 'main' (team 'x')")).toBe(false);
    expect(isBlockingViolationLine("protected-path: 'x' touches protected path 'x' (team 'x')")).toBe(true);
    expect(isBlockingViolationLine("never: action 'force-push' is in team 'x' never list")).toBe(true);
  });
});

describe("tool allowlist", () => {
  test("a native agent's allowlist is exactly its declared tools", () => {
    expect(allowedTools(repo.agents.get("lyra")!)).toEqual(["Read", "Write"]);
  });

  test("an agent with no declared tools gets an empty allowlist (nothing implicit)", () => {
    expect(allowedTools(repo.agents.get("finch")!)).toEqual([]);
  });
});

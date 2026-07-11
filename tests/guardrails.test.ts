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

  test("touching the protected main branch/path is a violation", () => {
    const v = checkGuardrails(kestrel, [{ path: "main", action: "force-push" }]);
    // Both the protected-path (main) and the never (force-push) rules fire.
    expect(v.map((x) => x.rule).sort()).toEqual(["never", "protected-path"]);
  });

  test("a `never` action (delete-branch) is flagged regardless of path", () => {
    const v = checkGuardrails(kestrel, [{ path: "feature/x", action: "delete-branch" }]);
    expect(v.length).toBe(1);
    expect(v[0].rule).toBe("never");
    expect(v[0].detail).toContain("delete-branch");
  });

  test("a team with no guardrails passes everything", () => {
    const bare = { ...kestrel, guardrails: undefined };
    expect(checkGuardrails(bare, [{ path: "deploy/x", action: "force-push" }])).toEqual([]);
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

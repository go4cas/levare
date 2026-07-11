// levare guardrails (§6): deterministic, no LLM. Two families, both enforced by inspecting a diff
// before a merge gate — `protected_paths` (files/branches a team may not touch) and `never` actions
// (e.g. force-push, delete-branch). A violation blocks the merge; it never silently proceeds.
//
// Tool allowlists and env scoping are the other two guardrails; env scoping lives in env.ts, and the
// tool allowlist is a pure projection of an agent's declared `tools:` (allowedTools below).

import type { Agent, Team } from "./types.ts";

/** A single changed path (and optionally the git action that produced it) from a proposed merge. */
export interface DiffEntry {
  path: string;
  /** e.g. "force-push", "delete-branch", "modify" — matched against the team's `never` list. */
  action?: string;
}

export interface GuardrailViolation {
  rule: "protected-path" | "never";
  detail: string;
  path?: string;
}

// A protected entry matches a changed path when it names the path exactly, is a prefix directory
// (trailing slash, e.g. `deploy/`), or names a path segment (e.g. branch `main`). Kept intentionally
// simple: the team declares literal paths/branches, not globs.
function protects(entry: string, path: string): boolean {
  if (entry.endsWith("/")) return path === entry.slice(0, -1) || path.startsWith(entry);
  if (path === entry) return true;
  if (path.startsWith(`${entry}/`)) return true;
  return path.split("/").includes(entry);
}

/** Check a proposed merge diff against a team's guardrails; [] means clear to gate. */
export function checkGuardrails(team: Team, diff: DiffEntry[]): GuardrailViolation[] {
  const g = team.guardrails;
  if (!g) return [];
  const violations: GuardrailViolation[] = [];
  const never = g.never ?? [];
  const protectedPaths = g.protected_paths ?? [];
  for (const entry of diff) {
    if (entry.action && never.includes(entry.action)) {
      violations.push({ rule: "never", detail: `action '${entry.action}' is in team '${team.name}' never list`, path: entry.path });
    }
    for (const p of protectedPaths) {
      if (protects(p, entry.path)) {
        violations.push({ rule: "protected-path", detail: `'${entry.path}' touches protected path '${p}' (team '${team.name}')`, path: entry.path });
      }
    }
  }
  return violations;
}

/**
 * The tool allowlist for a native agent: exactly its declared `tools:`, nothing implicit. The native
 * adapter passes this to the SDK so a member can only call tools it was granted.
 */
export function allowedTools(agent: Agent): string[] {
  return agent.tools ?? [];
}

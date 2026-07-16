// levare guardrails (§6): deterministic, no LLM. Two families, both enforced by inspecting a diff
// before a merge gate — `protected_paths` (files/branches a team may not touch) and `never` actions
// (e.g. force-push, delete-branch). A violation blocks the merge; it never silently proceeds.
//
// Tool allowlists and env scoping are the other two guardrails; env scoping lives in env.ts, and the
// tool allowlist is a pure projection of an agent's declared `tools:` (allowedTools below).

import type { Agent, Team } from "./types.ts";

// A single change from a proposed merge. `path` is a changed file path; `branch` is the git ref the
// change targets (e.g. the push destination). They are DIFFERENT namespaces (ruling C6): a file path
// is never matched against protected branches, and vice-versa. `action` is matched against `never`.
export interface DiffEntry {
  path?: string;
  branch?: string;
  /** e.g. "force-push", "delete-branch", "modify" — matched against the team's `never` list. */
  action?: string;
}

export interface GuardrailViolation {
  rule: "protected-path" | "protected-branch" | "never";
  detail: string;
  path?: string;
  branch?: string;
}

// A protected path entry matches a changed FILE PATH when it names the path exactly or is a prefix
// directory (trailing slash, e.g. `deploy/`). No segment matching — `deploy` never matches
// `src/deploy-notes.ts` or a path merely CONTAINING a "deploy" segment. Literal paths, not globs.
function protectsPath(entry: string, path: string): boolean {
  if (entry.endsWith("/")) return path === entry.slice(0, -1) || path.startsWith(entry);
  return path === entry || path.startsWith(`${entry}/`);
}

/**
 * Whether a team declares a non-empty `guardrails:` block — used only for TELLING the Conductor the
 * enforcement gap (doctor, the registry card), never for enforcement itself (NOTES REV1 finding 2):
 * `checkGuardrails` below has no production caller; the merge phase that would call it is formally
 * deferred to v1.1 (docs/prd-amendment-1.md §2, invariant 6).
 */
export function hasDeclaredGuardrails(team: Team): boolean {
  const g = team.guardrails;
  return !!g && ((g.protected_paths?.length ?? 0) > 0 || (g.protected_branches?.length ?? 0) > 0 || (g.never?.length ?? 0) > 0);
}

/** Check a proposed merge diff against a team's guardrails; [] means clear to gate. */
export function checkGuardrails(team: Team, diff: DiffEntry[]): GuardrailViolation[] {
  const g = team.guardrails;
  if (!g) return [];
  const violations: GuardrailViolation[] = [];
  const never = g.never ?? [];
  const protectedPaths = g.protected_paths ?? [];
  const protectedBranches = g.protected_branches ?? [];
  for (const entry of diff) {
    if (entry.action && never.includes(entry.action)) {
      violations.push({ rule: "never", detail: `action '${entry.action}' is in team '${team.name}' never list`, path: entry.path, branch: entry.branch });
    }
    // Branch namespace: a protected branch matches only the change's `branch` ref, exactly.
    if (entry.branch !== undefined && protectedBranches.includes(entry.branch)) {
      violations.push({ rule: "protected-branch", detail: `push to protected branch '${entry.branch}' (team '${team.name}')`, branch: entry.branch });
    }
    // Path namespace: a protected path matches only the change's file `path`.
    if (entry.path !== undefined) {
      for (const p of protectedPaths) {
        if (protectsPath(p, entry.path)) {
          violations.push({ rule: "protected-path", detail: `'${entry.path}' touches protected path '${p}' (team '${team.name}')`, path: entry.path });
        }
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

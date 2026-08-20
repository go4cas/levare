// levare guardrails (§6): deterministic, no LLM. Two families, both enforced by inspecting a diff
// at merge-gate EXECUTION time (NOTES MERGE-1, PRD Amendment 2 M3; board/gateops.ts#doApproveMerge is
// `checkGuardrails`'s production call site) — `protected_paths` (files/branches a team may not touch)
// and `never` actions (e.g. force-push, delete-branch). A `protected-path` or `never` violation FAILS
// the execution, even after Conductor approval; it never silently proceeds.
//
// Actor-aware ruling (2026-08-20): `protected-branch` is the one exception. Conductor approval AT THE
// MERGE GATE is itself the authority to land on a protected branch — "nothing reaches main except
// through the merge gate" is the point of protecting it, not a wall against the gate's own sanctioned
// write. `doApproveMerge` proves this by attaching `DiffEntry.approvedGate` (its own recorded approver
// and the exact `branch_sha` the trial evaluated) to the branch entries it builds — every OTHER caller
// (a preview/recheck, or any future write path that isn't the approved gate itself) omits it, so an
// unapproved write to the same ref stays blocked exactly as before. `protected_paths` and `never` never
// look at `approvedGate` at all — they stay absolute regardless of actor.
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
  /** e.g. "force-push", "delete-branch", "merge", "push" — matched against the team's `never` list. */
  action?: string;
  /** Set ONLY by an approved merge gate's own execution (board/gateops.ts#doApproveMerge) — proof that
   * THIS write to `branch` is the Conductor-approved gate landing the exact diff it just reviewed, not
   * an unapproved write to the same ref (a member pushing from its worktree, a `cli` member's own git
   * push). Recognized by the `protected-branch` rule only; `never` never consults it — force-push and
   * delete-branch stay absolute no matter who or what is asking (ruling, 2026-08-20). */
  approvedGate?: { approvedBy: string; branchSha: string };
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

/** Whether a team declares a non-empty `guardrails:` block. */
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
    // Branch namespace: a protected branch matches only the change's `branch` ref, exactly. Skipped
    // when the entry itself carries proof this IS the approved gate's own execution (see the
    // `approvedGate` field's own doc) — an unapproved write to the same branch still has none, so it
    // is unaffected and still flagged below.
    if (entry.branch !== undefined && protectedBranches.includes(entry.branch) && !entry.approvedGate) {
      // The action actually being performed, not a hardcoded assumption — `mergeDiffEntries` builds a
      // separate entry per action ("merge", and "push" only when the project has a `remote:`), so the
      // message names whichever one this entry actually is instead of always saying "push".
      const verb = entry.action === "push" ? "push" : entry.action === "merge" ? "merge" : "write";
      violations.push({ rule: "protected-branch", detail: `${verb} to protected branch '${entry.branch}' (team '${team.name}')`, branch: entry.branch });
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

/** The flattened `"rule: detail"` line every on-disk `guardrail_violations` entry is built from
 * (merge.ts#formatMergeArtifact, board/gateops.ts#doRecheckMerge) — one place so `isBlockingViolationLine`
 * below stays in sync with whatever actually builds these lines. */
export function violationLine(v: GuardrailViolation): string {
  return `${v.rule}: ${v.detail}`;
}

/** Whether an already-flattened violation line (as read back from an artifact's `guardrail_violations`
 * — plain strings, not `GuardrailViolation` objects, by the schema in validate.ts) is a genuine blocker.
 * `protected-branch` is advisory once it reaches a merge gate at all (an unapproved write is never the
 * shape this check runs against in this codebase today — see guardrails.ts's own header): Conductor
 * approval is what resolves it, so callers deciding whether to OFFER approval (board/render/shell.ts's
 * `canApprove`) must not treat it as a reason to withhold the button. `protected-path` and `never` lines
 * never match this prefix and stay blocking, unaffected. */
export function isBlockingViolationLine(line: string): boolean {
  return !line.startsWith("protected-branch:");
}

/**
 * The tool allowlist for a native agent: exactly its declared `tools:`, nothing implicit. The native
 * adapter passes this to the SDK so a member can only call tools it was granted.
 */
export function allowedTools(agent: Agent): string[] {
  return agent.tools ?? [];
}

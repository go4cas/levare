// levare env scoping (§6 guardrails, invariant 11). A member's spawned process sees ONLY the env
// vars its granted connectors name, plus a minimal PATH/HOME baseline — an allowlist, never a
// denylist over process.env. A secret for a connector a member wasn't granted can never leak into
// its environment, because nothing is copied through unless a grant (or the baseline) names it.
//
// Grants are the union of the member's agent-level `connectors:` and its team's `connectors:` (§5).

import type { Connector, Team } from "./types.ts";
import type { Repo } from "./repo.ts";

// The only vars a member gets for free — enough to find its interpreter and home, nothing sensitive.
// Documented in NOTES (phase-3 security posture): PATH so a wrapped CLI resolves, HOME so it can
// locate its own config/cache. No TERM, no LANG, no cloud creds — those must come via a connector.
export const ENV_BASELINE = ["PATH", "HOME"] as const;

/** The team a member belongs to (first team listing them), or undefined. */
export function teamOf(repo: Repo, member: string): Team | undefined {
  for (const team of repo.teams.values()) {
    if (team.members.includes(member)) return team;
  }
  return undefined;
}

/** Resolve the connector definitions granted to a member (agent grants ∪ team grants). */
export function grantedConnectors(repo: Repo, member: string): Connector[] {
  const agent = repo.agents.get(member);
  const team = teamOf(repo, member);
  const names = new Set<string>([...(agent?.connectors ?? []), ...(team?.connectors ?? [])]);
  const out: Connector[] = [];
  for (const name of names) {
    const c = repo.connectors.get(name);
    if (c) out.push(c);
  }
  return out;
}

/**
 * Build the allowlisted environment for a member's spawned process. Contains exactly: the baseline
 * vars that are present in `base`, plus the env vars named by the member's granted connectors that
 * are present in `base`. Nothing else from `base` is carried through.
 */
export function buildMemberEnv(
  repo: Repo,
  member: string,
  base: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  const allow = (name: string) => {
    const v = base[name];
    if (typeof v === "string") env[name] = v;
  };
  for (const name of ENV_BASELINE) allow(name);
  for (const c of grantedConnectors(repo, member)) {
    for (const varName of c.env) allow(varName);
  }
  return env;
}

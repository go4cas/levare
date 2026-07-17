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
 * NOTES C13: the `auth: subscription` connector granted to a member, if any. Its `env` is empty by
 * construction (validated), so `buildMemberEnv` below already has nothing extra to allowlist for
 * it — this exists purely so callers that need to know a member is subscription-authenticated
 * (receipt cost accounting, doctor) can ask without re-deriving the grant themselves.
 */
export function subscriptionConnector(repo: Repo, member: string): Connector | undefined {
  return grantedConnectors(repo, member).find((c) => c.auth === "subscription");
}

function allowlist(names: readonly string[], base: Record<string, string | undefined>, env: Record<string, string>): void {
  for (const name of names) {
    const v = base[name];
    if (typeof v === "string") env[name] = v;
  }
}

/**
 * Build the allowlisted environment for a member's spawned process. Contains exactly: the baseline
 * vars that are present in `base`, plus the env vars named by the member's granted connectors that
 * are present in `base` — EXCEPT a connector's vars are withheld entirely when `effects: write` and
 * `gate: proposal` (the default for a write connector, NOTES CAP-A): the grant now means "may draft a
 * proposal against this connector", never "holds its credential" — only `execution.ts`'s own
 * execution step (run once a Conductor approves the proposal gate) ever reads those vars, and it
 * reads them straight from the process, never from this function. `gate: trusted` is the declared,
 * visible opt-out — it injects exactly like an `effects: read` connector always has. Nothing else
 * from `base` is carried through.
 */
export function buildMemberEnv(
  repo: Repo,
  member: string,
  base: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  allowlist(ENV_BASELINE, base, env);
  for (const c of grantedConnectors(repo, member)) {
    if (c.effects === "write" && c.gate !== "trusted") continue; // withheld — proposal-gated (NOTES CAP-A).
    allowlist(c.env, base, env);
  }
  return env;
}

/**
 * NOTES CAP-A: the execution-time counterpart to `buildMemberEnv` — used ONLY by `execution.ts` when
 * a Conductor approves a proposal gate, never by a member's own spawned process. Contains exactly the
 * baseline plus this ONE connector's own named vars — not a member's full grant set, and not gated by
 * anything a member could influence (a proposal names a connector; it is levare's own execution step,
 * not the member, that reads the connector's credential, and only for the one connector the approved
 * proposal named).
 */
export function buildConnectorEnv(
  connector: Connector,
  base: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  allowlist(ENV_BASELINE, base, env);
  allowlist(connector.env, base, env);
  return env;
}

/**
 * NOTES F3 — the redaction guard, generalised from doctor.ts's `EnvProbe` (which already reads
 * presence only, never values, per invariant 11). Any diagnostic that wants to SHOW a member's env —
 * a log line, a console message, a future board panel — must describe it through this function, never
 * by handing the `Record<string, string>` a `buildMemberEnv` call actually returns to a
 * console.log/writeFileSync/commit call. It carries the variable NAME and, deliberately, only a
 * `present: true` marker (every entry it returns already passed the allowlist, so "present" is
 * always true here — the shape exists so a caller can never accidentally destructure a `.value`
 * field that doesn't exist).
 */
export function describeMemberEnv(env: Record<string, string>): Array<{ name: string; present: true }> {
  return Object.keys(env)
    .sort()
    .map((name) => ({ name, present: true as const }));
}

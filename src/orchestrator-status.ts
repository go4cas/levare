// NOTES C11: a single, honest description of whether the Orchestrator is reachable — "on" or "off",
// never a third "offline mode" state. Used by three surfaces that must never drift from each other:
// the board's rendered header/rail indicator (render.ts), `levare doctor` (doctor.ts via cli.ts), and
// (indirectly, via the same `checkSdkPreconditionsCached` cache) `orchestrator-boundary.ts#selectOrchestratorBoundary`
// — so "the badge says on" and "the route actually answers" can never disagree.

import { checkSdkPreconditionsCached, type SdkPreconditionOptions } from "./sdk-transport.ts";

export interface OrchestratorStatus {
  available: boolean;
  /** A short, human sentence explaining the state — the same text a doctor line and the panel's
   * disabled note draw from, so the reason is never re-worded per surface. */
  reason: string;
  /** The env var an operator would set to make the Orchestrator available. */
  envVar: string;
}

export const ORCHESTRATOR_ENV_VAR = "ANTHROPIC_API_KEY";

/** Resolve the Orchestrator's current boundary status — cached (30s TTL, see sdk-transport.ts) so a
 * page render or a doctor run never re-walks node_modules resolution on every call. */
export function resolveOrchestratorStatus(
  env: Record<string, string | undefined> = process.env,
  opts: SdkPreconditionOptions = {},
): OrchestratorStatus {
  const check = checkSdkPreconditionsCached(env, opts);
  return {
    available: check.viable,
    reason: check.viable ? "The Orchestrator is live." : (check.reason ?? `${ORCHESTRATOR_ENV_VAR} is not set`),
    envVar: ORCHESTRATOR_ENV_VAR,
  };
}

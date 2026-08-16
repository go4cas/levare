// NOTES C11: a single, honest description of whether the Orchestrator is reachable — "on" or "off",
// never a third "offline mode" state. Used by three surfaces that must never drift from each other:
// the board's rendered header/rail indicator (render.ts), `levare doctor` (doctor.ts via cli.ts), and
// (indirectly, via the same `checkSdkPreconditionsCached` cache) `orchestrator-boundary.ts#selectOrchestratorBoundary`
// — so "the badge says on" and "the route actually answers" can never disagree.

import { checkSdkPreconditionsCached, type SdkPreconditionOptions } from "./sdk-transport.ts";
import type { EnvProvenance } from "./dotenv.ts";

export interface OrchestratorStatus {
  available: boolean;
  /** A short, human sentence explaining the state — the same text a doctor line and the panel's
   * disabled note draw from, so the reason is never re-worded per surface. */
  reason: string;
  /** The env var an operator would set to make the Orchestrator available. */
  envVar: string;
}

export const ORCHESTRATOR_ENV_VAR = "ANTHROPIC_API_KEY";

// NOTES DIST5: a compiled `dist/levare` no longer needs special-casing here. DIST4 forced "off"
// under `--compile` because `sdk-transport.ts`'s worker spawn (`Bun.spawn([process.execPath,
// SDK_WORKER_PATH])`) only worked when `process.execPath` was a real `bun` interpreter, not the
// compiled binary itself. `workerSpawnArgv` (sdk-transport.ts) now self-invokes this same process in
// worker mode instead of spawning a script path, which works identically whether this process is
// compiled or source — so the credential/native-binary precondition below is the ONLY thing that
// determines availability, compiled or not.

/** Resolve the Orchestrator's current boundary status — cached (30s TTL, see sdk-transport.ts) so a
 * page render or a doctor run never re-walks node_modules resolution on every call.
 *
 * `envSource`, when given (DOCS-WALKTHROUGH-3 item 4): where `ANTHROPIC_API_KEY` actually came from —
 * '.env' or the shell — folded into `reason` exactly like a connector's own `env NAME present (source)`
 * line (doctor.ts). Every OTHER credential `levare doctor` reports on already names its source
 * (dotenv.ts#applyStudioEnv's provenance map, NOTES C11 part 4); this was the one doctor reports on
 * that didn't — a shell-exported key silently outranking a freshly-edited `.env` looked identical to a
 * correct load. Omitted by every board render call site (they have no provenance map handy and don't
 * need one — this is a `levare doctor`-only enhancement, threaded in by cli.ts alone), so the shared
 * `reason` text everywhere else is unchanged. */
export function resolveOrchestratorStatus(
  env: Record<string, string | undefined> = process.env,
  opts: SdkPreconditionOptions = {},
  envSource?: EnvProvenance,
): OrchestratorStatus {
  const check = checkSdkPreconditionsCached(env, opts);
  return {
    available: check.viable,
    // NOTES DOCS-WALKTHROUGH-2: this used to read "The Orchestrator is live." — a claim doctor cannot
    // back up. `checkSdkPreconditions` only proves the key is SET and the native binary resolves; it
    // never makes a request, so an expired or revoked key reports this identically to a good one, and
    // only fails later at real dispatch (an operator hit exactly this live: a green doctor, then a 401
    // on the first real message). Say only what's actually known — presence, not validity — rather than
    // implying a check that never ran. See docs/current-gaps.md for why a real round-trip check was
    // rejected rather than added.
    reason: check.viable
      ? `${ORCHESTRATOR_ENV_VAR} is present${envSource ? ` (${envSource})` : ""} — its validity isn't checked until the Orchestrator makes a real request.`
      : (check.reason ?? `${ORCHESTRATOR_ENV_VAR} is not set`),
    envVar: ORCHESTRATOR_ENV_VAR,
  };
}

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
  /** A supported env-var override for authentication (Finding 149: no longer the only way to
   * authenticate, or something `available` depends on — see `resolveOrchestratorStatus`). */
  envVar: string;
}

export const ORCHESTRATOR_ENV_VAR = "ANTHROPIC_API_KEY";

// NOTES DIST5: a compiled `dist/levare` no longer needs special-casing here. DIST4 forced "off"
// under `--compile` because `sdk-transport.ts`'s worker spawn (`Bun.spawn([process.execPath,
// SDK_WORKER_PATH])`) only worked when `process.execPath` was a real `bun` interpreter, not the
// compiled binary itself. `workerSpawnArgv` (sdk-transport.ts) now self-invokes this same process in
// worker mode instead of spawning a script path, which works identically whether this process is
// compiled or source — so the native-binary precondition below is the ONLY thing that determines
// availability, compiled or not (Finding 149: credential presence no longer gates this at all).

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
  // Finding 149: `check.viable` no longer depends on `ANTHROPIC_API_KEY` at all (sdk-transport.ts —
  // a subscription session authenticates identically but leaves no env var to detect). `env` is still
  // read HERE, independently of `check`, purely to report the (still-true, still-useful) fact that the
  // key is set when it is — never to gate on it. NOTES DOCS-WALKTHROUGH-2's "presence, not validity"
  // discipline still applies: this only ever says the key is present, never that it works.
  const keyPresent = typeof env[ORCHESTRATOR_ENV_VAR] === "string" && env[ORCHESTRATOR_ENV_VAR].length > 0;
  const keyNote = keyPresent ? `${ORCHESTRATOR_ENV_VAR} is present${envSource ? ` (${envSource})` : ""}; ` : "";
  return {
    available: check.viable,
    reason: check.viable
      ? `${keyNote}the Claude Agent SDK's native binary resolved — authentication (an API key or a subscription session) isn't checked until the Orchestrator makes a real request.`
      : (check.reason ?? `${ORCHESTRATOR_ENV_VAR} is not set`),
    envVar: ORCHESTRATOR_ENV_VAR,
  };
}

// NOTES C11: a single, honest description of whether the Orchestrator is reachable — "on" or "off",
// never a third "offline mode" state. Used by three surfaces that must never drift from each other:
// the board's rendered header/rail indicator (render.ts), `levare doctor` (doctor.ts via cli.ts), and
// (indirectly, via the same `checkSdkPreconditionsCached` cache) `orchestrator-boundary.ts#selectOrchestratorBoundary`
// — so "the badge says on" and "the route actually answers" can never disagree.

import { checkSdkPreconditionsCached, type SdkPreconditionOptions } from "./sdk-transport.ts";
import { isCompiledBuild } from "./version.ts";

export interface OrchestratorStatus {
  available: boolean;
  /** A short, human sentence explaining the state — the same text a doctor line and the panel's
   * disabled note draw from, so the reason is never re-worded per surface. */
  reason: string;
  /** The env var an operator would set to make the Orchestrator available. */
  envVar: string;
}

export const ORCHESTRATOR_ENV_VAR = "ANTHROPIC_API_KEY";

// NOTES DIST4: a compiled `dist/levare` can never actually run the Orchestrator, no matter what the
// LOCAL preconditions below say — confirmed live (not assumed). `sdk-transport.ts`'s
// `createAsyncSdkTransport` spawns the SDK worker as `Bun.spawn([process.execPath, SDK_WORKER_PATH])`,
// which only works when `process.execPath` is a real `bun` interpreter (true for a source/`./levare`
// run). Under `--compile`, `process.execPath` IS the compiled `dist/levare` binary itself — spawning
// it with a script-path argument does not run that script, it re-enters levare's own CLI parser,
// which rejects the path as `unknown command: ...` (confirmed by running the compiled binary this
// way directly). This is a different, deeper failure than the `import.meta.url`→`$bunfs` path-
// resolution bug DIST1/DIST4 fixed elsewhere: even a perfectly-resolved worker script path can't
// help, because there is no generic script interpreter left to hand it to. Reported here, not just
// left to fail per-request, because this module's whole job is "the badge says on" and "the route
// actually answers" must never disagree — silently leaving `available` to the credential/binary check
// alone would let a compiled binary claim "on" for a call that WILL fail on the very next message.
function compiledBinaryUnavailableReason(): string {
  return "The Orchestrator does not run from a compiled binary yet — its SDK worker is spawned via the running executable's own path, which only works for a real `bun` interpreter (a source run), not a compiled `dist/levare` (NOTES DIST4). Run from source (`./levare`) to use the Orchestrator.";
}

/** Resolve the Orchestrator's current boundary status — cached (30s TTL, see sdk-transport.ts) so a
 * page render or a doctor run never re-walks node_modules resolution on every call. `compiled`
 * defaults to the real `isCompiledBuild()` check; overridable only for tests. */
export function resolveOrchestratorStatus(
  env: Record<string, string | undefined> = process.env,
  opts: SdkPreconditionOptions = {},
  compiled: boolean = isCompiledBuild(),
): OrchestratorStatus {
  if (compiled) {
    return { available: false, reason: compiledBinaryUnavailableReason(), envVar: ORCHESTRATOR_ENV_VAR };
  }
  const check = checkSdkPreconditionsCached(env, opts);
  return {
    available: check.viable,
    reason: check.viable ? "The Orchestrator is live." : (check.reason ?? `${ORCHESTRATOR_ENV_VAR} is not set`),
    envVar: ORCHESTRATOR_ENV_VAR,
  };
}

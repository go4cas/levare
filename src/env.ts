// levare env scoping (§6 guardrails, invariant 11). A member's spawned process sees ONLY the env
// vars its granted connectors name, plus a minimal PATH/HOME baseline — an allowlist, never a
// denylist over process.env. A secret for a connector a member wasn't granted can never leak into
// its environment, because nothing is copied through unless a grant (or the baseline) names it.
//
// Grants are the union of the member's agent-level `connectors:` and its team's `connectors:` (§5).

import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
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

/**
 * NOTES CAP-B (v1.1 capability layer, part B, item 4): the outcome of `scopeHome` below — `env` is
 * `buildMemberEnv`'s own record, with `HOME` overridden to a scratch directory when scoping applied
 * (unchanged otherwise, same object reference when there was nothing to scope). `cleanup()` removes the
 * scratch directory (a no-op when none was created) — the caller MUST call it after the spawn this env
 * was built for completes, success or failure, so a scratch `HOME` never outlives the one run it was
 * made for.
 */
export interface ScopedHome {
  env: Record<string, string>;
  cleanup(): void;
}

export interface ScopeHomeOptions {
  /** Test-only override for the scratch-dir parent (default `os.tmpdir()`). */
  tmpRoot?: string;
}

/**
 * NOTES CAP-B: when `member` is granted a `auth: subscription` connector that declares `home:`, give
 * it a PER-RUN scratch `HOME` containing SYMLINKS to only the declared dotpaths from the real `HOME` —
 * never a copy (the vendor's on-disk login is a LIVE credential; revoking the real login must still
 * revoke it here, which only a symlink guarantees). Every other member, and a subscription connector
 * declaring no `home:` (the pre-CAP-B default — see the `SUBSCRIPTION_NO_HOME` validate/doctor
 * warning), gets back `env` completely unchanged — real, unscoped `HOME`, exactly as before this item.
 *
 * `env` must already be `buildMemberEnv`'s own output (its `HOME`, when present, is the real one this
 * function symlinks FROM) — this function only ever narrows an already-allowlisted env, never widens
 * one, and reads no connector env vars of its own (a write-gated connector's vars stay withheld exactly
 * as `buildMemberEnv` already decided; `home:` scoping and env-var withholding are orthogonal).
 *
 * Scratch dirs are created fresh on every call (never cached/shared across spawns) and MUST be removed
 * by the caller via the returned `cleanup()` once the spawn this env was built for is done.
 */
export function scopeHome(repo: Repo, member: string, env: Record<string, string>, opts: ScopeHomeOptions = {}): ScopedHome {
  const sub = subscriptionConnector(repo, member);
  const dotpaths = sub?.home;
  const realHome = env.HOME;
  if (!dotpaths || dotpaths.length === 0 || !realHome) return { env, cleanup() {} };

  const scratch = mkdtempSync(join(opts.tmpRoot ?? tmpdir(), "levare-home-"));
  for (const dotpath of dotpaths) {
    const target = join(realHome, dotpath);
    const link = join(scratch, dotpath);
    mkdirSync(dirname(link), { recursive: true });
    try {
      // No `type` argument: POSIX symlinks don't need one, and this codebase runs on Linux/macOS
      // (every other spawn helper in this repo — sdk-transport.ts, adapters.ts — is POSIX-only too).
      // A dangling target (the vendor CLI's config doesn't exist yet, e.g. before first login) is not
      // an error — the symlink is created regardless, exactly like a real `ln -s` would.
      symlinkSync(target, link);
    } catch {
      /* best-effort — a single unresolvable dotpath must not abort the whole spawn */
    }
  }
  return {
    env: { ...env, HOME: scratch },
    cleanup() {
      try {
        // `recursive: true` unlinks symlink ENTRIES inside `scratch`, never follows them into the
        // real target directories (standard rm -rf semantics) — the live credential this scopes is
        // never touched by cleanup, only the scratch dir's own symlinks are.
        rmSync(scratch, { recursive: true, force: true });
      } catch {
        /* best-effort — a scratch dir surviving a failed rm is not worth failing the run over */
      }
    },
  };
}

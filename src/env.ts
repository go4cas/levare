// levare env scoping (§6 guardrails, invariant 11). A member's spawned process sees ONLY the env
// vars its granted connectors name, plus a minimal PATH/HOME baseline — an allowlist, never a
// denylist over process.env. A secret for a connector a member wasn't granted can never leak into
// its environment, because nothing is copied through unless a grant (or the baseline) names it.
//
// Grants are the union of the member's agent-level `connectors:` and its team's `connectors:` (§5).

import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { join, dirname, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import type { Agent, Connector, Team } from "./types.ts";
import type { Repo } from "./repo.ts";
import { isSafeHomeDotpath } from "./validate.ts";

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

/**
 * NOTES R4-SANDBOX (v2, Ruling 2): whether a `kind: cli` member's sandboxed spawn is allowed network
 * reach — best-effort, per the goal's own ruling. Every connector this codebase has IS levare's own
 * declared way of naming an external reach (an mcp server's `server:`, a wrapped tool's remote backend,
 * a subscription model's own API) — there is no connector shape that names a purely-local capability —
 * so "holds at least one granted connector" is exactly "holds a connector declaring a remote endpoint"
 * (the goal's own phrasing) without inventing a second, parallel field for the same fact. A member
 * granted nothing has nothing to reach for; network is denied by default in that case.
 */
export function memberNetworkAllowed(repo: Repo, member: string): boolean {
  return grantedConnectors(repo, member).length > 0;
}

/**
 * NOTES MCP-1B (PRD Amendment 3, rulings R1/R5): whether a `kind: remote` agent's declared `server:`
 * names a connector this agent can actually dispatch through today — a real, GRANTED, `kind: mcp`
 * connector that declares a non-empty stdio `argv:`. `false` for a missing/wrong-kind/ungranted
 * connector, and for a `kind: mcp` connector with no `argv:` (ruling R1's still-deferred HTTP/SSE
 * transport, which spawns no local process and so never declares one). This is the single line
 * validate.ts, doctor.ts, and board/render/registry.ts each narrow their REV1 honesty warning around,
 * now that the stdio case is a real, working dispatch path (adapters.ts#createAsyncStdioRemoteBoundary)
 * rather than a blanket mock.
 */
export function remoteAgentImplemented(repo: Repo, agent: Agent): boolean {
  if (agent.kind !== "remote" || !agent.server) return false;
  const connector = repo.connectors.get(agent.server);
  if (!connector || connector.kind !== "mcp" || !connector.argv || connector.argv.length === 0) return false;
  return grantedConnectors(repo, agent.name).some((c) => c.name === connector.name);
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
  /** NOTES SEC-V11 F1: dotpaths this call refused to symlink because the resolved link or target path
   * escaped its own confinement (scratch dir / real HOME) — never populated by a validated studio
   * (validate.ts's own UNSAFE_HOME_PATH already rejects these at the schema boundary), but this function
   * fails closed independently of that check ever having run. Empty in the overwhelming common case. */
  skipped: string[];
}

// NOTES SEC-V11 F1 (defense in depth): the SAME confinement `scopeHome` must hold, checked again here
// with no dependency on validate.ts having run first — `child` must resolve to a path strictly BENEATH
// `parent`, never equal to it and never escaping via `..`. Pure string/path math: `join()` above already
// normalizes `..` segments out of `target`/`link` before this ever runs, so a traversal dotpath produces
// a path this check can catch without touching the filesystem (the target need not exist — a dangling
// vendor-config path is legal, per this function's own doc below).
function isStrictlyUnder(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && rel !== "." && !rel.startsWith("..") && !isAbsolute(rel);
}

export interface ScopeHomeOptions {
  /** Test-only override for the scratch-dir parent (default `os.tmpdir()`). */
  tmpRoot?: string;
}

/**
 * NOTES CAP-B / NOTES MCP-1C (PRD Amendment 3, ruling R3 — the Conductor's own confinement-fork ruling:
 * an MCP server gets the connector's `home:` mechanism "exactly as home: already scopes a subscription
 * cli connector"): give a member a PER-RUN scratch `HOME` containing SYMLINKS to only `connector`'s own
 * declared `home:` dotpaths from the real `HOME` — never a copy (a vendor's on-disk login, or whatever
 * a granted server's own declared reach names, is a LIVE resource; revoking it in the real HOME must
 * still revoke it here, which only a symlink guarantees). `connector` absent, or present but declaring
 * no `home:` (the pre-CAP-B default for a subscription connector — see the `SUBSCRIPTION_NO_HOME`
 * validate/doctor warning), returns `env` completely unchanged — real, unscoped `HOME`.
 *
 * `env` must already be the caller's own allowlisted output (its `HOME`, when present, is the real one
 * this function symlinks FROM) — this function only ever narrows an already-allowlisted env, never
 * widens one, and reads no connector env vars of its own (env-var withholding is orthogonal to `home:`
 * scoping and stays whatever the caller already decided).
 *
 * Scratch dirs are created fresh on every call (never cached/shared across spawns) and MUST be removed
 * by the caller via the returned `cleanup()` once the spawn this env was built for is done.
 *
 * NOTES SEC-V11 F1: a traversal `home:` entry (e.g. `"../../.ssh"`) is rejected independently of
 * validate.ts ever having run against the studio that declared it — this function fails CLOSED, never
 * trusting that a caller validated first. Such an entry is skipped (never symlinked, no exception
 * thrown) and named in the returned `skipped` list; every other declared dotpath still scopes normally.
 */
export function scopeHomeForConnector(connector: Connector | undefined, env: Record<string, string>, opts: ScopeHomeOptions = {}): ScopedHome {
  const dotpaths = connector?.home;
  const realHome = env.HOME;
  if (!dotpaths || dotpaths.length === 0 || !realHome) return { env, cleanup() {}, skipped: [] };

  const scratch = mkdtempSync(join(opts.tmpRoot ?? tmpdir(), "levare-home-"));
  const skipped: string[] = [];
  for (const dotpath of dotpaths) {
    // NOTES SEC-V11 F1: fails CLOSED regardless of whether validate.ts's own UNSAFE_HOME_PATH check
    // ever ran against this studio — a traversal dotpath (e.g. "../../.ssh") must never resolve its
    // symlink TARGET above `realHome`, and the LINK itself must never land outside `scratch` (both
    // `join()` calls below already fold ".." into the resulting string, so a traversal entry is only
    // detectable AFTER joining, not before — checking the joined result is the actual guarantee, not
    // `isSafeHomeDotpath`'s own lexical check, which is kept too as the cheap, obviously-correct first
    // gate). An entry failing either check is skipped — never symlinked, recorded in `skipped` — the
    // rest of the declared dotpaths still scope normally.
    if (!isSafeHomeDotpath(dotpath)) {
      skipped.push(dotpath);
      continue;
    }
    const target = join(realHome, dotpath);
    const link = join(scratch, dotpath);
    if (!isStrictlyUnder(link, scratch) || !isStrictlyUnder(target, realHome)) {
      skipped.push(dotpath);
      continue;
    }
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
    skipped,
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

/** The `cli`/`native` member-scoped counterpart to `scopeHomeForConnector` — resolves `member`'s own
 * granted `auth: subscription` connector (the only connector kind this call site has ever scoped
 * against) and delegates. Unchanged behaviour from before NOTES MCP-1C; the remote/MCP dispatch path
 * (adapters.ts#createAsyncStdioRemoteBoundary) calls `scopeHomeForConnector` directly with its own
 * resolved `kind: mcp` connector instead, since a remote member's `home:`-declaring connector need not
 * be `auth: subscription` at all (ruling R3: "the connector's existing home: mechanism", generalized). */
export function scopeHome(repo: Repo, member: string, env: Record<string, string>, opts: ScopeHomeOptions = {}): ScopedHome {
  return scopeHomeForConnector(subscriptionConnector(repo, member), env, opts);
}

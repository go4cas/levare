// levare member adapters (§6). Behind the Runner's MemberRunner boundary sit three adapter kinds,
// dispatched by an agent's `kind`:
//
//   native → a Claude Agent SDK invocation with the assembled context, tool allowlist, and
//            granted-connector env. The adapter talks to a `NativeBoundary`/`AsyncNativeBoundary`
//            interface — tests mock it; production (replay.ts#productionAdapterRunner, NOTES F8)
//            backs it with the real SDK via `createSdkNativeBoundary`/`createAsyncSdkNativeBoundary`.
//   cli    → Bun.spawn of the agent's command template in `cwd`, with the allowlisted env only and
//            the timeout enforced; the raw stdout is the member's content.
//   remote → an MCP call over stdio (PRD Amendment 3, ruling R5, NOTES MCP-1B). `produce()` (the
//            phase-2 batch `Runner`/replay's own synchronous path) still drives the mocked, sync
//            `RemoteBoundary`; `produceAsync()` (the live `levare serve` path) drives the real,
//            Promise-returning `AsyncRemoteBoundary` when one is supplied — mirroring native's own
//            sync-mock/async-real split (NOTES F8). The real implementation
//            (`createAsyncStdioRemoteBoundary`) spawns the member's granted `kind: mcp` connector's
//            declared stdio server (mcp-client.ts, Phase 1a), invokes exactly the one tool the agent
//            declares, and turns the response into the artifact doc — UNSANDBOXED (Phase 1c is the
//            sandbox wrap, ruling R3, not yet built).
//
// Ruling C12: the member authors CONTENT, levare authors the ARTIFACT. Whatever a boundary returns —
// plain prose, or prose wrapped in a frontmatter fence the member had no business emitting — is never
// trusted as the document. `AdapterRunner#author` strips any fence the raw text carries, keeps only
// the body, and wraps it in frontmatter built entirely from facts levare itself already knows: kind
// (the flow step's resolved kind), id (unit-scoped, `<kind>-<unit>-vN`), unit, project, status
// (`in-review`), produced_by (the team/member that actually ran), consumes (the artifacts levare
// handed it — the same set assembleContext put in the member's own context), supersedes (null; a
// caller versions/supersedes afterward), approved_by (null), created, files ([]), and usage — the
// SDK's own reported receipt when the boundary supplied one, `unreported` otherwise. A member's own
// token count, id, or any other self-reported metadata is discarded unread: a member reporting its
// own usage is a member guessing, and asking a model to restate facts the runner can already assert
// is asking it to fabricate them. Empty/unusable content after stripping is a hard error — the same
// "blocked artifact" surfacing every existing caller (dagwalk.ts, board/gateops.ts) already gives an
// AdapterError.

import { existsSync, statSync, accessSync, mkdirSync, mkdtempSync, rmSync, constants as fsConstants } from "node:fs";
import { isAbsolute, dirname, join as pathJoin } from "node:path";
import { tmpdir } from "node:os";
import { normalizeReceipt } from "./receipts.ts";
import { buildMemberEnv, teamOf, subscriptionConnector, scopeHome, memberNetworkAllowed, grantedConnectors } from "./env.ts";
import { connectStdioMcpServer, type McpToolCallResult } from "./mcp-client.ts";
import { allowedTools } from "./guardrails.ts";
import { assembleContext, unitArtifactPaths } from "./context.ts";
import { asyncSdkTransport, bunSdkTransport, resolveNativeBinary, type AsyncSdkTransport, type SdkTransport } from "./sdk-transport.ts";
import { repoCapabilities } from "./repo.ts";
import { resolveProjectRepoPath, workBranchName, branchExists, createDispatchWorktree } from "./merge.ts";
import { isSafeHomeDotpath } from "./validate.ts";
import { detectSandbox, wrapForSandbox, resolveDarwinUserTempDir, type SandboxDetection, type SandboxLevel, type SandboxPolicy, type WrappedSpawn } from "./sandbox.ts";
import type { Pricing } from "./pricing.ts";
import type { Repo } from "./repo.ts";
import type { MemberRunner } from "./runner.ts";
import type { Agent, Receipt } from "./types.ts";

export class AdapterError extends Error {}

// What every adapter is handed to do its job. `context` is the §6-assembled prompt; `env` is the
// allowlisted environment; `tools` is the native tool allowlist. Adapters that don't need a field
// (a CLI ignores `tools`) simply don't read it.
export interface InvokeRequest {
  agent: Agent;
  member: string;
  kind: string;
  unit: string;
  project: string;
  context: string;
  env: Record<string, string>;
  tools: string[];
  /** NOTES MERGE-1 (goal item 1) / NOTES R4-SANDBOX (Ruling 1): the unit's project repo checkout this
   * dispatch actually runs against — only set when `resolveProjectRepoPath` finds a real local checkout
   * (a project with no `repo:`, or one that doesn't resolve locally, or the studio's own root, leaves
   * this undefined; see that function's own doc). Once the unit's work branch exists, this is a
   * PER-DISPATCH scratch worktree of that branch (`merge.ts#createDispatchWorktree`), never the
   * project's own shared working tree — each dispatch gets its own isolated checkout, created before
   * the invoke call and removed after (`AdapterRunner#withDispatchWorktree`). This is what
   * `{feature_repo}` substitutes to (adapters.ts#defaultCliCommand) — undefined leaves the placeholder
   * unresolved, exactly the pre-existing (inert) behaviour for every project that isn't a real local
   * checkout, e.g. the golden fixture's own `storefront`. */
  projectRepoPath?: string;
  /**
   * NOTES R4-SANDBOX-FIX-7/FIX-8 (live macOS gate: a member's own commit inside its dispatch worktree,
   * denied by a working sandbox — then narrowed for security once shipped) / FIX-12 (root threaded
   * explicitly, for the deny-then-reallow reseal `sandboxWrap` now applies). Set alongside
   * `projectRepoPath` ONLY when a real per-dispatch worktree was created
   * (`withDispatchWorktree`/`withDispatchWorktreeAsync`). `root` is the ORIGINAL project repo's own
   * `.git` directory; `subpaths` are the EXACT paths under it a worktree commit actually reads/writes,
   * confirmed by direct reproduction (not assumed): `.git/objects` (new blobs/trees/commits), `.git/refs`
   * (the branch ref's own content update), `.git/logs` (the branch ref's reflog append), and this
   * dispatch's OWN `.git/worktrees/<name>` admin directory (`HEAD`, `index`, `COMMIT_EDITMSG`, its own
   * `logs/HEAD`) — never any sibling worktree's own admin directory, and never `root` itself,
   * `.git/hooks`, or `.git/config`. FIX-7 originally granted the whole `.git` directory as a flat
   * writable list; FIX-8 narrowed the SET of paths after a security review named `.git/hooks/*` and
   * `.git/config` (`core.hooksPath`/`core.fsmonitor`) as code-execution vectors that would otherwise run
   * UNCONFINED the next time any git operation touches this repo outside the sandbox (the Conductor's
   * own shell, levare's own gate-resolution commits, the daemon); FIX-12 discovered that a flat list
   * cannot express the reseal a BROADER, unrelated grant might later need carved back out of (FIX-11's
   * own darwin temp-dir grant swallowed FIX-8's seal on its first live execution) and moved this to
   * `sandboxWrap`'s dedicated `SandboxPolicy.gitWriteGrant` field, whose OWN deny-root-then-reallow-
   * subpaths ordering is what actually restores the seal regardless of what else the profile grants.
   * Undefined for every dispatch without a worktree (self-referential/unresolvable `repo:`, or no work
   * branch yet) — exactly `projectRepoPath`'s own no-worktree case.
   */
  dispatchGitWriteGrant?: { root: string; subpaths: string[] };
  /**
   * NOTES R4-VENDOR-CLI (live macOS gate: real `gh`, not the member stub): a fresh, per-dispatch scratch
   * directory a wrapped vendor CLI's own config/state/data/cache directories get redirected into under a
   * `"full"`-tier sandbox — set immediately before the real spawn (`runCli`/`runCliAsync`), cleaned up
   * immediately after, mirroring `withHomeScope`'s own create-immediately-before/clean-up-immediately-
   * after discipline. Distinct from `dispatchGitWriteGrant`: this is never git-specific — see
   * `cliVendorScratchEnv`'s own doc for why a vendor CLI's OWN directories (never the operator's real
   * ones) are what get created here. Undefined for a non-real spawn boundary (a test-injected `CliSpawn`
   * double), exactly `dispatchGitWriteGrant`'s own no-worktree case.
   */
  cliVendorScratchDir?: string;
}

/** The native SDK boundary — synchronous, used by the phase-2 batch `Runner` (`levare replay`) and by
 * `stubAdapterRunner`. `receipt`, when present, is the SDK's OWN reported usage (§10, NOTES F8) — a
 * model cannot know its real token counts/cost, so this must never be re-derived by parsing the
 * returned doc's frontmatter; see `AdapterRunner#finalize`. */
export interface NativeBoundary {
  invoke(req: InvokeRequest): { doc: string; receipt?: Receipt };
}

/** The non-blocking counterpart to `NativeBoundary` (NOTES F8) — same shape, Promise-returning,
 * mirroring `CliSpawn`/`AsyncCliSpawn`'s split. What `productionAdapterRunner`'s live `produceAsync`
 * path actually drives, so a real native SDK call never blocks `levare serve`'s event loop. */
export interface AsyncNativeBoundary {
  invoke(req: InvokeRequest): Promise<{ doc: string; receipt?: Receipt }>;
}

/** The remote MCP boundary — synchronous, used only by the phase-2 batch `Runner` (`levare replay`),
 * which drives a scripted decision walk synchronously and never reaches a live `levare serve` request
 * path. Stays mocked forever for that path (mirrors `NativeBoundary`'s own sync/replay-only role) —
 * the real implementation is `AsyncRemoteBoundary`/`createAsyncStdioRemoteBoundary` below. */
export interface RemoteBoundary {
  call(req: InvokeRequest): { doc: string };
}

/** NOTES MCP-1B — the non-blocking counterpart to `RemoteBoundary` (mirrors `AsyncNativeBoundary`'s
 * own split, NOTES F8): what `produceAsync`'s live `remote` case actually drives when supplied,
 * so a real stdio MCP session (an inherently async, multi-turn exchange over a long-lived child
 * process) never forces a fake synchronous facade over it. */
export interface AsyncRemoteBoundary {
  call(req: InvokeRequest): Promise<{ doc: string }>;
}

export interface SdkNativeBoundaryOptions {
  transport?: SdkTransport;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  /** Test-only override for the resolved native-binary path — see `resolveNativeBinary` default below. */
  pathToClaudeCodeExecutable?: string;
}

export interface AsyncSdkNativeBoundaryOptions {
  transport?: AsyncSdkTransport;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  /** Test-only override for the resolved native-binary path — see `resolveNativeBinary` default below. */
  pathToClaudeCodeExecutable?: string;
}

// Shared by both the sync and async native boundary constructors: the worker request built from an
// InvokeRequest, and the spawn env — exactly `req.env` (the member's allowlisted grants, already
// scoped by `buildMemberEnv` at `AdapterRunner#prepare`) plus `ANTHROPIC_API_KEY` forwarded from the
// calling process. The platform credential is not a connector grant, but every native call needs it
// to authenticate regardless of what the member was granted (invariant 11, D5, security-audit Surface
// 3's now-closed K5 pre-arm). The key's value is read only to forward it into the spawn's env; it is
// never logged, written to a file, or included in any commit.
function nativeSpawnEnv(req: InvokeRequest, baseEnv: Record<string, string | undefined>): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...req.env };
  if (typeof baseEnv.ANTHROPIC_API_KEY === "string") env.ANTHROPIC_API_KEY = baseEnv.ANTHROPIC_API_KEY;
  return env;
}

// NOTES MERGE-1: `{feature_repo}` (declared for `command`/`cwd` templates since before this goal) has
// exactly one resolution — the unit's project repo, when it resolves to a real local checkout
// (`req.projectRepoPath`). Undefined leaves the placeholder verbatim in the returned string, the same
// no-op every project without a real local checkout already got (a self-reference: `agent.cwd` for a
// fixture agent literally holding the string `"{feature_repo}"` substitutes to itself unchanged).
function resolveFeatureRepo(template: string | undefined, projectRepoPath: string | undefined): string | undefined {
  if (template === undefined) return undefined;
  return projectRepoPath ? template.replace(/\{feature_repo\}/g, projectRepoPath) : template;
}

// NOTES R4-SANDBOX-FIX-8 (security narrowing of FIX-7's own write grant): the EXACT subpaths a worktree
// commit reads/writes — `.git/objects` (new objects), `.git/refs` (the branch ref's own content update),
// `.git/logs` (the branch ref's reflog append), and this dispatch's OWN `.git/worktrees/<name>` admin
// directory (`merge.ts#DispatchWorktree.gitDir`, read back from the worktree's own `.git` pointer file,
// never guessed from a naming scheme) — confirmed by direct reproduction (chmod-deny each candidate path
// on a plain, non-sandboxed repo and observe which one a commit actually needs). Deliberately NEVER the
// `.git` directory itself, `.git/hooks`, or `.git/config`: both are code-execution vectors (a member
// writing `.git/hooks/post-commit`, or setting `core.hooksPath`/`core.fsmonitor` in `config`) that would
// run UNCONFINED the next time ANY git operation touches this repo outside the sandbox — the Conductor's
// own shell, levare's own gate-resolution commits, the daemon — and no deterministic guardrail catches
// either, since neither is part of any diff a merge gate inspects.
//
// `logs/` specifically is created here if missing (documented choice: create, never skip) — a repo whose
// only commits predate any reflog, or one with `core.logAllRefUpdates=false`, may not have it yet, and a
// bind-mount source that doesn't exist can't simply be granted; creating an empty directory costs
// nothing and lets an otherwise-ordinary commit's own reflog write land somewhere, rather than silently
// denying a legitimate write a test never had the chance to surface.
//
// NOTES R4-SANDBOX-FIX-9 (canonicalization consistency, found while fixing a live-gate test failure):
// `gitCommonDir` is derived from `worktreeGitDir` itself (`dirname(dirname(...))`, undoing exactly the
// `/worktrees/<name>` suffix `merge.ts#createDispatchWorktree` appended), NEVER re-joined from the
// caller's own `repoPath`. Confirmed directly: `git worktree add` canonicalizes the gitdir path it
// records in the new worktree's own `.git` pointer file, even when every git command that created the
// repo and the worktree ran entirely through a SYMLINKED path — so `worktreeGitDir` is ALWAYS the
// canonical form, regardless of what `repoPath` originally was. Rejoining `.git` onto the caller's own,
// possibly-still-symlinked `repoPath` would produce objects/refs/logs paths on a DIFFERENT literal
// spelling than the worktree admin dir — harmless for `buildSandboxExecProfile` (which canonicalizes
// every `writablePaths` entry itself), but a real gap for bubblewrap, which deliberately never
// canonicalizes anything (see `bubblewrapArgv`'s own header): git's own internal `commondir` resolution
// (a relative path from the worktree's own admin dir back to the shared `.git`) always resolves relative
// to whichever canonical path git itself recorded, never the caller's original spelling, so a `--bind`
// grant for objects/refs/logs at the WRONG (non-canonical) spelling would bind a path git's own commit
// never actually tries to reach.
// NOTES R4-SANDBOX-FIX-9 (live macOS gate): a "full"-tier sandbox denies the operator's own real HOME —
// an empty root on Linux (bubblewrap), an explicit deny-list entry on macOS (sandbox-exec) — which turns
// a read of `$HOME/.gitconfig` into EPERM rather than ENOENT. Git treats the two completely differently:
// ENOENT ("no global config file") is tolerated, silently; EPERM is FATAL (`fatal: unable to access
// '$HOME/.gitconfig': Operation not permitted`), because a permission denial reads as "this config is
// broken", not "there is no config". Fixed environmentally, never by widening the sandbox to make
// `.gitconfig` readable (that would defeat the whole point of denying the operator's real home): a
// dispatch running under a "full" sandbox gets `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` redirected to
// `/dev/null`, so git degrades cleanly to "no global/system config" instead of hitting the denial at all.
// Neither env var touches per-repo config (`.git/config`, read regardless) or `-c` flags a member's own
// command template already passes — a member needing git identity keeps working exactly as before.
function gitConfigRedirectEnv(env: Record<string, string>): Record<string, string> {
  return { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
}

// NOTES R4-VENDOR-CLI (live macOS gate: the first validation against a REAL vendor CLI, `gh`, never the
// member stub): the SAME EPERM-vs-ENOENT class FIX-9 named above, recurring for a different tool with a
// different failure shape. Kernel evidence from the live run: every `gh` invocation died identically at
// `~/.config/gh/config.yml`, `deny(1) file-read-data` — `gh` treats a DENIED (present-but-forbidden)
// config read as FATAL, before ever reaching the network, exactly like git's own `.gitconfig`. Unlike
// git's global config (a single FILE `/dev/null` can stand in for), `gh`'s own resolution — read directly
// from the library it vendors for this, `cli/go-gh`'s `pkg/config/config.go`, never guessed — is FOUR
// DIRECTORIES, each gh itself may create/write into on first use (`os.MkdirAll`), so `/dev/null` cannot
// stand in for any of them:
//   - `GH_CONFIG_DIR` (`config.yml`, `hosts.yml` — the operator's own real GitHub auth tokens live in
//     `hosts.yml` specifically, which is exactly why this must be a FRESH, EMPTY scratch directory, never
//     a read grant on the operator's real one: granting real reads would pipe the operator's own
//     credentials straight into the sandbox, the precise leak NOTES R4-SANDBOX-FIX-3/FIX-4's deny-user-
//     data ruling exists to prevent. Auth for a sandboxed `gh` member comes through its connector's own
//     `GITHUB_TOKEN` env var — `gh` itself documents `GH_TOKEN`/`GITHUB_TOKEN` as taking precedence over
//     a stored login session, so this is the vendor-intended way to run `gh` without a local session, not
//     a workaround.)
//   - `XDG_STATE_HOME` (a `gh` subdir under it — `state.yml`, e.g. update-check bookkeeping)
//   - `XDG_DATA_HOME` (a `gh` subdir)
//   - `XDG_CACHE_HOME` (a `gh` subdir — its own FALLBACK, absent this redirect, resolves to
//     `$TMPDIR/gh-cli-cache`, itself denied under this sandbox's own narrow xcrun-only temp-dir grant
//     (FIX-11/FIX-12) — closed here PROACTIVELY: the live run's own kernel evidence confirmed
//     `config.yml`/`hosts.yml`/a state file specifically, never independently confirmed the cache path,
//     named honestly as such in NOTES rather than claimed as live-verified).
// Applied generically to EVERY `"full"`-tier `kind: cli` dispatch, never gated on `argv[0] === "gh"`
// specifically — mirroring `gitConfigRedirectEnv`'s own precedent (that redirect isn't gated on "is this
// member git" either) and, per the XDG Base Directory spec being a general Unix convention many modern
// CLIs honor (not only `gh` — FIX-5's own named residual, Codex/Gemini, may benefit too), though this is
// NOT independently live-confirmed for any CLI other than `gh` and is named as such, not claimed proven.
function cliVendorScratchEnv(scratchDir: string): Record<string, string> {
  return {
    GH_CONFIG_DIR: pathJoin(scratchDir, "gh-config"),
    XDG_STATE_HOME: pathJoin(scratchDir, "xdg-state"),
    XDG_DATA_HOME: pathJoin(scratchDir, "xdg-data"),
    XDG_CACHE_HOME: pathJoin(scratchDir, "xdg-cache"),
  };
}

// Combines the git redirect (FIX-9) and the vendor-CLI scratch redirect (R4-VENDOR-CLI) into the single
// env layering `runCli`/`runCliAsync` apply under a `"full"`-tier sandbox — `vendorScratchDir` is
// undefined only when `createCliVendorScratch` was never called (never for a real spawn boundary that
// reached `"full"`; see both call sites), in which case this degrades to exactly `gitConfigRedirectEnv`'s
// own prior behavior.
function fullSandboxEnvRedirect(env: Record<string, string>, vendorScratchDir: string | undefined): Record<string, string> {
  const withGit = gitConfigRedirectEnv(env);
  return vendorScratchDir ? { ...withGit, ...cliVendorScratchEnv(vendorScratchDir) } : withGit;
}

// Creates the fresh, per-dispatch scratch directory `cliVendorScratchEnv` points a wrapped vendor CLI's
// own config/state/data/cache directories into — mirrors `env.ts#scopeHome`'s own `mkdtempSync(tmpdir())`
// scratch-resource lifecycle (created immediately before the spawn, removed in the caller's own
// `finally`, never shared across dispatches). Only the ROOT directory is created here: each of the four
// leaf subdirectories `cliVendorScratchEnv` names is created by the vendor CLI itself on first write
// (`os.MkdirAll`, confirmed directly from `cli/go-gh`'s own source) — mirroring FIX-8's own
// `dispatchGitWriteGrant`'s "create the root the grant needs, let the real workload populate the rest"
// posture, never pre-guessing a vendor CLI's own internal directory layout beyond what it needs to exist.
function createCliVendorScratch(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(pathJoin(tmpdir(), "levare-cli-vendor-"));
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort — mirrors every other scratch-resource cleanup in this file */
      }
    },
  };
}

// NOTES R4-SANDBOX-FIX-12: returns `root` alongside `subpaths` now (previously a flat array) — `sandboxWrap`
// needs `root` to build the deny-then-reallow reseal (`SandboxPolicy.gitWriteGrant`), which a flat list of
// subpaths alone cannot express.
function dispatchGitWriteGrant(worktreeGitDir: string): { root: string; subpaths: string[] } {
  const gitCommonDir = dirname(dirname(worktreeGitDir));
  const logs = pathJoin(gitCommonDir, "logs");
  if (!existsSync(logs)) mkdirSync(logs, { recursive: true });
  return { root: gitCommonDir, subpaths: [pathJoin(gitCommonDir, "objects"), pathJoin(gitCommonDir, "refs"), logs, worktreeGitDir] };
}

function nativeWorkerRequest(req: InvokeRequest, pathToClaudeCodeExecutable: string | undefined) {
  // Tool allowlist (security-audit Surface 3/8's now-closed K5 pre-arm): `req.tools` is
  // `guardrails.ts#allowedTools(agent)` — exactly the agent's declared `tools:`, `[]` when it
  // declares none. Passed as BOTH `tools` and `allowedTools` so an agent declaring no tools reaches
  // the SDK with an empty allowlist, never an implicit/full one.
  const cwd = resolveFeatureRepo(req.agent.cwd, req.projectRepoPath);
  return { prompt: req.context, model: req.agent.model, tools: req.tools, allowedTools: req.tools, cwd, pathToClaudeCodeExecutable };
}

/**
 * The real Claude Agent SDK backing for `NativeBoundary` (phase 7) — a synchronous call behind the
 * exact same `invoke(req): { doc: string }` shape the mocked boundary already implements, via the
 * shared transport (sdk-transport.ts). The member's own definition (`req.agent.body`) plus the full
 * §6-assembled recipe is already `req.context` (context.ts item 1 is "agent definition body") — no
 * separate system prompt is layered on top; the model's only instruction is the assembled context
 * itself, and its final turn IS the artifact document (never a side-effected file write — levare's
 * own validator re-checks whatever text comes back, exactly as it already re-checks a CLI/mocked
 * member's output). Used by the phase-2 batch `Runner` (never reachable from a live `levare serve`
 * request path — see `AdapterRunner#produce`'s own doc) and by `AdapterRunnerOptions.native`, which
 * `produceAsync` falls back to only when no `asyncNative` was supplied.
 */
export function createSdkNativeBoundary(opts: SdkNativeBoundaryOptions = {}): NativeBoundary {
  const transport = opts.transport ?? bunSdkTransport;
  const baseEnv = opts.env ?? process.env;
  const timeoutMs = opts.timeoutMs ?? 600_000;
  // Resolved ONCE, explicitly — never left to the SDK's own implicit resolution inside the worker
  // (NOTES phase-7 K14: a live host showed that implicit lookup fail to find a platform binary that
  // genuinely existed as a sibling node_modules package).
  const pathToClaudeCodeExecutable = opts.pathToClaudeCodeExecutable ?? resolveNativeBinary() ?? undefined;
  return {
    invoke(req: InvokeRequest): { doc: string; receipt?: Receipt } {
      const env = nativeSpawnEnv(req, baseEnv);
      const res = transport.run(nativeWorkerRequest(req, pathToClaudeCodeExecutable), { env, timeoutMs });
      if (!res.ok) throw new AdapterError(`native member '${req.member}' sdk call failed: ${res.error}`);
      return { doc: res.result, receipt: res.receipt };
    },
  };
}

/**
 * NOTES F8 — the non-blocking counterpart to `createSdkNativeBoundary`: identical recipe (env scoping,
 * tool allowlist, §6 context, resolved native binary), but the SDK call itself never blocks the
 * caller's event loop (`asyncSdkTransport`, `Bun.spawn` + await, the same non-blocking transport
 * `OrchestratorBoundary` already uses). This is what `productionAdapterRunner` wires as
 * `AdapterRunnerOptions.asyncNative` — the boundary a real, live `levare serve` request actually drives
 * for a `kind: native` member, closing the last of invariant 10's "mocked this phase" deferrals for
 * the member-invocation path (remote/MCP remains mocked, a separate, still-documented deferral).
 */
export function createAsyncSdkNativeBoundary(opts: AsyncSdkNativeBoundaryOptions = {}): AsyncNativeBoundary {
  const transport = opts.transport ?? asyncSdkTransport;
  const baseEnv = opts.env ?? process.env;
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const pathToClaudeCodeExecutable = opts.pathToClaudeCodeExecutable ?? resolveNativeBinary() ?? undefined;
  return {
    async invoke(req: InvokeRequest): Promise<{ doc: string; receipt?: Receipt }> {
      const env = nativeSpawnEnv(req, baseEnv);
      const res = await transport.run(nativeWorkerRequest(req, pathToClaudeCodeExecutable), { env, timeoutMs });
      if (!res.ok) throw new AdapterError(`native member '${req.member}' sdk call failed: ${res.error}`);
      return { doc: res.result, receipt: res.receipt };
    },
  };
}

export interface StdioRemoteBoundaryOptions {
  /** Test-only override for the mcp session constructor — default the real `connectStdioMcpServer`
   * (mcp-client.ts). Lets a test drive this boundary against a deterministic fake stdio server without
   * spawning a real third-party MCP install. */
  connect?: typeof connectStdioMcpServer;
  /** Test-only override for the connect/request timeout ceiling — default derives from the agent's own
   * `timeout:` (falls back to the same 600s default `defaultCliCommand`'s cli timeout uses). */
  timeoutMs?: number;
}

// NOTES MCP-1B: {task} substitution only — mirrors adapters.ts#defaultCliCommand's own {task}
// substitution for a cli member's argv template. A remote member declares no {feature_repo}/{model}
// equivalent: an MCP tools/call has no cwd of its own, and `model:` is native-only.
function buildMcpToolArguments(params: Record<string, string> | undefined, context: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params ?? {})) out[key] = value.replace(/\{task\}/g, context);
  return out;
}

// NOTES MCP-1B: only the text blocks a tools/call result carries — see McpToolCallResult's own doc
// (mcp-client.ts) for why other block types pass through unread rather than being rejected.
function extractMcpText(result: McpToolCallResult): string {
  return result.content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n")
    .trim();
}

/**
 * NOTES MCP-1B (PRD Amendment 3, rulings R2/R4/R5) — the real stdio MCP backing for
 * `AsyncRemoteBoundary`: resolves the member's declared `server:` to a granted `kind: mcp` connector,
 * spawns its declared stdio command (mcp-client.ts's `connectStdioMcpServer`, Phase 1a's own client),
 * invokes exactly the one tool the agent declares (`agent.tool`) with arguments built from
 * `agent.params`'s `{task}`-substituted template (ruling R2: one dispatch, one call, one artifact —
 * never an interactive multi-call session), and turns the tool's own text content into the artifact
 * `doc`. Auth is ruling R4, unchanged: `req.env` is already `buildMemberEnv`'s allowlisted output (the
 * member's granted connectors' env vars, computed at `AdapterRunner#prepare` before this boundary ever
 * runs) — passed straight through as the spawned server's WHOLE environment (mcp-client.ts's own
 * env-replacement comment). UNSANDBOXED (ruling R3 names the sandbox wrap as Phase 1c, not built here):
 * the spawned server process gets no OS-level confinement at all, exactly as honestly as
 * mcp-client.ts's own header states.
 */
export function createAsyncStdioRemoteBoundary(repo: Repo, opts: StdioRemoteBoundaryOptions = {}): AsyncRemoteBoundary {
  const connect = opts.connect ?? connectStdioMcpServer;
  return {
    async call(req: InvokeRequest): Promise<{ doc: string }> {
      const agent = req.agent;
      const serverName = agent.server;
      if (!serverName) throw new AdapterError(`remote member '${req.member}' declares no 'server'`);
      const connector = repo.connectors.get(serverName);
      if (!connector) throw new AdapterError(`remote member '${req.member}' declares server '${serverName}', which is not a known connector`);
      if (connector.kind !== "mcp") {
        throw new AdapterError(`remote member '${req.member}' declares server '${serverName}', which is kind: '${connector.kind}', not kind: mcp`);
      }
      if (!grantedConnectors(repo, req.member).some((c) => c.name === connector.name)) {
        throw new AdapterError(`remote member '${req.member}' is not granted connector '${serverName}' (agent/team 'connectors:')`);
      }
      if (!connector.argv || connector.argv.length === 0) {
        throw new AdapterError(
          `remote member '${req.member}''s connector '${serverName}' declares no stdio 'argv' — only a real, granted, stdio kind: mcp connector is implemented (PRD Amendment 3 ruling R1); HTTP/SSE MCP servers remain deferred`,
        );
      }
      const tool = agent.tool;
      if (!tool) throw new AdapterError(`remote member '${req.member}' declares no 'tool'`);
      const args = buildMcpToolArguments(agent.params, req.context);
      const timeoutMs = opts.timeoutMs ?? (agent.timeout ?? 600) * 1000;

      const session = await connect({ argv: connector.argv, env: req.env }, { timeoutMs });
      try {
        const result = await session.callTool(tool, args);
        if (result.isError) {
          throw new AdapterError(`remote member '${req.member}' tool '${tool}' on connector '${serverName}' reported isError: ${extractMcpText(result) || "(no content)"}`);
        }
        const text = extractMcpText(result);
        if (!text) throw new AdapterError(`remote member '${req.member}' tool '${tool}' on connector '${serverName}' returned no text content`);
        return { doc: text };
      } finally {
        await session.close();
      }
    },
  };
}

export interface SpawnResult {
  stdout: string;
  exitCode: number;
  timedOut: boolean;
  /**
   * The member's captured stderr (NOTES F3: a bare "exited 1" is a symptom, not a diagnosis — the
   * member's own error output is what actually tells a Conductor why). Optional so existing
   * test-double `CliSpawn` implementations that predate this field keep compiling/running unchanged;
   * treated as "" wherever absent. Never carries an env value — it is exactly what the member's own
   * process wrote to fd 2, nothing levare adds to it.
   */
  stderr?: string;
  /**
   * NOTES R4-SANDBOX-FIX: Bun's own signal name when the process was killed by a signal rather than
   * exiting normally (`exitCode` is `null` in that case, and this file's own `?? -1` fallback is what a
   * bare "exited -1" in an error message actually means — a process that never ran `exit()` at all).
   * Optional, mirroring `stderr?`'s own "predates this field" allowance for a test-double `CliSpawn`;
   * always populated by the real `bunSpawn`/`asyncBunSpawn` below. The single most useful piece of
   * information the macOS host-verification round 2 investigation was missing: "exited -1" alone cannot
   * distinguish a normal (if unusual) exit code from a signal-killed process, and the two point at
   * completely different classes of bug.
   */
  signalCode?: string | null;
}

export interface CliSpawnOptions {
  env: Record<string, string>;
  cwd?: string;
  timeoutMs: number;
  /**
   * NOTES F7: set only when the agent declares `context_via: stdin` — the full §6 context, written to
   * the child's stdin and then closed (EOF), never left open. Absent for the default `context_via:
   * arg` mode, in which case stdin is closed immediately with nothing written, so a CLI that
   * unexpectedly tries to read stdin blocks on EOF rather than hanging forever waiting on a TTY that
   * was never attached.
   */
  stdin?: string;
}

/** The CLI spawn boundary — wraps Bun.spawnSync so tests can drive the adapter without real procs. */
export interface CliSpawn {
  run(argv: string[], opts: CliSpawnOptions): SpawnResult;
}

/** The non-blocking counterpart to `CliSpawn` (NOTES F5) — same shape, Promise-returning, backed by
 * `Bun.spawn` (async) instead of `Bun.spawnSync`. See sdk-transport.ts's identical sync/async split
 * for the precedent this mirrors. */
export interface AsyncCliSpawn {
  run(argv: string[], opts: CliSpawnOptions): Promise<SpawnResult>;
}

// Default CLI spawn: a real, synchronous Bun.spawn with a hard timeout and the allowlisted env ONLY
// (env is replaced wholesale, not merged over process.env — that is the allowlist guarantee).
// NOTES R4-SANDBOX-FIX-10 (live macOS gate: a hung member chain — "killed 1 dangling process" reported at
// teardown with no diagnosis of WHICH link blocked). Gated on the identical `LEVARE_SANDBOX_DEBUG=1` flag
// every other sandbox diagnostic already uses. Prints whatever stdout/stderr bytes were actually
// captured before a timeout fired — the SUCCESS-path return already discards this (`stdout: timedOut ?
// "" : stdout`, a deliberate "never trust output from a killed/incomplete process" choice this leaves
// unchanged) — a hang's own partial output is exactly what tells a Conductor which link in a
// `sh -c "a && b && c"` chain actually got stuck, versus one that failed outright (which already reports
// its own stderr via `diagnoseCliFailure`).
function debugTimeoutOutput(stdout: string, stderr: string): void {
  if (process.env.LEVARE_SANDBOX_DEBUG !== "1") return;
  console.error(`[levare:sandbox-debug] timeout: partial stdout (${stdout.length} bytes): ${JSON.stringify(stdout.slice(0, 2000))}`);
  console.error(`[levare:sandbox-debug] timeout: partial stderr (${stderr.length} bytes): ${JSON.stringify(stderr.slice(0, 2000))}`);
}

// NOTES R4-SANDBOX-FIX-10: lists every process sharing `pgid` — `detached: true` (below) makes the
// spawned member its own process-group leader, and every child IT spawns (`sh` spawning `git`, `git`
// spawning a hook) inherits that SAME pgid unless one of them detaches again — called BEFORE
// `killProcessGroup` tears the group down, so a future hang names the blocking link (by pid and command
// name) instead of only ever reporting "N dangling processes" after they're already gone. `ps -A -o
// pid,ppid,pgid,comm` is the common subset both GNU (Linux) and BSD (macOS) `ps` accept identically —
// deliberately no distro/platform branch. Best-effort: if `ps` itself is unavailable or fails, this
// prints why rather than throwing and losing the timeout's own error path.
function debugAliveProcessGroup(pgid: number): void {
  if (process.env.LEVARE_SANDBOX_DEBUG !== "1") return;
  try {
    const r = Bun.spawnSync(["ps", "-A", "-o", "pid,ppid,pgid,comm"], { stdout: "pipe", stderr: "ignore" });
    const text = r.stdout ? new TextDecoder().decode(r.stdout) : "";
    const lines = text.split("\n").filter((line, i) => i === 0 || line.trim().split(/\s+/)[2] === String(pgid));
    console.error(`[levare:sandbox-debug] timeout: process group ${pgid} still alive at kill time:\n${lines.join("\n")}`);
  } catch (e) {
    console.error(`[levare:sandbox-debug] timeout: could not list process group ${pgid}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export const bunSpawn: CliSpawn = {
  run(argv, opts) {
    const proc = Bun.spawnSync(argv, {
      env: opts.env,
      cwd: opts.cwd,
      stdout: "pipe",
      stderr: "pipe",
      // NOTES F7: stdin carries the context when context_via is "stdin"; otherwise "ignore" closes it
      // immediately (never inherited, never left open) — see CliSpawnOptions.stdin's own doc.
      stdin: opts.stdin !== undefined ? Buffer.from(opts.stdin) : "ignore",
      timeout: opts.timeoutMs,
    });
    const stdout = proc.stdout ? new TextDecoder().decode(proc.stdout) : "";
    const stderr = proc.stderr ? new TextDecoder().decode(proc.stderr) : "";
    const timedOut = proc.exitedDueToTimeout === true;
    // NOTES R4-SANDBOX-FIX-10: `Bun.spawnSync`'s own `timeout` option kills the process internally, with
    // no hook for this module to inspect the process tree BEFOREHAND (unlike `asyncBunSpawn`, which owns
    // its own `setTimeout`) — only the partial-output half of this round's instrumentation applies here.
    if (timedOut) debugTimeoutOutput(stdout, stderr);
    return {
      stdout,
      exitCode: proc.exitCode ?? -1,
      // Bun's own timeout flag — the authoritative signal. A slow-but-successful member (which exits
      // 0 on its own) is never misread as timed out, and a plain non-zero exit stays a non-zero exit.
      timedOut,
      stderr,
      signalCode: proc.signalCode ?? null,
    };
  },
};

// Kill the whole process GROUP, not just the direct child — mirrors sdk-transport.ts#killProcessTree
// exactly (NOTES phase-7 K15): `detached: true` below puts the spawned member in its own process
// group, and a negative pid signals the whole group at once, reaping any of the member's own children
// too, not just the member itself.
function killProcessGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    /* already exited, or never got its own process group — nothing left to kill */
  }
}

// The non-blocking default (NOTES F5): `Bun.spawn` + `await` instead of `Bun.spawnSync`, so the
// caller's event loop (levare serve's single JS thread) keeps servicing OTHER concurrent requests —
// and the daemon's own background tick — for the full duration of a member's run, exactly the
// blocking-vs-non-blocking split sdk-transport.ts already established for the SDK worker. The timeout
// is enforced explicitly (a setTimeout that kills the process group), matching
// createAsyncSdkTransport's own reasoning: `exitedDueToTimeout` is documented for spawnSync, not
// observed to be populated for async spawn in this Bun version.
export const asyncBunSpawn: AsyncCliSpawn = {
  async run(argv, opts) {
    const proc = Bun.spawn(argv, {
      env: opts.env,
      cwd: opts.cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: opts.stdin !== undefined ? Buffer.from(opts.stdin) : "ignore",
      detached: true,
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // NOTES R4-SANDBOX-FIX-10: list who's still alive BEFORE killing — the whole point is naming the
      // blocking link, which the kill itself would otherwise erase all evidence of.
      if (proc.pid) {
        debugAliveProcessGroup(proc.pid);
        killProcessGroup(proc.pid);
      }
    }, opts.timeoutMs);
    try {
      const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      if (timedOut) debugTimeoutOutput(stdout, stderr);
      return {
        stdout: timedOut ? "" : stdout,
        exitCode: proc.exitCode ?? -1,
        timedOut,
        stderr,
        signalCode: proc.signalCode ?? null,
      };
    } finally {
      clearTimeout(timer);
    }
  },
};

export interface AdapterRunnerOptions {
  pricing: Pricing;
  /**
   * Test-only override of the studio's capability map. The DEFAULT — and the only thing any real
   * studio ever uses — is the repo's own: every agent's declared `produces:` kinds, read from disk
   * (repo.ts#repoCapabilities). Injecting the map at construction was a fixture-era seam the stubs
   * filled with a `CAPABILITIES` export while real agent definitions had no way to declare one, so a
   * real studio's map came out empty and every flow step failed to bind (NOTES F1).
   */
  capabilities?: Array<{ member: string; kind: string }>;
  native: NativeBoundary;
  remote: RemoteBoundary;
  /** NOTES MCP-1B: the non-blocking counterpart to `remote`, used only by `produceAsync`. When absent,
   * `produceAsync` falls back to `remote.call` (fine for a mocked/stub boundary, which does no real
   * I/O); `productionAdapterRunner` always supplies a real one (`createAsyncStdioRemoteBoundary`) so a
   * live remote dispatch never blocks the event loop — mirrors `asyncNative`'s own doc below. */
  asyncRemote?: AsyncRemoteBoundary;
  spawn?: CliSpawn;
  /** NOTES F5: the non-blocking counterpart to `spawn`, used only by `produceAsync`. Defaults to
   * `asyncBunSpawn` (real, non-blocking `Bun.spawn`). */
  asyncSpawn?: AsyncCliSpawn;
  /** NOTES F8: the non-blocking counterpart to `native`, used only by `produceAsync`. When absent,
   * `produceAsync` falls back to `native.invoke` (fine for a mocked/stub boundary, which does no real
   * I/O); `productionAdapterRunner` always supplies a real one (`createAsyncSdkNativeBoundary`) so a
   * live native call never blocks the event loop. */
  asyncNative?: AsyncNativeBoundary;
  /** Environment the allowlist draws from (default process.env). */
  baseEnv?: Record<string, string | undefined>;
  /**
   * Build the argv for a CLI member. Default substitutes the agent's `command` template
   * ({task}/{feature_repo}); replay's --stubs mode overrides this to spawn the stub member CLI.
   */
  cliCommand?: (req: InvokeRequest) => string[];
  /** Injectable clock for the artifact's `created` date (ruling C12) — default real today; tests
   * inject a fixed date for deterministic assertions. */
  now?: () => string;
  /** NOTES R4-SANDBOX: test-only override of the OS sandbox primitive detection — default a real,
   * freshly-probed `detectSandbox()` on every cli spawn (never cached across a run, and never assumed
   * from the platform alone — see sandbox.ts's own header). Production call sites (`replay.ts`,
   * `board/serve.ts`) never set this, so a live spawn always reflects the host's actual, current
   * capability. */
  sandboxDetection?: SandboxDetection;
}

// Substitute the agent.command argv template. {task} = the FULL §6-assembled context (NOTES F7) —
// the same recipe a native member's system prompt carries (agent body, skills, knowledge, team
// charter+learnings, project house rules, the task string, and consumed-artifact paths) — never just
// the bare flow step label; a foreign CLI member is a first-class member, not a word-guessing game.
// {feature_repo} = the project's checkout dir. {model} = the agent's declared `model:` (NOTES F11) —
// substituted whenever present so a template like `--model {model}` reaches the vendor CLI with the
// model the studio actually declared; when the agent declares no model, {model} substitutes to "" (the
// validator's MODEL_PLACEHOLDER_MISSING check is the enforcement point — a declared model with no
// `{model}` in the template is a validation error, not a runtime no-op). Each template element maps to
// EXACTLY ONE argv element: the placeholder is replaced in place and the resulting element is kept
// whole — a substituted value containing spaces, quotes, or shell metacharacters stays a single
// argument and is never re-split. The command is handed to a shell-less spawn(argv), so no element is
// ever interpreted by a shell.
function defaultCliCommand(req: InvokeRequest): string[] {
  const template = req.agent.command;
  if (!template || template.length === 0) throw new AdapterError(`cli agent '${req.member}' has no command template`);
  // NOTES MERGE-1: prefer the resolved project repo path when one exists; a project with no real
  // local checkout falls back to the pre-existing `agent.cwd` self-reference (see resolveFeatureRepo).
  const feature = req.projectRepoPath ?? req.agent.cwd ?? ".";
  const model = req.agent.model ?? "";
  return template.map((element) => element.replace(/\{task\}/g, req.context).replace(/\{feature_repo\}/g, feature).replace(/\{model\}/g, model));
}

// Which of the two ways (NOTES F7) `agent.context_via` says a CLI member receives its context.
// Defaults to "arg" — the pre-F7 shape (substituted into argv via {task}) — so an agent definition
// that never declares the field keeps behaving exactly as before, just with the FULL context instead
// of the bare step label now landing in that argv slot.
function contextVia(agent: Agent): "arg" | "stdin" {
  return agent.context_via === "stdin" ? "stdin" : "arg";
}

/**
 * NOTES F3: before handing argv/cwd to Bun.spawn, verify the two things that make Bun.spawn fail with
 * an opaque, contextless nonzero exit (or, for a bad cwd, a Node-level ENOENT with no member context
 * at all): (a) the resolved cwd exists and is a directory, and (b) argv[0] resolves to something
 * actually executable — either an absolute/relative path on disk or a bare name on PATH. Either
 * failure throws a precise, member-attributed AdapterError BEFORE any process is spawned, so a
 * misconfigured studio never surfaces as a bare "exited N" with nothing to go on.
 */
function preflightCli(member: string, argv: string[], cwd: string | undefined, pathEnv: string | undefined): void {
  if (cwd !== undefined) {
    if (!existsSync(cwd)) throw new AdapterError(`agent '${member}': cwd '${cwd}' does not exist`);
    if (!statSync(cwd).isDirectory()) throw new AdapterError(`agent '${member}': cwd '${cwd}' is not a directory`);
  }
  const argv0 = argv[0];
  if (!argv0) throw new AdapterError(`agent '${member}': command has no argv[0]`);
  if (argv0.includes("/")) {
    const resolved = isAbsolute(argv0) ? argv0 : pathJoin(cwd ?? process.cwd(), argv0);
    if (!isExecutableFile(resolved)) {
      throw new AdapterError(`agent '${member}': command '${argv0}' is not an executable file (resolved to '${resolved}')`);
    }
  } else if (Bun.which(argv0, { PATH: pathEnv ?? "" }) === null) {
    throw new AdapterError(`agent '${member}': command '${argv0}' not found on PATH`);
  }
}

// NOTES R4-SANDBOX-FIX: the SAME resolution `preflightCli` above already checks, but returning the
// resolved absolute path rather than a bare boolean — `sandboxWrap` uses it to allowlist wherever this
// dispatch's own argv[0] actually lives (a Homebrew/user-local install, `~/.bun`, anything the platform's
// own static allowlist doesn't already cover), never a second, drifting copy of the same lookup.
// `undefined` when unresolvable — `preflightCli` is what fails the dispatch for that case; this function
// only ever runs alongside a preflight check that already passed.
function resolveArgv0(argv0: string, cwd: string | undefined, pathEnv: string | undefined): string | undefined {
  if (argv0.includes("/")) {
    const resolved = isAbsolute(argv0) ? argv0 : pathJoin(cwd ?? process.cwd(), argv0);
    return existsSync(resolved) ? resolved : undefined;
  }
  return Bun.which(argv0, { PATH: pathEnv ?? "" }) ?? undefined;
}

function isExecutableFile(p: string): boolean {
  try {
    const st = statSync(p);
    if (!st.isFile()) return false;
    accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Last N chars of a string, trimmed — the truncated stderr tail attached to a CLI failure reason
// (NOTES F3). Never the full stderr: an unbounded member's error output must not grow a blocked
// artifact (and its git commit) without bound.
function truncateTail(s: string, maxLen: number): string {
  const trimmed = s.trim();
  return trimmed.length <= maxLen ? trimmed : trimmed.slice(-maxLen);
}

function lastNonEmptyLine(s: string): string {
  const lines = s.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : "";
}

// NOTES F21: many CLIs report a failure as structured JSON rather than plain text — when a stream
// parses as one and carries a recognizable error/message field, that field IS the diagnosis, more
// precise than a raw byte tail. `null` for anything that isn't parseable JSON with such a field —
// never a partial/best-effort read pretending to be a full one.
function vendorStructuredError(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const err = parsed?.error;
    if (typeof err === "string") return err;
    if (err && typeof err === "object" && typeof (err as Record<string, unknown>).message === "string") {
      return (err as Record<string, unknown>).message as string;
    }
    if (typeof parsed?.message === "string") return parsed.message;
  } catch {
    return null;
  }
  return null;
}

// NOTES F21: the diagnosis a Conductor actually needs when a CLI member fails — surfaced first and
// prominently, ahead of anything else a failure message reports. The pre-fix message led with the
// argv the member was invoked with, which for a real studio can carry the member's ENTIRE §6 context
// substituted into `{task}` — often thousands of characters — before the stderr tail ever appeared;
// on a card that shows only a bounded preview, the Conductor saw levare's own echoed prompt and never
// the real error at all (the live defect this closes). Tried in order: the vendor's own structured
// error (many CLIs emit JSON on failure), the tail of stderr, the last non-empty line of stdout (some
// CLIs write their error there instead of stderr) — "(no output captured)" only when the process
// genuinely reported nothing at all.
function diagnoseCliFailure(result: SpawnResult): string {
  const stderr = result.stderr ?? "";
  const structured = vendorStructuredError(stderr) ?? vendorStructuredError(result.stdout ?? "");
  if (structured) return structured;
  const tail = truncateTail(stderr, 2000);
  if (tail) return tail;
  const lastLine = lastNonEmptyLine(result.stdout ?? "");
  if (lastLine) return lastLine;
  return "(no output captured)";
}

// Each argv element, capped — kept as a secondary "what actually ran" reference, never the primary
// diagnosis (see diagnoseCliFailure above): a real `{task}`-substituted element can be thousands of
// characters, and dumping it whole here would recreate the exact defect this file's F21 fix closes.
function summarizeArgv(argv: string[], maxElementLen = 200): string {
  return JSON.stringify(argv.map((a) => (a.length > maxElementLen ? `${a.slice(0, maxElementLen)}…(${a.length} chars total)` : a)));
}

// NOTES F17: a wrapped CLI's own reported usage. Unlike a native member (a real SDK call that always
// reports structured usage, or genuinely reports nothing), a foreign CLI's token accounting — when it
// reports any at all — typically comes back as a plain trailer line rather than structured data, e.g.
// Codex's own "tokens used: 2745". Parsed off the member's raw stdout and stripped from the kept
// content before it's authored into the artifact body (ruling C12: the member's output is content, not
// schema — a usage trailer is no more part of the document than a frontmatter fence the member emitted
// on its own initiative). Returns `tokensUsed: null` when nothing matched — "reported nothing
// parseable this run", not "definitely zero" — see `AdapterRunner#author`'s own null-vs-silence
// handling for a subscription member.
const CLI_TOKENS_TRAILER_RE = /^[ \t]*tokens used:[ \t]*(\d+)[ \t]*$/im;
function extractCliUsageTrailer(raw: string): { content: string; tokensUsed: number | null } {
  const m = CLI_TOKENS_TRAILER_RE.exec(raw);
  if (!m) return { content: raw, tokensUsed: null };
  const tokensUsed = Number(m[1]);
  const content = (raw.slice(0, m.index) + raw.slice(m.index + m[0].length)).replace(/\n{3,}/g, "\n\n");
  return { content, tokensUsed };
}

/**
 * NOTES R4-SANDBOX-FIX-13 (live macOS gate: a ladder that could disagree with production — FIX-5's own
 * weak-canary lesson wearing a new coat). Extracted from `AdapterRunner#sandboxWrap` into its own,
 * EXPORTED, pure-ish function so a diagnostic script (`scripts/repro-r4-sandbox-fix10-hang.ts`) can build
 * the EXACT policy a real dispatch would, by calling the SAME code, rather than hand-mirroring the
 * fields and risking exactly the kind of silent drift that let FIX-12's own dedupe-ordering bug ship: the
 * ladder's own hand-rolled policy never reproduced the real `writablePaths`/`gitWriteGrant` duplication
 * `sandboxWrap` actually sends, so it never exercised the bug it was supposedly built to catch.
 *
 * `readOnlyPaths` always includes the studio root (`repo.root` — a command checked into the studio, or a
 * `context_artifacts: paths` member's own consumed-artifact reads, both need it), the running levare
 * binary's own directory, and wherever THIS dispatch's own argv[0] resolves to (`resolveArgv0` — a
 * Homebrew/user-local install, `~/.bun`, anything the platform's static allowlist doesn't already cover) —
 * both the running binary's own install and the resolved member command's own install include one level
 * ABOVE their immediate directory (NOTES R4-SANDBOX-FIX-3: "dyld reads beyond bin/"). The operator's REAL,
 * unscoped HOME and any granted subscription connector's OWN real home targets are threaded for the
 * darwin deny-list model specifically (ignored entirely by bubblewrap). `writablePaths`/`gitWriteGrant`/
 * `darwinXcrunTempDir` are FIX-7 through FIX-12's own accumulated grants — see `SandboxPolicy`'s own
 * per-field docs in `sandbox.ts` for what each does and why.
 */
export function buildDispatchSandboxPolicy(
  repo: Repo,
  req: InvokeRequest,
  cwd: string | undefined,
  argv0: string | undefined,
  baseEnv?: Record<string, string | undefined>,
): SandboxPolicy {
  const resolvedBin = argv0 ? resolveArgv0(argv0, cwd, req.env.PATH) : undefined;
  const treeDirs = (p: string) => [dirname(p), dirname(dirname(p))];
  const readOnlyPaths = [repo.root, ...treeDirs(process.execPath), ...(resolvedBin ? treeDirs(resolvedBin) : [])];
  const operatorHome = baseEnv?.HOME ?? process.env.HOME;
  const sub = subscriptionConnector(repo, req.member);
  const grantedHomeTargets = operatorHome ? (sub?.home ?? []).filter(isSafeHomeDotpath).map((dotpath) => pathJoin(operatorHome, dotpath)) : [];
  const darwinTempDir = resolveDarwinUserTempDir();
  return {
    cwd: cwd ?? process.cwd(),
    home: req.env.HOME,
    allowNetwork: memberNetworkAllowed(repo, req.member),
    readOnlyPaths,
    operatorHome,
    grantedHomeTargets,
    // NOTES R4-VENDOR-CLI: the vendor-CLI scratch dir carries no reseal/deny-then-reallow complexity the
    // way `gitWriteGrant`'s own subpaths do (nothing else in this profile ever claims this fresh,
    // per-dispatch directory), so it needs no dedicated field — a plain `writablePaths` entry, exactly
    // like `dispatchGitWriteGrant`'s own subpaths, is what both platforms' generators already handle
    // generically.
    writablePaths: [...(req.dispatchGitWriteGrant?.subpaths ?? []), ...(req.cliVendorScratchDir ? [req.cliVendorScratchDir] : [])],
    gitWriteGrant: req.dispatchGitWriteGrant,
    darwinXcrunTempDir: darwinTempDir,
  };
}

/**
 * The phase-3 MemberRunner: resolves each member to its adapter, assembles context, scopes env, runs
 * it, and normalizes the receipt. Returns { doc, receipt } — the Runner validates the doc and records
 * the receipt on the produce event.
 */
export class AdapterRunner implements MemberRunner {
  private readonly repo: Repo;
  private readonly opts: AdapterRunnerOptions;
  private readonly spawn: CliSpawn;
  private readonly asyncSpawn: AsyncCliSpawn;

  constructor(repo: Repo, opts: AdapterRunnerOptions) {
    this.repo = repo;
    this.opts = opts;
    this.spawn = opts.spawn ?? bunSpawn;
    this.asyncSpawn = opts.asyncSpawn ?? asyncBunSpawn;
  }

  /** Derived from the agent definitions on disk (invariant 2); `opts.capabilities` overrides only in tests. */
  capabilities() {
    return this.opts.capabilities ?? repoCapabilities(this.repo);
  }

  /** The blocking boundary (§6, phase 3): used by the phase-2 batch Runner (`levare replay`), which
   * drives a full scripted decision walk synchronously and is never reachable from a live `levare
   * serve` request path (invariant 10's native/remote deferral; the CLI kind's real, live spawn goes
   * through `produceAsync` instead — see NOTES F5). */
  produce(member: string, kind: string, unit: string, project: string, extraConsumes: string[] = []): { doc: string; receipt: Receipt } {
    const { agent, req, dispatchRepo } = this.prepare(member, kind, unit, project, extraConsumes);
    return this.withDispatchWorktree(member, dispatchRepo, req, (req2) => {
      let raw: string;
      let receipt: Receipt | undefined;
      let sandbox: SandboxLevel | undefined;
      switch (agent.kind) {
        case "native": {
          const res = this.withHomeScope(member, req2, (r) => this.opts.native.invoke(r));
          raw = res.doc;
          receipt = res.receipt;
          break;
        }
        case "remote":
          raw = this.opts.remote.call(req2).doc;
          break;
        case "cli": {
          const out = this.withHomeScope(member, req2, (r) => this.runCli(agent, r));
          raw = out.content;
          receipt = this.cliReceipt(agent, out.tokensUsed);
          sandbox = out.sandbox;
          break;
        }
        default:
          throw new AdapterError(`unknown agent kind '${(agent as Agent).kind}' for '${member}'`);
      }
      return this.author(req2, raw, receipt, extraConsumes, sandbox);
    });
  }

  /**
   * NOTES F5: the non-blocking boundary — what `levare serve`'s live daemon/gateops path drives
   * (see replay.ts#productionAdapterRunner). Identical recipe to `produce` (same context assembly, env
   * scoping, receipt normalization — one implementation, not a fork), but a `kind: cli` member's spawn
   * is genuinely async (`asyncSpawn`/`asyncBunSpawn`, Bun.spawn + await) instead of blocking the
   * caller's thread for the member's entire run. Native/remote stay synchronous underneath (they are
   * mocked boundaries, not live — invariant 10) but are still awaited here uniformly.
   */
  async produceAsync(member: string, kind: string, unit: string, project: string, extraConsumes: string[] = []): Promise<{ doc: string; receipt: Receipt }> {
    const { agent, req, dispatchRepo } = this.prepare(member, kind, unit, project, extraConsumes);
    return this.withDispatchWorktreeAsync(member, dispatchRepo, req, async (req2) => {
      let raw: string;
      let receipt: Receipt | undefined;
      let sandbox: SandboxLevel | undefined;
      switch (agent.kind) {
        case "native": {
          const res = await this.withHomeScopeAsync(member, req2, async (r) => (this.opts.asyncNative ? await this.opts.asyncNative.invoke(r) : this.opts.native.invoke(r)));
          raw = res.doc;
          receipt = res.receipt;
          break;
        }
        case "remote": {
          const res = this.opts.asyncRemote ? await this.opts.asyncRemote.call(req2) : this.opts.remote.call(req2);
          raw = res.doc;
          break;
        }
        case "cli": {
          const out = await this.withHomeScopeAsync(member, req2, (r) => this.runCliAsync(agent, r));
          raw = out.content;
          receipt = this.cliReceipt(agent, out.tokensUsed);
          sandbox = out.sandbox;
          break;
        }
        default:
          throw new AdapterError(`unknown agent kind '${(agent as Agent).kind}' for '${member}'`);
      }
      return this.author(req2, raw, receipt, extraConsumes, sandbox);
    });
  }

  // NOTES CAP-B (part B, item 4): wraps a native/cli invocation with a per-spawn scoped HOME
  // (env.ts#scopeHome) — a no-op (returns `req` unchanged) unless `member` is granted a subscription
  // connector that declares `home:`. Scratch dirs are created here, immediately before the spawn, and
  // removed in `finally` immediately after — never shared across calls, never left behind on either a
  // success or a thrown AdapterError. `remote` never goes through this (mocked, no real spawn — see
  // both callers above): scoping a HOME that never reaches a real process would only cost a wasted
  // mkdtemp/rm pair for no isolation benefit.
  private withHomeScope<T>(member: string, req: InvokeRequest, fn: (req: InvokeRequest) => T): T {
    const scoped = scopeHome(this.repo, member, req.env);
    try {
      return fn({ ...req, env: scoped.env });
    } finally {
      scoped.cleanup();
    }
  }

  private async withHomeScopeAsync<T>(member: string, req: InvokeRequest, fn: (req: InvokeRequest) => Promise<T>): Promise<T> {
    const scoped = scopeHome(this.repo, member, req.env);
    try {
      return await fn({ ...req, env: scoped.env });
    } finally {
      scoped.cleanup();
    }
  }

  // Shared setup for both produce/produceAsync: resolve the agent, assemble its §6 context, scope its
  // env, and build the InvokeRequest every adapter kind reads from. `dispatchRepo`, when set, is
  // resolved here but not yet turned into a worktree — `withDispatchWorktree`/`withDispatchWorktreeAsync`
  // do that around the actual invoke call, since the worktree's lifetime must span exactly one dispatch.
  private prepare(member: string, kind: string, unit: string, project: string, extraConsumes: string[] = []): {
    agent: Agent;
    req: InvokeRequest;
    dispatchRepo?: { repoPath: string; branch?: string };
  } {
    const agent = this.repo.agents.get(member);
    if (!agent) throw new AdapterError(`no agent definition for member '${member}'`);
    const context = this.assemble(member, unit, project, extraConsumes);
    const env = buildMemberEnv(this.repo, member, this.opts.baseEnv);
    const dispatchRepo = this.resolveDispatchRepo(project, unit);
    const req: InvokeRequest = { agent, member, kind, unit, project, context, env, tools: allowedTools(agent), projectRepoPath: dispatchRepo?.repoPath };
    return { agent, req, dispatchRepo };
  }

  // NOTES MERGE-1 (goal item 1) / NOTES R4-SANDBOX (Ruling 1): a repo-bearing project whose unit
  // already has a work branch (board/gateops.ts#doStart creates it at unit-open, before any member for
  // this unit is ever dispatched — see M1) gets a per-dispatch worktree of that branch. `branch`
  // undefined means either the project isn't a real local checkout (resolveProjectRepoPath already
  // excludes self-referential `repo: .` projects and unresolvable `repo:` values structurally) or the
  // branch genuinely doesn't exist yet (shouldn't happen given the ordering above, but never assumed) —
  // both cases fall through to the plain `repoPath` with no worktree, exactly the pre-existing no-op
  // behaviour for a project without a real checkout.
  private resolveDispatchRepo(project: string, unit: string): { repoPath: string; branch?: string } | undefined {
    const proj = this.repo.projects.get(project);
    if (!proj) return undefined;
    const repoPath = resolveProjectRepoPath(this.repo.root, proj);
    if (!repoPath) return undefined;
    const branch = workBranchName(unit);
    return { repoPath, branch: branchExists(repoPath, branch) ? branch : undefined };
  }

  // NOTES R4-SANDBOX (Ruling 1): wraps a native/cli invocation with a per-dispatch scratch worktree of
  // the unit's own work branch (merge.ts#createDispatchWorktree) — the shared-single-working-tree
  // checkout this goal retires (adapters.ts's own former `memberWorkingContext`, docs/current-gaps.md's
  // now-closed race). A no-op when `dispatchRepo` has no `branch` (no real local checkout, or no branch
  // yet). `req.projectRepoPath` is overridden to the worktree's own path for the duration of the call —
  // every downstream {feature_repo}/cwd resolution (nativeWorkerRequest, defaultCliCommand, cliInvocation)
  // reads it from there — and the worktree is torn down in `finally`, success or thrown AdapterError
  // alike, mirroring `withHomeScope`'s own create-immediately-before/clean-up-immediately-after shape.
  // NOTES R4-SANDBOX-FIX-7/FIX-8: `req.dispatchGitWritePaths` is set alongside it — the narrowed, exact
  // subpaths `sandboxWrap` needs to grant WRITE access to (see `InvokeRequest.dispatchGitWritePaths`'s
  // own doc), never the whole `.git` directory.
  // NOTES R4-SANDBOX-FIX-14 (round 3, live host): a dispatch that DECLINES a worktree is not just a
  // harness-parity concern — declining means the member's own commits land against the studio's SHARED
  // tree instead of an isolated scratch worktree, in production exactly as much as in the ladder. Round 2
  // isolated a live case where the fixture satisfied `resolveDispatchRepo`'s own precondition (verified
  // directly, immediately pre-dispatch) yet the actual dispatch still declined — a silent divergence
  // between the precondition and the decision, with no way to see WHERE it diverged. This prints the
  // decision itself — created (with the resolved path) or declined (naming exactly which guard fired) —
  // for EVERY dispatch, gated on the SAME `LEVARE_SANDBOX_DEBUG=1` env var every other sandbox-debug line
  // in this codebase already uses. A silent decline is the actual bug class here regardless of which
  // guard turns out to be responsible.
  private static logWorktreeDebug(outcome: string): void {
    if (process.env.LEVARE_SANDBOX_DEBUG !== "1") return;
    console.error(`[levare:sandbox-debug] ${outcome}`);
  }

  private withDispatchWorktree<T>(member: string, dispatchRepo: { repoPath: string; branch?: string } | undefined, req: InvokeRequest, fn: (req: InvokeRequest) => T): T {
    if (!dispatchRepo?.branch) {
      AdapterRunner.logWorktreeDebug(
        dispatchRepo
          ? `dispatch worktree declined for '${member}': work branch '${workBranchName(req.unit)}' does not exist in '${dispatchRepo.repoPath}' (resolveDispatchRepo's own branchExists check failed)`
          : `dispatch worktree declined for '${member}': resolveDispatchRepo found no repo-bearing project for project '${req.project}' (project not found, repo: unset/unresolvable, or self-referential to the studio root)`,
      );
      return fn(req);
    }
    const created = createDispatchWorktree(dispatchRepo.repoPath, dispatchRepo.branch);
    if (!created.ok) {
      AdapterRunner.logWorktreeDebug(`dispatch worktree declined for '${member}': createDispatchWorktree failed for branch '${dispatchRepo.branch}' in '${dispatchRepo.repoPath}': ${created.error}`);
      throw new AdapterError(`member '${member}': could not create dispatch worktree for work branch '${dispatchRepo.branch}' in '${dispatchRepo.repoPath}': ${created.error}`);
    }
    AdapterRunner.logWorktreeDebug(`dispatch worktree created for '${member}' at '${created.worktree.path}' (gitDir '${created.worktree.gitDir}') for branch '${dispatchRepo.branch}' in '${dispatchRepo.repoPath}'`);
    try {
      return fn({ ...req, projectRepoPath: created.worktree.path, dispatchGitWriteGrant: dispatchGitWriteGrant(created.worktree.gitDir) });
    } finally {
      created.worktree.cleanup();
    }
  }

  private async withDispatchWorktreeAsync<T>(
    member: string,
    dispatchRepo: { repoPath: string; branch?: string } | undefined,
    req: InvokeRequest,
    fn: (req: InvokeRequest) => Promise<T>,
  ): Promise<T> {
    if (!dispatchRepo?.branch) {
      AdapterRunner.logWorktreeDebug(
        dispatchRepo
          ? `dispatch worktree declined for '${member}': work branch '${workBranchName(req.unit)}' does not exist in '${dispatchRepo.repoPath}' (resolveDispatchRepo's own branchExists check failed)`
          : `dispatch worktree declined for '${member}': resolveDispatchRepo found no repo-bearing project for project '${req.project}' (project not found, repo: unset/unresolvable, or self-referential to the studio root)`,
      );
      return fn(req);
    }
    const created = createDispatchWorktree(dispatchRepo.repoPath, dispatchRepo.branch);
    if (!created.ok) {
      AdapterRunner.logWorktreeDebug(`dispatch worktree declined for '${member}': createDispatchWorktree failed for branch '${dispatchRepo.branch}' in '${dispatchRepo.repoPath}': ${created.error}`);
      throw new AdapterError(`member '${member}': could not create dispatch worktree for work branch '${dispatchRepo.branch}' in '${dispatchRepo.repoPath}': ${created.error}`);
    }
    AdapterRunner.logWorktreeDebug(`dispatch worktree created for '${member}' at '${created.worktree.path}' (gitDir '${created.worktree.gitDir}') for branch '${dispatchRepo.branch}' in '${dispatchRepo.repoPath}'`);
    try {
      return await fn({ ...req, projectRepoPath: created.worktree.path, dispatchGitWriteGrant: dispatchGitWriteGrant(created.worktree.gitDir) });
    } finally {
      created.worktree.cleanup();
    }
  }

  // NOTES F17: build a Receipt from a CLI's own parsed token trailer (extractCliUsageTrailer), when it
  // reported one — `agent.model` is the studio's own declaration (a CLI never reports its model in the
  // trailer), so pricing can still resolve it from the table when known. `undefined` when the CLI
  // reported nothing parseable, letting `author()`'s own `receipt ?? normalizeReceipt(null, ...)`
  // fallback take over exactly as before.
  private cliReceipt(agent: Agent, tokensUsed: number | null): Receipt | undefined {
    if (tokensUsed === null) return undefined;
    return normalizeReceipt({ model: agent.model ?? null, tokens_in: null, tokens_out: tokensUsed, wall_clock_s: null, usd: null }, this.opts.pricing);
  }

  // Ruling C12: levare authors the artifact. `raw` is whatever the boundary returned — plain content,
  // or content the member wrapped in a frontmatter fence of its own (stripped below, never read). The
  // wrapper is built entirely from facts this runner already knows; the member's own account of them
  // is never consulted. `receipt`, when the boundary supplied one, is the SDK's OWN reported usage (a
  // native member's real token counts/cost/wall-clock, computed by sdk-worker.ts from the actual API
  // response) — used verbatim. Absent (every non-native adapter, and a mocked/stub native boundary
  // that doesn't report one) records `unreported`, honestly — never re-derived by parsing whatever
  // usage figures the member's own output happened to claim.
  private author(req: InvokeRequest, raw: string, receipt?: Receipt, extraConsumes: string[] = [], sandbox?: SandboxLevel): { doc: string; receipt: Receipt } {
    const content = stripFrontmatter(raw);
    if (!content) throw new AdapterError(`member '${req.member}' produced no usable content`);
    let finalReceipt = receipt ?? normalizeReceipt(null, this.opts.pricing);
    // NOTES C13/F17: a subscription-authenticated member's cost is flat-rate, not per-token — pricing
    // it from the token table would be a fiction. `usd` is forced null and the plan is named in its
    // place; token counts (when the member's boundary reported them) pass through unchanged.
    //
    // F17: for a `kind: cli` subscription member specifically, the receipt is never simply OMITTED —
    // even when the CLI reported nothing parseable this run, the studio already knows this member's
    // auth mode and plan, so recording nothing at all would be indistinguishable from "ran for free".
    // Scoped to `cli`: a native member's boundary is the real SDK, which either reports real usage or
    // is genuinely, unconditionally silent (a test-only shape `normalizeReceipt`'s own `unreported`
    // already names honestly) — that silence is a different, still-legitimate case, left unchanged.
    const sub = subscriptionConnector(this.repo, req.member);
    if (sub) {
      if (finalReceipt.unreported && req.agent.kind === "cli") finalReceipt = { ...finalReceipt, unreported: false };
      if (!finalReceipt.unreported) finalReceipt = { ...finalReceipt, usd: null, plan: sub.plan ?? sub.name };
    }
    // NOTES F11 part 2: the SDK can silently substitute its own default model when a call doesn't run
    // on the one requested — no error, no warning, the call simply succeeds on a different model
    // (proven live: an auxiliary internal call inside a single query() ran on a model the agent never
    // declared, alongside a correctly-honoured primary response — see sdk-worker.ts's `respondingModel`
    // fix for the root cause this guards against as defense in depth). The receipt is the SDK's OWN
    // report of what actually ran (never re-derived, per the comment above) — so it is the only honest
    // thing to compare the DECLARATION against. A native member whose receipt names a model other than
    // its own declared `model:` produced work the Conductor never authorised and never budgeted for:
    // that is a hard failure, not a warning. Thrown here (before any content is authored) so
    // dagwalk.ts#produceOne's existing member-failure handling turns it into a `blocked` artifact
    // naming both models — the same path every other member failure already takes, not a new one.
    if (req.agent.kind === "native" && req.agent.model && !finalReceipt.unreported && finalReceipt.model && finalReceipt.model !== req.agent.model) {
      throw new AdapterError(
        `native member '${req.member}' declared model '${req.agent.model}' but its usage receipt reports it ran on '${finalReceipt.model}' — a member that ran on a model the Conductor did not authorise produced work they did not sanction or budget for`,
      );
    }
    const team = teamOf(this.repo, req.member);
    const producedBy = team ? `${team.name}/${req.member}` : req.member;
    const extraSet = new Set(extraConsumes);
    const consumes = unitArtifactPaths(this.repo.root, req.project, req.unit)
      .filter((a) => a.status === "approved" || extraSet.has(a.id))
      .map((a) => a.id);
    const id = `${req.kind}-${req.unit}-v1`;
    const created = (this.opts.now ?? (() => new Date().toISOString().slice(0, 10)))();
    const lines = [
      "---",
      `kind: ${req.kind}`,
      `id: ${id}`,
      `unit: ${req.unit}`,
      `project: ${req.project}`,
      "status: in-review",
      `produced_by: ${producedBy}`,
      `consumes: [${consumes.join(", ")}]`,
      "supersedes: null",
      "approved_by: null",
      `created: ${created}`,
      "files: []",
    ];
    if (!finalReceipt.unreported) {
      lines.push(
        "usage:",
        `  model: ${finalReceipt.model ?? "null"}`,
        `  tokens_in: ${finalReceipt.tokens_in ?? "null"}`,
        `  tokens_out: ${finalReceipt.tokens_out ?? "null"}`,
        `  usd: ${finalReceipt.usd ?? "null"}`,
        `  wall_clock_s: ${finalReceipt.wall_clock_s ?? "null"}`,
      );
      if (finalReceipt.plan) lines.push(`  plan: ${finalReceipt.plan}`);
    }
    // NOTES R4-SANDBOX: the OS-sandbox enforcement level a cli member's spawn actually ran under — a
    // fact about THIS run, independent of `usage`/`unreported` (a member reporting no usage at all still
    // carries a real sandbox level; never omitted just because nothing else was reported). Native/remote
    // never carry one — Ruling 2 wraps only the two cli spawn paths.
    if (req.agent.kind === "cli" && sandbox) lines.push(`sandbox: ${sandbox}`);
    lines.push("---", "");
    return { doc: lines.join("\n") + content + "\n", receipt: finalReceipt };
  }

  // Shared argv/cwd/stdin derivation for both the sync and async CLI spawn paths.
  private cliInvocation(agent: Agent, req: InvokeRequest): { argv: string[]; cwd: string | undefined; timeoutMs: number; stdin: string | undefined } {
    const argv = (this.opts.cliCommand ?? defaultCliCommand)(req);
    const timeoutMs = (agent.timeout ?? 600) * 1000;
    // NOTES MERGE-1: resolve `{feature_repo}` before checking for a leftover `{…}` — a cwd template
    // like finch's own `"{feature_repo}"` now resolves to the real project checkout when one exists
    // (req.projectRepoPath), and spawns there instead of falling back to the default cwd. A `cwd`
    // template that STILL holds an unresolved `{…}` after that (no real local checkout this run) is
    // not a real directory — spawn in the default cwd rather than fail on a bogus path, unchanged.
    const resolvedCwd = resolveFeatureRepo(agent.cwd, req.projectRepoPath);
    const cwd = resolvedCwd && !resolvedCwd.includes("{") ? resolvedCwd : undefined;
    // NOTES F7: context_via: stdin writes the full context to the child's stdin (and closes it);
    // context_via: arg (default) leaves stdin unset here — the CliSpawn boundary closes it regardless
    // (see CliSpawnOptions.stdin), so a CLI that unexpectedly reads stdin sees immediate EOF, never a
    // hang waiting on input that will never arrive.
    const stdin = contextVia(agent) === "stdin" ? req.context : undefined;
    return { argv, cwd, timeoutMs, stdin };
  }

  // Shared timeout/exit-code → AdapterError translation for both CLI spawn paths (NOTES F3: argv +
  // stderr tail attached either way). NOTES F17: also parses whatever token usage the CLI's own
  // stdout reports (see `extractCliUsageTrailer`) and returns it alongside the (trailer-stripped) doc
  // content — `tokensUsed` is null, not zero, when nothing parseable was found.
  private cliResultToDoc(member: string, agent: Agent, argv: string[], result: SpawnResult): { content: string; tokensUsed: number | null } {
    // NOTES R4-SANDBOX-FIX: an `exitCode` of -1 (this file's own `?? -1` fallback for both spawn
    // boundaries) means `proc.exitCode` was `null` — the process was killed by a SIGNAL, not a normal
    // `exit()`, a completely different class of failure than an ordinary nonzero exit and one "exited -1"
    // alone cannot distinguish. Named explicitly whenever known, since this was the single most useful
    // piece of information missing from the macOS host-verification round 2 investigation.
    const signal = result.signalCode ? ` (killed by signal ${result.signalCode})` : "";
    if (result.timedOut) {
      throw new AdapterError(
        `cli member '${member}' timed out after ${agent.timeout ?? 600}s${signal}: ${diagnoseCliFailure(result)} (argv: ${summarizeArgv(argv)})`,
      );
    }
    if (result.exitCode !== 0) {
      throw new AdapterError(`cli member '${member}' exited ${result.exitCode}${signal}: ${diagnoseCliFailure(result)} (argv: ${summarizeArgv(argv)})`);
    }
    return extractCliUsageTrailer(result.stdout);
  }

  // NOTES R4-SANDBOX (Ruling 2): wraps `argv` for the OS sandbox primitive detected on THIS spawn (never
  // cached — see sandbox.ts's own header) — filesystem confinement to the resolved `cwd` + the spawn's
  // own `HOME` (already scratch-scoped by `withHomeScope` when applicable) is the hard condition; network
  // is best-effort, denied unless the member holds at least one granted connector
  // (env.ts#memberNetworkAllowed). Only ever called for the REAL spawn boundary (see both call sites
  // below) — a test-injected `CliSpawn` double is a stand-in for arbitrary behaviour, never a real OS
  // process, so wrapping its argv would assert something about bwrap/unshare rather than about the
  // adapter's own logic (the identical reasoning `preflightCli`'s own `this.spawn === bunSpawn` guard
  // already applies, immediately below).
  //
  // NOTES R4-SANDBOX-FIX (macOS host verification): `readOnlyPaths` always includes the studio root
  // (`this.repo.root` — a command checked into the studio, or a `context_artifacts: paths` member's own
  // consumed-artifact reads, both need it; a live macOS run proved excluding it broke most of this
  // repo's own real-spawn test fixtures, which is exactly the "read reach a vendor CLI actually needs"
  // this module's own header names, not a loophole), the running levare binary's own directory
  // (`process.execPath` — many of this repo's own fixtures spawn `bun` itself), and wherever THIS
  // dispatch's own argv[0] resolves to (`resolveArgv0` — a Homebrew/user-local install, `~/.bun`,
  // anything the platform's static allowlist doesn't already cover).
  private sandboxWrap(argv: string[], cwd: string | undefined, req: InvokeRequest): WrappedSpawn {
    const detection = this.opts.sandboxDetection ?? detectSandbox();
    const policy = buildDispatchSandboxPolicy(this.repo, req, cwd, argv[0], this.opts.baseEnv);
    return wrapForSandbox(argv, policy, detection);
  }

  // NOTES R4-SANDBOX-FIX: prints the raw spawn result AFTER it returns — exitCode, signalCode, and
  // stdout/stderr byte counts plus stderr's own text — gated on the SAME `LEVARE_SANDBOX_DEBUG=1` env
  // var `sandbox.ts#wrapForSandbox` already gates its OWN (before-the-spawn) argv/profile dump behind.
  // Only ever called for the real spawn boundary, alongside `sandboxWrap` itself.
  private static logSpawnDebug(result: SpawnResult): void {
    if (process.env.LEVARE_SANDBOX_DEBUG !== "1") return;
    const stderr = result.stderr ?? "";
    console.error(
      `[levare:sandbox-debug] spawn result: exitCode=${result.exitCode} signalCode=${result.signalCode ?? "null"} timedOut=${result.timedOut} stdoutBytes=${result.stdout.length} stderrBytes=${stderr.length}`,
    );
    if (stderr) console.error(`[levare:sandbox-debug] stderr:\n${stderr}`);
  }

  private runCli(agent: Agent, req: InvokeRequest): { content: string; tokensUsed: number | null; sandbox?: SandboxLevel } {
    const { argv, cwd, timeoutMs, stdin } = this.cliInvocation(agent, req);
    // NOTES F3: pre-flight ONLY guards the real `bunSpawn` boundary — the one that actually hands argv
    // to the OS and can fail with an opaque, contextless nonzero exit. A test-injected `CliSpawn` is a
    // stand-in for arbitrary behaviour (including deliberately-fake argv[0]s like "codex" that this
    // sandbox never installs) and never touches the filesystem or PATH, so it is never subject to the
    // failure mode this guards against.
    const real = this.spawn === bunSpawn;
    if (real) preflightCli(req.member, argv, cwd, req.env.PATH);
    // NOTES R4-VENDOR-CLI: created unconditionally whenever real (mirrors `scopeHome`'s own unconditional-
    // creation-when-needed pattern) — the level isn't known until `sandboxWrap` below runs `detectSandbox()`
    // internally, so there's no cheaper point to decide "will this actually be used." The cost (one
    // `mkdtempSync`/`rmSync` pair) is trivial and matches every other scratch resource this file already
    // creates per-dispatch regardless of final level.
    const vendorScratch = real ? createCliVendorScratch() : undefined;
    const policyReq = vendorScratch ? { ...req, cliVendorScratchDir: vendorScratch.dir } : req;
    const wrapped: { argv: string[]; level?: SandboxLevel; cleanup?: () => void } = real ? this.sandboxWrap(argv, cwd, policyReq) : { argv };
    // NOTES R4-SANDBOX-FIX-9 / R4-VENDOR-CLI: only a "full"-tier sandbox denies (rather than merely
    // not-attempting-to-confine) the operator's real HOME — see `fullSandboxEnvRedirect`'s own doc.
    const env = wrapped.level === "full" ? fullSandboxEnvRedirect(req.env, vendorScratch?.dir) : req.env;
    try {
      const result = this.spawn.run(wrapped.argv, { env, cwd, timeoutMs, stdin });
      if (real) AdapterRunner.logSpawnDebug(result);
      // NOTES R4-SANDBOX-FIX: the WRAPPED argv, never the pre-wrap member argv — a failed spawn used to
      // report what the member would have been invoked with had sandboxing never run, which made "did
      // the wrapper even engage" impossible to tell from the error text alone.
      return { ...this.cliResultToDoc(req.member, agent, wrapped.argv, result), sandbox: wrapped.level };
    } finally {
      wrapped.cleanup?.();
      vendorScratch?.cleanup();
    }
  }

  // NOTES F5: the async counterpart to `runCli` — same argv/preflight/error handling, but the spawn
  // itself never blocks the caller's event loop (see asyncBunSpawn).
  private async runCliAsync(agent: Agent, req: InvokeRequest): Promise<{ content: string; tokensUsed: number | null; sandbox?: SandboxLevel }> {
    const { argv, cwd, timeoutMs, stdin } = this.cliInvocation(agent, req);
    const real = this.asyncSpawn === asyncBunSpawn;
    if (real) preflightCli(req.member, argv, cwd, req.env.PATH);
    const vendorScratch = real ? createCliVendorScratch() : undefined;
    const policyReq = vendorScratch ? { ...req, cliVendorScratchDir: vendorScratch.dir } : req;
    const wrapped: { argv: string[]; level?: SandboxLevel; cleanup?: () => void } = real ? this.sandboxWrap(argv, cwd, policyReq) : { argv };
    const env = wrapped.level === "full" ? fullSandboxEnvRedirect(req.env, vendorScratch?.dir) : req.env;
    try {
      const result = await this.asyncSpawn.run(wrapped.argv, { env, cwd, timeoutMs, stdin });
      if (real) AdapterRunner.logSpawnDebug(result);
      return { ...this.cliResultToDoc(req.member, agent, wrapped.argv, result), sandbox: wrapped.level };
    } finally {
      wrapped.cleanup?.();
      vendorScratch?.cleanup();
    }
  }

  // Assemble the §6 context. An empty consumed set ("no consumable produced yet") is a normal, silent
  // success — assembleContext simply returns a context with an empty consumed section. A THROW is a
  // genuine recipe error (missing agent/team/unit/step): that is surfaced on stderr, never silently
  // swallowed as if it were an empty context.
  private assemble(member: string, unit: string, project: string, extraConsumed: string[] = []): string {
    try {
      return assembleContext(this.repo, { root: this.repo.root, agent: member, unit, capabilities: this.capabilities(), extraConsumed });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`levare: context assembly error for member '${member}' (${project}/${unit}): ${msg}`);
      return "";
    }
  }
}

// Ruling C12: a member's raw output is content, never a document. If it happens to open with a
// frontmatter fence (a member that guessed at the schema, or restated it), that fence — and
// everything in it — is discarded unread; only the body past the closing fence is kept. A raw string
// with no fence at all (the common, honest case: a native member just wrote prose) passes through
// trimmed, unchanged.
function stripFrontmatter(raw: string): string {
  const lines = raw.split("\n");
  if (lines[0]?.trim() === "---") {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") return lines.slice(i + 1).join("\n").trim();
    }
  }
  return raw.trim();
}

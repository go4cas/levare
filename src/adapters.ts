// levare member adapters (§6). Behind the Runner's MemberRunner boundary sit three adapter kinds,
// dispatched by an agent's `kind`:
//
//   native → a Claude Agent SDK invocation with the assembled context, tool allowlist, and
//            granted-connector env. The adapter talks to a `NativeBoundary`/`AsyncNativeBoundary`
//            interface — tests mock it; production (replay.ts#productionAdapterRunner, NOTES F8)
//            backs it with the real SDK via `createSdkNativeBoundary`/`createAsyncSdkNativeBoundary`.
//   cli    → Bun.spawn of the agent's command template in `cwd`, with the allowlisted env only and
//            the timeout enforced; the raw stdout is the member's content.
//   remote → an MCP call over stdio (PRD Amendment 3, rulings R3/R5, NOTES MCP-1B/MCP-1C). `produce()`
//            (the phase-2 batch `Runner`/replay's own synchronous path) still drives the mocked, sync
//            `RemoteBoundary`; `produceAsync()` (the live `levare serve` path) drives the real,
//            Promise-returning `AsyncRemoteBoundary` when one is supplied — mirroring native's own
//            sync-mock/async-real split (NOTES F8). The real implementation
//            (`createAsyncStdioRemoteBoundary`) spawns the member's granted `kind: mcp` connector's
//            declared stdio server (mcp-client.ts, Phase 1a) through the SAME R4 sandbox wrap a cli
//            member's spawn goes through (ruling R3: identical deny-user-data confinement, plus the
//            connector's own `home:` for any declared exception), invokes exactly the one tool the
//            agent declares, and turns the response into the artifact doc.
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
import { buildMemberEnv, teamOf, subscriptionConnector, scopeHome, scopeHomeForConnector, memberNetworkAllowed, grantedConnectors } from "./env.ts";
import { connectStdioMcpServer, type McpToolCallResult } from "./mcp-client.ts";
import { allowedTools } from "./guardrails.ts";
import { assembleContext, unitArtifactPaths } from "./context.ts";
import {
  asyncSdkTransport,
  bunSdkTransport,
  resolveNativeBinary,
  asSdkTransportResult,
  LEVARE_CLAUDE_CONFIG_DIR,
  type AsyncSdkTransport,
  type SdkTransport,
  type SdkWorkerResponse,
  type WrapWorkerSpawn,
  type FailureClass,
  type FailureClassSource,
} from "./sdk-transport.ts";
import {
  buildDispatchTrace,
  buildDispatchTraceStart,
  writeDispatchTrace,
  buildCliDispatchTrace,
  buildCliDispatchTraceStart,
  writeCliDispatchTrace,
  type CliDispatchTraceIdentityOpts,
  type CliDispatchOutcome,
} from "./dispatch-trace.ts";
import { repoCapabilities } from "./repo.ts";
import { resolveProjectRepoPath, workBranchName, branchExists, createDispatchWorktree, commitDispatchWorktree, type DispatchCommitResult } from "./merge.ts";
import { isSafeHomeDotpath, detectFetchAtDispatchLauncher } from "./validate.ts";
import { detectSandbox, wrapForSandbox, resolveDarwinUserTempDir, type SandboxDetection, type SandboxLevel, type SandboxPolicy, type WrappedSpawn } from "./sandbox.ts";
import { registryStateHash, memberIdentity, resolveGlobalExcludesFile, resolveGlobalAttributesFile } from "./git.ts";
import { isCompiledBuild } from "./version.ts";
import type { Pricing } from "./pricing.ts";
import type { Repo } from "./repo.ts";
import type { MemberRunner } from "./runner.ts";
import type { Agent, Connector, Receipt } from "./types.ts";

// Finding 85: `class` is the ONE place a dispatch failure says who must act — set only at a boundary
// that genuinely knows (the SDK worker's own `error_status`, a studio config check that ran before any
// process spawned), never guessed from this error's own message text later (that shape is Finding
// 118's, disfavored). Absent means member-caused or genuinely unknown — the pre-Finding-85 default:
// Retry stays offered, exactly as before this ruling. See `FailureClass`'s own doc for what each value
// means and `dagwalk.ts#writeBlocked`/`board/gateops.ts#blockedRetryDoc` for where it lands on disk.
export class AdapterError extends Error {
  readonly class?: FailureClass;
  /** Finding 167: sibling to `class` — how it was decided (`FailureClassSource`'s own doc). Absent
   * whenever `class` is (nothing to attribute a source to) and on every non-SDK `AdapterError` site
   * below (a studio-config check that already knows its own class deterministically, never a status
   * or message match — there's no "source" question to answer for those). */
  readonly classSource?: FailureClassSource;
  /** Findings 162/95: the SDK's own receipt for this failed call, when a result message reported one
   * (see `SdkWorkerResponse.receipt`'s own doc for exactly when that is) — carried here so
   * `dagwalk.ts#writeBlocked` can stamp the SAME `usage:` field a successful artifact gets, instead of
   * a failed dispatch's real, priced cost being dropped at this boundary. Absent whenever the SDK
   * response carried none (idle/transport-level failures, and every non-SDK `AdapterError` site). */
  readonly receipt?: Receipt;
  constructor(message: string, opts?: { class?: FailureClass; classSource?: FailureClassSource; receipt?: Receipt }) {
    super(message);
    this.class = opts?.class;
    this.classSource = opts?.classSource;
    this.receipt = opts?.receipt;
  }
}

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
   * Goal "commit-on-produce" (Finding 74): the dispatch worktree's own branch tip SHA at the moment it
   * was checked out, i.e. before this dispatch ran at all (`merge.ts#DispatchWorktree.baseSha`) — what
   * `commitCodeChanges` compares the branch's tip against, after invoking and after its own commit
   * attempt, to decide whether this dispatch's work landed at all (regardless of whether the member
   * self-committed or `commitCodeChanges` had to). Set alongside `dispatchGitWriteGrant`, exactly
   * `projectRepoPath`'s own no-worktree case when absent.
   */
  dispatchWorktreeBaseSha?: string;
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
  /**
   * NOTES DISPATCH-TRACE: set by `AdapterRunner#withHomeScope`/`withHomeScopeAsync` — whether
   * `env.ts#scopeHome` actually swapped in a scratch HOME for this dispatch (`true`) or left `env.HOME`
   * as the real, unscoped operator directory because the member holds no `home:`-declaring connector
   * (`false`, the common case). A boolean fact about which code path ran, never the literal directory —
   * read by `createSdkNativeBoundary`/`createAsyncSdkNativeBoundary` to record "was HOME scoped" on a
   * dispatch trace without the trace ever carrying a real filesystem path.
   */
  homeScoped?: boolean;
}

/** The native SDK boundary — synchronous, used by the phase-2 batch `Runner` (`levare replay`) and by
 * `stubAdapterRunner`. `receipt`, when present, is the SDK's OWN reported usage (§10, NOTES F8) — a
 * model cannot know its real token counts/cost, so this must never be re-derived by parsing the
 * returned doc's frontmatter; see `AdapterRunner#finalize`. */
export interface NativeBoundary {
  invoke(req: InvokeRequest): { doc: string; receipt?: Receipt; sandbox?: SandboxLevel };
}

/** The non-blocking counterpart to `NativeBoundary` (NOTES F8) — same shape, Promise-returning,
 * mirroring `CliSpawn`/`AsyncCliSpawn`'s split. What `productionAdapterRunner`'s live `produceAsync`
 * path actually drives, so a real native SDK call never blocks `levare serve`'s event loop. */
export interface AsyncNativeBoundary {
  invoke(req: InvokeRequest): Promise<{ doc: string; receipt?: Receipt; sandbox?: SandboxLevel }>;
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
 * process) never forces a fake synchronous facade over it. NOTES MCP-1C: `sandbox`, when the boundary
 * actually wrapped its spawn (the real, un-injected `connectStdioMcpServer`, never a test double — see
 * `createAsyncStdioRemoteBoundary`'s own `real` guard, mirroring `runCli`/`runCliAsync`'s identical
 * cli-only convention), is the enforcement level that dispatch's server process actually ran under —
 * recorded on the produced artifact by `AdapterRunner#author`, exactly like a `kind: cli` member's own
 * `sandbox:` line. */
export interface AsyncRemoteBoundary {
  call(req: InvokeRequest): Promise<{ doc: string; sandbox?: SandboxLevel }>;
}

export interface SdkNativeBoundaryOptions {
  transport?: SdkTransport;
  env?: Record<string, string | undefined>;
  /** Test-only override, taking precedence over the dispatched agent's own `timeout:` — mirrors
   * `StdioRemoteBoundaryOptions.timeoutMs`'s identical role for the remote boundary. Production never
   * sets this; a real dispatch's bound comes from `req.agent.timeout` (Finding 81), defaulting to
   * `DEFAULT_NATIVE_TIMEOUT_S` when the agent declares none. */
  timeoutMs?: number;
  /** Test-only override for the idle bound (Finding 124) — mirrors `timeoutMs`'s identical role/
   * precedence. Production never sets this; a real dispatch's idle bound is always
   * `resolveNativeIdleTimeoutMs()`'s flat default (never derived from the dispatched agent, unlike
   * `timeoutMs`/`agent.timeout` — the ruling is explicit that this bound is flat, not per-agent). */
  idleTimeoutMs?: number;
  /** Test-only override for the resolved native-binary path — see `resolveNativeBinary` default below. */
  pathToClaudeCodeExecutable?: string;
  /** NOTES DISPATCH-TRACE: the studio root a dispatch trace is written under (`<studioRoot>/.levare/
   * dispatch-logs/`) — absent (the default for every test double, and for `stubAdapterRunner`, which
   * never constructs this boundary at all) means no trace is written; `productionAdapterRunner`
   * (replay.ts) passes `repo.root` on every real construction, so a live `levare serve` dispatch always
   * gets one. */
  studioRoot?: string;
  /**
   * Finding 75 (part 2): the repo this native dispatch's sandbox policy is built against
   * (`buildNativeSandboxPolicy`) — absent (every test double in this codebase, mirroring `studioRoot`'s
   * own "no repo, no trace" convention above) means the worker's own OS-level spawn is never wrapped at
   * all, exactly the pre-this-unit behaviour; `productionAdapterRunner` (replay.ts) always supplies it,
   * mirroring `createAsyncStdioRemoteBoundary(repo, opts)`'s own required-positional `repo` — kept
   * optional here instead (rather than a second required param) so every existing mocked-transport test
   * construction in this codebase keeps compiling unchanged.
   */
  repo?: Repo;
  /** Test-only override of OS sandbox primitive detection (mirrors `StdioRemoteBoundaryOptions.
   * sandboxDetection`) — production never sets this; a fresh, real `detectSandbox()` runs per dispatch. */
  sandboxDetection?: SandboxDetection;
  /** Test-only: threaded into `resolveNativeBinary` when `pathToClaudeCodeExecutable` above is unset —
   * mirrors `SdkOrchestratorBoundaryOptions.binaryResolution` (orchestrator-boundary.ts). Lets a test
   * force resolution to genuinely fail (an unresolvable platform/arch) rather than picking up whatever
   * real binary happens to be installed in this dev/test environment's own node_modules — the only way
   * to exercise "the parent has no path of its own" (Finding 112's compiled-build shape) without
   * actually running under a compiled build. */
  binaryResolution?: { platform?: string; arch?: string; requireFrom?: string };
}

export interface AsyncSdkNativeBoundaryOptions {
  transport?: AsyncSdkTransport;
  env?: Record<string, string | undefined>;
  /** See `SdkNativeBoundaryOptions.timeoutMs` — identical role, async boundary. */
  timeoutMs?: number;
  /** See `SdkNativeBoundaryOptions.idleTimeoutMs` — identical role, async boundary. */
  idleTimeoutMs?: number;
  /** Test-only override for the resolved native-binary path — see `resolveNativeBinary` default below. */
  pathToClaudeCodeExecutable?: string;
  /** See `SdkNativeBoundaryOptions.studioRoot` — identical role, async boundary. */
  studioRoot?: string;
  /** See `SdkNativeBoundaryOptions.repo` — identical role, async boundary. */
  repo?: Repo;
  /** See `SdkNativeBoundaryOptions.binaryResolution` — identical role, async boundary. */
  binaryResolution?: { platform?: string; arch?: string; requireFrom?: string };
  /** See `SdkNativeBoundaryOptions.sandboxDetection` — identical role, async boundary. */
  sandboxDetection?: SandboxDetection;
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
//
// Finding 120: the redirect above degrades `.gitconfig` cleanly, but it's not the ONLY thing a "full"
// sandbox denies read access to — the operator's global excludes file (explicit `core.excludesFile`, or
// git's own default `$HOME/.config/git/ignore`) lives under the SAME denied real HOME, and unlike
// `.gitconfig`, a denied excludesFile is NOT fatal: git just warns to stderr and silently proceeds as if
// no excludes file exists at all (confirmed directly against this host's own git — a "full"-tier deny
// degrades a read failure there to a no-op, not an error, so this has no crash to make it visible). A
// member's own `git add`/`git status` inside the sandbox would stage exactly what the operator's global
// ignore rules say never to track. Fixed the same way FIX-9 fixes `.gitconfig` visibility without
// reopening HOME: resolve the real path here, in THIS unsandboxed parent process (before the sandbox
// denial ever applies), and hand it back into the spawn as `GIT_CONFIG_COUNT`/`_KEY_0`/`_VALUE_0` — the
// environment-variable equivalent of a `-c core.excludesFile=` override, since a member's own git
// invocations inside the sandbox are never levare's own command line to add `-c` flags to. The sandbox
// policy itself (`buildDispatchSandboxPolicy`) grants read access to this SAME resolved path — narrowly,
// never the whole operator HOME — so the value this points at is actually reachable, not just named.
//
// Finding 144: `core.attributesFile` lives under the same denied real HOME and degrades the same way
// (a denied read is a tolerated no-op for git, not fatal — same as excludesFile, unlike `.gitconfig`
// itself) — a member's own `git add` inside the sandbox would silently skip whatever clean filter or
// eol rule the operator's global attributes configure. Threaded through the SAME `GIT_CONFIG_COUNT`
// mechanism as a second override, since both keys need identical env-var-equivalent treatment here.
function gitConfigRedirectEnv(env: Record<string, string>): Record<string, string> {
  const base = { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  const overrides: Array<[string, string]> = [];
  const excludesFile = resolveGlobalExcludesFile(env);
  if (excludesFile) overrides.push(["core.excludesFile", excludesFile]);
  const attributesFile = resolveGlobalAttributesFile(env);
  if (attributesFile) overrides.push(["core.attributesFile", attributesFile]);
  if (overrides.length === 0) return base;
  const countEnv: Record<string, string> = { GIT_CONFIG_COUNT: String(overrides.length) };
  overrides.forEach(([key, value], i) => {
    countEnv[`GIT_CONFIG_KEY_${i}`] = key;
    countEnv[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return { ...base, ...countEnv };
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

function nativeWorkerRequest(req: InvokeRequest, pathToClaudeCodeExecutable: string | undefined, idleTimeoutMs: number) {
  // Tool allowlist (security-audit Surface 3/8's now-closed K5 pre-arm): `req.tools` is
  // `guardrails.ts#allowedTools(agent)` — exactly the agent's declared `tools:`, `[]` when it
  // declares none. Passed as BOTH `tools` and `allowedTools` so an agent declaring no tools reaches
  // the SDK with an empty allowlist, never an implicit/full one.
  const cwd = resolveFeatureRepo(req.agent.cwd, req.projectRepoPath);
  return { prompt: req.context, model: req.agent.model, tools: req.tools, allowedTools: req.tools, cwd, pathToClaudeCodeExecutable, idleTimeoutMs };
}

// Finding 81: the native member dispatch default, in seconds — used by both createSdkNativeBoundary
// and createAsyncSdkNativeBoundary when the dispatched agent declares no `timeout:` of its own. Raised
// from the prior 600s: five real dispatches were measured against that bound (four killed, one success
// at 554,108ms — a 46-second margin), so a flat 600s killed more real native dispatches than it
// permitted. 1200s is not a principled number — it is that one real measurement, doubled — chosen over
// leaving the default alone and requiring per-agent config because every new studio would otherwise
// inherit a bound already shown to kill most real native work. Deliberately does NOT touch `cli`'s or
// `remote`'s own 600s defaults (adapters.ts#cliInvocation, #createAsyncStdioRemoteBoundary) — the
// evidence and the ruling are both scoped to native dispatch alone.
const DEFAULT_NATIVE_TIMEOUT_S = 1200;

// The cli/remote dispatch default, in seconds — unchanged by Finding 81 (the evidence and the ruling
// are both scoped to native dispatch alone; see DEFAULT_NATIVE_TIMEOUT_S's own doc above).
const DEFAULT_CLI_REMOTE_TIMEOUT_S = 600;

/** The bound a real dispatch of `agent` will actually run under, in seconds — `agent.timeout` when
 * declared, else the kind-appropriate default. The one place this resolution rule lives, so the board
 * (Finding 81 part 3: showing the bound beside a dispatch's elapsed time) can display the exact same
 * number a real dispatch would enforce, never a second, independently-maintained copy of the rule. */
export function resolveMemberTimeoutS(agent: Agent): number {
  return agent.timeout ?? (agent.kind === "native" ? DEFAULT_NATIVE_TIMEOUT_S : DEFAULT_CLI_REMOTE_TIMEOUT_S);
}

// Finding 124: the native-dispatch idle bound, in seconds — no message-stream activity at all for this
// long aborts the dispatch (sdk-worker.ts#consumeQuery), reported as `outcome: "idle"`, distinct from
// `DEFAULT_NATIVE_TIMEOUT_S` (the outer wall-clock backstop, left untouched by this unit). Flat across
// every native agent — Finding 123's own trace table showed the axis that actually predicted a timeout
// was ROLE (`code-builder`, every time), not a size/kind property a per-agent or per-role number could
// track any better than a single flat bound already does.
//
// Honestly NOT measured against real inter-message gaps: `DispatchTraceRecord` (dispatch-trace.ts)
// timestamps a dispatch's start and end, and `sdk-worker.ts`'s own stderr logs an elapsed-ms figure on
// every `api_retry` and on its own final exit line, but no existing trace records a timestamp on each
// individual streamed message — the one figure this bound most wants ("how long does a healthy
// dispatch typically go between messages") was never captured by anything that ran before this unit,
// and this sandbox holds no real `.levare/dispatch-logs/` history to mine regardless. 300s (5 minutes)
// is chosen by the same reasoning `DEFAULT_NATIVE_TIMEOUT_S` itself was widened by by (Finding 81) — a
// deliberately generous number, erring toward never killing real work — rather than a number derived
// from a measurement this unit does not have: comfortably longer than a single slow tool call most
// members plausibly issue (a package install, a test run, a web fetch), while still meaningfully
// shorter than the 1200s backstop, so a dispatch that goes fully silent (the failing-tool-call loop
// Finding 124's own ruling names, which streams nothing between attempts) is caught in a quarter of the
// time rather than riding out the full backstop. The next unit that touches this constant should have
// real numbers to work from: `sdk-worker.ts`'s per-iteration idle race already knows the actual gap
// between messages the instant it happens (see `raceIdle`) — the missing piece is only that a
// genuinely idle-triggered dispatch's `worker_stderr` now says so explicitly (`formatIdleFailureError`),
// which is itself the first real data point this bound has ever had.
const DEFAULT_NATIVE_IDLE_TIMEOUT_S = 300;

/** The idle bound (Finding 124) a real native dispatch of `agent` will actually run under, in
 * milliseconds — always `DEFAULT_NATIVE_IDLE_TIMEOUT_S`, since the ruling is explicit that this is
 * flat, never a per-agent or per-kind override the way `resolveMemberTimeoutS` is. A free function
 * (rather than inlined at both call sites) so `createSdkNativeBoundary`/`createAsyncSdkNativeBoundary`
 * can't drift out of sync on what "the idle bound" means, mirroring `resolveMemberTimeoutS`'s own
 * "one place this resolution rule lives" reasoning. */
function resolveNativeIdleTimeoutMs(): number {
  return DEFAULT_NATIVE_IDLE_TIMEOUT_S * 1000;
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
  // Resolved ONCE, explicitly — never left to the SDK's own implicit resolution inside the worker
  // (NOTES phase-7 K14: a live host showed that implicit lookup fail to find a platform binary that
  // genuinely existed as a sibling node_modules package).
  const br = opts.binaryResolution;
  const pathToClaudeCodeExecutable = opts.pathToClaudeCodeExecutable ?? resolveNativeBinary(br?.platform, br?.arch, br?.requireFrom) ?? undefined;
  return {
    invoke(req: InvokeRequest): { doc: string; receipt?: Receipt; sandbox?: SandboxLevel } {
      // Finding 81: reads the dispatched agent's own `timeout:` per-call — a boundary is constructed
      // once for the whole server lifetime, so this can never be resolved at construction time the way
      // `pathToClaudeCodeExecutable` above is. Mirrors `createAsyncStdioRemoteBoundary`'s identical
      // precedence (StdioRemoteBoundaryOptions.timeoutMs's own doc): a test-only opts override beats
      // the agent's declared value, which beats the default.
      const timeoutMs = opts.timeoutMs ?? resolveMemberTimeoutS(req.agent) * 1000;
      // Finding 124: same test-only-override-beats-default precedence as `timeoutMs` above, but never
      // reads `req.agent` — the idle bound is flat, not per-agent (see `resolveNativeIdleTimeoutMs`).
      const idleTimeoutMs = opts.idleTimeoutMs ?? resolveNativeIdleTimeoutMs();
      const env = nativeSpawnEnv(req, baseEnv);
      let sandboxLevel: SandboxLevel | undefined;
      const wrapWorkerSpawn = nativeWrapWorkerSpawn(opts.repo, req, pathToClaudeCodeExecutable, baseEnv, opts.sandboxDetection, (l) => (sandboxLevel = l));
      const runOnce = (): SdkWorkerResponse => {
        const startedAt = new Date().toISOString();
        const traceCtx = { startedAt, timeoutMs, baseEnv, pathToClaudeCodeExecutable };
        traceNativeDispatchStart(opts.studioRoot, req, traceCtx);
        const res = transport.run(nativeWorkerRequest(req, pathToClaudeCodeExecutable, idleTimeoutMs), { env, timeoutMs, wrapWorkerSpawn });
        traceNativeDispatchFinish(opts.studioRoot, req, res, traceCtx);
        return res;
      };
      let res = runOnce();
      // Finding 85: `transient` is the one class levare acts on rather than asking — the SDK's own
      // retry policy (inside the worker's own `query()` call, sdk-worker.ts) already exhausted itself
      // on a rate-limit/5xx/connection-error shape before this ever returned. This is a SECOND, coarser
      // retry at the dispatch level — a fresh worker process, once — before a Conductor ever sees a
      // gate. Capped at exactly one extra attempt (never a loop): Finding 92 was seven retries
      // compounding into a misleading 45s timeout, and this must not recreate that shape one level up.
      if (!res.ok && res.errorClass === "transient") {
        console.error(`levare: native member '${req.member}' sdk call failed transiently, retrying once before gating (Finding 85): ${res.error}`);
        res = runOnce();
      }
      if (!res.ok) throw new AdapterError(`native member '${req.member}' sdk call failed: ${res.error}`, { class: res.errorClass, classSource: res.errorClassSource, receipt: res.receipt });
      return { doc: res.result, receipt: res.receipt, sandbox: sandboxLevel };
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
  const br = opts.binaryResolution;
  const pathToClaudeCodeExecutable = opts.pathToClaudeCodeExecutable ?? resolveNativeBinary(br?.platform, br?.arch, br?.requireFrom) ?? undefined;
  return {
    async invoke(req: InvokeRequest): Promise<{ doc: string; receipt?: Receipt; sandbox?: SandboxLevel }> {
      // Finding 81: see createSdkNativeBoundary's identical comment above — same per-call resolution,
      // same precedence, async boundary.
      const timeoutMs = opts.timeoutMs ?? resolveMemberTimeoutS(req.agent) * 1000;
      // Finding 124: see createSdkNativeBoundary's identical comment above — same flat idle bound,
      // async boundary.
      const idleTimeoutMs = opts.idleTimeoutMs ?? resolveNativeIdleTimeoutMs();
      const env = nativeSpawnEnv(req, baseEnv);
      let sandboxLevel: SandboxLevel | undefined;
      const wrapWorkerSpawn = nativeWrapWorkerSpawn(opts.repo, req, pathToClaudeCodeExecutable, baseEnv, opts.sandboxDetection, (l) => (sandboxLevel = l));
      const runOnce = async (): Promise<SdkWorkerResponse> => {
        const startedAt = new Date().toISOString();
        const traceCtx = { startedAt, timeoutMs, baseEnv, pathToClaudeCodeExecutable };
        traceNativeDispatchStart(opts.studioRoot, req, traceCtx);
        const res = await transport.run(nativeWorkerRequest(req, pathToClaudeCodeExecutable, idleTimeoutMs), { env, timeoutMs, wrapWorkerSpawn });
        traceNativeDispatchFinish(opts.studioRoot, req, res, traceCtx);
        return res;
      };
      let res = await runOnce();
      // Finding 85: see createSdkNativeBoundary's identical comment above — same one-extra-attempt cap,
      // async boundary.
      if (!res.ok && res.errorClass === "transient") {
        console.error(`levare: native member '${req.member}' sdk call failed transiently, retrying once before gating (Finding 85): ${res.error}`);
        res = await runOnce();
      }
      if (!res.ok) throw new AdapterError(`native member '${req.member}' sdk call failed: ${res.error}`, { class: res.errorClass, classSource: res.errorClassSource, receipt: res.receipt });
      return { doc: res.result, receipt: res.receipt, sandbox: sandboxLevel };
    },
  };
}

type NativeDispatchTraceCtx = { startedAt: string; timeoutMs: number; baseEnv: Record<string, string | undefined>; pathToClaudeCodeExecutable: string | undefined };

// Finding 112: `true` only when THIS process resolved the binary itself — the source-build case,
// resolved once at boundary-construction time, so it's real, known knowledge even before a dispatch
// starts. On a compiled build this is always `undefined` here (never a stand-in `false`): resolution
// happens inside the worker's own self-invocation, invisible to this process — see
// `nativeDispatchFinishNativeBinaryResolved` below for where the worker's own report supersedes this
// once the dispatch has actually run.
function nativeDispatchTraceIdentityOpts(req: InvokeRequest, ctx: NativeDispatchTraceCtx, nativeBinaryResolved: boolean | undefined) {
  return {
    homeScoped: req.homeScoped ?? false,
    anthropicApiKeyPresent: typeof ctx.baseEnv.ANTHROPIC_API_KEY === "string",
    nativeBinaryResolved,
    startedAt: ctx.startedAt,
    timeoutMs: ctx.timeoutMs,
  };
}

// Finding 112: the worker (`sdk-worker.ts`) is the only place that ever knows the true answer on a
// compiled build, and reports it back on `res.nativeBinaryResolved` whenever it ran far enough to
// answer — success, a non-success result, or a thrown error alike. Only when a TRANSPORT-level failure
// kept the worker's own `respond()` from ever running (script not found, timed out, non-JSON output)
// does this fall back to the parent's own pre-spawn knowledge, which is only ever a real answer for a
// source build (`pathToClaudeCodeExecutable !== undefined`) — a compiled build with no worker report
// stays `undefined`, honestly unknown, never a fabricated `false`.
function nativeDispatchFinishNativeBinaryResolved(res: SdkWorkerResponse, ctx: NativeDispatchTraceCtx): boolean | undefined {
  return res.nativeBinaryResolved ?? (ctx.pathToClaudeCodeExecutable !== undefined ? true : undefined);
}

// NOTES DISPATCH-TRACE / Finding 113: written BEFORE the spawn, with everything already known at that
// point — inputs, env var names, HOME scoping, pid, timestamp, timeout bound — so a Conductor reading
// `.levare/dispatch-logs/` mid-dispatch sees something instead of nothing for the dispatch's entire
// duration (the exact gap Finding 113 observed: a ten-minute believed-hung dispatch left the directory
// empty the whole time it ran). `traceNativeDispatchFinish` amends this SAME file in place once the
// dispatch completes — shares `ctx` (in particular `ctx.startedAt`, which both the start and finish
// records carry unchanged) with its caller specifically so the two writes land on the identical
// filename (`traceFileName` is keyed on `started_at`, not wall-clock-at-write-time). A no-op when
// `studioRoot` was never supplied (every test double, and `stubAdapterRunner`, which never constructs
// this boundary at all).
function traceNativeDispatchStart(studioRoot: string | undefined, req: InvokeRequest, ctx: NativeDispatchTraceCtx): void {
  if (!studioRoot) return;
  const nativeBinaryResolved = ctx.pathToClaudeCodeExecutable !== undefined ? true : undefined;
  const record = buildDispatchTraceStart(req, nativeDispatchTraceIdentityOpts(req, ctx, nativeBinaryResolved));
  writeDispatchTrace(studioRoot, record);
}

// NOTES DISPATCH-TRACE: shared by both the sync and async native boundary — amends the start trace
// (`traceNativeDispatchStart`, same file, same `ctx.startedAt`) with everything only knowable once the
// dispatch finished — output, duration, outcome — success or failure alike, so a Conductor debugging a
// live studio has a consistent record either way. A no-op when `studioRoot` was never supplied.
function traceNativeDispatchFinish(studioRoot: string | undefined, req: InvokeRequest, res: SdkWorkerResponse, ctx: NativeDispatchTraceCtx): void {
  if (!studioRoot) return;
  // Captured here, at the call site closest to the transport call actually resolving (both
  // `createSdkNativeBoundary`/`createAsyncSdkNativeBoundary` call this immediately after `transport.run`
  // returns) — the same "real wall clock, not arithmetic" discipline `startedAt` already uses.
  const endedAt = new Date().toISOString();
  const wide = asSdkTransportResult(res);
  const record = buildDispatchTrace(
    req,
    {
      ok: res.ok,
      error: res.ok ? undefined : res.error,
      timedOut: wide.timedOut,
      // Finding 124: `idle` only ever comes from the WORKER's own report (`res.idle`) — the transport's
      // wall-clock kill (`wide.timedOut`) never populates it, so the two can never both be true; see
      // `buildDispatchTrace`'s own `timedOut` precedence for why that ordering matters.
      idle: !res.ok && res.idle === true,
      durationMs: wide.durationMs,
      endedAt,
      stdout: wide.stdout,
      stderr: wide.stderr,
      // Findings 162/95: unconditional — `res.receipt` is already `undefined` whenever the SDK
      // genuinely reported nothing (idle/transport-level failures); gating it on `res.ok` here dropped
      // a real, priced cost on an error-result failure (error_max_turns etc.), matching the ORCHESTRATOR
      // trace's own `buildOrchestratorTrace` (dispatch-trace.ts), which never had this gate.
      receipt: res.receipt,
    },
    nativeDispatchTraceIdentityOpts(req, ctx, nativeDispatchFinishNativeBinaryResolved(res, ctx)),
  );
  writeDispatchTrace(studioRoot, record);
}

export interface StdioRemoteBoundaryOptions {
  /** Test-only override for the mcp session constructor — default the real `connectStdioMcpServer`
   * (mcp-client.ts). Lets a test drive this boundary against a deterministic fake stdio server without
   * spawning a real third-party MCP install. */
  connect?: typeof connectStdioMcpServer;
  /** Test-only override for the connect/request timeout ceiling — default derives from the agent's own
   * `timeout:` (falls back to the same 600s default `defaultCliCommand`'s cli timeout uses). */
  timeoutMs?: number;
  /** NOTES MCP-1C (parity with `AdapterRunnerOptions.sandboxDetection`): test-only override of the OS
   * sandbox primitive detection — default a real, freshly-probed `detectSandbox()` on every real
   * dispatch (never cached, never assumed — see sandbox.ts's own header). Production call sites never
   * set this. Exists so a test can drive the remote boundary through a WORKING (if fake) wrap — e.g. the
   * bwrap-shaped `fakeWorkingPrimitive()` helper `tests/adapters.test.ts`'s own cli tests already use —
   * without depending on this host's REAL bubblewrap/sandbox-exec actually functioning, proving the
   * wrap/debug-instrumentation plumbing itself is correct independent of whether a live OS primitive
   * happens to work here. */
  sandboxDetection?: SandboxDetection;
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

// NOTES MCP-1C: the SAME `LEVARE_SANDBOX_DEBUG=1` gate `AdapterRunner.logSpawnDebug`/`logWorktreeDebug`
// already use — a free-standing function (not a class method) since this boundary isn't one, but the
// wording/gate stays identical so a Conductor grepping debug output for one prefix sees every sandboxed
// spawn this codebase makes, cli or remote alike.
function logRemoteSandboxDebug(line: string): void {
  if (process.env.LEVARE_SANDBOX_DEBUG !== "1") return;
  console.error(`[levare:sandbox-debug] ${line}`);
}

/**
 * NOTES MCP-1B/MCP-1C (PRD Amendment 3, rulings R2/R3/R4/R5) — the real stdio MCP backing for
 * `AsyncRemoteBoundary`: resolves the member's declared `server:` to a granted `kind: mcp` connector,
 * spawns its declared stdio command (mcp-client.ts's `connectStdioMcpServer`, Phase 1a's own client)
 * through the SAME R4 sandbox wrap a `kind: cli` member's spawn goes through, invokes exactly the one
 * tool the agent declares (`agent.tool`) with arguments built from `agent.params`'s `{task}`-substituted
 * template (ruling R2: one dispatch, one call, one artifact — never an interactive multi-call session),
 * and turns the tool's own text content into the artifact `doc`. Auth is ruling R4, unchanged: `req.env`
 * is already `buildMemberEnv`'s allowlisted output (the member's granted connectors' env vars, computed
 * at `AdapterRunner#prepare` before this boundary ever runs).
 *
 * NOTES MCP-1C — the sandbox wrap itself (ruling R3, the Conductor's own confinement-fork ruling: an
 * MCP server gets the IDENTICAL confinement a `cli` member gets, plus the connector's own `home:` for
 * any declared exception — never a second, looser profile). Mirrors `AdapterRunner#runCli`/`runCliAsync`
 * closely enough to read side by side:
 *   - `real` (only the un-injected, default `connectStdioMcpServer` — never a test-injected `opts.connect`
 *     double, mirroring `preflightCli`'s `this.spawn === bunSpawn` guard exactly: a double is a stand-in
 *     for arbitrary behaviour, never a real OS process, so wrapping its argv would assert something about
 *     bwrap/sandbox-exec rather than about this boundary's own logic).
 *   - a fresh, per-dispatch scratch working directory (mirrors a cli dispatch's own worktree/vendor-
 *     scratch lifecycle: created immediately before the spawn, removed in `finally`) — an MCP tools/call
 *     has no cwd of its own (unlike a cli member's `agent.cwd`/`{feature_repo}`), so this IS the "scratch
 *     working area" the ruling names, independent of whether an OS primitive actually confines it.
 *   - `scopeHomeForConnector(connector, req.env)` — the SAME `home:` mechanism `env.ts#scopeHome` already
 *     gives a subscription cli connector, generalized to ANY granted `kind: mcp` connector (Connector.home's
 *     own doc, types.ts): a per-run scratch HOME symlinking only the connector's declared dotpaths when it
 *     declares any, the real unscoped HOME otherwise.
 *   - `buildRemoteSandboxPolicy`/`wrapForSandbox` — the SAME generator `sandbox.ts` already ships (no
 *     second profile invented): filesystem confined to the scratch cwd + scoped HOME + the studio root
 *     read-only, network best-effort (granted here unconditionally, since a remote dispatch always holds
 *     at least its own `server:` connector — `memberNetworkAllowed` reads that identically for cli/remote).
 * The enforcement level actually used (`wrapped.level`) is returned alongside `doc` so `AdapterRunner#author`
 * can record it on the artifact — see `AsyncRemoteBoundary.call`'s own doc.
 */
export function createAsyncStdioRemoteBoundary(repo: Repo, opts: StdioRemoteBoundaryOptions = {}): AsyncRemoteBoundary {
  const connect = opts.connect ?? connectStdioMcpServer;
  return {
    async call(req: InvokeRequest): Promise<{ doc: string; sandbox?: SandboxLevel }> {
      const agent = req.agent;
      const serverName = agent.server;
      // Finding 85: every check below is a studio-authoring mistake, not the member's or a vendor
      // call's — nothing here ever runs the connector, so `class: "operator"` throughout: no retry can
      // fix a config problem, and the Conductor is who edits team/agent/connector definitions.
      if (!serverName) throw new AdapterError(`remote member '${req.member}' declares no 'server'`, { class: "operator" });
      const connector = repo.connectors.get(serverName);
      if (!connector) throw new AdapterError(`remote member '${req.member}' declares server '${serverName}', which is not a known connector`, { class: "operator" });
      if (connector.kind !== "mcp") {
        throw new AdapterError(`remote member '${req.member}' declares server '${serverName}', which is kind: '${connector.kind}', not kind: mcp`, { class: "operator" });
      }
      if (!grantedConnectors(repo, req.member).some((c) => c.name === connector.name)) {
        throw new AdapterError(`remote member '${req.member}' is not granted connector '${serverName}' (agent/team 'connectors:')`, { class: "operator" });
      }
      if (!connector.argv || connector.argv.length === 0) {
        throw new AdapterError(
          `remote member '${req.member}''s connector '${serverName}' declares no stdio 'argv' — only a real, granted, stdio kind: mcp connector is implemented (PRD Amendment 3 ruling R1); HTTP/SSE MCP servers remain deferred`,
          { class: "operator" },
        );
      }
      const tool = agent.tool;
      if (!tool) throw new AdapterError(`remote member '${req.member}' declares no 'tool'`, { class: "operator" });
      const args = buildMcpToolArguments(agent.params, req.context);
      const timeoutMs = opts.timeoutMs ?? resolveMemberTimeoutS(agent) * 1000;

      // NOTES MCP-1C: only the REAL boundary (default `connect`) ever sandboxes — see this function's
      // own doc for why a test-injected `opts.connect` double must never be wrapped.
      const real = connect === connectStdioMcpServer;
      const scratchDir = real ? mkdtempSync(pathJoin(tmpdir(), "levare-mcp-dispatch-")) : undefined;
      const scopedHome = real ? scopeHomeForConnector(connector, req.env) : undefined;
      const spawnEnv = scopedHome?.env ?? req.env;
      let wrapped: { argv: string[]; level?: SandboxLevel; cleanup?: () => void } = { argv: connector.argv };
      if (real && scratchDir) {
        // NOTES MCP-1C (a reported live-macOS hang in exactly this path — see NOTES MCP-1C's own
        // addendum): `detection` is test-injectable so a container without a working primitive can still
        // drive this code path through a fake-but-functioning one (see `StdioRemoteBoundaryOptions.
        // sandboxDetection`'s own doc) — production never sets it, so this is always the real, fresh,
        // un-cached probe there, exactly like `AdapterRunner#sandboxWrap`'s own identical line.
        const detection = opts.sandboxDetection ?? detectSandbox();
        logRemoteSandboxDebug(`level: ${detection.level} (primitive: ${detection.primitive})`);
        // NOTES MCP-1C addendum 6: the Conductor's ruling on the bunx/npx e2e hang (item #4) — a
        // fetch-at-dispatch connector (npx -y, bunx, pnpm dlx, yarn dlx over a bare package spec) cannot
        // be confined by a working sandbox primitive at all: its real code lands in an npm/npx/bun cache
        // under the operator's own HOME, a location argvScriptReadOnlyPaths never grants (only a
        // resolved, existing local file path in argv is). Left alone, the spawned interpreter blocks on
        // that denied read and hangs rather than exiting — the same class of finding addendum 3 already
        // found one layer down, for a local script instead of a cache dir. Refused HERE, before ever
        // reaching `wrapForSandbox`/`connect`, so this is a fast, named error instead of a 60s stall —
        // validate.ts#detectFetchAtDispatchLauncher is the SAME detection validate.ts already warns with
        // at validate time (a legal-but-unsupported-under-sandbox declaration); this is where that
        // warning becomes an actual constraint, exactly when a working primitive is present to enforce
        // it. A host with no working primitive (`detection.level === "none"`) is unaffected — the
        // fetch-at-dispatch server runs exactly as it always has, unconfined.
        if (detection.level !== "none") {
          const launcher = detectFetchAtDispatchLauncher(connector.argv);
          if (launcher) {
            scopedHome?.cleanup();
            rmSync(scratchDir, { recursive: true, force: true });
            const invocation = launcher.subcommand ? `${launcher.runner} ${launcher.subcommand}` : launcher.runner;
            // Finding 85: a connector authoring choice the sandbox refuses to run at all — the operator
            // fixes the connector's argv, never a retry.
            throw new AdapterError(
              `remote member '${req.member}''s connector '${serverName}' spawns its server via '${invocation}', a fetch-and-run package launcher — refused under this host's working sandbox primitive (${detection.primitive}), rather than left to hang (NOTES MCP-1C addendum 6). A fetch-at-dispatch server's real code lands in an npm/npx/bun cache under the operator's own HOME, which the sandbox denies and no connector argv references. Install the server locally and reference its resolved script/binary path directly in this connector's argv instead — see docs/guide/04-workflow/05-foreign-agent.md.`,
              { class: "operator" },
            );
          }
        }
        const policy = buildRemoteSandboxPolicy(repo, req, connector, scratchDir, spawnEnv);
        // `wrapForSandbox` itself prints (under the SAME LEVARE_SANDBOX_DEBUG=1 gate) the composed
        // argv/cwd/home for every tier, and — for `sandbox-exec` specifically — the darwin profile's own
        // text and the temp file it was written to (sandbox.ts#sandboxExecArgv), BEFORE this call
        // returns, i.e. strictly before `connect()` below is ever reached. This is the exact "print the
        // profile a hung process is dying under" instrumentation a live macOS hang needs — reused
        // verbatim from the identical machinery a `cli` dispatch's own wrap already relies on, never a
        // second, remote-specific implementation of the same printing.
        wrapped = wrapForSandbox(connector.argv, policy, detection);
        logRemoteSandboxDebug(
          `remote dispatch for '${req.member}' via connector '${serverName}': scratch cwd '${scratchDir}', home ${scopedHome?.skipped.length ? `scoped (skipped: ${scopedHome.skipped.join(", ")})` : connector.home?.length ? "scoped" : "unscoped (connector declares no home:)"}, sandbox level '${wrapped.level}'`,
        );
      }

      // NOTES MCP-1C: the explicit "about to spawn" marker — deliberately the LAST debug line before the
      // one call that can actually hang, so a Conductor reading a stalled run's own stderr can tell
      // apart "setup (detection/policy/wrap) never finished" from "setup finished; the spawn itself, or
      // the handshake immediately after it, is what's stuck" — the latter being exactly what a genuine
      // kernel-level denial during a real MCP server's own startup would look like (a blocked process
      // waiting on a denied resource, never exiting, rather than crashing outright — the R4-VENDOR-CLI
      // config-EPERM class manifesting as a hang instead of a fatal exit for a well-behaved server that
      // retries/waits rather than aborting).
      logRemoteSandboxDebug(`spawning now: argv=${JSON.stringify(wrapped.argv)} cwd=${scratchDir ?? "(inherited)"}`);

      let session: Awaited<ReturnType<typeof connect>>;
      try {
        session = await connect({ argv: wrapped.argv, cwd: scratchDir, env: spawnEnv }, { timeoutMs });
      } catch (e) {
        wrapped.cleanup?.();
        scopedHome?.cleanup();
        if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
        throw e;
      }
      try {
        const result = await session.callTool(tool, args);
        if (result.isError) {
          throw new AdapterError(`remote member '${req.member}' tool '${tool}' on connector '${serverName}' reported isError: ${extractMcpText(result) || "(no content)"}`);
        }
        const text = extractMcpText(result);
        if (!text) throw new AdapterError(`remote member '${req.member}' tool '${tool}' on connector '${serverName}' returned no text content`);
        return { doc: text, sandbox: wrapped.level };
      } finally {
        await session.close();
        wrapped.cleanup?.();
        scopedHome?.cleanup();
        if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
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
  /**
   * Finding 132: the spawned CLI's own pid. Cheaply available the instant `Bun.spawnSync`/`Bun.spawn`
   * returns a subprocess handle — unlike a native dispatch's worker pid (never captured anywhere in this
   * codebase; see `dispatch-trace.ts#DispatchTraceRecord.pid`'s own doc for why), a cli spawn is a single,
   * direct child this process owns start to finish. Optional, mirroring `stderr?`/`signalCode?`'s own
   * "predates this field" allowance for a test-double `CliSpawn`; always populated by the real
   * `bunSpawn`/`asyncBunSpawn` below.
   */
  pid?: number;
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
      pid: proc.pid,
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
        pid: proc.pid,
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
  /** Injectable clock for the artifact's `created` timestamp (ruling C12) — default real
   * `new Date().toISOString()` (a full UTC timestamp, not a bare date, since NOTES "created
   * timestamp"); tests inject a fixed value for deterministic assertions. */
  now?: () => string;
  /** NOTES R4-SANDBOX: test-only override of the OS sandbox primitive detection — default a real,
   * freshly-probed `detectSandbox()` on every cli spawn (never cached across a run, and never assumed
   * from the platform alone — see sandbox.ts's own header). Production call sites (`replay.ts`,
   * `board/serve.ts`) never set this, so a live spawn always reflects the host's actual, current
   * capability. */
  sandboxDetection?: SandboxDetection;
  /** Finding 132: the studio root a `kind: cli` dispatch trace is written under (`<studioRoot>/.levare/
   * dispatch-logs/`) — mirrors `SdkNativeBoundaryOptions.studioRoot`'s identical role for the native
   * path. Absent (the default for every test double, and for `stubAdapterRunner`) means no cli trace is
   * written; `productionAdapterRunner` (replay.ts) passes `repo.root` on every real construction, so a
   * live `kind: cli` dispatch — sync (`produce`, `levare replay`) or async (`produceAsync`, `levare
   * serve`) alike — always gets one. */
  studioRoot?: string;
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
  // Finding 85: a missing command template is the studio's own authoring gap — retry can never fill it in.
  if (!template || template.length === 0) throw new AdapterError(`cli agent '${req.member}' has no command template`, { class: "operator" });
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
  // Finding 85: every preflight failure below is caught before any process spawns — a fact about the
  // studio's own config/host, never the vendor or the member. `class: "operator"` throughout.
  if (cwd !== undefined) {
    if (!existsSync(cwd)) throw new AdapterError(`agent '${member}': cwd '${cwd}' does not exist`, { class: "operator" });
    if (!statSync(cwd).isDirectory()) throw new AdapterError(`agent '${member}': cwd '${cwd}' is not a directory`, { class: "operator" });
  }
  const argv0 = argv[0];
  if (!argv0) throw new AdapterError(`agent '${member}': command has no argv[0]`, { class: "operator" });
  if (argv0.includes("/")) {
    const resolved = isAbsolute(argv0) ? argv0 : pathJoin(cwd ?? process.cwd(), argv0);
    if (!isExecutableFile(resolved)) {
      throw new AdapterError(`agent '${member}': command '${argv0}' is not an executable file (resolved to '${resolved}')`, { class: "operator" });
    }
  } else if (Bun.which(argv0, { PATH: pathEnv ?? "" }) === null) {
    throw new AdapterError(`agent '${member}': command '${argv0}' not found on PATH`, { class: "operator" });
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

// Ruling 2026-08-24 (the verdict bridge, Finding 118): a critic has no channel to WRITE frontmatter
// directly (Ruling C12 — the member's own account of levare-facts is never consulted), so `verdict`
// (validate.ts's ARTIFACT_SCHEMA) can only ever populate by reading it out of what the critic already
// writes — its own review body. Unlike `extractCliUsageTrailer` above, this is READ-ONLY: a verdict line
// is the critic's genuine prose, not wrapper boilerplate, and stays in the body exactly as written (never
// stripped). Anchored per whole line — never a substring match, so "no changes requested" inside ordinary
// critique prose can never trip it — and scans the ENTIRE document, not just the first or last line:
// every matching line is counted. Exactly one match is unambiguous and is accepted; zero means the critic
// never declared one; two or more — even two IDENTICAL values — is a conflict, resolved by neither
// position nor recency (never the first match, never the last — `[...matchAll]` up front, deliberately
// never `.exec()`'s own first-match-only semantics, which has no way to notice a second one at all).
const VERDICT_LINE_RE = /^[ \t]*(?:Verdict:[ \t]*)?(APPROVED|CHANGES REQUESTED)[ \t]*$/gm;
// Findings 118/133: a critic writing `` `CHANGES REQUESTED` `` or **APPROVED** is still declaring the
// verdict on its own line — the backticks/asterisks/underscores are the member's own markdown habit, not
// a second sentence sharing the line with it. Stripped per-line before VERDICT_LINE_RE ever runs, so the
// whole-line anchor above keeps doing its real job unchanged: prose merely mentioning the token still has
// other words left on the line after stripping and still fails to match.
const MARKDOWN_DECORATION_RE = /[`*_]/g;
function stripVerdictLineDecoration(content: string): string {
  return content
    .split("\n")
    .map((line) => line.replace(MARKDOWN_DECORATION_RE, ""))
    .join("\n");
}
function extractVerdict(content: string): "APPROVED" | "CHANGES REQUESTED" | null {
  const matches = [...stripVerdictLineDecoration(content).matchAll(VERDICT_LINE_RE)];
  return matches.length === 1 ? (matches[0][1] as "APPROVED" | "CHANGES REQUESTED") : null;
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
// NOTES MCP-1C: the plumbing shared by a cli member's own dispatch policy and a remote/MCP server's —
// read-only system reach (the studio root, the running binary's own install tree, the resolved
// argv[0]'s own install tree), the operator's real HOME (the darwin deny target), and the darwin xcrun
// temp dir. Pulled out so `buildRemoteSandboxPolicy` below can build an equivalent policy without
// dragging in cli-only concerns (`dispatchGitWriteGrant`, `cliVendorScratchDir`) that don't apply to a
// spawned MCP server — it never touches a project's git worktree at all.
function baseSandboxContext(
  repo: Repo,
  cwd: string | undefined,
  argv0: string | undefined,
  pathEnv: string | undefined,
  baseEnv?: Record<string, string | undefined>,
): { readOnlyPaths: string[]; operatorHome: string | undefined; darwinTempDir: string | undefined } {
  const resolvedBin = argv0 ? resolveArgv0(argv0, cwd, pathEnv) : undefined;
  const treeDirs = (p: string) => [dirname(p), dirname(dirname(p))];
  const readOnlyPaths = [repo.root, ...treeDirs(process.execPath), ...(resolvedBin ? treeDirs(resolvedBin) : [])];
  const operatorHome = baseEnv?.HOME ?? process.env.HOME;
  const darwinTempDir = resolveDarwinUserTempDir();
  return { readOnlyPaths, operatorHome, darwinTempDir };
}

export function buildDispatchSandboxPolicy(
  repo: Repo,
  req: InvokeRequest,
  cwd: string | undefined,
  argv0: string | undefined,
  baseEnv?: Record<string, string | undefined>,
): SandboxPolicy {
  const { readOnlyPaths, operatorHome, darwinTempDir } = baseSandboxContext(repo, cwd, argv0, req.env.PATH, baseEnv);
  const sub = subscriptionConnector(repo, req.member);
  const grantedHomeTargets = operatorHome ? (sub?.home ?? []).filter(isSafeHomeDotpath).map((dotpath) => pathJoin(operatorHome, dotpath)) : [];
  // Finding 120: the SAME resolved path `gitConfigRedirectEnv` points a "full"-tier dispatch's
  // GIT_CONFIG_VALUE_0 at — granted read-only here (a single file, never the containing directory or
  // the rest of operatorHome) so that redirect actually resolves to something readable under the
  // sandbox, instead of degrading to the identical silent no-op a plain denied HOME already produces.
  // Resolved unconditionally (not gated on the eventual sandbox tier — cheap, and `readOnlyPaths` is
  // inert on a "none"/partial-tier dispatch exactly like every other entry in this list already is).
  const excludesFile = resolveGlobalExcludesFile(req.env);
  // Finding 144: the same grant, for the same reason, for GIT_CONFIG_VALUE_1's target when a global
  // core.attributesFile resolves.
  const attributesFile = resolveGlobalAttributesFile(req.env);
  const gitConfigReadOnlyPaths = [excludesFile, attributesFile].filter((p): p is string => p !== undefined);
  return {
    cwd: cwd ?? process.cwd(),
    home: req.env.HOME,
    allowNetwork: memberNetworkAllowed(repo, req.member),
    readOnlyPaths: [...readOnlyPaths, ...gitConfigReadOnlyPaths],
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

// NOTES MCP-1C (live macOS finding, LEVARE_SANDBOX_DEBUG's own captured profile): a `kind: mcp`
// connector's argv often names an INTERPRETER (bun, node, python3) plus a local SCRIPT the connector
// author wrote — unlike a `kind: cli` command, where argv[0] is almost always the actual binary being
// executed directly, already covered by `resolveArgv0`'s own install-tree grant. Live evidence: the
// interpreter's own resolved install tree WAS granted, but the SCRIPT PATH it was told to load (argv[1],
// e.g. `/Users/cas/source/levare/fixtures/stubs/fake-mcp-server.ts`) was not — bun spawned under the
// sandbox, tried to read the very file it was told to execute, was denied (`deny file-read-data` on the
// script path, confirmed from the kernel log), and HUNG at module-load rather than exiting cleanly
// (bun's own loader blocks on a denied read rather than erroring — the same "blocked process, not a
// crash" shape this whole R4 saga has repeatedly found for a startup-time denial). Never a gap for
// `cli`: no evidence anywhere in this codebase of a `cli` command template taking this
// interpreter-plus-local-script shape, so `buildDispatchSandboxPolicy` is deliberately left untouched —
// the narrowest fix the evidence justifies is remote-specific.
//
// Scans every argv element AFTER argv[0] for an ABSOLUTE path to a real, existing FILE on disk — never
// a bare flag, mode string, or bunx/npx package name (none of which resolve as an existing absolute
// path), so this can never over-grant on a well-formed connector: a `bunx -y @scope/pkg stdio` connector
// (no local script at all) scans its three trailing args and finds nothing to add. Grants exactly the
// script's own directory, read-only — a `subpath` reallow, the SAME granularity every other
// `readOnlyPaths` entry already gets (and, on darwin, canonicalized by `buildSandboxExecProfile`'s own
// existing `canon()` pass over every `readOnlyPaths` entry — no separate symlink handling needed here).
// Never the whole studio root, never a blanket re-allow of the operator's home.
function argvScriptReadOnlyPaths(argv: string[]): string[] {
  const out: string[] = [];
  for (const el of argv.slice(1)) {
    if (isAbsolute(el) && existsSync(el) && statSync(el).isFile()) out.push(dirname(el));
  }
  return out;
}

/**
 * NOTES MCP-1C (PRD Amendment 3, ruling R3) — the remote/MCP sibling of `buildDispatchSandboxPolicy`.
 * `cwd` is the dispatch's own fresh, per-dispatch scratch working area (createAsyncStdioRemoteBoundary
 * creates it fresh, never the project's own worktree — an MCP tools/call has no cwd of its own, unlike a
 * cli member's `agent.cwd`/`{feature_repo}`). `homeEnv` is whatever `env.ts#scopeHomeForConnector`
 * returned for THIS connector — the real, unscoped HOME when it declares no `home:`, or the per-run
 * scratch HOME (symlinks to its declared dotpaths) when it does; threaded straight into `policy.home`
 * exactly as `buildDispatchSandboxPolicy` threads `req.env.HOME` (`buildSandboxExecProfile`'s own
 * DEFECT-1 canon-comparison already no-ops a `home` that resolves to the same path as `operatorHome`, so
 * this needs no additional guard here). `grantedHomeTargets` reads `connector.home` directly — never
 * `subscriptionConnector`, since ruling R3 generalizes the mechanism to ANY granted `kind: mcp`
 * connector, `auth: env` or not (Connector.home's own doc, types.ts). No `writablePaths`/`gitWriteGrant`:
 * a spawned MCP server has no dispatch-worktree git-write need at all.
 *
 * `readOnlyPaths` additionally includes `argvScriptReadOnlyPaths(connector.argv)` — see that function's
 * own doc for the live finding this closes: an interpreter-plus-local-script connector's own script must
 * be readable under the sandbox, or the spawned interpreter hangs trying to load it.
 */
export function buildRemoteSandboxPolicy(repo: Repo, req: InvokeRequest, connector: Connector, cwd: string, homeEnv: Record<string, string>): SandboxPolicy {
  const { readOnlyPaths, operatorHome, darwinTempDir } = baseSandboxContext(repo, cwd, connector.argv?.[0], req.env.PATH, undefined);
  const grantedHomeTargets = operatorHome ? (connector.home ?? []).filter(isSafeHomeDotpath).map((dotpath) => pathJoin(operatorHome, dotpath)) : [];
  return {
    cwd,
    home: homeEnv.HOME,
    allowNetwork: memberNetworkAllowed(repo, req.member),
    readOnlyPaths: [...readOnlyPaths, ...(connector.argv ? argvScriptReadOnlyPaths(connector.argv) : [])],
    operatorHome,
    grantedHomeTargets,
    darwinXcrunTempDir: darwinTempDir,
  };
}

// Finding 75 (part 3 — regression from part 2): the per-uid base directory `@anthropic-ai/claude-agent-sdk/
// extract#extractFromBunfs` (vendored at `node_modules/@anthropic-ai/claude-agent-sdk/extractFromBunfs.js`
// — read directly, never guessed) extracts a COMPILED worker's own embedded native binary into, before
// spawning it: `{tmpdir()}/claude-{uid}` on POSIX, `{tmpdir()}/claude` on win32 — computed here from the
// SAME formula that file uses, never by calling extraction itself (only sdk-worker.ts's own process may
// safely do that; see sdk-transport.ts's own module comment on why this parent process never can).
//
// Part 2 claimed this mirrors that file's formula "exactly" but only ever tested `platform: "linux"` —
// on POSIX it called plain `node:os`'s `tmpdir()` unconditionally. `extractFromBunfs.js`'s OWN `tmpdir()`
// helper is NOT that: it honors `CLAUDE_CODE_TMPDIR` first, then hardcodes `/tmp` on darwin specifically
// to bypass `os.tmpdir()` (its own comment: "macOS /tmp works fine; os.tmpdir() below is for
// Android-on-Linux where /tmp isn't writable") — `os.tmpdir()` on a real macOS host returns `$TMPDIR`
// (typically `/var/folders/xx/yyyy/T`), a directory tree with NO relationship to `/tmp` (unlike `/tmp`
// itself, which is only ever a symlink to `/private/tmp` — the two are not the same path canonicalized
// two ways, they are genuinely different trees). The prior formula therefore granted a directory the
// inner CLI's own scratch machinery (bunfs extraction, and — sharing this identical per-uid base — the
// Bash tool's own per-session scratch dirs) never uses on darwin at all, denying every real spawn. Fixed
// to replicate `extractFromBunfs.js#tmpdir()` verbatim rather than reaching past it to Node's own.
//
// Exported (mirrors `resolveDarwinUserTempDir`'s own testable shape) so the formula itself has a direct
// unit test, independent of `process.platform`/`process.getuid`/`process.env` on whatever host `bun test`
// runs on.
export function nativeBunfsExtractionBase(opts: { platform?: string; getuid?: () => number; env?: Record<string, string | undefined> } = {}): string {
  const platform = opts.platform ?? process.platform;
  const getuid = opts.getuid ?? process.getuid?.bind(process) ?? (() => 0);
  const env = opts.env ?? process.env;
  const base = env.CLAUDE_CODE_TMPDIR || (platform === "darwin" ? "/tmp" : tmpdir());
  return pathJoin(base, platform === "win32" ? "claude" : `claude-${getuid()}`);
}

// Finding 75 (part 3): `sandbox.ts#canon` resolves every path it writes into a darwin profile through
// `realpathSync` so a `(subpath ...)` rule matches the KERNEL-RESOLVED form of the path being accessed —
// but `realpathSync` throws (ENOENT) if the target doesn't exist YET, and `canon` then falls back to the
// literal, un-resolved string (deliberately, for this module's own pure fixture tests — see sandbox.ts's
// own doc on `canon`). Every OTHER production grant this codebase makes is pre-created by levare itself
// before the policy is built (a worktree, a scoped HOME, a git-logs dir — see `dispatchGitWriteGrant`'s
// own `if (!existsSync(logs)) mkdirSync(...)` precedent, reused here) — `nativeBunfsExtractionBase`'s own
// target is the one exception: it names a directory the INNER CLI creates lazily, possibly for the first
// time ever on this host, which `canon`'s existing ENOENT fallback would silently defeat (granting the
// pre-resolution `/tmp/claude-{uid}` spelling, which never matches the kernel's `/private/tmp/claude-
// {uid}` once symlink-resolved). Pre-creating just the base (not the deeper, unpredictable per-run
// subdirectories the inner CLI nests under it) is enough — a subpath/bind grant on it covers whatever
// gets nested inside regardless of name. Best-effort, mirroring `sdk-transport.ts#hermeticSpawnEnv`'s own
// posture for a directory this process creates only as scaffolding for another process to use: a create
// failure here isn't a hard error, and the spawn will surface its own failure downstream if the
// directory genuinely can't be made.
// Exported (mirrors `nativeBunfsExtractionBase`'s own testable shape) so the pre-creation behavior has a
// direct unit test against a scratch `CLAUDE_CODE_TMPDIR`, never the host's real per-uid temp dir.
export function ensureNativeBunfsExtractionBase(opts: Parameters<typeof nativeBunfsExtractionBase>[0] = {}): string {
  const dir = nativeBunfsExtractionBase(opts);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* best-effort — see this function's own doc */
  }
  return dir;
}

/**
 * Finding 75 (part 2) — the native-dispatch sibling of `buildDispatchSandboxPolicy`/
 * `buildRemoteSandboxPolicy`: wraps the SDK WORKER's own OS-level self-invocation spawn
 * (sdk-transport.ts#workerSpawnArgv), never the `claude` subprocess the SDK spawns internally one layer
 * further down (a process this module cannot see or wrap directly — confining the worker that spawns it
 * is what actually confines the whole tree, since the worker's own mount/seatbelt namespace applies to
 * every descendant it forks).
 *
 * `cwd` here is the WORKER's own OS-level spawn cwd (sdk-transport.ts#workerSpawnCwd) — NOT the dispatch
 * worktree. The two are the SAME path for a `kind: cli` member (`buildDispatchSandboxPolicy`'s own `cwd`
 * param IS the worktree); for native they differ by construction: `workerSpawnCwd` is `LEVARE_ROOT` (a
 * source run) or the inherited ambient cwd (a compiled self-invocation), consumed by the OS spawn
 * itself, while the worktree (`req.projectRepoPath`) reaches the SDK one layer deeper via `query({
 * options: { cwd } })`, read only once the worker process is already running. Reusing
 * `AdapterRunner#sandboxWrap`'s cli-shaped call verbatim would bind the WRONG path read-write and leave
 * the worktree itself entirely ungranted — it therefore gets its own explicit `writablePaths` entry
 * here, independent of what `cwd` is bound to (and skipped on the rare case a project has no real local
 * checkout at all, where `req.projectRepoPath` is undefined — nothing to grant).
 *
 * `allowNetwork` is unconditionally `true` — never gated on `env.ts#memberNetworkAllowed` the way
 * `buildDispatchSandboxPolicy` gates a `cli` member's network reach on holding a granted connector.
 * Every native dispatch calls the Anthropic API to do its one job; network is the mechanism this kind
 * runs on, not an optional connector grant.
 *
 * Two grants exist here and nowhere else: `nativeBunfsExtractionBase`, pre-created via
 * `ensureNativeBunfsExtractionBase` (compiled builds only — written AND executed by the worker itself;
 * Finding 75 part 3's own fix — see that function's doc) and `LEVARE_CLAUDE_CONFIG_DIR` (sdk-transport.ts
 * — created by this process, read/written by the SDK's own inner `claude` CLI subprocess, on every run
 * mode). Neither has an existing `SandboxPolicy` field any other kind ever points at.
 *
 * `isCompiledBuildFn` (Finding 75 part 3, round 2 — a live macOS run's own finding): defaults to the real
 * `isCompiledBuild`, injectable so a PROBE can force the compiled-build branch without needing an actual
 * `--define`-stamped binary. Without this, `scripts/repro-r4-sandbox-native-worker.ts`'s own STEP C —
 * invoked via `bun run`, which is inherently a source run — could never exercise the
 * `ensureNativeBunfsExtractionBase` grant at all: `isCompiledBuild()` reads real ambient state and is
 * unconditionally false there, so the grant this whole unit exists to fix was silently absent from
 * every profile the probe ever generated, and the probe passed for a reason production doesn't share.
 * The exact same "the probe's own gap is part of the finding" lesson the original goal named, one layer
 * deeper: closing the FIRST probe gap (auth) still left this SECOND one (build mode) unexercised.
 */
export function buildNativeSandboxPolicy(
  repo: Repo,
  req: InvokeRequest,
  cwd: string,
  pathToClaudeCodeExecutable: string | undefined,
  baseEnv?: Record<string, string | undefined>,
  isCompiledBuildFn: () => boolean = isCompiledBuild,
): SandboxPolicy {
  const { readOnlyPaths, operatorHome, darwinTempDir } = baseSandboxContext(repo, cwd, undefined, req.env.PATH, baseEnv);
  const treeDirs = (p: string) => [dirname(p), dirname(dirname(p))];
  const sub = subscriptionConnector(repo, req.member);
  const grantedHomeTargets = operatorHome ? (sub?.home ?? []).filter(isSafeHomeDotpath).map((dotpath) => pathJoin(operatorHome, dotpath)) : [];
  return {
    cwd,
    home: req.env.HOME,
    allowNetwork: true,
    // A source-tree run resolves a real, immediately-usable binary path (NOTES phase-7 K14) — grant its
    // own install tree exactly like a `cli` member's resolved argv[0] gets (baseSandboxContext's own
    // `resolvedBin` reallow); a compiled run leaves this undefined (resolved+extracted inside the worker
    // itself, NOTES DIST7) and relies on `nativeBunfsExtractionBase` below instead.
    readOnlyPaths: [...readOnlyPaths, ...(pathToClaudeCodeExecutable ? treeDirs(pathToClaudeCodeExecutable) : [])],
    operatorHome,
    grantedHomeTargets,
    writablePaths: [
      ...(req.projectRepoPath && req.projectRepoPath !== cwd ? [req.projectRepoPath] : []),
      ...(req.dispatchGitWriteGrant?.subpaths ?? []),
      LEVARE_CLAUDE_CONFIG_DIR,
      ...(isCompiledBuildFn() ? [ensureNativeBunfsExtractionBase()] : []),
    ],
    gitWriteGrant: req.dispatchGitWriteGrant,
    darwinXcrunTempDir: darwinTempDir,
  };
}

// Finding 75 (part 2): shared by both the sync and async native boundary constructors — builds the
// `WrapWorkerSpawn` closure `sdk-transport.ts` calls (only ever on the real self-invocation spawn path;
// see its own doc) with a fresh, un-cached `detectSandbox()` per dispatch (sandbox.ts's own "never
// assumed to still hold" posture), and reports the resulting enforcement level back to the caller via
// `onLevel` — `transport.run()` calls the wrap closure SYNCHRONOUSLY, before its own first `await`
// (async transport) or before returning at all (sync transport), so `onLevel` has always fired by the
// time either `run()` call resolves. `undefined` when `opts.repo` was never supplied (every test double
// in this codebase) — the pre-this-unit behaviour, unchanged: the worker spawns unwrapped.
function nativeWrapWorkerSpawn(
  repo: Repo | undefined,
  req: InvokeRequest,
  pathToClaudeCodeExecutable: string | undefined,
  baseEnv: Record<string, string | undefined>,
  sandboxDetection: SandboxDetection | undefined,
  onLevel: (level: SandboxLevel) => void,
): WrapWorkerSpawn | undefined {
  if (!repo) return undefined;
  return (argv, cwd) => {
    const detection = sandboxDetection ?? detectSandbox();
    const policy = buildNativeSandboxPolicy(repo, req, cwd, pathToClaudeCodeExecutable, baseEnv);
    const wrapped = wrapForSandbox(argv, policy, detection);
    onLevel(wrapped.level);
    return wrapped;
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
          sandbox = res.sandbox;
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
          // Finding 85: a declared agent kind this build's dispatch switch doesn't recognize — a
          // studio-authoring/version-skew fact, never the vendor's or the member's.
          throw new AdapterError(`unknown agent kind '${(agent as Agent).kind}' for '${member}'`, { class: "operator" });
      }
      const codeCommit = this.commitCodeChanges(member, kind, unit, req2);
      return this.author(req2, raw, receipt, extraConsumes, sandbox, codeCommit);
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
          sandbox = res.sandbox;
          break;
        }
        case "remote": {
          // NOTES MCP-1C: `sandbox` is only ever set via the REAL boundary (`this.opts.remote`, the
          // sync/replay-only mock, never wraps anything — see `RemoteBoundary`'s own doc) — mirrors the
          // cli case immediately below, which likewise only ever gets a `sandbox` level from a real spawn.
          if (this.opts.asyncRemote) {
            const res = await this.opts.asyncRemote.call(req2);
            raw = res.doc;
            sandbox = res.sandbox;
          } else {
            raw = this.opts.remote.call(req2).doc;
          }
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
          // Finding 85: a declared agent kind this build's dispatch switch doesn't recognize — a
          // studio-authoring/version-skew fact, never the vendor's or the member's.
          throw new AdapterError(`unknown agent kind '${(agent as Agent).kind}' for '${member}'`, { class: "operator" });
      }
      const codeCommit = this.commitCodeChanges(member, kind, unit, req2);
      return this.author(req2, raw, receipt, extraConsumes, sandbox, codeCommit);
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
    // NOTES DISPATCH-TRACE: `scopeHomeForConnector` returns the SAME `env` reference, unchanged, when
    // scoping was a no-op (env.ts:213) — reference inequality is therefore a real, cheap signal for
    // "did HOME actually get scoped", not a heuristic.
    try {
      return fn({ ...req, env: scoped.env, homeScoped: scoped.env !== req.env });
    } finally {
      scoped.cleanup();
    }
  }

  private async withHomeScopeAsync<T>(member: string, req: InvokeRequest, fn: (req: InvokeRequest) => Promise<T>): Promise<T> {
    const scoped = scopeHome(this.repo, member, req.env);
    try {
      return await fn({ ...req, env: scoped.env, homeScoped: scoped.env !== req.env });
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
    // Finding 85: no team/agent definition names this member at all — a studio-authoring gap.
    if (!agent) throw new AdapterError(`no agent definition for member '${member}'`, { class: "operator" });
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
    const created = createDispatchWorktree(dispatchRepo.repoPath, dispatchRepo.branch, memberIdentity(member));
    if (!created.ok) {
      AdapterRunner.logWorktreeDebug(`dispatch worktree declined for '${member}': createDispatchWorktree failed for branch '${dispatchRepo.branch}' in '${dispatchRepo.repoPath}': ${created.error}`);
      throw new AdapterError(`member '${member}': could not create dispatch worktree for work branch '${dispatchRepo.branch}' in '${dispatchRepo.repoPath}': ${created.error}`);
    }
    AdapterRunner.logWorktreeDebug(`dispatch worktree created for '${member}' at '${created.worktree.path}' (gitDir '${created.worktree.gitDir}') for branch '${dispatchRepo.branch}' in '${dispatchRepo.repoPath}'`);
    try {
      return fn({ ...req, projectRepoPath: created.worktree.path, dispatchGitWriteGrant: dispatchGitWriteGrant(created.worktree.gitDir), dispatchWorktreeBaseSha: created.worktree.baseSha });
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
    const created = createDispatchWorktree(dispatchRepo.repoPath, dispatchRepo.branch, memberIdentity(member));
    if (!created.ok) {
      AdapterRunner.logWorktreeDebug(`dispatch worktree declined for '${member}': createDispatchWorktree failed for branch '${dispatchRepo.branch}' in '${dispatchRepo.repoPath}': ${created.error}`);
      throw new AdapterError(`member '${member}': could not create dispatch worktree for work branch '${dispatchRepo.branch}' in '${dispatchRepo.repoPath}': ${created.error}`);
    }
    AdapterRunner.logWorktreeDebug(`dispatch worktree created for '${member}' at '${created.worktree.path}' (gitDir '${created.worktree.gitDir}') for branch '${dispatchRepo.branch}' in '${dispatchRepo.repoPath}'`);
    try {
      return await fn({ ...req, projectRepoPath: created.worktree.path, dispatchGitWriteGrant: dispatchGitWriteGrant(created.worktree.gitDir), dispatchWorktreeBaseSha: created.worktree.baseSha });
    } finally {
      created.worktree.cleanup();
    }
  }

  // Goal "commit-on-produce" (Finding 74): runs INSIDE withDispatchWorktree(Async)'s callback — after
  // the invoke above has returned, before that callback returns and the `finally` force-deletes the
  // worktree (adapters.ts#withDispatchWorktree/withDispatchWorktreeAsync) — so this is the only chance
  // any code ever gets to see the member's own uncommitted file edits before they're gone for good. A
  // no-op returning undefined when there was no real dispatch worktree at all (`req.dispatchGitWriteGrant`
  // absent — self-referential/unresolvable `repo:`, or no work branch yet, exactly `projectRepoPath`'s
  // own no-worktree case): there is nothing to commit against and nothing worth stamping on the artifact.
  // A commit failure is a HARD failure, thrown before `author()` ever runs, never swallowed — mirrors
  // `createDispatchWorktree` failing above: a member's real code changes existing but failing to land on
  // the work branch is exactly this finding recurring, and must block the unit as loudly as any other
  // member failure (dagwalk.ts#produceOne's existing catch → `blocked` artifact).
  private commitCodeChanges(member: string, kind: string, unit: string, req: InvokeRequest): DispatchCommitResult | undefined {
    if (!req.dispatchGitWriteGrant) return undefined;
    const result = commitDispatchWorktree(req.projectRepoPath!, req.dispatchWorktreeBaseSha!, `${member}: ${kind} for ${unit}`, memberIdentity(member));
    if (!result.committed && result.reason === "error") {
      throw new AdapterError(`member '${member}': failed to commit dispatch worktree changes for unit '${unit}' in '${req.projectRepoPath}': ${result.error}`);
    }
    return result;
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
  private author(req: InvokeRequest, raw: string, receipt?: Receipt, extraConsumes: string[] = [], sandbox?: SandboxLevel, codeCommit?: DispatchCommitResult): { doc: string; receipt: Receipt } {
    const content = stripFrontmatter(raw);
    if (!content) throw new AdapterError(`member '${req.member}' produced no usable content`);
    // Ruling 2026-08-24 (the verdict bridge, Finding 118): scoped to kind: review only — the exact
    // predicate board/render/shell.ts's own card already uses to decide whether to show a verdict badge
    // — so a non-review kind's last line is never coincidentally scanned for APPROVED/CHANGES REQUESTED.
    // See extractVerdict's own doc for the scan itself.
    const verdict = req.kind === "review" ? extractVerdict(content) : null;
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
    // Full UTC timestamp, not a bare date (NOTES "created timestamp"): a member dispatched and
    // approved within the same hour used to stamp midnight either way, which is what made
    // derive.ts#ageLabel/medianGateResponseDays read hours as "0d"/"1d" depending on which side of
    // midnight the walk happened to land on. `.toISOString()` already produces the exact
    // `YYYY-MM-DDTHH:MM:SS.sssZ` shape validate.ts's `isIsoDate` now accepts.
    const created = (this.opts.now ?? (() => new Date().toISOString()))();
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
      // Goal REGISTRY-PROVENANCE, Part 2: what governed this dispatch — see git.ts#registryStateHash's
      // own doc for why a content hash, not the repo's HEAD, is what gets stamped here. Unconditional,
      // unlike usage/sandbox below: every kind of member (native/cli/remote) runs under SOME registry
      // state, so this is never a "some artifacts have it" fact the way a receipt or a sandbox level is.
      `registry: ${registryStateHash(this.repo.root)}`,
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
      // NOTES "receipt cache tokens": present only for a native receipt (sdk-worker.ts#deriveReceipt
      // always sets both, even to 0) — a cli/remote member has no cache accounting to give, so these
      // stay absent rather than a misleading `null` on every non-native artifact.
      if (finalReceipt.tokens_cache_read !== undefined) lines.push(`  tokens_cache_read: ${finalReceipt.tokens_cache_read ?? "null"}`);
      if (finalReceipt.tokens_cache_write !== undefined) lines.push(`  tokens_cache_write: ${finalReceipt.tokens_cache_write ?? "null"}`);
      if (finalReceipt.plan) lines.push(`  plan: ${finalReceipt.plan}`);
    }
    // NOTES R4-SANDBOX / NOTES MCP-1C / Finding 75 (part 2, 2026-08-24): the OS-sandbox enforcement
    // level this member's spawn actually ran under — a fact about THIS run, independent of
    // `usage`/`unreported` (a member reporting no usage at all still carries a real sandbox level; never
    // omitted just because nothing else was reported). `cli` (Ruling 2), `remote` (ruling R3), and now
    // `native` (Finding 75 part 2 — the SDK worker's own self-invocation spawn, sdk-transport.ts#
    // workerSpawnArgv, wrapped by `createSdkNativeBoundary`/`createAsyncSdkNativeBoundary` exactly like a
    // `cli` member's spawn) share the identical rule: present only when the boundary that actually ran
    // reported a level. Absent for every kind when the boundary was a mocked/stub double (`replay
    // --stubs`, most unit tests) — a mock never genuinely wrapped anything, so there is nothing honest to
    // stamp, mirroring `cli`/`remote`'s own pre-existing convention rather than inventing a native-only
    // exception to it. `sandbox: not-wrapped` (Finding 75 part 1) is no longer emitted by this binary —
    // it remains a legal value only on artifacts an OLDER binary already wrote (validate.ts's schema
    // still accepts it; Finding 99's ruling: never rewrite what an older binary produced).
    if ((req.agent.kind === "cli" || req.agent.kind === "remote" || req.agent.kind === "native") && sandbox) lines.push(`sandbox: ${sandbox}`);
    // NOTES R4-SANDBOX-APPSERVER: recorded on EVERY artifact this member produces, independent of
    // `sandbox:`'s own value above (which reads "none" identically whether the host simply lacks a
    // primitive or the author declared this member unsandboxeable — the two are NOT the same fact, and
    // silently collapsing them would hide a deliberate, documented decision behind what looks like an
    // ordinary host-capability gap). `req.agent.sandbox_reason` is required by `validate.ts` whenever
    // `sandbox: unsandboxed` is declared, so this is never emitted without one. `native` has no such
    // declared escape hatch (Finding 75 part 2 gives it no `sandbox: unsandboxed` field), so this line
    // stays cli-only.
    if (req.agent.kind === "cli" && req.agent.sandbox === "unsandboxed" && req.agent.sandbox_reason) {
      lines.push(`sandbox_reason: ${req.agent.sandbox_reason}`);
    }
    // Goal "commit-on-produce" (Finding 74): whether this dispatch's own worktree file changes (if any)
    // survived teardown as a commit on the work branch — see `commitCodeChanges`'s own doc for when this
    // runs. Present for every member kind that got a real dispatch worktree (unlike `sandbox:` above,
    // this is about whether a worktree existed at all, not about which kind spawned a confinable OS
    // process). `none` records a dispatch that changed nothing, explicitly — never silently
    // indistinguishable from one that committed real work. A failed commit attempt never reaches this
    // line at all (`commitCodeChanges` throws before `author()` is ever called).
    if (codeCommit) lines.push(`code_commit: ${codeCommit.committed ? codeCommit.commit : "none"}`);
    // Unit "member authorship survives a self-commit": present ONLY when the landed commit's own
    // author/committer doesn't match `memberIdentity(req.member)` — a member's own bare commit resolving
    // some other ambient identity (the live defect this unit closes), or a member deliberately overriding
    // identity on its own command line (accepted, never prevented — see merge.ts#commitDispatchWorktree's
    // own doc). Absent whenever the identity matches, including every commit `commitDispatchWorktree`
    // made itself (its own `-c` flags always match by construction) — this line's mere PRESENCE is the
    // anomaly signal, mirroring `sandbox_reason`'s own "present only when relevant" precedent above.
    if (codeCommit?.committed && codeCommit.unexpectedActor) {
      const a = codeCommit.unexpectedActor;
      const committerDiffers = a.authorName !== a.committerName || a.authorEmail !== a.committerEmail;
      const committerPart = committerDiffers ? ` (committer: ${a.committerName} <${a.committerEmail}>)` : "";
      lines.push(`code_commit_actor: ${a.authorName} <${a.authorEmail}>${committerPart}`);
    }
    // Ruling 2026-08-25 (Findings 118/133): `verdict_source` is `extracted` when the scan found exactly
    // one anchored line, since author() has no other channel a member could have used to set it (Ruling
    // C12; see validate.ts's own schema doc for `declared`'s reserved, not-yet-implemented meaning). For
    // kind: review specifically, the scan RAN even when it found nothing — `not-found` records that,
    // so a critic whose verdict line was lost to a matching failure (or genuinely never wrote one) is no
    // longer indistinguishable from a review artifact this field predates. `verdict` itself stays absent
    // in that case: the scan found no unambiguous verdict, so there is nothing to name.
    if (verdict) lines.push(`verdict: ${verdict}`, "verdict_source: extracted");
    else if (req.kind === "review") lines.push("verdict_source: not-found");
    lines.push("---", "");
    return { doc: lines.join("\n") + content + "\n", receipt: finalReceipt };
  }

  // Shared argv/cwd/stdin derivation for both the sync and async CLI spawn paths.
  private cliInvocation(agent: Agent, req: InvokeRequest): { argv: string[]; cwd: string | undefined; timeoutMs: number; stdin: string | undefined } {
    const argv = (this.opts.cliCommand ?? defaultCliCommand)(req);
    const timeoutMs = resolveMemberTimeoutS(agent) * 1000;
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
  // NOTES R4-SANDBOX-APPSERVER: `agent.sandbox === "unsandboxed"` is the declared escape hatch — an
  // author-stated fact that THIS member's process cannot run confined at all (a vendor CLI whose own
  // architecture needs OS access this sandbox's threat model won't safely grant — an in-process IPC
  // client, a self-sandboxing helper, or anything else a live host investigation names), never a
  // silent degradation. Checked BEFORE `detectSandbox()` even runs — no probe cost paid for a spawn
  // that was never going to be wrapped regardless of what the host offers — and the spawn proceeds with
  // the plain, unwrapped `argv`, `level: "none"`, exactly like a host with no working primitive at all.
  // The DISTINCTION from "host lacks a primitive" — this was DECLARED, not merely unavailable — is
  // recorded separately, on the artifact itself (`author()`'s own `sandbox_reason` line, read straight
  // off `req.agent.sandbox_reason`, required by validate.ts whenever `sandbox: unsandboxed` is declared)
  // rather than invented here as a second WrappedSpawn shape only this one caller would ever produce.
  private sandboxWrap(argv: string[], cwd: string | undefined, req: InvokeRequest): WrappedSpawn {
    if (req.agent.sandbox === "unsandboxed") return { argv, level: "none" };
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

  // Finding 132: shared by `runCli`/`runCliAsync` — everything about a cli dispatch trace that's known
  // BEFORE the spawn (argv actually resolved to run, env names, HOME/sandbox/grant facts, timing bound).
  // `wrapped`/`env` are already computed by both callers before this runs, so this never re-derives the
  // sandbox decision — it only reports it. See `dispatch-trace.ts`'s own cli-trace section header for why
  // this is a sibling shape to the native record, not a widened one.
  private cliTraceIdentityOpts(
    req: InvokeRequest,
    agent: Agent,
    wrapped: { argv: string[]; level?: SandboxLevel },
    env: Record<string, string>,
    cwd: string | undefined,
    timeoutMs: number,
    vendorScratchUsed: boolean,
    startedAt: string,
  ): CliDispatchTraceIdentityOpts {
    return {
      unit: req.unit,
      project: req.project,
      member: req.member,
      kind: req.kind,
      command: wrapped.argv[0] ?? "",
      args: wrapped.argv.slice(1),
      cwd,
      timeoutMs,
      env,
      homeScoped: req.homeScoped ?? false,
      sandboxLevel: wrapped.level,
      sandboxReason: agent.sandbox === "unsandboxed" ? agent.sandbox_reason : undefined,
      gitWriteGrant: req.dispatchGitWriteGrant !== undefined,
      vendorScratch: vendorScratchUsed,
      startedAt,
    };
  }

  // Finding 132 / Finding 113's discipline applied to cli: written before the spawn, so a hung cli
  // dispatch (Finding 52's own six rounds of live-sandbox debugging) leaves something in
  // `.levare/dispatch-logs/` for its entire duration instead of nothing. A no-op when `studioRoot` was
  // never supplied — every test double, and `stubAdapterRunner`, which never sets it.
  private traceCliDispatchStart(traceOpts: CliDispatchTraceIdentityOpts): void {
    if (!this.opts.studioRoot) return;
    writeCliDispatchTrace(this.opts.studioRoot, buildCliDispatchTraceStart(traceOpts));
  }

  // Finding 132: amends the start trace (same file, same `traceOpts.startedAt`) with the spawn's own
  // outcome — written from the raw `SpawnResult` directly, BEFORE `cliResultToDoc` runs, so a failing
  // dispatch's trace is never skipped just because the caller goes on to throw an `AdapterError` for it.
  private traceCliDispatchFinish(result: SpawnResult, endedAt: string, traceOpts: CliDispatchTraceIdentityOpts): void {
    if (!this.opts.studioRoot) return;
    const outcome: CliDispatchOutcome = {
      timedOut: result.timedOut,
      // Neither `CliSpawn`/`AsyncCliSpawn` tracks its own elapsed time (unlike the SDK transport, which
      // hands `NativeDispatchOutcome.durationMs` back as a directly-measured figure) — derived here from
      // the two real wall-clock timestamps this method's own two callers already capture immediately
      // before/after the spawn, millisecond-precision `toISOString()` on both sides, never a separate
      // timer this file would otherwise have to add to `SpawnResult` for no other consumer's benefit.
      durationMs: Date.parse(endedAt) - Date.parse(traceOpts.startedAt),
      endedAt,
      exitCode: result.exitCode,
      signalCode: result.signalCode,
      childPid: result.pid,
      stdout: result.stdout,
      stderr: result.stderr ?? "",
    };
    writeCliDispatchTrace(this.opts.studioRoot, buildCliDispatchTrace(outcome, traceOpts));
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
    const traceOpts = this.cliTraceIdentityOpts(req, agent, wrapped, env, cwd, timeoutMs, vendorScratch !== undefined, new Date().toISOString());
    this.traceCliDispatchStart(traceOpts);
    try {
      const result = this.spawn.run(wrapped.argv, { env, cwd, timeoutMs, stdin });
      if (real) AdapterRunner.logSpawnDebug(result);
      this.traceCliDispatchFinish(result, new Date().toISOString(), traceOpts);
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
    const traceOpts = this.cliTraceIdentityOpts(req, agent, wrapped, env, cwd, timeoutMs, vendorScratch !== undefined, new Date().toISOString());
    this.traceCliDispatchStart(traceOpts);
    try {
      const result = await this.asyncSpawn.run(wrapped.argv, { env, cwd, timeoutMs, stdin });
      if (real) AdapterRunner.logSpawnDebug(result);
      this.traceCliDispatchFinish(result, new Date().toISOString(), traceOpts);
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

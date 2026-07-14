// levare member adapters (§6). Behind the Runner's MemberRunner boundary sit three adapter kinds,
// dispatched by an agent's `kind`:
//
//   native → a Claude Agent SDK invocation with the assembled context, tool allowlist, and
//            granted-connector env. The adapter talks to a `NativeBoundary`/`AsyncNativeBoundary`
//            interface — tests mock it; production (replay.ts#productionAdapterRunner, NOTES F8)
//            backs it with the real SDK via `createSdkNativeBoundary`/`createAsyncSdkNativeBoundary`.
//   cli    → Bun.spawn of the agent's command template in `cwd`, with the allowlisted env only and
//            the timeout enforced; the raw stdout is the member's content.
//   remote → an MCP call, likewise behind a mockable `RemoteBoundary` (still mocked in every path —
//            a documented, separate deferral, untouched by F8).
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

import { existsSync, statSync, accessSync, constants as fsConstants } from "node:fs";
import { isAbsolute, join as pathJoin } from "node:path";
import { normalizeReceipt } from "./receipts.ts";
import { buildMemberEnv, teamOf, subscriptionConnector } from "./env.ts";
import { allowedTools } from "./guardrails.ts";
import { assembleContext, unitArtifactPaths } from "./context.ts";
import { asyncSdkTransport, bunSdkTransport, resolveNativeBinary, type AsyncSdkTransport, type SdkTransport } from "./sdk-transport.ts";
import { repoCapabilities } from "./repo.ts";
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

/** The remote MCP boundary (mocked this phase). */
export interface RemoteBoundary {
  call(req: InvokeRequest): { doc: string };
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

function nativeWorkerRequest(req: InvokeRequest, pathToClaudeCodeExecutable: string | undefined) {
  // Tool allowlist (security-audit Surface 3/8's now-closed K5 pre-arm): `req.tools` is
  // `guardrails.ts#allowedTools(agent)` — exactly the agent's declared `tools:`, `[]` when it
  // declares none. Passed as BOTH `tools` and `allowedTools` so an agent declaring no tools reaches
  // the SDK with an empty allowlist, never an implicit/full one.
  return { prompt: req.context, model: req.agent.model, tools: req.tools, allowedTools: req.tools, cwd: req.agent.cwd, pathToClaudeCodeExecutable };
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
    return {
      stdout: proc.stdout ? new TextDecoder().decode(proc.stdout) : "",
      exitCode: proc.exitCode ?? -1,
      // Bun's own timeout flag — the authoritative signal. A slow-but-successful member (which exits
      // 0 on its own) is never misread as timed out, and a plain non-zero exit stays a non-zero exit.
      timedOut: proc.exitedDueToTimeout === true,
      stderr: proc.stderr ? new TextDecoder().decode(proc.stderr) : "",
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
      if (proc.pid) killProcessGroup(proc.pid);
    }, opts.timeoutMs);
    try {
      const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return {
        stdout: timedOut ? "" : stdout,
        exitCode: proc.exitCode ?? -1,
        timedOut,
        stderr,
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
  const feature = req.agent.cwd ?? ".";
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
    const { agent, req } = this.prepare(member, kind, unit, project, extraConsumes);
    let raw: string;
    let receipt: Receipt | undefined;
    switch (agent.kind) {
      case "native": {
        const res = this.opts.native.invoke(req);
        raw = res.doc;
        receipt = res.receipt;
        break;
      }
      case "remote":
        raw = this.opts.remote.call(req).doc;
        break;
      case "cli":
        raw = this.runCli(agent, req);
        break;
      default:
        throw new AdapterError(`unknown agent kind '${(agent as Agent).kind}' for '${member}'`);
    }
    return this.author(req, raw, receipt, extraConsumes);
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
    const { agent, req } = this.prepare(member, kind, unit, project, extraConsumes);
    let raw: string;
    let receipt: Receipt | undefined;
    switch (agent.kind) {
      case "native": {
        const res = this.opts.asyncNative ? await this.opts.asyncNative.invoke(req) : this.opts.native.invoke(req);
        raw = res.doc;
        receipt = res.receipt;
        break;
      }
      case "remote":
        raw = this.opts.remote.call(req).doc;
        break;
      case "cli":
        raw = await this.runCliAsync(agent, req);
        break;
      default:
        throw new AdapterError(`unknown agent kind '${(agent as Agent).kind}' for '${member}'`);
    }
    return this.author(req, raw, receipt, extraConsumes);
  }

  // Shared setup for both produce/produceAsync: resolve the agent, assemble its §6 context, scope its
  // env, and build the InvokeRequest every adapter kind reads from.
  private prepare(member: string, kind: string, unit: string, project: string, extraConsumes: string[] = []): { agent: Agent; req: InvokeRequest } {
    const agent = this.repo.agents.get(member);
    if (!agent) throw new AdapterError(`no agent definition for member '${member}'`);
    const context = this.assemble(member, unit, project, extraConsumes);
    const env = buildMemberEnv(this.repo, member, this.opts.baseEnv);
    const req: InvokeRequest = { agent, member, kind, unit, project, context, env, tools: allowedTools(agent) };
    return { agent, req };
  }

  // Ruling C12: levare authors the artifact. `raw` is whatever the boundary returned — plain content,
  // or content the member wrapped in a frontmatter fence of its own (stripped below, never read). The
  // wrapper is built entirely from facts this runner already knows; the member's own account of them
  // is never consulted. `receipt`, when the boundary supplied one, is the SDK's OWN reported usage (a
  // native member's real token counts/cost/wall-clock, computed by sdk-worker.ts from the actual API
  // response) — used verbatim. Absent (every non-native adapter, and a mocked/stub native boundary
  // that doesn't report one) records `unreported`, honestly — never re-derived by parsing whatever
  // usage figures the member's own output happened to claim.
  private author(req: InvokeRequest, raw: string, receipt?: Receipt, extraConsumes: string[] = []): { doc: string; receipt: Receipt } {
    const content = stripFrontmatter(raw);
    if (!content) throw new AdapterError(`member '${req.member}' produced no usable content`);
    let finalReceipt = receipt ?? normalizeReceipt(null, this.opts.pricing);
    // NOTES C13: a subscription-authenticated member's cost is flat-rate, not per-token — pricing it
    // from the token table would be a fiction. `usd` is forced null and the plan is named in its
    // place; token counts (when the member's boundary reported them) pass through unchanged.
    if (!finalReceipt.unreported) {
      const sub = subscriptionConnector(this.repo, req.member);
      if (sub) finalReceipt = { ...finalReceipt, usd: null, plan: sub.plan ?? sub.name };
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
    lines.push("---", "");
    return { doc: lines.join("\n") + content + "\n", receipt: finalReceipt };
  }

  // Shared argv/cwd/stdin derivation for both the sync and async CLI spawn paths.
  private cliInvocation(agent: Agent, req: InvokeRequest): { argv: string[]; cwd: string | undefined; timeoutMs: number; stdin: string | undefined } {
    const argv = (this.opts.cliCommand ?? defaultCliCommand)(req);
    const timeoutMs = (agent.timeout ?? 600) * 1000;
    // A `cwd` template that still holds an unresolved `{…}` (no feature repo bound this run) is not a
    // real directory — spawn in the default cwd rather than fail on a bogus path.
    const cwd = agent.cwd && !agent.cwd.includes("{") ? agent.cwd : undefined;
    // NOTES F7: context_via: stdin writes the full context to the child's stdin (and closes it);
    // context_via: arg (default) leaves stdin unset here — the CliSpawn boundary closes it regardless
    // (see CliSpawnOptions.stdin), so a CLI that unexpectedly reads stdin sees immediate EOF, never a
    // hang waiting on input that will never arrive.
    const stdin = contextVia(agent) === "stdin" ? req.context : undefined;
    return { argv, cwd, timeoutMs, stdin };
  }

  // Shared timeout/exit-code → AdapterError translation for both CLI spawn paths (NOTES F3: argv +
  // stderr tail attached either way).
  private cliResultToDoc(member: string, agent: Agent, argv: string[], result: SpawnResult): string {
    const tail = truncateTail(result.stderr ?? "", 2000);
    const stderrSuffix = tail ? `\nstderr (last ${tail.length} chars):\n${tail}` : "";
    if (result.timedOut) {
      throw new AdapterError(`cli member '${member}' timed out after ${agent.timeout ?? 600}s (argv: ${JSON.stringify(argv)})${stderrSuffix}`);
    }
    if (result.exitCode !== 0) {
      throw new AdapterError(`cli member '${member}' exited ${result.exitCode} (argv: ${JSON.stringify(argv)})${stderrSuffix}`);
    }
    return result.stdout;
  }

  private runCli(agent: Agent, req: InvokeRequest): string {
    const { argv, cwd, timeoutMs, stdin } = this.cliInvocation(agent, req);
    // NOTES F3: pre-flight ONLY guards the real `bunSpawn` boundary — the one that actually hands argv
    // to the OS and can fail with an opaque, contextless nonzero exit. A test-injected `CliSpawn` is a
    // stand-in for arbitrary behaviour (including deliberately-fake argv[0]s like "codex" that this
    // sandbox never installs) and never touches the filesystem or PATH, so it is never subject to the
    // failure mode this guards against.
    if (this.spawn === bunSpawn) preflightCli(req.member, argv, cwd, req.env.PATH);
    const result = this.spawn.run(argv, { env: req.env, cwd, timeoutMs, stdin });
    return this.cliResultToDoc(req.member, agent, argv, result);
  }

  // NOTES F5: the async counterpart to `runCli` — same argv/preflight/error handling, but the spawn
  // itself never blocks the caller's event loop (see asyncBunSpawn).
  private async runCliAsync(agent: Agent, req: InvokeRequest): Promise<string> {
    const { argv, cwd, timeoutMs, stdin } = this.cliInvocation(agent, req);
    if (this.asyncSpawn === asyncBunSpawn) preflightCli(req.member, argv, cwd, req.env.PATH);
    const result = await this.asyncSpawn.run(argv, { env: req.env, cwd, timeoutMs, stdin });
    return this.cliResultToDoc(req.member, agent, argv, result);
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

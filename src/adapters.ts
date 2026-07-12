// levare member adapters (§6). Behind the Runner's MemberRunner boundary sit three adapter kinds,
// dispatched by an agent's `kind`:
//
//   native → a Claude Agent SDK invocation with the assembled context, tool allowlist, and
//            granted-connector env. The SDK itself is NOT a dependency this phase; the adapter talks
//            to a `NativeBoundary` interface, which tests mock and a later phase backs with the SDK.
//   cli    → Bun.spawn of the agent's command template in `cwd`, with the allowlisted env only and
//            the timeout enforced; the raw stdout is the artifact doc, validated at the boundary.
//   remote → an MCP call, likewise behind a mockable `RemoteBoundary`.
//
// All three funnel their member's reported usage through normalizeReceipt (§10), so the receipt shape
// is identical and `unreported` is recorded honestly when a member gives nothing. The doc itself is
// never trusted from the member: the Runner re-validates it against the artifact contract.

import { parseFrontmatter } from "./yaml.ts";
import { normalizeReceipt } from "./receipts.ts";
import { buildMemberEnv } from "./env.ts";
import { allowedTools } from "./guardrails.ts";
import { assembleContext } from "./context.ts";
import { bunSdkTransport, resolveNativeBinary, type SdkTransport } from "./sdk-transport.ts";
import type { Pricing } from "./pricing.ts";
import type { Repo } from "./repo.ts";
import type { MemberRunner } from "./runner.ts";
import type { Agent, Receipt, Usage } from "./types.ts";

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

/** The native SDK boundary (mocked this phase). Returns the raw artifact markdown the member wrote. */
export interface NativeBoundary {
  invoke(req: InvokeRequest): { doc: string };
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

/**
 * The real Claude Agent SDK backing for `NativeBoundary` (phase 7) — a synchronous call behind the
 * exact same `invoke(req): { doc: string }` shape the mocked boundary already implements, via the
 * shared transport (sdk-transport.ts) rather than threading async through the Runner/AdapterRunner
 * call chain. The member's own definition (`req.agent.body`) plus the full §6-assembled recipe is
 * already `req.context` (context.ts item 1 is "agent definition body") — no separate system prompt
 * is layered on top; the model's only instruction is the assembled context itself, and its final
 * turn IS the artifact document (never a side-effected file write — levare's own validator re-checks
 * whatever text comes back, exactly as it already re-checks a CLI/mocked member's output).
 *
 * Env scoping (invariant 11, D5): the worker subprocess runs with exactly `req.env` (the member's
 * allowlisted grants) plus `ANTHROPIC_API_KEY` forwarded from the calling process — the platform
 * credential is not a connector grant, but every native call needs it to authenticate regardless of
 * what the member was granted. The key's value is read only to forward it into the spawn's env; it
 * is never logged, written to a file, or included in any commit.
 */
export function createSdkNativeBoundary(opts: SdkNativeBoundaryOptions = {}): NativeBoundary {
  const transport = opts.transport ?? bunSdkTransport;
  const baseEnv = opts.env ?? process.env;
  const timeoutMs = opts.timeoutMs ?? 600_000;
  // Resolved ONCE, explicitly — never left to the SDK's own implicit resolution inside the worker
  // (NOTES phase-7 K14: a live host showed that implicit lookup fail to find a platform binary that
  // genuinely existed as a sibling node_modules package; the same fix applied to OrchestratorBoundary
  // applies here for the identical reason, even though this boundary isn't wired into any live path yet).
  const pathToClaudeCodeExecutable = opts.pathToClaudeCodeExecutable ?? resolveNativeBinary() ?? undefined;
  return {
    invoke(req: InvokeRequest): { doc: string } {
      const env: Record<string, string | undefined> = { ...req.env };
      if (typeof baseEnv.ANTHROPIC_API_KEY === "string") env.ANTHROPIC_API_KEY = baseEnv.ANTHROPIC_API_KEY;
      const res = transport.run(
        { prompt: req.context, model: req.agent.model, tools: req.tools, allowedTools: req.tools, cwd: req.agent.cwd, pathToClaudeCodeExecutable },
        { env, timeoutMs },
      );
      if (!res.ok) throw new AdapterError(`native member '${req.member}' sdk call failed: ${res.error}`);
      return { doc: res.result };
    },
  };
}

export interface SpawnResult {
  stdout: string;
  exitCode: number;
  timedOut: boolean;
}

/** The CLI spawn boundary — wraps Bun.spawnSync so tests can drive the adapter without real procs. */
export interface CliSpawn {
  run(argv: string[], opts: { env: Record<string, string>; cwd?: string; timeoutMs: number }): SpawnResult;
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
      timeout: opts.timeoutMs,
    });
    return {
      stdout: proc.stdout ? new TextDecoder().decode(proc.stdout) : "",
      exitCode: proc.exitCode ?? -1,
      // Bun's own timeout flag — the authoritative signal. A slow-but-successful member (which exits
      // 0 on its own) is never misread as timed out, and a plain non-zero exit stays a non-zero exit.
      timedOut: proc.exitedDueToTimeout === true,
    };
  },
};

export interface AdapterRunnerOptions {
  pricing: Pricing;
  capabilities: Array<{ member: string; kind: string }>;
  native: NativeBoundary;
  remote: RemoteBoundary;
  spawn?: CliSpawn;
  /** Environment the allowlist draws from (default process.env). */
  baseEnv?: Record<string, string | undefined>;
  /**
   * Build the argv for a CLI member. Default substitutes the agent's `command` template
   * ({task}/{feature_repo}); replay's --stubs mode overrides this to spawn the stub member CLI.
   */
  cliCommand?: (req: InvokeRequest) => string[];
}

// Substitute the agent.command argv template. {task} = the flow step's kind/label; {feature_repo} =
// the project's checkout dir. Each template element maps to EXACTLY ONE argv element: the placeholder
// is replaced in place and the resulting element is kept whole — a substituted value containing
// spaces, quotes, or shell metacharacters stays a single argument and is never re-split. The command
// is handed to shell-less Bun.spawnSync(argv), so no element is ever interpreted by a shell.
function defaultCliCommand(req: InvokeRequest): string[] {
  const template = req.agent.command;
  if (!template || template.length === 0) throw new AdapterError(`cli agent '${req.member}' has no command template`);
  const feature = req.agent.cwd ?? ".";
  return template.map((element) => element.replace(/\{task\}/g, req.kind).replace(/\{feature_repo\}/g, feature));
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

  constructor(repo: Repo, opts: AdapterRunnerOptions) {
    this.repo = repo;
    this.opts = opts;
    this.spawn = opts.spawn ?? bunSpawn;
  }

  capabilities() {
    return this.opts.capabilities;
  }

  produce(member: string, kind: string, unit: string, project: string): { doc: string; receipt: Receipt } {
    const agent = this.repo.agents.get(member);
    if (!agent) throw new AdapterError(`no agent definition for member '${member}'`);

    const context = this.assemble(member, unit, project);
    const env = buildMemberEnv(this.repo, member, this.opts.baseEnv);
    const req: InvokeRequest = { agent, member, kind, unit, project, context, env, tools: allowedTools(agent) };

    let doc: string;
    switch (agent.kind) {
      case "native":
        doc = this.opts.native.invoke(req).doc;
        break;
      case "remote":
        doc = this.opts.remote.call(req).doc;
        break;
      case "cli":
        doc = this.runCli(agent, req);
        break;
      default:
        throw new AdapterError(`unknown agent kind '${(agent as Agent).kind}' for '${member}'`);
    }

    const receipt = normalizeReceipt(readUsage(doc), this.opts.pricing);
    return { doc, receipt };
  }

  private runCli(agent: Agent, req: InvokeRequest): string {
    const argv = (this.opts.cliCommand ?? defaultCliCommand)(req);
    const timeoutMs = (agent.timeout ?? 600) * 1000;
    // A `cwd` template that still holds an unresolved `{…}` (no feature repo bound this run) is not a
    // real directory — spawn in the default cwd rather than fail on a bogus path.
    const cwd = agent.cwd && !agent.cwd.includes("{") ? agent.cwd : undefined;
    const result = this.spawn.run(argv, { env: req.env, cwd, timeoutMs });
    if (result.timedOut) throw new AdapterError(`cli member '${req.member}' timed out after ${agent.timeout ?? 600}s`);
    if (result.exitCode !== 0) throw new AdapterError(`cli member '${req.member}' exited ${result.exitCode}`);
    return result.stdout;
  }

  // Assemble the §6 context. An empty consumed set ("no consumable produced yet") is a normal, silent
  // success — assembleContext simply returns a context with an empty consumed section. A THROW is a
  // genuine recipe error (missing agent/team/unit/step): that is surfaced on stderr, never silently
  // swallowed as if it were an empty context.
  private assemble(member: string, unit: string, project: string): string {
    try {
      return assembleContext(this.repo, { root: this.repo.root, agent: member, unit, capabilities: this.opts.capabilities });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`levare: context assembly error for member '${member}' (${project}/${unit}): ${msg}`);
      return "";
    }
  }
}

// Pull the reported usage block out of a raw artifact doc and validate its SHAPE before it is priced.
// A missing block, or a malformed one (not a map, or any field of the wrong type), records `unreported`
// (returns null) rather than a fabricated or crashing receipt — silence and garbage both read as "no
// trustworthy usage", never as a $0 run or a NaN estimate.
function readUsage(doc: string): Usage | null {
  let raw: unknown;
  try {
    raw = parseFrontmatter(doc).data.usage;
  } catch {
    return null;
  }
  return coerceUsage(raw);
}

function coerceUsage(raw: unknown): Usage | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return null; // a scalar/list usage field is malformed.
  const m = raw as Record<string, unknown>;
  // A present-but-wrong-typed field yields the `undefined` sentinel → the whole block is malformed.
  const asNum = (v: unknown): number | null | undefined =>
    v === undefined || v === null ? null : typeof v === "number" && Number.isFinite(v) ? v : undefined;
  const asStr = (v: unknown): string | null | undefined =>
    v === undefined || v === null ? null : typeof v === "string" ? v : undefined;
  const model = asStr(m.model);
  const tokens_in = asNum(m.tokens_in);
  const tokens_out = asNum(m.tokens_out);
  const usd = asNum(m.usd);
  const wall_clock_s = asNum(m.wall_clock_s);
  if ([model, tokens_in, tokens_out, usd, wall_clock_s].some((v) => v === undefined)) return null;
  return { model: model!, tokens_in: tokens_in!, tokens_out: tokens_out!, usd: usd!, wall_clock_s: wall_clock_s! };
}

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
      // Bun surfaces a timeout as a SIGTERM signal kill; treat any non-zero-without-output likewise.
      timedOut: proc.signalCode === "SIGTERM" || proc.signalCode === "SIGKILL",
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

// Substitute the agent.command template. {task} = the flow step's kind/label; {feature_repo} = the
// project's checkout dir (unknown here → a placeholder the caller can override via cliCommand).
function defaultCliCommand(req: InvokeRequest): string[] {
  const template = req.agent.command;
  if (!template) throw new AdapterError(`cli agent '${req.member}' has no command template`);
  const substituted = template
    .replace(/\{task\}/g, req.kind)
    .replace(/\{feature_repo\}/g, req.agent.cwd ?? ".");
  return substituted.split(/\s+/).filter(Boolean);
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

  // Best-effort context assembly; a member may run before any consumable exists, so a failure here is
  // non-fatal (the member still gets its definition/skills/knowledge via the boundary).
  private assemble(member: string, unit: string, project: string): string {
    try {
      return assembleContext(this.repo, { root: this.repo.root, agent: member, unit, capabilities: this.opts.capabilities });
    } catch {
      return "";
    }
  }
}

// Pull the reported usage block out of a raw artifact doc, tolerating its absence.
function readUsage(doc: string): Usage | null {
  try {
    const { data } = parseFrontmatter(doc);
    return (data.usage as Usage | null) ?? null;
  } catch {
    return null;
  }
}

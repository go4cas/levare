// levare doctor (§6). Walks the connector registry and reports, per connector, whether its required
// env var *names* are present in the environment and whether its CLI/MCP backend is reachable —
// "before anything runs". It reads no secret values, only presence, honouring invariant 11.
//
// The headline status is env presence (ok when every named var is present, else missing-env) — this
// is the §11 acceptance surface ("one ok, one missing-env"). CLI availability / MCP server identity
// are reported as advisory lines and do not flip the status: a missing binary is a warning to fix,
// not a validation failure of the connector definition. Determinism comes from injecting both the
// env probe and the CLI probe; the CLI wires process.env presence and Bun.which.

import type { Connector } from "./types.ts";
import type { EnvProvenance } from "./dotenv.ts";
import type { OrchestratorStatus } from "./orchestrator-status.ts";
import type { VersionInfo } from "./version.ts";

/** Whether `docs/orchestrator-prompt.md` was actually readable at doctor-run time, and from where —
 * NOTES DIST4/DIST5: independent of `orchestrator`'s on/off state above, which (since DIST5) reflects
 * only the credential/native-binary precondition, compiled or not — the SDK worker spawn that DIST4
 * once couldn't run under `--compile` now self-invokes correctly either way. This line remains its
 * own, separate proof that the prompt itself loads correctly under `--compile`. */
export interface PromptCheck {
  path: string;
  ok: boolean;
  bytes?: number;
  error?: string;
}

/** Presence-only view of the environment — never exposes values (invariant 11). */
export interface EnvProbe {
  has(name: string): boolean;
}

/** Resolve whether a CLI command is runnable, without invoking it. */
export type CliProbe = (command: string) => "found" | "not-found";

export interface ConnectorHealth {
  name: string;
  kind: "mcp" | "cli";
  // NOTES C13: which mode this connector declares. "subscription" carries `warning` below — doctor
  // must never let this connector's report read as "levare has this scoped" when it doesn't.
  auth: "env" | "subscription";
  plan?: string;
  warning?: string;
  // NOTES C11 part 4: `provenance` names WHERE a present variable came from — '.env' or the shell —
  // so "why does this work on my machine and not in CI" has a visible answer. `undefined` when the
  // caller didn't pass a provenance map (every pre-C11 call site; presence-only, as before) or the
  // variable is absent.
  env: Array<{ name: string; present: boolean; provenance?: EnvProvenance }>;
  status: "ok" | "missing-env";
  /** For cli connectors: the command and whether it resolves on PATH. */
  cli?: { command: string; probe: "found" | "not-found" };
  /** For mcp connectors: the server name. */
  mcp?: { server: string };
}

export function diagnose(connectors: Connector[], env: EnvProbe, probe: CliProbe, provenance?: Map<string, EnvProvenance>): ConnectorHealth[] {
  return [...connectors]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => {
      const envChecks = c.env.map((name) => {
        const present = env.has(name);
        return { name, present, provenance: present ? (provenance?.get(name) ?? "shell") : undefined };
      });
      // A subscription connector names no env (validated), so this is vacuously "ok" — env presence
      // was never the thing to check for it; see `warning` for what IS true about it instead.
      const status: ConnectorHealth["status"] = envChecks.every((e) => e.present) ? "ok" : "missing-env";
      const health: ConnectorHealth = { name: c.name, kind: c.kind, auth: c.auth, env: envChecks, status };
      if (c.plan) health.plan = c.plan;
      if (c.auth === "subscription") {
        // NOTES C13: stated plainly, every time — the board and this report must never imply a
        // scoping guarantee levare is not providing.
        health.warning = `levare cannot scope this credential — any member that can spawn \`${c.command ?? c.name}\` can use this login. The grant is documentation, not enforcement.`;
      }
      if (c.kind === "cli" && c.command) health.cli = { command: c.command, probe: probe(c.command) };
      if (c.kind === "mcp" && c.server) health.mcp = { server: c.server };
      return health;
    });
}

/** Render the health report as the exact text `levare doctor` prints. `orchestrator`, when given,
 * prints the Orchestrator boundary's own on/off state ahead of the connector report (NOTES C11 part
 * 3: "report the Orchestrator's boundary in `levare doctor`") — the same status the board's header
 * indicator shows, computed by the same function (orchestrator-status.ts), so the two can never
 * disagree about whether the Orchestrator is reachable.
 *
 * `versionInfo`, when given, prints the run mode first (NOTES DIST1) — compiled binary vs. source
 * run — since a compiled binary and the source tree it was built from can drift, and "is this the
 * code I think it is?" needs a visible answer. A full staleness check (comparing the build commit
 * against the studio/source HEAD) is deferred; this only makes the run mode legible. */
export function formatDoctor(health: ConnectorHealth[], orchestrator?: OrchestratorStatus, versionInfo?: VersionInfo, promptCheck?: PromptCheck): string {
  const out: string[] = [];
  if (versionInfo) {
    out.push(`run mode: ${versionInfo.build ? `compiled (build ${versionInfo.build.commit})` : "source/dev"}`);
    out.push("");
  }
  if (orchestrator) {
    out.push(`orchestrator: ${orchestrator.available ? "on" : "off"} · ${orchestrator.reason}`);
    out.push("");
  }
  if (promptCheck) {
    out.push(promptCheck.ok ? `orchestrator prompt: readable (${promptCheck.bytes} bytes) at ${promptCheck.path}` : `orchestrator prompt: ERROR — ${promptCheck.error} (${promptCheck.path})`);
    out.push("");
  }
  out.push(`levare doctor · ${health.length} connector${health.length === 1 ? "" : "s"}`);
  for (const h of health) {
    out.push("");
    out.push(`${h.name} · ${h.kind}`);
    out.push(`  auth: ${h.auth}${h.plan ? ` · ${h.plan}` : ""}`);
    if (h.warning) out.push(`  ⚠ ${h.warning}`);
    for (const e of h.env) out.push(`  env ${e.name} ${e.present ? `present (${e.provenance})` : "missing"}`);
    if (h.cli) out.push(`  cli ${h.cli.command} ${h.cli.probe === "found" ? "on PATH" : "not found on PATH"}`);
    if (h.mcp) out.push(`  mcp ${h.mcp.server}`);
    out.push(`  → ${h.status}`);
  }
  return out.join("\n") + "\n";
}

export function runDoctor(
  connectors: Connector[],
  env: EnvProbe,
  probe: CliProbe,
  provenance?: Map<string, EnvProvenance>,
  orchestrator?: OrchestratorStatus,
  versionInfo?: VersionInfo,
  promptCheck?: PromptCheck,
): string {
  return formatDoctor(diagnose(connectors, env, probe, provenance), orchestrator, versionInfo, promptCheck);
}

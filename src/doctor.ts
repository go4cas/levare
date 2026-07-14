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

/** Presence-only view of the environment — never exposes values (invariant 11). */
export interface EnvProbe {
  has(name: string): boolean;
}

/** Resolve whether a CLI command is runnable, without invoking it. */
export type CliProbe = (command: string) => "found" | "not-found";

export interface ConnectorHealth {
  name: string;
  kind: "mcp" | "cli";
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
      const status: ConnectorHealth["status"] = envChecks.every((e) => e.present) ? "ok" : "missing-env";
      const health: ConnectorHealth = { name: c.name, kind: c.kind, env: envChecks, status };
      if (c.kind === "cli" && c.command) health.cli = { command: c.command, probe: probe(c.command) };
      if (c.kind === "mcp" && c.server) health.mcp = { server: c.server };
      return health;
    });
}

/** Render the health report as the exact text `levare doctor` prints. `orchestrator`, when given,
 * prints the Orchestrator boundary's own on/off state ahead of the connector report (NOTES C11 part
 * 3: "report the Orchestrator's boundary in `levare doctor`") — the same status the board's header
 * indicator shows, computed by the same function (orchestrator-status.ts), so the two can never
 * disagree about whether the Orchestrator is reachable. */
export function formatDoctor(health: ConnectorHealth[], orchestrator?: OrchestratorStatus): string {
  const out: string[] = [];
  if (orchestrator) {
    out.push(`orchestrator: ${orchestrator.available ? "on" : "off"} · ${orchestrator.reason}`);
    out.push("");
  }
  out.push(`levare doctor · ${health.length} connector${health.length === 1 ? "" : "s"}`);
  for (const h of health) {
    out.push("");
    out.push(`${h.name} · ${h.kind}`);
    for (const e of h.env) out.push(`  env ${e.name} ${e.present ? `present (${e.provenance})` : "missing"}`);
    if (h.cli) out.push(`  cli ${h.cli.command} ${h.cli.probe === "found" ? "on PATH" : "not found on PATH"}`);
    if (h.mcp) out.push(`  mcp ${h.mcp.server}`);
    out.push(`  → ${h.status}`);
  }
  return out.join("\n") + "\n";
}

export function runDoctor(connectors: Connector[], env: EnvProbe, probe: CliProbe, provenance?: Map<string, EnvProvenance>, orchestrator?: OrchestratorStatus): string {
  return formatDoctor(diagnose(connectors, env, probe, provenance), orchestrator);
}

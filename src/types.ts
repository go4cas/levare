// levare domain types (PRD §5). These are the in-memory shapes the Runner walks: teams and their
// declarative flows, agents, type templates, projects, work units, and artifacts. Loaders in
// repo.ts parse the markdown-with-frontmatter files (via the phase-1 yaml parser) into these.
//
// The flow is the only structurally interesting frontmatter: an ordered list whose entries are one
// of three shapes — a `step`, a `gate`, or a `loop` block (§5). We normalize the raw parsed maps
// into a discriminated union (FlowNode) so the Runner never re-inspects loose YAML shapes.

import type { YamlValue } from "./yaml.ts";

// ---------------------------------------------------------------------------
// Flow (team.flow) — the declarative sequence the Runner executes (§6)
// ---------------------------------------------------------------------------

export interface FlowStep {
  kind: "step";
  /** Task label from the flow step (§6 context recipe item 6); resolves to a (member, kind). */
  step: string;
}
export interface FlowGate {
  kind: "gate";
  /** Only `human` gates exist today; the field is kept for forward-compatibility. */
  who: string;
}
export interface FlowLoop {
  kind: "loop";
  /** The two step labels the loop alternates, e.g. [spec, review]. */
  between: [string, string];
  /** A status condition on a named kind, e.g. `spec.approved`. */
  until: string;
  maxRounds: number;
  /** What to do when max_rounds is reached without `until`; only `gate` today. */
  onExhaust: string;
}
export type FlowNode = FlowStep | FlowGate | FlowLoop;

// ---------------------------------------------------------------------------
// Registry entities (§5)
// ---------------------------------------------------------------------------

export interface Team {
  name: string;
  consumes: string[];
  produces: string[];
  members: string[];
  flow: FlowNode[];
  mode: "declarative" | "led";
  style: { color: string };
  guardrails?: { protected_paths?: string[]; never?: string[] };
  knowledge?: string[];
  /** Team charter (markdown body), injected into member context (§6). */
  charter: string;
}

export interface Agent {
  name: string;
  kind: "native" | "cli" | "remote";
  model?: string;
  command?: string;
  cwd?: string;
  timeout?: number;
  result?: string;
  server?: string;
  skills?: string[];
  tools?: string[];
  knowledge?: string[];
  style: { avatar: string };
  body: string;
}

export interface TypeTemplate {
  name: string;
  glyph: string;
  expects: string[];
  gates: string[];
  output?: string;
  /** Spike/timebox semantics, Runner-enforced (§5). */
  timebox?: string | null;
  /** Research reports promote to knowledge/ through a gate (§5). */
  promotable_to?: string | null;
}

export interface Project {
  name: string;
  repo: string;
  remote: string | null;
  default_branch: string;
  deploy: string | null;
  pace: "auto" | "step";
  /** One-level merge over team defaults (§5). */
  overrides?: Record<string, YamlValue>;
  /** House rules (markdown body), injected into every member context for this project (§6). */
  houseRules: string;
}

export type WorkUnitStatus = "active" | "paused" | "blocked" | "shipped" | "abandoned";

export interface WorkUnit {
  type: string;
  status: WorkUnitStatus;
  project: string;
  unit: string;
  /** Start-gate condition — a unit with unmet `after:` is invisible to the walk (§6, NOTES A6). */
  after?: string[];
  timebox?: string | null;
  /** USD; crossing the ledger sum raises a budget gate (§10). */
  budget?: number | null;
  /** Directory holding the unit and its artifacts. */
  dir: string;
}

export type ArtifactStatus =
  | "draft"
  | "in-review"
  | "approved"
  | "rejected"
  | "superseded"
  | "blocked";

export interface Artifact {
  kind: string;
  id: string;
  unit: string;
  project: string;
  status: ArtifactStatus;
  produced_by: string;
  consumes: string[];
  supersedes: string | null;
  approved_by: string | null;
  created: string;
  files: string[];
  usage?: Usage | null;
  /** First body paragraph is the display summary (NOTES A8). */
  body?: string;
}

export interface Usage {
  model: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  usd: number | null;
  wall_clock_s: number | null;
}

// ---------------------------------------------------------------------------
// Flow parsing — normalize raw frontmatter `flow:` into FlowNode[]
// ---------------------------------------------------------------------------

export class FlowError extends Error {}

export function parseFlow(raw: YamlValue, teamName: string): FlowNode[] {
  if (!Array.isArray(raw)) throw new FlowError(`team '${teamName}' flow must be a list`);
  return raw.map((entry, i) => parseFlowNode(entry, teamName, i));
}

function parseFlowNode(entry: YamlValue, teamName: string, i: number): FlowNode {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw new FlowError(`team '${teamName}' flow entry ${i} must be a mapping`);
  }
  const m = entry as Record<string, YamlValue>;
  if ("step" in m) return { kind: "step", step: str(m.step, `${teamName} flow[${i}].step`) };
  if ("gate" in m) return { kind: "gate", who: str(m.gate, `${teamName} flow[${i}].gate`) };
  if ("loop" in m) {
    const l = m.loop;
    if (l === null || typeof l !== "object" || Array.isArray(l)) {
      throw new FlowError(`team '${teamName}' flow[${i}].loop must be a mapping`);
    }
    const lm = l as Record<string, YamlValue>;
    const between = lm.between;
    if (!Array.isArray(between) || between.length !== 2 || !between.every((x) => typeof x === "string")) {
      throw new FlowError(`team '${teamName}' loop.between must be a list of exactly two step labels`);
    }
    return {
      kind: "loop",
      between: [between[0] as string, between[1] as string],
      until: str(lm.until, `${teamName} loop.until`),
      maxRounds: num(lm.max_rounds, `${teamName} loop.max_rounds`),
      onExhaust: str(lm.on_exhaust, `${teamName} loop.on_exhaust`),
    };
  }
  throw new FlowError(`team '${teamName}' flow entry ${i} is neither step, gate, nor loop`);
}

function str(v: YamlValue, where: string): string {
  if (typeof v !== "string") throw new FlowError(`${where} must be a string`);
  return v;
}
function num(v: YamlValue, where: string): number {
  if (typeof v !== "number") throw new FlowError(`${where} must be a number`);
  return v;
}

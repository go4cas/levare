// The real Claude Agent SDK backing for `OrchestratorBoundary` (§7, phase 7). `interpret`/`narrate`
// stay exactly the shapes orchestrator.ts's `handle()` already dispatches against — synchronous,
// text/Intent in, text/Intent out — per the phase directive ("back the two boundaries behind their
// existing interfaces... the dispatch logic, gate resolution, and repo operations do not change").
// The real async SDK call happens in a separate worker process (sdk-transport.ts); this module is
// the pure request/response shaping around that transport.
//
// The Orchestrator's system prompt (docs/orchestrator-prompt.md, the Conductor-authored voice) is
// loaded from disk VERBATIM — read once, passed to the SDK's `systemPrompt` option unmodified, never
// edited or appended to. `narrate()` sends the already-computed factual line as the user turn under
// that system prompt so the model phrases it in the Orchestrator's voice. `interpret()` uses the
// SDK's native `outputFormat: {type: "json_schema"}` (confirmed in the shipped sdk.d.ts) instead of
// asking the model to hand-format JSON in prose — the same verbatim system prompt still applies (its
// own §"Intent to operations" already describes translating free text "through your tools"; a JSON
// schema constraint is the mechanical realization of that, not a prompt edit).

import { readFileSync } from "node:fs";
import type { Intent, OrchestratorBoundary } from "./orchestrator.ts";
import { deterministicBoundary } from "./orchestrator.ts";
import type { Verb } from "./runner.ts";
import { bunSdkTransport, hasAnthropicCredentials, type SdkTransport } from "./sdk-transport.ts";

export const ORCHESTRATOR_PROMPT_PATH = new URL("../docs/orchestrator-prompt.md", import.meta.url).pathname;

/** Read the Orchestrator's system prompt from disk verbatim — never embedded, never edited. */
export function loadOrchestratorPromptSource(path: string = ORCHESTRATOR_PROMPT_PATH): string {
  return readFileSync(path, "utf8");
}

const DEFAULT_MODEL = "claude-opus-4-8";

const VERBS: Verb[] = ["approve", "request", "reject", "start", "notyet", "rescope", "continue", "raise", "stop"];

// A flat schema (every field optional except `kind`) rather than a discriminated `oneOf` — simpler
// and more reliably honored by structured-output json_schema mode; `coerceIntent` below narrows to
// the exact Intent shape per kind, exactly as adapters.ts#coerceUsage narrows a loosely-typed blob
// rather than trusting the model's output wholesale.
const INTENT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["briefing", "gate-decision", "capture-idea", "open-unit", "promote-idea", "stats", "unknown"] },
    target: { type: "string" },
    verb: { type: "string", enum: VERBS },
    note: { type: "string" },
    name: { type: "string" },
    pitch: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    project: { type: "string" },
    unit: { type: "string" },
    type: { type: "string" },
    after: { type: "array", items: { type: "string" } },
    idea: { type: "string" },
    text: { type: "string" },
  },
  required: ["kind"],
  additionalProperties: false,
};

// Never trust the model's structured output wholesale: narrow it into exactly one Intent shape, and
// fall back to `unknown` (never throw, never fabricate a field) on anything that doesn't fit —
// mirroring adapters.ts#coerceUsage's "malformed input records a safe default, never a crash".
export function coerceIntent(raw: unknown, fallbackText: string): Intent {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { kind: "unknown", text: fallbackText };
  const m = raw as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  const strArr = (v: unknown): string[] | undefined => (Array.isArray(v) && v.every((x) => typeof x === "string") ? v : undefined);

  switch (m.kind) {
    case "briefing":
      return { kind: "briefing" };
    case "stats":
      return { kind: "stats" };
    case "gate-decision": {
      const target = str(m.target);
      const verb = str(m.verb);
      if (!target || !verb || !VERBS.includes(verb as Verb)) return { kind: "unknown", text: fallbackText };
      const note = str(m.note);
      return { kind: "gate-decision", target, verb: verb as Verb, note: note || undefined };
    }
    case "capture-idea": {
      const name = str(m.name);
      const pitch = str(m.pitch);
      if (!name || !pitch) return { kind: "unknown", text: fallbackText };
      return { kind: "capture-idea", name, pitch, tags: strArr(m.tags) };
    }
    case "open-unit": {
      const project = str(m.project);
      const unit = str(m.unit);
      const type = str(m.type);
      if (!project || !unit || !type) return { kind: "unknown", text: fallbackText };
      return { kind: "open-unit", project, unit, type, after: strArr(m.after) };
    }
    case "promote-idea": {
      const idea = str(m.idea);
      const project = str(m.project);
      const unit = str(m.unit);
      if (!idea || !project || !unit) return { kind: "unknown", text: fallbackText };
      return { kind: "promote-idea", idea, project, unit };
    }
    default:
      return { kind: "unknown", text: fallbackText };
  }
}

export interface SdkOrchestratorBoundaryOptions {
  transport?: SdkTransport;
  model?: string;
  systemPromptPath?: string;
  /** Environment the transport's spawned worker draws from (default process.env). Never logged. */
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

/** The real SDK-driven `OrchestratorBoundary`: `interpret`/`narrate` behind the exact same
 * synchronous interface the deterministic boundary implements (adapters.ts's NativeBoundary pattern,
 * mirrored here for the Orchestrator). */
export function createSdkOrchestratorBoundary(opts: SdkOrchestratorBoundaryOptions = {}): OrchestratorBoundary {
  const transport = opts.transport ?? bunSdkTransport;
  const model = opts.model ?? DEFAULT_MODEL;
  const systemPrompt = loadOrchestratorPromptSource(opts.systemPromptPath);
  const env = opts.env ?? process.env;
  const timeoutMs = opts.timeoutMs ?? 120_000;

  return {
    interpret(text: string): Intent {
      const res = transport.run(
        { prompt: text, systemPrompt, model, tools: [], allowedTools: [], outputFormat: { type: "json_schema", schema: INTENT_SCHEMA } },
        { env, timeoutMs },
      );
      if (!res.ok) return { kind: "unknown", text };
      return coerceIntent(res.structuredOutput, text);
    },
    narrate(prompt: string): string {
      const res = transport.run({ prompt, systemPrompt, model, tools: [], allowedTools: [] }, { env, timeoutMs });
      // A transport failure must never surface as a fabricated Orchestrator line — fall back to the
      // plain computed fact (identical to the deterministic boundary's own narrate) rather than lie.
      if (!res.ok) return prompt;
      return res.result;
    },
  };
}

/**
 * Select the real SDK-driven boundary when the environment carries API credentials, else the
 * deterministic regex boundary — the explicit offline fallback (goal: "selected automatically when
 * no API key is present in the environment"). This is the one seam `levare serve`/the CLI call; it
 * never inspects the key's value, only its presence (invariant 11).
 */
export function selectOrchestratorBoundary(
  env: Record<string, string | undefined> = process.env,
  opts: Omit<SdkOrchestratorBoundaryOptions, "env"> = {},
): OrchestratorBoundary {
  return hasAnthropicCredentials(env) ? createSdkOrchestratorBoundary({ ...opts, env }) : deterministicBoundary;
}

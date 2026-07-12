// The real Claude Agent SDK backing for `OrchestratorBoundary` (§7, phase 7). `interpret`/`narrate`
// are async — the boundary interface itself (orchestrator.ts) is the one seam that carries the SDK's
// I/O; `handle()`'s dispatch (the switch, gate resolution, repo operations) is unchanged, it just
// awaits this boundary instead of calling it inline. The real SDK call happens in a separate worker
// process reached over `AsyncSdkTransport` (sdk-transport.ts, spawned via non-blocking `Bun.spawn` —
// NOT `Bun.spawnSync`, which was found to freeze the entire `levare serve` event loop for every
// concurrent connection, not just the in-flight one; see NOTES phase-7 K9). This module is the pure
// request/response shaping around that transport.
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
import type { Receipt } from "./types.ts";
import {
  asyncSdkTransport,
  hasAnthropicCredentials,
  checkSdkPreconditionsCached,
  resolveNativeBinary,
  type AsyncSdkTransport,
  type SdkPreconditionOptions,
} from "./sdk-transport.ts";

export const ORCHESTRATOR_PROMPT_PATH = new URL("../docs/orchestrator-prompt.md", import.meta.url).pathname;

/** Read the Orchestrator's system prompt from disk verbatim — never embedded, never edited. */
export function loadOrchestratorPromptSource(path: string = ORCHESTRATOR_PROMPT_PATH): string {
  return readFileSync(path, "utf8");
}

// §10, NOTES phase-7 K16: surface the SDK's OWN reported cost/tokens (never an estimate) so a
// Conductor running `levare serve` can actually see what each Orchestrator call cost. This is
// visibility only, not persistence — there is no unit/artifact for a chat message to attach a ledger
// entry to (see K16 for why full ledger integration is deliberately out of scope here).
function logReceipt(call: "interpret" | "narrate", receipt: Receipt | undefined): void {
  if (!receipt) return;
  const usd = receipt.usd !== null ? `$${receipt.usd.toFixed(4)}` : "usd unreported";
  const tokens = receipt.tokens_in !== null && receipt.tokens_out !== null ? `${receipt.tokens_in} in / ${receipt.tokens_out} out` : "tokens unreported";
  console.error(`levare: Orchestrator ${call}() usage — ${receipt.model ?? "model unreported"} · ${tokens} · ${usd}`);
}

// A live host spent $0.055 on a two-word "stats" reply — Opus, on every call, including trivial
// intent classification, is dramatically more than that job needs (NOTES phase-7 K16). Default to a
// much cheaper, faster model; `LEVARE_ORCHESTRATOR_MODEL` overrides it as an interim, environment-
// based "studio-level setting" (a real registry field is the correct long-term home — see NOTES K16
// for why that's deliberately out of scope for this fix-up cycle).
const DEFAULT_MODEL = "claude-sonnet-5";

function resolveOrchestratorModel(env: Record<string, string | undefined>): string {
  return env.LEVARE_ORCHESTRATOR_MODEL || DEFAULT_MODEL;
}

/**
 * Raised by `interpret()` when the SDK TRANSPORT itself fails — the worker never ran, exited
 * non-zero, timed out, or produced unparseable output. This is deliberately distinct from a
 * successful call whose model answer doesn't classify into a known Intent (that stays a legitimate
 * `{kind:"unknown"}`, via `coerceIntent`): a transport failure must never impersonate a valid
 * classification, the same lesson validate.ts's immutability check already enforces for its own
 * fail-open states (NOTES A4 — "every early-exit valid state is an escape hatch; make the taken state
 * observable"). `narrate()` intentionally does NOT throw on the same failure — see NOTES phase-7 K8.
 */
export class OrchestratorSdkError extends Error {}

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
  transport?: AsyncSdkTransport;
  model?: string;
  systemPromptPath?: string;
  /** Environment the transport's spawned worker draws from (default process.env). Never logged. */
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  /** Explicit override for the resolved native-binary path (test-only) — see
   * `resolveNativeBinaryPath` default below and NOTES phase-7 K14. */
  pathToClaudeCodeExecutable?: string;
  /** Test-only: threaded into `resolveNativeBinary` when `pathToClaudeCodeExecutable` above is unset. */
  binaryResolution?: { platform?: string; arch?: string; requireFrom?: string };
}

/** The real SDK-driven `OrchestratorBoundary`: `interpret`/`narrate` behind the exact same async
 * interface the deterministic boundary implements — non-blocking end to end, so a slow or hung SDK
 * call never freezes `levare serve`'s event loop for other requests (NOTES phase-7 K9). */
export function createSdkOrchestratorBoundary(opts: SdkOrchestratorBoundaryOptions = {}): OrchestratorBoundary {
  const transport = opts.transport ?? asyncSdkTransport;
  const systemPrompt = loadOrchestratorPromptSource(opts.systemPromptPath);
  const env = opts.env ?? process.env;
  const model = opts.model ?? resolveOrchestratorModel(env);
  // Well under a minute (NOTES phase-7 K15) — an Orchestrator chat reply is a conversational round
  // trip, not a long-running member task; a live successful call took ~9s. Any caller's own outer
  // timeout must stay comfortably LONGER than this, never shorter — the reverse is what let a hung
  // call outlive the test that was supposed to catch it.
  const timeoutMs = opts.timeoutMs ?? 45_000;
  // Resolved ONCE, here, at construction time — never left to the SDK's own implicit resolution
  // inside the worker (NOTES phase-7 K14: a live host showed that implicit lookup fail to find a
  // platform binary that genuinely existed as a sibling node_modules package). Every request this
  // boundary makes carries the SAME resolved path, so "the probe says viable" and "the real call
  // actually uses that binary" can never diverge — they're the same function call.
  const br = opts.binaryResolution;
  const pathToClaudeCodeExecutable = opts.pathToClaudeCodeExecutable ?? resolveNativeBinary(br?.platform, br?.arch, br?.requireFrom) ?? undefined;

  return {
    async interpret(text: string): Promise<Intent> {
      const res = await transport.run(
        { prompt: text, systemPrompt, model, tools: [], allowedTools: [], outputFormat: { type: "json_schema", schema: INTENT_SCHEMA }, pathToClaudeCodeExecutable },
        { env, timeoutMs },
      );
      // A transport failure (worker never ran / exited non-zero / timed out / unparseable output) is
      // NOT a legitimate "unknown" intent — "unknown" is a real classification a live model can
      // genuinely return, and silently mapping a system failure onto it would be indistinguishable
      // from a working call that just didn't recognize the phrase. Surface it loudly instead: log to
      // stderr (never the value of any credential — `res.error` is the transport's own diagnostic
      // text) and throw, so the caller sees exactly what failed (exit code / stderr / parse error).
      if (!res.ok) {
        console.error(`levare: Orchestrator SDK interpret() failed: ${res.error}`);
        throw new OrchestratorSdkError(`Orchestrator SDK interpret() failed: ${res.error}`);
      }
      logReceipt("interpret", res.receipt);
      return coerceIntent(res.structuredOutput, text);
    },
    async narrate(prompt: string): Promise<string> {
      const res = await transport.run({ prompt, systemPrompt, model, tools: [], allowedTools: [], pathToClaudeCodeExecutable }, { env, timeoutMs });
      // A transport failure must never surface as a fabricated Orchestrator line — fall back to the
      // plain computed fact (identical to the deterministic boundary's own narrate) rather than lie.
      if (!res.ok) return prompt;
      logReceipt("narrate", res.receipt);
      return res.result;
    },
  };
}

export type SelectOrchestratorBoundaryOptions = Omit<SdkOrchestratorBoundaryOptions, "env"> & {
  /** Test-only: threaded into `checkSdkPreconditionsCached` — see sdk-transport.ts. */
  precondition?: SdkPreconditionOptions;
};

/**
 * Select the real SDK-driven boundary when the environment carries API credentials AND the SDK's own
 * local preconditions (credential + a resolvable native binary — NOTES phase-7 K13) are met, else the
 * deterministic regex boundary — the explicit offline fallback (goal: "selected automatically when no
 * API key is present in the environment"). The precondition check is fast and local (no network, no
 * subprocess): a genuinely broken install (missing binary) is detected and falls back to offline mode
 * WITHOUT ever attempting — and timing out on — a real spawn. A credential that resolves but is
 * invalid, or any other genuine runtime failure (network, credit, model error), is NOT something this
 * local check can know; those still degrade per-request exactly as they already did (K11). This is
 * the one seam `levare serve`/the CLI call; it never inspects the key's value, only its presence
 * (invariant 11).
 */
export function selectOrchestratorBoundary(
  env: Record<string, string | undefined> = process.env,
  opts: SelectOrchestratorBoundaryOptions = {},
): OrchestratorBoundary {
  if (!hasAnthropicCredentials(env)) return deterministicBoundary;
  const { precondition, ...boundaryOpts } = opts;
  const check = checkSdkPreconditionsCached(env, precondition);
  if (!check.viable) return deterministicBoundary;
  // Reuse the EXACT path the precondition probe just resolved, rather than letting
  // createSdkOrchestratorBoundary re-resolve it — "the probe says viable" and "the real call uses
  // that binary" are then provably the same value, not just the same algorithm (NOTES K14).
  return createSdkOrchestratorBoundary({ ...boundaryOpts, env, pathToClaudeCodeExecutable: boundaryOpts.pathToClaudeCodeExecutable ?? check.binaryPath });
}

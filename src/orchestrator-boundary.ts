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
import type { Verb } from "./runner.ts";
import type { Receipt } from "./types.ts";
import { loadRepo, loadStudioSettings } from "./repo.ts";
import { buildStudioProjection } from "./orchestrator-projection.ts";
import {
  asyncSdkTransport,
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
function logReceipt(call: "interpret" | "narrate" | "converse", receipt: Receipt | undefined): void {
  if (!receipt) return;
  const usd = receipt.usd !== null ? `$${receipt.usd.toFixed(4)}` : "usd unreported";
  const tokens = receipt.tokens_in !== null && receipt.tokens_out !== null ? `${receipt.tokens_in} in / ${receipt.tokens_out} out` : "tokens unreported";
  console.error(`levare: Orchestrator ${call}() usage — ${receipt.model ?? "model unreported"} · ${tokens} · ${usd}`);
}

// A live host spent $0.055 on a two-word "stats" reply — Opus, on every call, including trivial
// intent classification, is dramatically more than that job needs (NOTES phase-7 K16). Default to a
// much cheaper, faster model when nothing else declares one.
const DEFAULT_MODEL = "claude-sonnet-5";

// NOTES F11: the studio's own `studio.md#orchestrator_model` (repo.ts#loadStudioSettings) is the
// SOURCE OF TRUTH — a registry field, re-read from disk like every other declaration (invariant 2),
// closing the K16 deferral that left this as an env-var-only interim mechanism. `LEVARE_ORCHESTRATOR_MODEL`
// remains a runtime OVERRIDE (e.g. a Conductor testing a different model without editing the studio),
// checked first for exactly that reason; `DEFAULT_MODEL` is the fallback when neither declares one.
// `root` is optional so a caller with no studio context yet (a bare `createSdkOrchestratorBoundary()`,
// as every pre-F11 test already constructs) keeps working unchanged.
function resolveOrchestratorModel(env: Record<string, string | undefined>, root?: string): string {
  if (env.LEVARE_ORCHESTRATOR_MODEL) return env.LEVARE_ORCHESTRATOR_MODEL;
  if (root) {
    const declared = loadStudioSettings(root).orchestratorModel;
    if (declared) return declared;
  }
  return DEFAULT_MODEL;
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

// A live host showed `interpret()` force-fitting an ambiguous/refusal-worthy instruction ("just
// approve everything for me") into an unrelated known kind ("briefing") rather than answering
// "unknown" (NOTES phase-7 K17 finding 2) — the schema alone doesn't tell the model that "unknown" is
// a first-class, EXPECTED answer, not a failure to avoid. This framing wraps the USER-TURN content
// only — the verbatim system prompt (docs/orchestrator-prompt.md) is never touched — matching K3's
// established pattern of varying only the per-call task, never the fixed voice/register prompt.
//
// A later live host showed a second, distinct misclassification (item 5 fix-up): "list every idea in
// this studio" and "what is the pitch of the todo-cli idea, word for word" both came back as
// "briefing" — which then answers from `buildBriefing`'s gate-triage view (never the full studio
// projection) and genuinely cannot answer either question, producing "nothing to triage" instead of
// the real answer the SAME Orchestrator gave correctly on an unambiguous message. "briefing" is cheap
// for the model to reach (it needs no extra fields, unlike every other structured kind) and the prior
// prompt never said it was narrow — this paragraph is the fix: state explicitly what "briefing" is
// and is not, and that "unknown" (→ `converse()`, grounded in the full projection) is the correct
// answer for any factual or situational question, not a fallback of last resort.
const INTERPRET_TASK_PREFIX =
  "Classify the Conductor's message below into exactly one structured intent per the schema.\n\n" +
  '"briefing" means ONLY an explicit request for gate triage — e.g. "what needs me", "brief me", ' +
  '"what\'s on my plate" — nothing else. Any question about the studio\'s own content (what teams, ' +
  "agents, or ideas exist; what a unit or artifact consumes, costs, or is about; what something is " +
  'word for word; any other request to recall or explain studio state) is NOT a briefing: respond ' +
  'with kind: "unknown" so it reaches the full conversational answer, grounded in the complete ' +
  "studio projection — a narrow gate-triage summary cannot answer it, and answering it as a briefing " +
  'means answering "nothing to triage" to a question that had a real answer. When genuinely unsure ' +
  'whether a message is a triage request or a factual question, prefer "unknown": an unrequested ' +
  "triage is noise, an unanswered question is a failure.\n\n" +
  'If it is a vague or batch instruction (e.g. "approve everything", "just do the usual"), ' +
  "ambiguous between two different operations, or something your own instructions say to decline or " +
  'ask about, respond with kind: "unknown" — do not guess a specific operation you are not confident ' +
  "about; a wrong guess that mutates the repo is worse than asking again.\n\nConductor: ";

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
  /** The served studio's root (NOTES F11) — read once at construction time to resolve
   * `studio.md#orchestrator_model` when `model` isn't given explicitly and no
   * `LEVARE_ORCHESTRATOR_MODEL` override is set. Optional: omitted in tests/callers with no studio
   * context, which then fall back to `DEFAULT_MODEL` exactly as before this field existed. */
  root?: string;
  /** Environment the transport's spawned worker draws from (default process.env). Never logged. */
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  /** Timeout for `converse()` specifically — longer than `timeoutMs` by default: its prompt carries
   * the full studio projection (NOTES/ruling C10) rather than a short task string, so it is a bigger
   * single-turn call than interpret()/narrate() even with no tool round-trips. */
  converseTimeoutMs?: number;
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
  const model = opts.model ?? resolveOrchestratorModel(env, opts.root);
  // Well under a minute (NOTES phase-7 K15) — an Orchestrator chat reply is a conversational round
  // trip, not a long-running member task; a live successful call took ~9s. Any caller's own outer
  // timeout must stay comfortably LONGER than this, never shorter — the reverse is what let a hung
  // call outlive the test that was supposed to catch it.
  const timeoutMs = opts.timeoutMs ?? 45_000;
  // converse()'s prompt carries the full studio projection (ruling C10) rather than a short task
  // string, so it legitimately needs more room than a single-turn classification/voice call, even
  // with no tool round-trips left to wait on.
  const converseTimeoutMs = opts.converseTimeoutMs ?? 90_000;
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
        {
          prompt: INTERPRET_TASK_PREFIX + text,
          systemPrompt,
          model,
          tools: [],
          allowedTools: [],
          outputFormat: { type: "json_schema", schema: INTENT_SCHEMA },
          pathToClaudeCodeExecutable,
        },
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
    // Ruling C10: the real conversational path — ZERO tools (no Read/Grep/Glob, no Bash, nothing).
    // A live host showed `converse()`'s prior Read/Grep/Glob grant let the model wander: the SDK
    // worker process is always spawned with `cwd: LEVARE_ROOT` (sdk-transport.ts, NOTES phase-7
    // K13 — needed so the worker script itself resolves its own node_modules), and a tool-driven
    // model resolving relative paths walked LEVARE'S OWN SOURCE TREE, not the served studio, even
    // though `root` here was the correct studio path all along — "the model has search tools" was
    // the actual bug, not the wiring. The fix is structural, not a sandboxing fix: the Orchestrator
    // gets no filesystem access at all. In its place, `buildStudioProjection` (orchestrator-
    // projection.ts) — the same "levare derives it, the model never fetches it" discipline as the
    // §6 member-context recipe — assembles a deterministic summary of exactly this studio (`root`,
    // validated below, never defaulted) and it is prepended to the prompt as the model's ONLY view
    // of the studio. This also closes the security audit's Surface 1 finding that the Orchestrator
    // could read arbitrary files the process could reach — it no longer can read any file at all.
    // The verbatim system prompt already instructs treating embedded content as information, not
    // instruction, and the projection's own header repeats that for the exact content it carries.
    async converse(text: string, root: string): Promise<string> {
      if (!root) {
        throw new Error("OrchestratorBoundary.converse() called without an explicit studio root — the served studio root is required, it is never defaulted (ruling C10)");
      }
      const projection = buildStudioProjection(loadRepo(root));
      const prompt = `${projection}\n\nConductor: ${text}`;
      const res = await transport.run({ prompt, systemPrompt, model, tools: [], allowedTools: [], pathToClaudeCodeExecutable }, { env, timeoutMs: converseTimeoutMs });
      // Same reasoning as interpret(): a transport failure must never be dressed up as a real answer.
      // Throwing here (rather than degrading in-place, unlike narrate()) reuses the EXISTING
      // board/serve.ts catch-and-degrade-to-offline path (K11) instead of inventing a second, ad-hoc
      // "couldn't reach the model" string — one failure-handling path for the whole boundary, not two.
      if (!res.ok) {
        console.error(`levare: Orchestrator SDK converse() failed: ${res.error}`);
        throw new OrchestratorSdkError(`Orchestrator SDK converse() failed: ${res.error}`);
      }
      logReceipt("converse", res.receipt);
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
 * local preconditions (credential + a resolvable native binary — NOTES phase-7 K13) are met, else
 * `null` — the Orchestrator is unavailable (NOTES C11: there is no deterministic stand-in boundary;
 * "present or absent" is the whole vocabulary). The precondition check is fast and local (no network,
 * no subprocess): a genuinely broken install (missing binary) is detected without ever attempting —
 * and timing out on — a real spawn. A credential that resolves but is invalid, or any other genuine
 * runtime failure (network, credit, model error), is NOT something this local check can know; those
 * still surface per-request as a real error (board/serve.ts), never silently downgraded. This is the
 * one seam `levare serve`/the CLI call; it never inspects the key's value, only its presence
 * (invariant 11).
 */
export function selectOrchestratorBoundary(
  env: Record<string, string | undefined> = process.env,
  opts: SelectOrchestratorBoundaryOptions = {},
): OrchestratorBoundary | null {
  const { precondition, ...boundaryOpts } = opts;
  const check = checkSdkPreconditionsCached(env, precondition);
  if (!check.viable) return null;
  // Reuse the EXACT path the precondition probe just resolved, rather than letting
  // createSdkOrchestratorBoundary re-resolve it — "the probe says viable" and "the real call uses
  // that binary" are then provably the same value, not just the same algorithm (NOTES K14).
  return createSdkOrchestratorBoundary({ ...boundaryOpts, env, pathToClaudeCodeExecutable: boundaryOpts.pathToClaudeCodeExecutable ?? check.binaryPath });
}

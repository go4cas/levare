// The Orchestrator (PRD §7): a Claude Agent SDK application whose conversation is the product's
// single entry point. It holds no state — everything it "knows" is re-derived from the repo (files
// are the truth, invariant 2) and from the conversation itself (a proposal it made is carried by the
// caller, not remembered here). The SDK is not a runtime dependency this phase (invariant 10): the
// natural-language pieces (turning free text into intent, turning a derived fact into prose) sit
// behind an `OrchestratorBoundary` interface — mocked here exactly as adapters.ts mocks the native
// SDK boundary — with a deterministic default implementation standing in for the real model call.
//
// Every mutating operation funnels through the same functions the board's write routes use
// (`resolveGate` from board/gateops.ts, `conductorCommit` from git.ts) — ruling C7: a Conductor's
// approve means the same thing whichever surface received the click, chat included. Proposals
// (LEARNINGS appends, knowledge promotions) are never applied directly: they are returned as
// gate-shaped objects and only become a write when a caller resolves them with an explicit decision,
// exactly as invariant 1 requires ("no member process starts... external events may only raise
// gates") applied to the Orchestrator's own suggestions.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadRepo, type Repo } from "./repo.ts";
import { openGates, medianGateResponseDays, repoSpend, type OpenGate } from "./board/derive.ts";
import { diagnose, type CliProbe, type ConnectorHealth, type EnvProbe } from "./doctor.ts";
import { resolveGate, type GateOpResult } from "./board/gateops.ts";
import type { Verb } from "./runner.ts";
import { validatePath } from "./validate.ts";
import { conductorCommit } from "./git.ts";

// ---------------------------------------------------------------------------
// The mocked SDK boundary
// ---------------------------------------------------------------------------

export type Intent =
  | { kind: "briefing" }
  | { kind: "gate-decision"; target: string; verb: Verb; note?: string }
  | { kind: "capture-idea"; name: string; pitch: string; tags?: string[] }
  | { kind: "open-unit"; project: string; unit: string; type: string; after?: string[] }
  | { kind: "promote-idea"; idea: string; project: string; unit: string }
  | { kind: "stats" }
  | { kind: "unknown"; text: string };

/** The Orchestrator's LLM-shaped surface — natural language in, structured intent or prose out.
 * Mocked this phase (invariant 10): the SDK is not a runtime dependency, so `interpret`/`narrate`
 * are deterministic stand-ins, injectable exactly like adapters.ts's NativeBoundary. */
export interface OrchestratorBoundary {
  interpret(text: string): Intent;
  narrate(prompt: string): string;
}

const GATE_VERB_RE = /^(approve|reject|start|notyet|not[- ]yet|rescope)\s+(\S+)(?:\s*:\s*(.*)|\s+(.*))?$/i;
const REQUEST_RE = /^request(?:[- ]changes)?\s+(\S+)\s*:?\s*(.+)$/i;
const CAPTURE_IDEA_RE = /^capture idea:?\s*([\w-]+)\s*\|\s*([^|]+)(?:\|\s*(.+))?$/i;
const OPEN_UNIT_RE = /^open (\w+) unit (\S+) in (\S+)(?:\s+after\s+(\S+))?$/i;
const PROMOTE_IDEA_RE = /^promote idea (\S+) to (\S+)(?:\s+as\s+(\S+))?$/i;

/** The deterministic default boundary: a small, documented pattern grammar standing in for the real
 * model's intent extraction and narration this phase. Real free-form NLU is out of scope (mocked). */
export const deterministicBoundary: OrchestratorBoundary = {
  interpret(text: string): Intent {
    const t = text.trim();
    if (/^(what needs me|briefing|brief me)\b/i.test(t)) return { kind: "briefing" };

    let m = GATE_VERB_RE.exec(t);
    if (m) {
      const verb = m[1].toLowerCase().replace(/[- ]/g, "") as Verb;
      const note = (m[3] ?? m[4])?.trim();
      return { kind: "gate-decision", target: m[2], verb, note: note || undefined };
    }
    m = REQUEST_RE.exec(t);
    if (m) return { kind: "gate-decision", target: m[1], verb: "request", note: m[2].trim() };

    m = CAPTURE_IDEA_RE.exec(t);
    if (m) {
      const tags = m[3] ? m[3].split(",").map((s) => s.trim()).filter(Boolean) : undefined;
      return { kind: "capture-idea", name: m[1], pitch: m[2].trim(), tags };
    }

    m = OPEN_UNIT_RE.exec(t);
    if (m) return { kind: "open-unit", type: m[1], unit: m[2], project: m[3], after: m[4] ? [m[4]] : undefined };

    m = PROMOTE_IDEA_RE.exec(t);
    if (m) return { kind: "promote-idea", idea: m[1], project: m[2], unit: m[3] || m[1] };

    if (/^stats\b/i.test(t)) return { kind: "stats" };

    return { kind: "unknown", text: t };
  },
  narrate(prompt: string): string {
    return prompt;
  },
};

// ---------------------------------------------------------------------------
// Briefing (§7: "opens every session with a scope-appropriate briefing")
// ---------------------------------------------------------------------------

export interface Briefing {
  /** Artifact-shaped gates, oldest artifact first. */
  gates: OpenGate[];
  /** Units whose `after:` just became satisfied — "what unblocked". */
  unblocked: OpenGate[];
  doctor: ConnectorHealth[];
  warnings: ConnectorHealth[];
  text: string;
}

export function buildBriefing(repo: Repo, env: EnvProbe, probe: CliProbe): Briefing {
  const all = openGates(repo);
  const gates = all
    .filter((g): g is OpenGate & { artifact: NonNullable<OpenGate["artifact"]> } => g.type === "artifact" && !!g.artifact)
    .sort((a, b) => a.artifact.created.localeCompare(b.artifact.created));
  const unblocked = all.filter((g) => g.type === "start");
  const doctor = diagnose([...repo.connectors.values()], env, probe);
  const warnings = doctor.filter((d) => d.status !== "ok");

  const lines: string[] = [];
  if (gates.length === 0 && unblocked.length === 0) {
    lines.push("Nothing needs you right now.");
  } else {
    if (gates.length) lines.push(`${gates.length} gate${gates.length === 1 ? "" : "s"} on you, oldest first: ${gates.map((g) => g.target).join(", ")}.`);
    if (unblocked.length) lines.push(`Unblocked and ready to start: ${unblocked.map((g) => g.unit).join(", ")}.`);
  }
  lines.push(warnings.length ? `Doctor: ${warnings.map((w) => `${w.name} ${w.status}`).join(", ")}.` : `Doctor: all ${doctor.length} connector${doctor.length === 1 ? "" : "s"} ok.`);

  return { gates, unblocked, doctor, warnings, text: lines.join(" ") };
}

// ---------------------------------------------------------------------------
// Stats (§8: "answers stats questions from the derived metrics")
// ---------------------------------------------------------------------------

export interface StatsSnapshot {
  gatesOpen: number;
  unitsShipped: number;
  medianGateResponseDays: number | null;
  spendUsd: number;
}

export function computeStats(repo: Repo): StatsSnapshot {
  return {
    gatesOpen: openGates(repo).length,
    unitsShipped: repo.units.filter((u) => u.status === "shipped").length,
    medianGateResponseDays: medianGateResponseDays(repo),
    spendUsd: repoSpend(repo),
  };
}

function formatStats(s: StatsSnapshot): string {
  const median = s.medianGateResponseDays === null ? "—" : `${s.medianGateResponseDays}d`;
  return `${s.gatesOpen} gate(s) open · ${s.unitsShipped} unit(s) shipped · median gate response ${median} · spend $${s.spendUsd.toFixed(2)}.`;
}

// ---------------------------------------------------------------------------
// Intent → unit operations (§7: "open unit of type X, capture idea → ideas/, promote idea → project")
// ---------------------------------------------------------------------------

function rollbackAndFail(root: string, file: string, existedBefore: boolean, backup: string | null): GateOpResult {
  if (existedBefore && backup !== null) writeFileSync(file, backup);
  else rmSync(file, { force: true });
  const result = validatePath(root);
  const first = result.errors[0];
  return { ok: false, status: 422, error: first ? `${first.code}: ${first.message}` : "validation failed" };
}

export interface OpenUnitOptions {
  root: string;
  project: string;
  unit: string;
  type: string;
  after?: string[];
  budget?: number | null;
  timebox?: string | null;
  body: string;
}

/** Open a new work unit of a given type (§7 unit operation). */
export function openUnit(opts: OpenUnitOptions): GateOpResult {
  const dir = join(opts.root, "work", opts.project, opts.unit);
  if (existsSync(dir)) return { ok: false, status: 409, error: `unit '${opts.unit}' already exists in project '${opts.project}'` };
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "unit.md");
  const lines = [
    "---",
    `type: ${opts.type}`,
    "status: active",
    `project: ${opts.project}`,
    `unit: ${opts.unit}`,
    ...(opts.after?.length ? [`after: [${opts.after.join(", ")}]`] : []),
    ...(opts.timebox ? [`timebox: ${opts.timebox}`] : []),
    ...(opts.budget != null ? [`budget: ${opts.budget}`] : []),
    "---",
    "",
    `# ${opts.unit}`,
    "",
    opts.body,
    "",
  ];
  writeFileSync(file, lines.join("\n"));
  const result = validatePath(opts.root);
  if (!result.ok) {
    rmSync(dir, { recursive: true, force: true });
    const first = result.errors[0];
    return { ok: false, status: 422, error: first ? `${first.code}: ${first.message}` : "validation failed" };
  }
  const commit = conductorCommit(opts.root, [file], `open ${opts.type} unit ${opts.project}/${opts.unit}`);
  return { ok: true, commit, changedFiles: [file] };
}

export interface CaptureIdeaOptions {
  root: string;
  name: string;
  pitch: string;
  tags?: string[];
  body?: string;
}

/** Capture a pitch → ideas/ (§7 unit operation). */
export function captureIdea(opts: CaptureIdeaOptions): GateOpResult {
  const file = join(opts.root, "ideas", `${opts.name}.md`);
  if (existsSync(file)) return { ok: false, status: 409, error: `idea '${opts.name}' already exists` };
  mkdirSync(dirname(file), { recursive: true });
  const lines = [
    "---",
    `name: ${opts.name}`,
    `pitch: ${JSON.stringify(opts.pitch)}`,
    ...(opts.tags?.length ? [`tags: [${opts.tags.join(", ")}]`] : []),
    "---",
    "",
    `# ${titleCase(opts.name)}`,
    "",
    opts.body ?? opts.pitch,
    "",
  ];
  writeFileSync(file, lines.join("\n"));
  const result = validatePath(opts.root);
  if (!result.ok) {
    rmSync(file, { force: true });
    const first = result.errors[0];
    return { ok: false, status: 422, error: first ? `${first.code}: ${first.message}` : "validation failed" };
  }
  const commit = conductorCommit(opts.root, [file], `capture idea ${opts.name}`);
  return { ok: true, commit, changedFiles: [file] };
}

export interface PromoteIdeaOptions {
  root: string;
  idea: string;
  project: string;
  unit: string;
}

/** Promote a captured idea → an inception work unit in a project (§7 unit operation). The idea file
 * is removed as part of the same commit — it is now materialized as a unit, not a separate pitch. */
export function promoteIdea(opts: PromoteIdeaOptions): GateOpResult {
  const ideaFile = join(opts.root, "ideas", `${opts.idea}.md`);
  if (!existsSync(ideaFile)) return { ok: false, status: 404, error: `idea '${opts.idea}' not found` };
  const ideaSrc = readFileSync(ideaFile, "utf8");
  const pitchMatch = /^pitch:\s*(.+)$/m.exec(ideaSrc);
  const pitch = pitchMatch ? JSON.parse(pitchMatch[1]) : opts.idea;

  const dir = join(opts.root, "work", opts.project, opts.unit);
  if (existsSync(dir)) return { ok: false, status: 409, error: `unit '${opts.unit}' already exists in project '${opts.project}'` };
  mkdirSync(dir, { recursive: true });
  const unitFile = join(dir, "unit.md");
  writeFileSync(
    unitFile,
    ["---", "type: inception", "status: active", `project: ${opts.project}`, `unit: ${opts.unit}`, "---", "", `# ${opts.unit}`, "", `Promoted from idea '${opts.idea}': ${pitch}`, ""].join("\n"),
  );
  rmSync(ideaFile);

  const result = validatePath(opts.root);
  if (!result.ok) {
    rmSync(dir, { recursive: true, force: true });
    writeFileSync(ideaFile, ideaSrc);
    const first = result.errors[0];
    return { ok: false, status: 422, error: first ? `${first.code}: ${first.message}` : "validation failed" };
  }
  const commit = conductorCommit(opts.root, [unitFile, ideaFile], `promote idea ${opts.idea} → ${opts.project}/${opts.unit}`);
  return { ok: true, commit, changedFiles: [unitFile, ideaFile] };
}

function titleCase(name: string): string {
  return name.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// ---------------------------------------------------------------------------
// Proposals (§7: "proposes — never applies — LEARNINGS.md appends... and knowledge promotions...
// both through gates"). A Proposal is gate-shaped (a target, allowed verbs) but is never written to
// disk on its own — it is carried by the conversation (the Orchestrator holds no state) until a
// caller resolves it with an explicit Conductor decision.
// ---------------------------------------------------------------------------

export interface Proposal {
  kind: "learnings" | "knowledge-promotion";
  label: string;
  project: string;
  unit?: string;
  team?: string;
  /** Repo-relative path the proposal would write to on approval. */
  targetFile: string;
  text: string;
  verbs: Verb[];
}

export interface ProposeRetroOptions {
  team: string;
  unit: string;
  project: string;
  text: string;
}

/** A unit retro's proposed LEARNINGS.md append — a gate awaiting the Conductor, never a direct write. */
export function proposeRetro(repo: Repo, opts: ProposeRetroOptions): Proposal {
  if (!repo.teams.has(opts.team)) throw new Error(`no team '${opts.team}'`);
  return {
    kind: "learnings",
    label: `retro: ${opts.team} learnings — ${opts.unit}`,
    project: opts.project,
    unit: opts.unit,
    team: opts.team,
    targetFile: join("teams", `${opts.team}.learnings.md`),
    text: opts.text,
    verbs: ["approve", "reject"],
  };
}

export interface ProposeKnowledgePromotionOptions {
  reportArtifactId: string;
  project: string;
  unit: string;
  knowledgeName: string;
  content: string;
}

/** A research report's proposed knowledge/ promotion — likewise a gate, never a direct write (§5: a
 * type's `promotable_to` names the destination; the promotion itself always passes a gate). */
export function proposeKnowledgePromotion(opts: ProposeKnowledgePromotionOptions): Proposal {
  return {
    kind: "knowledge-promotion",
    label: `promote research report ${opts.reportArtifactId} → knowledge/${opts.knowledgeName}.md`,
    project: opts.project,
    unit: opts.unit,
    targetFile: join("knowledge", `${opts.knowledgeName}.md`),
    text: opts.content,
    verbs: ["approve", "reject"],
  };
}

/** Resolve a proposal (approve writes; reject is a no-op — the proposal is simply discarded). */
export function resolveProposal(root: string, proposal: Proposal, verb: "approve" | "reject", by: string): GateOpResult {
  if (verb === "reject") return { ok: true, commit: "", changedFiles: [] };
  const file = join(root, proposal.targetFile);
  const existedBefore = existsSync(file);
  const backup = existedBefore ? readFileSync(file, "utf8") : null;
  mkdirSync(dirname(file), { recursive: true });

  let content: string;
  if (proposal.kind === "learnings") {
    // Team LEARNINGS.md is a plain markdown note (no frontmatter) — skipped by the schema validator
    // (validate.ts classify()), so no re-validation is needed after appending to it.
    const existing = backup ?? `# ${proposal.team} — learnings\n`;
    content = `${existing.trimEnd()}\n\n## ${by}\n${proposal.text}\n`;
    writeFileSync(file, content);
  } else {
    const base = basename(proposal.targetFile, ".md");
    const existing = backup ?? `---\nname: ${base}\n---\n`;
    content = `${existing.trimEnd()}\n\n${proposal.text}\n`;
    writeFileSync(file, content);
    const result = validatePath(root);
    if (!result.ok) return rollbackAndFail(root, file, existedBefore, backup);
  }
  const commit = conductorCommit(root, [file], `${proposal.label} — approved by ${by}`);
  return { ok: true, commit, changedFiles: [file] };
}

// ---------------------------------------------------------------------------
// new-project skill (§7: "runs the new-project skill (gh repo create, clone, write pointer, ask
// deploy target + house rules, commit)"). Tests run this against a scratch git dir, never real
// GitHub: the caller supplies `remoteDir`, a bare repo standing in for what `gh repo create` would
// hand back, and this function performs a REAL `git clone` of it — end to end, nothing mocked below
// the git-porcelain boundary.
// ---------------------------------------------------------------------------

export interface NewProjectOptions {
  root: string;
  name: string;
  /** A bare git repo standing in for `gh repo create`'s result (scratch, never real GitHub). */
  remoteDir: string;
  /** Where to clone the new project's working checkout. */
  cloneDir: string;
  deploy: string | null;
  houseRules: string;
  defaultBranch?: string;
}

export function runNewProjectSkill(opts: NewProjectOptions): GateOpResult {
  if (!existsSync(opts.remoteDir)) return { ok: false, status: 422, error: `remote '${opts.remoteDir}' does not exist — create-repo step failed` };
  const branch = opts.defaultBranch ?? "main";

  const clone = spawnSync("git", ["-c", "init.defaultBranch=" + branch, "clone", "-q", opts.remoteDir, opts.cloneDir], { encoding: "utf8" });
  if (clone.status !== 0) return { ok: false, status: 500, error: `clone failed: ${clone.stderr}` };

  writeFileSync(join(opts.cloneDir, "README.md"), `# ${opts.name}\n`);
  const cloneGitArgs = (args: string[]) => ["-C", opts.cloneDir, "-c", "user.name=cas", "-c", "user.email=cas@levare.local", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args];
  spawnSync("git", cloneGitArgs(["add", "-A"]));
  spawnSync("git", cloneGitArgs(["commit", "-q", "-m", "initial commit"]));

  const projectFile = join(opts.root, "projects", `${opts.name}.md`);
  if (existsSync(projectFile)) return { ok: false, status: 409, error: `project '${opts.name}' already exists` };
  mkdirSync(dirname(projectFile), { recursive: true });
  const lines = [
    "---",
    `name: ${opts.name}`,
    `repo: ${opts.cloneDir}`,
    `remote: ${opts.remoteDir}`,
    `default_branch: ${branch}`,
    `deploy: ${opts.deploy ?? "null"}`,
    "pace: auto",
    "---",
    "",
    `# ${titleCase(opts.name)} — house rules`,
    "",
    opts.houseRules,
    "",
  ];
  writeFileSync(projectFile, lines.join("\n"));
  const result = validatePath(opts.root);
  if (!result.ok) {
    rmSync(projectFile, { force: true });
    const first = result.errors[0];
    return { ok: false, status: 422, error: first ? `${first.code}: ${first.message}` : "validation failed" };
  }
  const commit = conductorCommit(opts.root, [projectFile], `new-project ${opts.name}`);
  return { ok: true, commit, changedFiles: [projectFile] };
}

// ---------------------------------------------------------------------------
// The dispatcher — one entry point for every surface (chat, and anything else that wants the same
// intent grammar). Gate decisions call the SAME `resolveGate` the POST /gates route calls (ruling C7).
// ---------------------------------------------------------------------------

export interface OrchestratorContext {
  root: string;
  /** Conductor identity ("name + ISO date", ruling C5) stamped on approvals/commits this call makes. */
  by: string;
  env?: EnvProbe;
  cliProbe?: CliProbe;
}

export interface HandleResult {
  reply: string;
  intent: Intent;
  result: GateOpResult | Briefing | StatsSnapshot | null;
}

function defaultEnv(): EnvProbe {
  return { has: (n) => typeof process.env[n] === "string" && process.env[n] !== "" };
}
function defaultCliProbe(): CliProbe {
  return (cmd) => (Bun.which(cmd) ? "found" : "not-found");
}

/** Locate the project a chat-supplied target (artifact id, or unit id for start/notyet/rescope) lives
 * in — lets chat omit the project a click-driven gate card would already carry as a URL param. */
export function locateProjectForTarget(repo: Repo, target: string): string | undefined {
  for (const [key, artifacts] of repo.artifacts) {
    if (artifacts.has(target)) return key.split("/")[0];
  }
  const unit = repo.units.find((u) => u.unit === target);
  return unit?.project;
}

export function handle(text: string, ctx: OrchestratorContext, boundary: OrchestratorBoundary = deterministicBoundary): HandleResult {
  const intent = boundary.interpret(text);
  const today = ctx.by.match(/\d{4}-\d{2}-\d{2}/)?.[0];

  switch (intent.kind) {
    case "briefing": {
      const repo = loadRepo(ctx.root);
      const b = buildBriefing(repo, ctx.env ?? defaultEnv(), ctx.cliProbe ?? defaultCliProbe());
      return { reply: boundary.narrate(b.text), intent, result: b };
    }
    case "gate-decision": {
      const repo = loadRepo(ctx.root);
      const project = locateProjectForTarget(repo, intent.target);
      if (!project) return { reply: `I can't find an open gate for '${intent.target}'.`, intent, result: null };
      // Ruling C7: identical to the POST /gates/:project/:artifact/:verb route — same function, same
      // mutation, same commit shape, whichever surface received the click.
      const result = resolveGate(ctx.root, project, intent.target, intent.verb, { note: intent.note, today });
      const reply = result.ok
        ? `Done — ${intent.verb} recorded on ${intent.target}.`
        : `Couldn't ${intent.verb} ${intent.target}: ${result.error}`;
      return { reply: boundary.narrate(reply), intent, result };
    }
    case "capture-idea": {
      const result = captureIdea({ root: ctx.root, name: intent.name, pitch: intent.pitch, tags: intent.tags });
      const reply = result.ok ? `Captured idea '${intent.name}'.` : `Couldn't capture idea: ${result.error}`;
      return { reply: boundary.narrate(reply), intent, result };
    }
    case "open-unit": {
      const result = openUnit({ root: ctx.root, project: intent.project, unit: intent.unit, type: intent.type, after: intent.after, body: `Opened via the Orchestrator.` });
      const reply = result.ok ? `Opened ${intent.type} unit ${intent.project}/${intent.unit}.` : `Couldn't open unit: ${result.error}`;
      return { reply: boundary.narrate(reply), intent, result };
    }
    case "promote-idea": {
      const result = promoteIdea({ root: ctx.root, idea: intent.idea, project: intent.project, unit: intent.unit });
      const reply = result.ok ? `Promoted idea '${intent.idea}' → ${intent.project}/${intent.unit}.` : `Couldn't promote idea: ${result.error}`;
      return { reply: boundary.narrate(reply), intent, result };
    }
    case "stats": {
      const s = computeStats(loadRepo(ctx.root));
      return { reply: boundary.narrate(formatStats(s)), intent, result: s };
    }
    case "unknown":
    default:
      return {
        reply: text.trim() ? `Noted: "${text.trim()}". Nothing changes state until you act on a gate.` : "Say more and I'll fold it into the next briefing.",
        intent,
        result: null,
      };
  }
}

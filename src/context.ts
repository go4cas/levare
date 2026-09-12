// levare context assembly (§6). The fixed recipe, in order, assembled deterministically so
// `levare context <agent> --unit <u> --dry-run` prints the exact bytes a member would receive:
//
//   1. agent definition body            5. project house rules
//   2. referenced skills                6. the flow step, the unit's type template, and the unit's
//   3. referenced knowledge files           own body (Finding 163) — what kind of work this is and
//   4. team charter + team LEARNINGS.md     what the operator actually asked for
//                                        7. consumed artifacts — paths or inline, per agent declaration
//
// Two further sections are CONDITIONAL — present only when they apply, so a single-step dispatch or a
// loop's round-1 context is byte-for-byte unchanged from before either existed:
//
//   8. conductor note — present only on a loop author's request-changes redo (`opts.requestChangesNote`,
//      the goal REDO-CONTEXT fix): the Conductor's own free-text reason for the round, labelled with
//      which prior artifact it was written against. Never folded into item 6's unit body — a member
//      reading item 6 for "what kind of work is this" must not have to guess whether a paragraph there
//      is the operator's standing brief or a one-off correction for this round alone.
//   9. capability: proposal-gated connectors — unchanged from before (NOTES CAP-A item 5), renumbered
//      from its former "8" to make room for the note above.
//
// A third conditional is not a numbered section but a single line spliced INTO item 6 itself, after
// this module has already returned: a dispatch with a real dispatch worktree gets an explicit "your
// working directory is this unit's worktree at <path>" line — see `withDispatchWorktreeLine` below and
// its only caller, `adapters.ts#withDispatchWorktree`/`withDispatchWorktreeAsync` (the worktree is
// created strictly after `assembleContext` returns, so it can never be a plain parameter here). Absent
// for every dispatch without a worktree, so that context stays byte-for-byte unchanged too.
//
// Finding 163: item 6 used to be the flow step's label alone (e.g. `spec`) — the member never saw the
// unit's name, its type, or a syllable of what the operator wrote in `unit.md`. The type template
// (`types/<type>.md`) was itself never read past its frontmatter (`expects`/`gates`/`glyph`) anywhere
// in this codebase, so a `feature` and a `spike` were indistinguishable to a member too. Both now
// render here. Neither overrides the approved artifact chain in item 7 — see that item's own section
// header for the same caveat item 6's now states explicitly.
// Item 7's delivery mode is a per-agent declaration (ruling C9, NOTES D6): `agent.context_artifacts`
// defaults to `"paths"` — root-relative paths only, unchanged since phase 3 — for a member with
// filesystem access to the studio. A member that cannot reach the studio (e.g. a wrapped CLI
// deliberately run in an isolated scratch directory, so a repo's own config can't alter its
// behaviour) declares `"inline"`: section 7 then carries the full text (frontmatter + body) of every
// consumed artifact instead of a pointer it could never open. The consumed set is the unit's
// currently-approved artifacts — the vetted inputs available at that step — PLUS `extraConsumed`
// (ruling C14) — in both modes.

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parseFrontmatter } from "./yaml.ts";
import type { Repo } from "./repo.ts";
import { teamOf, grantedConnectors } from "./env.ts";
import { kindMatches } from "./flow.ts";

export class ContextError extends Error {}

interface Capability {
  member: string;
  kind: string;
}

/** The flow steps (label + resolved kind) an agent can satisfy, in flow order. */
function agentSteps(repo: Repo, teamName: string, caps: Capability[], agent: string): Array<{ label: string; kind: string }> {
  const team = repo.teams.get(teamName);
  if (!team) throw new ContextError(`no team '${teamName}'`);
  const labels: string[] = [];
  for (const node of team.flow) {
    if (node.kind === "step") labels.push(node.step);
    else if (node.kind === "loop") labels.push(node.between[0], node.between[1]);
  }
  const out: Array<{ label: string; kind: string }> = [];
  for (const label of labels) {
    const cap = caps.find((c) => c.member === agent && kindMatches(c.kind, label));
    if (cap) out.push({ label, kind: cap.kind });
  }
  return out;
}

// The unit's on-disk artifacts as (id, status, root-relative path), so consumed paths are addressable
// and deterministic. Mirrors repo.ts's discovery (single-file and one-index folder artifacts).
// Exported for adapters.ts (ruling C12): the same "currently-approved artifacts" set assembleContext
// hands a member as its consumed paths is what levare itself records as `consumes:` on the artifact it
// authors — one derivation, not a second copy that could drift from what the member was actually given.
export function unitArtifactPaths(root: string, project: string, unit: string): Array<{ id: string; status: string; rel: string }> {
  const unitDir = join(root, "work", project, unit);
  const out: Array<{ id: string; status: string; rel: string }> = [];
  if (!existsSync(unitDir)) return out;
  const record = (file: string) => {
    const { data } = parseFrontmatter(readFileSync(file, "utf8"));
    if (typeof data.id !== "string") return;
    out.push({ id: data.id, status: String(data.status ?? ""), rel: relative(root, file) });
  };
  for (const name of readdirSync(unitDir).sort()) {
    const full = join(unitDir, name);
    const s = statSync(full);
    if (s.isFile() && name.endsWith(".md") && name !== "unit.md") record(full);
    else if (s.isDirectory()) {
      const index = readdirSync(full).filter((n) => n.endsWith(".md"))[0];
      if (index) record(join(full, index));
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export interface AssembleOptions {
  root: string;
  agent: string;
  unit: string;
  /** Which flow step's context to assemble, by step LABEL; defaults to the agent's last step in flow
   * order. Ignored when `kind` below is also given — `levare context --step` is the one caller that
   * knows a label and has no dispatched kind to give it; a real dispatch always has a kind and never
   * sets this. */
  step?: string;
  /**
   * The KIND actually being dispatched (`AdapterRunner#prepare`'s own `kind` argument, itself resolved
   * from `flow.ts#resolveStep` before dispatch ever calls `#prepare`). Takes precedence over `step`
   * when both are given, and threaded through so the task line, the header's `step X → Y`, and
   * everything else this function derives from the resolved step describe what the member was
   * ACTUALLY dispatched to produce — never silently the agent's LAST flow step, which is what an
   * omitted `step` fell back to before this field existed (a member with more than one kind in a
   * team's flow — e.g. a `design`/`spec` agent dispatched for `design` — was told to produce its last
   * kind regardless of which one was actually dispatched). A `kind` that matches no step this agent
   * can satisfy is a ContextError, never a silent fallback to the default.
   */
  kind?: string;
  /** Capability source (member→kind), same shape the Runner uses; provided by the caller. */
  capabilities: Capability[];
  /**
   * Ruling C14: artifact ids to include in the consumed set IN ADDITION to whatever is currently
   * `approved` — a loop's companion (critic) member consumes the round's own author artifact even
   * though it is still `in-review` at the moment the companion runs (the round's outcome, not each
   * artifact individually, is what the Conductor gates — see dagwalk.ts).
   */
  extraConsumed?: string[];
  /**
   * Set only on a loop author's request-changes redo (board/gateops.ts#doRequest, runner.ts#runLoop) —
   * the Conductor's own note plus `on`, the id of the artifact being superseded by this redo. Rendered
   * as its own labelled section (item 8), never appended to item 6's unit body — see this file's own
   * header. Omitted entirely (no section 8 at all) for every other dispatch, so a single-step or
   * round-1 context stays byte-for-byte unchanged. `on` is optional here only for `levare context
   * --dry-run --note` (a preview, not a real redo — cli.ts's own doc): when omitted, it is derived from
   * the latest on-disk artifact of the resolved step's own kind. Every real call site (gateops.ts,
   * runner.ts) always supplies it explicitly.
   */
  requestChangesNote?: { note: string; on?: string };
}

// Goal 2026-09-11 ("native member cwd"): the exact item-6 header `withDispatchWorktreeLine` below
// splices its own line after — a named constant so the two never drift apart silently.
export const TASK_SECTION_HEADER = "── 6. task ──";

/**
 * Goal 2026-09-11 ("native member cwd"): the explicit line a dispatch WITH a real dispatch worktree
 * gets — "your working directory is the unit's worktree at <path>; write there", so a member never has
 * to discover it on its own (the live mason incident: a member that never knew where its worktree was
 * built the whole unit under its own ambient cwd instead). Not a parameter threaded through
 * `assembleContext` itself: the worktree is created strictly AFTER this module has already assembled
 * and returned the context string (`AdapterRunner#prepare` resolves `dispatchRepo` only after calling
 * `assemble`; the worktree itself is created later still, inside `withDispatchWorktree`/
 * `withDispatchWorktreeAsync`, wrapping the actual dispatch) — so this is a deliberate post-hoc splice,
 * the only place that ever calls it. A dispatch with no worktree never calls this at all, so its own
 * context stays byte-for-byte unchanged, exactly like every other conditional section in this file.
 */
export function withDispatchWorktreeLine(context: string, worktreePath: string): string {
  const marker = `${TASK_SECTION_HEADER}\n`;
  const idx = context.indexOf(marker);
  if (idx === -1) return context; // defensive: context assembly itself failed (AdapterRunner#assemble's own catch returns "").
  const insertAt = idx + marker.length;
  const line = `Your working directory is this unit's worktree at ${worktreePath}. Build there; levare commits it.\n\n`;
  return context.slice(0, insertAt) + line + context.slice(insertAt);
}

/** Assemble the §6 context for an agent at a step in a unit and return it as an exact string. */
export function assembleContext(repo: Repo, opts: AssembleOptions): string {
  const agent = repo.agents.get(opts.agent);
  if (!agent) throw new ContextError(`no agent '${opts.agent}' in ${opts.root}`);
  const team = teamOf(repo, opts.agent);
  if (!team) throw new ContextError(`agent '${opts.agent}' belongs to no team`);

  // Locate the unit and its project.
  const unitRow = repo.units.find((u) => u.unit === opts.unit);
  if (!unitRow) throw new ContextError(`no work unit '${opts.unit}' under ${opts.root}`);
  const project = repo.projects.get(unitRow.project);

  // Resolve the step: by dispatched `kind` when given (ground truth for a real dispatch — see the
  // field's own doc), else by `step` label (`levare context --step`), else the agent's last producing
  // step in flow order (both flags omitted — the CLI's own no-flag default, unchanged).
  const steps = agentSteps(repo, team.name, opts.capabilities, opts.agent);
  if (steps.length === 0) throw new ContextError(`agent '${opts.agent}' produces no kind in team '${team.name}' flow`);
  let chosen: { label: string; kind: string } | undefined;
  if (opts.kind !== undefined) {
    chosen = steps.find((s) => s.kind === opts.kind);
    if (!chosen) {
      throw new ContextError(
        `agent '${opts.agent}' was dispatched for kind '${opts.kind}', but produces no such kind in team '${team.name}' flow (has: ${steps.map((s) => s.kind).join(", ")})`,
      );
    }
  } else if (opts.step !== undefined) {
    chosen = steps.find((s) => s.label === opts.step);
    if (!chosen) throw new ContextError(`agent '${opts.agent}' has no flow step '${opts.step}' (has: ${steps.map((s) => s.label).join(", ")})`);
  } else {
    chosen = steps[steps.length - 1];
  }

  const extra = new Set(opts.extraConsumed ?? []);
  const consumed = unitArtifactPaths(opts.root, unitRow.project, opts.unit).filter((a) => a.status === "approved" || extra.has(a.id));
  const inline = agent.context_artifacts === "inline";

  // ---- Render the recipe, section by section, in fixed order. ----
  const out: string[] = [];
  out.push(`context · ${team.name}/${agent.name} · ${unitRow.project}/${opts.unit} · step ${chosen.label} → ${chosen.kind}`);
  out.push(
    `recipe: agent · skills · knowledge · team charter+learnings · project house rules · task · ${inline ? "consumed artifacts (inline)" : "consumed paths"}` +
      (opts.requestChangesNote ? " · conductor note" : ""),
  );
  out.push("");

  const kindTag = agent.kind === "native" ? `native, ${agent.model ?? "?"}` : agent.kind;
  out.push(`── 1. agent · ${agent.name} (${kindTag}) ──`);
  out.push(agent.body);
  out.push("");

  out.push("── 2. skills ──");
  // Finding 172: team.skills ∪ agent.skills, deduped — team first, then agent, mirroring
  // env.ts#grantedConnectors' own agent∪team union (order differs only in display, not membership: a
  // Set drops the later duplicate either way, and one team per agent is enforced, so there is no
  // multi-team accumulation to reason about here).
  const skills = [...new Set([...(team.skills ?? []), ...(agent.skills ?? [])])];
  if (skills.length === 0) out.push("(none)");
  for (const s of skills) {
    out.push(`### ${s}`);
    out.push(readEntityBody(opts.root, "skills", s));
    out.push("");
  }
  if (skills.length === 0) out.push("");

  out.push("── 3. knowledge ──");
  // Finding 185: same gap Finding 172 closed for skills — team.knowledge was parsed, validated
  // (UNKNOWN_KNOWLEDGE), and rendered on the team card, but never actually read here. team ∪ agent,
  // deduped, same shape as the skills union above.
  const knowledge = [...new Set([...(team.knowledge ?? []), ...(agent.knowledge ?? [])])];
  if (knowledge.length === 0) out.push("(none)");
  for (const k of knowledge) {
    out.push(`### ${k}`);
    out.push(readEntityBody(opts.root, "knowledge", k));
    out.push("");
  }
  if (knowledge.length === 0) out.push("");

  out.push(`── 4. team charter · ${team.name} ──`);
  out.push(team.charter);
  out.push("");
  out.push(`── team learnings · ${team.name} ──`);
  out.push(team.learnings.trim() === "" ? "(none)" : team.learnings.trim());
  out.push("");

  out.push(`── 5. project house rules · ${unitRow.project} ──`);
  out.push(project ? project.houseRules : "(none)");
  out.push("");

  out.push("── 6. task ──");
  out.push(chosen.label);
  out.push("");

  const type = repo.types.get(unitRow.type);
  out.push(`### type: ${unitRow.type}`);
  out.push(type ? (type.body?.trim() || "(none)") : `(not found: types/${unitRow.type}.md)`);
  out.push("");

  out.push(
    `### unit: ${unitRow.project}/${unitRow.unit} — context, not a licence to override the approved artifacts in item 7`,
  );
  out.push(unitRow.body?.trim() || "(none)");
  out.push("");

  out.push(
    inline
      ? "── 7. consumed artifacts (inline — full text, per agent declaration `context_artifacts: inline`, ruling C9) ──"
      : "── 7. consumed artifacts (paths only — never contents) ──",
  );
  if (consumed.length === 0) out.push("(none)");
  for (const c of consumed) {
    if (!inline) {
      out.push(c.rel);
      continue;
    }
    out.push(`── consumed artifact: ${c.id} (${c.rel}) ──`);
    out.push(readFileSync(join(opts.root, c.rel), "utf8").replace(/\n$/, ""));
    out.push(`── end consumed artifact: ${c.id} ──`);
  }

  // Goal REDO-CONTEXT: the Conductor's own request-changes note, when this dispatch is a loop author's
  // redo — a distinct, labelled section, never smuggled into item 6's unit body (see this file's own
  // header). Appended only when there's a note to show, so every other dispatch's context (round 1, a
  // plain step, an approve/reject) is byte-for-byte unchanged.
  if (opts.requestChangesNote) {
    const on =
      opts.requestChangesNote.on ??
      unitArtifactPaths(opts.root, unitRow.project, opts.unit)
        .filter((a) => a.id.startsWith(`${chosen.kind}-`))
        .sort((a, b) => a.id.localeCompare(b.id))
        .pop()?.id ??
      "(none)";
    out.push("");
    out.push(`── 8. conductor note · request changes on ${on} ──`);
    out.push(opts.requestChangesNote.note.trim());
  }

  // NOTES CAP-A (item 5): a member granted an `effects: write` + `gate: proposal` connector never
  // holds its credential (env.ts#buildMemberEnv withholds it) — it must be told, in its own context,
  // that direct calls are unavailable and how to act instead. Appended only when there's something to
  // say, so every pre-existing agent's context (no such grant) is byte-for-byte unchanged.
  const proposalBlock = proposalCapabilitySection(repo, opts.agent);
  if (proposalBlock.length > 0) out.push(...proposalBlock);

  return out.join("\n") + "\n";
}

function proposalCapabilitySection(repo: Repo, member: string): string[] {
  const grants = grantedConnectors(repo, member).filter((c) => c.effects === "write" && c.gate !== "trusted");
  if (grants.length === 0) return [];
  const out: string[] = [
    "",
    "── 9. capability: proposal-gated connectors ──",
    "You are granted the connector(s) below, but direct calls are unavailable — their credentials are " +
      "withheld from your process. To act, produce an artifact of kind `proposal` naming `connector:`, " +
      "`action:` (one of the actions listed for that connector), and `params:` covering every " +
      "placeholder in that action's template. The Conductor approves the proposal gate; levare executes it.",
  ];
  for (const c of grants) {
    out.push(`### ${c.name} (${c.kind})`);
    const actions = Object.entries(c.actions ?? {});
    if (actions.length === 0) {
      out.push("  (no actions declared)");
      continue;
    }
    for (const [name, template] of actions) {
      const placeholders = [...new Set(template.flatMap((el) => [...el.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1])))];
      out.push(`  - ${name}: params [${placeholders.join(", ")}]`);
    }
  }
  return out;
}

// Read an entity's markdown body (frontmatter stripped) from a registry dir, or a not-found marker.
// A referenced name resolves to either the flat convention (`<dir>/<name>.md`) or the Agent Skills
// folder convention (`<dir>/<name>/SKILL.md`, a directory bundling the skill with its own supporting
// files) — the latter matters for `skills/`, where the golden/scaffolded `new-project` skill lives.
function readEntityBody(root: string, dir: string, name: string): string {
  const flat = join(root, dir, `${name}.md`);
  const bundled = join(root, dir, name, "SKILL.md");
  const file = existsSync(flat) ? flat : existsSync(bundled) ? bundled : null;
  if (!file) return `(not found: ${dir}/${name}.md)`;
  const { body } = parseFrontmatter(readFileSync(file, "utf8"));
  return body.trim();
}

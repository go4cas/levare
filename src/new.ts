// `levare new` (Finding 93, RELEASE R1): create a work unit without hand-editing `unit.md` — the
// first thing any new user needs, and until now the only way to do it was `mkdir` + `printf` a file
// by hand. Ruled: CLI-only, no board form (a second form would double the risk Finding 71's dead gate
// already showed, before that lesson is absorbed).
//
// `type`/`status`/`team`/`budget` are NOT all required by WORK_UNIT_SCHEMA (validate.ts) — only
// `type` and `status` are. `team` is required only when validateResponsibleTeam's own AMBIGUOUS_
// PRODUCER check would otherwise refuse to guess; `budget` is fully optional/nullable. This module
// infers `type`/`team` exactly the way that check reasons about candidates (same `produces`/`expects`
// data, read via the already-validated `Repo`), so a unit `new` creates never trips a check `validate`
// would then reject — and is deliberately slightly STRICTER than AMBIGUOUS_PRODUCER's own per-kind
// scope: `new` requires an explicit `--team` whenever more than one team could plausibly own any part
// of the type's `expects`, not only when two teams collide on the exact same kind. That is a superset
// of what `validate` demands, never a subset, so nothing `new` accepts can fail `validate` afterward.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRepo, RepoError, type Repo } from "./repo.ts";
import { commitAs, resolveGitIdentity } from "./git.ts";

// Directory-name-safe: these become path segments under `work/` (and, reused by project-new.ts,
// under `projects/`). No separators, no leading dot/dash, no `..` — never trust an operator-supplied
// name into `join()` unchecked.
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface NewUnitInput {
  root: string;
  project: string;
  unit: string;
  type?: string;
  team?: string;
  budget?: number;
  /** Injectable for hermetic tests (mirrors init.ts#makeFoundingCommit's own `env` param) — defaults
   * to `process.env`, i.e. whatever git identity is actually configured on the host. */
  env?: NodeJS.ProcessEnv;
}

export interface FieldOrigin<T> {
  value: T;
  source: "flag" | "inferred" | "default";
}

export interface NewUnitResult {
  ok: true;
  file: string;
  type: FieldOrigin<string>;
  team?: FieldOrigin<string>;
  budget?: FieldOrigin<number>;
  committed: boolean;
  commit?: string;
  commitNote?: string;
}

export interface NewUnitFailure {
  ok: false;
  code: string;
  message: string;
}

function fail(code: string, message: string): NewUnitFailure {
  return { ok: false, code, message };
}

function buildFrontmatter(project: string, unit: string, type: string, team: string | undefined, budget: number | undefined): string {
  const lines = ["---", `type: ${type}`, "status: active", `project: ${project}`, `unit: ${unit}`];
  if (team) lines.push(`team: ${team}`);
  if (budget !== undefined) lines.push(`budget: ${budget}`);
  lines.push("---", "", `# ${unit}`, "");
  return lines.join("\n");
}

/**
 * Create `work/<project>/<unit>/unit.md`. Loads and validates the studio first (never adds to a
 * studio that doesn't already validate — this command's own guarantees depend on reading an honest
 * `Repo`), resolves `type`/`team`/`budget` per the rules above, writes the file, and — best-effort —
 * commits it under the operator's own resolved git identity (mirrors `init.ts#makeFoundingCommit`;
 * see that file's own doc for why this is never CONDUCTOR_NAME/RUNNER_NAME). A commit failure never
 * fails the command: the file is the truth (invariant 2), and `loadRepo`/the daemon/the board all read
 * it straight off disk, commit or not — only the audit trail is degraded, and that's reported, not
 * hidden.
 */
export function createUnit(input: NewUnitInput): NewUnitResult | NewUnitFailure {
  const { root, project, unit } = input;

  if (!NAME_RE.test(project)) return fail("INVALID_NAME", `project name '${project}' is not a valid path segment (letters, digits, '.', '_', '-' only, starting with an alphanumeric)`);
  if (!NAME_RE.test(unit)) return fail("INVALID_NAME", `unit name '${unit}' is not a valid path segment (letters, digits, '.', '_', '-' only, starting with an alphanumeric)`);

  let repo: Repo;
  try {
    repo = loadRepo(root);
  } catch (e) {
    if (e instanceof RepoError) return fail("STUDIO_INVALID", `'${root}' does not validate as a studio — fix it before adding a unit:\n  ${e.message}`);
    return fail("STUDIO_UNREADABLE", `could not read '${root}' as a studio: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (!repo.projects.has(project)) {
    const candidates = [...repo.projects.keys()].sort();
    return fail(
      "UNKNOWN_PROJECT",
      candidates.length > 0
        ? `no project named '${project}' — known projects: ${candidates.join(", ")}`
        : `no project named '${project}' — this studio has no projects defined yet (add one under projects/)`,
    );
  }

  const unitDir = join(root, "work", project, unit);
  const unitFile = join(unitDir, "unit.md");
  if (existsSync(unitFile)) return fail("UNIT_EXISTS", `a unit already exists at ${unitFile}`);

  // --- type ---------------------------------------------------------------
  let type: FieldOrigin<string>;
  if (input.type !== undefined) {
    if (!repo.types.has(input.type)) {
      const candidates = [...repo.types.keys()].sort();
      return fail("UNKNOWN_TYPE", `no type named '${input.type}' — known types: ${candidates.join(", ") || "(none defined)"}`);
    }
    type = { value: input.type, source: "flag" };
  } else {
    const candidates = [...repo.types.keys()].sort();
    if (candidates.length === 0) return fail("NO_TYPES", "this studio has no work-unit types defined (types/ is empty) — nothing to infer, and nothing --type could name");
    if (candidates.length > 1) return fail("AMBIGUOUS_TYPE", `--type is required — this studio defines more than one: ${candidates.join(", ")}`);
    type = { value: candidates[0]!, source: "inferred" };
  }

  const expects = repo.types.get(type.value)!.expects;

  // --- team -----------------------------------------------------------------
  const teamCandidates = [...repo.teams.values()]
    .filter((t) => t.produces.some((k) => expects.includes(k)))
    .map((t) => t.name)
    .sort();

  let team: FieldOrigin<string> | undefined;
  if (input.team !== undefined) {
    const t = repo.teams.get(input.team);
    if (!t) {
      const known = [...repo.teams.keys()].sort();
      return fail("UNKNOWN_TEAM", `no team named '${input.team}' — known teams: ${known.join(", ") || "(none defined)"}`);
    }
    if (expects.length > 0 && !t.produces.some((k) => expects.includes(k))) {
      return fail(
        "TEAM_CANNOT_PRODUCE",
        `team '${input.team}' produces [${t.produces.join(", ") || "nothing"}] — none of which type '${type.value}' expects [${expects.join(", ")}]`,
      );
    }
    team = { value: input.team, source: "flag" };
  } else if (teamCandidates.length === 1) {
    team = { value: teamCandidates[0]!, source: "inferred" };
  } else if (teamCandidates.length > 1) {
    return fail(
      "AMBIGUOUS_TEAM",
      `--team is required — more than one team in this studio could produce something type '${type.value}' expects [${expects.join(", ")}]: ${teamCandidates.join(", ")}`,
    );
  }
  // teamCandidates.length === 0: no team can produce anything this type expects — nothing to
  // disambiguate, so `team:` is left unset, exactly as validateResponsibleTeam leaves it alone.

  // --- budget -----------------------------------------------------------------
  let budget: FieldOrigin<number> | undefined;
  if (input.budget !== undefined) {
    if (!Number.isFinite(input.budget) || input.budget <= 0) return fail("INVALID_BUDGET", `--budget must be a positive number, got '${input.budget}'`);
    budget = { value: input.budget, source: "flag" };
  } else {
    // No project- or studio-level "default budget" field exists in the schema today
    // (validate.ts#PROJECT_SCHEMA / #STUDIO_SCHEMA) — the only place a per-project default can live
    // without a schema change is a project's own open-ended `overrides:` map (already read the same
    // way for `pace`, runner.ts#effectivePace). Absent that, budget is simply left unset — legal,
    // since WORK_UNIT_SCHEMA declares it optional/nullable.
    const override = repo.projects.get(project)!.overrides?.budget;
    if (typeof override === "number" && Number.isFinite(override) && override > 0) {
      budget = { value: override, source: "default" };
    }
  }

  // --- write ------------------------------------------------------------------
  const content = buildFrontmatter(project, unit, type.value, team?.value, budget?.value);
  try {
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(unitFile, content);
  } catch (e) {
    return fail("UNWRITABLE", `could not write ${unitFile}: ${e instanceof Error ? e.message : String(e)}`);
  }

  // --- commit (best-effort; the file on disk is what matters — see doc comment above) ------------
  const relFile = join("work", project, unit, "unit.md");
  let committed = false;
  let commit: string | undefined;
  let commitNote: string | undefined;
  if (!existsSync(join(root, ".git"))) {
    commitNote = "not committed — this studio has no .git; the file is on disk but its creation is unaudited";
  } else {
    const identity = resolveGitIdentity(root, input.env ?? process.env);
    if (!identity) {
      commitNote = "not committed — no git identity resolved (git config user.name/user.email); commit it yourself";
    } else {
      try {
        commit = commitAs(root, [relFile], `new: ${project}/${unit}`, identity);
        committed = true;
      } catch (e) {
        commitNote = `not committed — ${e instanceof Error ? e.message : String(e)}`;
      }
    }
  }

  return { ok: true, file: unitFile, type, team, budget, committed, commit, commitNote };
}

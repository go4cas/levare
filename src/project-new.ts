// `levare project new` (Finding 137, RELEASE R1b): create `projects/<name>.md` without hand-editing a
// file — the last hand-written registry entity between `levare init` and a running unit (ideas are the
// other; see docs/guide's own sweep note). `levare new` (Finding 93) already did this for units; this
// mirrors its shape exactly — flags with inference where the studio/target repo leaves one candidate,
// loud failure naming the ambiguity where it doesn't, a report naming what was written, a `Next:` line.
//
// PROJECT_SCHEMA (validate.ts) requires `name`/`repo`/`remote`/`default_branch`/`deploy`/`pace` to be
// PRESENT keys — `remote`/`deploy` may be `null`, but omitting them entirely is MISSING_FIELD, not a
// silent default (that laxer behavior lives only in repo.ts#toProject, the in-memory loader, which this
// command does not use). Every one of those six keys is always written below, never left for `validate`
// to catch missing.
//
// `board/gateops.ts#runNewProjectSkill` is the only other writer of `projects/<name>.md` today — it
// backs a different, still CLI-unreachable "new-project" GATE OP (clone a brand-new repo from a
// `remoteDir` stand-in for `gh repo create`, commit as the Conductor). This command instead REGISTERS
// an existing local checkout — the shape `repo:` documents and the guide has always taught — and,
// exactly like `new.ts#createUnit`, commits under the OPERATOR's own resolved git identity, never
// CONDUCTOR_NAME/RUNNER_NAME (this is the operator's own act, not a Conductor gate resolution). The two
// writers deliberately produce the same six-key frontmatter shape/order (see buildFrontmatter below) so
// a reader of either can't tell which command wrote a given project file.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadRepo, RepoError, type Repo } from "./repo.ts";
import { commitAs, resolveGitIdentity } from "./git.ts";
import { resolveProjectRepoPathRaw } from "./merge.ts";
import { NAME_RE } from "./new.ts";

export interface NewProjectInput {
  root: string;
  name: string;
  /** Raw `repo:` value — stored verbatim (tilde/relative form preserved, exactly like a hand-written
   * project), never rewritten to its resolved absolute path. Required: unlike `type`/`team` in
   * new.ts, there is no studio-wide default to fall back to for "where does this project's code live". */
  repo: string;
  remote?: string;
  defaultBranch?: string;
  deploy?: string;
  pace?: string;
  /** The project's house rules — injected into every member's context (context recipe §5). Piped in
   * via stdin (see cli.ts's own isTTY-gated read), never a second hand-edit step after creation. */
  houseRules?: string;
  /** Injectable for hermetic tests (mirrors new.ts#NewUnitInput's own `env` param). */
  env?: NodeJS.ProcessEnv;
}

export interface FieldOrigin<T> {
  value: T;
  source: "flag" | "inferred" | "default";
}

export interface NewProjectResult {
  ok: true;
  file: string;
  repo: string;
  remote: FieldOrigin<string | null>;
  defaultBranch: FieldOrigin<string>;
  deploy: FieldOrigin<string | null>;
  pace: FieldOrigin<"auto" | "step">;
  committed: boolean;
  commit?: string;
  commitNote?: string;
}

export interface NewProjectFailure {
  ok: false;
  code: string;
  message: string;
}

function fail(code: string, message: string): NewProjectFailure {
  return { ok: false, code, message };
}

// Read-only local git queries against the TARGET repo (never the studio) — no identity/hermetic-env
// concerns (nothing here commits), so these inherit the ambient environment exactly like
// git.ts#resolveGitIdentity's own `git config --get` calls do.
function currentBranch(repoPath: string): string | undefined {
  const r = spawnSync("git", ["-C", repoPath, "symbolic-ref", "--short", "-q", "HEAD"], { encoding: "utf8" });
  if (r.status !== 0) return undefined;
  const branch = r.stdout.trim();
  return branch || undefined;
}

function listRemotes(repoPath: string): string[] {
  const r = spawnSync("git", ["-C", repoPath, "remote"], { encoding: "utf8" });
  if (r.status !== 0) return [];
  return r.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function remoteUrl(repoPath: string, name: string): string | undefined {
  const r = spawnSync("git", ["-C", repoPath, "remote", "get-url", name], { encoding: "utf8" });
  if (r.status !== 0) return undefined;
  const url = r.stdout.trim();
  return url || undefined;
}

// Field order/format mirrors board/gateops.ts#runNewProjectSkill exactly (see this file's own header)
// — `null` is the bare YAML keyword, never a quoted string, on both nullable fields.
function buildFrontmatter(name: string, repo: string, remote: string | null, defaultBranch: string, deploy: string | null, pace: "auto" | "step", houseRules: string | undefined): string {
  const lines = ["---", `name: ${name}`, `repo: ${repo}`, `remote: ${remote ?? "null"}`, `default_branch: ${defaultBranch}`, `deploy: ${deploy ?? "null"}`, `pace: ${pace}`, "---", "", `# ${name}`, ""];
  if (houseRules) lines.push("## House rules", "", houseRules, "");
  return lines.join("\n");
}

/**
 * Create `projects/<name>.md`. Loads and validates the studio first (never adds to a studio that
 * doesn't already validate — same guarantee new.ts#createUnit gives units), resolves
 * `remote`/`default_branch`/`deploy`/`pace` per the rules below, writes the file, and — best-effort —
 * commits it under the operator's own resolved git identity. A commit failure never fails the command
 * (see new.ts#createUnit's own doc for why: the file is the truth, commit-or-not).
 *
 * `repo:` is refused UP FRONT when it doesn't resolve to a real local git checkout (Finding 77's own
 * `resolveProjectRepoPath`/`PROJECT_REPO_UNRESOLVED` only warn at whole-studio `validate` time, which
 * can be long after a stranger typed the wrong path) — deliberately narrower and louder than that
 * warning: a project THIS command creates says so immediately, at creation, never at first dispatch.
 */
export function createProject(input: NewProjectInput): NewProjectResult | NewProjectFailure {
  const { root, name } = input;

  if (!NAME_RE.test(name)) return fail("INVALID_NAME", `project name '${name}' is not a valid path segment (letters, digits, '.', '_', '-' only, starting with an alphanumeric)`);

  let repo: Repo;
  try {
    repo = loadRepo(root);
  } catch (e) {
    if (e instanceof RepoError) return fail("STUDIO_INVALID", `'${root}' does not validate as a studio — fix it before adding a project:\n  ${e.message}`);
    return fail("STUDIO_UNREADABLE", `could not read '${root}' as a studio: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (repo.projects.has(name)) return fail("PROJECT_EXISTS", `a project named '${name}' already exists (projects/${name}.md)`);

  const projectFile = join(root, "projects", `${name}.md`);
  if (existsSync(projectFile)) return fail("PROJECT_EXISTS", `a project file already exists at ${projectFile}`);

  // --- repo -----------------------------------------------------------------------------------------
  if (!input.repo) return fail("MISSING_REPO", "--repo is required — the path to this project's existing local git checkout");
  const resolvedRepo = resolveProjectRepoPathRaw(root, input.repo);
  if (!existsSync(join(resolvedRepo, ".git"))) {
    return fail(
      "REPO_NOT_A_CHECKOUT",
      `--repo '${input.repo}' resolves to '${resolvedRepo}', but '${resolvedRepo}/.git' does not exist — point --repo at a real local git checkout before creating this project`,
    );
  }

  // --- default_branch --------------------------------------------------------------------------------
  let defaultBranch: FieldOrigin<string>;
  if (input.defaultBranch !== undefined) {
    defaultBranch = { value: input.defaultBranch, source: "flag" };
  } else {
    const detected = currentBranch(resolvedRepo);
    if (!detected) {
      return fail(
        "DEFAULT_BRANCH_UNDETECTABLE",
        `could not detect a current branch in '${resolvedRepo}' (a detached HEAD, or a repo with no HEAD at all) — pass --default-branch explicitly`,
      );
    }
    defaultBranch = { value: detected, source: "inferred" };
  }

  // --- remote -----------------------------------------------------------------------------------------
  let remote: FieldOrigin<string | null>;
  if (input.remote !== undefined) {
    remote = { value: input.remote, source: "flag" };
  } else {
    const remotes = listRemotes(resolvedRepo);
    if (remotes.length === 0) {
      // No remote to infer from — legal: PROJECT_SCHEMA's own `remote` is nullable for exactly this
      // ("or null if this project declares none"), mirroring new.ts's own team-candidates === 0 case.
      remote = { value: null, source: "default" };
    } else if (remotes.length === 1) {
      const url = remoteUrl(resolvedRepo, remotes[0]!);
      remote = url !== undefined ? { value: url, source: "inferred" } : { value: null, source: "default" };
    } else {
      return fail("AMBIGUOUS_REMOTE", `--remote is required — '${resolvedRepo}' has more than one git remote: ${remotes.sort().join(", ")}`);
    }
  }

  // --- deploy -------------------------------------------------------------------------------------------
  const deploy: FieldOrigin<string | null> = input.deploy !== undefined ? { value: input.deploy, source: "flag" } : { value: null, source: "default" };

  // --- pace -----------------------------------------------------------------------------------------------
  let pace: FieldOrigin<"auto" | "step">;
  if (input.pace !== undefined) {
    if (input.pace !== "auto" && input.pace !== "step") return fail("INVALID_PACE", `--pace must be 'auto' or 'step', got '${input.pace}'`);
    pace = { value: input.pace, source: "flag" };
  } else {
    pace = { value: "auto", source: "default" };
  }

  // --- write --------------------------------------------------------------------------------------------------
  const content = buildFrontmatter(name, input.repo, remote.value, defaultBranch.value, deploy.value, pace.value, input.houseRules);
  try {
    mkdirSync(join(root, "projects"), { recursive: true });
    writeFileSync(projectFile, content);
  } catch (e) {
    return fail("UNWRITABLE", `could not write ${projectFile}: ${e instanceof Error ? e.message : String(e)}`);
  }

  // --- commit (best-effort; the file on disk is what matters — see doc comment above) ------------------------
  const relFile = join("projects", `${name}.md`);
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
        commit = commitAs(root, [relFile], `new-project: ${name}`, identity);
        committed = true;
      } catch (e) {
        commitNote = `not committed — ${e instanceof Error ? e.message : String(e)}`;
      }
    }
  }

  return { ok: true, file: projectFile, repo: input.repo, remote, defaultBranch, deploy, pace, committed, commit, commitNote };
}

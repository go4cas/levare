// Run-view timeline: "every runner walk, member spawn, and gate event" (design brief) — built from
// the two sources of truth that actually exist on disk for a unit: the append-only usage ledger
// (§10 `ledger.ndjson`, one line per member invocation) and `git log` on the unit's directory. No
// separate event store; both are re-derived from the repo on every request (invariant 2).

import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { CONDUCTOR_NAME, RUNNER_NAME, GOVERNING_REGISTRY_DIRS, GOVERNING_REGISTRY_ROOT_FILE } from "./git.ts";

/** Phase 2 cluster 3 part 3: who a timeline row is attributed to, structured rather than baked only
 * into `text`'s HTML — the run view uses this to render the design brief's own actor-avatar rule
 * ("agent initials on team tint, the Conductor as the only solid-filled disc, the Runner deliberately
 * gray"). `member` needs a repo lookup (a bare agent name, no team prefix) to tint correctly — that
 * lookup belongs to the render layer (which has `repo`), not here (which only has a raw ledger line/
 * git author). `conductor`/`runner` are resolved right here, from the exact identities every real
 * commit in the app funnels through (`git.ts#CONDUCTOR_NAME`/`RUNNER_NAME`) — never guessed. `unknown`
 * is an honest fallback for a git author that is neither (e.g. a human editing files directly outside
 * the board) — no avatar tint is fabricated for it. */
export interface TimelineActor {
  kind: "member" | "conductor" | "runner" | "unknown";
  name: string;
}

export interface TimelineRow {
  ts: string; // ISO
  kind: "produce" | "commit" | "branch";
  text: string;
  actor: TimelineActor;
  /** Finding 88: true when this row's underlying commit ALSO touched the governing registry
   * (`git.ts#GOVERNING_REGISTRY_DIRS`/`GOVERNING_REGISTRY_ROOT_FILE`), not just this unit's own
   * directory — a signal the row is worth a second look, not a claim that it's irrelevant to the
   * unit (a registry edit can still be the causally relevant one, e.g. the project's own
   * registration commit). Absent/false for a commit that touched only this unit's own files, and
   * for every `ledgerRows` row (the ledger has no registry concept). */
  registry?: boolean;
}

interface LedgerLine {
  ts: string;
  event: string;
  member?: string;
  kind?: string;
  /** Present only for `event: "branch"` (Finding 86) — the work branch levare just created. */
  branch?: string;
  wall_clock_s?: number;
  tokens_in?: number;
  tokens_out?: number;
  usd?: number;
}

export function ledgerRows(unitDir: string): TimelineRow[] {
  const file = join(unitDir, "ledger.ndjson");
  if (!existsSync(file)) return [];
  const rows: TimelineRow[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let l: LedgerLine;
    try {
      l = JSON.parse(line);
    } catch {
      continue;
    }
    if (l.event === "branch" && l.branch) {
      // Finding 86: `createWorkBranch` is a plain ref write, never a commit — it leaves nothing for
      // `gitLogRows` to find on either repo, so it is recorded here instead, as the ledger event a
      // `git branch` can't produce on its own. Attributed to the Conductor because the branch is
      // created inside the SAME `start` transaction the Conductor's own click authorized (see
      // board/gateops.ts#doStart) — never to the Runner, which is reserved for autonomous production
      // between gates.
      rows.push({ ts: l.ts, kind: "branch", text: `<span class="who">${CONDUCTOR_NAME}</span> created work branch <span class="mono">${l.branch}</span>`, actor: { kind: "conductor", name: CONDUCTOR_NAME } });
      continue;
    }
    if (!l.member) continue;
    const cost = typeof l.usd === "number" ? ` &middot; ${(l.tokens_in ?? 0) + (l.tokens_out ?? 0)} tok &middot; ~$${l.usd.toFixed(2)}` : "";
    rows.push({ ts: l.ts, kind: "produce", text: `<span class="who">${l.member}</span> ${l.event}d <span class="mono">${l.kind ?? ""}</span>${cost}`, actor: { kind: "member", name: l.member } });
  }
  return rows;
}

/** Finding 86: called once from `board/gateops.ts#doStart`, right after `createWorkBranch` actually
 * creates a new ref (never on the idempotent "branch already existed" path) — the only write site for
 * `ledger.ndjson` in the app today; every other line in that file is produced elsewhere. */
export function appendBranchEvent(unitDir: string, branch: string, ts: string = new Date().toISOString()): void {
  appendFileSync(join(unitDir, "ledger.ndjson"), `${JSON.stringify({ ts, event: "branch", branch })}\n`);
}

function touchesGoverningRegistry(files: string[]): boolean {
  return files.some((f) => f === GOVERNING_REGISTRY_ROOT_FILE || GOVERNING_REGISTRY_DIRS.some((d) => f === d || f.startsWith(`${d}/`)));
}

export function gitLogRows(root: string, unitDir: string): TimelineRow[] {
  const rel = relative(root, unitDir);
  // Finding 88: `--name-only` alone would list only the files matching `-- rel` (git filters the diff
  // by the same pathspec that selected the commit) — useless for detecting "this commit ALSO touched
  // the registry", since a registry path can never match `rel`. `--full-diff` overrides that: the
  // pathspec still selects which COMMITS appear, but the file list per commit is the commit's real,
  // complete changeset.
  const r = spawnSync("git", ["-C", root, "log", "--full-diff", "--name-only", "--format=%x01%aI|%an|%s", "--", rel], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout.trim()) return [];
  return r.stdout
    .split("\x01")
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split("\n");
      const [ts, author, ...subjectParts] = lines[0].split("|");
      const subject = subjectParts.join("|");
      const files = lines.slice(1).filter(Boolean);
      const actorKind: TimelineActor["kind"] = author === CONDUCTOR_NAME ? "conductor" : author === RUNNER_NAME ? "runner" : "unknown";
      return {
        ts,
        kind: "commit" as const,
        text: `<span class="who">${author}</span> committed &mdash; ${subject}`,
        actor: { kind: actorKind, name: author },
        registry: touchesGoverningRegistry(files),
      };
    });
}

export function buildTimeline(root: string, unitDir: string): TimelineRow[] {
  const rows = [...ledgerRows(unitDir), ...gitLogRows(root, unitDir)];
  return rows.sort((a, b) => a.ts.localeCompare(b.ts));
}

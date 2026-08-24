// Run-view timeline: "every runner walk, member spawn, and gate event" (design brief) — built from
// the two sources of truth that actually exist on disk for a unit: the append-only usage ledger
// (§10 `ledger.ndjson`, one line per member invocation) and `git log` on the unit's directory. No
// separate event store; both are re-derived from the repo on every request (invariant 2).

import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { CONDUCTOR_EMAIL, RUNNER_EMAIL } from "./git.ts";

/** Phase 2 cluster 3 part 3: who a timeline row is attributed to, structured rather than baked only
 * into `text`'s HTML — the run view uses this to render the design brief's own actor-avatar rule
 * ("agent initials on team tint, the Conductor as the only solid-filled disc, the Runner deliberately
 * gray"). `member` needs a repo lookup (a bare agent name, no team prefix) to tint correctly — that
 * lookup belongs to the render layer (which has `repo`), not here (which only has a raw ledger line/
 * git author). `conductor`/`runner`/`member` are resolved right here by `resolveGitActor`, from the
 * exact identity shapes every real commit in the app funnels through (`git.ts#CONDUCTOR_EMAIL`/
 * `RUNNER_EMAIL`/`memberIdentity`, plus an optionally studio-declared human identity for the Conductor
 * — Finding 90) — never guessed by name alone. `unknown` is an honest fallback for a git identity that
 * matches none of those (e.g. a human editing files directly, under their OWN git identity, with no
 * `conductor_git_identity` declared to say who they are) — no avatar tint is fabricated for it. */
export interface TimelineActor {
  kind: "member" | "conductor" | "runner" | "unknown";
  name: string;
  /** Finding 90: for `kind: "conductor"` only — true when this exact commit's author/email IS
   * `git.ts#CONDUCTOR_NAME`/`CONDUCTOR_EMAIL` (levare's own `commitAs`, i.e. an app-mediated action);
   * false when it matched only via a studio-declared `conductor_git_identity` (the same human, but a
   * commit they made directly with their own git config, outside the app). Unifying the DISPLAY name
   * must not erase this distinction — see `git.ts#RUNNER_NAME`'s own doc comment on why collapsing "the
   * app did this" into "a human decided this" would misrepresent git log as a record of human
   * decisions. Absent for every other kind. */
  stamped?: boolean;
}

/** Finding 90: the one place a git (author, email) pair resolves to an actor — exhaustive over every
 * identity shape the app itself produces (`CONDUCTOR_EMAIL`, `RUNNER_EMAIL`, `git.ts#memberIdentity`'s
 * `<member>@levare.local` shape) plus, optionally, the studio's own declared human identity for the
 * Conductor. `unknown` is reserved for a git identity matching none of those — a genuinely unrecognized
 * human, not a member/runner/conductor commit this function merely failed to recognize by name alone. */
export function resolveGitActor(name: string, email: string, declaredConductor?: { name: string; email: string }): TimelineActor {
  if (email === CONDUCTOR_EMAIL) return { kind: "conductor", name: declaredConductor?.name ?? name, stamped: true };
  if (email === RUNNER_EMAIL) return { kind: "runner", name };
  if (declaredConductor && email === declaredConductor.email) return { kind: "conductor", name: declaredConductor.name, stamped: false };
  if (email === `${name}@levare.local`) return { kind: "member", name };
  return { kind: "unknown", name };
}

export interface TimelineRow {
  ts: string; // ISO
  kind: "produce" | "commit";
  text: string;
  actor: TimelineActor;
}

interface LedgerLine {
  ts: string;
  member: string;
  event: string;
  kind?: string;
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
    const cost = typeof l.usd === "number" ? ` &middot; ${(l.tokens_in ?? 0) + (l.tokens_out ?? 0)} tok &middot; ~$${l.usd.toFixed(2)}` : "";
    rows.push({ ts: l.ts, kind: "produce", text: `<span class="who">${l.member}</span> ${l.event}d <span class="mono">${l.kind ?? ""}</span>${cost}`, actor: { kind: "member", name: l.member } });
  }
  return rows;
}

export function gitLogRows(root: string, unitDir: string, declaredConductor?: { name: string; email: string }): TimelineRow[] {
  const rel = relative(root, unitDir);
  const r = spawnSync("git", ["-C", root, "log", "--format=%aI|%an|%ae|%s", "--", rel], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout.trim()) return [];
  return r.stdout
    .trim()
    .split("\n")
    .map((line) => {
      const [ts, author, email, ...subjectParts] = line.split("|");
      const subject = subjectParts.join("|");
      const actor = resolveGitActor(author, email, declaredConductor);
      return { ts, kind: "commit" as const, text: `<span class="who">${actor.name}</span> committed &mdash; ${subject}`, actor };
    });
}

export function buildTimeline(root: string, unitDir: string, declaredConductor?: { name: string; email: string }): TimelineRow[] {
  const rows = [...ledgerRows(unitDir), ...gitLogRows(root, unitDir, declaredConductor)];
  return rows.sort((a, b) => a.ts.localeCompare(b.ts));
}

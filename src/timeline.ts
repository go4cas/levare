// Run-view timeline: "every runner walk, member spawn, and gate event" (design brief) — built from
// the two sources of truth that actually exist on disk for a unit: the append-only usage ledger
// (§10 `ledger.ndjson`, one line per member invocation) and `git log` on the unit's directory. No
// separate event store; both are re-derived from the repo on every request (invariant 2).

import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

export interface TimelineRow {
  ts: string; // ISO
  kind: "produce" | "commit";
  text: string;
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
    rows.push({ ts: l.ts, kind: "produce", text: `<span class="who">${l.member}</span> ${l.event}d <span class="mono">${l.kind ?? ""}</span>${cost}` });
  }
  return rows;
}

export function gitLogRows(root: string, unitDir: string): TimelineRow[] {
  const rel = relative(root, unitDir);
  const r = spawnSync("git", ["-C", root, "log", "--format=%aI|%an|%s", "--", rel], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout.trim()) return [];
  return r.stdout
    .trim()
    .split("\n")
    .map((line) => {
      const [ts, author, ...subjectParts] = line.split("|");
      const subject = subjectParts.join("|");
      return { ts, kind: "commit" as const, text: `<span class="who">${author}</span> committed &mdash; ${subject}` };
    });
}

export function buildTimeline(root: string, unitDir: string): TimelineRow[] {
  const rows = [...ledgerRows(unitDir), ...gitLogRows(root, unitDir)];
  return rows.sort((a, b) => a.ts.localeCompare(b.ts));
}

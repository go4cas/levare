// The Orchestrator conversation's durable record (NOTES V11-CONV) — closing the last invariant-2
// exception UI10 left open (docs/current-gaps.md's former "Conversation persistence" entry). Today
// (before this module) the conversation lived only in browser DOM state: real across an in-app
// navigation (UI10), gone on a refresh, a closed tab, or tomorrow. One markdown file per
// <scope>/<month> — append-only, authored by levare itself as the `levare-runner` identity
// (git.ts#runnerCommit) via the REV2 transactional helper, one commit per COMPLETED exchange
// (Conductor message + Orchestrator reply). These files are NOT registry entities: no schema, no
// card, no editor surface — validate.ts explicitly exempts `conversations/` from its markdown walk,
// and repo.ts#loadRepo never reads it (it only ever reads a fixed, named set of directories — see
// both modules' own comments). The panel is the reading UI; git/grep is the archive.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { transactionalWrite, runnerCommit, type TxResult } from "./git.ts";
import { validatePath, formatValidationErrors } from "./validate.ts";

export const CONVERSATIONS_DIR = "conversations";

/** The studio-level scope — every screen with no project of its own (studio, registry, ideas) writes
 * and reads here. A project-scoped screen (project/run/artifact) uses the project's own name instead. */
export const STUDIO_SCOPE = "studio";

/** How many past EXCHANGES (a Conductor message + the Orchestrator's reply, counted as one) the panel
 * renders beneath the live briefing on mount / a client-nav scope change (goal item 3) — a constant,
 * not user-configurable. Older history stays on disk, fully greppable; an in-UI "load earlier"
 * affordance is explicitly deferred (recorded in NOTES V11-CONV). */
export const TAIL_EXCHANGES = 20;

export type Speaker = "conductor" | "orchestrator";

export interface Turn {
  speaker: Speaker;
  /** ISO 8601, as written to disk — the read path renders relative to THIS, never "now" at read time. */
  at: string;
  text: string;
}

/** A safe scope is exactly one path segment: non-empty, no separators, no traversal. Anything else —
 * a malformed or absent client-supplied scope — falls back to the studio scope rather than reject the
 * request outright, the same "never trust the client wholesale, degrade to a safe default" discipline
 * `orchestrator-boundary.ts#coerceIntent` already applies to the model's own structured output. */
export function sanitizeScope(raw: unknown): string {
  if (typeof raw !== "string") return STUDIO_SCOPE;
  const s = raw.trim();
  if (!s || s === "." || s === ".." || s.includes("/") || s.includes("\\")) return STUDIO_SCOPE;
  return s;
}

function monthKey(d: Date): string {
  return d.toISOString().slice(0, 7); // YYYY-MM
}

export function conversationPath(root: string, scope: string, when: Date): string {
  return join(root, CONVERSATIONS_DIR, scope, `${monthKey(when)}.md`);
}

function fileHeader(scope: string, when: Date): string {
  return `# ${scope} — ${monthKey(when)}\n\n`;
}

const TURN_HEADER = /^## (conductor|orchestrator) · (\S+)$/;

// NOTES SEC-V11 F3: a body line that itself exactly matches the header grammar (an adversarial artifact
// or member output quoted verbatim into a Conductor/Orchestrator message) would otherwise be misread on
// the next parse as a NEW turn boundary — forging a turn out of attacker-controlled text. Escaped here,
// on write, with a single leading backslash (the same convention Markdown itself uses to escape a line
// that would otherwise be read as a heading) — `\## conductor · ...` is still perfectly readable by a
// human `cat`ing the file, and `parseConversation` strips exactly this one prefix back off, so the
// round-trip (append then parse) restores the ORIGINAL text byte-for-byte, never forging an extra turn.
function escapeBodyLine(line: string): string {
  return TURN_HEADER.test(line) ? `\\${line}` : line;
}

function formatTurn(turn: Turn): string {
  const body = turn.text.trim().split("\n").map(escapeBodyLine).join("\n");
  return `## ${turn.speaker} · ${turn.at}\n\n${body}\n\n`;
}

/** Parse a conversation segment back into its turns — pleasant to `cat`/diff by design (goal's own
 * requirement), not a strict serialization: any line that isn't a recognized `## speaker · timestamp`
 * header folds into the CURRENT turn's running text, so a Conductor hand-annotating the file (or a
 * message body that happens to contain a blank line) never breaks the parse. A body line that itself
 * exactly matches the header grammar is escaped at write time (`escapeBodyLine`, above) with a single
 * leading backslash; this function strips exactly that escape back off (NOT a general backslash-escape
 * grammar — only when what remains after removing one leading backslash matches the header pattern) so
 * such a line stays part of the CURRENT turn's body, never mistaken for a new turn boundary — the
 * round-trip (append then parse) yields exactly the turns written, byte-for-byte (NOTES SEC-V11 F3). */
export function parseConversation(content: string): Turn[] {
  const lines = content.split("\n");
  const turns: Turn[] = [];
  for (const line of lines) {
    const m = TURN_HEADER.exec(line);
    if (m) {
      turns.push({ speaker: m[1] as Speaker, at: m[2], text: "" });
      continue;
    }
    if (turns.length === 0) continue; // the title line, or stray content before the first turn
    const unescaped = line.startsWith("\\") && TURN_HEADER.test(line.slice(1)) ? line.slice(1) : line;
    turns[turns.length - 1].text += (turns[turns.length - 1].text ? "\n" : "") + unescaped;
  }
  for (const t of turns) t.text = t.text.trim();
  return turns;
}

/**
 * Append one COMPLETED exchange to `scope`'s current-month segment, creating the directory/file on
 * first use, and commit it as `levare-runner` via `transactionalWrite` — ONE commit per exchange,
 * never per-turn. `validate()` re-derives the whole repo the same way every other transactional write
 * in this codebase does (REV2); `conversations/` is exempt from entity classification (validate.ts),
 * so this only ever catches a genuine, unrelated pre-existing problem elsewhere in the studio, never
 * the conversation file itself.
 */
export function appendExchange(root: string, scope: string, conductorText: string, orchestratorText: string, now: Date = new Date()): TxResult {
  const path = conversationPath(root, scope, now);
  const existing = existsSync(path) ? readFileSync(path, "utf8") : null;
  const conductorAt = now.toISOString();
  // Stamped a moment later than the Conductor's own message — never the identical instant — so the
  // two turns' file order and their timestamp order can never disagree for a future reader/parser.
  const orchestratorAt = new Date(now.getTime() + 1).toISOString();
  const content =
    (existing ?? fileHeader(scope, now)) +
    formatTurn({ speaker: "conductor", at: conductorAt, text: conductorText }) +
    formatTurn({ speaker: "orchestrator", at: orchestratorAt, text: orchestratorText });

  mkdirSync(dirname(path), { recursive: true });
  return transactionalWrite(root, [{ path, content }], `conversation: ${scope} exchange`, runnerCommit, () => {
    const v = validatePath(root);
    return v.ok ? null : formatValidationErrors(v.errors);
  });
}

/** Load `scope`'s CURRENT-month segment only — older months stay on disk, greppable (goal item 3's
 * deferred "load earlier" affordance) — capped to the last `maxExchanges` exchanges (oldest first).
 * A missing file (a fresh studio, or the first exchange of a new month not yet sent) is simply no
 * history yet, the same honest empty state the rest of the panel already renders. */
export function loadConversationTail(root: string, scope: string, now: Date = new Date(), maxExchanges: number = TAIL_EXCHANGES): Turn[] {
  const path = conversationPath(root, scope, now);
  if (!existsSync(path)) return [];
  const turns = parseConversation(readFileSync(path, "utf8"));
  const maxTurns = maxExchanges * 2;
  return turns.length > maxTurns ? turns.slice(turns.length - maxTurns) : turns;
}

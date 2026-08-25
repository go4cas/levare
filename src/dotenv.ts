// NOTES C11 part 4: per-studio `.env` support. `levare serve`/`levare doctor` load a `.env` file from
// the STUDIO ROOT into the process environment on startup — exactly as if the operator had exported
// those variables in their shell. Deliberately scoped to the studio root only: no global
// `~/.levare/env` (a key in a shell profile would defeat connector scoping — env.ts's allowlist —
// by making a credential available to every studio and every member, regardless of grants).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface DotenvEntry {
  name: string;
  value: string;
}

export const STUDIO_ENV_FILENAME = ".env";

/** Parse `KEY=VALUE` lines. No interpolation, no multiline values, no `export` handling beyond
 * stripping a leading `export ` (a common shell habit) — deliberately minimal, matching this
 * project's "no dependencies beyond the SDK" posture (package.json's deps:check). Blank lines and
 * `#`-comments are skipped; a line with no `=` or an invalid identifier before it is skipped too,
 * rather than guessed at. */
export function parseDotenv(src: string): DotenvEntry[] {
  const out: DotenvEntry[] = [];
  for (const rawLine of src.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const eq = withoutExport.indexOf("=");
    if (eq === -1) continue;
    const name = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    let value = withoutExport.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    out.push({ name, value });
  }
  return out;
}

/** Read `<root>/.env`, or `[]` when it doesn't exist. */
export function loadDotenvFile(root: string): DotenvEntry[] {
  const file = join(root, STUDIO_ENV_FILENAME);
  if (!existsSync(file)) return [];
  return parseDotenv(readFileSync(file, "utf8"));
}

export type EnvProvenance = "dotenv" | "shell";

// Findings 31/32: `applyStudioEnv` is called again on every page/mutating board request (serve.ts)
// so an edited `.env` takes effect without a restart, not just once at `levare serve` startup. A
// variable this function itself set from `.env` on an earlier call is, by the second call, "already
// present" in `target` — indistinguishable from a genuinely shell-exported one by presence alone. This
// per-target set remembers which names THIS function put there, so a re-invocation can still refresh
// its own value (picking up an edit) while a name it never touched — the real shell-wins case — stays
// permanently protected and permanently reported as `'shell'`. Keyed by object identity (`target`),
// not by root: every test constructs its own scratch target, so nothing here leaks across tests or
// across two studios sharing no target object.
const dotenvOwnedNames = new WeakMap<object, Set<string>>();

/**
 * Load `<root>/.env` into `target` (default `process.env`). A variable already present and non-empty
 * in `target` — genuinely exported in the shell — always wins; `.env` only fills gaps, so a CI/host
 * environment that already sets a credential is never silently shadowed by a stray studio `.env`.
 * Returns the provenance of every variable named by `.env` — 'dotenv' when this call set it (or
 * confirmed it), 'shell' when it was already present with a DIFFERENT value and therefore left
 * untouched — so a caller (doctor.ts) can report "why does this work on my machine and not in CI"
 * instead of leaving that invisible.
 *
 * Findings 121/31/32: presence alone can't tell a shell export from a value Bun (or any other runtime)
 * already auto-loaded from this same `.env` before this function's first call ever runs — both look
 * identical as "already present in `target`". Value equality can: if what's already present matches
 * what `.env` holds for that name right now, `.env` is the only plausible source regardless of what
 * put it there, so it's labelled 'dotenv' and adopted as owned (free to refresh on a later edit) rather
 * than being locked in as 'shell' forever. Only a present value that DIFFERS from `.env` is a genuine
 * shell export, and only that case is protected and reported as 'shell'.
 *
 * Safe to call repeatedly against the SAME `target` (the whole point — see the module-level comment
 * above): a name this function has adopted (set or confirmed from `.env`) is still its own to refresh
 * on a later call, picking up an edited value; a name that's present and differs from `.env` is treated
 * as shell on every call, never overwritten and never relabeled, no matter how many times this runs.
 *
 * This changes nothing about scoping: `target` is the whole process environment, and env.ts's
 * `buildMemberEnv` allowlist still governs what any member's spawned process actually sees — a
 * variable loaded here is visible to `process.env` exactly as if the operator had exported it, and a
 * member without the granting connector still can't see it (invariant 11 is unchanged by where a var
 * came from).
 */
export function applyStudioEnv(root: string, target: Record<string, string | undefined> = process.env): Map<string, EnvProvenance> {
  const provenance = new Map<string, EnvProvenance>();
  let owned = dotenvOwnedNames.get(target);
  for (const { name, value } of loadDotenvFile(root)) {
    const present = typeof target[name] === "string" && target[name] !== "";
    if (present && !owned?.has(name) && target[name] !== value) {
      provenance.set(name, "shell");
      continue;
    }
    target[name] = value;
    provenance.set(name, "dotenv");
    if (!owned) dotenvOwnedNames.set(target, (owned = new Set()));
    owned.add(name);
  }
  return provenance;
}

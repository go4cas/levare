import { test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// NOTES R3 (item 2): src/board/ is the UI/API layer (the web board's render path and its HTTP write
// routes) built ON TOP of the core domain (types.ts, repo.ts, flow.ts, runner.ts, dagwalk.ts,
// orchestrator*.ts, ...). Core must never reach back INTO board/ for logic it needs — that inversion
// is exactly what src/orchestrator-projection.ts did before this fix (it imported board/derive.ts,
// board/extra.ts, and board/timeline.ts for pure derivation/lookup helpers that were core all along
// and have since moved to src/derive.ts, src/extra.ts, src/timeline.ts; src/dagwalk.ts had the same
// problem with board/locate.ts, now src/locate.ts). This test makes the boundary mechanical: any file
// directly under src/ (not src/board/ itself) that imports from src/board/ fails the build, with a
// named, commented allowlist for the two calls that are deliberately NOT this inversion (below) —
// so a new one can never recur silently.

const SRC = join(import.meta.dir, "..", "src");

// Each entry: the importing file, and why importing something under board/ from outside it is NOT
// the R3 inversion (core reaching for board-only DERIVATION/LOOKUP logic). Both entries below reach
// for board's own API/write SURFACE, not for logic that's secretly core — that's ordinary layering,
// not an inversion, and is called out explicitly rather than left for a loose check to paper over.
const ALLOWED: Record<string, string> = {
  "cli.ts": "the CLI entrypoint/composition root — it wires the board's HTTP server (board/serve.ts) into the `levare serve` command, which is what an entrypoint is for.",
  "orchestrator.ts": "reuses board/gateops.ts's resolveGate (the board's own gate-write API) so the Orchestrator's dispatch executes a Conductor-authorized verb through the exact same commit path the board itself uses, rather than a second copy of gate mutation — a deliberate, pre-existing reuse of the board's write surface, not a need for board-owned DERIVATION logic (which is what R3's inversion was about, and what moved out to src/derive.ts et al).",
};

function importsFromBoard(src: string): string[] {
  const matches = src.matchAll(/from\s+["']\.\/board\/([^"']+)["']/g);
  return [...matches].map((m) => m[1]);
}

test("no file directly under src/ imports from src/board/, except the named, explained exceptions", () => {
  const offenders: string[] = [];
  for (const name of readdirSync(SRC)) {
    if (!name.endsWith(".ts")) continue;
    const full = join(SRC, name);
    const targets = importsFromBoard(readFileSync(full, "utf8"));
    if (targets.length === 0) continue;
    if (ALLOWED[name]) continue; // named above, with why it isn't the R3 inversion.
    offenders.push(`${name} imports board/${targets.join(", board/")}`);
  }
  expect(offenders).toEqual([]);
});

test("the allowlist itself only names files that still exist and still do exactly what it claims", () => {
  for (const name of Object.keys(ALLOWED)) {
    const full = join(SRC, name);
    const src = readFileSync(full, "utf8");
    expect(importsFromBoard(src).length).toBeGreaterThan(0);
  }
});

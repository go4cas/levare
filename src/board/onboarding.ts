// First-run experience (phase 6, deliverable b): `levare serve` pointed at a directory that isn't
// yet a studio must explain that and suggest `levare init`, rather than rendering blank/broken
// screens (loadRepo would otherwise throw NOT_FOUND for a missing root, or every screen would render
// its "nothing here" empty state for an existing-but-empty one — neither tells a first-time user
// what to do next).

import { existsSync } from "node:fs";
import { join } from "node:path";
import { esc } from "../derive.ts";

// The skeleton `levare init` scaffolds (src/init.ts). A root "looks like" a studio once at least one
// of these exists — a partially-built studio (e.g. only `teams/` written so far) still renders
// normally; only a directory with none of them gets the onboarding page.
const SKELETON_DIRS = ["teams", "agents", "skills", "knowledge", "types", "connectors", "projects", "evals", "work", "ideas"];

export function isStudioInitialized(root: string): boolean {
  if (!existsSync(root)) return false;
  return SKELETON_DIRS.some((d) => existsSync(join(root, d)));
}

export function renderOnboarding(root: string): string {
  const rootLabel = esc(root);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>levare · not yet a studio</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/styles.css">
<style>
  body{ display:flex; align-items:center; justify-content:center; min-height:100vh; }
  .onboard{ max-width:520px; margin:24px; background:var(--panel); border:1px solid var(--border);
    border-radius:14px; padding:32px 34px; display:flex; flex-direction:column; gap:16px;
    box-shadow:var(--shadow); }
  .onboard h1{ margin:0; font-size:19px; font-weight:600; letter-spacing:-.01em; }
  .onboard p{ margin:0; font-size:13.5px; line-height:1.6; color:var(--fg-dim); }
  .onboard code{ font-family:var(--mono); font-size:.92em; background:var(--panel-2);
    border:1px solid var(--border); padding:2px 6px; border-radius:5px; color:var(--fg); }
  .onboard pre{ margin:0; font-family:var(--mono); font-size:12.5px; line-height:1.7; color:var(--fg);
    background:var(--panel-2); border:1px solid var(--border); border-radius:10px; padding:14px 16px; }
</style>
</head>
<body>
  <main class="onboard">
    <h1>This isn't a levare studio yet</h1>
    <p><code class="mono">${rootLabel}</code> has none of a studio's registry directories
      (<code>teams/</code>, <code>agents/</code>, <code>types/</code>, …) — there's nothing here
      for the board to project yet.</p>
    <pre>levare init ${rootLabel}</pre>
    <p>scaffolds a working studio into it: the directory skeleton, the five work-unit type
      templates, one example team with its agents, and a sample skill — a starting point you edit
      into your own, with no demo work units. Run it, then reload this page.</p>
  </main>
</body>
</html>
`;
}

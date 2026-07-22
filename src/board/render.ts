// Server-rendered board templates (PRD §9). Pure functions: repo data in, an HTML string out — no
// client state, re-derived on every request (invariant 2). Structure and CSS class names are bound
// to assets/styles.css (shipped verbatim, never touched here); only the data inside each element
// changes. Where the CD prototype markup (assets/*.html) assumed richer demo data than the golden
// fixture actually has (multiple projects with live members, a start-gate example, release history),
// the fixture is truth and the markup is trimmed to what the repo can actually show — see NOTES.md.
//
// NOTES REV4: this used to be one 1290-line/41-function file holding all six screens plus the shell
// plus the registry cards. It's now a thin re-export barrel over `render/` — the shared shell/rail/
// gate-card/orchestrator-panel pieces live in `render/shell.ts`, and each screen (studio, project,
// run, artifact, idea, registry) is its own module importing shell.ts and components.ts. The barrel
// stays (rather than updating every importer to the new per-screen paths) because the fan-in here is
// wide — `board/serve.ts` plus a dozen-plus test files all import multiple screen renderers from one
// place — and a barrel keeps that call-site graph exactly as it was; the "cleaner graph" the split
// itself buys is inside `render/`, where each screen module now only imports the shared pieces it
// actually uses instead of sharing one 1290-line scope.
export { renderStudio } from "./render/studio.ts";
export { renderProject } from "./render/project.ts";
export { renderRun, scoreNodeClass, scoreLineClass, elapsedLabel } from "./render/run.ts";
export { renderArtifact } from "./render/artifact.ts";
export { renderIdea } from "./render/idea.ts";
export { renderRegistry } from "./render/registry.ts";
export { projectStatusChip } from "./render/shell.ts";

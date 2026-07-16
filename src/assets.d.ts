// Ambient module declarations for Bun's `with { type: "file" }` asset imports (NOTES DIST1,
// board/serve.ts, orchestrator-boundary.ts): the import resolves to a string path at both runtime
// (dev: the real file path; `bun build --compile`: a path into Bun's embedded $bunfs, transparently
// rewritten) and here, for the compiler. bun-types ships declarations for several text-asset
// extensions (*.txt, *.toml, *.yaml, ...) but not these three, so they're declared here instead of
// widening one of bun-types' own patterns.

declare module "*.css" {
  const path: string;
  export default path;
}

declare module "*.md" {
  const path: string;
  export default path;
}

// A generic `*.js` wildcard would also match every real JS module import — safe here only because
// this codebase has exactly one `.js` asset import (grep-verified) and no plain JS source files.
declare module "*/assets/app.js" {
  const path: string;
  export default path;
}

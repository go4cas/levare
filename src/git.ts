// Shared Conductor git identity + commit helper (PRD §4, §9, ruling E6). Every write path that
// commits on the Conductor's behalf — board gate resolution, the registry edit route, and the
// Orchestrator's own writes (§7) — funnels through this one function, so "commit as the Conductor"
// means exactly one thing everywhere it happens. Always passes explicit non-interactive-safe
// overrides: a Conductor action must never hang on a host signing prompt or a stray commit hook.

import { spawnSync } from "node:child_process";

export const CONDUCTOR_NAME = "cas";
export const CONDUCTOR_EMAIL = "cas@levare.local";

export function conductorCommit(root: string, files: string[], message: string): string {
  const gitArgs = (args: string[]) => [
    "-C",
    root,
    "-c",
    `user.name=${CONDUCTOR_NAME}`,
    "-c",
    `user.email=${CONDUCTOR_EMAIL}`,
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=/dev/null",
    ...args,
  ];
  const add = spawnSync("git", gitArgs(["add", "--", ...files]), { encoding: "utf8" });
  if (add.status !== 0) throw new Error(`git add failed: ${add.stderr}`);
  const commit = spawnSync("git", gitArgs(["commit", "-q", "-m", message]), { encoding: "utf8" });
  if (commit.status !== 0) throw new Error(`git commit failed: ${commit.stderr}${commit.stdout}`);
  const rev = spawnSync("git", gitArgs(["rev-parse", "HEAD"]), { encoding: "utf8" });
  return rev.stdout.trim();
}

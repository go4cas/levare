// levare CLI entry point. Phase 1 implements `validate`; phase 2 adds `replay`. Later phases add
// context/serve/doctor/stats behind the same dispatcher.

import { validatePath, type ValidationResult } from "./validate.ts";
import { formatReport, runReplay } from "./replay.ts";
import { loadRepo, repoCapabilities } from "./repo.ts";
import { assembleContext } from "./context.ts";
import { runDoctor, type PromptCheck } from "./doctor.ts";
import { serve } from "./board/serve.ts";
import { initStudio, GIT_IDENTITY_NOTE } from "./init.ts";
import { applyStudioEnv } from "./dotenv.ts";
import { resolveOrchestratorStatus } from "./orchestrator-status.ts";
import { loadOrchestratorPromptSource, ORCHESTRATOR_PROMPT_PATH } from "./orchestrator-boundary.ts";
import { getVersionInfo, formatVersion } from "./version.ts";
import { WORKER_COMMAND } from "./sdk-transport.ts";
import { hasDeclaredGuardrails } from "./guardrails.ts";

// Until the studio repo root is populated, the fixture golden tree stands in as the studio (NOTES
// A1); context/doctor default their root there. `--root <path>` overrides.
const DEFAULT_ROOT = "fixtures/golden";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function formatEntries(entries: { code: string; message: string; file: string; line?: number }[]): string {
  const lines: string[] = [];
  for (const e of entries) {
    const loc = e.line !== undefined ? `${e.file}:${e.line}` : e.file;
    lines.push(`  ${e.code}  ${loc}\n    ${e.message}`);
  }
  return lines.join("\n");
}

function formatResult(result: ValidationResult): string {
  return formatEntries(result.errors);
}

export function runValidate(path: string): number {
  const result = validatePath(path);
  if (result.ok) {
    console.log("valid");
    // NOTES REV1 finding 3: a warning never flips `ok` — the declaration (e.g. kind: remote) is legal
    // — but it still needs telling, printed after the "valid" line rather than suppressed.
    if (result.warnings.length > 0) {
      console.log(`${result.warnings.length} warning(s):`);
      console.log(formatEntries(result.warnings));
    }
    return 0;
  }
  console.error(`invalid — ${result.errors.length} error(s):`);
  console.error(formatResult(result));
  return 1;
}

export function runReplayCmd(path: string, stubs: boolean): number {
  if (!stubs) {
    console.error("replay currently requires --stubs (phase 2 drives stub members)");
    return 2;
  }
  const report = runReplay(path);
  console.log(formatReport(report));
  if (report.expected !== null && !report.match) return 1;
  return 0;
}

// `levare context <agent> --unit <u> [--step s] [--root r] [--dry-run]` — print the exact §6 context.
export function runContextCmd(rest: string[]): number {
  const agent = rest.find((a) => !a.startsWith("-"));
  const unit = flag(rest, "--unit");
  if (!agent || !unit) {
    console.error("usage: levare context <agent> --unit <unit> [--step <step>] [--root <path>] [--dry-run]");
    return 2;
  }
  const root = flag(rest, "--root") ?? DEFAULT_ROOT;
  const step = flag(rest, "--step");
  try {
    const repo = loadRepo(root);
    // Capabilities come from the studio's own agent definitions (`produces:`), never from the
    // fixture stubs — `levare context` on a real studio must print what that studio would actually
    // send its member (NOTES F1).
    process.stdout.write(assembleContext(repo, { root, agent, unit, step, capabilities: repoCapabilities(repo) }));
    return 0;
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    return 1;
  }
}

// NOTES DIST4: reads `docs/orchestrator-prompt.md` via the exact same path the real boundary uses
// (`ORCHESTRATOR_PROMPT_PATH`, a `{ type: "file" }` import) and reports success/failure — independent
// of `orchestrator`'s on/off state, which now reports "off" under a compiled binary regardless of the
// prompt (see orchestrator-status.ts). This is the one doctor line a compiled binary can use to prove
// the prompt-loading fix itself actually works under `--compile`, not just in a source run.
function checkOrchestratorPrompt(): PromptCheck {
  try {
    const text = loadOrchestratorPromptSource(ORCHESTRATOR_PROMPT_PATH);
    return { path: ORCHESTRATOR_PROMPT_PATH, ok: true, bytes: Buffer.byteLength(text, "utf8") };
  } catch (e) {
    return { path: ORCHESTRATOR_PROMPT_PATH, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// `levare doctor [root]` — walk connectors, report env presence + CLI/MCP reachability (§6), the
// Orchestrator's own boundary state, and where each present variable came from (.env or shell).
export function runDoctorCmd(rest: string[]): number {
  const root = rest.find((a) => !a.startsWith("-")) ?? DEFAULT_ROOT;
  try {
    // NOTES C11 part 4: `.env` at the studio root loads into this process's own env BEFORE anything
    // below reads it — the same "on startup" contract `runServeCmd` follows — so doctor reports
    // exactly the environment a `levare serve` launched right after it would actually see.
    const provenance = applyStudioEnv(root);
    const repo = loadRepo(root);
    const env = { has: (name: string) => typeof process.env[name] === "string" && process.env[name] !== "" };
    const probe = (command: string): "found" | "not-found" => (Bun.which(command) ? "found" : "not-found");
    const orchestrator = resolveOrchestratorStatus(process.env);
    // NOTES REV1 finding 2: every team declaring a non-empty `guardrails:` block, so doctor can tell
    // the Conductor the enforcement gap plainly (see runDoctor's own doc comment).
    const guardrailsTeams = [...repo.teams.values()].filter(hasDeclaredGuardrails).map((t) => t.name);
    // NOTES REV1 finding 3: every agent declaring `kind: remote` — a legal declaration that produces
    // no real work today (adapters.ts's RemoteBoundary is a mocked fixture).
    const remoteAgents = [...repo.agents.values()].filter((a) => a.kind === "remote").map((a) => a.name);
    process.stdout.write(
      runDoctor([...repo.connectors.values()], env, probe, provenance, orchestrator, getVersionInfo(), checkOrchestratorPrompt(), guardrailsTeams, remoteAgents),
    );
    return 0;
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    return 1;
  }
}

// `levare init [path]` — scaffold an empty (or not-yet-a-studio) directory into a working studio:
// the skeleton, the five type templates, one example team with its agents, a sample skill, a
// .devcontainer/, and a starter README (§3, phase 6). Never overwrites an existing file. Also
// `git init`s the target and makes the founding commit under the user's own resolved git identity —
// without that, the approved-artifact immutability check fail-opens and every commit-as-Conductor
// write path is inert by default (see src/init.ts#initStudio, src/git.ts#makeFoundingCommit).
export function runInitCmd(rest: string[]): number {
  const target = rest.find((a) => !a.startsWith("-")) ?? ".";
  const result = initStudio(target);
  console.log(`levare init · ${target}`);
  console.log(`  ${result.scaffold.created.length} file(s)/dir(s) created`);
  if (result.scaffold.skipped.length > 0) {
    console.log(`  ${result.scaffold.skipped.length} file(s) already existed and were left untouched:`);
    for (const s of result.scaffold.skipped) console.log(`    ${s}`);
  }
  if (result.git.committed) {
    console.log(`  git: founding commit ${result.git.commit?.slice(0, 12)} as ${result.git.identity?.name} <${result.git.identity?.email}>`);
  } else {
    console.log("");
    console.log("  ⚠ no founding commit was made — " + (result.git.gitAvailable ? "no git identity resolved" : "git is not available"));
    console.log("");
    for (const line of wrap(GIT_IDENTITY_NOTE, 78)) console.log(`  ${line}`);
    console.log("");
  }
  console.log(`Next: levare validate ${target}    ·    levare serve ${target}`);
  return 0;
}

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (line.length > 0 && line.length + 1 + w.length > width) {
      lines.push(line);
      line = w;
    } else {
      line = line.length ? `${line} ${w}` : w;
    }
  }
  if (line.length) lines.push(line);
  return lines;
}

// `levare serve [root] [--port N] [--read-only] [--no-daemon]` — the board (§9) plus, by default, the
// phase-8 daemon in the same process (deliverable a). Read-only when --read-only is passed, or by
// default when root sits under a fixtures/ tree (NOTES E14); a read-only board never gets a daemon
// (nothing for it to legitimately write). `--no-daemon` disables it on an otherwise-writable root too.
export function runServeCmd(rest: string[]): number {
  const root = rest.find((a) => !a.startsWith("-")) ?? DEFAULT_ROOT;
  // NOTES C11 part 4: load `<root>/.env` into this process's own environment on startup — exactly as
  // if the operator had exported those variables in their shell. The connector allowlist (env.ts) is
  // unaffected: it scopes from process.env regardless of how a variable got there, so a member without
  // a grant still can't see a var this only just added.
  applyStudioEnv(root);
  const port = Number(flag(rest, "--port") ?? 4173);
  // --read-only forces write routes off for any path; without it, a path under fixtures/ is
  // read-only by default (structural, not a rule to remember — see NOTES E14) and any other path
  // stays read-write.
  const readOnly = rest.includes("--read-only") ? true : undefined;
  const noDaemon = rest.includes("--no-daemon");
  const { url, board, daemon } = serve(root, port, { readOnly, noDaemon });
  console.log(`levare serve · ${root} → ${url}${board.ctx.readOnly ? " (read-only)" : ""}${daemon ? " · daemon: on" : " · daemon: off"}`);
  return 0;
}

// `levare --version` / `-v` — print the stamped version+commit for a compiled binary, or an honest
// "source/dev" for an unstamped run (the `./levare` shim, `bun run src/cli.ts`). NOTES DIST1: a
// binary that can't say what it is can't be trusted in the field.
export function runVersionCmd(): number {
  console.log(formatVersion(getVersionInfo()));
  return 0;
}

function usage(): number {
  console.error(
    "usage: levare init [path]\n" +
      "       levare validate <path>\n" +
      "       levare replay <path> --stubs\n" +
      "       levare context <agent> --unit <unit> [--step <step>] [--root <path>] [--dry-run]\n" +
      "       levare doctor [root]\n" +
      "       levare serve [root] [--port N] [--read-only] [--no-daemon]\n" +
      "       levare --version | -v",
  );
  return 2;
}

export function main(argv: string[]): number {
  const [command, ...rest] = argv;
  switch (command) {
    case "init":
      return runInitCmd(rest);
    case "validate": {
      const path = rest[0];
      if (!path) return usage();
      return runValidate(path);
    }
    case "replay": {
      const path = rest.find((a) => !a.startsWith("-"));
      if (!path) return usage();
      return runReplayCmd(path, rest.includes("--stubs"));
    }
    case "context":
      return runContextCmd(rest);
    case "doctor":
      return runDoctorCmd(rest);
    case "serve":
      return runServeCmd(rest);
    case "--version":
    case "-v":
      return runVersionCmd();
    case undefined:
    case "--help":
    case "-h":
      return usage();
    default:
      console.error(`unknown command: ${command}`);
      return usage();
  }
}

// Single entry point for every way this CLI gets invoked: this module's own `if (import.meta.main)`
// block below, AND the separate `./levare` wrapper script (the actual documented invocation path,
// NOTES A3) both call this — not `process.exit(main(argv))` directly — specifically so the
// long-running-command exception can never be forgotten in one of the two places again (see NOTES
// E12 for how exactly that happened).
//
// `serve` starts a long-lived Bun.serve listener; every other command runs once and exits. Exiting
// unconditionally the instant `main()` returns would tear down the process before the listener ever
// accepts a connection.
//
// `WORKER_COMMAND` (`__worker`) is intercepted here, BEFORE `main()`'s own switch/usage() — it is the
// hidden internal subcommand sdk-transport.ts's `workerSpawnArgv` self-invokes into (NOTES DIST5:
// the standard `bun build --compile` pattern — a fresh copy of this same process, told to run the
// SDK worker in-process, instead of spawning a script path that only a real `bun` interpreter can
// run). Deliberately never added to `main()`'s switch: that keeps it out of `usage()`/`--help`
// without needing a separate "hidden commands" allowlist — a caller that reaches `main(["__worker"])`
// directly (bypassing `runCli`) gets the ordinary "unknown command" response, exactly as before this
// command existed.
export function runCli(argv: string[]): void {
  if (argv[0] === WORKER_COMMAND) {
    // Dynamic, not a top-level `import` (NOTES REV1 finding 1): `sdk-worker.ts` imports
    // `@anthropic-ai/claude-agent-sdk` at its own module top, and a static import here would load
    // that module — and therefore require the SDK package to be installed — for EVERY command this
    // CLI runs, including offline ones (`validate`, `doctor`, `context`) that never touch a model.
    // Deferring to `await import()` inside this branch means the SDK is only ever required to resolve
    // when a real `__worker` invocation actually happens (NOTES DIST5's self-invocation spawn).
    import("./sdk-worker.ts")
      .then(({ runSdkWorkerFromStdin }) => runSdkWorkerFromStdin())
      .then(() => process.exit(0))
      .catch((e) => {
        console.error(String(e instanceof Error ? e.message : e));
        process.exit(1);
      });
  } else if (argv[0] === "serve") {
    main(argv);
  } else {
    process.exit(main(argv));
  }
}

if (import.meta.main) {
  runCli(process.argv.slice(2));
}

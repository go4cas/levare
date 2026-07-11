// levare CLI entry point. Phase 1 implements `validate`; phase 2 adds `replay`. Later phases add
// context/serve/doctor/stats behind the same dispatcher.

import { validatePath, type ValidationResult } from "./validate.ts";
import { formatReport, runReplay } from "./replay.ts";
import { loadRepo } from "./repo.ts";
import { assembleContext } from "./context.ts";
import { runDoctor } from "./doctor.ts";
import { CAPABILITIES } from "../fixtures/stubs/member-stub.ts";

// Until the studio repo root is populated, the fixture golden tree stands in as the studio (NOTES
// A1); context/doctor default their root there. `--root <path>` overrides.
const DEFAULT_ROOT = "fixtures/golden";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function formatResult(result: ValidationResult): string {
  const lines: string[] = [];
  for (const e of result.errors) {
    const loc = e.line !== undefined ? `${e.file}:${e.line}` : e.file;
    lines.push(`  ${e.code}  ${loc}\n    ${e.message}`);
  }
  return lines.join("\n");
}

export function runValidate(path: string): number {
  const result = validatePath(path);
  if (result.ok) {
    console.log("valid");
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
    process.stdout.write(assembleContext(repo, { root, agent, unit, step, capabilities: CAPABILITIES }));
    return 0;
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    return 1;
  }
}

// `levare doctor [root]` — walk connectors, report env presence + CLI/MCP reachability (§6).
export function runDoctorCmd(rest: string[]): number {
  const root = rest.find((a) => !a.startsWith("-")) ?? DEFAULT_ROOT;
  try {
    const repo = loadRepo(root);
    const env = { has: (name: string) => typeof process.env[name] === "string" && process.env[name] !== "" };
    const probe = (command: string): "found" | "not-found" => (Bun.which(command) ? "found" : "not-found");
    process.stdout.write(runDoctor([...repo.connectors.values()], env, probe));
    return 0;
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    return 1;
  }
}

function usage(): number {
  console.error(
    "usage: levare validate <path>\n" +
      "       levare replay <path> --stubs\n" +
      "       levare context <agent> --unit <unit> [--step <step>] [--root <path>] [--dry-run]\n" +
      "       levare doctor [root]",
  );
  return 2;
}

export function main(argv: string[]): number {
  const [command, ...rest] = argv;
  switch (command) {
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
    case undefined:
    case "--help":
    case "-h":
      return usage();
    default:
      console.error(`unknown command: ${command}`);
      return usage();
  }
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}

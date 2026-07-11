// levare CLI entry point. Phase 1 implements `validate`; phase 2 adds `replay`. Later phases add
// context/serve/doctor/stats behind the same dispatcher.

import { validatePath, type ValidationResult } from "./validate.ts";
import { formatReport, runReplay } from "./replay.ts";

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

function usage(): number {
  console.error("usage: levare validate <path>\n       levare replay <path> --stubs");
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

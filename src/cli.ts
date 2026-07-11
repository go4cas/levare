// levare CLI entry point. Phase 1 implements only `validate`; later phases add replay/context/
// serve/doctor/stats behind the same dispatcher.

import { validatePath, type ValidationResult } from "./validate.ts";

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

function usage(): number {
  console.error("usage: levare validate <path>");
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

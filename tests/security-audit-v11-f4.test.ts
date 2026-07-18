// Security audit v1.1, F4 (LOW) — placeholder-in-flag-position lint (docs/security-audit-v11.md,
// NOTES SEC-V11).

import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePath } from "../src/validate.ts";

function rmrf(p: string): void {
  rmSync(p, { recursive: true, force: true });
}

describe("F4 — a leading-position placeholder gets a WARNING (never an error)", () => {
  function connectorStudio(actionsBlock: string): string {
    const dir = mkdtempSync(join(tmpdir(), "levare-f4-"));
    mkdirSync(join(dir, "connectors"), { recursive: true });
    writeFileSync(
      join(dir, "connectors", "gh.md"),
      ["---", "name: gh", "kind: cli", "command: gh", "env: [GH_TOKEN]", "effects: write", "gate: proposal", actionsBlock, "---", "", "# gh connector", ""].join("\n"),
    );
    return dir;
  }

  test("a placeholder with no flag immediately before it warns, naming the position", () => {
    const dir = connectorStudio('actions:\n  run: ["gh", "{args}"]');
    try {
      const r = validatePath(dir);
      expect(r.ok).toBe(true); // a warning, never an error — the argv is still injection-safe
      const w = r.warnings.find((w) => w.code === "PLACEHOLDER_NOT_IN_VALUE_POSITION");
      expect(w).toBeDefined();
      expect(w!.message).toContain("gh");
      expect(w!.message).toContain("run");
      expect(w!.message).toContain("{args}");
    } finally {
      rmrf(dir);
    }
  });

  test("a placeholder immediately preceded by a literal flag-shaped element does NOT warn", () => {
    const dir = connectorStudio('actions:\n  create: ["gh", "pr", "create", "--title", "{title}"]');
    try {
      const r = validatePath(dir);
      expect(r.warnings.map((w) => w.code)).not.toContain("PLACEHOLDER_NOT_IN_VALUE_POSITION");
    } finally {
      rmrf(dir);
    }
  });
});

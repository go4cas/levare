// Invariant 10 (PRD §2): zero runtime dependencies except @anthropic-ai/claude-agent-sdk. Until now
// this was enforced only by the `deps:check` npm script — a CI gate, never an in-suite assertion, so
// `bun test` alone could pass while the policy silently rotted. This test brings the policy inside the
// suite as an OUTCOME check (the real package.json, not an intent flag): the same rule deps:check runs,
// asserted where every other invariant is asserted. Dev dependencies are unrestricted (§2) and not checked.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SANCTIONED = "@anthropic-ai/claude-agent-sdk";

test("[invariant 10] package.json declares exactly one runtime dependency: the sanctioned SDK", () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"));
  const deps = Object.keys(pkg.dependencies ?? {});
  const forbidden = deps.filter((d) => d !== SANCTIONED);
  expect(forbidden).toEqual([]);
  expect(deps).toContain(SANCTIONED);
});

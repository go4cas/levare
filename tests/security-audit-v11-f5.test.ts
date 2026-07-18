// Security audit v1.1, F5 (LOW, hardening) — confirm scope sanitation coverage: a project-name-derived
// conversation scope cannot traverse either (docs/security-audit-v11.md, NOTES SEC-V11).

import { test, expect, describe } from "bun:test";
import { join } from "node:path";
import { conversationPath, sanitizeScope, STUDIO_SCOPE } from "../src/conversation.ts";

describe("F5 — project-name-derived scope cannot traverse (hardening)", () => {
  test("conversationPath sanitizes a traversal-shaped scope regardless of caller (never just the client-body path)", () => {
    const root = "/some/studio/root";
    const now = new Date("2026-01-01T00:00:00.000Z");
    // A project's own `name:` field is an unconstrained str (validate.ts places no filesystem-safety
    // rule on it) — this is the same shape an attacker-influenced project frontmatter could carry
    // straight into `orchestratorPanel`'s scope on every project/run/artifact page render.
    for (const traversal of ["../../etc", "..", ".", "a/b", "a\\b"]) {
      const p = conversationPath(root, traversal, now);
      expect(p.startsWith(join(root, "conversations") + "/")).toBe(true);
      expect(p).toBe(conversationPath(root, STUDIO_SCOPE, now)); // falls back exactly like sanitizeScope's own default
    }
  });

  test("a normal project name is unaffected — passes through as its own scope", () => {
    const root = "/some/studio/root";
    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(conversationPath(root, "storefront", now)).toBe(join(root, "conversations", "storefront", "2026-01.md"));
  });

  test("sanitizeScope itself already covers the client-supplied path (regression, unchanged)", () => {
    expect(sanitizeScope("../../etc")).toBe(STUDIO_SCOPE);
    expect(sanitizeScope("storefront")).toBe("storefront");
  });
});

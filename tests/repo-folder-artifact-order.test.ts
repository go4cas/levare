import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, cpSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRepo } from "../src/repo.ts";

// NOTES: the readdir[0] order-dependence in a work-unit folder-artifact's index resolution — the
// same class of bug as the F11 insertion-order finding (never let unspecified read order decide
// which file is authoritative). `validate.ts`'s INDEX_COUNT check rejects a folder holding more than
// one `.md` file, but that check runs on a separate path from `repo.ts#loadUnitArtifacts` — a repo
// loaded with `{ validate: false }` (an established pattern; see e.g. tests/f19-blocked-artifact-
// verbs.test.ts, tests/binding.test.ts) can still reach the folder-artifact branch with two `.md`
// files present, and before this fix `readdirSync(full).filter(...)[0]` picked whichever one the
// filesystem's own (unspecified) directory-entry order returned first.

function seedScratchRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "levare-repo-folder-order-"));
  cpSync("fixtures/golden", root, { recursive: true });
  return root;
}

function artifactDoc(id: string, body: string): string {
  return `---
kind: design
id: ${id}
unit: checkout-flow
project: storefront
status: in-review
produced_by: kestrel/lyra
consumes: []
supersedes: null
approved_by: null
created: 2026-07-14
files: []
---
${body}
`;
}

test("a folder artifact with more than one .md file resolves the SAME index every time, sorted lexicographically — not by directory-read order", () => {
  const root = seedScratchRepo();
  try {
    const artDir = join(root, "work/storefront/checkout-flow/multi-index-test");
    mkdirSync(artDir);
    // Written in REVERSE alphabetical order — if resolution ever fell back to insertion/readdir
    // order, "z-second.md" (written last, but sorts last) would be the one most likely to expose a
    // naive first-of-readdir bug. The documented rule is sorted order or a named-file convention;
    // this repo has no named-file convention for folder-artifact indices, so the rule is: sort, take
    // the first — deterministic regardless of write/readdir order.
    writeFileSync(join(artDir, "z-second.md"), artifactDoc("design-order-z", "Written first on disk, sorts last."));
    writeFileSync(join(artDir, "a-first.md"), artifactDoc("design-order-a", "Written second on disk, sorts first."));

    const repo = loadRepo(root, { validate: false });
    const artifacts = repo.artifacts.get("storefront/checkout-flow")!;
    expect(artifacts.has("design-order-a")).toBe(true);
    expect(artifacts.has("design-order-z")).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolution is stable across repeated loads regardless of which file was written to disk most recently", () => {
  const root = seedScratchRepo();
  try {
    const artDir = join(root, "work/storefront/checkout-flow/multi-index-test");
    mkdirSync(artDir);
    // This time write in FORWARD alphabetical order (opposite of the test above) — the resolved
    // artifact must still be the lexicographically-first file, proving the outcome depends on the
    // sorted rule, never on write order in either direction.
    writeFileSync(join(artDir, "a-first.md"), artifactDoc("design-order-a", "Written first this time."));
    writeFileSync(join(artDir, "z-second.md"), artifactDoc("design-order-z", "Written second this time."));

    const first = loadRepo(root, { validate: false }).artifacts.get("storefront/checkout-flow")!;
    const second = loadRepo(root, { validate: false }).artifacts.get("storefront/checkout-flow")!;
    expect(first.has("design-order-a")).toBe(true);
    expect(second.has("design-order-a")).toBe(true);
    expect(first.has("design-order-z")).toBe(false);
    expect(second.has("design-order-z")).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

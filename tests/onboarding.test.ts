import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBoard } from "../src/board/serve.ts";
import { isStudioInitialized } from "../src/board/onboarding.ts";
import { scaffoldStudio } from "../src/init.ts";

// Phase 6 deliverable (b): `levare serve` pointed at an uninitialized directory explains and
// suggests `levare init`, rather than rendering blank screens.

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "levare-onboard-"));
  dirs.push(d);
  return d;
}

describe("first-run experience", () => {
  test("isStudioInitialized is false for an empty directory and true once any skeleton dir exists", () => {
    const root = tmpRoot();
    expect(isStudioInitialized(root)).toBe(false);
    mkdirSync(join(root, "teams"));
    expect(isStudioInitialized(root)).toBe(true);
  });

  test("isStudioInitialized is false for a path that does not exist at all", () => {
    expect(isStudioInitialized(join(tmpdir(), "levare-never-created-xyz"))).toBe(false);
  });

  test("every screen route renders the onboarding page (not blank, not a crash) against an empty directory", async () => {
    const root = tmpRoot();
    const board = createBoard(root);
    for (const path of ["/", "/studio", "/project/anything", "/run/anything/anything", "/registry"]) {
      const res = await board.fetch(new Request(`http://x${path}`));
      const body = await res.text();
      expect(res.status).toBe(200);
      expect(body).toContain("levare init");
      expect(body).toContain("This isn't a levare studio yet");
    }
    board.close();
  });

  test("renders onboarding even when the root directory does not exist yet", async () => {
    const root = join(tmpdir(), "levare-onboard-missing-" + Math.random().toString(36).slice(2));
    const board = createBoard(root);
    const res = await board.fetch(new Request("http://x/"));
    const body = await res.text();
    board.close();
    expect(res.status).toBe(200);
    expect(body).toContain("levare init");
  });

  test("assets and SSE routes are unaffected by the onboarding gate", async () => {
    const root = tmpRoot();
    const board = createBoard(root);
    const css = await board.fetch(new Request("http://x/styles.css"));
    expect(css.status).toBe(200);
    expect(await css.text()).toContain(".snode");
    board.close();
  });

  test("once scaffolded, the onboarding page no longer appears", async () => {
    const root = tmpRoot();
    scaffoldStudio(root);
    const board = createBoard(root);
    const res = await board.fetch(new Request("http://x/"));
    const body = await res.text();
    board.close();
    expect(body).not.toContain("This isn't a levare studio yet");
  });
});

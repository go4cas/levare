import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, statSync, existsSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDispatchTrace,
  writeDispatchTrace,
  sweepDispatchTraces,
  DISPATCH_LOG_DIR_NAME,
  type NativeDispatchOutcome,
} from "../src/dispatch-trace.ts";
import type { InvokeRequest } from "../src/adapters.ts";
import type { Agent } from "../src/types.ts";

// NOTES DISPATCH-TRACE (native-dispatch-hang investigation, 2026-08-19): this file proves the two
// invariants dispatch-trace.ts's own header names — never a connector env VALUE, and bounded retention —
// plus the record builder's basic shape. See adapters.ts#traceNativeDispatch for the real wiring this
// module feeds (not exercised here directly; that's covered by the existing adapters.test.ts native-
// boundary tests, which don't need to know a trace was written underneath them).

function nativeAgent(extra: Partial<Agent> = {}): Agent {
  return { name: "builder", kind: "native", produces: ["code"], model: "claude-sonnet-5", ...extra } as Agent;
}

function baseReq(extra: Partial<InvokeRequest> = {}): InvokeRequest {
  return {
    agent: nativeAgent(),
    member: "quill/builder",
    kind: "code",
    unit: "list-entries",
    project: "jot",
    context: "THE ASSEMBLED CONTEXT",
    env: { PATH: "/usr/bin", HOME: "/home/operator" },
    tools: [],
    ...extra,
  };
}

function okOutcome(extra: Partial<NativeDispatchOutcome> = {}): NativeDispatchOutcome {
  return { ok: true, timedOut: false, durationMs: 1234, stdout: '{"ok":true,"result":"done"}', stderr: "levare: sdk worker query() finished in 1234ms", ...extra };
}

describe("buildDispatchTrace — invariant 1: env NAMES only, never a value, never a connector's env: value", () => {
  test("a connector-granted var whose value looks exactly like a credential never appears anywhere in the record", () => {
    const req = baseReq({
      env: {
        PATH: "/usr/bin",
        HOME: "/home/operator",
        GITHUB_TOKEN: "ghp_SUPER_SECRET_VALUE_1234567890",
        ANTHROPIC_API_KEY: "sk-ant-SUPER_SECRET_VALUE",
      },
    });
    const record = buildDispatchTrace(req, okOutcome(), {
      homeScoped: false,
      anthropicApiKeyPresent: true,
      nativeBinaryResolved: true,
      startedAt: "2026-08-19T00:00:00.000Z",
      timeoutMs: 600_000,
    });

    // Names are present — the whole point is a Conductor can see WHAT was granted.
    const names = record.env.map((e) => e.name).sort();
    expect(names).toEqual(["ANTHROPIC_API_KEY", "GITHUB_TOKEN", "HOME", "PATH"]);
    // Every entry is name + `present: true` — structurally incapable of carrying a value.
    for (const e of record.env) {
      expect(Object.keys(e).sort()).toEqual(["name", "present"]);
      expect(e.present).toBe(true);
    }

    // The actual secret VALUES never appear anywhere in the serialized record, under any field.
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("ghp_SUPER_SECRET_VALUE_1234567890");
    expect(serialized).not.toContain("sk-ant-SUPER_SECRET_VALUE");
    // Nor the real HOME path — home_scoped is a boolean fact, never the literal directory.
    expect(serialized).not.toContain("/home/operator");
    expect(typeof record.home_scoped).toBe("boolean");
  });

  test("home_scoped reflects the boolean the caller passed, never a path, in both directions", () => {
    const req = baseReq();
    const scoped = buildDispatchTrace(req, okOutcome(), {
      homeScoped: true,
      anthropicApiKeyPresent: false,
      nativeBinaryResolved: false,
      startedAt: "2026-08-19T00:00:00.000Z",
      timeoutMs: 600_000,
    });
    expect(scoped.home_scoped).toBe(true);
    const unscoped = buildDispatchTrace(req, okOutcome(), {
      homeScoped: false,
      anthropicApiKeyPresent: false,
      nativeBinaryResolved: false,
      startedAt: "2026-08-19T00:00:00.000Z",
      timeoutMs: 600_000,
    });
    expect(unscoped.home_scoped).toBe(false);
  });
});

describe("buildDispatchTrace — outcome/timing/truncation shape", () => {
  test("a timed-out dispatch records outcome: timeout, the worker's captured stderr, and the timeout ceiling", () => {
    const req = baseReq();
    const record = buildDispatchTrace(
      req,
      { ok: false, error: "sdk worker timed out after 600000ms", timedOut: true, durationMs: 600_000, stdout: "", stderr: "levare: sdk worker query() retrying (attempt 1/3...)" },
      { homeScoped: false, anthropicApiKeyPresent: true, nativeBinaryResolved: true, startedAt: "2026-08-19T00:00:00.000Z", timeoutMs: 600_000 },
    );
    expect(record.outcome).toBe("timeout");
    expect(record.error).toBe("sdk worker timed out after 600000ms");
    expect(record.timeout_ms).toBe(600_000);
    expect(record.duration_ms).toBe(600_000);
    expect(record.worker_stderr).toContain("retrying");
    expect(record.worker_stderr_truncated).toBe(false);
  });

  test("a field longer than the cap is truncated and flagged, never silently dropped or silently shortened", () => {
    const req = baseReq({ context: "x".repeat(300_000) });
    const record = buildDispatchTrace(req, okOutcome({ stderr: "y".repeat(300_000) }), {
      homeScoped: false,
      anthropicApiKeyPresent: false,
      nativeBinaryResolved: false,
      startedAt: "2026-08-19T00:00:00.000Z",
      timeoutMs: 600_000,
    });
    expect(record.context.length).toBeLessThan(300_000);
    expect(record.context_truncated).toBe(true);
    expect(record.worker_stderr_truncated).toBe(true);
    expect(record.worker_stdout_truncated).toBe(false);
  });
});

describe("writeDispatchTrace — lands under <studioRoot>/.levare/dispatch-logs/, valid JSON, matches the record", () => {
  test("writes a readable file whose contents round-trip the record", () => {
    const studioRoot = mkdtempSync(join(tmpdir(), "levare-trace-studio-"));
    try {
      const req = baseReq();
      const record = buildDispatchTrace(req, okOutcome(), {
        homeScoped: false,
        anthropicApiKeyPresent: true,
        nativeBinaryResolved: true,
        startedAt: "2026-08-19T00:00:00.000Z",
        timeoutMs: 600_000,
      });
      writeDispatchTrace(studioRoot, record, "2026-08-19T00-00-00-000Z");
      const dir = join(studioRoot, DISPATCH_LOG_DIR_NAME);
      expect(existsSync(dir)).toBe(true);
      const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
      expect(files.length).toBe(1);
      expect(files[0]).toContain("list-entries");
      expect(files[0]).toContain("code");
      const parsed = JSON.parse(readFileSync(join(dir, files[0]), "utf8"));
      expect(parsed.unit).toBe("list-entries");
      expect(parsed.member).toBe("quill/builder");
      expect(parsed.outcome).toBe("ok");
    } finally {
      rmSync(studioRoot, { recursive: true, force: true });
    }
  });

  test("a member name containing '/' (team/member) never creates a nested path", () => {
    const studioRoot = mkdtempSync(join(tmpdir(), "levare-trace-studio-"));
    try {
      const record = buildDispatchTrace(baseReq({ member: "quill/builder" }), okOutcome(), {
        homeScoped: false,
        anthropicApiKeyPresent: false,
        nativeBinaryResolved: false,
        startedAt: "2026-08-19T00:00:00.000Z",
        timeoutMs: 600_000,
      });
      writeDispatchTrace(studioRoot, record, "2026-08-19T00-00-00-000Z");
      const dir = join(studioRoot, DISPATCH_LOG_DIR_NAME);
      const files = readdirSync(dir);
      expect(files.length).toBe(1);
      expect(files[0]).not.toContain("/");
    } finally {
      rmSync(studioRoot, { recursive: true, force: true });
    }
  });
});

describe("sweepDispatchTraces — bounded retention, both bounds applied independently", () => {
  function touchFile(dir: string, name: string, mtimeMs: number): void {
    const path = join(dir, name);
    Bun.write(path, "{}");
    const seconds = mtimeMs / 1000;
    utimesSync(path, seconds, seconds);
  }

  test("enforces a file-count cap, deleting the OLDEST files first", () => {
    const dir = mkdtempSync(join(tmpdir(), "levare-trace-sweep-"));
    try {
      const now = Date.parse("2026-08-19T00:00:00.000Z");
      for (let i = 0; i < 10; i++) {
        touchFile(dir, `trace-${i}.json`, now - (10 - i) * 1000); // trace-0 oldest, trace-9 newest
      }
      sweepDispatchTraces(dir, now, 5, Number.MAX_SAFE_INTEGER);
      const remaining = readdirSync(dir).sort();
      expect(remaining.length).toBe(5);
      // The 5 NEWEST survive — trace-5 through trace-9.
      expect(remaining).toEqual(["trace-5.json", "trace-6.json", "trace-7.json", "trace-8.json", "trace-9.json"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("enforces a max-age cap independently of the count cap", () => {
    const dir = mkdtempSync(join(tmpdir(), "levare-trace-sweep-"));
    try {
      const now = Date.parse("2026-08-19T00:00:00.000Z");
      const dayMs = 24 * 60 * 60 * 1000;
      touchFile(dir, "fresh.json", now - 1 * dayMs);
      touchFile(dir, "stale.json", now - 40 * dayMs);
      sweepDispatchTraces(dir, now, Number.MAX_SAFE_INTEGER, 30 * dayMs);
      const remaining = readdirSync(dir);
      expect(remaining).toEqual(["fresh.json"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a directory that doesn't exist yet is a silent no-op, never a throw", () => {
    expect(() => sweepDispatchTraces(join(tmpdir(), "levare-trace-sweep-does-not-exist"))).not.toThrow();
  });

  test("writeDispatchTrace itself sweeps on every write — an old file is gone after a fresh write pushes past the cap", () => {
    const studioRoot = mkdtempSync(join(tmpdir(), "levare-trace-studio-sweep-"));
    try {
      const dir = join(studioRoot, DISPATCH_LOG_DIR_NAME);
      const record = buildDispatchTrace(baseReq(), okOutcome(), {
        homeScoped: false,
        anthropicApiKeyPresent: false,
        nativeBinaryResolved: false,
        startedAt: "2026-08-19T00:00:00.000Z",
        timeoutMs: 600_000,
      });
      // Seed the directory with a file older than the retention window before the module ever ran.
      writeDispatchTrace(studioRoot, record, "2020-01-01T00-00-00-000Z");
      const seeded = readdirSync(dir);
      expect(seeded.length).toBe(1);
      // Backdate it so the sweep's age check (using the module's own default 30-day window against
      // the REAL Date.now()) actually fires — the file's mtime, not the trace's own started_at, is
      // what sweepDispatchTraces reads.
      const veryOld = Date.now() - 40 * 24 * 60 * 60 * 1000;
      utimesSync(join(dir, seeded[0]), veryOld / 1000, veryOld / 1000);
      // A fresh write triggers the opportunistic sweep.
      writeDispatchTrace(studioRoot, record, "2026-08-19T00-00-00-001Z");
      const after = readdirSync(dir);
      expect(after.length).toBe(1);
      expect(after[0]).not.toBe(seeded[0]);
    } finally {
      rmSync(studioRoot, { recursive: true, force: true });
    }
  });
});

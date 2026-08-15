import { test, expect, describe } from "bun:test";
import { ageLabel, medianGateResponseDays } from "../src/derive.ts";
import type { Repo } from "../src/repo.ts";
import type { Artifact, WorkUnit } from "../src/types.ts";

// NOTES "created timestamp" — the two live defects: `ageLabel` read a bare-date `created` from that
// date's UTC midnight, so an artifact produced minutes earlier displayed hours of age on the
// orchestrator card; `medianGateResponseDays` took a day-granularity delta between `created` and a date
// extracted from `approved_by`, so a gate opened and approved hours apart — but straddling a UTC
// midnight — read a full day's response time. Both are fixed by `created` carrying a full UTC
// timestamp now (validate.ts's `isIsoDate`, every write site) rather than a bare date; a bare
// `YYYY-MM-DD` stays permanently valid (pre-change artifacts), read as that day's UTC midnight.

function artifact(overrides: Partial<Artifact>): Artifact {
  return {
    kind: "spec",
    id: "spec-widget-v1",
    unit: "widget",
    project: "acme",
    status: "in-review",
    produced_by: "team/member",
    consumes: [],
    supersedes: null,
    approved_by: null,
    created: "2026-08-13T00:00:00.000Z",
    files: [],
    ...overrides,
  };
}

function unit(overrides: Partial<WorkUnit> = {}): WorkUnit {
  return { type: "feature", status: "active", project: "acme", unit: "widget", dir: "/tmp/nonexistent", ...overrides };
}

function repoOf(units: WorkUnit[], artifactsByUnit: Record<string, Artifact[]>): Repo {
  const artifacts = new Map<string, Map<string, Artifact>>();
  for (const [key, arts] of Object.entries(artifactsByUnit)) {
    artifacts.set(key, new Map(arts.map((a) => [a.id, a])));
  }
  return {
    root: "/tmp/nonexistent",
    teams: new Map(),
    agents: new Map(),
    types: new Map(),
    projects: new Map(),
    connectors: new Map(),
    units,
    artifacts,
    studio: {},
  };
}

describe("derive.ts#ageLabel — precise `created` timestamp (NOTES 'created timestamp')", () => {
  test("an artifact created and read within the same minute reports a sub-hour age, not a fabricated 'Nh'", () => {
    const now = new Date("2026-08-15T14:32:40.000Z");
    const created = new Date(now.getTime() - 45_000).toISOString(); // 45s earlier, same minute
    expect(ageLabel(created, now)).toBe("just now");
  });

  test("an artifact created 90 minutes before `now`, both mid-day, reports '1h' — not inflated by flooring to midnight", () => {
    const now = new Date("2026-08-15T14:32:00.000Z");
    const created = "2026-08-15T13:02:00.000Z"; // 90 minutes before now, same UTC day
    expect(ageLabel(created, now)).toBe("1h");
  });

  test("backward compat: a pre-change bare-date created (YYYY-MM-DD) still reads — as that day's UTC midnight", () => {
    const now = new Date("2026-08-13T07:00:00.000Z");
    // Old behavior, still correct for old data: reads as 7h from UTC midnight, not an error/empty string.
    expect(ageLabel("2026-08-13", now)).toBe("7h");
  });

  test("an unparseable created never throws — empty label", () => {
    expect(ageLabel("not-a-date", new Date())).toBe("");
  });
});

describe("derive.ts#medianGateResponseDays — precise `created` timestamp (NOTES 'created timestamp')", () => {
  test("a gate opened and approved minutes apart, straddling a UTC midnight boundary, does not report a full day", () => {
    // Gate opened 2026-08-13 23:58 UTC, approved 2026-08-14 00:03 UTC — 5 real minutes apart, but the
    // OLD day-floored `created` (midnight of the 13th) vs. approved_by's date (the 14th) read exactly
    // 1.0 days. The boundary case is the bug — a same-day test proves nothing.
    const art = artifact({
      status: "approved",
      created: "2026-08-13T23:58:00.000Z",
      approved_by: "Cas 2026-08-14",
    });
    const repo = repoOf([unit()], { "acme/widget": [art] });
    const median = medianGateResponseDays(repo);
    expect(median).not.toBeNull();
    // 5 minutes ≈ 0.0035 days — nowhere near the old, wrong 1.0.
    expect(median!).toBeLessThan(0.01);
  });

  test("opened just after UTC midnight and approved later the same calendar day reads near zero, never negative", () => {
    const art = artifact({
      status: "approved",
      created: "2026-08-14T00:05:00.000Z",
      approved_by: "Cas 2026-08-14",
    });
    const repo = repoOf([unit()], { "acme/widget": [art] });
    const median = medianGateResponseDays(repo);
    expect(median).not.toBeNull();
    expect(median!).toBeLessThan(0.01);
  });

  test("backward compat: a pre-change bare-date created still computes a sane (non-NaN, non-negative) delta", () => {
    const art = artifact({
      status: "approved",
      created: "2026-08-11",
      approved_by: "Cas 2026-08-13",
    });
    const repo = repoOf([unit()], { "acme/widget": [art] });
    const median = medianGateResponseDays(repo);
    expect(median).toBe(2);
  });

  test("no approved artifacts at all → null, not zero (an empty result is not a real median of zero days)", () => {
    const repo = repoOf([unit()], { "acme/widget": [artifact({ status: "in-review", approved_by: null })] });
    expect(medianGateResponseDays(repo)).toBeNull();
  });
});

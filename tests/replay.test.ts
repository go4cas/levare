import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { runReplay, formatReport, serialize } from "../src/replay.ts";
import { main } from "../src/cli.ts";

// `levare replay fixtures/golden --stubs` is the phase-2 acceptance surface. These tests assert the
// transcript demonstrates each required behaviour and that the golden scenario reproduces the
// permanent oracle in fixtures/golden/expected.json byte-for-byte.

describe("replay", () => {
  const report = runReplay("fixtures/golden");

  test("golden scenario matches expected.json byte-for-byte", () => {
    const onDisk = readFileSync("fixtures/golden/expected.json", "utf8");
    expect(serialize(report.oracle)).toBe(onDisk);
    expect(report.match).toBe(true);
  });

  test("expected.json records the derived final statuses", () => {
    expect(report.oracle.artifacts).toEqual({
      "design-checkout-v1": "approved",
      "product-brief-v1": "approved",
      "review-checkout-flow-v1": "superseded",
      "review-checkout-flow-v2": "approved",
      "spec-checkout-flow-v1": "superseded",
      "spec-checkout-flow-v2": "approved",
    });
    expect(report.oracle.unit.status).toBe("active");
  });

  test("no scenario leaves an artifact at in-review with no open gate (C2)", () => {
    for (const sc of report.scenarios) {
      const inReview = Object.entries(sc.statuses.artifacts).filter(([, s]) => s === "in-review");
      expect(inReview).toEqual([]);
    }
  });

  test("exhaustion resolves the spec to rejected and its final review to approved (C2)", () => {
    const exhaust = report.scenarios.find((s) => s.name === "exhaust")!;
    expect(exhaust.statuses.artifacts["spec-checkout-flow-v3"]).toBe("rejected");
    expect(exhaust.statuses.artifacts["review-checkout-flow-v3"]).toBe("approved");
  });

  test("transcript shows the walk halting at each declared gate and resuming", () => {
    const t = formatReport(report);
    // Every gate line halts and every resolution resumes.
    expect(t).toContain("GATE ▸ brief");
    expect(t).toContain("GATE ▸ design");
    expect(t).toContain("GATE ▸ spec review");
    expect(t.match(/HALT, awaiting Conductor/g)!.length).toBeGreaterThanOrEqual(4);
    expect(t).toContain("→ resume");
  });

  test("transcript shows the loop terminating by condition in round 2", () => {
    const golden = report.scenarios.find((s) => s.name === "golden")!;
    const t = formatReport({ ...report, scenarios: [golden] });
    expect(t).toContain("terminated by condition in round 2");
  });

  test("transcript shows the 3-round exhaustion escalating via on_exhaust: gate", () => {
    const t = formatReport(report);
    expect(t).toContain("exhausted after 3 rounds → on_exhaust: gate");
    expect(t).toContain("GATE ▸ spec exhausted");
    expect(t).toContain("on_exhaust: gate");
  });

  test("both scenarios are present in the report", () => {
    expect(report.scenarios.map((s) => s.name)).toEqual(["golden", "exhaust"]);
  });

  test("the transcript shows a usage receipt for every invocation (§10, phase 3)", () => {
    const golden = report.scenarios.find((s) => s.name === "golden")!;
    const produced = golden.events.filter((e) => e.t === "produce");
    // Every produce event carries a normalized receipt from the adapter boundary.
    expect(produced.every((e) => e.t === "produce" && e.receipt !== undefined)).toBe(true);
    const t = formatReport({ ...report, scenarios: [golden] });
    expect(t).toContain("usage: $0.06"); // wren's brief, priced from the table
    expect(t).toContain("usage: unreported"); // finch/Codex reports nothing
  });

  test("the deliberately-silent CLI member is recorded as unreported, never $0 (§10)", () => {
    const golden = report.scenarios.find((s) => s.name === "golden")!;
    const finch = golden.events.filter((e) => e.t === "produce" && e.member === "kestrel/finch");
    expect(finch.length).toBeGreaterThan(0);
    for (const e of finch) {
      if (e.t !== "produce") continue;
      expect(e.receipt?.unreported).toBe(true);
      expect(e.receipt?.usd).toBe(null);
    }
  });

  test("CLI `replay <path> --stubs` exits 0", () => {
    expect(main(["replay", "fixtures/golden", "--stubs"])).toBe(0);
  });

  test("CLI `replay` without --stubs exits 2", () => {
    expect(main(["replay", "fixtures/golden"])).toBe(2);
  });
});

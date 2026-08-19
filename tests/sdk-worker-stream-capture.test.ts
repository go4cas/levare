import { test, expect, describe } from "bun:test";
import { assistantContentLogLines } from "../src/sdk-worker.ts";

// NOTES DISPATCH-TRACE (native-dispatch-hang investigation, phase 1 recovery): Phase 1 established that
// sdk-worker.ts's `for await` loop previously retained NOTHING from a streamed `assistant` message except
// two narrow signals (an `api_retry` counter, the responding model) — every text/tool_use block, `Write`
// included, was inspected only for those two signals and discarded. `assistantContentLogLines` closes
// that gap; these tests exercise it directly (pure, no real SDK/subprocess involved), mirroring
// tests/sdk-worker-receipt.test.ts's own precedent for testing sdk-worker.ts's pure pieces in isolation.

describe("assistantContentLogLines — recovers a member's own text and tool calls from a streamed message", () => {
  test("a text block renders one log line carrying the text verbatim", () => {
    const lines = assistantContentLogLines([{ type: "text", text: "Here is my plan for the checkout flow." }]);
    expect(lines).toEqual(["levare: sdk worker assistant text: Here is my plan for the checkout flow."]);
  });

  test("a tool_use block (Write, the standing Finding 70 case) renders the tool name and its full input", () => {
    const lines = assistantContentLogLines([{ type: "tool_use", name: "Write", input: { file_path: "src/checkout.ts", content: "export const total = 42;" } }]);
    expect(lines).toEqual([`levare: sdk worker tool_use Write: ${JSON.stringify({ file_path: "src/checkout.ts", content: "export const total = 42;" })}`]);
  });

  test("multiple blocks in one message each render their own line, in order", () => {
    const lines = assistantContentLogLines([
      { type: "text", text: "Writing the file now." },
      { type: "tool_use", name: "Write", input: { file_path: "a.ts" } },
      { type: "tool_use", name: "Bash", input: { command: "bun test" } },
    ]);
    expect(lines).toEqual([
      "levare: sdk worker assistant text: Writing the file now.",
      `levare: sdk worker tool_use Write: ${JSON.stringify({ file_path: "a.ts" })}`,
      `levare: sdk worker tool_use Bash: ${JSON.stringify({ command: "bun test" })}`,
    ]);
  });

  test("a thinking block (or any other block type) is silently skipped, not thrown on", () => {
    expect(assistantContentLogLines([{ type: "thinking", thinking: "internal reasoning" }])).toEqual([]);
  });

  test("a tool_use block with no input renders `null`, never throws on a missing field", () => {
    expect(assistantContentLogLines([{ type: "tool_use", name: "TodoWrite" }])).toEqual(['levare: sdk worker tool_use TodoWrite: null']);
  });

  test("defensive against malformed/absent content — never throws, always an empty array", () => {
    expect(assistantContentLogLines(undefined)).toEqual([]);
    expect(assistantContentLogLines(null)).toEqual([]);
    expect(assistantContentLogLines("not an array")).toEqual([]);
    expect(assistantContentLogLines([null, 42, "garbage", { type: "text" /* no .text */ }])).toEqual([]);
  });
});

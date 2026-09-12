import { test, expect, describe, mock } from "bun:test";
import { evaluateBashSandboxGuard, buildSandboxEscapeHook, SANDBOX_ESCAPE_DENIAL_MESSAGE } from "../src/sdk-worker.ts";

// Goal 2026-09-12 (defect 3 — "sdk-worker.ts runs with permissionMode bypassPermissions"). Mason (the
// live buildlog dispatch) set `dangerouslyDisableSandbox: true` on six Bash calls while fighting defect
// 1's own git-read denial — an escape hatch this codebase's own Bash tool schema documents as
// "dangerously override sandbox mode and run commands without sandboxing" for the CALLING Claude Code
// session's own sandbox. Nothing stops a dispatched member from reaching for the identical flag against
// LEVARE's sandbox: `buildQueryOptions` (sdk-worker.ts) sets `permissionMode: "bypassPermissions"` with
// no `canUseTool`/`hooks` guard of any kind, so every tool call — Bash included, flag included — is
// auto-approved today. `evaluateBashSandboxGuard` is the pure decision this unit's PreToolUse hook wires
// into `query()`'s own `hooks` option: refuse a Bash call carrying the flag, let everything else through
// unchanged. Deliberately a pure function (mirrors `classifyLocalSdkError`/`isNonRetryableAuthStatus`'s
// own precedent) so this is testable without spawning the real SDK or a real sandboxed process.
describe("evaluateBashSandboxGuard — refuses a Bash call carrying dangerouslyDisableSandbox, never touches anything else", () => {
  test("a Bash tool_use with dangerouslyDisableSandbox: true is denied", () => {
    const verdict = evaluateBashSandboxGuard("Bash", { command: "cat /etc/shadow", dangerouslyDisableSandbox: true });
    expect(verdict).not.toBeUndefined();
    expect(verdict?.permissionDecision).toBe("deny");
    expect(verdict?.permissionDecisionReason).toMatch(/sandbox/i);
    expect(verdict?.permissionDecisionReason).toMatch(/levare/i);
  });

  test("an ordinary Bash tool_use with no such flag passes through untouched", () => {
    expect(evaluateBashSandboxGuard("Bash", { command: "ls -la" })).toBeUndefined();
  });

  test("dangerouslyDisableSandbox: false is not a refusal — only an explicit true trips the guard", () => {
    expect(evaluateBashSandboxGuard("Bash", { command: "ls -la", dangerouslyDisableSandbox: false })).toBeUndefined();
  });

  test("a non-Bash tool carrying the same-shaped input is never touched — this guard is Bash-specific", () => {
    expect(evaluateBashSandboxGuard("Read", { dangerouslyDisableSandbox: true })).toBeUndefined();
  });

  test("malformed/missing input never throws — degrades to no-op", () => {
    expect(evaluateBashSandboxGuard("Bash", null as unknown as Record<string, unknown>)).toBeUndefined();
    expect(evaluateBashSandboxGuard("Bash", {} as Record<string, unknown>)).toBeUndefined();
  });
});

// The actual wiring `runSdkWorkerFromStdin` plugs into `query()`'s own `hooks.PreToolUse` — exercised
// directly here (a fake `PreToolUseHookInput`, no real SDK/spawn needed) so the hook's own `continue`/
// `hookSpecificOutput` shape and its `onDenied` counting callback are both covered, not just the pure
// decision `evaluateBashSandboxGuard` makes underneath it.
describe("buildSandboxEscapeHook — the actual PreToolUse hook wired into query()", () => {
  const preToolUse = (toolName: string, toolInput: unknown) => ({
    hook_event_name: "PreToolUse" as const,
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: "toolu_test",
    session_id: "test-session",
    transcript_path: "/dev/null",
    cwd: "/work",
    permission_mode: "bypassPermissions",
  });

  test("denies and counts a Bash call carrying dangerouslyDisableSandbox: true", async () => {
    const onDenied = mock(() => {});
    const hook = buildSandboxEscapeHook(onDenied);
    const result = await hook.hooks[0](preToolUse("Bash", { command: "id", dangerouslyDisableSandbox: true }), "toolu_test", { signal: new AbortController().signal });
    expect(result).toMatchObject({ continue: false, stopReason: SANDBOX_ESCAPE_DENIAL_MESSAGE });
    expect((result as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(onDenied).toHaveBeenCalledTimes(1);
  });

  test("lets an ordinary Bash call through and never counts it", async () => {
    const onDenied = mock(() => {});
    const hook = buildSandboxEscapeHook(onDenied);
    const result = await hook.hooks[0](preToolUse("Bash", { command: "id" }), "toolu_test", { signal: new AbortController().signal });
    expect(result).toEqual({ continue: true });
    expect(onDenied).not.toHaveBeenCalled();
  });

  test("ignores a non-PreToolUse hook input entirely", async () => {
    const onDenied = mock(() => {});
    const hook = buildSandboxEscapeHook(onDenied);
    const result = await hook.hooks[0]({ hook_event_name: "SessionStart" } as unknown as Parameters<typeof hook.hooks[0]>[0], "toolu_test", { signal: new AbortController().signal });
    expect(result).toEqual({ continue: true });
    expect(onDenied).not.toHaveBeenCalled();
  });
});

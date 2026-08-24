// levare SDK transport (phase 7, closing invariant-10's "mocked this phase" deferral). Both real
// implementations spawn a small standalone worker script (`sdk-worker.ts`) that makes the one real
// async `query()` call (the SDK itself is inherently async — it spawns and streams from a `claude`
// CLI subprocess, confirmed from the SDK's own shipped README) and prints its outcome as a single
// line of JSON on stdout. This module has TWO ways of spawning that worker, for two different trust
// levels of caller:
//
//   `SdkTransport`      — SYNCHRONOUS, via `Bun.spawnSync`, exactly the pattern `adapters.ts`'s
//                          `CliSpawn`/`bunSpawn` already uses for the "cli" agent kind. Used ONLY by
//                          `NativeBoundary` (adapters.ts), which is not reachable from any live
//                          `levare serve` request path today (NOTES K5) — nothing yet calls it from
//                          inside `Bun.serve`'s single-threaded request handler.
//   `AsyncSdkTransport` — genuinely non-blocking, via `Bun.spawn` + `await`. Used by
//                          `OrchestratorBoundary` (orchestrator-boundary.ts), which IS wired into
//                          `board/serve.ts`'s `/orchestrator/message` route.
//
// The distinction is load-bearing, not stylistic (NOTES phase-7 K9, a live-gate fix-up): a live run
// with a real key showed `Bun.spawnSync` freezing the ENTIRE server — not just the in-flight request,
// but concurrent unrelated ones too (`GET /styles.css`, a plain static-file read with no SDK
// involvement, timed out while an `/orchestrator/message` call was in flight). Bun's server runs on
// one JS thread; a blocking synchronous spawn call freezes that thread — and therefore every
// concurrent connection — for as long as the child process runs, exactly like any other synchronous
// blocking call would. `Bun.spawn` (async) does not: the OS-level wait happens off-thread, and
// `await`ing its exit yields the event loop back to Bun.serve for the duration.
//
// This is also the literal "transport level" the goal asks tests to mock at: both interfaces are
// injectable exactly like `CliSpawn` (adapters.test.ts already establishes the pattern of injecting a
// fake spawn and asserting the argv/env it was handed), so `bun test` never spawns a real worker,
// never touches the network, and never needs `ANTHROPIC_API_KEY`.
//
// Env trust boundary (phase-7 live-gate fix-up, NOTES K8): env.ts's allowlist-only scoping
// (`buildMemberEnv`) is correct for a MEMBER's spawned process — a member is a granted, scoped
// participant and must see nothing beyond PATH/HOME plus its own connectors' vars. The worker this
// module spawns is NOT a member; it is levare's own Orchestrator, running with the same trust level
// as the process that launched `levare` itself. It must inherit the FULL launching environment
// (including whatever credential — `ANTHROPIC_API_KEY`, an OAuth profile env var, AWS/GCP creds for
// a third-party backend — the SDK needs to authenticate), not an allowlisted subset. Every caller of
// `bunSdkTransport`/`createBunSdkTransport` in this repo therefore passes the FULL environment
// (`process.env`, unscoped) as `opts.env` — see orchestrator-boundary.ts's `createSdkOrchestratorBoundary`,
// whose default is exactly `process.env`. `createSdkNativeBoundary` (adapters.ts) is the one caller
// that scopes `env` — for a *member* invocation, correctly, per invariant 11 — and it explicitly adds
// `ANTHROPIC_API_KEY` back on top of that scoped set for the same reason: the platform credential is
// not a connector grant, but the SDK call still needs it regardless of what the member was granted.

import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Receipt } from "./types.ts";
import { isCompiledBuild } from "./version.ts";
// The literal (test-stub `null`, or build-time-rewritten file asset — NOTES DIST7) that a compiled
// binary embeds via Bun's `with { type: "file" }` import. See native-binary.generated.ts's own
// header for why this must be a static import here, not something resolved dynamically.
import embeddedNativeBinaryAsset from "./native-binary.generated.ts";

// NOTES CAP-B (v1.1 capability layer, part B, item 1): the fixed vocabulary an agent's `tools:` may
// name — validated (validate.ts#validateAgentTools), never a free-form registry. Derived HONESTLY from
// this installed SDK version's own `ToolInputSchemas` union
// (node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts), the one place this SDK version
// documents, machine-checkably, every tool name `query()`'s `tools`/`allowedTools` options can name —
// every entry below is that union's own `*Input` interface name with the `Input` suffix stripped, and
// `File` stripped from `FileRead`/`FileWrite`/`FileEdit` (confirmed against `sdk.d.ts`'s own two
// worked examples: `tools: ['Read', 'Grep', 'Glob', 'Bash']` and `['Bash', 'Read', 'Edit']` — the
// capitalized, un-prefixed forms are what the SDK's own docs use). Never hand-invented: a name that
// isn't a sibling of an actual `*Input` schema in this SDK version does not appear here, and a
// version bump that adds/removes a tool schema is the only thing that should ever change this list.
export const SDK_TOOL_NAMES: readonly string[] = [
  "Agent",
  "Artifact",
  "AskUserQuestion",
  "Bash",
  "ClaudeDesign",
  "CronCreate",
  "CronDelete",
  "CronList",
  "Edit",
  "EnterPlanMode",
  "EnterWorktree",
  "ExitPlanMode",
  "ExitWorktree",
  "Glob",
  "Grep",
  "ListMcpResources",
  "Mcp",
  "Monitor",
  "NotebookEdit",
  "Projects",
  "PushNotification",
  "Read",
  "ReadMcpResource",
  "ReadMcpResourceDir",
  "REPL",
  "RemoteTrigger",
  "ReportFindings",
  "ScheduleWakeup",
  "ShowOnboardingRolePicker",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "TaskStop",
  "TaskUpdate",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  "Workflow",
  "Write",
] as const;

export interface SdkWorkerRequest {
  /** The user-turn content sent to the model this call. */
  prompt: string;
  /** Loaded verbatim from disk by the caller (never edited/appended here) when set. */
  systemPrompt?: string;
  model?: string;
  /** Base tool set the model may see (levare's own `tools:` vocabulary, validated against
   * `SDK_TOOL_NAMES` above at `levare validate` time — passed through as-is here; see NOTES phase-7 K2
   * for the scope boundary on SDK built-in tool-name mapping). */
  tools?: string[];
  allowedTools?: string[];
  outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
  cwd?: string;
  /** Explicit override for the SDK's own native-binary resolution (NOTES phase-7 K14) — resolved
   * ONCE by `resolveNativeBinary` at boundary-construction time and passed through unchanged on every
   * request, so the worker's real `query()` call never relies on the SDK's own implicit resolution
   * (which showed a resolution mismatch on at least one host — see K14). Unset only when resolution
   * itself failed, in which case the SDK falls back to its own (equally unresolvable) attempt. */
  pathToClaudeCodeExecutable?: string;
}

// `nativeBinaryResolved` (Finding 112): optional on BOTH branches — the worker itself always knows the
// answer and reports it (`sdk-worker.ts#runSdkWorkerFromStdin`), but a TRANSPORT-level failure (worker
// script not found, timed out before responding, exited without valid JSON) never reaches the worker's
// own `respond()` call at all, so the transport's own synthesized `{ok:false,...}` legitimately has no
// value to report — absent, not `false`: the resolution outcome is genuinely unknown, not a negative.
export type SdkWorkerResponse =
  | { ok: true; result: string; structuredOutput?: unknown; receipt?: Receipt; nativeBinaryResolved?: boolean }
  | { ok: false; error: string; nativeBinaryResolved?: boolean };

/**
 * NOTES DISPATCH-TRACE (native-dispatch-hang investigation, 2026-08-19): what `run()` actually returns,
 * on EVERY exit path including a timeout — the worker's own captured stdout/stderr text and how long the
 * spawn ran for. Before this, the timeout branch of both transports read `proc.stdout`/`proc.stderr` (or,
 * for the async transport, fully awaited and decoded them) and then discarded them unconditionally in the
 * returned error — the diagnostic text a hung/slow worker printed (elapsed time, `api_retry` messages,
 * sdk-worker.ts's own always-on exit-path logging) existed in memory and was thrown away before any
 * caller ever saw it. `SdkWorkerResponse` itself stays the worker's own wire contract (what it printed as
 * its one line of JSON); this wraps it with what the TRANSPORT observed spawning it — the caller
 * (adapters.ts's dispatch-trace wiring) is the one place that needs both together. */
export type SdkTransportResult = SdkWorkerResponse & {
  /** The worker's full captured stdout, trimmed — on success this is exactly the one JSON line
   * `sdk-worker.ts#respond` printed; on any failure/timeout it may carry non-JSON diagnostic text. */
  stdout: string;
  /** The worker's full captured stderr, trimmed — `sdk-worker.ts`'s own always-on exit-path logging
   * (elapsed time, `api_retry` messages) lives here, on every exit path, timeout included. */
  stderr: string;
  /** Wall-clock time this transport call spent spawned, in ms — measured by the transport, independent
   * of whatever the worker itself may or may not have reported. */
  durationMs: number;
  /** Whether THIS transport killed the process tree itself after `timeoutMs` elapsed — distinct from
   * `!ok`, which also covers a normal non-zero exit or malformed output. */
  timedOut: boolean;
};

/**
 * Finding 75 (part 2): when supplied, wraps the WORKER's own OS-level self-invocation spawn (never the
 * `claude` subprocess the SDK itself spawns internally, which this transport cannot see) for whichever
 * sandbox primitive this host has — the SAME `sandbox.ts#wrapForSandbox` mechanism a `kind: cli`
 * member's spawn already goes through, applied here to the worker instead. Given the RAW argv/cwd this
 * transport was about to spawn with, returns what to spawn instead (`argv` may be unchanged — `level:
 * "none"` still calls through, honestly reporting nothing was available — `cleanup`, when present, MUST
 * be invoked once the spawn completes, success or failure alike — mirrors `sandbox.ts#WrappedSpawn`'s
 * own contract exactly, since this IS that contract, just not typed against `sandbox.ts` directly here
 * so this module stays free of any sandbox-specific import). Only ever called on the REAL self-invocation
 * path (no explicit `workerPath`) — see `createBunSdkTransport`'s own guard for why a standalone test
 * script is never wrapped. Absent (every test double, and the async orchestrator boundary, which has its
 * own unrelated caller) is a legal no-op: the worker spawns exactly as it always has.
 */
export interface WrapWorkerSpawn {
  (argv: string[], cwd: string): { argv: string[]; cleanup?: () => void };
}

export interface SdkTransportRunOptions {
  env: Record<string, string | undefined>;
  timeoutMs: number;
  wrapWorkerSpawn?: WrapWorkerSpawn;
}

/** The synchronous transport boundary (adapters.ts's NativeBoundary only — see the module note above
 * for why this must never be called from a `levare serve` request path). Declared return type stays
 * `SdkWorkerResponse` deliberately — every test double across this repo implementing this interface
 * returns exactly that shape, and widening the declared contract would force-edit every one of them for
 * a fact only the two REAL implementations below actually produce. The real implementations return the
 * strictly wider `SdkTransportResult` (structurally assignable to `SdkWorkerResponse`, so no cast is
 * needed on the producing side); a caller that specifically wants the diagnostic fields (adapters.ts's
 * dispatch-trace wiring — the only caller that does) narrows via `asSdkTransportResult` below, which
 * degrades to empty/zero defaults for an injected test double that never populated them. */
export interface SdkTransport {
  run(req: SdkWorkerRequest, opts: SdkTransportRunOptions): SdkWorkerResponse;
}

/** The non-blocking transport boundary (orchestrator-boundary.ts — the one reachable from
 * `levare serve`'s request path). Same request/response shape as `SdkTransport`, Promise-returning. */
export interface AsyncSdkTransport {
  run(req: SdkWorkerRequest, opts: SdkTransportRunOptions): Promise<SdkWorkerResponse>;
}

/** Narrows a transport's return value to `SdkTransportResult`, defaulting the diagnostic fields when
 * they're absent — true for every test double in this repo (none of them populate `stdout`/`stderr`/
 * `durationMs`/`timedOut`; only `createBunSdkTransport`/`createAsyncSdkTransport` below do), so a
 * dispatch trace built from a mocked/stub boundary records honest "nothing captured" defaults rather
 * than throwing on an undefined field. */
export function asSdkTransportResult(res: SdkWorkerResponse): SdkTransportResult {
  const r = res as Partial<SdkTransportResult>;
  return { ...res, stdout: r.stdout ?? "", stderr: r.stderr ?? "", durationMs: r.durationMs ?? 0, timedOut: r.timedOut ?? false };
}

// `Bun.fileURLToPath` (not raw `URL.pathname`), matching the pattern already established in
// adapters.test.ts for spawning a real subprocess against a `file://`-resolved script path — a raw
// `.pathname` can carry percent-encoded characters (spaces, unicode) that a literal argv element
// spawned with no shell will not decode, which `fileURLToPath` handles correctly.
export const SDK_WORKER_PATH = Bun.fileURLToPath(new URL("./sdk-worker.ts", import.meta.url));

// ---------------------------------------------------------------------------
// Self-invocation worker spawn (NOTES DIST5 — the standard `bun build --compile` pattern)
// ---------------------------------------------------------------------------
//
// The REAL worker spawn (`createBunSdkTransport`/`createAsyncSdkTransport` with no explicit
// `workerPath` override) used to be `Bun.spawn([process.execPath, SDK_WORKER_PATH])` — spawn a
// generic script interpreter against a resolved file path. That is correct in a source run
// (`process.execPath` is the real `bun` interpreter), but under `bun build --compile`,
// `process.execPath` IS the compiled binary itself, which only knows how to run its own embedded
// entrypoint — confirmed live, `dist/levare <any script path>` printed `unknown command: <path>`
// (NOTES DIST4). The fix: spawn a FRESH COPY OF THIS SAME PROCESS, told to run in worker mode via a
// hidden CLI flag (`WORKER_COMMAND`, dispatched by `cli.ts#runCli`), rather than a separate script.
//
//   - Compiled: `process.execPath` is the standalone binary — re-invoking it with just the flag
//     re-enters its own embedded entrypoint directly (confirmed empirically: a compiled binary
//     spawning itself with `[execPath, "flag"]` reports `process.argv.slice(2) === ["flag"]` in the
//     child, identical to how the top-level dispatch already reads its own argv).
//   - Source: `process.execPath` is a generic `bun` interpreter with no script bound to it —
//     `bun __worker` alone fails with `error: Script not found "__worker"`. It needs an explicit
//     script argument, so this file's own entry point (`cli.ts`) is handed to it, exactly the same
//     `import.meta.url`-resolution idiom `SDK_WORKER_PATH` above already uses (safe here specifically
//     because it is ONLY ever read when `isCompiledBuild()` is false — a source run's
//     `import.meta.url` resolves to a real on-disk path; only `--compile` rewrites it into the
//     virtual `$bunfs` tree that broke the old approach).
//
// Either way the CHILD's `process.argv.slice(2)` ends up exactly `[WORKER_COMMAND]`, landing on the
// identical dispatch every other CLI command already goes through — no special-casing between the
// two run modes beyond this one argv-shape difference.
export const WORKER_COMMAND = "__worker";

const CLI_ENTRY_PATH = Bun.fileURLToPath(new URL("./cli.ts", import.meta.url));

// Exported (Finding 75 part 2): `adapters.ts`'s native sandbox wiring needs to know the EXACT argv a
// real self-invocation spawns so a diagnostic script can build the identical wrapped invocation
// `createBunSdkTransport`/`createAsyncSdkTransport` do — mirrors `buildDispatchSandboxPolicy`'s own
// export for the identical "a ladder must call the real thing, never hand-mirror it" reason (NOTES
// R4-SANDBOX-FIX-13).
export function workerSpawnArgv(): string[] {
  return isCompiledBuild() ? [process.execPath, WORKER_COMMAND] : [process.execPath, CLI_ENTRY_PATH, WORKER_COMMAND];
}

// A live-binary spawn attempt caught a second, distinct compiled-only bug (NOTES DIST5): every
// spawn below pins an explicit `cwd` (`LEVARE_ROOT`, derived from `SDK_WORKER_PATH`) so the worker
// script resolves its own node_modules regardless of the caller's cwd. `LEVARE_ROOT` is a real,
// walkable on-disk directory in a source run, but under `--compile` it resolves into Bun's virtual
// `$bunfs` tree — an unwalkable path that made the OS-level `posix_spawn` itself fail with
// `ENOENT: no such file or directory, posix_spawn '<execPath>'` (confirmed live: `Bun.spawn` cannot
// `chdir` into a cwd that doesn't exist on the real filesystem, so the child never even starts,
// regardless of the argv fix above). A compiled self-invocation needs no pinned cwd at all — the
// worker's own module resolution is irrelevant (everything is embedded) and the native-binary path
// is already resolved once and passed explicitly (`pathToClaudeCodeExecutable`) — so it simply omits
// `cwd`, which makes `Bun.spawn` inherit the running process's own (real) cwd instead.
// Exported (Finding 75 part 2) for the same reason as `workerSpawnArgv` above.
export function workerSpawnCwd(workerPath: string | undefined): string | undefined {
  if (workerPath === undefined && isCompiledBuild()) return undefined;
  return LEVARE_ROOT;
}

/**
 * Whether the environment carries credentials the SDK can authenticate with — presence only, the
 * value itself is never read into a log, artifact, or commit (invariant 11), mirroring doctor.ts's
 * `EnvProbe` posture exactly. One of the two local preconditions `checkSdkPreconditions` checks before
 * `selectOrchestratorBoundary` will return a real boundary at all (NOTES C11: the other outcome is
 * `null` — unavailable — never a stand-in implementation).
 */
export function hasAnthropicCredentials(env: Record<string, string | undefined> = process.env): boolean {
  return typeof env.ANTHROPIC_API_KEY === "string" && env.ANTHROPIC_API_KEY.length > 0;
}

// The levare repo root — the directory holding this project's own package.json/node_modules — pinned
// explicitly as `cwd` for every worker spawn below (NOTES phase-7 K13), rather than left to inherit
// from whatever process spawns it. `SDK_WORKER_PATH` is `<root>/src/sdk-worker.ts`; two `dirname`s up.
export const LEVARE_ROOT = dirname(dirname(SDK_WORKER_PATH));

// Deliberately well under a minute (NOTES phase-7 K15): a live host's own outer test timeout (60s)
// was SHORTER than this transport's prior default (120s), so the transport's own timeout-kill never
// got a chance to fire before the outer caller gave up first — "killed 1 dangling process" was Bun's
// own cleanup catching what this transport should have caught itself. Every caller in this repo must
// keep its own timeout comfortably LONGER than this value, not the other way around.
const DEFAULT_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Fast, local SDK-viability precondition check (NOTES phase-7 K13)
// ---------------------------------------------------------------------------
//
// A missing native CLI binary is knowable in milliseconds — the SDK's own resolution of it
// (extracted directly from the shipped sdk.mjs, not guessed) is a synchronous `require.resolve` loop
// over a handful of platform-specific package names, with no network or subprocess involved. Probing
// this cheaply, ONCE per cache window, lets `selectOrchestratorBoundary` report "unavailable" for a
// genuinely broken install — never spawning the worker at all — instead of discovering the same fact
// only after a slow, per-request spawn-and-fail. A credential or network problem (something this local
// check cannot know) still surfaces the slow way, per request, exactly as it already did (K11) — this
// optimization only ever short-circuits a LOCAL, static precondition, never second-guesses a live call
// that might simply be slow.

const SDK_PACKAGE_NAME = "@anthropic-ai/claude-agent-sdk";

// The exact candidate package names query()'s own internal resolver tries — extracted verbatim from
// `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`'s own resolution function, not derived
// independently, so this probe can never disagree with what the real call would actually attempt.
// Both Linux libc variants are tried (in either order — either resolving is a sufficient "viable"
// signal; we don't need to replicate the SDK's own musl-vs-glibc PICK, only its candidate SET).
function nativeBinaryCandidates(platform: string, arch: string): string[] {
  const ext = platform === "win32" ? ".exe" : "";
  const names =
    platform === "android"
      ? [`${SDK_PACKAGE_NAME}-linux-${arch}-android`]
      : platform === "linux"
        ? [`${SDK_PACKAGE_NAME}-linux-${arch}`, `${SDK_PACKAGE_NAME}-linux-${arch}-musl`]
        : [`${SDK_PACKAGE_NAME}-${platform}-${arch}`];
  return names.map((n) => `${n}/claude${ext}`);
}

// ---------------------------------------------------------------------------
// The compiled-binary resolution path (NOTES DIST7)
// ---------------------------------------------------------------------------
//
// `createRequire(...).resolve(...)` below (the source-tree path) walks the real filesystem looking
// for a `node_modules` directory — that is exactly what makes it work from source, and exactly what
// makes it CWD-dependent, not fixed, inside a `bun build --compile` binary: `requireFrom` there is a
// `$bunfs` virtual path with no real directory to walk up from, so Bun's resolver falls back to a
// walk from `process.cwd()` instead. Invoked from inside this repo's own working tree (where
// `node_modules/@anthropic-ai/claude-agent-sdk-*` really is on disk — e.g. `bun test`'s cwd, or a
// developer running `dist/levare` from the repo root) that fallback walk happens to succeed, which is
// why a same-repo smoke test can pass while the identical binary, run from any real user's studio
// directory (nowhere near this repo's node_modules), fails — confirmed empirically, not inferred: see
// NOTES DIST7 for the side-by-side repro. A real release binary is invoked from a scaffolded studio,
// never from levare's own source tree, so this fallback is not a fix, only a coincidence.
//
// The SDK's own README ("Compiled binaries (`bun build --compile`)") documents the actual supported
// mechanism: embed the platform's native binary as a Bun file asset via a static `with { type: "file"
// }` import (resolved and packed into the binary's own `$bunfs` at BUILD time, not looked up on a real
// filesystem at run time), then extract it to a real temp path with the SDK's own
// `@anthropic-ai/claude-agent-sdk/extract#extractFromBunfs` (child processes cannot spawn a `$bunfs`
// path directly) before spawning it. `native-binary.generated.ts` is the one static import site
// `scripts/build.sh` rewrites per build target.
//
// The EXTRACTION step (calling `extractFromBunfs`, which lives in `@anthropic-ai/claude-agent-sdk`'s
// own `/extract` export) deliberately does NOT happen in this module, or anywhere this PARENT process
// reaches — it happens in `sdk-worker.ts`, and only there. Two things forced that split, both
// confirmed empirically, not assumed (NOTES DIST7 addendum, a live-gate fix-up):
//
//   1. A top-level static `import` of any `@anthropic-ai/claude-agent-sdk` subpath in THIS module is
//      resolved at module-LOAD time regardless of which branch ever runs — this module is loaded by
//      every offline command (`validate`/`doctor`/`context`), and on a fresh checkout with no `bun
//      install` yet, that eager resolution broke all three of them with "Cannot find module", exactly
//      the bug `tests/cli-no-sdk.test.ts` (NOTES REV1 finding 1) exists to catch. `sdk-worker.ts` is
//      the one module already exempt from that constraint — `cli.ts` only ever reaches it via a
//      dynamic `import("./sdk-worker.ts")` inside the hidden `__worker` branch, so its own top-level
//      SDK import (already there, for `query()` itself) never resolves for an offline command.
//   2. A compiled binary has no live module-resolution machinery at runtime for anything NOT already
//      linked into its single bundle at build time — confirmed by direct experiment: both a runtime
//      `require()` AND a runtime dynamic `import()` of `@anthropic-ai/claude-agent-sdk/extract` fail
//      inside a real compiled binary with `Cannot find module`, even though the identical specifier
//      resolves fine as a top-level static import. Only a STATIC top-level import — one that's
//      unconditionally reachable from the compiled binary's own entry point, exactly like
//      `sdk-worker.ts`'s existing `import { query } from "@anthropic-ai/claude-agent-sdk"` — gets
//      linked into the bundle and works at runtime. `sdk-worker.ts` runs as a FRESH SELF-INVOCATION of
//      this same compiled binary (`workerSpawnArgv`, NOTES DIST5) — same embedded `$bunfs`, same
//      linked bundle — so it can safely add its own static `extractFromBunfs` import alongside its
//      existing `query` one and do the extraction itself, right before making the real call.
//
// This module's own job for the compiled case is therefore narrower than "resolve a spawnable path":
// just report whether an asset is embedded at all (`hasEmbeddedNativeBinary`, no extraction, safe
// everywhere) for viability checks (`doctor`'s `orchestrator: on/off`); `resolveNativeBinary` itself
// returns `null` for a compiled build (never a raw, unextracted `$bunfs` path — spawning that directly
// would fail exactly like the original bug), leaving `pathToClaudeCodeExecutable` unset in the
// outgoing request so `sdk-worker.ts` resolves and extracts it itself when it actually runs.
function hasEmbeddedNativeBinary(): boolean {
  return embeddedNativeBinaryAsset !== null;
}

/**
 * Can the SDK's own optional platform binary be resolved, AS A VALUE THIS PROCESS CAN HAND TO THE SDK
 * (`pathToClaudeCodeExecutable`)? Two entirely different mechanisms, dispatched on `isCompiledBuild()`:
 *
 *   - Source tree: mirrors `query()`'s own internal resolution exactly — `require.resolve` scoped via
 *     `createRequire`. The SDK itself scopes from `sdk.mjs`'s own file location; scoping from any file
 *     inside this SAME project tree resolves identically, because node_modules resolution of a sibling
 *     scoped package is tree-position-based, not caller-position-based — confirmed by reading the
 *     SDK's own resolver, not assumed. `requireFrom` is injectable (test-only) to point the scoped
 *     require at an empty scratch directory, simulating a genuinely unresolvable binary without
 *     touching the real installed packages.
 *   - Compiled binary: always `null` here, deliberately — see the module comment above for why this
 *     process can never safely extract the embedded asset itself. Callers that need the real path for
 *     an actual dispatch get it from `sdk-worker.ts` instead (it self-resolves when the incoming
 *     request's `pathToClaudeCodeExecutable` is unset); callers that only need to know whether the SDK
 *     is viable at all should call `hasEmbeddedNativeBinary`/`checkSdkPreconditions`, not this.
 */
export function resolveNativeBinary(platform: string = process.platform, arch: string = process.arch, requireFrom: string = import.meta.url): string | null {
  if (isCompiledBuild()) return null;
  const scopedRequire = createRequire(requireFrom);
  for (const candidate of nativeBinaryCandidates(platform, arch)) {
    try {
      const resolved = scopedRequire.resolve(candidate);
      if (existsSync(resolved)) return resolved;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

export interface SdkPreconditionCheck {
  viable: boolean;
  reason?: string;
  /** The resolved binary path, when viable — the SAME value `createSdkOrchestratorBoundary` will
   * itself resolve and pass explicitly as `pathToClaudeCodeExecutable` (NOTES K14). */
  binaryPath?: string;
}

export interface SdkPreconditionOptions {
  platform?: string;
  arch?: string;
  /** Test-only: see `resolveNativeBinary`. */
  requireFrom?: string;
}

/** The two LOCAL, zero-cost preconditions a real SDK call needs: a credential, and a resolvable
 * native binary. Both are knowable in milliseconds — no network, no subprocess.
 *
 * The binary check itself is two different mechanisms (NOTES DIST7): a compiled build asks
 * `hasEmbeddedNativeBinary` (is one embedded at all — never attempts extraction here, see this
 * file's own module comment on `resolveNativeBinary` above for why); a source build asks
 * `resolveNativeBinary` for a real, immediately-usable path. Either way, `binaryPath` on the
 * returned check is only ever set for the SOURCE case — a compiled build's real dispatch path
 * resolves its own `pathToClaudeCodeExecutable` in `sdk-worker.ts` instead, which is the only place
 * that can safely do the extraction (see there). */
export function checkSdkPreconditions(env: Record<string, string | undefined> = process.env, opts: SdkPreconditionOptions = {}): SdkPreconditionCheck {
  if (!hasAnthropicCredentials(env)) return { viable: false, reason: "ANTHROPIC_API_KEY is not set" };
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const compiled = isCompiledBuild();
  const binaryPath = compiled ? undefined : (resolveNativeBinary(platform, arch, opts.requireFrom) ?? undefined);
  const viableBinary = compiled ? hasEmbeddedNativeBinary() : binaryPath !== undefined;
  if (!viableBinary) {
    // NOTES DIST7: two different audiences hit this, with two different remedies — a source/dev run
    // really can fix this with a package install; a compiled binary user has no node_modules to
    // install into, and the actual cause there is a levare packaging defect or an unsupported
    // platform, never a missing npm install.
    const reason = compiled
      ? `this levare build has no Claude Agent SDK binary embedded for ${platform}-${arch} — either it's an unofficial build (only darwin-arm64/darwin-x64/linux-x64/linux-arm64 release assets embed one) or this platform isn't a supported release target; download the levare-${platform}-${arch} asset from the GitHub Releases page, or run 'bun run build' from a levare checkout on this machine`
      : `native CLI binary for ${platform}-${arch} not found in node_modules — run 'bun install' to fetch @anthropic-ai/claude-agent-sdk-${platform}-${arch} (an optional dependency of @anthropic-ai/claude-agent-sdk)`;
    return { viable: false, reason };
  }
  return { viable: true, binaryPath };
}

const PRECONDITION_CACHE_TTL_MS = 30_000;
let preconditionCache: { check: SdkPreconditionCheck; expiresAt: number } | null = null;
let lastLoggedViable: boolean | null = null;

/**
 * Cached wrapper around `checkSdkPreconditions` — probed ONCE per cache window rather than on every
 * message, so a genuinely broken install fails fast (no spawn attempt at all) without re-running the
 * check (or logging about it) on every single request. The diagnostic logs only on a TRANSITION into
 * unavailability, not on every re-check within the failing window — a "clear one-time note", not a
 * repeating warning. A short TTL lets a fix (e.g. a reinstall while `levare serve` keeps running) be
 * noticed without a restart.
 */
export function checkSdkPreconditionsCached(
  env: Record<string, string | undefined> = process.env,
  opts: SdkPreconditionOptions = {},
  now: number = Date.now(),
): SdkPreconditionCheck {
  if (preconditionCache && preconditionCache.expiresAt > now) return preconditionCache.check;
  const check = checkSdkPreconditions(env, opts);
  if (!check.viable && lastLoggedViable !== false) {
    console.error(`levare: Orchestrator unavailable (${check.reason}) — the panel will show disabled until this resolves.`);
  }
  lastLoggedViable = check.viable;
  preconditionCache = { check, expiresAt: now + PRECONDITION_CACHE_TTL_MS };
  return check;
}

/** Test-only: clear the module-level precondition cache so tests don't leak state into each other. */
export function resetSdkPreconditionCache(): void {
  preconditionCache = null;
  lastLoggedViable = null;
}

// Drop undefined-valued entries before handing an env record to Bun.spawnSync: process.env's TS type
// allows `string | undefined` per key, and a literal `undefined` value serialized into a child's
// environment block is exactly the kind of quiet, hard-to-diagnose corruption this transport must
// not risk — every real value (including ANTHROPIC_API_KEY, when present) is passed through exactly
// as given; nothing is filtered by name (that would be the allowlist model, wrong for this seam).
function definedEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === "string") out[k] = v;
  return out;
}

// ---------------------------------------------------------------------------
// Hermetic CLI spawn (NOTES phase-7 K15, a live-gate fix-up)
// ---------------------------------------------------------------------------
//
// A live host hung indefinitely on every real call, even though the `claude` CLI itself worked fine
// standalone (`claude -p "..." --output-format json` returned in ~2s). Root cause: the spawned worker
// inherited the OPERATOR's personal Claude Code configuration — specifically a user-installed
// SessionEnd hook (a "claude-mem" plugin spawning `node`) that, in a TTY-less spawned subprocess,
// never actually completed, so the CLI's own process never exited even though the model had already
// answered and been billed. This is the identical lesson NOTES A4/E12 already recorded for git
// subprocesses: anything spawned inherits the host's ambient configuration unless it is EXPLICITLY
// pinned to a hermetic one — apply it here exactly as it was applied there.
//
// Two SDK options close this off completely (both confirmed in the shipped sdk.d.ts, not guessed):
//   `settingSources: []`  — "SDK isolation mode": loads NO filesystem settings (`~/.claude/settings.json`
//                            user settings, `.claude/settings.json` project settings, or
//                            `.claude/settings.local.json` local settings) — the operator's hooks and
//                            plugins are never even registered, so a SessionEnd hook has nothing to fire.
//                            Passed in sdk-worker.ts's `query()` call.
//   `CLAUDE_CONFIG_DIR`    — redirects the CLI's own on-disk config/session directory away from the
//                            operator's real `~/.claude` entirely, so nothing this spawn does (session
//                            transcripts, auth cache) can read from or write into the operator's real
//                            profile, and vice versa. Belt-and-suspenders on top of `settingSources: []`
//                            and `persistSession: false` (also set in sdk-worker.ts).
export const LEVARE_CLAUDE_CONFIG_DIR = join(tmpdir(), "levare-sdk-config");

// A caller (a test) that has ALREADY set CLAUDE_CONFIG_DIR explicitly wins — this only fills in a
// hermetic default, it never overrides an intentional override.
export function hermeticSpawnEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  if (env.CLAUDE_CONFIG_DIR) return env;
  try {
    mkdirSync(LEVARE_CLAUDE_CONFIG_DIR, { recursive: true });
  } catch {
    /* best-effort — if this fails, the SDK will fail loudly on its own rather than silently inheriting ~/.claude */
  }
  return { ...env, CLAUDE_CONFIG_DIR: LEVARE_CLAUDE_CONFIG_DIR };
}

// ---------------------------------------------------------------------------
// Kill the WHOLE process tree, not just the direct child (NOTES phase-7 K15)
// ---------------------------------------------------------------------------
//
// A live host's timeout-kill did not fire, and Bun reported "killed 1 dangling process" — because
// `proc.kill()` (both the sync and async Subprocess method, and Bun.spawnSync's own `timeout` +
// `killSignal` handling) only ever signals the DIRECT child (the worker). The worker's own
// grandchildren — the `claude` CLI process the SDK spawns internally, and in turn the CLI's own child
// processes (a hook, in the confirmed live case) — are never touched, and if the worker's own process
// never gets to exit cleanly (exactly the hang this fix-up is for), those grandchildren simply outlive
// it. Verified empirically (not assumed) against a real hanging-grandchild reproduction: spawning with
// `detached: true` puts the worker in its OWN new process group (its PID becomes the group ID);
// `process.kill(-pid, "SIGKILL")` (the NEGATIVE pid) signals the ENTIRE group at once. Confirmed this
// reaps both the worker and a grandchild that ignores plain SIGTERM, with zero dangling processes
// afterward — the `spawnSync`-with-`detached`-and-`timeout` combination alone does NOT do this (its
// own internal timeout kill only reaches the direct child); the explicit group-kill below is required.
function killProcessTree(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    /* already exited, or never got its own process group — nothing left to kill */
  }
}

/** A transport that spawns the SDK worker synchronously and blocks on it. With no `workerPath`
 * argument (the default, `bunSdkTransport`), it self-invokes this same process in worker mode
 * (`workerSpawnArgv`, NOTES DIST5) — the real path, working under both source and compiled runs.
 * Tests can pass an explicit `workerPath` to a standalone script (spawned directly with a real `bun`
 * interpreter) to exercise a genuine, network-free, deterministic transport failure/slow/hung worker
 * (see tests/orchestrator-sdk.test.ts, tests/sdk-transport-hermetic.test.ts) — that shape is
 * unaffected by this change, it never goes through self-invocation. */
export function createBunSdkTransport(workerPath?: string): SdkTransport {
  return {
    run(req, opts): SdkTransportResult {
      const startedAt = Date.now();
      if (workerPath !== undefined && !existsSync(workerPath)) {
        return { ok: false, error: `sdk worker script not found at ${workerPath}`, stdout: "", stderr: "", durationMs: Date.now() - startedAt, timedOut: false };
      }
      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      let argv = workerPath !== undefined ? [process.execPath, workerPath] : workerSpawnArgv();
      let cwd = workerSpawnCwd(workerPath);
      let cleanupWrap: (() => void) | undefined;
      // Finding 75 (part 2): only the real self-invocation spawn is ever wrapped — a standalone
      // `workerPath` script is a test double, never a real OS process this codebase's own sandbox
      // exists to confine (mirrors AdapterRunner#runCli's `this.spawn === bunSpawn` guard exactly).
      // NOTES R4-SANDBOX-FIX-6: the policy's own `cwd` must equal the EXACT path the process actually
      // runs in, or the wrap confines the wrong directory — resolved to a concrete value (never left
      // `undefined`, which a compiled self-invocation otherwise leaves for `Bun.spawnSync` to fill in
      // implicitly from its own ambient cwd) before the wrap is asked to build a policy against it.
      if (workerPath === undefined && opts.wrapWorkerSpawn) {
        const resolvedCwd = cwd ?? process.cwd();
        const wrapped = opts.wrapWorkerSpawn(argv, resolvedCwd);
        argv = wrapped.argv;
        cwd = resolvedCwd;
        cleanupWrap = wrapped.cleanup;
      }
      try {
        const proc = Bun.spawnSync(argv, {
          cwd,
          env: definedEnv(hermeticSpawnEnv(opts.env)),
          stdin: Buffer.from(JSON.stringify(req)),
          stdout: "pipe",
          stderr: "pipe",
          timeout: timeoutMs,
          killSignal: "SIGKILL",
          detached: true,
        });
        const durationMs = Date.now() - startedAt;
        // NOTES DISPATCH-TRACE: decoded UNCONDITIONALLY, before branching on the exit reason —
        // `spawnSync` buffers whatever the child wrote before a timeout-kill same as any other exit, so
        // this is the one place both variables exist regardless of which return below fires.
        const stdout = proc.stdout ? new TextDecoder().decode(proc.stdout).trim() : "";
        const stderr = proc.stderr ? new TextDecoder().decode(proc.stderr).trim() : "";
        if (proc.exitedDueToTimeout) {
          // spawnSync's own timeout+killSignal only reached the direct child (confirmed empirically —
          // see killProcessTree's own comment); reap any surviving grandchildren explicitly.
          if (proc.pid) killProcessTree(proc.pid);
          return { ok: false, error: `sdk worker timed out after ${timeoutMs}ms`, stdout, stderr, durationMs, timedOut: true };
        }
        if (proc.exitCode !== 0) {
          return { ok: false, error: `sdk worker exited ${proc.exitCode}: ${stderr || stdout || "(no output)"}`, stdout, stderr, durationMs, timedOut: false };
        }
        try {
          const parsed = JSON.parse(stdout) as SdkWorkerResponse;
          return { ...parsed, stdout, stderr, durationMs, timedOut: false };
        } catch {
          return { ok: false, error: `sdk worker produced non-JSON output: ${stdout.slice(0, 200)}`, stdout, stderr, durationMs, timedOut: false };
        }
      } finally {
        cleanupWrap?.();
      }
    },
  };
}

/** Default transport: a real, synchronous spawn of the real worker script, which makes the real SDK call. */
export const bunSdkTransport: SdkTransport = createBunSdkTransport();

/**
 * A transport that spawns the SDK worker via `Bun.spawn` (non-blocking) and awaits it — the async
 * counterpart to `createBunSdkTransport` above, used wherever the caller may be servicing concurrent
 * requests (today: only `OrchestratorBoundary`, wired into `board/serve.ts`). The timeout is enforced
 * explicitly (a `setTimeout` that kills the child) rather than relying on `Bun.spawn`'s own `timeout`
 * option, whose `exitedDueToTimeout` signal is documented for `spawnSync` but was NOT observed to be
 * populated for async `spawn` in this Bun version — an explicit flag is unambiguous either way.
 *
 * Same `workerPath`-argument split as `createBunSdkTransport` (NOTES DIST5): omitted (the default,
 * `asyncSdkTransport`) self-invokes this same process in worker mode; an explicit path (test-only)
 * spawns that standalone script directly, exactly as before.
 */
export function createAsyncSdkTransport(workerPath?: string): AsyncSdkTransport {
  return {
    async run(req, opts): Promise<SdkTransportResult> {
      const startedAt = Date.now();
      if (workerPath !== undefined && !existsSync(workerPath)) {
        return { ok: false, error: `sdk worker script not found at ${workerPath}`, stdout: "", stderr: "", durationMs: Date.now() - startedAt, timedOut: false };
      }
      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      let argv = workerPath !== undefined ? [process.execPath, workerPath] : workerSpawnArgv();
      let cwd = workerSpawnCwd(workerPath);
      let cleanupWrap: (() => void) | undefined;
      // Finding 75 (part 2): see createBunSdkTransport's own identical guard/doc above — the same
      // real-self-invocation-only wrap, applied to the async spawn path.
      if (workerPath === undefined && opts.wrapWorkerSpawn) {
        const resolvedCwd = cwd ?? process.cwd();
        const wrapped = opts.wrapWorkerSpawn(argv, resolvedCwd);
        argv = wrapped.argv;
        cwd = resolvedCwd;
        cleanupWrap = wrapped.cleanup;
      }
      const proc = Bun.spawn(argv, {
        cwd,
        env: definedEnv(hermeticSpawnEnv(opts.env)),
        stdin: Buffer.from(JSON.stringify(req)),
        stdout: "pipe",
        stderr: "pipe",
        // Own process GROUP, so a timeout can kill the whole tree (worker + the CLI it spawns + any
        // of the CLI's own children), not just this direct child — see killProcessTree above.
        detached: true,
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(proc.pid);
      }, timeoutMs);
      try {
        const [stdoutRaw, stderrRaw] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        const stdout = stdoutRaw.trim();
        const stderr = stderrRaw.trim();
        const durationMs = Date.now() - startedAt;
        // NOTES DISPATCH-TRACE (native-dispatch-hang investigation): this is the exact branch that used
        // to discard `stdout`/`stderr` — both are fully captured above regardless of `timedOut`
        // (`killProcessTree` fired already; awaiting the now-closing pipes just drains what was written
        // before the kill), so a hung worker's own diagnostic lines (sdk-worker.ts's always-on
        // elapsed-time/api_retry logging) are now returned to the caller instead of thrown away.
        if (timedOut) return { ok: false, error: `sdk worker timed out after ${timeoutMs}ms`, stdout, stderr, durationMs, timedOut: true };
        if (proc.exitCode !== 0) {
          return { ok: false, error: `sdk worker exited ${proc.exitCode}: ${stderr || stdout || "(no output)"}`, stdout, stderr, durationMs, timedOut: false };
        }
        try {
          const parsed = JSON.parse(stdout) as SdkWorkerResponse;
          return { ...parsed, stdout, stderr, durationMs, timedOut: false };
        } catch {
          return { ok: false, error: `sdk worker produced non-JSON output: ${stdout.slice(0, 200)}`, stdout, stderr, durationMs, timedOut: false };
        }
      } finally {
        clearTimeout(timer);
        cleanupWrap?.();
      }
    },
  };
}

/** Default async transport: a real, non-blocking spawn of the real worker script. */
export const asyncSdkTransport: AsyncSdkTransport = createAsyncSdkTransport();

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

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";

export interface SdkWorkerRequest {
  /** The user-turn content sent to the model this call. */
  prompt: string;
  /** Loaded verbatim from disk by the caller (never edited/appended here) when set. */
  systemPrompt?: string;
  model?: string;
  /** Base tool set the model may see (levare's own `tools:` vocabulary — passed through as-is; see
   * NOTES phase-7 K2 for the scope boundary on SDK built-in tool-name mapping). */
  tools?: string[];
  allowedTools?: string[];
  outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
  cwd?: string;
}

export type SdkWorkerResponse = { ok: true; result: string; structuredOutput?: unknown } | { ok: false; error: string };

/** The synchronous transport boundary (adapters.ts's NativeBoundary only — see the module note above
 * for why this must never be called from a `levare serve` request path). */
export interface SdkTransport {
  run(req: SdkWorkerRequest, opts: { env: Record<string, string | undefined>; timeoutMs: number }): SdkWorkerResponse;
}

/** The non-blocking transport boundary (orchestrator-boundary.ts — the one reachable from
 * `levare serve`'s request path). Same request/response shape as `SdkTransport`, Promise-returning. */
export interface AsyncSdkTransport {
  run(req: SdkWorkerRequest, opts: { env: Record<string, string | undefined>; timeoutMs: number }): Promise<SdkWorkerResponse>;
}

// `Bun.fileURLToPath` (not raw `URL.pathname`), matching the pattern already established in
// adapters.test.ts for spawning a real subprocess against a `file://`-resolved script path — a raw
// `.pathname` can carry percent-encoded characters (spaces, unicode) that a literal argv element
// spawned with no shell will not decode, which `fileURLToPath` handles correctly.
export const SDK_WORKER_PATH = Bun.fileURLToPath(new URL("./sdk-worker.ts", import.meta.url));

/**
 * Whether the environment carries credentials the SDK can authenticate with — presence only, the
 * value itself is never read into a log, artifact, or commit (invariant 11), mirroring doctor.ts's
 * `EnvProbe` posture exactly. This is the one check that selects the real boundary vs. the
 * deterministic offline fallback.
 */
export function hasAnthropicCredentials(env: Record<string, string | undefined> = process.env): boolean {
  return typeof env.ANTHROPIC_API_KEY === "string" && env.ANTHROPIC_API_KEY.length > 0;
}

// The levare repo root — the directory holding this project's own package.json/node_modules — pinned
// explicitly as `cwd` for every worker spawn below (NOTES phase-7 K13), rather than left to inherit
// from whatever process spawns it. `SDK_WORKER_PATH` is `<root>/src/sdk-worker.ts`; two `dirname`s up.
export const LEVARE_ROOT = dirname(dirname(SDK_WORKER_PATH));

const DEFAULT_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Fast, local SDK-viability precondition check (NOTES phase-7 K13)
// ---------------------------------------------------------------------------
//
// A missing native CLI binary is knowable in milliseconds — the SDK's own resolution of it
// (extracted directly from the shipped sdk.mjs, not guessed) is a synchronous `require.resolve` loop
// over a handful of platform-specific package names, with no network or subprocess involved. Probing
// this cheaply, ONCE per cache window, lets `selectOrchestratorBoundary` skip straight to the
// deterministic offline boundary for a genuinely broken install — never spawning the worker at all —
// instead of discovering the same fact only after a slow, per-request spawn-and-fail. A credential or
// network problem (something this local check cannot know) still surfaces the slow way, per request,
// exactly as it already did (K11) — this optimization only ever short-circuits a LOCAL, static
// precondition, never second-guesses a live call that might simply be slow.

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

/**
 * Can the SDK's own optional platform binary be resolved from this project's node_modules? Mirrors
 * `query()`'s own internal resolution exactly: `require.resolve` scoped via `createRequire`. The SDK
 * itself scopes from `sdk.mjs`'s own file location; scoping from any file inside this SAME project
 * tree resolves identically, because node_modules resolution of a sibling scoped package is
 * tree-position-based, not caller-position-based — confirmed by reading the SDK's own resolver, not
 * assumed. `requireFrom` is injectable (test-only) to point the scoped require at an empty scratch
 * directory, simulating a genuinely unresolvable binary without touching the real installed packages.
 */
export function resolveNativeBinary(platform: string = process.platform, arch: string = process.arch, requireFrom: string = import.meta.url): string | null {
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
}

export interface SdkPreconditionOptions {
  platform?: string;
  arch?: string;
  /** Test-only: see `resolveNativeBinary`. */
  requireFrom?: string;
}

/** The two LOCAL, zero-cost preconditions a real SDK call needs: a credential, and a resolvable
 * native binary. Both are knowable in milliseconds — no network, no subprocess. */
export function checkSdkPreconditions(env: Record<string, string | undefined> = process.env, opts: SdkPreconditionOptions = {}): SdkPreconditionCheck {
  if (!hasAnthropicCredentials(env)) return { viable: false, reason: "ANTHROPIC_API_KEY is not set" };
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  if (!resolveNativeBinary(platform, arch, opts.requireFrom)) {
    return {
      viable: false,
      reason: `native CLI binary for ${platform}-${arch} not found — reinstall @anthropic-ai/claude-agent-sdk on this platform (README.md's Phase 7 section)`,
    };
  }
  return { viable: true };
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
    console.error(`levare: Orchestrator SDK unavailable (${check.reason}) — using the deterministic offline boundary until this resolves.`);
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

/** A transport that spawns `workerPath` synchronously and blocks on it — the default (`bunSdkTransport`)
 * points at the real `sdk-worker.ts`; tests can point another instance at a bogus path to exercise a
 * genuine, network-free, deterministic transport failure (see tests/orchestrator-sdk.test.ts). */
export function createBunSdkTransport(workerPath: string = SDK_WORKER_PATH): SdkTransport {
  return {
    run(req, opts) {
      if (!existsSync(workerPath)) {
        return { ok: false, error: `sdk worker script not found at ${workerPath}` };
      }
      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const proc = Bun.spawnSync([process.execPath, workerPath], {
        cwd: LEVARE_ROOT,
        env: definedEnv(opts.env),
        stdin: Buffer.from(JSON.stringify(req)),
        stdout: "pipe",
        stderr: "pipe",
        timeout: timeoutMs,
      });
      if (proc.exitedDueToTimeout) return { ok: false, error: `sdk worker timed out after ${timeoutMs}ms` };
      const stdout = proc.stdout ? new TextDecoder().decode(proc.stdout).trim() : "";
      if (proc.exitCode !== 0) {
        const stderr = proc.stderr ? new TextDecoder().decode(proc.stderr).trim() : "";
        return { ok: false, error: `sdk worker exited ${proc.exitCode}: ${stderr || stdout || "(no output)"}` };
      }
      try {
        return JSON.parse(stdout) as SdkWorkerResponse;
      } catch {
        return { ok: false, error: `sdk worker produced non-JSON output: ${stdout.slice(0, 200)}` };
      }
    },
  };
}

/** Default transport: a real, synchronous spawn of the real worker script, which makes the real SDK call. */
export const bunSdkTransport: SdkTransport = createBunSdkTransport();

/**
 * A transport that spawns `workerPath` via `Bun.spawn` (non-blocking) and awaits it — the async
 * counterpart to `createBunSdkTransport` above, used wherever the caller may be servicing concurrent
 * requests (today: only `OrchestratorBoundary`, wired into `board/serve.ts`). The timeout is enforced
 * explicitly (a `setTimeout` that kills the child) rather than relying on `Bun.spawn`'s own `timeout`
 * option, whose `exitedDueToTimeout` signal is documented for `spawnSync` but was NOT observed to be
 * populated for async `spawn` in this Bun version — an explicit flag is unambiguous either way.
 */
export function createAsyncSdkTransport(workerPath: string = SDK_WORKER_PATH): AsyncSdkTransport {
  return {
    async run(req, opts) {
      if (!existsSync(workerPath)) {
        return { ok: false, error: `sdk worker script not found at ${workerPath}` };
      }
      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const proc = Bun.spawn([process.execPath, workerPath], {
        cwd: LEVARE_ROOT,
        env: definedEnv(opts.env),
        stdin: Buffer.from(JSON.stringify(req)),
        stdout: "pipe",
        stderr: "pipe",
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, timeoutMs);
      try {
        const [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        if (timedOut) return { ok: false, error: `sdk worker timed out after ${timeoutMs}ms` };
        if (proc.exitCode !== 0) {
          return { ok: false, error: `sdk worker exited ${proc.exitCode}: ${stderr.trim() || stdout.trim() || "(no output)"}` };
        }
        try {
          return JSON.parse(stdout.trim()) as SdkWorkerResponse;
        } catch {
          return { ok: false, error: `sdk worker produced non-JSON output: ${stdout.trim().slice(0, 200)}` };
        }
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Default async transport: a real, non-blocking spawn of the real worker script. */
export const asyncSdkTransport: AsyncSdkTransport = createAsyncSdkTransport();

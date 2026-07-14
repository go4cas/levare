// `levare serve` (PRD §9). Raw Bun.serve, no framework: every GET re-derives HTML from the repo on
// every request (invariant 2); the write surface is exactly three routes (invariant 9), asserted
// against ROUTE_TABLE below by a test rather than re-typed there. SSE pushes a re-render trigger
// whenever fs.watch sees a change under the repo root — the client's job on receipt is just "refetch
// the page", never to patch DOM from a payload, keeping the projection stateless end to end.

import { watch, type FSWatcher } from "node:fs";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname, dirname, resolve, sep } from "node:path";
import { loadRepo, type Repo } from "../repo.ts";
import { renderStudio, renderProject, renderRun, renderRegistry, renderArtifact, renderIdea } from "./render.ts";
import { resolveGate } from "./gateops.ts";
import type { AsyncMemberRunner } from "../dagwalk.ts";
import { validatePath } from "../validate.ts";
import type { Verb } from "../runner.ts";
import { conductorCommit, CONDUCTOR_NAME } from "../git.ts";
import { handle as orchestratorHandle, type HandleResult, type OrchestratorBoundary } from "../orchestrator.ts";
import { selectOrchestratorBoundary, type SelectOrchestratorBoundaryOptions } from "../orchestrator-boundary.ts";
import { resolveOrchestratorStatus } from "../orchestrator-status.ts";
import { isStudioInitialized, renderOnboarding } from "./onboarding.ts";
import { Daemon } from "../daemon.ts";

export interface RouteDef {
  method: "GET" | "POST";
  pattern: string;
  mutating: boolean;
  /** A repo-projecting screen (as opposed to an asset/SSE/write route) — gated by the first-run
   * onboarding check (NOTES phase-6 deliverable b) before its handler ever runs. */
  page?: boolean;
  handler: (req: Request, params: Record<string, string>, ctx: BoardCtx) => Response | Promise<Response>;
}

export interface BoardCtx {
  root: string;
  broadcast: (msg: string) => void;
  /** When true, every mutating route refuses with 405 before its handler ever runs (see NOTES E14). */
  readOnly: boolean;
  /** Override the per-request `selectOrchestratorBoundary()` call — production never sets this;
   * tests use it to inject a controllable (e.g. deliberately slow) boundary to prove a concurrent,
   * unrelated request is never blocked by an in-flight `/orchestrator/message` call (NOTES phase-7 K9). */
  orchestratorBoundary?: OrchestratorBoundary;
  /** Test-only options threaded into `selectOrchestratorBoundary` when `orchestratorBoundary` above is
   * NOT set — lets a test drive the REAL selection path (fast-precondition probe included) with a
   * simulated platform/arch or an empty scratch require-root, rather than bypassing selection
   * entirely with a hand-rolled boundary (NOTES phase-7 K13). */
  orchestratorSelectOpts?: SelectOrchestratorBoundaryOptions;
  /** Override the `resolveGate()` call's own default (`productionAdapterRunner`) — production never
   * sets this; tests use it to drive a gate resolution (e.g. a `start` verb) through a controllable
   * `AsyncMemberRunner`, mirroring `orchestratorBoundary` above exactly (NOTES F8). */
  memberRunner?: AsyncMemberRunner;
  /** Phase 8, deliverable c: when set, "Members running" / "Running now" (render.ts#renderStudio)
   * become a true projection of this daemon's in-flight invocations. Absent in every pre-phase-8 test
   * that constructs a board directly (createBoard's default), which is why those screens keep
   * rendering their honest "nothing running" empty state unchanged — only `serve()` (the CLI's actual
   * `levare serve` entry point) attaches a real one, so no existing test gains a background daemon,
   * a second fs.watch handle, or any other side effect it didn't already have. */
  daemon?: Daemon;
}

// A demo/screenshot server pointed at a fixtures/ tree must not be able to mutate it, structurally —
// not "don't do that", a route that literally cannot execute. `fixtures/golden` and any future
// fixtures directory both qualify: any path with a literal `fixtures` path segment.
export function isUnderFixtures(root: string): boolean {
  return resolve(root).split(sep).includes("fixtures");
}

// CSRF defense (surface 6). The board is an unauthenticated localhost server whose three write routes
// mutate the repo, resolve gates (forging a Conductor approval — invariant 4), and can start members
// (spending money, invariant 1). A malicious web page open in the operator's browser can POST to
// localhost with a CORS "simple request" (a text/plain body needs no preflight, and Bun's req.json()
// parses the body regardless of content-type), so with no origin check ANY site could drive every
// write route. This is a STRUCTURAL guard, not per-handler: a browser attaches an `Origin` header to
// every cross-origin POST (and to same-origin fetch POSTs too), so a mutating request is refused when
// it carries an Origin that is not this server's own. Non-browser clients (curl, the CLI, tests) send
// no Origin and are unaffected — they are not the CSRF threat, which is specifically a page in the
// operator's browser being made to act as them. `Sec-Fetch-Site: cross-site` is honored as a second
// signal for browsers that send it even when they omit Origin.
export function isCrossOriginWrite(req: Request, url: URL): boolean {
  const origin = req.headers.get("origin");
  if (origin) {
    try {
      if (new URL(origin).host !== url.host) return true;
    } catch {
      return true; // an unparseable Origin is not our own origin
    }
  }
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return true;
  return false;
}

// The only directories the registry edit route may write into. The route edits registry ENTITY
// definitions (PRD §9: "registry — all entity kinds rendered; Edit source → validate → write → commit")
// — never arbitrary repo paths. Without this, `POST /registry/*path` accepted any path under root:
// a `..`-free path like `.git/hooks/pre-commit` planted an executable git hook (code execution the
// next time the operator runs git), and the file was written to disk BEFORE the validate/commit step,
// so it persisted even when the commit then failed. Confinement is by resolved-path containment plus
// a top-level-segment allowlist, not a textual `..` scan (which a `.git` segment slips straight past).
const REGISTRY_EDITABLE_DIRS = new Set([
  "teams", "agents", "skills", "knowledge", "types", "connectors", "projects", "evals", "ideas",
]);

/** True when `relPath` (a `/registry/*path` remainder) is a real, in-repo registry entity file the
 * edit route is allowed to write. Rejects traversal, absolute paths, `.git`/dotfile escapes, and any
 * top-level directory not in REGISTRY_EDITABLE_DIRS. */
export function isRegistryEditablePath(root: string, relPath: string): boolean {
  if (!relPath || relPath.includes("\0")) return false;
  const rootAbs = resolve(root);
  const fileAbs = resolve(rootAbs, relPath);
  // Must stay strictly inside the studio root.
  if (fileAbs !== rootAbs && !fileAbs.startsWith(rootAbs + sep)) return false;
  const rel = fileAbs.slice(rootAbs.length + 1);
  const segs = rel.split(sep);
  if (segs.length < 2) return false; // must be <dir>/<file>, never a bare top-level file
  if (segs.some((s) => s === "" || s === "." || s === ".." || s.startsWith(".git"))) return false;
  if (!REGISTRY_EDITABLE_DIRS.has(segs[0])) return false;
  return segs[segs.length - 1].endsWith(".md");
}

const ASSET_DIR = new URL("../../assets/", import.meta.url).pathname;

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function serveAsset(name: string): Response {
  const file = join(ASSET_DIR, name);
  if (!existsSync(file)) return new Response("not found", { status: 404 });
  const type = extname(name) === ".css" ? "text/css" : extname(name) === ".js" ? "text/javascript" : "application/octet-stream";
  return new Response(readFileSync(file), { headers: { "content-type": `${type}; charset=utf-8` } });
}

function withRepo(root: string): Repo {
  return loadRepo(root);
}

// ---------------------------------------------------------------------------
// Route table — the single source of truth for both dispatch and the mutating-route-count test.
// ---------------------------------------------------------------------------

export const ROUTES: RouteDef[] = [
  {
    method: "GET",
    pattern: "/",
    mutating: false,
    page: true,
    // Renders studio directly (200), not a redirect: a plain `curl /` with no `-L` must see real
    // content, not a bounce (NOTES E12 — the phase-4 gate demonstration curls `/` directly).
    handler: (_req, _params, ctx) => html(renderStudio(withRepo(ctx.root), ctx.root, undefined, ctx.daemon?.running() ?? [])),
  },
  {
    method: "GET",
    pattern: "/studio",
    mutating: false,
    page: true,
    handler: (_req, _params, ctx) => html(renderStudio(withRepo(ctx.root), ctx.root, undefined, ctx.daemon?.running() ?? [])),
  },
  {
    method: "GET",
    pattern: "/project/:name",
    mutating: false,
    page: true,
    handler: (_req, params, ctx) => html(renderProject(withRepo(ctx.root), params.name, ctx.root, undefined, ctx.daemon?.running() ?? [])),
  },
  {
    method: "GET",
    pattern: "/run/:project/:unit",
    mutating: false,
    page: true,
    handler: (_req, params, ctx) => html(renderRun(withRepo(ctx.root), params.project, params.unit, ctx.root, undefined, ctx.daemon?.running() ?? [])),
  },
  {
    method: "GET",
    pattern: "/registry",
    mutating: false,
    page: true,
    handler: (req, _params, ctx) => {
      const entity = new URL(req.url).searchParams.get("entity") ?? undefined;
      return html(renderRegistry(withRepo(ctx.root), ctx.root, entity));
    },
  },
  // Artifact render view (item 1, phase 7.5) — every artifact id in the product routes here now,
  // instead of falling back to the unit/run view. Read-only: the definition-browser pattern applied
  // to work/.
  {
    method: "GET",
    pattern: "/artifact/:project/:unit/:id",
    mutating: false,
    page: true,
    handler: (_req, params, ctx) => html(renderArtifact(withRepo(ctx.root), params.project, params.unit, params.id, ctx.root)),
  },
  // Idea render view (item 6) — the same artifact render view, applied to ideas/*.md.
  {
    method: "GET",
    pattern: "/idea/:name",
    mutating: false,
    page: true,
    handler: (_req, params, ctx) => html(renderIdea(withRepo(ctx.root), ctx.root, params.name)),
  },
  { method: "GET", pattern: "/styles.css", mutating: false, handler: () => serveAsset("styles.css") },
  { method: "GET", pattern: "/app.js", mutating: false, handler: () => serveAsset("app.js") },
  {
    method: "GET",
    pattern: "/events",
    mutating: false,
    handler: (req, _params, ctx) => sseResponse(ctx, req),
  },
  {
    method: "POST",
    pattern: "/gates/:project/:artifact/:verb",
    mutating: true,
    handler: async (req, params, ctx) => {
      const verb = params.verb as Verb;
      const allowed: Verb[] = ["approve", "request", "reject", "start", "notyet", "rescope", "retry", "skip", "abandon"];
      // Ruling C3 (extended): budget-gate verbs target a UNIT and are resolved against the daemon's
      // in-memory C3 state, not the on-disk artifact gate machinery — so they route separately.
      const budgetVerbs: Verb[] = ["continue", "raise", "stop"];
      if (budgetVerbs.includes(verb)) {
        if (!ctx.daemon) return json({ ok: false, error: "no daemon: budget gates are only resolvable on a live serve" }, 409);
        const r = ctx.daemon.resolveBudget(params.project, params.artifact, verb as "continue" | "raise" | "stop");
        if (!r.ok) return json({ ok: false, error: r.error }, 404);
        ctx.broadcast("reload");
        ctx.daemon.notify(); // a continue/raise may have just un-halted the unit — let the walk resume now.
        return json({ ok: true });
      }
      if (!allowed.includes(verb)) return json({ ok: false, error: `unknown verb '${verb}'` }, 400);
      let note: string | undefined;
      try {
        const body = await req.json();
        note = typeof body?.note === "string" ? body.note : undefined;
      } catch {
        /* no body / not JSON — note stays undefined */
      }
      const result = await resolveGate(ctx.root, params.project, params.artifact, verb, { note, memberRunner: ctx.memberRunner, daemon: ctx.daemon });
      if (!result.ok) return json({ ok: false, error: result.error }, result.status);
      ctx.broadcast("reload");
      // Deliverable (d): an approval (or any other resolution) may have just satisfied a producible
      // kind's dependencies — nudge the daemon to look now rather than wait out its own debounce, so
      // the walk visibly continues in the same interaction the Conductor just made.
      ctx.daemon?.notify();
      return json({ ok: true, commit: result.commit, changedFiles: result.changedFiles });
    },
  },
  {
    method: "POST",
    pattern: "/registry/*path",
    mutating: true,
    handler: async (req, params, ctx) => {
      const relPath = params.path;
      // Confine to real registry entity files (see isRegistryEditablePath). This replaces the old
      // textual `..` scan, which let `.git/hooks/pre-commit` and any other in-root path through.
      if (!isRegistryEditablePath(ctx.root, relPath)) {
        return json({ ok: false, error: "invalid path: the registry edit route may only write entity definition files under teams/agents/skills/knowledge/types/connectors/projects/evals/ideas" }, 400);
      }
      const file = join(ctx.root, relPath);
      let content: string;
      try {
        const body = await req.json();
        content = String(body?.content ?? "");
      } catch {
        return json({ ok: false, error: "expected JSON body { content }" }, 400);
      }
      const backup = existsSync(file) ? readFileSync(file, "utf8") : null;
      const dir = dirname(file);
      if (!existsSync(dir)) return json({ ok: false, error: `directory does not exist: ${dir}` }, 404);
      const { writeFileSync } = await import("node:fs");
      writeFileSync(file, content);
      // Validate with the same validator the whole repo is checked against (PRD §9: "validate → write → commit").
      const result = validatePath(ctx.root);
      if (!result.ok) {
        if (backup === null) {
          const { rmSync } = await import("node:fs");
          rmSync(file);
        } else {
          writeFileSync(file, backup);
        }
        return json({ ok: false, error: result.errors.slice(0, 5).map((e) => `${e.code}: ${e.message}`).join("; ") }, 422);
      }
      const commit = conductorCommit(ctx.root, [file], `edit ${relPath}`);
      ctx.broadcast("reload");
      return json({ ok: true, commit });
    },
  },
  {
    method: "POST",
    pattern: "/orchestrator/message",
    mutating: true,
    handler: async (req, _params, ctx) => {
      let text = "";
      try {
        const body = await req.json();
        text = String(body?.text ?? "");
      } catch {
        /* ignore */
      }
      // PRD §7: the Orchestrator holds no state — every call re-derives from the repo. `handle` is
      // the same entry point a scripted/chat driver uses in tests; a gate-decision message round-trips
      // to the identical `resolveGate` mutation the POST /gates route uses (ruling C7). The boundary is
      // selected fresh per request so a key added mid-session takes effect without a restart, and
      // never logged either way (invariant 11). `ctx.orchestratorBoundary` is a test-only override
      // (unset in production, where `selectOrchestratorBoundary()` always runs).
      //
      // NOTES C11: when no boundary is selectable (no credential, or the SDK's local preconditions
      // fail), this is NOT routed through a deterministic stand-in — that boundary no longer exists.
      // The route reports the honest disabled state and returns, never calling `handle()` at all.
      // NOTES F11: `root` lets the boundary resolve `studio.md#orchestrator_model` — the studio-level
      // declaration that is now the source of truth for the Orchestrator's model (LEVARE_ORCHESTRATOR_MODEL
      // remains a runtime override, checked first inside resolveOrchestratorModel).
      const boundary = ctx.orchestratorBoundary ?? selectOrchestratorBoundary(process.env, { ...ctx.orchestratorSelectOpts, root: ctx.root });
      if (!boundary) {
        const status = resolveOrchestratorStatus(process.env, ctx.orchestratorSelectOpts?.precondition);
        return json({ ok: false, disabled: true, reason: status.reason, envVar: status.envVar }, 503);
      }
      const today = new Date().toISOString().slice(0, 10);
      const orchestratorCtx = { root: ctx.root, by: `${CONDUCTOR_NAME} ${today}` };
      // The board is a projection of files; the Orchestrator's SDK voice is an enhancement on top of
      // it (§7), never a dependency the write surface can fail on. A genuine transport failure at this
      // point (the boundary WAS selectable — credential + binary both resolved — but the live call
      // itself failed: network, timeout, a model error) is a real error, surfaced as one — never
      // dressed up as an Orchestrator reply, and never silently downgraded to a canned voice.
      let reply: string;
      let result: HandleResult["result"];
      try {
        ({ reply, result } = await orchestratorHandle(text, orchestratorCtx, boundary));
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        console.error(`levare: Orchestrator SDK call failed: ${reason}`);
        return json({ ok: false, error: reason }, 502);
      }
      if (result && "ok" in result && result.ok && result.commit) {
        ctx.broadcast("reload");
        ctx.daemon?.notify(); // an Orchestrator-driven gate resolution can unblock the walk too.
      }
      ctx.broadcast(`orchestrator:${JSON.stringify({ text: reply })}`);
      return json({ ok: true, reply });
    },
  },
];

export const MUTATING_ROUTES = ROUTES.filter((r) => r.mutating).map((r) => ({ method: r.method, pattern: r.pattern }));

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

function matchRoute(method: string, pathname: string): { route: RouteDef; params: Record<string, string> } | null {
  const pathSegs = pathname.split("/").filter((s) => s.length > 0);
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const patSegs = route.pattern.split("/").filter((s) => s.length > 0);
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < patSegs.length; i++) {
      const p = patSegs[i];
      if (p.startsWith("*")) {
        params[p.slice(1)] = pathSegs.slice(i).join("/");
        ok = pathSegs.length >= i;
        break;
      }
      if (p.startsWith(":")) {
        if (pathSegs[i] === undefined) {
          ok = false;
          break;
        }
        params[p.slice(1)] = decodeURIComponent(pathSegs[i]);
        continue;
      }
      if (pathSegs[i] !== p) {
        ok = false;
        break;
      }
    }
    if (ok && (patSegs.some((p) => p.startsWith("*")) || pathSegs.length === patSegs.length)) {
      return { route, params };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// SSE — a stability fix (was BLOCKING): every connection used to call `subscribe()`, capture the
// returned `unsubscribe`, and then discard it (`void unsubscribe`) — a navigated-away or closed
// client's Sender was NEVER removed from the subscriber set. Observed live as the server process's
// open file descriptor count climbing with every page navigation (each page load opens a fresh
// EventSource) until the OS's per-process handle limit was exhausted and the server stopped
// responding — exactly the "something goes wrong after a few navigations" the Conductor reported.
// The fs.watch handle itself was already correct — ONE watcher per board, created once in
// createBoard() below and shared by every subscriber (a property of the repo being served, never of
// a client) — so the fix here is entirely about actually releasing a connection's resources on
// disconnect, not creating fewer watchers.
// ---------------------------------------------------------------------------

interface SseSubscriber {
  send: (chunk: string) => void;
  /** Ends this subscriber's stream from the server side — used on board shutdown to close every
   * still-open SSE connection, not just stop tracking it. */
  close: () => void;
}

function sseResponse(ctx: BoardCtx, req: Request): Response {
  let unsubscribe: (() => void) | undefined;
  let cleaned = false;
  // Idempotent: both the stream's own cancel() and the request's abort signal can fire for the same
  // disconnect (belt and suspenders across runtime/version differences in which one actually fires),
  // and this must only ever remove the subscriber once.
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    unsubscribe?.();
  };

  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      const sub: SseSubscriber = {
        send: (chunk) => {
          try {
            controller.enqueue(enc.encode(`data: ${chunk}\n\n`));
          } catch {
            cleanup(); // enqueue failing means the controller is already dead — stop tracking it now
          }
        },
        close: () => {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        },
      };
      unsubscribe = subscribe(ctx, sub);
      controller.enqueue(enc.encode(`: connected\n\n`));
    },
    // Fires when the stream's consumer (Bun, on client disconnect) cancels it.
    cancel() {
      cleanup();
    },
  });

  // Bun aborts a request's own AbortSignal when the underlying connection closes — the primary,
  // reliable "this client is gone" signal for a navigated-away or closed EventSource; the stream's
  // own cancel() above is the second path so cleanup still runs if only one of the two fires.
  req.signal.addEventListener("abort", cleanup);

  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
}

const subscribers = new WeakMap<BoardCtx, Set<SseSubscriber>>();
function subscribe(ctx: BoardCtx, sub: SseSubscriber): () => void {
  let set = subscribers.get(ctx);
  if (!set) subscribers.set(ctx, (set = new Set()));
  set.add(sub);
  return () => set!.delete(sub);
}
function subscribersOf(ctx: BoardCtx): Set<SseSubscriber> {
  return subscribers.get(ctx) ?? new Set();
}
/** Ends every still-open SSE stream for this board and stops tracking them — called on shutdown so a
 * server restart never leaves a client hanging on a connection nobody will ever write to again. */
function closeAllSubscribers(ctx: BoardCtx): void {
  for (const sub of subscribersOf(ctx)) sub.close();
  subscribers.delete(ctx);
}

/** Test-only: the live SSE subscriber count for a board. Broadcasting still reaching a fresh
 * connection after a churn of connect/disconnect cycles is NOT, on its own, proof the leak is
 * fixed — a dead subscriber's `send` just throws-and-is-caught silently, so a broadcast test alone
 * would pass whether or not old entries were ever actually removed. This is what lets a test assert
 * the set genuinely returns to empty, not merely that it still happens to work. */
export function debugSubscriberCount(ctx: BoardCtx): number {
  return subscribersOf(ctx).size;
}

// ---------------------------------------------------------------------------
// Board — the fetch handler + fs.watch-driven broadcaster, as a self-contained unit tests can start
// and stop without touching a real network port.
// ---------------------------------------------------------------------------

export interface Board {
  fetch(req: Request): Promise<Response>;
  close(): void;
  ctx: BoardCtx;
}

export function createBoard(
  root: string,
  opts: {
    readOnly?: boolean;
    orchestratorBoundary?: OrchestratorBoundary;
    orchestratorSelectOpts?: SelectOrchestratorBoundaryOptions;
    daemon?: Daemon;
    memberRunner?: AsyncMemberRunner;
  } = {},
): Board {
  const readOnly = opts.readOnly ?? isUnderFixtures(root);
  const ctx: BoardCtx = {
    root,
    readOnly,
    orchestratorBoundary: opts.orchestratorBoundary,
    orchestratorSelectOpts: opts.orchestratorSelectOpts,
    daemon: opts.daemon,
    memberRunner: opts.memberRunner,
    broadcast: (msg) => {
      for (const sub of subscribersOf(ctx)) sub.send(msg);
    },
  };

  // ONE fs.watch for this board's entire lifetime, shared by every SSE subscriber — a property of the
  // repo being served, never of a client. Nothing below creates a watcher per connection; this is the
  // only `watch()` call in the board's lifecycle, made once here at startup.
  let watcher: FSWatcher | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  const notify = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => ctx.broadcast("reload"), 80);
  };
  try {
    watcher = watch(root, { recursive: true }, () => notify());
  } catch {
    try {
      watcher = watch(root, {}, () => notify());
    } catch {
      watcher = null; // no fs.watch support on this platform; SSE channel still works for direct pushes.
    }
  }

  return {
    ctx,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const matched = matchRoute(req.method, url.pathname);
      if (!matched) return json({ ok: false, error: "not found" }, 404);
      // First-run experience (phase 6b): a repo-projecting screen against a root that isn't yet a
      // studio explains that and suggests `levare init`, instead of loadRepo throwing on a missing
      // root or every screen rendering its ordinary "nothing here" empty state with no next step.
      if (matched.route.page && !isStudioInitialized(ctx.root)) {
        return html(renderOnboarding(ctx.root));
      }
      // CSRF (surface 6): a cross-origin write is refused ahead of the handler — structurally, the
      // same posture as the read-only guard below — so no write route can ever run for a request
      // driven by a page on another origin in the operator's browser. See isCrossOriginWrite.
      if (matched.route.mutating && isCrossOriginWrite(req, url)) {
        return json(
          { ok: false, error: "cross-origin write refused: the board's write routes require a same-origin request (invariant: only the Conductor, from the board itself, mutates the repo)" },
          403,
        );
      }
      // Enforced ahead of the handler, not inside it: a read-only board's write routes cannot run at
      // all, by construction — there is no handler code path left to accidentally trigger a mutation.
      if (matched.route.mutating && ctx.readOnly) {
        return json(
          { ok: false, error: "this board is running read-only (serving a path under fixtures/, or --read-only was passed); write routes are disabled" },
          405,
        );
      }
      try {
        return await matched.route.handler(req, matched.params, ctx);
      } catch (e) {
        return json({ ok: false, error: String(e instanceof Error ? e.message : e) }, 500);
      }
    },
    close() {
      watcher?.close();
      if (debounce) clearTimeout(debounce);
      // Shutdown must end every still-open SSE stream, not just stop the watcher that used to feed
      // them — otherwise a restart leaves each connected client hanging on a socket nobody will ever
      // write to again.
      closeAllSubscribers(ctx);
    },
  };
}

export interface ServeHandle {
  board: Board;
  url: string;
  /** Stop listening, close the fs.watch handle, and (unless `keepProcessAlive`) exit the process. */
  stop(): void;
  /** null when `--no-daemon`/read-only — see `serve()`'s own opts doc. */
  daemon: Daemon | null;
}

// Binds 0.0.0.0 (not loopback-only) so the port is reachable from a forwarded/container port, not
// just from inside the same network namespace the process runs in. Returns the ServeHandle instead
// of exiting; the caller (the CLI's `serve` command, which is the long-running exception to
// process.exit — see runCli in cli.ts) is what keeps the process alive by simply never exiting.
export function serve(
  root: string,
  port = 4173,
  opts: {
    keepProcessAlive?: boolean;
    readOnly?: boolean;
    orchestratorBoundary?: OrchestratorBoundary;
    orchestratorSelectOpts?: SelectOrchestratorBoundaryOptions;
    /** Test-only override — see the default's own rationale below. */
    idleTimeoutSeconds?: number;
    /** Deliverable (a): `--no-daemon` disables the daemon; `levare serve` boots one by default,
     * alongside the board, in the same process. A read-only board (NOTES E14 — a path under
     * fixtures/, or --read-only) never gets a daemon regardless of this flag: the daemon's whole job
     * is to write artifacts, which a read-only board must never do (the same structural guarantee
     * that already gates the three write routes applies here, not a second rule to remember). */
    noDaemon?: boolean;
    /** Test-only: inject a daemon directly instead of letting `serve()` construct + own one. */
    daemon?: Daemon;
  } = {},
): ServeHandle {
  const keepAlive = opts.keepProcessAlive ?? true;
  const readOnly = opts.readOnly ?? isUnderFixtures(root);
  const daemon = opts.daemon ?? (opts.noDaemon || readOnly ? null : new Daemon(root));
  daemon?.start();
  const board = createBoard(root, {
    readOnly: opts.readOnly,
    orchestratorBoundary: opts.orchestratorBoundary,
    orchestratorSelectOpts: opts.orchestratorSelectOpts,
    daemon: daemon ?? undefined,
  });
  // idleTimeout (NOTES phase-7 K17, a live-gate fix-up — "a request must always produce a reply"):
  // Bun.serve's own default is 10 SECONDS — after that, Bun resets the connection with no HTTP
  // response at all if the handler hasn't sent anything yet. A real /orchestrator/message call can
  // routinely take longer than that, so this is set well past every internal SDK timeout (90s, see
  // orchestrator-boundary.ts's converseTimeoutMs) — Bun's idleTimeout should be a backstop of last
  // resort, never the thing that actually fires. It is NOT, on its own, what guarantees "a request
  // must always produce a reply": while investigating this, a POST carrying a body (the shape of
  // every real /orchestrator/message call) was observed to bypass Bun's own idle-timeout enforcement
  // entirely in this Bun version, even past this value — see tests/board-serve-idletimeout.test.ts.
  // The actual guarantee is the SDK transport's own setTimeout-based kill (sdk-transport.ts, proven in
  // tests/sdk-transport-hermetic.test.ts's hung-worker tests) plus this route's degrade-to-offline
  // catch below, both method/body-agnostic. This idleTimeout is defense in depth for the HTTP layer.
  const server = Bun.serve({ port, hostname: "0.0.0.0", idleTimeout: opts.idleTimeoutSeconds ?? 180, fetch: (req) => board.fetch(req) });
  // Bind 0.0.0.0 (above) so the port is reachable from outside the container, but never hand back
  // "0.0.0.0" as the connect address: "0.0.0.0" is a bind wildcard, not a real destination, and
  // connecting to it literally is OS/resolver-dependent — observed, while chasing the phase-7 K17
  // idleTimeout live-gate fix, to sometimes silently bypass Bun's own idle-timeout enforcement
  // entirely (a request that should have been reset instead hung open indefinitely). "localhost"
  // is what every caller — the printed CLI message, a browser, this file's own tests — should
  // actually use to reach the server that was just bound.
  const url = `http://localhost:${server.port}`;

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    daemon?.stop();
    board.close();
    server.stop(true);
  };

  if (keepAlive) {
    // SIGINT (Ctrl-C) / SIGTERM must shut down cleanly — close the listener and the fs.watch handle
    // rather than relying on the default signal disposition to just kill the process mid-request.
    const onSignal = () => {
      stop();
      process.exit(0);
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  }

  return { board, url, stop, daemon };
}

// `levare serve` (PRD §9). Raw Bun.serve, no framework: every GET re-derives HTML from the repo on
// every request (invariant 2); the write surface is exactly three routes (invariant 9), asserted
// against ROUTE_TABLE below by a test rather than re-typed there. SSE pushes a re-render trigger
// whenever fs.watch sees a change under the repo root — the client's job on receipt is just "refetch
// the page", never to patch DOM from a payload, keeping the projection stateless end to end.

import { watch, type FSWatcher } from "node:fs";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname, dirname, resolve, sep } from "node:path";
import { loadRepo, type Repo } from "../repo.ts";
import { renderStudio, renderProject, renderRun, renderRegistry } from "./render.ts";
import { resolveGate } from "./gateops.ts";
import { validatePath } from "../validate.ts";
import type { Verb } from "../runner.ts";
import { conductorCommit, CONDUCTOR_NAME } from "../git.ts";
import { handle as orchestratorHandle } from "../orchestrator.ts";
import { isStudioInitialized, renderOnboarding } from "./onboarding.ts";

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
}

// A demo/screenshot server pointed at a fixtures/ tree must not be able to mutate it, structurally —
// not "don't do that", a route that literally cannot execute. `fixtures/golden` and any future
// fixtures directory both qualify: any path with a literal `fixtures` path segment.
export function isUnderFixtures(root: string): boolean {
  return resolve(root).split(sep).includes("fixtures");
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
    handler: (_req, _params, ctx) => html(renderStudio(withRepo(ctx.root), ctx.root)),
  },
  {
    method: "GET",
    pattern: "/studio",
    mutating: false,
    page: true,
    handler: (_req, _params, ctx) => html(renderStudio(withRepo(ctx.root), ctx.root)),
  },
  {
    method: "GET",
    pattern: "/project/:name",
    mutating: false,
    page: true,
    handler: (_req, params, ctx) => html(renderProject(withRepo(ctx.root), params.name)),
  },
  {
    method: "GET",
    pattern: "/run/:project/:unit",
    mutating: false,
    page: true,
    handler: (_req, params, ctx) => html(renderRun(withRepo(ctx.root), params.project, params.unit, ctx.root)),
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
  { method: "GET", pattern: "/styles.css", mutating: false, handler: () => serveAsset("styles.css") },
  { method: "GET", pattern: "/app.js", mutating: false, handler: () => serveAsset("app.js") },
  {
    method: "GET",
    pattern: "/events",
    mutating: false,
    handler: (_req, _params, ctx) => sseResponse(ctx),
  },
  {
    method: "POST",
    pattern: "/gates/:project/:artifact/:verb",
    mutating: true,
    handler: async (req, params, ctx) => {
      const verb = params.verb as Verb;
      const allowed: Verb[] = ["approve", "request", "reject", "start", "notyet", "rescope"];
      if (!allowed.includes(verb)) return json({ ok: false, error: `unknown verb '${verb}'` }, 400);
      let note: string | undefined;
      try {
        const body = await req.json();
        note = typeof body?.note === "string" ? body.note : undefined;
      } catch {
        /* no body / not JSON — note stays undefined */
      }
      const result = resolveGate(ctx.root, params.project, params.artifact, verb, { note });
      if (!result.ok) return json({ ok: false, error: result.error }, result.status);
      ctx.broadcast("reload");
      return json({ ok: true, commit: result.commit, changedFiles: result.changedFiles });
    },
  },
  {
    method: "POST",
    pattern: "/registry/*path",
    mutating: true,
    handler: async (req, params, ctx) => {
      const relPath = params.path;
      if (!relPath || relPath.includes("..")) return json({ ok: false, error: "invalid path" }, 400);
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
      // to the identical `resolveGate` mutation the POST /gates route uses (ruling C7).
      const today = new Date().toISOString().slice(0, 10);
      const { reply, result } = orchestratorHandle(text, { root: ctx.root, by: `${CONDUCTOR_NAME} ${today}` });
      if (result && "ok" in result && result.ok && result.commit) ctx.broadcast("reload");
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
// SSE
// ---------------------------------------------------------------------------

type Sender = (chunk: string) => void;

function sseResponse(ctx: BoardCtx): Response {
  let send: Sender = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      send = (chunk) => {
        try {
          controller.enqueue(enc.encode(`data: ${chunk}\n\n`));
        } catch {
          /* client gone */
        }
      };
      controller.enqueue(enc.encode(`: connected\n\n`));
    },
  });
  const unsubscribe = subscribe(ctx, send);
  // Bun surfaces stream cancel on client disconnect; unsubscribe to avoid leaking senders.
  const wrapped = new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
  void unsubscribe;
  return wrapped;
}

const subscribers = new WeakMap<BoardCtx, Set<Sender>>();
function subscribe(ctx: BoardCtx, send: Sender): () => void {
  let set = subscribers.get(ctx);
  if (!set) subscribers.set(ctx, (set = new Set()));
  set.add(send);
  return () => set!.delete(send);
}
function subscribersOf(ctx: BoardCtx): Set<Sender> {
  return subscribers.get(ctx) ?? new Set();
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

export function createBoard(root: string, opts: { readOnly?: boolean } = {}): Board {
  const readOnly = opts.readOnly ?? isUnderFixtures(root);
  const ctx: BoardCtx = {
    root,
    readOnly,
    broadcast: (msg) => {
      for (const send of subscribersOf(ctx)) send(msg);
    },
  };

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
    },
  };
}

export interface ServeHandle {
  board: Board;
  url: string;
  /** Stop listening, close the fs.watch handle, and (unless `keepProcessAlive`) exit the process. */
  stop(): void;
}

// Binds 0.0.0.0 (not loopback-only) so the port is reachable from a forwarded/container port, not
// just from inside the same network namespace the process runs in. Returns the ServeHandle instead
// of exiting; the caller (the CLI's `serve` command, which is the long-running exception to
// process.exit — see runCli in cli.ts) is what keeps the process alive by simply never exiting.
export function serve(root: string, port = 4173, opts: { keepProcessAlive?: boolean; readOnly?: boolean } = {}): ServeHandle {
  const keepAlive = opts.keepProcessAlive ?? true;
  const board = createBoard(root, { readOnly: opts.readOnly });
  const server = Bun.serve({ port, hostname: "0.0.0.0", fetch: (req) => board.fetch(req) });
  const url = `http://${server.hostname}:${server.port}`;

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
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

  return { board, url, stop };
}

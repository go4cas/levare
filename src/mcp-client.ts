// MCP Phase 1a (PRD Amendment 3, ruling R5 — docs/prd-amendment-3.md §5): a real stdio MCP client.
// Spawns a local MCP server process, speaks JSON-RPC 2.0 over its stdin/stdout, completes the
// `initialize` handshake, sends `notifications/initialized`, and lists whatever the negotiated
// capabilities advertise (`tools/list`, `resources/list`). Handshake and discovery ONLY — this
// module never calls a tool or reads a resource; that is Phase 1b (invocation to artifact), a
// deliberately separate, later goal (ruling R5's own staged design).
//
// UNSANDBOXED (ruling R3 names Phase 1c as the sandbox wrap): the process spawned here runs with
// this module's own inherited environment and no OS-level confinement at all — no scoped HOME, no
// filesystem/network restriction, nothing R4 already gives a `kind: cli` member's spawn. That is a
// real, honest gap for anything beyond a trusted reference server run by a developer/test, not a
// production posture; nothing in this module, `validate`, or `doctor` may claim otherwise until
// Phase 1c actually wraps this spawn (see NOTES MCP-1A).
//
// This is the "new sibling" ruling R5 names for `RemoteBoundary` (adapters.ts) — deliberately NOT
// wired behind that interface yet. `RemoteBoundary.call(req): { doc: string }` is synchronous,
// matching the mocked fixture every dispatch path still uses (invariant 10's standing remote
// deferral, NOTES REV1 finding 3): a real stdio MCP session is an inherently async, multi-turn
// exchange over a long-lived child process (spawn once, write a request line, await the matched
// response line, tolerate the server's own unsolicited notifications arriving in between) — there is
// no correct synchronous encoding of that exchange. Reconciling the two (most likely an
// `AsyncRemoteBoundary`, mirroring the `AsyncNativeBoundary`/`AsyncCliSpawn` precedent NOTES F5/F8
// already established) is Phase 1b's concern, once there is a real call to make. This module is
// proven standalone instead, directly against a real reference server
// (tests/mcp-handshake.test.ts), never through the adapter/dispatch machinery.

export class McpProtocolError extends Error {}

export interface JsonRpcRequestMessage {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}
export interface JsonRpcNotificationMessage {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}
interface JsonRpcResponseMessage {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpServerInfo {
  name: string;
  version?: string;
  title?: string;
}

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  serverInfo: McpServerInfo;
  instructions?: string;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpResource {
  uri: string;
  name?: string;
  mimeType?: string;
  description?: string;
}

// The exact spawn template levare resolves a `kind: mcp` connector's declared stdio command to —
// argv only, never a shell string (mirrors adapters.ts#defaultCliCommand's identical
// non-shell-split guarantee: `argv[0]` plus its arguments, handed to a shell-less spawn).
export interface StdioMcpServerCommand {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface McpConnectOptions {
  /** Per-request timeout — also the ceiling `close()` waits before escalating to SIGKILL. */
  timeoutMs?: number;
}

export interface McpSession {
  readonly initializeResult: McpInitializeResult;
  /** `[]` when the negotiated capabilities never advertised `tools` — never sent as a probe. */
  listTools(): Promise<McpTool[]>;
  /** `[]` when the negotiated capabilities never advertised `resources` — never sent as a probe. */
  listResources(): Promise<McpResource[]>;
  close(): Promise<void>;
}

const CLIENT_INFO = { name: "levare", version: "0.0.1" };
// MCP protocol date-version this client requests. A server may negotiate a different version back
// (`initializeResult.protocolVersion`); Phase 1a accepts whatever the server names — it is here only
// to prove levare can complete a real handshake, not to enforce a specific spec revision.
const CLIENT_PROTOCOL_VERSION = "2024-11-05";
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Spawns `command.argv` as a local MCP server and completes the handshake: `initialize` →
 * validate the response shape → `notifications/initialized`. Throws `McpProtocolError` (and kills
 * the spawned process) on a malformed/missing response, a JSON-RPC error object, or a timeout.
 */
export async function connectStdioMcpServer(command: StdioMcpServerCommand, opts: McpConnectOptions = {}): Promise<McpSession> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const [bin, ...args] = command.argv;
  if (!bin) throw new McpProtocolError("mcp server command has no argv[0]");

  let proc: Bun.PipedSubprocess;
  try {
    proc = Bun.spawn([bin, ...args], {
      cwd: command.cwd,
      env: command.env ? { ...process.env, ...command.env } : process.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (e) {
    throw new McpProtocolError(`failed to spawn mcp server '${bin}': ${e instanceof Error ? e.message : String(e)}`);
  }

  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let nextId = 1;
  let closed = false;
  let stderrTail = "";

  function handleLine(line: string): void {
    let msg: JsonRpcResponseMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      // The MCP stdio transport reserves stdout for JSON-RPC frames only; a non-JSON line is a
      // server-side protocol violation, but Phase 1a's discovery-only scope has nothing to lose by
      // ignoring it rather than tearing down an otherwise-working handshake over it.
      return;
    }
    if (typeof msg.id !== "number") return; // the server's own notification — nothing to correlate.
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.error) waiter.reject(new McpProtocolError(`mcp server '${bin}' returned an error for request ${msg.id}: [${msg.error.code}] ${msg.error.message}`));
    else waiter.resolve(msg.result);
  }

  const readLoop = (async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (line) handleLine(line);
        }
      }
    } catch {
      /* stream closed/errored underneath us — in-flight requests are settled by close()/timeout */
    }
  })();

  const stderrLoop = (async () => {
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        // Bounded tail only (mirrors adapters.ts#truncateTail's own reasoning) — this is diagnostic
        // context for a failed handshake, never something that should grow without bound.
        stderrTail = (stderrTail + decoder.decode(value, { stream: true })).slice(-4000);
      }
    } catch {
      /* best-effort */
    }
  })();

  function send(msg: JsonRpcRequestMessage | JsonRpcNotificationMessage): void {
    proc.stdin.write(`${JSON.stringify(msg)}\n`);
    proc.stdin.flush();
  }

  function request<T>(method: string, params?: unknown): Promise<T> {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        const tail = stderrTail.trim();
        reject(new McpProtocolError(`mcp server '${bin}' timed out waiting for '${method}' response after ${timeoutMs}ms${tail ? ` (stderr: ${tail.slice(-500)})` : ""}`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      send({ jsonrpc: "2.0", id, method, params });
    });
  }

  function notify(method: string, params?: unknown): void {
    send({ jsonrpc: "2.0", method, params });
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    for (const waiter of pending.values()) waiter.reject(new McpProtocolError("mcp session closed"));
    pending.clear();
    try {
      await proc.stdin.end();
    } catch {
      /* already closed */
    }
    proc.kill();
    await Promise.race([proc.exited, new Promise((r) => setTimeout(r, 2000))]);
    if (proc.exitCode === null && proc.signalCode === null) {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
    await Promise.allSettled([readLoop, stderrLoop]);
  }

  let initializeResult: McpInitializeResult;
  try {
    const result = await request<McpInitializeResult>("initialize", {
      protocolVersion: CLIENT_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });
    if (!result || typeof result.protocolVersion !== "string" || typeof result.serverInfo?.name !== "string" || typeof result.capabilities !== "object" || result.capabilities === null) {
      throw new McpProtocolError(`mcp server '${bin}' returned a malformed initialize result: ${JSON.stringify(result)}`);
    }
    initializeResult = result;
    notify("notifications/initialized");
  } catch (e) {
    await close();
    throw e;
  }

  const capabilities = initializeResult.capabilities;

  return {
    initializeResult,
    async listTools() {
      if (!("tools" in capabilities)) return [];
      const result = await request<{ tools?: McpTool[] }>("tools/list", {});
      return result.tools ?? [];
    },
    async listResources() {
      if (!("resources" in capabilities)) return [];
      const result = await request<{ resources?: McpResource[] }>("resources/list", {});
      return result.resources ?? [];
    },
    close,
  };
}

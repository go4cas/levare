// MCP Phase 1a/1b/1c (PRD Amendment 3, rulings R3/R5 — docs/prd-amendment-3.md §§3/5): a real stdio MCP
// client. Spawns a local MCP server process, speaks JSON-RPC 2.0 over its stdin/stdout, completes the
// `initialize` handshake, sends `notifications/initialized`, lists whatever the negotiated
// capabilities advertise (`tools/list`, `resources/list`), and — since Phase 1b — invokes a named tool
// (`tools/call`, `callTool` below). Phase 1a proved handshake and discovery only; Phase 1b closes the
// remaining step (invocation) so `adapters.ts#createAsyncStdioRemoteBoundary` can turn a real tool
// response into a real artifact.
//
// THIS MODULE ITSELF carries no sandboxing — `connectStdioMcpServer` spawns exactly `command.argv`
// (never wrapped/interpreted here), in `command.cwd` (verbatim), with `command.env` as the WHOLE spawn
// environment when supplied. That is deliberate, not a gap: ruling R3's sandbox wrap (Phase 1c) lives
// entirely at the CALLER, `adapters.ts#createAsyncStdioRemoteBoundary` — it composes the sandboxed argv
// (bwrap/sandbox-exec-prefixed), the per-dispatch scratch `cwd`, and the scoped `env` BEFORE ever
// calling this function, exactly mirroring how `Bun.spawn` itself has no sandbox awareness and
// `sandbox.ts#wrapForSandbox` does that composing for a `kind: cli` member's spawn. A caller that hands
// this function unwrapped argv/an unscoped env gets an unsandboxed spawn — same as it always has —
// which is exactly what a test (or `mcp-client.test.ts`'s own direct calls) legitimately wants.
//
// This is the "new sibling" ruling R5 names for `RemoteBoundary` (adapters.ts): `RemoteBoundary.call
// (req): { doc: string }` is synchronous, matching the mocked fixture every dispatch path used through
// Phase 1a — a real stdio MCP session is an inherently async, multi-turn exchange over a long-lived
// child process (spawn once, write a request line, await the matched response line, tolerate the
// server's own unsolicited notifications arriving in between), so there is no correct synchronous
// encoding of it. Phase 1b reconciles this via `AsyncRemoteBoundary` (adapters.ts), mirroring the
// `AsyncNativeBoundary`/`AsyncCliSpawn` precedent NOTES F5/F8 already established — this module stays a
// standalone protocol client either way, proven directly against a real reference server
// (tests/mcp-handshake.test.ts) and, since Phase 1b, through the adapter/dispatch machinery too
// (tests/mcp-remote-e2e.test.ts).

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

// NOTES MCP-1B (Phase 1b, ruling R5): a `tools/call` response's content is a list of typed blocks per
// the MCP spec (text/image/resource/...); Phase 1b's own artifact-production path only ever reads the
// text blocks (`callTool`'s own caller, adapters.ts#createAsyncStdioRemoteBoundary) — other block types
// pass through unread rather than being rejected, since a well-behaved tool may legitimately mix them.
export interface McpToolCallContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface McpToolCallResult {
  content: McpToolCallContentBlock[];
  // `true` when the tool itself reports a failure (per the MCP spec, distinct from a JSON-RPC error —
  // the call succeeded, but the TOOL failed) — the caller's own concern to surface, never swallowed here.
  isError?: boolean;
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
  /**
   * NOTES MCP-1B (Phase 1b, ruling R5) — invoke exactly one server tool by name, `tools/call`. Unlike
   * `listTools`/`listResources`, this is never short-circuited on the negotiated `tools` capability: a
   * caller that names a tool has already decided it exists (adapters.ts's own dispatch validates the
   * agent/connector declaration before ever reaching here) — a server that genuinely has no such tool,
   * or advertises no `tools` capability at all, reports that as its own JSON-RPC error, surfaced as
   * `McpProtocolError` exactly like any other malformed/error response.
   */
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult>;
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
      // NOTES MCP-1B: when `command.env` is given, it is the WHOLE spawn environment, never merged
      // OVER `process.env` — the same "env is replaced wholesale, that is the allowlist guarantee"
      // contract adapters.ts's own CliSpawn boundaries give a `kind: cli` member's spawn. Phase 1a never
      // exercised this path (its own tests/scripts pass no `env:` at all, relying on the `undefined` ->
      // `process.env` branch below for a dev-tool run) — Phase 1b's real member dispatch is what makes
      // this matter: `req.env` here is already `buildMemberEnv`'s allowlisted output, and merging it
      // OVER the full host `process.env` would leak every var levare deliberately withheld straight into
      // the spawned MCP server's process, defeating invariant 11 for exactly the call site this
      // connects.
      env: command.env ?? process.env,
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
    async callTool(name: string, args: Record<string, unknown>) {
      const result = await request<McpToolCallResult>("tools/call", { name, arguments: args });
      if (!result || !Array.isArray(result.content)) {
        throw new McpProtocolError(`mcp server '${bin}' returned a malformed tools/call result for '${name}': ${JSON.stringify(result)}`);
      }
      return result;
    },
    close,
  };
}

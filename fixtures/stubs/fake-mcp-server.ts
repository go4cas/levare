#!/usr/bin/env bun
// Deterministic fake stdio MCP server (NOTES MCP-1A) — exercises src/mcp-client.ts's handshake and
// discovery logic against the same newline-delimited JSON-RPC wire format a real server uses,
// without any network dependency. The real-server proof lives in tests/mcp-handshake.test.ts (a
// genuine `npx`/`bunx`-spawned reference server); this fixture covers the edge cases a live,
// well-behaved reference server never exercises on purpose: a malformed response, a JSON-RPC error,
// and a server that declares no discoverable capabilities at all.
//
//   fake-mcp-server.ts <mode>
//
// Modes: normal | malformed | error | no-capabilities | hang | tool-error
//
// NOTES MCP-1B: "normal" (and every mode reaching handleLine's default tools/call branch) answers
// tools/call generically — echoes the call's own arguments back as text, deterministic and
// argument-visible, so a caller can assert both that the call happened AND what it was called with.
// "tool-error" answers with `isError: true` instead, for adapters.ts#createAsyncStdioRemoteBoundary's
// own isError handling.

const mode = process.argv[2] ?? "normal";

function send(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function fail(message: string): never {
  console.error(`[fake-mcp-server] ${message}`);
  process.exit(1);
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buf += chunk;
  let idx: number;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line) handleLine(line);
  }
});

function handleLine(line: string): void {
  const msg = JSON.parse(line) as { id?: number; method: string; params?: unknown };
  if (msg.method === "initialize") return handleInitialize(msg.id!);
  if (msg.method === "notifications/initialized") return; // no response expected
  if (msg.method === "tools/list") return send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "noop", description: "does nothing" }] } });
  if (msg.method === "resources/list") return send({ jsonrpc: "2.0", id: msg.id, result: { resources: [{ uri: "fake://one", name: "one" }] } });
  if (msg.method === "tools/call") return handleToolCall(msg.id!, msg.params as { name: string; arguments?: Record<string, unknown> });
  fail(`unexpected method in mode '${mode}': ${msg.method}`);
}

function handleToolCall(id: number, params: { name: string; arguments?: Record<string, unknown> }): void {
  if (mode === "tool-error") {
    send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `tool '${params.name}' failed` }], isError: true } });
    return;
  }
  send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `called ${params.name} with ${JSON.stringify(params.arguments ?? {})}` }] } });
}

function handleInitialize(id: number): void {
  if (mode === "hang") {
    return; // deliberately never responds — exercises src/mcp-client.ts's request timeout path
  } else if (mode === "normal" || mode === "tool-error") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "fake-mcp-server", version: "0.0.1" },
      },
    });
  } else if (mode === "no-capabilities") {
    send({
      jsonrpc: "2.0",
      id,
      result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake-mcp-server", version: "0.0.1" } },
    });
  } else if (mode === "malformed") {
    // Missing serverInfo entirely — src/mcp-client.ts must reject this, never coerce/guess a name.
    send({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: {} } });
  } else if (mode === "error") {
    send({ jsonrpc: "2.0", id, error: { code: -32000, message: "simulated initialize failure" } });
  } else {
    fail(`unknown mode '${mode}'`);
  }
}

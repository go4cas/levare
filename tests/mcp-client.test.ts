import { test, expect, describe } from "bun:test";
import { connectStdioMcpServer, McpProtocolError } from "../src/mcp-client.ts";

// MCP Phase 1a (PRD Amendment 3, ruling R5) — offline coverage of src/mcp-client.ts's handshake and
// discovery logic against a deterministic fake stdio server (fixtures/stubs/fake-mcp-server.ts), no
// network dependency. The genuine wire-compatibility proof — a real reference MCP server, spawned
// via npx/bunx — lives in tests/mcp-handshake.test.ts; this file covers edge cases a live,
// well-behaved reference server has no reason to exercise: a malformed response, a JSON-RPC error,
// and a server whose negotiated capabilities advertise neither tools nor resources.

function fakeServer(mode: string) {
  return { argv: ["bun", "fixtures/stubs/fake-mcp-server.ts", mode] };
}

describe("connectStdioMcpServer (fake server, offline)", () => {
  test("completes initialize + initialized and discovers tools/resources per negotiated capabilities", async () => {
    const session = await connectStdioMcpServer(fakeServer("normal"), { timeoutMs: 5000 });
    expect(session.initializeResult.protocolVersion).toBe("2024-11-05");
    expect(session.initializeResult.serverInfo.name).toBe("fake-mcp-server");
    expect(session.initializeResult.capabilities).toEqual({ tools: {}, resources: {} });
    const tools = await session.listTools();
    const resources = await session.listResources();
    expect(tools).toEqual([{ name: "noop", description: "does nothing" }]);
    expect(resources).toEqual([{ uri: "fake://one", name: "one" }]);
    await session.close();
  });

  test("never sends tools/list or resources/list when the server declares neither capability", async () => {
    // fixtures/stubs/fake-mcp-server.ts's `no-capabilities` mode treats any tools/list or
    // resources/list request as a protocol violation it exits non-zero over (`fail(...)`) — the only
    // reason this test passes at all is that listTools()/listResources() short-circuit on the
    // client side (capabilities has neither key) and never send the request in the first place.
    const session = await connectStdioMcpServer(fakeServer("no-capabilities"), { timeoutMs: 5000 });
    expect(session.initializeResult.capabilities).toEqual({});
    await expect(session.listTools()).resolves.toEqual([]);
    await expect(session.listResources()).resolves.toEqual([]);
    await session.close();
  });

  test("rejects with McpProtocolError on a malformed initialize result", async () => {
    await expect(connectStdioMcpServer(fakeServer("malformed"), { timeoutMs: 5000 })).rejects.toThrow(McpProtocolError);
  });

  test("rejects with McpProtocolError when the server returns a JSON-RPC error object", async () => {
    await expect(connectStdioMcpServer(fakeServer("error"), { timeoutMs: 5000 })).rejects.toThrow(/simulated initialize failure/);
  });

  test("rejects when argv[0] cannot be spawned at all", async () => {
    await expect(connectStdioMcpServer({ argv: ["/no/such/binary/levare-mcp-test"] }, { timeoutMs: 2000 })).rejects.toThrow(McpProtocolError);
  });

  test("rejects with a timeout error when the server never responds to initialize", async () => {
    await expect(connectStdioMcpServer(fakeServer("hang"), { timeoutMs: 500 })).rejects.toThrow(/timed out waiting for 'initialize'/);
  });

  test("close() is idempotent and safe to call twice", async () => {
    const session = await connectStdioMcpServer(fakeServer("normal"), { timeoutMs: 5000 });
    await session.close();
    await session.close();
  });
});

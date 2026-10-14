import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpManager } from "../core/mcp/manager.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const outcome = (promise) => promise.then(value => ({ value, error: null }), error => ({ value: null, error }));
const complete = { content: [{ type: "text", text: "ok" }] };

async function fixture(transport, { autoReconnect = false, endpoint = true, initialize = true } = {}) {
  const streams = [];
  const posts = [];
  const sockets = new Set<import("node:net").Socket>();
  let hold = true;
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET") {
      streams.push(res);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.flushHeaders();
      if (endpoint) res.write(`event: endpoint\ndata: /messages?g=${streams.length}\n\n`);
      return;
    }
    let wire = "";
    for await (const chunk of req) wire += chunk;
    const body = JSON.parse(wire);
    if (req.url === "/sse") { res.writeHead(405).end(); return; }
    posts.push(body);
    res.writeHead(202).end(); // An ack is not the response to the JSON-RPC request.
    if (body.id == null) return;
    const stream = streams[Number(new URL(req.url, "http://localhost").searchParams.get("g")) - 1];
    if (body.method === "initialize" && !initialize) return;
    if (body.method === "tools/call" && hold) return;
    const result = body.method === "initialize" ? { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "local", version: "1" } }
      : body.method === "tools/list" ? { tools: [{ name: "write", inputSchema: { type: "object" } }] } : complete;
    stream.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`);
  });
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback address");
  const base = `http://127.0.0.1:${address.port}`;
  let config = { enabled: true, connectors: [{ id: "remote", name: "Local", enabled: true, transport,
    url: `${base}/sse`, authType: "none", autoReconnect, timeout: 2, tools: [] }] };
  const manager = new McpManager({ dataDir: "/unused-sse-fixture", log: { debug() {}, warn() {}, info() {}, error() {} } }, {
    configStore: { get: () => config, set: (_key, value) => { config = value; } },
    fetchImpl: (url, init) => { expect(String(url).startsWith(`${base}/`)).toBe(true); return fetch(url, init); },
  });
  const closes = vi.spyOn(manager, "_onClientClose");
  cleanups.push(async () => {
    await manager.dispose();
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    expect(server.listening).toBe(false);
  });
  return { manager, streams, posts, closes, get config() { return config; }, serveTools: () => { hold = false; },
    current: () => { const client = manager.clients.get("remote"); return transport === "remote" ? client?.client : client; },
    calls: () => posts.filter(p => p.method === "tools/call"),
    terminate: (kind) => kind === "eof" ? streams.at(-1).end() : streams.at(-1).destroy() };
}

describe.each(["sse", "remote"])("legacy SSE native TCP (%s)", transport => {
  for (const kind of ["error", "eof"])
    for (const count of [0, 2])
      it(`${kind} with ${count} pending stops once; explicit reopen succeeds without replay`, async () => {
        const f = await fixture(transport);
        await f.manager.startConnector("remote");
        const client = f.current();
        const pending = Array.from({ length: count }, () => outcome(client.callTool("write", {})));
        await vi.waitFor(() => expect(f.calls()).toHaveLength(count));
        f.terminate(kind);
        const results = await Promise.all(pending);
        await vi.waitFor(() => expect(client.running).toBe(false));
        for (const result of results) {
          if (kind === "error") expect(result.error).toBeInstanceOf(TypeError);
          else expect(result.error?.message).toMatch(/stream closed/);
        }
        expect(client._pending.size).toBe(0);
        expect(client.messageEndpoint).toBe("");
        expect(f.manager.connectorStatusFor("remote")).toBe("stopped");
        expect(f.manager.reconnectState.size).toBe(0);
        expect(f.closes).toHaveBeenCalledTimes(1);
        expect(f.closes.mock.calls[0][1]).toMatchObject({ expected: false, needsAuth: false });
        expect(f.calls()).toHaveLength(count);
        f.serveTools();
        await f.manager.startConnector("remote");
        expect(f.streams).toHaveLength(2);
        expect(f.calls()).toHaveLength(count);
        expect(await f.current().callTool("write", {})).toEqual(complete);
        expect(f.calls()).toHaveLength(count + 1);
      });

  for (const kind of ["error", "eof"])
    it(`${kind} permits only existing backoff reconnect and never repeats a tool`, async () => {
      const f = await fixture(transport, { autoReconnect: true });
      await f.manager.startConnector("remote");
      const client = f.current();
      const pending = outcome(client.callTool("write", {}));
      await vi.waitFor(() => expect(f.calls()).toHaveLength(1));
      f.terminate(kind);
      expect((await pending).error).toBeTruthy();
      await vi.waitFor(() => expect(f.manager.connectorStatusFor("remote")).toBe("reconnecting"));
      await vi.waitFor(() => expect(f.manager.connectorStatusFor("remote")).toBe("running"), { timeout: 3500 });
      expect(f.streams).toHaveLength(2);
      expect(f.calls()).toHaveLength(1);
      expect(f.posts.filter(p => p.method === "initialize")).toHaveLength(2);
      expect(f.posts.filter(p => p.method === "tools/list")).toHaveLength(2);
      expect(f.closes).toHaveBeenCalledTimes(1);
    });

  it("deliberate stop closes the TCP reader and reopening uses a new client", async () => {
    const f = await fixture(transport, { autoReconnect: true });
    await f.manager.startConnector("remote");
    const old = f.current();
    const pending = outcome(old.callTool("write", {}));
    await vi.waitFor(() => expect(f.calls()).toHaveLength(1));
    await f.manager.stopConnector("remote");
    expect((await pending).error?.message).toBe("MCP connector stopped");
    await vi.waitFor(() => expect(f.streams[0].destroyed).toBe(true));
    expect(f.closes).not.toHaveBeenCalled();
    expect(f.manager.reconnectState.size).toBe(0);
    f.serveTools(); await f.manager.startConnector("remote");
    expect(f.current()).not.toBe(old);
    expect(await f.current().callTool("write", {})).toEqual(complete);
    expect(f.calls()).toHaveLength(2);
  });
});

for (const kind of ["error", "eof"])
  for (const phase of ["before-endpoint", "during-initialize"])
    it(`native ${kind} ${phase} ends startup without initialized or a reconnect`, async () => {
      const f = await fixture("sse", { endpoint: phase !== "before-endpoint", initialize: false });
      const starting = outcome(f.manager.startConnector("remote"));
      await vi.waitFor(() => expect(f.streams).toHaveLength(1));
      if (phase === "during-initialize") await vi.waitFor(() => expect(f.posts.some(p => p.method === "initialize")).toBe(true));
      f.terminate(kind);
      const result = await starting;
      if (kind === "error") expect(result.error).toBeInstanceOf(TypeError);
      else expect(result.error?.message).toMatch(/stream closed/);
      expect(f.posts.some(p => p.method === "notifications/initialized")).toBe(false);
      expect(f.manager.connectorStatusFor("remote")).toBe("stopped");
      expect(f.manager.reconnectState.size).toBe(0);
      expect(f.closes).not.toHaveBeenCalled(); // Startup promise owns the manager state.
    });

for (const gate of ["desired-stopped", "global-disabled", "connector-disabled"])
  it(`reader failure respects ${gate} even with autoReconnect enabled`, async () => {
    const f = await fixture("sse", { autoReconnect: true });
    await f.manager.startConnector("remote");
    const client = f.current();
    if (gate === "desired-stopped") f.manager.desiredStates.set("remote", "stopped");
    else if (gate === "global-disabled") f.config.enabled = false;
    else f.config.connectors[0].enabled = false;
    f.terminate("error");
    await vi.waitFor(() => expect(client.running).toBe(false));
    expect(f.manager.reconnectState.size).toBe(0);
    expect(f.streams).toHaveLength(1);
    expect(f.calls()).toHaveLength(0);
  });

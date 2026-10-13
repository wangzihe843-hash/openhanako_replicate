import http from "node:http";
import { afterEach, beforeEach, expect, it } from "vitest";
import { McpStreamableHttpClient } from "../core/mcp/clients/http-client.ts";
import { complete, envelope } from "./fixtures/mcp-http-fixture.ts";

let server: http.Server;
let base: string;
let executed: number;
beforeEach(async () => {
  executed = 0;
  server = http.createServer(async (req, res) => {
    if (req.method === "DELETE") { res.writeHead(202).end(); return; }
    let data = "";
    for await (const chunk of req) data += chunk;
    const body = JSON.parse(data);
    if (body.id == null) { res.writeHead(202).end(); return; }
    const initializing = body.method === "initialize";
    const version = req.headers["mcp-protocol-version"];
    if (!initializing) executed++; // A side effect happens before the response is lost.
    const result = initializing ? {
      protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: "loopback-fixture", version: "1" },
    } : complete(version === "2026-07-28" ? "modern" : "legacy");
    let wire = JSON.stringify(envelope(body.id, result));
    const isSse = req.url === "/sse";
    if (isSse) wire = `data: ${wire}\n\n`;
    res.writeHead(200, {
      "Content-Type": isSse ? "text/event-stream" : "application/json", "Content-Length": Buffer.byteLength(wire),
      ...(initializing ? { "MCP-Session-Id": "loopback-session" } : {}),
    });
    if (initializing) { res.end(wire); return; }
    res.flushHeaders();
    res.write(wire.slice(0, 25));
    setTimeout(() => res.destroy(), 20);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback address");
  base = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  server?.closeAllConnections();
  if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
});

it("native Fetch rejects a truncated body after receiving successful headers", async () => {
  const response = await fetch(`${base}/json`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call" }) });
  expect(response.status).toBe(200);
  expect(response.ok).toBe(true);
  await expect(response.text()).rejects.toBeInstanceOf(TypeError);
  expect(executed).toBe(1);
});

it.each([
  ["2026-07-28", "json"], ["2026-07-28", "sse"],
  ["2025-11-25", "json"], ["2025-11-25", "sse"],
])("%s %s rejects actual TCP truncation without repeating the action", async (version, format) => {
  const closes = [];
  let calls = 0;
  const client = new McpStreamableHttpClient({ id: "loopback", url: `${base}/${format}`, protocolVersion: version, timeout: 2 }, {
    fetchImpl: (url, init) => {
      if (init.body && JSON.parse(init.body).method === "tools/call") calls++;
      return fetch(url, init);
    }, log: { ...console, debug() {}, warn() {} }, onClose: (info) => closes.push(info),
  });
  try {
    await client.start();
    await expect(client.callTool("write", {})).rejects.toBeInstanceOf(TypeError);
    expect(calls).toBe(1);
    expect(executed).toBe(1);
    expect(client.running).toBe(false);
    expect(closes).toHaveLength(1);
    expect(closes[0].needsAuth).toBe(false);
  } finally { await client.stop(); }
});

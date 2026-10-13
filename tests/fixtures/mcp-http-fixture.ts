import assert from "node:assert/strict";
import { McpManager } from "../../core/mcp/manager.ts";

export const modes = ["modern", "legacy", "sse"] as const;
export const httpModes = ["modern", "legacy"] as const;
export type Mode = typeof modes[number];
export const delay = (ms = 10) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export async function until(probe: () => boolean, timeout = 2_000) {
  const deadline = Date.now() + timeout;
  while (!probe()) {
    if (Date.now() >= deadline) throw new Error("MCP fixture gate timed out");
    await delay(5);
  }
}
export function gate<T = void>() {
  let resolve: (value: T) => void;
  let reject: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
export const watch = <T>(promise: Promise<T>) => promise.then(
  (value) => ({ value, error: undefined }),
  (error) => ({ value: undefined, error }),
);
export const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json", ...headers },
});
export const encoder = new TextEncoder();
export const envelope = (id, result) => ({ jsonrpc: "2.0", id, result });
export const packet = (id, result) => `data: ${JSON.stringify(envelope(id, result))}\n\n`;
export function complete(mode: Mode, text = "side effect recorded") {
  return {
    ...(mode === "modern" ? { resultType: "complete" } : {}),
    content: [{ type: "text", text }], isError: false,
  };
}

// Native body consumption rejects after receiving part of a real RPC envelope.
// Do not replace Response.text/json: those are the behavior under test.
export function truncated(prefix, {
  contentType = "application/json", status = 200,
  error = new TypeError("transport body interrupted"),
} = {}) {
  let pulls = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (pulls++ === 0) controller.enqueue(encoder.encode(prefix));
      else controller.error(error);
    },
  }), { status, headers: { "Content-Type": contentType } });
}
export function heldBody(contentType = "application/json") {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const reading = gate();
  const response = new Response(new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    pull() { reading.resolve(); },
  }, { highWaterMark: 0 }), { headers: { "Content-Type": contentType } });
  return { response, controller, reading: reading.promise };
}

// Only HTTP and persisted configuration are fixtures. The manager, publication,
// auth refresh, cancellation and all three transports are the real implementations.
export async function harness(mode: Mode, { oauth = false, autoReconnect = false, timeout = 2 } = {}) {
  let stored = {
    enabled: true,
    connectors: [{
      id: "remote", name: "Remote fixture", enabled: true,
      url: "https://fixture.invalid/mcp", transport: mode === "sse" ? "sse" : "streamable-http",
      headers: { "MCP-Protocol-Version": mode === "modern" ? "2026-07-28" : "2025-11-25" },
      autoReconnect, timeout, authType: oauth ? "oauth" : "none", oauthClientId: "fixture-client",
      ...(oauth ? { oauth: {
        accessToken: "fixture-old", refreshToken: "fixture-refresh",
        tokenEndpoint: "https://fixture.invalid/token", expiresAt: Date.now() + 3_600_000,
      } } : {}),
      tools: [{ name: "write", description: "Local fixture counter", inputSchema: {
        type: "object", properties: { tag: { type: "string" } },
      } }],
    }],
  };
  const calls = [], all = [], closes = [], logs = [], streams = [], tokenRequests = [];
  let stream: ReadableStreamDefaultController<Uint8Array>;
  let toolReply, listReply, resourceReply, notificationReply;
  let tokenReply = async (_init): Promise<Response> => json({ access_token: "fixture-new", expires_in: 3600 });
  const sendRaw = (text: string) => stream.enqueue(encoder.encode(text));
  const send = (message) => sendRaw(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
  const respond = (body, result) => {
    if (mode === "sse") {
      queueMicrotask(() => send(envelope(body.id, result)));
      return new Response(null, { status: 202 });
    }
    return json(envelope(body.id, result), 200,
      body.method === "initialize" ? { "MCP-Session-Id": "fixture-session" } : {});
  };
  const fetchImpl = async (url, init: RequestInit = {}) => {
    if (String(url) === "https://fixture.invalid/token") {
      tokenRequests.push(init);
      return tokenReply(init);
    }
    if (init.method === "DELETE") return new Response(null, { status: 202 });
    if (init.method === "GET") {
      assert.equal(mode, "sse");
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller;
          streams.push(controller);
          controller.enqueue(encoder.encode("event: endpoint\ndata: /messages\n\n"));
          init.signal?.addEventListener("abort", () => {
            try { controller.close(); } catch { /* Already closed by the scenario. */ }
          }, { once: true });
        },
      }), { headers: { "Content-Type": "text/event-stream" } });
    }
    const body = JSON.parse(String(init.body));
    all.push({ body, init });
    assert.equal(body.jsonrpc, "2.0");
    if (body.id == null) return notificationReply ? notificationReply(body) : new Response(null, { status: 202 });
    if (mode === "modern") {
      assert.equal(body.params._meta["io.modelcontextprotocol/protocolVersion"], "2026-07-28");
      assert.equal(init.headers["MCP-Protocol-Version"], "2026-07-28");
    }
    if (body.method === "initialize") return respond(body, {
      protocolVersion: body.params.protocolVersion, capabilities: { tools: {} },
      serverInfo: { name: "local-fixture", version: "1" },
    });
    if (body.method === "tools/list") return listReply ? listReply(body, init) : respond(body, {
      ...(mode === "modern" ? { resultType: "complete" } : {}), tools: stored.connectors[0].tools,
    });
    if (body.method === "resources/read") return resourceReply(body, init);
    if (body.method === "tools/call") {
      calls.push({ body, init });
      return toolReply ? toolReply(body, init) : respond(body, complete(mode));
    }
    throw new Error(`Unexpected fixture request ${body.method}`);
  };
  const manager = new McpManager({
    dataDir: "/unused-mcp-http-fixture", log: { debug: (v) => logs.push(v), warn: (v) => logs.push(v), info() {}, error() {} },
  }, { configStore: { get: () => stored, set: (_key, value) => { stored = value; } }, fetchImpl });
  manager._bus = { request: async () => ({ config: {
    mcp: { connectors: { remote: { enabled: true, tools: { write: true } } } },
  } }) };
  const onClose = manager._onClientClose.bind(manager);
  manager._onClientClose = (id, info) => { closes.push(info); return onClose(id, info); };
  await manager.startConnector("remote");
  const client = manager.clients.get("remote");
  const tool = manager.getAllTools().find((entry) => entry.name === "mcp_remote_write");
  assert.ok(tool);
  return {
    mode, manager, client, tool, calls, all, closes, logs, tokenRequests, respond, send, sendRaw,
    failStream: (error: Error) => stream.error(error), closeStream: () => stream.close(),
    reply: (fn) => { toolReply = fn; }, replyList: (fn) => { listReply = fn; },
    replyResource: (fn) => { resourceReply = fn; }, replyNotify: (fn) => { notificationReply = fn; },
    replyToken: (fn) => { tokenReply = fn; },
    mutate: (fn) => fn(stored.connectors[0]),
    expire: () => { stored.connectors[0].oauth.expiresAt = Date.now() - 1; },
    run: (signal?: AbortSignal, args = {}) => tool.execute("fixture-call", args, signal, undefined, { agentId: "fixture-agent" }),
    async dispose() {
      await manager.dispose();
      for (const controller of streams) {
        try { controller.close(); } catch { /* Already closed by transport teardown. */ }
      }
    },
  };
}

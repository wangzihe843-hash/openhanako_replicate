import { createServer, request as httpRequest, type Server } from "node:http";
import { connect, createServer as createTcpServer, type AddressInfo, type Socket } from "node:net";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import * as sdk from "@larksuiteoapi/node-sdk";
import { normalizeNetworkProxyConfig } from "../shared/network-proxy.ts";

const config = vi.hoisted(() => ({ value: { mode: "direct" } as Record<string, string> }));
vi.mock("../lib/net/outbound-proxy.ts", () => ({ getOutboundProxyConfig: () => config.value }));
import { createFeishuTransport } from "../lib/bridge/feishu-transport.ts";

const cleanups: Array<() => void | Promise<void>> = [];
const logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {} };
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  config.value = { mode: "direct" };
});
async function listen(server: Server | ReturnType<typeof createTcpServer>) {
  const sockets = new Set<Socket>();
  server.on("connection", socket => { sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket)); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  cleanups.push(async () => { for (const s of sockets) s.destroy(); await new Promise<void>(r => server.close(() => r())); });
  return { port: (server.address() as AddressInfo).port, sockets };
}
function transport() {
  const value = createFeishuTransport(); cleanups.push(() => value.close()); return value;
}

describe("Feishu owned proxy transport with real SDK", () => {
  it("routes HTTP/WS per URL, preserves loopback noProxy and isolates adapter cancellation", async () => {
    let base = "";
    const server = createServer((req, res) => {
      req.resume(); res.setHeader("content-type", "application/json");
      if (req.url === "/callback/ws/endpoint") res.end(JSON.stringify({ code: 0, data: { URL: `${base.replace("http:", "ws:")}/?device_id=synthetic&service_id=1`, ClientConfig: { PingInterval: 60, ReconnectCount: 0, ReconnectInterval: 60, ReconnectNonce: 0 } } }));
      else res.end(JSON.stringify({ code: 0, data: "synthetic" }));
    });
    const target = await listen(server);
    base = `http://feishu.invalid:${target.port}`;
    const wss = new WebSocketServer({ server });
    cleanups.push(async () => { for (const ws of wss.clients) ws.terminate(); await new Promise<void>(r => wss.close(() => r())); });
    let httpCount = 0; let connectCount = 0;
    const httpProxy = createServer((req, res) => {
      const url = new URL(req.url!); expect(url.hostname).toBe("feishu.invalid"); httpCount++;
      const forward = httpRequest(`http://127.0.0.1:${target.port}${url.pathname}${url.search}`, { method: req.method, headers: req.headers, agent: false }, result => { res.writeHead(result.statusCode!, result.headers); result.pipe(res); });
      forward.on("error", () => res.destroy()); req.pipe(forward);
    });
    const hp = await listen(httpProxy);
    const wsProxy = createServer();
    wsProxy.on("connect", (req, socket, head) => {
      expect(req.url).toBe(`feishu.invalid:${target.port}`); connectCount++;
      const upstream = connect(target.port, "127.0.0.1");
      upstream.on("error", () => socket.destroy()); socket.on("error", () => upstream.destroy()); socket.on("close", () => upstream.destroy());
      upstream.once("connect", () => { socket.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket); });
    });
    const wp = await listen(wsProxy);
    config.value = { mode: "manual", httpProxy: `http://127.0.0.1:${hp.port}`, wsProxy: `http://127.0.0.1:${wp.port}`, noProxy: "" };
    const a = transport(); const b = transport();
    const first = new sdk.WSClient({ appId: "cli_0000000000000015", appSecret: "synthetic-secret", domain: base, httpInstance: a.httpInstance, agent: a.agent, logger, handshakeTimeoutMs: 500 });
    const second = new sdk.WSClient({ appId: "cli_0000000000000016", appSecret: "synthetic-secret", domain: base, httpInstance: b.httpInstance, agent: b.agent, logger, handshakeTimeoutMs: 500 });
    cleanups.push(() => { first.close({ force: true }); second.close({ force: true }); });
    await first.start({ eventDispatcher: new sdk.EventDispatcher({}).register({}) });
    await second.start({ eventDispatcher: new sdk.EventDispatcher({}).register({}) });
    await vi.waitFor(() => expect(wss.clients.size).toBe(2));
    expect(httpCount).toBe(2); expect(connectCount).toBe(2);
    first.close({ force: true }); a.close();
    await vi.waitFor(() => expect(wss.clients.size).toBe(1));
    await expect(b.httpInstance.get(`${base}/synthetic`)).resolves.toMatchObject({ code: 0 });
    expect(httpCount).toBe(3);
    await expect(b.httpInstance.get(`http://127.0.0.1:${target.port}/synthetic`)).resolves.toMatchObject({ code: 0 });
    expect(httpCount).toBe(3);
    expect(second.getConnectionStatus().state).toBe("connected");
    second.close({ force: true }); b.close();
    await vi.waitFor(() => { expect(wss.clients.size).toBe(0); expect(hp.sockets.size).toBe(0); expect(wp.sockets.size).toBe(0); expect(target.sockets.size).toBe(0); });
  });

  it("cancels an HTTP CONNECT handshake before the request gets a socket", async () => {
    let connects = 0;
    const proxy = createServer();
    proxy.on("connect", (_req, socket) => { connects++; socket.resume(); socket.on("end", () => socket.end()); });
    const p = await listen(proxy);
    config.value = { mode: "manual", httpsProxy: `http://127.0.0.1:${p.port}`, noProxy: "" };
    const t = transport();
    const pending = t.httpInstance.get("https://feishu.invalid/synthetic").catch(error => error);
    await vi.waitFor(() => expect(connects).toBe(1));
    t.close();
    expect(await pending).toBeInstanceOf(Error);
    await vi.waitFor(() => expect(p.sockets.size).toBe(0));
  });
});

describe("Feishu Worker transport seams", () => {
  it("closes every owned request and reports one fatal error at a hard deadline", async () => {
    let received = 0;
    const server = createServer(req => { req.resume(); received++; });
    const endpoint = await listen(server);
    const onFatal = vi.fn();
    const t = createFeishuTransport({ getProxyConfig: () => normalizeNetworkProxyConfig({ mode: "direct" }), onFatal });
    cleanups.push(() => t.close());
    const url = `http://127.0.0.1:${endpoint.port}/pending`;
    const first = t.httpInstance.get(url, { timeout: 100 }).catch(error => error);
    const second = t.httpInstance.get(url, { timeout: 1000 }).catch(error => error);
    await vi.waitFor(() => expect(received).toBe(2));
    expect(await first).toMatchObject({ code: "ETIMEDOUT" });
    expect(await second).toBeInstanceOf(Error);
    expect(onFatal).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(endpoint.sockets.size).toBe(0));
    expect(t.signal.aborted).toBe(true);
  });

  it("distinguishes a lost write response from a confirmed rejection and pre-dispatch cancellation", async () => {
    let received = 0;
    const server = createServer((req, res) => {
      req.resume();
      req.once("end", () => {
        received++;
        if (req.url!.includes("reject")) { res.writeHead(403); res.end('{"code":112,"error":{"log_id":"synthetic-log"}}'); }
        else req.socket.destroy();
      });
    });
    const endpoint = await listen(server);
    const base = `http://127.0.0.1:${endpoint.port}/open-apis/im/v1/messages`;
    const t = transport();
    const lost = await t.httpInstance.post(base, { content: "synthetic" }).catch(error => error);
    expect(lost.deliveryUnknown).toBe(true);
    const rejected = await t.httpInstance.post(`${base}/reject`, { content: "synthetic" }).catch(error => error);
    expect(rejected.deliveryUnknown).toBeUndefined();
    expect(rejected).toMatchObject({ status: 403, code: 112, log_id: "synthetic-log" });
    const controller = new AbortController(); controller.abort();
    const cancelled = await t.httpInstance.request({ method: "POST", url: base, signal: controller.signal } as sdk.HttpRequestOptions<unknown> & { signal: AbortSignal }).catch(error => error);
    expect(cancelled.name).toBe("AbortError");
    expect(cancelled.deliveryUnknown).toBeUndefined();
    expect(t.signal.aborted).toBe(false);
    expect(received).toBe(2);
  });

  it("reads the instance's latest effective proxy snapshot for each new request", async () => {
    const counts = [0, 0];
    const first = await listen(createServer((req, res) => { counts[0]++; req.resume(); res.setHeader("content-type", "application/json"); res.end('{"code":0}'); }));
    const second = await listen(createServer((req, res) => { counts[1]++; req.resume(); res.setHeader("content-type", "application/json"); res.end('{"code":0}'); }));
    let snapshot = normalizeNetworkProxyConfig({ mode: "manual", httpProxy: `http://127.0.0.1:${first.port}`, noProxy: "" });
    const t = createFeishuTransport({ getProxyConfig: () => snapshot });
    cleanups.push(() => t.close());
    await t.httpInstance.get("http://feishu.invalid/synthetic");
    snapshot = { ...snapshot, httpProxy: `http://127.0.0.1:${second.port}` };
    await t.httpInstance.get("http://feishu.invalid/synthetic");
    expect(counts).toEqual([1, 1]);
    t.close();
    await vi.waitFor(() => { expect(first.sockets.size).toBe(0); expect(second.sockets.size).toBe(0); });
  });
});

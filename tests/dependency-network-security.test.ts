import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { connect, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createAdaptorServer } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import WebSocket from "ws";
import { fetch } from "undici";
import { createOutboundProxyRuntime, fetchDispatcherForUrl, telegramBotOptions } from "../lib/net/outbound-proxy.ts";

const require = createRequire(import.meta.url);
const request = require("@cypress/request");
const servers: Server[] = [];
const sockets = new Set<Socket>();
const runtime = createOutboundProxyRuntime({ env: {}, log: () => {}, warn: () => {} });

async function listen(server: Server) {
  servers.push(server);
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as { port: number }).port;
}

afterEach(async () => {
  runtime.reset(); vi.unstubAllEnvs();
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

describe("network dependencies using isolated loopback endpoints", () => {
  it("enforces Hono's body limit on unknown-length streaming uploads", async () => {
    const app = new Hono();
    app.use("/upload", bodyLimit({ maxSize: 32 }));
    app.post("/upload", async c => c.text(await c.req.text()));
    const send = (size: number) => app.request("http://local.invalid/upload", {
      method: "POST", duplex: "half", body: new ReadableStream({ start(controller) {
        controller.enqueue(new Uint8Array(size).fill(97)); controller.close();
      } }),
    } as RequestInit);
    expect(await (await send(16)).text()).toBe("a".repeat(16));
    expect((await send(64)).status).toBe(413);
  });

  it("serves HTTP and upgrades WebSockets through the installed Hono adapter pair", async () => {
    const app = new Hono();
    const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
    app.get("/health", c => c.json({ ok: true }));
    app.get("/ws", upgradeWebSocket(() => ({ onMessage(event, ws) { ws.send(`echo:${event.data}`); } })));
    const server = createAdaptorServer({ fetch: app.fetch }) as Server;
    injectWebSocket(server);
    const port = await listen(server);
    expect(await (await fetch(`http://127.0.0.1:${port}/health`)).json()).toEqual({ ok: true });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    try {
      await once(ws, "open");
      const response = once(ws, "message"); ws.send("mock");
      expect(String((await response)[0])).toBe("echo:mock");
    } finally { ws.terminate(); }
  });

  it("keeps Undici redirects, response streams and aborts functional", async () => {
    const port = await listen(createServer((req, res) => {
      if (req.url === "/redirect") { res.writeHead(302, { Location: "/stream" }); res.end(); }
      else if (req.url === "/slow") { res.writeHead(200); res.write("first"); }
      else { res.writeHead(200); res.write("one"); setImmediate(() => res.end("two")); }
    }));
    const base = `http://127.0.0.1:${port}`;
    const response = await fetch(`${base}/redirect`);
    expect(response.redirected).toBe(true);
    expect(await response.text()).toBe("onetwo");
    const controller = new AbortController();
    const slow = await fetch(`${base}/slow`, { signal: controller.signal });
    const reader = slow.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
    const pending = reader.read(); controller.abort();
    await expect(pending).rejects.toThrow(/abort/i);
  });

  it("uses the configured Undici CONNECT proxy without external DNS or requests", async () => {
    const originPort = await listen(createServer((_req, res) => res.end("proxied")));
    const targets: string[] = [];
    const proxy = createServer();
    proxy.on("connect", (req, client, head) => {
      targets.push(req.url || "");
      const upstream = connect(originPort, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.pipe(client); client.pipe(upstream);
      });
      sockets.add(upstream); upstream.on("close", () => sockets.delete(upstream));
      upstream.on("error", () => client.destroy()); client.on("error", () => upstream.destroy());
    });
    const proxyPort = await listen(proxy);
    runtime.apply({ mode: "manual", httpProxy: `http://127.0.0.1:${proxyPort}` });
    const target = "http://service.invalid/test";
    const { dispatcher } = fetchDispatcherForUrl(target, {});
    expect(await (await fetch(target, { dispatcher })).text()).toBe("proxied");
    expect(targets).toEqual(["service.invalid:80"]);
  });

  it("preserves Telegram HTTP requests and bypasses the proxy after a loopback redirect", async () => {
    const originPort = await listen(createServer((_req, res) => res.end("local-control")));
    const targets: string[] = [];
    const proxyPort = await listen(createServer((req, res) => {
      targets.push(req.url || "");
      res.writeHead(302, { Location: `http://127.0.0.1:${originPort}/control` }); res.end();
    }));
    vi.stubEnv("http_proxy", "pac+ftp://untrusted.invalid/proxy.pac");
    runtime.apply({ mode: "manual", httpProxy: `http://127.0.0.1:${proxyPort}` });
    const options = telegramBotOptions({ request: { timeout: 2000 } }).request;
    const body = await new Promise((resolve, reject) => request({ ...options, url: "http://remote.invalid/start" }, (error: Error | null, _response: unknown, data: string) => error ? reject(error) : resolve(data)));
    expect(body).toBe("local-control");
    expect(targets).toEqual(["http://remote.invalid/start"]);
  });

  it("updates real requests from the same Telegram options across direct and proxy changes", async () => {
    const directPort = await listen(createServer((_req, res) => res.end("direct")));
    const firstPort = await listen(createServer((_req, res) => res.end("proxy-a")));
    const secondPort = await listen(createServer((_req, res) => res.end("proxy-b")));
    runtime.apply({ mode: "direct" });
    const options = telegramBotOptions({ request: { timeout: 2000 } }).request;
    const send = () => new Promise((resolve, reject) => request({
      ...options,
      url: `http://local-mock.invalid:${directPort}/control`,
      lookup: (_hostname, lookupOptions, callback) => lookupOptions.all
        ? callback(null, [{ address: "127.0.0.1", family: 4 }])
        : callback(null, "127.0.0.1", 4),
    }, (error: Error | null, _response: unknown, data: string) => error ? reject(error) : resolve(data)));
    expect(await send()).toBe("direct");
    runtime.apply({ mode: "manual", httpProxy: `http://127.0.0.1:${firstPort}` });
    expect(await send()).toBe("proxy-a");
    runtime.apply({ mode: "manual", httpProxy: `http://127.0.0.1:${secondPort}` });
    expect(await send()).toBe("proxy-b");
    runtime.apply({ mode: "direct" });
    expect(await send()).toBe("direct");
  });
});

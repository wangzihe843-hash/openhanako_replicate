import { createServer, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

// Only DNS is replaced; fetch, Agent, ProxyAgent and the CONNECT tunnel are real
// npm undici. Every socket terminates on our own isolated loopback listeners.
vi.mock("undici", async importOriginal => {
  const actual = await importOriginal<typeof import("undici")>();
  return { ...actual, Agent: class extends actual.Agent {
    constructor() { super({ connect: { lookup: (_host, options, callback) => {
      const done = callback as (error: Error | null, address: string | { address: string; family: number }[], family?: number) => void;
      if (options.all) done(null, [{ address: "127.0.0.1", family: 4 }]);
      else done(null, "127.0.0.1", 4);
    } } }); }
  } };
});
import { Api } from "node-telegram-bot-api";
import { telegramFetch, telegramApiOptions } from "../lib/net/telegram-fetch.ts";
import { createOutboundProxyRuntime } from "../lib/net/outbound-proxy.ts";

const servers: Server[] = [];
const sockets = new Set<Socket>();
const runtime = createOutboundProxyRuntime({ log() {}, warn() {} });
async function listen(server: Server) {
  servers.push(server);
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as { port: number }).port;
}
async function proxyTo(port: number) {
  const targets: string[] = [];
  const proxy = createServer();
  proxy.on("connect", (req, client, head) => {
    targets.push(req.url!);
    const upstream = connect(port, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client); client.pipe(upstream);
    });
    sockets.add(upstream); upstream.on("close", () => sockets.delete(upstream));
    upstream.on("error", () => client.destroy()); client.on("error", () => upstream.destroy());
  });
  return { port: await listen(proxy), targets };
}
afterEach(async () => {
  runtime.reset(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

describe("Telegram npm undici transport on isolated loopback", () => {
  it("retains one client through direct/manual/system/noProxy and hot proxy changes", async () => {
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("built-in fetch must not run"); }));
    const origin = async (name: string) => listen(createServer((_req, res) => res.end(JSON.stringify({ ok: true, result: { username: name } }))));
    const directPort = await origin("direct");
    const a = await proxyTo(await origin("proxy-a"));
    const b = await proxyTo(await origin("proxy-b"));
    const api = new Api("SYNTHETIC_ONLY", { ...telegramApiOptions(), apiRoot: `http://remote.invalid:${directPort}` });
    runtime.apply({ mode: "direct" });
    expect((await api.getMe()).username).toBe("direct");
    runtime.apply({ mode: "manual", httpProxy: `http://127.0.0.1:${a.port}` });
    expect((await api.getMe()).username).toBe("proxy-a");
    runtime.apply({ mode: "manual", httpProxy: `http://127.0.0.1:${b.port}` });
    expect((await api.getMe()).username).toBe("proxy-b");
    runtime.apply({ mode: "manual", httpProxy: `http://127.0.0.1:${a.port}`, noProxy: ".invalid" });
    expect((await api.getMe()).username).toBe("direct");
    vi.stubEnv("HTTP_PROXY", `http://127.0.0.1:${b.port}`);
    vi.stubEnv("http_proxy", `http://127.0.0.1:${b.port}`);
    vi.stubEnv("NO_PROXY", ""); vi.stubEnv("no_proxy", "");
    runtime.apply({ mode: "system" });
    expect((await api.getMe()).username).toBe("proxy-b");
    runtime.apply({ mode: "direct" });
    expect((await api.getMe()).username).toBe("direct");
    expect(a.targets).toEqual([`remote.invalid:${directPort}`]);
    expect(b.targets.length).toBeGreaterThanOrEqual(1);
  });
  it.each([301, 302, 303, 307, 308])("refuses %d redirects before forwarding credential path or body", async status => {
    let leaked = 0;
    const destination = await listen(createServer((_req, res) => { leaked++; res.end("unexpected"); }));
    let sourceHits = 0;
    const source = await listen(createServer((_req, res) => {
      sourceHits++; res.writeHead(status, { Location: `http://127.0.0.1:${destination}/steal` }); res.end();
    }));
    const api = new Api("SYNTHETIC_ONLY", { ...telegramApiOptions(), apiRoot: `http://127.0.0.1:${source}` });
    await expect(api.sendMessage({ chat_id: 1, text: "synthetic body" })).rejects.toThrow("Network request failed");
    expect(sourceHits).toBe(1);
    expect(leaked).toBe(0);
    await expect(telegramFetch(`http://127.0.0.1:${source}/file/botSYNTHETIC_ONLY/a`)).rejects.toThrow("redirect refused");
    expect(leaked).toBe(0);
  });
  it("cancels both pending headers and streaming response bodies", async () => {
    let arrived = false;
    const port = await listen(createServer((req, res) => {
      arrived = true;
      if (req.url === "/body") { res.writeHead(200); res.write("first"); }
    }));
    const headers = new AbortController();
    const request = telegramFetch(`http://127.0.0.1:${port}/headers`, { signal: headers.signal }).catch(e => e);
    await vi.waitFor(() => expect(arrived).toBe(true)); headers.abort();
    expect(await request).toBeInstanceOf(Error);
    const body = new AbortController();
    const response = await telegramFetch(`http://127.0.0.1:${port}/body`, { signal: body.signal });
    const reader = response.body!.getReader();
    await reader.read();
    const read = reader.read().catch(e => e); body.abort();
    expect(await read).toBeInstanceOf(Error);
  });
});

// Real installed SDK + loopback HTTP/WS. Only domain/cache/config seams are
// redirected; production serialization, agents and cancellation remain active.
import { createServer, globalAgent, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import * as sdk from "@larksuiteoapi/node-sdk";

const state = vi.hoisted(() => ({ base: "", clients: [] as sdk.WSClient[], dispatchers: [] as sdk.EventDispatcher[], caches: [] as Array<{ cache: sdk.DefaultCache; appId: string }>, afterDiscovery: null as null | (() => void) }));
vi.mock("../lib/net/outbound-proxy.ts", () => ({ getOutboundProxyConfig: () => ({ mode: "direct" }) }));
vi.mock("../lib/bridge/optional-sdks.ts", async () => {
  const actual = await vi.importActual<typeof import("@larksuiteoapi/node-sdk")>("@larksuiteoapi/node-sdk");
  class Client extends actual.Client {
    constructor(options: ConstructorParameters<typeof actual.Client>[0]) {
      const cache = new actual.DefaultCache();
      super({ ...options, domain: state.base, cache });
      state.caches.push({ cache, appId: options.appId });
    }
  }
  class WSClient extends actual.WSClient {
    constructor(options: ConstructorParameters<typeof actual.WSClient>[0]) {
      super({ ...options, domain: state.base, httpInstance: {
        ...options.httpInstance,
        request: async (request: sdk.HttpRequestOptions<unknown>) => {
          const result = await options.httpInstance.request(request);
          if (request.url.endsWith("/callback/ws/endpoint")) state.afterDiscovery?.();
          return result;
        },
      } });
      state.clients.push(this);
    }
  }
  class EventDispatcher extends actual.EventDispatcher {
    constructor(options: ConstructorParameters<typeof actual.EventDispatcher>[0]) { super(options); state.dispatchers.push(this); }
  }
  return { loadFeishuSdk: () => ({ ...actual, Client, WSClient, EventDispatcher }) };
});
import { createFeishuAdapter } from "../lib/bridge/feishu-adapter.ts";
import { createFeishuTransport } from "../lib/bridge/feishu-transport.ts";

const cleanups: Array<() => Promise<void> | void> = [];
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  state.clients.length = 0; state.dispatchers.length = 0;
  state.caches.length = 0;
  state.afterDiscovery = null;
});

type Mode = "endpoint" | "handshake" | "token" | "message" | "upload" | "resource" | "contact" | "card" | "ready";
async function harness(mode: Mode = "ready") {
  const sockets = new Set<Socket>();
  const requests: Array<{ url: string; method: string; body: string; response: ServerResponse }> = [];
  const incoming: unknown[] = [];
  const statuses: unknown[][] = [];
  let upgrades = 0;
  let messageAborted = false;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      const url = request.url!;
      requests.push({ url, method: request.method!, body: Buffer.concat(chunks).toString(), response });
      response.setHeader("content-type", "application/json");
      if (url === "/callback/ws/endpoint") { if (mode !== "endpoint") releaseEndpoint(response); return; }
      if (url.includes("tenant_access_token/internal")) {
        if (mode !== "token") response.end(JSON.stringify({ code: 0, tenant_access_token: "synthetic-token", expire: 7200 })); return;
      }
      if (url.includes("/resources/")) {
        response.setHeader("content-type", "application/octet-stream");
        response.write("synthetic-resource");
        if (mode !== "resource") response.end(); return;
      }
      if (url.includes("/contact/v3/users/")) {
        if (mode !== "contact") response.end(JSON.stringify({ code: 0, data: { user: { name: "Synthetic" } } })); return;
      }
      if (url.includes("/cardkit/v1/cards")) {
        if (mode !== "card") response.end(JSON.stringify({ code: 0, data: { card_id: "synthetic-card" } })); return;
      }
      if (url.startsWith("/open-apis/im/v1/messages")) {
        response.on("close", () => { messageAborted = true; });
        if (mode !== "message") response.end(JSON.stringify({ code: 0, data: { message_id: "synthetic-message" } })); return;
      }
      if (/\/im\/v1\/(images|files)/.test(url)) {
        if (mode !== "upload") response.end(JSON.stringify({ code: 0, data: { image_key: "synthetic-image", file_key: "synthetic-file" } })); return;
      }
      response.statusCode = 404; response.end("{}");
    });
  });
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    upgrades++;
    if (mode !== "handshake") wss.handleUpgrade(request, socket, head, client => wss.emit("connection", client, request));
    else { socket.on("end", () => socket.end()); socket.resume(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.base = base;
  function releaseEndpoint(response: ServerResponse) {
    response.end(JSON.stringify({ code: 0, data: { URL: `${base.replace("http:", "ws:")}/?device_id=synthetic&service_id=1`, ClientConfig: { PingInterval: 60, ReconnectCount: 3, ReconnectInterval: 0.02, ReconnectNonce: 0 } } }));
  }
  const adapter = createFeishuAdapter({ appId: `cli_${Math.floor(Math.random() * 1e12).toString(16).padStart(16, "0")}`, appSecret: "synthetic-secret", agentId: "synthetic-agent", onMessage: (message: unknown) => incoming.push(message), onStatus: (...args: unknown[]) => statuses.push(args) });
  cleanups.push(async () => {
    adapter.stop();
    for (const socket of wss.clients) socket.terminate();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await new Promise<void>(resolve => wss.close(() => resolve()));
  });
  const endpoints = () => requests.filter(r => r.url === "/callback/ws/endpoint");
  const messages = () => requests.filter(r => r.url.startsWith("/open-apis/im/v1/messages") && !r.url.includes("/resources/"));
  return { adapter, base, requests, endpoints, messages, incoming, statuses, releaseEndpoint, wss, sockets, upgrades: () => upgrades, messageAborted: () => messageAborted, client: state.clients.at(-1), dispatcher: state.dispatchers.at(-1) };
}

describe("frozen U15 actual-adapter release gates", () => {
  it("must not create a WS handshake when endpoint discovery completes after stop", async () => {
    const h = await harness("endpoint");
    await vi.waitFor(() => expect(h.endpoints()).toHaveLength(1));
    h.adapter.stop(); h.releaseEndpoint(h.endpoints()[0].response); await pause(250);
    expect(h.upgrades()).toBe(0);
    expect(h.sockets.size).toBe(0);
  });

  it("must cancel an HTTP send waiting for response when the adapter stops", async () => {
    const h = await harness("message");
    await vi.waitFor(() => expect(h.upgrades()).toBe(1));
    let settled = false;
    const sent = h.adapter.sendReply("synthetic-chat", "synthetic-message").then(() => null, error => error).finally(() => { settled = true; });
    await vi.waitFor(() => expect(h.messages()).toHaveLength(1));
    h.adapter.stop(); await pause(250);
    expect(h.messageAborted()).toBe(true);
    expect(settled).toBe(true);
    expect(await sent).toBeInstanceOf(Error);
    expect(h.sockets.size).toBe(0);
  });
});

describe("real SDK adapter cancellation and generations", () => {
  it("rejects a late handshake even when discovery already resolved at stop", async () => {
    const h = await harness("endpoint");
    await vi.waitFor(() => expect(h.endpoints()).toHaveLength(1));
    state.afterDiscovery = () => h.adapter.stop();
    h.releaseEndpoint(h.endpoints()[0].response);
    await pause(250);
    expect(h.upgrades()).toBe(0);
    expect(h.sockets.size).toBe(0);
    expect(h.statuses).toHaveLength(0);
  });

  it("closes a handshake that never returns open/error", async () => {
    const h = await harness("handshake");
    await vi.waitFor(() => expect(h.upgrades()).toBe(1));
    h.adapter.stop();
    await vi.waitFor(() => expect(h.sockets.size).toBe(0));
    expect(h.incoming).toHaveLength(0);
  });

  it("stops pending token acquisition before any message is submitted", async () => {
    const h = await harness("token");
    const result = h.adapter.sendReply("synthetic-chat", "hello").catch(error => error);
    await vi.waitFor(() => expect(h.requests.some(r => r.url.includes("tenant_access_token"))).toBe(true));
    h.adapter.stop();
    expect(await result).toBeInstanceOf(Error);
    expect(h.messages()).toHaveLength(0);
    await vi.waitFor(() => expect(h.sockets.size).toBe(0));
  });

  it.each(["upload", "card"] as const)("stops pending %s before follow-up IM submission", async mode => {
    const h = await harness(mode);
    const result = (mode === "upload"
      ? h.adapter.sendMediaBuffer("synthetic-chat", Buffer.from("synthetic-image"), { mime: "image/png" })
      : h.adapter.startRichStreamReply("synthetic-chat", "hello")).catch(error => error);
    await vi.waitFor(() => expect(h.requests.some(r => r.url.includes(mode === "upload" ? "/images" : "/cardkit/"))).toBe(true));
    h.adapter.stop();
    expect(await result).toBeInstanceOf(Error);
    expect(h.messages()).toHaveLength(0);
    await vi.waitFor(() => expect(h.sockets.size).toBe(0));
  });

  it("cancels a resource body after headers and SDK stream wrapping", async () => {
    const h = await harness("resource");
    const result = h.adapter.downloadFile("synthetic-message", "synthetic-file").catch(error => error);
    await vi.waitFor(() => expect(h.requests.some(r => r.url.includes("/resources/"))).toBe(true));
    await pause(30); h.adapter.stop();
    expect(await result).toBeInstanceOf(Error);
    await vi.waitFor(() => expect(h.sockets.size).toBe(0));
  });

  it("keeps rapid stop/new-start isolated from old discovery and user-info callbacks", async () => {
    const old = await harness("endpoint");
    await vi.waitFor(() => expect(old.endpoints()).toHaveLength(1));
    old.adapter.stop();
    const next = await harness("contact");
    await vi.waitFor(() => expect(next.upgrades()).toBe(1));
    old.releaseEndpoint(old.endpoints()[0].response);
    const event = {
      schema: "2.0", header: { event_type: "im.message.receive_v1", event_id: "synthetic-event" },
      event: {
        message: { message_type: "text", chat_id: "synthetic-chat", message_id: "synthetic-message", content: '{"text":"hello"}', chat_type: "p2p" },
        sender: { sender_type: "user", sender_id: { open_id: "synthetic-user" } },
      },
    };
    const pending = next.dispatcher.invoke(event);
    await vi.waitFor(() => expect(next.requests.some(r => r.url.includes("/contact/"))).toBe(true));
    next.adapter.stop(); await pending;
    await old.dispatcher.invoke(event);
    expect(old.upgrades()).toBe(0);
    expect(old.incoming).toHaveLength(0); expect(next.incoming).toHaveLength(0);
    await vi.waitFor(() => { expect(old.sockets.size).toBe(0); expect(next.sockets.size).toBe(0); });
  });

  it("uses SDK reconnection and clears its socket/timers on stop", async () => {
    const h = await harness();
    await vi.waitFor(() => expect(h.client.getConnectionStatus().state).toBe("connected"));
    for (const ws of h.wss.clients) ws.terminate();
    await vi.waitFor(() => expect(h.upgrades()).toBe(2));
    expect(h.endpoints()).toHaveLength(2);
    h.adapter.stop();
    await vi.waitFor(() => expect(h.sockets.size).toBe(0));
    const upgrades = h.upgrades(); await pause(100);
    expect(h.upgrades()).toBe(upgrades);
  });

  it("enforces an HTTP deadline without changing SDK defaults/interceptors or other instances", async () => {
    const h = await harness("message");
    const defaults = { ...sdk.defaultHttpInstance.defaults };
    const interceptors = sdk.defaultHttpInstance.interceptors as unknown as { request: { handlers: unknown[] }; response: { handlers: unknown[] } };
    const requestInterceptors = [...interceptors.request.handlers];
    const responseInterceptors = [...interceptors.response.handlers];
    const globalMaxSockets = globalAgent.maxSockets;
    const a = createFeishuTransport(); const b = createFeishuTransport();
    cleanups.push(() => { a.close(); b.close(); });
    const pending = a.httpInstance.get(`${h.base}/open-apis/im/v1/messages`, { timeout: 80 }).catch(error => error);
    const error = await pending;
    expect(error.code === "ETIMEDOUT" || error.code === "ECONNABORTED").toBe(true);
    a.close();
    await expect(b.httpInstance.post(`${h.base}/open-apis/auth/v3/tenant_access_token/internal`, {})).resolves.toMatchObject({ code: 0 });
    expect(sdk.defaultHttpInstance.defaults).toEqual(defaults);
    expect(interceptors.request.handlers).toEqual(requestInterceptors);
    expect(interceptors.response.handlers).toEqual(responseInterceptors);
    expect(globalAgent.maxSockets).toBe(globalMaxSockets);
  });

  it("preserves token refresh, PATCH/PUT, CardKit reference/sequence, media fields and resource streams", async () => {
    const h = await harness();
    await h.adapter.sendReply("synthetic-chat", "hello");
    await h.adapter.sendReply("synthetic-chat", "again");
    expect(h.requests.filter(r => r.url.includes("tenant_access_token"))).toHaveLength(1);
    const { cache, appId } = state.caches.at(-1);
    await cache.set(sdk.CTenantAccessToken, "expired-synthetic", Date.now() - 1, { namespace: appId });
    const text = await h.adapter.startStreamReply("synthetic-chat", "text");
    expect(h.requests.filter(r => r.url.includes("tenant_access_token"))).toHaveLength(2);
    await h.adapter.updateStreamReply("synthetic-chat", text, "updated");
    const table = "| Name | Status |\n| --- | --- |\n| Synthetic | ready |";
    const card = await h.adapter.startStreamReply("synthetic-chat", table);
    await h.adapter.updateStreamReply("synthetic-chat", card, table + "\nupdated");
    const updates = h.messages().filter(r => r.method === "PUT" || r.method === "PATCH");
    expect(updates.map(r => r.method)).toEqual(["PUT", "PATCH"]);
    expect(JSON.parse(updates[0].body).msg_type).toBe("post");
    expect(Object.keys(JSON.parse(updates[1].body))).toEqual(["content"]);
    const rich = await h.adapter.startRichStreamReply("synthetic-chat", "rich");
    await h.adapter.finishRichStreamReply("synthetic-chat", rich, "finished");
    const reference = h.messages().map(r => JSON.parse(r.body)).find(r => JSON.parse(r.content).type === "card");
    expect(JSON.parse(reference.content)).toEqual({ type: "card", data: { card_id: "synthetic-card" } });
    expect(h.requests.filter(r => r.url.includes("/cardkit/") && r.method !== "POST").map(r => JSON.parse(r.body).sequence)).toEqual([2, 3, 4]);
    for (const [filename, mime, expected] of [["synthetic.png", "image/png", "image"], ["synthetic.pdf", "application/pdf", "file"], ["synthetic.mp4", "video/mp4", "media"], ["synthetic.opus", "audio/opus", "audio"]]) {
      await h.adapter.sendMediaBuffer("synthetic-chat", Buffer.from("synthetic-media"), { filename, mime });
      expect(JSON.parse(h.messages().at(-1)!.body).msg_type).toBe(expected);
    }
    const uploads = h.requests.filter(r => /\/im\/v1\/(images|files)/.test(r.url));
    expect(uploads).toHaveLength(4);
    expect(uploads[0].body).toContain('name="image_type"');
    for (const [index, fileType] of [[1, "pdf"], [2, "mp4"], [3, "opus"]] as const) expect(uploads[index].body).toContain(`\r\n\r\n${fileType}\r\n`);
    expect(await h.adapter.downloadFile("synthetic-message", "synthetic-file")).toEqual(Buffer.from("synthetic-resource"));
    h.adapter.stop();
    await vi.waitFor(() => expect(h.sockets.size).toBe(0));
  });
});

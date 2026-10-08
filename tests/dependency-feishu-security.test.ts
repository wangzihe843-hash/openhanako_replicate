import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { AxiosInstance } from "axios";
import { loadFeishuSdk } from "../lib/bridge/optional-sdks.ts";

const sdk = loadFeishuSdk();
const servers: Server[] = [];
const sockets = new Set<Socket>();
const wsClients: InstanceType<typeof sdk.WSClient>[] = [];
const wsServers: WebSocketServer[] = [];
const httpInstance = sdk.defaultHttpInstance as unknown as AxiosInstance;
const defaults = httpInstance.defaults;
const requestInterceptors = httpInstance.interceptors.request;
const interceptors: number[] = [];
let originalProxy: typeof defaults.proxy;

async function listen(server: Server) {
  servers.push(server);
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

beforeEach(() => { originalProxy = defaults.proxy; defaults.proxy = false; });
afterEach(async () => {
  for (const client of wsClients.splice(0)) client.close({ force: true });
  for (const server of wsServers.splice(0)) {
    for (const client of server.clients) client.terminate();
    server.close();
  }
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  defaults.proxy = originalProxy;
  for (const interceptor of interceptors.splice(0)) requestInterceptors.eject(interceptor);
});

describe("real Feishu SDK with isolated mock services", () => {
  it("authenticates and sends text, image and file payloads through its installed Axios", async () => {
    const requests: { url: string; body: string; authorization?: string; contentType?: string }[] = [];
    let failMessages = false;
    const base = await listen(createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      requests.push({ url: req.url!, body: Buffer.concat(chunks).toString(), authorization: req.headers.authorization, contentType: req.headers["content-type"] });
      res.setHeader("Content-Type", "application/json");
      if (req.url?.includes("tenant_access_token/internal")) {
        res.end(JSON.stringify({ code: 0, tenant_access_token: "isolated-token", expire: 7200 }));
      } else if (req.url?.startsWith("/open-apis/im/v1/messages")) {
        res.statusCode = failMessages ? 503 : 200;
        res.end(JSON.stringify({ code: failMessages ? 503 : 0, data: { message_id: "mock-message" } }));
      } else if (req.url === "/open-apis/im/v1/images") {
        res.end(JSON.stringify({ code: 0, data: { image_key: "mock-image" } }));
      } else if (req.url === "/open-apis/im/v1/files") {
        res.end(JSON.stringify({ code: 0, data: { file_key: "mock-file" } }));
      } else { res.statusCode = 404; res.end("{}"); }
    }));
    // SDK path-template expansion treats a domain's :port as a path parameter.
    // Route a port-free fake domain to loopback before Axios opens any connection.
    interceptors.push(requestInterceptors.use(config => {
      const url = new URL(config.url);
      if (url.hostname !== "feishu.mock.invalid") throw new Error("Unexpected mock SDK destination");
      config.url = `${base}${url.pathname}${url.search}`;
      return config;
    }));
    const client = new sdk.Client({ appId: "cli_0000000000000001", appSecret: "isolated-fake-secret", domain: "http://feishu.mock.invalid", loggerLevel: sdk.LoggerLevel.error });
    const message = { params: { receive_id_type: "chat_id" as const }, data: { receive_id: "mock-chat", msg_type: "text", content: JSON.stringify({ text: "hello mock" }) } };
    expect((await client.im.message.create(message)).data?.message_id).toBe("mock-message");
    expect((await client.im.image.create({ data: { image_type: "message", image: Buffer.from("isolated-image-content") } }))?.image_key).toBe("mock-image");
    expect((await client.im.file.create({ data: { file_type: "stream", file_name: "mock.txt", file: Buffer.from("isolated-file-content") } }))?.file_key).toBe("mock-file");
    expect(requests.filter(req => req.url.includes("tenant_access_token"))).toHaveLength(1);
    expect(JSON.parse(requests[0].body)).toMatchObject({ app_id: "cli_0000000000000001", app_secret: "isolated-fake-secret" });
    expect(requests.slice(1).every(req => req.authorization === "Bearer isolated-token")).toBe(true);
    expect(JSON.parse(requests[1].body)).toMatchObject(message.data);
    expect(requests[1].url).toContain("receive_id_type=chat_id");
    expect(requests[2].contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(requests[2].body).toContain("isolated-image-content");
    expect(requests[3].body).toContain("isolated-file-content");
    expect(requests[3].body).toContain("mock.txt");
    failMessages = true;
    await expect(client.im.message.create(message)).rejects.toMatchObject({ response: { status: 503 } });
  });

  it("opens and closes a real WSClient with the state shape used by the adapter", async () => {
    let wsUrl = "";
    const endpointBodies: unknown[] = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      endpointBodies.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ code: 0, data: { URL: wsUrl, ClientConfig: { PingInterval: 60, ReconnectCount: 0, ReconnectInterval: 60, ReconnectNonce: 0 } } }));
    });
    const base = await listen(server);
    wsUrl = `${base.replace("http:", "ws:")}/socket?device_id=mock-device&service_id=1`;
    const wss = new WebSocketServer({ server, path: "/socket" }); wsServers.push(wss);
    const client = new sdk.WSClient({ appId: "cli_0000000000000002", appSecret: "isolated-fake-secret", domain: base, autoReconnect: false, loggerLevel: sdk.LoggerLevel.error });
    wsClients.push(client);
    await client.start({ eventDispatcher: new sdk.EventDispatcher({}).register({}) });
    const adapterState = client as unknown as { wsConfig: { wsInstance: { readyState: number } | null } };
    await vi.waitFor(() => expect(adapterState.wsConfig.wsInstance?.readyState).toBe(1));
    expect(endpointBodies).toEqual([expect.objectContaining({ AppID: "cli_0000000000000002", AppSecret: "isolated-fake-secret" })]);
    client.close({ force: true });
    expect(adapterState.wsConfig.wsInstance).toBeNull();
  });
});

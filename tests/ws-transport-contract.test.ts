import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { connect, type Socket } from "node:net";
import WebSocket, { Receiver, Sender, WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOutboundProxyRuntime, webSocketOptionsForUrl } from "../lib/net/outbound-proxy.ts";
import { createDingTalkAdapter, DINGTALK_BOT_CALLBACK_TOPIC } from "../lib/bridge/dingtalk-adapter.ts";

// Real transport contracts: only loopback listeners and synthetic credentials.
const servers: Server[] = [];
const wsServers: WebSocketServer[] = [];
const webSockets = new Set<WebSocket>();
const sockets = new Set<Socket>();
const adapters: ReturnType<typeof createDingTalkAdapter>[] = [];
const runtime = createOutboundProxyRuntime({ env: {}, log: () => {}, warn: () => {} });

async function listen(server: Server) {
  servers.push(server);
  server.on("connection", socket => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as { port: number }).port;
}

function track(socket: WebSocket) {
  webSockets.add(socket);
  // Expected protocol failures still need an error listener during cleanup.
  socket.on("error", () => {});
  return socket;
}

function closed(socket: WebSocket): Promise<number> {
  return new Promise(resolve => socket.once("close", code => resolve(code)));
}

async function endpoint(options = {}) {
  const server = createServer();
  const wss = new WebSocketServer({ server, ...options });
  wsServers.push(wss);
  wss.on("connection", track);
  const port = await listen(server);
  return { wss, url: `ws://127.0.0.1:${port}/socket`, port };
}

async function pair(serverOptions = {}, clientOptions = {}) {
  const { wss, url } = await endpoint(serverOptions);
  const connection = once(wss, "connection");
  const client = track(new WebSocket(url, clientOptions));
  await once(client, "open");
  const [peer] = await connection;
  return { client, peer: peer as WebSocket };
}

afterEach(async () => {
  adapters.splice(0).forEach(adapter => adapter.stop());
  await Promise.all([...webSockets].map(async socket => {
    if (socket.readyState === WebSocket.CLOSED) return;
    const done = closed(socket); socket.terminate(); await done;
  }));
  webSockets.clear();
  for (const socket of sockets) socket.destroy();
  await Promise.all(wsServers.splice(0).map(wss => new Promise<void>(resolve => wss.close(() => resolve()))));
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  runtime.reset();
});

describe("installed ws transport contracts", () => {
  it("resolves one ws from every installed consumer and loads optional realtime exports offline", async () => {
    const require = createRequire(import.meta.url);
    for (const consumer of ["@hono/node-ws", "@larksuiteoapi/node-sdk", "@google/genai", "openai"]) {
      expect(createRequire(require.resolve(consumer)).resolve("ws")).toBe(require.resolve("ws"));
    }
    expect(typeof (await import("@google/genai")).GoogleGenAI).toBe("function");
    expect(typeof (await import("openai/realtime/ws")).OpenAIRealtimeWS).toBe("function");
  });

  it("keeps both constructor forms and the protocols option interoperable", async () => {
    const { wss, url } = await endpoint();
    for (const make of [
      () => new WebSocket(url, ["hana-v1"]),
      () => new WebSocket(url, { protocols: ["hana-v1"] }),
      () => new WebSocket(url, undefined, { protocols: "hana-v1" }),
    ]) {
      const connection = once(wss, "connection");
      const client = track(make()); await once(client, "open");
      const [peer] = await connection;
      expect(client.protocol).toBe("hana-v1"); expect(peer.protocol).toBe("hana-v1");
      const done = closed(client); client.close(1000); expect(await done).toBe(1000);
    }
  });

  it.each([false, true])("preserves fragmented text, binary data and ping/pong with compression=%s", async compression => {
    const { client, peer } = await pair({ perMessageDeflate: compression });
    expect(Boolean(client.extensions)).toBe(compression);
    const text = "汉🙂".repeat(200_000);
    const textMessage = once(peer, "message");
    client.send(text.slice(0, 300_000), { fin: false }); client.send(text.slice(300_000));
    const [raw, binary] = await textMessage;
    expect(String(raw)).toBe(text); expect(binary).toBe(false);
    const bytes = Buffer.from(Array.from({ length: 131_072 }, (_, i) => i % 256));
    const binaryMessage = once(client, "message"); peer.send(bytes);
    const [received, isBinary] = await binaryMessage;
    expect(received).toEqual(bytes); expect(isBinary).toBe(true);
    const pong = once(peer, "pong"); peer.ping("synthetic-heartbeat");
    expect(String((await pong)[0])).toBe("synthetic-heartbeat");
  });

  it("rejects an incompatible compression window offer before accepting a connection", async () => {
    const { url, wss } = await endpoint({ perMessageDeflate: { clientMaxWindowBits: 15 } });
    const accepted = vi.fn(); wss.on("connection", accepted);
    const client = track(new WebSocket(url, { perMessageDeflate: { clientMaxWindowBits: 9 } }));
    const error = once(client, "error"); const done = closed(client);
    expect((await error)[0].message).toContain("Unexpected server response: 400");
    expect(await done).toBe(1006); expect(accepted).not.toHaveBeenCalled();
  });

  it.each([false, true])("enforces decompressed message bytes at the payload boundary, compression=%s", async compression => {
    const { client, peer } = await pair({ maxPayload: 64, perMessageDeflate: compression });
    const message = once(peer, "message"); client.send("a".repeat(64));
    expect(String((await message)[0])).toHaveLength(64);
    const error = once(peer, "error"); const done = closed(client);
    client.send("a".repeat(65));
    expect((await error)[0]).toMatchObject({ code: "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH" });
    expect(await done).toBe(1009);
  });

  it("accepts the default fragment boundary and counts empty fragments beyond it", async () => {
    const { client, peer } = await pair();
    const message = once(peer, "message");
    for (let i = 1; i < 16_384; i++) client.send("", { fin: false });
    client.send("complete"); expect(String((await message)[0])).toBe("complete");
    const error = once(peer, "error"); const done = closed(client);
    for (let i = 0; i < 16_385; i++) client.send("", { fin: false });
    expect((await error)[0]).toMatchObject({ code: "WS_ERR_TOO_MANY_BUFFERED_PARTS" });
    expect(await done).toBe(1008);
  });

  it.each([false, true])("counts empty fragments in compressed and plain messages, compression=%s", async compression => {
    const { client, peer } = await pair({ maxFragments: 2, perMessageDeflate: compression });
    const error = once(peer, "error"); const done = closed(client);
    client.send("", { fin: false }); client.send("", { fin: false }); client.send("tail");
    expect((await error)[0]).toMatchObject({ code: "WS_ERR_TOO_MANY_BUFFERED_PARTS" });
    expect(await done).toBe(1008);
  });

  it("bounds buffered partial-frame chunks independently of payload bytes", async () => {
    const receiver = new Receiver({ maxBufferedChunks: 2, maxPayload: 16 });
    const error = once(receiver, "error");
    receiver.write(Buffer.from([0x82, 16]));
    receiver.write(Buffer.from([1])); receiver.write(Buffer.from([2])); receiver.write(Buffer.from([3]));
    expect((await error)[0]).toMatchObject({ code: "WS_ERR_TOO_MANY_BUFFERED_PARTS" });
    receiver.destroy();
  });

  it.each(["code", "reason"])("keeps OPEN after invalid close %s and then closes cleanly", async invalid => {
    const { client, peer } = await pair();
    expect(() => invalid === "code" ? client.close(1006) : client.close(1000, "x".repeat(124))).toThrow();
    expect(client.readyState).toBe(WebSocket.OPEN);
    const message = once(peer, "message"); client.send("still usable");
    expect(String((await message)[0])).toBe("still usable");
    const done = closed(client); client.close(1000, "complete");
    const error = await new Promise<Error | undefined>(resolve => client.send("too late", resolve));
    expect(error?.message).toContain("not open"); expect(await done).toBe(1000);
  });

  it.each(["unmasked", "close-code"])("rejects an invalid wire %s frame with protocol close", async invalid => {
    const { client, peer } = await pair();
    const error = once(peer, "error"); const done = closed(client);
    // Public Sender.frame creates the otherwise invalid frame; only the wire is injected.
    const payload = invalid === "close-code" ? Buffer.from([0x03, 0xee]) : Buffer.from("bad mask");
    const frames = Sender.frame(payload, { fin: true, opcode: invalid === "close-code" ? 8 : 1, mask: invalid !== "unmasked", readOnly: true });
    for (const frame of frames) client._socket.write(frame);
    expect((await error)[0].code).toBe(invalid === "unmasked" ? "WS_ERR_EXPECTED_MASK" : "WS_ERR_INVALID_CLOSE_CODE");
    expect(await done).toBe(1002);
  });

  it.each(["timeout", "cancel"])("reclaims an unfinished HTTP Upgrade after %s", async action => {
    const server = createServer();
    const upgraded = new Promise<void>(resolve => server.once("upgrade", (_request, socket) => {
      // Consume the peer's FIN even though this fixture deliberately never replies.
      socket.resume(); socket.on("end", () => socket.end()); resolve();
    }));
    const port = await listen(server);
    const client = track(new WebSocket(`ws://127.0.0.1:${port}`, { handshakeTimeout: 100 }));
    const error = once(client, "error"); const done = closed(client);
    await upgraded; if (action === "cancel") client.terminate();
    expect((await error)[0].message).toMatch(action === "cancel" ? /closed before/ : /timed out/);
    expect(await done).toBe(1006); expect(client.readyState).toBe(WebSocket.CLOSED);
    await vi.waitFor(() => expect(sockets.size).toBe(0));
  });

  it("upgrades through the configured HTTP proxy without resolving the synthetic destination", async () => {
    const { port, wss } = await endpoint();
    const requests: string[] = [];
    const proxy = createServer();
    proxy.on("connect", (request, downstream, head) => {
      requests.push(request.url!);
      const upstream = connect(port, "127.0.0.1", () => {
        downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.pipe(downstream); downstream.pipe(upstream);
      });
      sockets.add(upstream); upstream.once("close", () => sockets.delete(upstream));
      upstream.on("error", () => downstream.destroy()); downstream.on("error", () => upstream.destroy());
    });
    const proxyPort = await listen(proxy);
    runtime.apply({ mode: "manual", httpProxy: `http://127.0.0.1:${proxyPort}` });
    const target = "ws://ws.synthetic.invalid/socket";
    const connection = once(wss, "connection");
    const client = track(new WebSocket(target, { ...webSocketOptionsForUrl(target), handshakeTimeout: 1000 }));
    await once(client, "open"); const [peer] = await connection;
    const message = once(client, "message"); peer.send("through proxy");
    expect(String((await message)[0])).toBe("through proxy");
    expect(requests).toEqual(["ws.synthetic.invalid:80"]);
  });

  it("preserves DingTalk application ACK, control pong, reconnect and stop on real sockets", async () => {
    const { url, wss } = await endpoint();
    runtime.apply({ mode: "direct" });
    const onMessage = vi.fn(); const onStatus = vi.fn();
    const fetchImpl = vi.fn(async () => Response.json({ endpoint: url, ticket: "synthetic-ticket" }));
    const connection = once(wss, "connection");
    const adapter = createDingTalkAdapter({ corpId: "synthetic-corp", clientId: "synthetic-app", clientSecret: "synthetic-secret", robotCode: "synthetic-robot", agentId: "synthetic-agent", onMessage, onStatus, fetchImpl, reconnectDelayMs: 25 });
    adapters.push(adapter);
    const [peer] = await connection;
    await vi.waitFor(() => expect(onStatus).toHaveBeenLastCalledWith("connected"));
    const ack = once(peer, "message");
    peer.send(JSON.stringify({ type: "SYSTEM", headers: { topic: "ping", messageId: "synthetic-ping" }, data: JSON.stringify({ opaque: { value: 7 } }) }));
    expect(JSON.parse(String((await ack)[0]))).toMatchObject({ code: 200, headers: { messageId: "synthetic-ping" }, data: JSON.stringify({ opaque: { value: 7 } }) });
    const pong = once(peer, "pong"); peer.ping("control"); expect(String((await pong)[0])).toBe("control");
    const callbackAck = once(peer, "message");
    peer.send(JSON.stringify({ type: "CALLBACK", headers: { topic: DINGTALK_BOT_CALLBACK_TOPIC, messageId: "synthetic-event" }, data: JSON.stringify({ msgId: "synthetic-msg", conversationType: "1", senderStaffId: "synthetic-user", msgtype: "text", text: { content: "hello" } }) }));
    expect(JSON.parse(String((await callbackAck)[0])).headers.messageId).toBe("synthetic-event"); expect(onMessage).toHaveBeenCalledOnce();
    const reconnect = once(wss, "connection"); peer.close(1001);
    const [fresh] = await reconnect; await vi.waitFor(() => expect(onStatus).toHaveBeenLastCalledWith("connected"));
    const done = closed(fresh); adapter.stop(); await done;
    await new Promise(resolve => setTimeout(resolve, 75));
    expect(wss.clients.size).toBe(0); expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onStatus).toHaveBeenLastCalledWith("disconnected");
  });
});

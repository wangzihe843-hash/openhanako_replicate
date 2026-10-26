import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const network = vi.hoisted(() => ({ base: "", dispatcher: undefined as Agent | undefined }));
vi.mock("undici", async original => {
  const actual = await original<typeof import("undici")>();
  return { ...actual, fetch: (url: string, init: Parameters<typeof actual.fetch>[1]) => {
    const source = new URL(url);
    if (!["api.bot.qq.com", "storage.synthetic.invalid"].includes(source.hostname)) throw new Error("unexpected external destination");
    return actual.fetch(`${network.base}${source.pathname}`, { ...init, dispatcher: network.dispatcher });
  } };
});
import { Agent } from "undici";
import { createQQAdapter } from "../lib/bridge/qq-adapter.ts";
import { createOutboundProxyRuntime } from "../lib/net/outbound-proxy.ts";

const runtime = createOutboundProxyRuntime({ log: () => {}, warn: () => {}, env: {} });
const adapters: ReturnType<typeof createQQAdapter>[] = [];
let server: http.Server;
let gateway: WebSocketServer;
let sockets: WebSocket[];
let frames: { op: number; d?: unknown }[][];
let requests: { path: string; body: Buffer }[];
let held: http.ServerResponse[];
let holdStage: string;
let holdBody: boolean;
let directory: string;
let file: string;
let pendingResponses: Set<http.ServerResponse>;
function create() {
  const onStatus = vi.fn(); const onMessage = vi.fn();
  const adapter = createQQAdapter({ appID: "synthetic-app", appSecret: "synthetic-secret", agentId: "synthetic-agent", onStatus, onMessage, dmGuildMap: undefined, onDmGuildDiscovered: undefined });
  adapters.push(adapter); return { adapter, onStatus, onMessage };
}
function event(socket: WebSocket, op: number, d?: unknown, s?: number, t?: string) { socket.send(JSON.stringify({ op, d, s, t })); }
function stage(pathname: string) {
  if (pathname.endsWith("getAppAccessToken")) return "token";
  if (pathname.endsWith("/gateway")) return "gateway";
  if (pathname.includes("/part-")) return "put";
  if (pathname.endsWith("upload_prepare")) return "prepare";
  if (pathname.endsWith("upload_part_finish")) return "finish";
  if (pathname.endsWith("/files")) return "merge";
  return "send";
}
beforeEach(async () => {
  runtime.apply({ mode: "direct" }); sockets = []; frames = []; requests = []; held = []; holdStage = ""; holdBody = false; pendingResponses = new Set();
  network.dispatcher = new Agent();
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "qq-lifecycle-loopback-")); file = path.join(directory, "fixture.png"); await fs.writeFile(file, Buffer.from([0, 1, 2, 3, 4, 5, 6, 255]));
  server = http.createServer(async (req, res) => {
    pendingResponses.add(res); res.once("close", () => pendingResponses.delete(res));
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({ path: req.url!, body: Buffer.concat(chunks) });
    const current = stage(req.url!);
    if (current === holdStage) { held.push(res); if (holdBody) { res.writeHead(200, { "Content-Type": "application/json" }); res.write('{"pending":'); } return; }
    let body: unknown = {};
    if (current === "token") body = { access_token: "synthetic-token", expires_in: 7200 };
    if (current === "gateway") body = { url: `${network.base.replace("http:", "ws:")}/ws` };
    if (current === "prepare") body = { upload_id: "synthetic-upload", block_size: "4", parts: [0, 1].map(index => ({ index, block_size: "4", presigned_url: `https://storage.synthetic.invalid/part-${index}?signature=synthetic` })), upload_config: { concurrency: 2, retry_timeout: 3, retry_delay: 1 } };
    if (current === "merge") body = { file_info: "synthetic-file-info" };
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(["put", "finish"].includes(current) ? "" : JSON.stringify(body));
  });
  gateway = new WebSocketServer({ server, path: "/ws" });
  gateway.on("connection", socket => {
    const index = sockets.length; sockets.push(socket); frames.push([]);
    socket.on("message", raw => {
      const payload = JSON.parse(String(raw)); frames[index].push(payload);
      if (payload.op === 1) event(socket, 11);
      if (payload.op === 2) event(socket, 0, { session_id: `synthetic-session-${index}` }, 0, "READY");
      if (payload.op === 6) event(socket, 0, "", 5, "RESUMED");
    });
    event(socket, 10, { heartbeat_interval: 1_000 });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  network.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  adapters.splice(0).forEach(adapter => adapter.stop());
  await vi.waitFor(() => expect(gateway.clients.size).toBe(0));
  await network.dispatcher.close();
  await new Promise<void>(resolve => gateway.close(() => resolve()));
  await new Promise<void>(resolve => server.close(() => resolve()));
  expect(pendingResponses.size).toBe(0);
  await fs.rm(directory, { recursive: true, force: true }); runtime.reset();
});

describe("QQ controlled real WebSocket/HTTP", () => {
  it("executes Identify, stale-session Identify, Resume and terminal close over real frames", async () => {
    const { onStatus } = create(); await vi.waitFor(() => expect(onStatus).toHaveBeenLastCalledWith("connected"));
    expect(frames[0][0]).toMatchObject({ op: 2, d: { intents: 1107296256, shard: [0, 1] } });
    sockets[0].close(4006, "synthetic-private-reason");
    await vi.waitFor(() => expect(frames[1]?.[0]?.op).toBe(2), { timeout: 3_000 });
    await vi.waitFor(() => expect(onStatus).toHaveBeenLastCalledWith("connected"));
    sockets[1].close(4009);
    await vi.waitFor(() => expect(frames[2]?.[0]).toMatchObject({ op: 6, d: { session_id: "synthetic-session-1", seq: 0 } }), { timeout: 3_000 });
    sockets[2].close(4915, "synthetic-secret");
    await vi.waitFor(() => expect(onStatus.mock.calls.at(-1)).toEqual(["error", expect.stringContaining("4915")]));
    const count = requests.length; await new Promise(resolve => setTimeout(resolve, 1_100)); expect(requests).toHaveLength(count);
    expect(JSON.stringify(onStatus.mock.calls)).not.toContain("synthetic-secret");
  });
  it("isolates rapid start-stop-start with token HTTP outstanding", async () => {
    holdStage = "token"; const old = create(); await vi.waitFor(() => expect(held).toHaveLength(1));
    old.adapter.stop(); await vi.waitFor(() => expect(held[0].destroyed).toBe(true));
    holdStage = ""; const fresh = create(); await vi.waitFor(() => expect(fresh.onStatus).toHaveBeenLastCalledWith("connected"));
    held[0].end(JSON.stringify({ access_token: "obsolete", expires_in: 7200 }));
    expect(sockets).toHaveLength(1); expect(old.onStatus).toHaveBeenLastCalledWith("disconnected");
  });
  it("sends real zero-based part bytes, finish and merge fields, and exactly one final media message", async () => {
    const { adapter, onStatus } = create(); await vi.waitFor(() => expect(onStatus).toHaveBeenLastCalledWith("connected"));
    await adapter.sendMediaFile("synthetic-user", file, { kind: "image", isGroup: false, filename: "fixture.png", replyContext: { messageId: "synthetic-msg" } });
    for (const index of [0, 1]) expect(requests.find(r => r.path === `/part-${index}`)?.body).toEqual((await fs.readFile(file)).subarray(index * 4, index * 4 + 4));
    expect(requests.filter(r => stage(r.path) === "finish").map(r => JSON.parse(String(r.body)).part_index).sort()).toEqual([0, 1]);
    expect(JSON.parse(String(requests.find(r => stage(r.path) === "merge")!.body))).toEqual({ upload_id: "synthetic-upload", file_type: 1, file_name: "fixture.png", srv_send_msg: false });
    const sends = requests.filter(r => stage(r.path) === "send"); expect(sends).toHaveLength(1);
    expect(JSON.parse(String(sends[0].body))).toMatchObject({ msg_type: 7, msg_id: "synthetic-msg", msg_seq: 1, media: { file_info: "synthetic-file-info" } });
  });
  it.each(["put", "finish", "merge"])("aborts real pending %s requests, including both concurrent parts", async phase => {
    const { adapter, onStatus } = create(); await vi.waitFor(() => expect(onStatus).toHaveBeenLastCalledWith("connected"));
    holdStage = phase; holdBody = phase !== "put";
    const result = adapter.sendMediaFile("synthetic-user", file, { kind: "image" }).then(() => null, error => error);
    await vi.waitFor(() => expect(held.length).toBe(phase === "merge" ? 1 : 2)); adapter.stop();
    expect(await result).toMatchObject({ name: "AbortError" }); await vi.waitFor(() => expect(held.every(r => r.destroyed)).toBe(true));
    expect(requests.filter(r => stage(r.path) === "send")).toHaveLength(0);
  });
  it.each([false, true])("aborts a real message response at body=%s with no resend", async body => {
    const { adapter, onStatus } = create(); await vi.waitFor(() => expect(onStatus).toHaveBeenLastCalledWith("connected"));
    holdStage = "send"; holdBody = body;
    const result = adapter.sendReply("synthetic-user", "x".repeat(2001)).then(() => null, error => error);
    await vi.waitFor(() => expect(held).toHaveLength(1)); adapter.stop();
    expect(await result).toMatchObject({ name: "AbortError" }); await vi.waitFor(() => expect(held[0].destroyed).toBe(true));
    expect(requests.filter(r => stage(r.path) === "send")).toHaveLength(1);
  });
});

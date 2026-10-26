import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type Fetch = typeof import("undici").fetch;
type Init = Parameters<Fetch>[1];
const transport = vi.hoisted(() => ({ fetch: null as ((url: string, init: Init, fetchImpl?: Fetch) => ReturnType<Fetch>) | null, logs: [] as string[] }));
vi.mock("undici", async importOriginal => {
  const actual = await importOriginal<typeof import("undici")>();
  return { ...actual, fetch: (url: string, init: Init) => transport.fetch(url, init, actual.fetch) };
});
vi.mock("ws", () => ({ default: class { static OPEN = 1; on() {} close() {} send() {} } }));
vi.mock("../lib/debug-log.js", () => ({
  debugLog: () => null,
  createModuleLogger: () => ({ log: (s: string) => transport.logs.push(s), warn: (s: string) => transport.logs.push(s), error: (s: string) => transport.logs.push(s) }),
}));
import { createQQAdapter } from "../lib/bridge/qq-adapter.ts";
import { createDingTalkAdapter } from "../lib/bridge/dingtalk-adapter.ts";
import { MediaDeliveryService } from "../lib/bridge/media-delivery-service.ts";
import { BridgeHttpRedirectError } from "../lib/bridge/outbound-http.ts";
import { bridgeHttpLoopback } from "./fixtures/bridge-http-loopback.ts";

class TestSocket { static OPEN = 1; on() {} close() {} send() {} }

describe("actual QQ and DingTalk adapters reject redirects", () => {
  let loop: Awaited<ReturnType<typeof bridgeHttpLoopback>>;
  let stopped: Array<{ stop(): void }> = [];
  let tmp: string;
  beforeAll(async () => {
    loop = await bridgeHttpLoopback();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-redirect-"));
    fs.writeFileSync(path.join(tmp, "synthetic.txt"), "SYNTHETIC_FILE_BYTES");
    transport.fetch = (url: string, init: Init, fetchImpl: Fetch = globalThis.fetch as unknown as Fetch) => {
      const parsed = new URL(url);
      if (!["api.bot.qq.com", "bots.qq.com", "api.sgroup.qq.com", "api.dingtalk.com", "api.dingtalk.io", "127.0.0.1"].includes(parsed.hostname)) throw new Error("Unexpected adapter origin");
      return fetchImpl(loop.source + parsed.pathname, { ...init, dispatcher: loop.agent });
    };
  });
  afterEach(() => { for (const adapter of stopped) adapter.stop(); stopped = []; vi.restoreAllMocks(); });
  afterAll(async () => { await loop?.close(); if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

  function qq(onStatus = vi.fn()) {
    const adapter = createQQAdapter({ appID: "SYNTHETIC_ID", appSecret: "SYNTHETIC_BODY_SECRET", agentId: "test", onMessage: vi.fn(), dmGuildMap: {}, onDmGuildDiscovered: vi.fn(), onStatus });
    stopped.push(adapter);
    return adapter;
  }
  function ding(onStatus = vi.fn(), legacy = false, clientSecret = "SYNTHETIC_BODY_SECRET") {
    const adapter = createDingTalkAdapter({ ...(legacy ? { authMode: "legacy_app" } : { corpId: "synthetic-corp" }), clientId: "SYNTHETIC_ID", clientSecret, robotCode: "robot", agentId: "test", onMessage: vi.fn(), onStatus, fetchImpl: (url: string, init: Init) => transport.fetch(url, init), WebSocketImpl: TestSocket, reconnectDelayMs: 10 });
    stopped.push(adapter);
    return adapter;
  }
  function normal(req: { path: string }, response: import("node:http").ServerResponse) {
    const data = req.path.endsWith("getAppAccessToken") || req.path.includes("oauth2") ? { access_token: "SYNTHETIC_AUTH_TOKEN", accessToken: "SYNTHETIC_AUTH_TOKEN", expires_in: 7200, expireIn: 7200 }
      : req.path === "/gateway" ? { url: "wss://never-network.invalid" }
        : req.path.endsWith("/open") ? { endpoint: "wss://never-network.invalid", ticket: "SYNTHETIC_TICKET" }
          : req.path.endsWith("/upload_prepare") ? { upload_id: "upload", block_size: "100", parts: [{ index: 0, block_size: "20", presigned_url: loop.source + "/put" }] }
            : { file_info: "SYNTHETIC_FILE_INFO" };
    response.end(JSON.stringify(data));
  }
  function redirect(response: import("node:http").ServerResponse, status: number) {
    response.writeHead(status, { Location: loop.sink + "/capture?secret=SYNTHETIC_LOCATION_SECRET" });
    response.end("SYNTHETIC_RESPONSE_SECRET");
  }

  it.each([301, 302, 303, 307, 308])("actual QQ token refuses %i without a reconnect", async status => {
    loop.reset(); transport.logs.length = 0;
    loop.respond((_req, res) => redirect(res, status));
    const clearTimer = vi.spyOn(globalThis, "clearInterval");
    const onStatus = vi.fn(); qq(onStatus);
    await vi.waitFor(() => expect(onStatus).toHaveBeenCalledWith("error", expect.stringContaining("redirect refused")));
    // Observe beyond the first scheduled reconnect delay (1000ms).
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(loop.sourceRequests).toHaveLength(1);
    expect(clearTimer).toHaveBeenCalledWith(expect.any(Object));
    expect(loop.sinkRequests).toEqual([]);
    expect(transport.logs.join(" ")).not.toMatch(/SYNTHETIC_/);
  });
  it.each([301, 302, 303, 307, 308])("actual DingTalk stream refuses %i without reconnect", async status => {
    loop.reset(); transport.logs.length = 0;
    loop.respond((_req, res) => redirect(res, status));
    const onStatus = vi.fn(); ding(onStatus);
    await vi.waitFor(() => expect(onStatus).toHaveBeenCalledWith("error", expect.stringContaining("redirect refused")));
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(loop.sourceRequests).toHaveLength(1);
    expect(loop.sinkRequests).toEqual([]);
    expect(transport.logs.join(" ")).not.toMatch(/SYNTHETIC_/);
  });

  for (const stage of ["text", "remote-media", "rich-media", "prepare", "put", "part-finish", "complete"] as const) {
    it(`${stage} refusal never retries or probes another QQ target`, async () => {
      loop.reset(); loop.respond(normal);
      const adapter = qq();
      await vi.waitFor(() => expect(loop.sourceRequests.some(r => r.path === "/gateway")).toBe(true));
      loop.reset();
      const target = stage === "text" || stage === "rich-media" ? "/messages" : stage === "remote-media" || stage === "complete" ? "/files" : stage === "prepare" ? "/upload_prepare" : stage === "put" ? "/put" : "/upload_part_finish";
      loop.respond((req, res) => req.path.endsWith(target) ? redirect(res, 307) : normal(req, res));
      const promise = stage === "text" ? adapter.sendReply("test", "hello")
        : stage === "remote-media" || stage === "rich-media" ? adapter.sendMedia("test", "https://media.invalid/image.png", {})
          : adapter.sendMediaFile("test", path.join(tmp, "synthetic.txt"), { filename: "image.png" });
      await expect(promise).rejects.toBeInstanceOf(BridgeHttpRedirectError);
      expect(loop.sourceRequests.filter(r => r.path.endsWith(target))).toHaveLength(1);
      expect(loop.sourceRequests.some(r => r.path.includes("/groups/"))).toBe(false);
      expect(loop.sinkRequests).toEqual([]);
    });
  }

  it("QQ token refusal during media delivery does not resend credentials for a failure notice", async () => {
    loop.reset();
    loop.respond((req, res) => req.path.endsWith("getAppAccessToken")
      ? res.end(JSON.stringify({ access_token: "SYNTHETIC_AUTH_TOKEN", expires_in: 1 })) : normal(req, res));
    const adapter = qq();
    await vi.waitFor(() => expect(loop.sourceRequests.some(req => req.path === "/gateway")).toBe(true));
    loop.reset();
    loop.respond((_req, res) => redirect(res, 307));
    let failure: unknown;
    try { await adapter.sendMedia("test", "https://media.invalid/image.png", {}); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(BridgeHttpRedirectError);
    await new MediaDeliveryService().sendFailureNotice(adapter, "test", failure);
    expect(loop.sourceRequests).toHaveLength(1);
    expect(loop.sourceRequests[0].body).toContain("SYNTHETIC_BODY_SECRET");
    expect(loop.sinkRequests).toEqual([]);
  });

  it("DingTalk preserves redirect classification when secret redaction changes diagnostic text", async () => {
    loop.reset(); loop.respond(normal);
    const adapter = ding(vi.fn(), false, "POST");
    await vi.waitFor(() => expect(loop.sourceRequests).toHaveLength(1));
    loop.reset(); loop.respond((_req, res) => redirect(res, 307));
    const error = await adapter.sendReply("test", "hello").catch(error => error);
    expect(error.message).not.toContain("POST");
    expect(error).toBeInstanceOf(BridgeHttpRedirectError);
    await new MediaDeliveryService().sendFailureNotice(adapter, "test", error);
    expect(loop.sourceRequests).toHaveLength(1);
    expect(loop.sinkRequests).toEqual([]);
  });

  for (const legacy of [false, true]) for (const phase of ["token", "robot"] as const) {
    it(`actual DingTalk ${legacy ? "legacy" : "current"} ${phase} refusal sends no second request`, async () => {
      loop.reset(); loop.respond(normal);
      const adapter = ding(vi.fn(), legacy);
      await vi.waitFor(() => expect(loop.sourceRequests.length).toBe(1));
      loop.reset();
      loop.respond((req, res) => (phase === "token" ? req.path.includes("oauth2") : req.path.includes("robot")) ? redirect(res, 308) : normal(req, res));
      await expect(adapter.sendReply("test", "hello", { isGroup: false, senderStaffId: "synthetic-user" })).rejects.toBeInstanceOf(BridgeHttpRedirectError);
      expect(loop.sourceRequests).toHaveLength(phase === "token" ? 1 : 2);
      expect(loop.sinkRequests).toEqual([]);
      if (phase === "robot") expect(loop.sourceRequests[1].headers["x-acs-dingtalk-access-token"]).toBe("SYNTHETIC_AUTH_TOKEN");
    });
  }
});

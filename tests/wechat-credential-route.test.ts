import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createBridgeRoute } from "../server/routes/bridge.ts";
import { bridgeHttpLoopback } from "./fixtures/bridge-http-loopback.ts";

const endpoint = "https://ilinkai.weixin.qq.com/ilink/bot/getconfig";
const credential = "SYN_WECHAT_REQUEST_AUTH";

function requestCredentialTest() {
  const app = new Hono();
  const manager = {
    getStatus: vi.fn(() => ({})),
    getMessages: vi.fn(() => []),
    startPlatformFromConfig: vi.fn(),
    stopPlatform: vi.fn(),
  };
  app.route("/api", createBridgeRoute({}, manager));
  return {
    manager,
    response: app.request("/api/bridge/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "wechat", credentials: { botToken: credential } }),
    }),
  };
}

describe("WeChat credential test over controlled HTTPS loopback", () => {
  let loop: Awaited<ReturnType<typeof bridgeHttpLoopback>>;
  const nativeFetch = globalThis.fetch;

  beforeAll(async () => { loop = await bridgeHttpLoopback(); });
  afterAll(async () => { await loop?.close(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  function remapToLoopback() {
    loop.reset();
    // The real original hostname is only a protocol identifier. The underlying
    // transport sees loopback only, and the dispatcher refuses every other host.
    const spy = vi.fn((url: string, init: RequestInit) => {
      if (String(url) !== endpoint) throw new Error("Unexpected WeChat test endpoint");
      const requestInit = { ...init, dispatcher: loop.agent };
      return nativeFetch(loop.source + "/ilink/bot/getconfig", requestInit);
    });
    vi.stubGlobal("fetch", spy);
    return spy;
  }

  it.each([{}, { ret: 0 }, { ret: 0, errcode: -14 }])("accepts documented getconfig success without claiming message delivery: %j", async payload => {
    const spy = remapToLoopback();
    loop.respond((_req, response) => response.end(JSON.stringify(payload)));
    const test = requestCredentialTest();
    const response = await test.response;
    const result = await response.json();
    expect(result.ok).toBe(true);
    expect(result.info.msg).toContain("鉴权");
    expect(result.info.msg).not.toMatch(/连接成功|送达|已发送/);
    expect(spy).toHaveBeenCalledOnce();
    expect(loop.sourceRequests).toHaveLength(1);
    expect(loop.sinkRequests).toEqual([]);
    const wire = loop.sourceRequests[0];
    expect(wire.method).toBe("POST");
    expect(wire.headers.authorization).toBe(`Bearer ${credential}`);
    expect(wire.headers.authorizationtype).toBe("ilink_bot_token");
    expect(wire.headers["x-wechat-uin"]).toBeTruthy();
    expect(JSON.parse(wire.body)).toEqual({ base_info: { channel_version: "1.0.0" } });
    expect(test.manager.startPlatformFromConfig).not.toHaveBeenCalled();
    expect(test.manager.stopPlatform).not.toHaveBeenCalled();
  });

  it.each([
    { ret: -14 },
    { ret: -14, errcode: 0 },
    { ret: 7 },
    { ret: "-14" },
    { ret: "0" },
    { ret: null },
  ])("rejects unsuccessful or malformed getconfig codes: %j", async payload => {
    remapToLoopback();
    loop.respond((_req, response) => response.end(JSON.stringify({ ...payload, errmsg: "context_token=SYN_ROUTE_CONTEXT log_id=route-local" })));
    const { response } = requestCredentialTest();
    const result = await (await response).json();
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe("string");
    expect(result.error).not.toContain("SYN_ROUTE_CONTEXT");
    expect(loop.sourceRequests).toHaveLength(1);
    expect(loop.sinkRequests).toEqual([]);
  });

  it.each([401, 503])("rejects HTTP %i even when its JSON says ret=0", async status => {
    remapToLoopback();
    loop.respond((_req, response) => {
      response.writeHead(status);
      response.end(JSON.stringify({ ret: 0, errmsg: "aes_key=SYN_ROUTE_HTTP_SECRET log_id=route-http" }));
    });
    const { response } = requestCredentialTest();
    const result = await (await response).json();
    expect(result.ok).toBe(false);
    expect(result.error).toContain(`HTTP ${status}`);
    expect(result.error).not.toContain("SYN_ROUTE_HTTP_SECRET");
    expect(loop.sourceRequests).toHaveLength(1);
  });

  it("returns a safe failure for malformed JSON", async () => {
    remapToLoopback();
    loop.respond((_req, response) => response.end('{"context_token":"SYN_ROUTE_JSON_SECRET", broken'));
    const { response } = requestCredentialTest();
    const result = await (await response).json();
    expect(result.ok).toBe(false);
    expect(result.error).not.toContain("SYN_ROUTE_JSON_SECRET");
    expect(loop.sourceRequests).toHaveLength(1);
  });

  it.each(["fetch", "body"])("redacts a %s rejection before returning the WeChat credential result", async stage => {
    const failure = new Error("context_token=SYN_REJECTION_SECRET log_id=local-rejection");
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (stage === "fetch") throw failure;
      return new Response(new ReadableStream({ start(controller) { controller.error(failure); } }));
    }));
    const { response } = requestCredentialTest();
    const result = await (await response).json();
    expect(result.ok).toBe(false);
    expect(result.error).not.toContain("SYN_REJECTION_SECRET");
    expect(result.error).toContain(stage === "fetch" ? "local-rejection" : "body_read_failed");
  });
});

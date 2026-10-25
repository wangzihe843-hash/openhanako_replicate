/**
 * tests/bridge-outbound-http.test.ts
 *
 * #1612 Bridge outbound REST 统一网络边界。
 *
 * 根因：QQ adapter 的 WS 走 webSocketOptionsForUrl 的显式代理，而 token /
 * gateway / sendReply 等 REST 用 Node 内建 fetch 直连——npm undici 的
 * setGlobalDispatcher 写的是 npm 拷贝的 registry，Node 内建 fetch 不读它
 * （Node v24 实测），代理环境下"收得到、发不出"，错误只剩笼统的 fetch failed。
 *
 * 本套件定义 Bridge outbound HTTP helper 的契约：
 *   1. 每个请求必须显式声明 stage；错误信息带 [platform:stage]、目标 host、代理路由
 *   2. 代理 dispatcher 与 WS 同源（resolveDispatcher 注入），per-request 显式传递
 *   3. 显式 timeout 常量，超时报 stage 化错误
 *   4. 仅幂等调用做有限 retry/backoff，上限与退避基数为显式常量
 *   5. 诊断不泄漏完整 URL（path/query 可能含签名）与代理凭证
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  BRIDGE_HTTP_MAX_RETRIES,
  BRIDGE_HTTP_RETRY_BASE_DELAY_MS,
  BRIDGE_HTTP_TIMEOUT_MS,
  BridgeHttpError,
  BridgeHttpRedirectError,
  createBridgeOutboundHttp,
} from "../lib/bridge/outbound-http.ts";

import { fetch as undiciFetch } from "undici";
import { downloadMedia } from "../lib/bridge/media-utils.ts";
import { bridgeHttpLoopback } from "./fixtures/bridge-http-loopback.ts";

function fakeResponse(status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: { cancel: vi.fn(async () => {}) },
    text: async () => "",
    json: async () => ({}),
  };
}

function networkError(code: string) {
  return Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error(`${code} 127.0.0.1:443`), { code }),
  });
}

function directResolver() {
  return { dispatcher: null, proxyUrl: "" };
}

describe("createBridgeOutboundHttp", () => {
  it("exports explicit timeout / retry constants", () => {
    expect(BRIDGE_HTTP_TIMEOUT_MS).toBeGreaterThan(0);
    expect(BRIDGE_HTTP_MAX_RETRIES).toBeGreaterThan(0);
    expect(BRIDGE_HTTP_RETRY_BASE_DELAY_MS).toBeGreaterThan(0);
  });

  it("requires an explicit platform label", () => {
    expect(() => createBridgeOutboundHttp({} as any)).toThrow(/platform/);
  });

  it("requires an explicit stage on every request", async () => {
    const http = createBridgeOutboundHttp({
      platform: "qq",
      fetchImpl: vi.fn(async () => fakeResponse()),
      resolveDispatcher: directResolver,
    } as any);
    await expect(http.request({ url: "https://api.sgroup.qq.com/gateway" } as any))
      .rejects.toThrow(/stage/);
  });

  it("passes the per-URL proxy dispatcher resolved from the shared proxy source", async () => {
    const dispatcher = { dispatch: () => false };
    const inits: any[] = [];
    const fetchImpl = vi.fn(async (_url: any, init: any) => {
      inits.push(init);
      return fakeResponse();
    });
    const http = createBridgeOutboundHttp({
      platform: "qq",
      fetchImpl,
      resolveDispatcher: (url: string) => ({
        dispatcher: url.startsWith("https://api.sgroup.qq.com") ? dispatcher : null,
        proxyUrl: url.startsWith("https://api.sgroup.qq.com") ? "http://127.0.0.1:7890" : "",
      }),
    } as any);

    await http.request({ stage: "gateway", url: "https://api.sgroup.qq.com/gateway" });
    expect(inits[0].dispatcher).toBe(dispatcher);

    await http.request({ stage: "token", url: "https://bots.qq.com/app/getAppAccessToken", method: "POST" });
    expect(inits[1].dispatcher).toBeUndefined();
  });

  it("aborts after the explicit timeout and reports stage/host/route without leaking the path", async () => {
    const fetchImpl = vi.fn((_url: any, init: any) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
      });
    }));
    const http = createBridgeOutboundHttp({
      platform: "qq",
      fetchImpl,
      resolveDispatcher: directResolver,
    } as any);

    const err: any = await http.request({
      stage: "upload_part_put",
      url: "https://cos.example.com/part-1?sig=TOPSECRET",
      method: "PUT",
      timeoutMs: 20,
    }).then(
      () => { throw new Error("expected timeout"); },
      (e: any) => e,
    );

    expect(err).toBeInstanceOf(BridgeHttpError);
    expect(err.timedOut).toBe(true);
    expect(err.stage).toBe("upload_part_put");
    expect(err.host).toBe("cos.example.com");
    expect(err.message).toContain("[qq:upload_part_put]");
    expect(err.message).toContain("cos.example.com");
    expect(err.message).toContain("20ms");
    expect(err.message).not.toContain("TOPSECRET");
    expect(err.message).not.toContain("/part-1");
  });

  it("retries idempotent requests on network failure with bounded exponential backoff", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw networkError("ECONNREFUSED");
      return fakeResponse();
    });
    const sleep = vi.fn(async () => {});
    const http = createBridgeOutboundHttp({
      platform: "qq",
      fetchImpl,
      resolveDispatcher: directResolver,
      sleep,
    } as any);

    const res: any = await http.request({
      stage: "token",
      url: "https://bots.qq.com/app/getAppAccessToken",
      method: "POST",
      idempotent: true,
    });

    expect(res.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]: any) => ms)).toEqual([
      BRIDGE_HTTP_RETRY_BASE_DELAY_MS,
      BRIDGE_HTTP_RETRY_BASE_DELAY_MS * 2,
    ]);
  });

  it("never auto-retries non-idempotent requests (no duplicate sends)", async () => {
    const fetchImpl = vi.fn(async () => { throw networkError("ECONNRESET"); });
    const sleep = vi.fn(async () => {});
    const http = createBridgeOutboundHttp({
      platform: "qq",
      fetchImpl,
      resolveDispatcher: directResolver,
      sleep,
    } as any);

    const err: any = await http.request({
      stage: "send_reply",
      url: "https://api.sgroup.qq.com/v2/users/user-openid/messages",
      method: "POST",
      body: "{}",
    }).then(
      () => { throw new Error("expected failure"); },
      (e: any) => e,
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(err).toBeInstanceOf(BridgeHttpError);
    expect(err.attempts).toBe(1);
  });

  it("stops at the retry cap and surfaces attempts, route and the underlying cause", async () => {
    const fetchImpl = vi.fn(async () => { throw networkError("ETIMEDOUT"); });
    const sleep = vi.fn(async () => {});
    const http = createBridgeOutboundHttp({
      platform: "qq",
      fetchImpl,
      resolveDispatcher: () => ({ dispatcher: { dispatch: () => false }, proxyUrl: "http://alice:secret@proxy.local:8080" }),
      sleep,
    } as any);

    const err: any = await http.request({
      stage: "token",
      url: "https://bots.qq.com/app/getAppAccessToken",
      method: "POST",
      idempotent: true,
    }).then(
      () => { throw new Error("expected failure"); },
      (e: any) => e,
    );

    expect(fetchImpl).toHaveBeenCalledTimes(BRIDGE_HTTP_MAX_RETRIES + 1);
    expect(err).toBeInstanceOf(BridgeHttpError);
    expect(err.attempts).toBe(BRIDGE_HTTP_MAX_RETRIES + 1);
    expect(err.proxied).toBe(true);
    // stage + host + 底层错误码 + 代理路由都必须在消息里
    expect(err.message).toContain("[qq:token]");
    expect(err.message).toContain("bots.qq.com");
    expect(err.message).toContain("ETIMEDOUT");
    expect(err.message).toContain("proxy.local:8080");
    // 代理凭证不泄漏
    expect(err.message).not.toContain("secret");
    expect(err.message).not.toContain("alice");
    expect(err.proxyUrl).not.toContain("secret");
    // 原始错误保留在 cause 链上
    expect(err.cause?.message).toBe("fetch failed");
  });

  it("retries retryable HTTP statuses for idempotent requests and returns the final response as-is", async () => {
    const first = fakeResponse(503);
    const second = fakeResponse(200);
    const fetchImpl = vi.fn(async () => (fetchImpl.mock.calls.length === 1 ? first : second));
    const sleep = vi.fn(async () => {});
    const http = createBridgeOutboundHttp({
      platform: "qq",
      fetchImpl,
      resolveDispatcher: directResolver,
      sleep,
    } as any);

    const res: any = await http.request({
      stage: "gateway",
      url: "https://api.sgroup.qq.com/gateway",
      idempotent: true,
    });
    expect(res.status).toBe(200);
    expect(first.body.cancel).toHaveBeenCalled();

    // 非幂等：5xx 原样返回（状态语义归调用方），绝不重试
    const fetchOnce = vi.fn(async () => fakeResponse(503));
    const httpNoRetry = createBridgeOutboundHttp({
      platform: "qq",
      fetchImpl: fetchOnce,
      resolveDispatcher: directResolver,
      sleep,
    } as any);
    const res503: any = await httpNoRetry.request({
      stage: "send_reply",
      url: "https://api.sgroup.qq.com/v2/users/u/messages",
      method: "POST",
    });
    expect(res503.status).toBe(503);
    expect(fetchOnce).toHaveBeenCalledTimes(1);
  });
});


describe("Bridge redirect policy over real HTTPS loopback", () => {
  let loop: Awaited<ReturnType<typeof bridgeHttpLoopback>>;
  beforeAll(async () => { loop = await bridgeHttpLoopback(); });
  afterAll(async () => { await loop?.close(); });
  const shapes = [
    ["qq_token", { clientSecret: "SYNTHETIC_BODY_SECRET" }, {}],
    ["qq_api", { content: "message" }, { Authorization: "QQBot SYNTHETIC_AUTH_TOKEN" }],
    ["dingtalk_current", { client_secret: "SYNTHETIC_BODY_SECRET" }, {}],
    ["dingtalk_legacy", { appSecret: "SYNTHETIC_BODY_SECRET" }, {}],
    ["dingtalk_stream", { clientSecret: "SYNTHETIC_BODY_SECRET" }, {}],
    ["dingtalk_robot", { msgParam: "message" }, { "x-acs-dingtalk-access-token": "SYNTHETIC_CUSTOM_TOKEN" }],
    ["qq_presigned_put", null, {}],
  ] as const;
  for (const fetchImpl of [undiciFetch, globalThis.fetch]) {
    for (const destination of ["same-origin", "cross-host", "downgrade"] as const) {
      for (const [stage, payload, headers] of shapes) {
        it.each([301, 302, 303, 307, 308])(`${fetchImpl === undiciFetch ? "undici" : "native"} ${stage} ${destination} refuses HTTP %i without second station or retry`, async status => {
          loop.reset();
          const location = (destination === "same-origin" ? loop.source : destination === "cross-host" ? loop.sink : loop.downgrade) + "/capture?secret=SYNTHETIC_LOCATION_SECRET";
          loop.respond((_request, response) => { response.writeHead(status, { Location: location }); response.end("SYNTHETIC_RESPONSE_SECRET"); });
          const sleep = vi.fn(async () => {});
          const http = createBridgeOutboundHttp({ platform: "qq", fetchImpl: fetchImpl as unknown as typeof undiciFetch, resolveDispatcher: () => ({ dispatcher: loop.agent, proxyUrl: "" }), sleep });
          const error = await http.request({ stage, url: loop.source + "/source?signature=SYNTHETIC_URL_SECRET", method: payload ? "POST" : "PUT", headers: { ...headers }, body: payload ? JSON.stringify(payload) : new Blob(["SYNTHETIC_FILE_BYTES"]), idempotent: true }).catch(error => error);
          expect(error).toBeInstanceOf(BridgeHttpRedirectError);
          expect(error).toMatchObject({ code: "BRIDGE_HTTP_REDIRECT_REJECTED", status, attempts: 1, timedOut: false });
          expect(loop.sourceRequests).toHaveLength(1);
          expect(loop.sourceRequests[0].path).toContain("/source?");
          expect(loop.sourceRequests[0].remoteAddress).toBe("127.0.0.1");
          expect(loop.sinkRequests).toEqual([]);
          expect(sleep).not.toHaveBeenCalled();
          expect(error.cause).toBeUndefined();
          expect(error.message + JSON.stringify(error)).not.toMatch(/SYNTHETIC_|capture|signature=/);
        });
      }
    }
  }

  it("keeps ordinary media CDN downloads on their independent redirect-capable path", async () => {
    loop.reset();
    loop.respond((_req, res) => { res.writeHead(302, { Location: loop.sink + "/public-media" }); res.end(); });
    vi.stubGlobal("fetch", (url: string) => undiciFetch(url, { dispatcher: loop.agent }));
    try {
      expect((await downloadMedia(loop.source + "/public-media")).toString()).toBe("{}");
      expect(loop.sourceRequests).toHaveLength(1);
      expect(loop.sinkRequests).toHaveLength(1);
      expect(loop.sinkRequests[0].body).toBe("");
    } finally { vi.unstubAllGlobals(); }
  });

  it.each([200, 204, 304, 400, 401, 404, 429, 500, 503])("preserves HTTP %i response and existing retry rules", async status => {
    loop.reset();
    loop.respond((_request, response) => { response.writeHead(status); response.end(status === 204 || status === 304 ? undefined : "control"); });
    const sleep = vi.fn(async () => {});
    const http = createBridgeOutboundHttp({ platform: "qq", resolveDispatcher: () => ({ dispatcher: loop.agent, proxyUrl: "" }), sleep });
    const response = await http.request({ stage: "control", url: loop.source, idempotent: true });
    expect(response.status).toBe(status);
    await response.text();
    const count = status === 429 || status >= 500 ? 3 : 1;
    expect(loop.sourceRequests).toHaveLength(count);
    expect(sleep).toHaveBeenCalledTimes(count - 1);
    expect(loop.sinkRequests).toHaveLength(0);
  });
});

describe("Bridge redirect error contract", () => {
  it.each([301, 302, 303, 307, 308])("refuses %i even without Location; cancels body and ignores release errors", async status => {
    const response = fakeResponse(status);
    response.body.cancel.mockRejectedValue(new Error("SYNTHETIC_CANCEL_SECRET"));
    const fetchImpl = vi.fn(async () => response);
    const sleep = vi.fn(async () => {});
    const http = createBridgeOutboundHttp({ platform: "dingtalk", fetchImpl: fetchImpl as unknown as typeof undiciFetch, resolveDispatcher: directResolver, sleep });
    await expect(http.request({ stage: "token", url: "https://source.invalid", idempotent: true })).rejects.toMatchObject({ code: "BRIDGE_HTTP_REDIRECT_REJECTED", attempts: 1, status });
    expect(response.body.cancel).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith("https://source.invalid", expect.objectContaining({ redirect: "manual" }));
    expect(sleep).not.toHaveBeenCalled();
  });
});


it("stops after a retryable status followed by redirect, with safe proxy diagnostics", async () => {
  const fetchImpl = vi.fn().mockResolvedValueOnce(fakeResponse(503)).mockResolvedValueOnce(fakeResponse(307));
  const sleep = vi.fn(async () => {});
  const http = createBridgeOutboundHttp({ platform: "qq", fetchImpl, sleep, resolveDispatcher: () => ({ dispatcher: null, proxyUrl: "http://SYNTHETIC_USER:SYNTHETIC_PASS@proxy.invalid/path?secret=SYNTHETIC_QUERY#SYNTHETIC_FRAGMENT" }) });
  const error = await http.request({ stage: "token", url: "https://source.invalid", idempotent: true }).catch(error => error);
  expect(error).toBeInstanceOf(BridgeHttpRedirectError);
  expect(error).toMatchObject({ attempts: 2, status: 307 });
  expect(JSON.stringify(error) + error.message).not.toContain("SYNTHETIC_");
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(sleep).toHaveBeenCalledExactlyOnceWith(BRIDGE_HTTP_RETRY_BASE_DELAY_MS);
});

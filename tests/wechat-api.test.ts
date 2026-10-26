import { describe, expect, it } from "vitest";
import {
  assertWechatApiResponse,
  readWechatApiResponse,
  WechatApiError,
} from "../lib/bridge/wechat-api.ts";

const updates = "ilink/bot/getupdates";
const otherEndpoints = [
  "ilink/bot/getconfig",
  "ilink/bot/sendmessage",
  "ilink/bot/sendtyping",
  "ilink/bot/getuploadurl",
];

function apiError(endpoint: string, response: unknown): WechatApiError {
  try {
    assertWechatApiResponse(endpoint, response);
  } catch (error) {
    expect(error).toBeInstanceOf(WechatApiError);
    return error as WechatApiError;
  }
  throw new Error("Expected a structured WeChat API error");
}

describe("WeChat endpoint business-error contracts", () => {
  it.each([
    {},
    { ret: 0 },
    { errcode: 0 },
    { ret: 0, errcode: 0 },
  ])("accepts optional numeric zero getupdates codes: %j", response => {
    expect(() => assertWechatApiResponse(updates, response)).not.toThrow();
  });

  it.each([
    { ret: -14 },
    { ret: -14, errcode: 0 },
    { errcode: -14 },
    { ret: 0, errcode: -14 },
    { ret: 7, errcode: -14 },
    { ret: -14, errcode: 7 },
    { ret: -14, errcode: "0" },
    { ret: "0", errcode: -14 },
  ])("classifies numeric -14 from either documented getupdates field: %j", response => {
    const error = apiError(updates, response);
    expect(error.sessionExpired).toBe(true);
  });

  it.each([
    { ret: 7 },
    { ret: 0, errcode: 7 },
    { errcode: 7 },
    { ret: 7, errmsg: "server text mentions ret=-14 errcode=-14" },
  ])("keeps ordinary business failures separate from session expiry: %j", response => {
    expect(apiError(updates, response).sessionExpired).toBe(false);
  });

  it.each(["-14", "0", null, false, [], {}])("rejects a malformed ret without treating it as numeric -14: %j", ret => {
    expect(apiError(updates, { ret }).sessionExpired).toBe(false);
  });

  it.each(["-14", "0", null, false, [], {}])("rejects a malformed getupdates errcode without expiring the session: %j", errcode => {
    expect(apiError(updates, { ret: 0, errcode }).sessionExpired).toBe(false);
  });

  it.each(otherEndpoints)("preserves ret errors but does not invent an errcode contract for %s", endpoint => {
    for (const response of [{}, { ret: 0 }, { ret: 0, errcode: -14 }, { errcode: -14 }]) {
      expect(() => assertWechatApiResponse(endpoint, response)).not.toThrow();
    }
    expect(apiError(endpoint, { ret: -14 }).sessionExpired).toBe(true);
    expect(apiError(endpoint, { ret: 7, errcode: -14 }).sessionExpired).toBe(false);
  });

  it("redacts an error copy while retaining codes and leaving the source response untouched", () => {
    const response = {
      ret: 7,
      errcode: 8,
      errmsg: "context_token=SYN_CONTEXT aes_key=SYN_AES https://cdn.invalid/?encrypted_query_param=SYN_QUERY log_id=local-123",
    };
    const original = JSON.stringify(response);
    const error = apiError(updates, response);
    expect(error).toMatchObject({ ret: 7, errcode: 8, sessionExpired: false });
    expect(error.message).not.toMatch(/SYN_CONTEXT|SYN_AES|SYN_QUERY/);
    expect(error.message).toContain("local-123");
    expect(JSON.stringify(response)).toBe(original);
  });
});

describe("WeChat HTTP response classification", () => {
  it.each([401, 503])("keeps HTTP %i separate from business expiry even if the body contains -14", async status => {
    const response = new Response(JSON.stringify({ ret: -14, errmsg: "context_token=SYN_HTTP_SECRET log_id=local-http" }), { status });
    let error: unknown;
    try { await readWechatApiResponse(updates, response); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("Expected HTTP error");
    expect((error as { sessionExpired?: boolean }).sessionExpired).not.toBe(true);
    expect(error.message).toContain(`HTTP ${status}`);
    expect(error.message).not.toContain("SYN_HTTP_SECRET");
  });

  it("rejects bad JSON without copying its raw body into the error", async () => {
    const response = new Response('{"context_token":"SYN_BAD_JSON_SECRET", invalid');
    let error: unknown;
    try { await readWechatApiResponse(updates, response); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("Expected JSON error");
    expect((error as { sessionExpired?: boolean }).sessionExpired).not.toBe(true);
    expect(error.message).not.toContain("SYN_BAD_JSON_SECRET");
  });

  it("returns successful protocol fields unchanged", async () => {
    const payload = { ret: 0, errcode: 0, get_updates_buf: "SYN_CURSOR", msgs: [] };
    expect(await readWechatApiResponse(updates, new Response(JSON.stringify(payload)))).toEqual(payload);
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import esm from "../shared/log-redactor.ts";
import cjs from "../shared/log-redactor.cjs";
import { readWechatApiResponse } from "../lib/bridge/wechat-api.ts";
import { MediaDeliveryService } from "../lib/bridge/media-delivery-service.ts";
import { createModuleLogger, initDebugLog } from "../lib/debug-log.ts";

// Short, non-working sentinels: no real API, recipient, media or credentials.
const secret = "short-Z7";
const fullUrl = `https://novac2c.cdn.weixin.qq.com/signed/${secret}?opaque=${secret}`;
const endpoint = "ilink/bot/getuploadurl";
const diagnostic = "stage=upload httpStatus=503 log_id=local-123 retry_after=3";
const temporary: string[] = [];
const encode = (value: string, count: number) => {
  for (let i = 0; i < count; i++) value = encodeURIComponent(value);
  return value;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe.each([["TS", esm], ["CJS", cjs]] as const)("%s media diagnostic redaction", (_name, api) => {
  it.each(["full_url", "upload_full_url", "UPLOAD-FULL-URL", "uploadFullUrl"])("hides the complete %s field in text and nested objects", key => {
    const object = { detail: [{ [key]: `${fullUrl}&other=Z` }], ret: 1, log_id: "local-123" };
    const original = JSON.stringify(object);
    for (const input of [original, JSON.stringify({ error: original }),
      `${key}=${fullUrl}&other=Z ${diagnostic}`,
      `${key}=${fullUrl.replace("novac2c.cdn.weixin.qq.com", "example.invalid")}&other=Z ${diagnostic}`]) {
      const output = api.redactLogText(input);
      expect(output).not.toContain(secret);
      expect(output).not.toContain("other=Z");
      expect(output).toContain("[redacted]");
      expect(api.redactLogText(output)).toBe(output);
    }
    expect(api.redactLogValue(object)).toEqual({ detail: [{ [key]: "[redacted]" }], ret: 1, log_id: "local-123" });
    expect(JSON.stringify(object)).toBe(original);
  });

  it.each([
    fullUrl,
    `HTTPS://NOVAC2C.CDN.WEIXIN.QQ.COM/${secret}?UnknownCase=Z&x=Y#short-fragment`,
    `https://%6eovac2c.cdn.weixin.qq.com/${secret}?%6Fpaque=Z`,
    encode(fullUrl, 1), encode(fullUrl, 2), encode(fullUrl, 4), encode(fullUrl, 5),
    encode(fullUrl, 1).replace(/%3A|%2F/g, value => value.toLowerCase()),
    `${encode(fullUrl, 1)}%INVALID`,
    JSON.stringify({ detail: JSON.stringify({ errmsg: fullUrl }) }),
    fullUrl.replaceAll("/", "\\/"),
  ])("does not infer media credential length or query names: %s", url => {
    const output = api.redactLogText(`media failed ${url} ${diagnostic}`);
    expect(output).not.toContain(secret);
    expect(output).not.toMatch(/=Z|=Y|short-fragment/);
    expect(output).toContain(diagnostic);
    expect(api.redactLogText(output)).toBe(output);
  });

  it.each(["sig", "SIGNATURE", "opaque", "%6Fpaque", "%256Fpaque", "%252525256Fpaque", "bad%Qkey", "ToKeN"])("hides even one-character URL credentials for %s", key => {
    const output = api.redactLogText(`https://example.invalid/file?${key}=Z&version=3 ${diagnostic}`);
    expect(output).not.toContain("=Z");
    expect(output).toContain("version=3");
    expect(output).toContain(diagnostic);
    expect(api.redactLogText(output)).toBe(output);
  });

  it("retains ordinary diagnostics and URLs, without expanding the media host match", () => {
    for (const url of [
      "https://example.invalid/photo.jpg?version=3",
      "https://novac2c.cdn.weixin.qq.com.example.invalid/docs?version=3",
      "https://example.invalid/docs/novac2c.cdn.weixin.qq.com?version=3",
    ]) expect(api.redactLogText(url)).toBe(url);
    const ordinary = `${diagnostic} opaque=ordinary signature=example full_url_count=2 support-full_url=reference`;
    expect(api.redactLogText(ordinary)).toBe(ordinary);
  });

  it("sanitizes nested Error causes, aggregate errors and stacks without altering source objects", () => {
    const cause = Object.assign(new Error(`media failed ${fullUrl}`), { code: "EUPLOAD", httpStatus: 503 });
    const error = new AggregateError([cause], "upload failed", { cause });
    error.stack = `Error: media failed ${encode(fullUrl, 2)}\n    at /tmp/media.ts:12:3`;
    const output = api.formatLogArgs([error]);
    expect(output).not.toContain(secret);
    expect(output).toContain("EUPLOAD");
    expect(output).toContain("503");
    expect(output).toContain("/tmp/media.ts:12:3");
    expect(cause.message).toContain(secret);
    expect(error.cause).toBe(cause);
  });
});

describe("real WeChat media error output boundaries", () => {
  it.each(["HTTP field", "HTTP nested error", "business errmsg", "business encoded errmsg", "HTTP wrapped errmsg", "business wrapped errmsg"])("sanitizes %s before errors, persistent logs, console and failure notices", async mode => {
    const reportedUrl = mode.includes("wrapped") ? `https://diagnostic.example.com/error?detail=${encode(fullUrl, 2)}`
      : mode.includes("encoded") ? encode(fullUrl, 2) : fullUrl;
    const body = mode === "HTTP field" ? { upload_full_url: fullUrl, log_id: "local-123" }
      : mode === "HTTP nested error" ? { error: { cause: { errmsg: JSON.stringify({ detail: encode(fullUrl, 2) }) } }, log_id: "local-123" }
      : { ret: 1, errmsg: `media preparation failed ${reportedUrl} log_id=local-123` };
    const original = JSON.stringify(body);
    let error: Error | undefined;
    try { await readWechatApiResponse(endpoint, new Response(original, { status: mode.startsWith("HTTP") ? 503 : 200 })); }
    catch (caught) { error = caught as Error; }
    expect(error).toBeInstanceOf(Error);
    expect(error!.message).toContain(endpoint);
    expect(error!.message).toContain(mode.startsWith("HTTP") ? "HTTP 503" : "ret=1");
    expect(error!.message).toContain("local-123");
    expect(error!.message).not.toContain(secret);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-media-redaction-"));
    temporary.push(dir);
    const log = initDebugLog(dir);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Real shared logger; mirror BridgeManager's media failure message and source.
    createModuleLogger("bridge").warn(`media send failed: ${error!.message} (remote_url:${fullUrl})`);
    const sendReply = vi.fn<(chatId: string, text: string) => Promise<void>>(async () => {});
    await new MediaDeliveryService().sendFailureNotice({ sendReply }, "synthetic-user", error);
    for (const output of [error!.stack, fs.readFileSync(log.filePath, "utf8"), JSON.stringify(consoleWarn.mock.calls), JSON.stringify(sendReply.mock.calls)]) {
      expect(output).not.toContain(secret);
      expect(output).toContain("local-123");
    }
    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(body)).toBe(original);
  });

  it("also sanitizes a raw error at the failure-notice boundary", async () => {
    const sendReply = vi.fn<(chatId: string, text: string) => Promise<void>>(async () => {});
    const error = new Error(`media failed ${fullUrl} ${diagnostic}`);
    await new MediaDeliveryService().sendFailureNotice({ sendReply }, "synthetic-user", error);
    expect(sendReply).toHaveBeenCalledTimes(1);
    const text = sendReply.mock.calls[0][1];
    expect(text).toContain("[文件发送失败]");
    expect(text).toContain(diagnostic);
    expect(text).not.toContain(secret);
    expect(error.message).toContain(secret);
  });

  it("leaves successful protocol data and ordinary failure text unchanged", async () => {
    const payload = { ret: 0, upload_full_url: fullUrl, upload_param: "synthetic" };
    expect(await readWechatApiResponse(endpoint, new Response(JSON.stringify(payload)))).toEqual(payload);
    const sendReply = vi.fn<(chatId: string, text: string) => Promise<void>>(async () => {});
    await new MediaDeliveryService().sendFailureNotice({ sendReply }, "synthetic-user", new Error("ordinary failure"));
    expect(sendReply).toHaveBeenCalledWith("synthetic-user", "[文件发送失败] ordinary failure");
  });
});

const queryOnlyMedia = "https://novac2c.cdn.weixin.qq.com/media?opaque=z7";
const wrapUrl = (value: string) => `https://diagnostic.example.com/error?detail=${value}&version=3`;
const nestUrl = (value: string, layers: number) => {
  for (let i = 0; i < layers; i++) value = wrapUrl(i % 2 ? encode(value, 1) : value);
  return value;
};

describe.each([["TS", esm], ["CJS", cjs]] as const)("%s nested diagnostic URLs", (_name, api) => {
  it.each([
    wrapUrl(queryOnlyMedia),
    wrapUrl("prefix" + queryOnlyMedia),
    wrapUrl(encode("prefix" + queryOnlyMedia, 2)),
    `https://diagnostic.example.com/error?token=${queryOnlyMedia}&unknown=z7`,
    `https://diagnostic.example.com/error?access_token=${encode(queryOnlyMedia, 1)}&unknown=z7`,
    `https://diagnostic.example.com/error?bad=%Q&detail=${encode(queryOnlyMedia, 2)}`,
    wrapUrl(encode(queryOnlyMedia, 1)),
    wrapUrl(encode(queryOnlyMedia, 2)),
    wrapUrl(encode(queryOnlyMedia, 4)),
    wrapUrl(encode(queryOnlyMedia, 5)),
    encode(wrapUrl(encode(queryOnlyMedia, 1)), 1),
    encode(wrapUrl(encode(queryOnlyMedia, 2)), 4),
    nestUrl(queryOnlyMedia, 3), nestUrl(queryOnlyMedia, 12),
    wrapUrl(queryOnlyMedia.replace("opaque", "arbitraryCase")),
    // Raw & is ambiguous: do not lose inner parameters by parsing the outer query.
    wrapUrl(queryOnlyMedia.replace("?opaque=z7", "?part=1&unknown=z7")),
    wrapUrl(queryOnlyMedia.replace("?opaque=z7", "?part=1#z7")),
    wrapUrl(encode(queryOnlyMedia, 1).replace("https", "%68%74%74%70%73")),
    wrapUrl(encode(JSON.stringify({ error: { url: queryOnlyMedia } }), 1)),
    wrapUrl(`https://example.invalid/help?version=3,${encode(queryOnlyMedia, 2)}`),
    `https://diagnostic.example.com/error#${encode(queryOnlyMedia, 2)}`,
    `https://diagnostic.example.com/proxy/${encode(queryOnlyMedia, 1)}`,
    wrapUrl(encode(queryOnlyMedia, 1) + "%INVALID"),
    wrapUrl(encode(queryOnlyMedia, 2)) + "&bad=%Q",
    wrapUrl(queryOnlyMedia.replace("novac2c", "%6eovac2c")),
    wrapUrl(queryOnlyMedia.toUpperCase().replace("Z7", "z7")),
  ])("removes nested capabilities without depending on signature shape: %s", url => {
    const output = api.redactLogText(`failed ${url} ${diagnostic}`);
    expect(output).not.toContain("z7");
    expect(output).toContain(diagnostic);
    expect(api.redactLogText(output)).toBe(output);
  });

  it.each([
    "https://api.telegram.org/bot123:z7/getFile",
    "https://api.telegram.org/file/bot123:z7/file.jpg",
    "https://api.example.com/file?access_token=z7",
    "https://api.example.com/file?app_secret=z7",
    "https://api.example.com/file?ToKeN=z7",
    "https://api.example.com/file?%256Fpaque=z7",
    "https://api.example.com/file?encrypted_query_param=z7",
    "https://name:z7@api.example.com/file",
  ])("also protects other credential-bearing nested URLs: %s", inner => {
    for (const url of [wrapUrl(inner), wrapUrl(encode(inner, 2)), nestUrl(inner, 3)]) {
      const output = api.redactLogText(`${url} ${diagnostic}`);
      expect(output).not.toContain("z7");
      expect(output).toContain(diagnostic);
      expect(api.redactLogText(output)).toBe(output);
    }
  });

  it("preserves ordinary nested links and diagnostics byte for byte", () => {
    for (const inner of [
      "https://example.invalid/help?version=3&count=2",
      "https://novac2c.cdn.weixin.qq.com.example.invalid/docs?version=3",
      "https://example.invalid/docs/novac2c.cdn.weixin.qq.com?version=3",
    ]) {
      for (const url of [wrapUrl(inner), wrapUrl(encode(inner, 1)), wrapUrl(encode(inner, 2))]) {
        expect(api.redactLogText(`${url} ${diagnostic}`)).toBe(`${url} ${diagnostic}`);
      }
    }
  });

  it("bounds nested URL depth, inspection bytes and breadth while hiding uninspected tails", () => {
    const oversized = wrapUrl("x".repeat(20_000) + encode(queryOnlyMedia, 1));
    const broad = Array.from({ length: 300 }, () => wrapUrl("https://example.invalid/help?version=3")).join(" ");
    for (const value of [oversized, nestUrl(queryOnlyMedia, 100), broad + " " + wrapUrl(queryOnlyMedia)]) {
      const output = api.redactLogText(`${value} ${diagnostic}`);
      expect(output).not.toContain("z7");
      expect(output).toContain(diagnostic);
      expect(output.length).toBeLessThanOrEqual(value.length + diagnostic.length + 1);
      expect(api.redactLogText(output)).toBe(output);
    }
  });

  it("covers escaped JSON, aggregate causes and stacks without changing input", () => {
    const url = wrapUrl(encode(queryOnlyMedia, 2));
    const cause = new Error(url);
    const error = new AggregateError([cause], "upload failed", { cause });
    error.stack = `Error: ${url}\n    at /tmp/media.ts:12:3`;
    for (const value of [JSON.stringify({ detail: JSON.stringify({ url }) }), error]) {
      const output = api.redactLogText(value);
      expect(output).not.toContain("z7");
      expect(api.redactLogText(output)).toBe(output);
    }
    expect(api.redactLogValue(error).stack).toContain("/tmp/media.ts:12:3");
    expect(cause.message).toBe(url);
  });
});

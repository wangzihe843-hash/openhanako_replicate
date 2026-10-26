import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWechatAdapter } from "../lib/bridge/wechat-adapter.ts";
import { encodeIlinkMediaAesKey } from "../lib/bridge/wechat-ilink-media-crypto.ts";
import { assertWechatMediaUrl, fetchWechatMedia, readWechatBody, selectWechatMediaUrl, WECHAT_API_MAX_BYTES, WECHAT_BODY_TIMEOUT_MS, WECHAT_MEDIA_MAX_BYTES, WECHAT_MEDIA_TIMEOUT_MS } from "../lib/bridge/wechat-media.ts";

const CDN = "https://novac2c.cdn.weixin.qq.com";
const TOKEN = "SYNTHETIC_U13_BOT_TOKEN";
const CONTEXT = "SYNTHETIC_U13_CONTEXT";
const adapters: ReturnType<typeof createWechatAdapter>[] = [];
const json = (value: unknown) => new Response(JSON.stringify(value));
async function flush() { for (let n = 0; n < 60; n++) await Promise.resolve(); }

function setup(handler: (url: string, init: RequestInit) => Promise<Response> | Response, items: unknown[] = [{ type: 1, text_item: { text: "hello" } }]) {
  let polls = 0;
  const fetchMock = vi.fn<typeof fetch>(async (input, init: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith("/getupdates")) {
      if (++polls === 1) return json({ ret: 0, msgs: [{ from_user_id: "fixture-user", context_token: CONTEXT, item_list: items }] });
      return new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), { once: true }));
    }
    return handler(url, init);
  });
  vi.stubGlobal("fetch", fetchMock);
  const onMessage = vi.fn();
  const adapter = createWechatAdapter({ botToken: TOKEN, hanaHome: undefined, agentId: "fixture-agent", onMessage, onStatus: vi.fn() });
  adapters.push(adapter);
  return { adapter, onMessage, fetchMock };
}

afterEach(() => {
  for (const adapter of adapters.splice(0)) adapter.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const KEY = Buffer.from("00112233445566778899aabbccddeeff", "hex");
function encrypt(buffer: Buffer) {
  const cipher = crypto.createCipheriv("aes-128-ecb", KEY, null);
  return Buffer.concat([cipher.update(buffer), cipher.final()]);
}
function streamResponse(chunks: Uint8Array[], headers: Record<string, string> = {}) {
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({
    start(controller) { for (const chunk of chunks) controller.enqueue(chunk); },
    cancel,
  }), { headers });
  return { response, cancel };
}

describe("WeChat media URL and encryption boundaries", () => {
  it.each([undefined, null, "", "  "])("falls back only when the full URL is absent or blank: %j", full => {
    expect(selectWechatMediaUrl(full, "old +&/=" )).toBe(`${CDN}/c2c/download?encrypted_query_param=old%20%2B%26%2F%3D`);
    expect(selectWechatMediaUrl(full, "old", "file +")).toBe(`${CDN}/c2c/upload?encrypted_query_param=old&filekey=file%20%2B`);
  });

  it.each([
    "http://novac2c.cdn.weixin.qq.com/c2c/download", "file:///tmp/fixture", "data:text/plain,secret", "//novac2c.cdn.weixin.qq.com/file",
    "https://novac2c.cdn.weixin.qq.com.evil.example/file", "https://novac2c.cdn.weixin.qq.com@evil.example/file",
    "https://name:password@novac2c.cdn.weixin.qq.com/file", "https://novac2c.cdn.weixin.qq.com:444/file",
    "https://novac2c.cdn.weixin.qq.com/file#secret", "https://novac2c.cdn.weixin.qq.com./file",
    "https://127.0.0.1/file", "https://[::1]/file", "https://169.254.169.254/file", "https://unverified.example/file", "not a URL", 7, {},
  ])("rejects an untrusted/malformed full URL without trying a legacy fallback: %j", async full => {
    const fixture = setup(() => { throw new Error("No media request allowed"); });
    await flush();
    const before = fixture.fetchMock.mock.calls.length;
    await expect(fixture.adapter.downloadImage(JSON.stringify({ full_url: full, encrypt_query_param: "SYNTHETIC_FALLBACK" }))).rejects.toThrow();
    expect(fixture.fetchMock).toHaveBeenCalledTimes(before);
  });

  it.each([{}, { encrypt_query_param: "" }, { full_url: "" }, null, []])("rejects missing media destinations without a request: %j", async ref => {
    const fixture = setup(() => { throw new Error("No media request allowed"); });
    await flush();
    const before = fixture.fetchMock.mock.calls.length;
    await expect(fixture.adapter.downloadImage(JSON.stringify(ref))).rejects.toThrow();
    expect(fixture.fetchMock).toHaveBeenCalledTimes(before);
  });

  it.each(["http://127.1/a", "http://0x7f000001/a", "https://[::ffff:127.0.0.1]/a", "http://10.0.0.1/a", "http://169.254.169.254/a", "http://[fc00::1]/a", "http://localhost/a", "http://machine.local/a", "http://100.64.0.1/a"])("blocks private remote sources: %s", url => {
    expect(() => assertWechatMediaUrl(url, false)).toThrow();
  });

  it.each([KEY.toString("base64"), encodeIlinkMediaAesKey(KEY.toString("hex"))])("decrypts old and full CDN destinations with both key encodings: %s", async aes_key => {
    const bytes = encrypt(Buffer.from("synthetic plaintext"));
    const fixture = setup(() => new Response(new Uint8Array(bytes)));
    for (const ref of [{ full_url: `${CDN}/signed?opaque=SYNTHETIC` }, { encrypt_query_param: "SYNTHETIC_OLD" }]) {
      expect((await fixture.adapter.downloadFileByRef(JSON.stringify({ ...ref, aes_key }))).toString()).toBe("synthetic plaintext");
    }
    const media = fixture.fetchMock.mock.calls.filter(([url]) => String(url).startsWith(CDN));
    expect(media).toHaveLength(2);
    for (const [, init] of media) {
      expect(new Headers(init.headers).get("authorization")).toBeNull();
      expect(new Headers(init.headers).get("authorizationtype")).toBeNull();
      expect(new Headers(init.headers).get("x-wechat-uin")).toBeNull();
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.redirect).toBe("manual");
    }
  });

  it("maps full URL file/video/reference images and prefers image_item.aeskey", async () => {
    const full = `${CDN}/signed?opaque=SYNTHETIC`;
    const media = { full_url: full, aes_key: "SYNTHETIC_WRONG" };
    const fixture = setup(() => new Response(new Uint8Array(encrypt(Buffer.from("image")))) , [
      { type: 2, image_item: { media, aeskey: KEY.toString("hex") } },
      { type: 4, file_item: { media, file_name: "fixture.bin", len: "16" } },
      { type: 5, video_item: { media } },
    ]);
    await flush();
    const message = fixture.onMessage.mock.calls[0][0];
    expect(message).toMatchObject({ agentId: "fixture-agent", chatId: "fixture-user", sessionKey: "wx_dm_fixture-user@fixture-agent" });
    expect(message.attachments.map(item => item.type)).toEqual(["image", "file", "video"]);
    expect(message.attachments.every(item => JSON.parse(item.platformRef).full_url === full)).toBe(true);
    expect((await fixture.adapter.downloadImage(message.attachments[0].platformRef)).toString()).toBe("image");
    fixture.adapter.stop();
    const quoted = setup(() => { throw new Error("No eager download"); }, [{ type: 1, text_item: { text: "quote" }, ref_msg: { message_item: { type: 2, image_item: { media, aeskey: KEY.toString("hex") } } } }]);
    await flush();
    expect(JSON.parse(quoted.onMessage.mock.calls[0][0].attachments[0].platformRef).full_url).toBe(full);
  });

  it("rejects bad keys before network and bad ciphertext without retry or plaintext fallback", async () => {
    const fixture = setup(() => new Response("bad ciphertext"));
    await flush();
    const before = fixture.fetchMock.mock.calls.length;
    await expect(fixture.adapter.downloadImage(JSON.stringify({ full_url: `${CDN}/file`, aes_key: "SYNTHETIC_BAD_KEY" }))).rejects.toThrow("invalid_aes_key");
    expect(fixture.fetchMock).toHaveBeenCalledTimes(before);
    await expect(fixture.adapter.downloadImage(JSON.stringify({ full_url: `${CDN}/file`, aes_key: KEY.toString("base64") }))).rejects.toThrow("decrypt_failed");
    expect(fixture.fetchMock).toHaveBeenCalledTimes(before + 1);
  });
});

describe("WeChat transfer budgets and cancellation", () => {
  it.each(["success", "failure"])("shares concurrent prefetch and attachment reads, then clears a %s", async outcome => {
    let finish!: (response: Response) => void;
    const fixture = setup(() => new Promise(resolve => { finish = resolve; }));
    await flush();
    const before = fixture.fetchMock.mock.calls.length;
    const ref = JSON.stringify({ full_url: `${CDN}/concurrent?signature=SYNTHETIC` });
    const first = fixture.adapter.downloadImage(ref).catch(error => error);
    const second = fixture.adapter.downloadFileByRef(ref).catch(error => error);
    expect(fixture.fetchMock).toHaveBeenCalledTimes(before + 1);
    finish(outcome === "success" ? new Response("fixture") : new Response(null, { status: 503 }));
    expect(await first).toBe(await second);
    const manual = fixture.adapter.downloadImage(ref);
    expect(fixture.fetchMock).toHaveBeenCalledTimes(before + 2);
    finish(new Response("manual read"));
    expect((await manual).toString()).toBe("manual read");
  });

  it("accepts the exact plaintext cap including an AES padding block on the wire", async () => {
    const bytes = encrypt(Buffer.alloc(WECHAT_MEDIA_MAX_BYTES, 42));
    expect(bytes.length).toBe(WECHAT_MEDIA_MAX_BYTES + 16);
    const fixture = setup(() => new Response(new Uint8Array(bytes), { headers: { "content-length": String(bytes.length) } }));
    const result = await fixture.adapter.downloadFileByRef(JSON.stringify({ encrypt_query_param: "SYNTHETIC_SIZE", aes_key: KEY.toString("base64") }));
    expect(result.length).toBe(WECHAT_MEDIA_MAX_BYTES);
    expect(result[0]).toBe(42);
    expect(result.at(-1)).toBe(42);
  });

  it("rejects a plaintext just over the cap even if padded wire bytes fit", async () => {
    const bytes = encrypt(Buffer.alloc(WECHAT_MEDIA_MAX_BYTES + 1, 42));
    const fixture = setup(() => new Response(new Uint8Array(bytes)));
    await expect(fixture.adapter.downloadFileByRef(JSON.stringify({ encrypt_query_param: "SYNTHETIC_SIZE", aes_key: KEY.toString("base64") }))).rejects.toThrow("body_too_large");
  });

  it("rejects an oversized outgoing buffer before upload preparation", async () => {
    const fixture = setup(() => { throw new Error("Unexpected outbound request"); });
    await flush();
    const calls = fixture.fetchMock.mock.calls.length;
    await expect(fixture.adapter.sendMediaBuffer("fixture-user", Buffer.alloc(WECHAT_MEDIA_MAX_BYTES + 1), { mime: "image/png", filename: "fixture.png" })).rejects.toThrow("body_too_large");
    expect(fixture.fetchMock).toHaveBeenCalledTimes(calls);
  });

  it("streams exact bytes and cancels declared or delivered overflow without waiting on cancellation", async () => {
    expect(await readWechatBody(new Response(new Uint8Array([1, 2, 3, 4])), 4)).toEqual(Buffer.from([1, 2, 3, 4]));
    for (const headers of [{}, { "content-length": "5" }]) {
      const { response, cancel } = streamResponse([new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])], headers);
      cancel.mockImplementation(() => new Promise(() => {}));
      await expect(readWechatBody(response, 4)).rejects.toThrow("body_too_large");
      expect(cancel).toHaveBeenCalledOnce();
      expect(response.body.locked).toBe(false);
    }
  });

  it.each(["abort", "timeout"])("cancels a stalled reader on %s and releases its lock", async mode => {
    vi.useFakeTimers();
    const { response, cancel } = streamResponse([new Uint8Array([1])]);
    const controller = new AbortController();
    const result = readWechatBody(response, 4, controller.signal).catch(error => error);
    await flush();
    if (mode === "abort") controller.abort(new Error("SYNTHETIC_SECRET_ABORT"));
    else await vi.advanceTimersByTimeAsync(WECHAT_BODY_TIMEOUT_MS + 1);
    const error = await result;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toContain("SYNTHETIC_SECRET");
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("enforces one deadline against a continuous trickle", async () => {
    vi.useFakeTimers();
    let stream: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ start(c) { stream = c; }, cancel }));
    const result = readWechatBody(response, 100).catch(error => error);
    for (let n = 0; n < 5; n++) { stream.enqueue(new Uint8Array([1])); await vi.advanceTimersByTimeAsync(2_000); }
    expect((await result).message).toContain("timeout");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("times out headers and cleans a late response even when the transport ignores abort", async () => {
    vi.useFakeTimers();
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise(resolve => { finish = resolve; })));
    const pending = fetchWechatMedia(`${CDN}/file`, { signal: new AbortController().signal }).catch(error => error);
    await vi.advanceTimersByTimeAsync(WECHAT_MEDIA_TIMEOUT_MS + 1);
    expect((await pending).message).toContain("timeout");
    const { response, cancel } = streamResponse([]);
    finish(response);
    await flush();
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["remote source", "CDN upload", "API body"])("stops a pending %s body before any final sendmessage", async stage => {
    const { response, cancel } = streamResponse([new Uint8Array([32])], { "x-encrypted-param": "SYNTHETIC_DOWNLOAD" });
    const fixture = setup(url => {
      if (stage === "remote source" && url === "https://source.example.com/file") return response;
      if (url.endsWith("/getuploadurl")) return stage === "API body" ? response : json({ ret: 0, upload_param: "SYNTHETIC_UPLOAD" });
      if (stage === "CDN upload" && url.startsWith(CDN)) return response;
      throw new Error("Unexpected next stage");
    });
    await flush();
    const pending = (stage === "remote source" ? fixture.adapter.sendMedia("fixture-user", "https://source.example.com/file")
      : fixture.adapter.sendMediaBuffer("fixture-user", Buffer.from("fixture"), { mime: "image/png", filename: "fixture.png" })).catch(error => error);
    await flush();
    fixture.adapter.stop();
    expect(await pending).toBeInstanceOf(Error);
    expect(cancel).toHaveBeenCalledOnce();
    expect(fixture.fetchMock.mock.calls.some(([url]) => String(url).endsWith("/sendmessage"))).toBe(false);
  });

  it("bounds Bot API JSON and stops a hung poll body", async () => {
    const { response, cancel } = streamResponse([], { "content-length": String(WECHAT_API_MAX_BYTES + 1) });
    const fixture = setup(() => response);
    await flush();
    await expect(fixture.adapter.getMe()).rejects.toThrow("body_too_large");
    expect(cancel).toHaveBeenCalledOnce();
    fixture.adapter.stop();
    const stalled = streamResponse([]);
    vi.stubGlobal("fetch", vi.fn(async () => stalled.response));
    const onMessage = vi.fn();
    const poller = createWechatAdapter({ botToken: TOKEN, hanaHome: undefined, agentId: "fixture", onMessage, onStatus: vi.fn() });
    adapters.push(poller);
    await flush();
    poller.stop();
    await flush();
    expect(stalled.cancel).toHaveBeenCalledOnce();
    expect(onMessage).not.toHaveBeenCalled();
  });
});

describe("WeChat complete media URL contract", () => {
  it("retains a full_url-only inbound image", async () => {
    const full = `${CDN}/c2c/download?signature=SYNTHETIC_IMAGE`;
    const fixture = setup(() => { throw new Error("Unexpected fetch"); }, [{ type: 2, image_item: { media: { full_url: full } } }]);
    await flush();
    expect(fixture.onMessage).toHaveBeenCalledOnce();
    expect(JSON.parse(fixture.onMessage.mock.calls[0][0].attachments[0].platformRef).full_url).toBe(full);
  });

  it("prefers the full download URL without a second parameter download", async () => {
    const full = `${CDN}/c2c/download?signature=SYNTHETIC_DOWNLOAD`;
    const requests: string[] = [];
    const fixture = setup(url => { requests.push(url); return new Response("plain"); });
    const buffer = await fixture.adapter.downloadImage(JSON.stringify({ full_url: full, encrypt_query_param: "SYNTHETIC_LEGACY" }));
    expect(buffer.toString()).toBe("plain");
    expect(requests).toEqual([full]);
  });

  it("uploads using upload_full_url when upload_param is absent", async () => {
    const full = `${CDN}/c2c/upload?signature=SYNTHETIC_UPLOAD`;
    const uploads: string[] = [];
    const fixture = setup((url, init) => {
      if (url.endsWith("/getuploadurl")) return json({ ret: 0, upload_full_url: full });
      if (url.endsWith("/sendmessage")) return json({ ret: 0 });
      uploads.push(url);
      expect(new Headers(init.headers).has("authorization")).toBe(false);
      return new Response(null, { headers: { "x-encrypted-param": "SYNTHETIC_DOWNLOAD_PARAM" } });
    });
    await flush();
    await fixture.adapter.sendMediaBuffer("fixture-user", Buffer.from("fixture"), { mime: "image/png", filename: "fixture.png" });
    expect(uploads).toEqual([full]);
  });

  it("cancels an in-flight legacy CDN download on stop", async () => {
    let signal: AbortSignal | null | undefined;
    let finish!: (value: Response) => void;
    const fixture = setup((_url, init) => { signal = init.signal; return new Promise(resolve => { finish = resolve; }); });
    const pending = fixture.adapter.downloadFileByRef(JSON.stringify({ encrypt_query_param: "SYNTHETIC_LEGACY" })).catch(error => error);
    await flush();
    fixture.adapter.stop();
    finish(new Response("late"));
    const result = await pending;
    expect(signal?.aborted).toBe(true);
    expect(result).toBeInstanceOf(Error);
  });
});

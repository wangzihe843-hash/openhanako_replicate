import crypto from "node:crypto";
import dns from "node:dns";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createWechatAdapter } from "../lib/bridge/wechat-adapter.ts";
import { fetchWechatMedia } from "../lib/bridge/wechat-media.ts";
import { bridgeHttpLoopback } from "./fixtures/bridge-http-loopback.ts";

const API = "https://ilinkai.weixin.qq.com";
const CDN = "https://novac2c.cdn.weixin.qq.com";
const SOURCE = "https://source.example.com";
const TOKEN = "SYNTHETIC_U13_HTTP_BOT";
const SIGNATURE = "SYNTHETIC_U13_OPAQUE_SIGNATURE";
const CONTEXT = "SYNTHETIC_U13_CONTEXT";
const nativeFetch = globalThis.fetch;
const adapters: ReturnType<typeof createWechatAdapter>[] = [];
let loop: Awaited<ReturnType<typeof bridgeHttpLoopback>>;
beforeAll(async () => { loop = await bridgeHttpLoopback(); });
afterAll(async () => { await loop?.close(); });
afterEach(() => {
  for (const adapter of adapters.splice(0)) adapter.stop();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Explicit transport routing: every real request goes only to an owned local
// HTTP/HTTPS fixture with a verified test CA. No global TLS or DNS weakening.
function setup() {
  loop.reset();
  let polls = 0;
  const fetchSpy = vi.fn<typeof fetch>(async (input, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (url.origin === API && url.pathname.endsWith("/getupdates")) {
      if (++polls === 1) return new Response(JSON.stringify({ ret: 0, msgs: [{ from_user_id: "fixture-user", context_token: CONTEXT, item_list: [{ type: 1, text_item: { text: "hello" } }] }] }));
      return new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), { once: true }));
    }
    if (![API, CDN, SOURCE, "http://source.example.com"].includes(url.origin)) throw new Error("Unexpected fixture destination");
    const origin = url.protocol === "http:" ? loop.downgrade : loop.source;
    return nativeFetch(origin + url.pathname + url.search, { ...init, dispatcher: loop.agent } as RequestInit);
  });
  vi.stubGlobal("fetch", fetchSpy);
  const onMessage = vi.fn();
  const adapter = createWechatAdapter({ botToken: TOKEN, hanaHome: undefined, agentId: "fixture", onMessage, onStatus: vi.fn() });
  adapters.push(adapter);
  return { adapter, fetchSpy, ready: () => vi.waitFor(() => expect(adapter.canReply("fixture-user")).toBe(true)) };
}

function assertNoApiCredentials() {
  const media = [...loop.sourceRequests, ...loop.sinkRequests].filter(request => !request.path.startsWith("/ilink/bot/"));
  for (const request of media) {
    for (const field of ["authorization", "authorizationtype", "x-wechat-uin", "cookie", "referer"]) expect(request.headers[field]).toBeUndefined();
    expect(JSON.stringify(request)).not.toContain(TOKEN);
    expect(JSON.stringify(request)).not.toContain(CONTEXT);
  }
}

describe("WeChat real local HTTP/HTTPS media transport", () => {
  it.each(["image/png", "audio/mpeg", "video/mp4", "application/octet-stream"])("encrypts %s once, prefers the complete upload URL and retains delivery shape", async mime => {
    const fixture = setup();
    let rawKey: Buffer;
    const full = `${CDN}/complete-upload?opaque=${SIGNATURE}`;
    loop.respond((request, response) => {
      if (request.path.endsWith("/getuploadurl")) {
        expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`);
        const payload = JSON.parse(request.body);
        rawKey = Buffer.from(payload.aeskey, "hex");
        response.end(JSON.stringify({ ret: 0, upload_full_url: full, upload_param: "SYNTHETIC_IGNORED" }));
      } else if (request.path.startsWith("/complete-upload")) {
        const decipher = crypto.createDecipheriv("aes-128-ecb", rawKey, null);
        expect(Buffer.concat([decipher.update(request.bodyBytes), decipher.final()]).toString()).toBe("synthetic media");
        response.setHeader("x-encrypted-param", "SYNTHETIC_DOWNLOAD");
        response.end();
      } else if (request.path.endsWith("/sendmessage")) {
        const payload = JSON.parse(request.body);
        expect(payload.msg.context_token).toBe(CONTEXT);
        expect(payload.msg.item_list[0].type).toBe(mime.startsWith("image/") ? 2 : 4);
        response.end('{"ret":0}');
      } else throw new Error("Unexpected fixture path");
    });
    await fixture.ready();
    await fixture.adapter.sendMediaBuffer("fixture-user", Buffer.from("synthetic media"), { mime, filename: "fixture.bin" });
    expect(loop.sourceRequests.map(request => request.path)).toEqual(["/ilink/bot/getuploadurl", `/complete-upload?opaque=${SIGNATURE}`, "/ilink/bot/sendmessage"]);
    assertNoApiCredentials();
    expect(loop.sinkRequests).toEqual([]);
  });

  it("downloads a full URL through validated relative redirects exactly once per hop", async () => {
    const fixture = setup();
    loop.respond((request, response) => {
      if (request.path.startsWith("/start")) { response.writeHead(302, { location: `/final?opaque=${SIGNATURE}` }); response.end("redirect body"); }
      else response.end("synthetic image");
    });
    expect((await fixture.adapter.downloadImage(JSON.stringify({ full_url: `${CDN}/start?opaque=${SIGNATURE}`, encrypt_query_param: "SYNTHETIC_UNUSED" }))).toString()).toBe("synthetic image");
    expect(loop.sourceRequests.map(request => request.path)).toEqual([`/start?opaque=${SIGNATURE}`, `/final?opaque=${SIGNATURE}`]);
    assertNoApiCredentials();
    expect(loop.sinkRequests).toEqual([]);
  });

  it.each(["https://untrusted.example/file", "http://novac2c.cdn.weixin.qq.com/file", "http://169.254.169.254/metadata", "http://127.0.0.1/private", "https://name:pass@novac2c.cdn.weixin.qq.com/file"])("rejects a redirect to %s before contacting it", async destination => {
    const fixture = setup();
    loop.respond((_request, response) => { response.writeHead(302, { location: destination }); response.end(); });
    await expect(fixture.adapter.downloadImage(JSON.stringify({ full_url: `${CDN}/start?opaque=${SIGNATURE}` }))).rejects.toThrow("untrusted_redirect");
    expect(loop.sourceRequests).toHaveLength(1);
    expect(loop.sinkRequests).toEqual([]);
    expect(fixture.fetchSpy.mock.calls.filter(([url]) => !String(url).includes("/getupdates"))).toHaveLength(1);
    assertNoApiCredentials();
  });

  it("bounds redirect loops and reports missing locations without echoing signed URLs", async () => {
    const fixture = setup();
    loop.respond((_request, response) => { response.writeHead(307, { location: `/again?opaque=${SIGNATURE}` }); response.end(); });
    await expect(fixture.adapter.downloadImage(JSON.stringify({ full_url: `${CDN}/again?opaque=${SIGNATURE}` }))).rejects.toThrow("redirect_rejected");
    expect(loop.sourceRequests).toHaveLength(4);
    loop.reset();
    loop.respond((_request, response) => { response.writeHead(302); response.end(); });
    await expect(fixture.adapter.downloadImage(JSON.stringify({ full_url: `${CDN}/missing?opaque=${SIGNATURE}` }))).rejects.toThrow("redirect_missing_location");
    expect(loop.sourceRequests).toHaveLength(1);
  });

  it.each([307, 308, 302])("handles CDN upload redirect %i without changing method or leaking credentials", async status => {
    const fixture = setup();
    loop.respond((request, response) => {
      if (request.path.endsWith("/getuploadurl")) response.end(JSON.stringify({ ret: 0, upload_full_url: `${CDN}/upload-start?opaque=${SIGNATURE}` }));
      else if (request.path.startsWith("/upload-start")) { response.writeHead(status, { location: "/upload-end" }); response.end(); }
      else if (request.path === "/upload-end") { response.setHeader("x-encrypted-param", "SYNTHETIC_DOWNLOAD"); response.end(); }
      else response.end('{"ret":0}');
    });
    await fixture.ready();
    const action = fixture.adapter.sendMediaBuffer("fixture-user", Buffer.from("fixture"), { mime: "image/png", filename: "fixture.png" });
    if (status === 302) {
      await expect(action).rejects.toThrow("redirect_rejected");
      expect(loop.sourceRequests).toHaveLength(2);
    } else {
      await action;
      expect(loop.sourceRequests.filter(request => request.path.startsWith("/upload")).map(request => request.method)).toEqual(["POST", "POST"]);
      expect(loop.sourceRequests[1].bodyBytes).toEqual(loop.sourceRequests[2].bodyBytes);
    }
    assertNoApiCredentials();
  });

  it.each(["https", "http"])("bounds a remote %s source and then uploads without source credentials", async protocol => {
    const fixture = setup();
    loop.respond((request, response) => {
      if (request.path === "/source.bin") response.end("fixture");
      else if (request.path.endsWith("/getuploadurl")) response.end('{"ret":0,"upload_param":"SYNTHETIC_UPLOAD"}');
      else if (request.path.startsWith("/c2c/upload")) { response.setHeader("x-encrypted-param", "SYNTHETIC_DOWNLOAD"); response.end(); }
      else response.end('{"ret":0}');
    });
    await fixture.ready();
    await fixture.adapter.sendMedia("fixture-user", `${protocol}://source.example.com/source.bin`);
    expect([...loop.sourceRequests, ...loop.sinkRequests].filter(request => request.path === "/source.bin")).toHaveLength(1);
    expect(loop.sourceRequests.filter(request => request.path.startsWith("/c2c/upload"))).toHaveLength(1);
    assertNoApiCredentials();
  });

  it.each(["HTTP error", "missing header", "unknown send", "API redirect", "API HTTP signed URL", "API business signed URL", "API HTTP nested URL", "API business nested URL"])("does not retry or leak response secrets on %s", async failure => {
    const fixture = setup();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    loop.respond((request, response) => {
      if (request.path.endsWith("/getuploadurl")) {
        if (failure === "API redirect") { response.writeHead(307, { location: `${CDN}/unexpected` }); response.end(); }
        else if (failure === "API HTTP signed URL") { response.writeHead(503); response.end(JSON.stringify({ upload_full_url: `${CDN}/signed?opaque=${SIGNATURE}` })); }
        else if (failure === "API business signed URL") response.end(JSON.stringify({ ret: 1, errmsg: `media failed ${CDN}/signed?opaque=${SIGNATURE}` }));
        else if (failure.includes("nested URL")) {
          const detail = `https://diagnostic.example.com/error?detail=${encodeURIComponent(`${CDN}/signed?opaque=${SIGNATURE}`)}`;
          if (failure === "API HTTP nested URL") { response.writeHead(503); response.end(JSON.stringify({ error: { detail } })); }
          else response.end(JSON.stringify({ ret: 1, errmsg: detail }));
        }
        else response.end('{"ret":0,"upload_param":"SYNTHETIC_UPLOAD"}');
      } else if (request.path.startsWith("/c2c/upload")) {
        if (failure === "HTTP error") { response.writeHead(503, { "x-error-message": SIGNATURE }); response.end(`${TOKEN} ${CDN}/signed?opaque=${SIGNATURE}`); }
        else { if (failure !== "missing header") response.setHeader("x-encrypted-param", "SYNTHETIC_DOWNLOAD"); response.end(); }
      } else response.destroy(); // sendmessage may have been accepted; never replay.
    });
    await fixture.ready();
    const error = await fixture.adapter.sendMediaBuffer("fixture-user", Buffer.from("fixture"), { mime: "image/png", filename: "fixture.png" }).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(SIGNATURE);
    expect(String(error)).not.toContain(TOKEN);
    expect(JSON.stringify(consoleSpy.mock.calls)).not.toContain(SIGNATURE);
    expect(loop.sourceRequests.filter(request => request.path.endsWith("/getuploadurl"))).toHaveLength(1);
    expect(loop.sourceRequests.filter(request => request.path.startsWith("/c2c/upload"))).toHaveLength(failure.startsWith("API ") ? 0 : 1);
    expect(loop.sourceRequests.filter(request => request.path.endsWith("/sendmessage"))).toHaveLength(failure === "unknown send" ? 1 : 0);
    expect(loop.sinkRequests).toEqual([]);
    assertNoApiCredentials();
  });

  it("closes a real incomplete response when the adapter stops", async () => {
    const fixture = setup();
    let closed = false;
    loop.respond((_request, response) => { response.on("close", () => { closed = true; }); response.writeHead(200); response.write("partial"); });
    const pending = fixture.adapter.downloadFileByRef(JSON.stringify({ full_url: `${CDN}/slow` })).catch(error => error);
    await vi.waitFor(() => expect(loop.sourceRequests).toHaveLength(1));
    fixture.adapter.stop();
    expect(await pending).toBeInstanceOf(Error);
    await vi.waitFor(() => expect(closed).toBe(true));
    expect(loop.sinkRequests).toEqual([]);
  });

  it.each([{ addresses: ["127.0.0.1"] }, { addresses: ["93.184.216.34", "127.0.0.1"] }, { addresses: ["::ffff:127.0.0.1"] }])("checks the actual connector DNS result before opening a socket: %j", async ({ addresses }) => {
    loop.reset();
    const lookup = vi.spyOn(dns, "lookup").mockImplementation(((hostname, options, callback) => {
      expect(hostname).toBe("novac2c.cdn.weixin.qq.com");
      queueMicrotask(() => callback(null, addresses.map(address => ({ address, family: address.includes(":") ? 6 : 4 }))));
    }) as typeof dns.lookup);
    await expect(fetchWechatMedia(`${CDN}/file`, { signal: new AbortController().signal })).rejects.toThrow("request_failed");
    expect(lookup).toHaveBeenCalledOnce();
    expect(loop.sourceRequests).toEqual([]);
    expect(loop.sinkRequests).toEqual([]);
  });
});

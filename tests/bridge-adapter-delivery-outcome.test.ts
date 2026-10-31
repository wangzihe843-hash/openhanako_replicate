import { EventEmitter } from "node:events";
import net from "node:net";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("undici", async importOriginal => ({ ...await importOriginal<typeof import("undici")>(), fetch: transport.fetch }));
vi.mock("ws", () => ({ default: class {
  static OPEN = 1;
  readyState = 0;
  on() {}
  send() {}
  close() {}
} }));
vi.mock("../lib/debug-log.ts", () => ({ debugLog: () => null, createModuleLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

import { BridgeManager } from "../lib/bridge/bridge-manager.ts";
import { createQQAdapter } from "../lib/bridge/qq-adapter.ts";
import { createDingTalkAdapter } from "../lib/bridge/dingtalk-adapter.ts";
import { createWechatAdapter } from "../lib/bridge/wechat-adapter.ts";
import { createTelegramAdapter } from "../lib/bridge/telegram-adapter.ts";
import { unknownDeliveryFailure } from "../shared/errors.ts";

type Platform = "qq" | "dingtalk" | "wechat" | "telegram";
type Send = (init: RequestInit, attempt: number, method: string) => Response | Promise<Response>;
const platforms: Platform[] = ["qq", "dingtalk", "wechat", "telegram"];
const cleaners: (() => unknown)[] = [];
let serial = 0;
const TOKEN = "SYNTHETIC_TOKEN_PRIVATE";
const CONTEXT = "SYNTHETIC_CONTEXT_PRIVATE";
class FakeSocket extends EventEmitter {
  static OPEN = 1;
  readyState = 0;
  send() {}
  close() { this.emit("close"); }
  terminate() { this.close(); }
}
function pending(signal?: AbortSignal | null): Promise<Response> {
  return new Promise((_, reject) => {
    if (signal?.aborted) reject(signal.reason);
    else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
function ack(platform: Platform) {
  return Response.json(platform === "dingtalk" ? { processQueryKey: "synthetic-receipt" }
    : platform === "wechat" ? { ret: 0 }
      : platform === "telegram" ? { ok: true, result: { message_id: 1 } } : { id: "synthetic-receipt" });
}
function rejection(platform: Platform, status = 400) {
  return Response.json(platform === "telegram" ? { ok: false, error_code: status, description: "synthetic rejection" }
    : platform === "wechat" ? { ret: 42, errmsg: "synthetic rejection" }
      : { code: 42, message: "synthetic rejection" }, { status });
}
async function fixture(platform: Platform, send: Send, options: { fallback?: boolean; noContext?: boolean; badToken?: boolean; uploadFailure?: boolean } = {}) {
  let attempts = 0;
  let polls = 0;
  const methods: string[] = [];
  const onStatus = vi.fn();
  const fetch = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const method = new URL(String(input)).pathname.split("/").at(-1)!;
    methods.push(method);
    if (["messages", "batchSend", "send", "sendmessage", "sendMessage", "sendRichMessage", "sendPhoto", "sendVideo", "sendAudio", "sendDocument"].includes(method)) return send(init, ++attempts, method);
    if (method === "connections" || method === "open") return Response.json({ endpoint: "wss://synthetic.invalid/ws", ticket: "synthetic-ticket" });
    if (method === "token" || method === "getAppAccessToken") return options.badToken ? Response.json({ code: "invalid_token" }, { status: 401 })
      : Response.json({ access_token: TOKEN, expires_in: 7200 });
    if (method === "gateway") return Response.json({ url: "wss://synthetic.invalid/ws" });
    if (method === "files" || method === "getuploadurl") {
      if (options.uploadFailure) throw Error("synthetic upload failed before any message send");
      return Response.json({ file_info: "synthetic-file", upload_param: "synthetic-upload" });
    }
    if (method === "upload") return new Response("", { headers: { "x-encrypted-param": "synthetic-download" } });
    if (method === "getMe") return Response.json({ ok: true, result: { id: 42, is_bot: true, first_name: "Synthetic" } });
    if (method === "getUpdates") return pending(init.signal);
    if (method === "getupdates") return ++polls === 1 ? Response.json({ ret: 0, msgs: options.noContext ? [] : [{ from_user_id: "synthetic-owner", context_token: CONTEXT, item_list: [{ type: 1, text_item: { text: "hello" } }] }] }) : pending(init.signal);
    if (["sendChatAction", "sendMessageDraft", "sendRichMessageDraft"].includes(method)) return send(init, attempts, method);
    throw Error("Unexpected synthetic request: " + method);
  });
  transport.fetch.mockImplementation(fetch);
  vi.stubGlobal("fetch", fetch);
  const agentId = `cp-outcome-${++serial}`;
  const adapter = platform === "qq" ? createQQAdapter({ appID: "synthetic-app", appSecret: "synthetic-secret", agentId, onMessage: vi.fn(), onStatus, dmGuildMap: undefined, onDmGuildDiscovered: undefined })
    : platform === "dingtalk" ? createDingTalkAdapter({ corpId: "synthetic-corp", clientId: "synthetic-client", clientSecret: "synthetic-secret", robotCode: "synthetic-robot", agentId, onMessage: vi.fn(), onStatus, fetchImpl: fetch, WebSocketImpl: FakeSocket })
      : platform === "wechat" ? createWechatAdapter({ botToken: TOKEN, agentId, onMessage: vi.fn(), onStatus, hanaHome: undefined })
        : createTelegramAdapter({ token: TOKEN, agentId, onMessage: vi.fn(), onStatus, fetch });
  const agent = { config: { bridge: Object.fromEntries(platforms.map(p => [p, { owner: "synthetic-owner" }])) } };
  const bm = new BridgeManager({ engine: { hanakoHome: os.tmpdir(), getAgent: () => agent, getBridgeIndex: () => ({}) }, hub: { eventBus: { emit: vi.fn() } } });
  bm._platforms.set(`${platform}:${agentId}`, { platform, agentId, status: "connected", adapter });
  const fallback = vi.fn();
  if (options.fallback !== false) {
    const other = platform === "telegram" ? "dingtalk" : "telegram";
    bm._platforms.set(`${other}:${agentId}`, { platform: other, agentId, status: "connected", adapter: { sendReply: fallback, stop() {} } });
  }
  cleaners.push(() => bm.stopAll());
  if (platform === "wechat" && !options.noContext) await vi.waitFor(() => expect((adapter as ReturnType<typeof createWechatAdapter>).canReply("synthetic-owner")).toBe(true));
  // Let startup finish without opening any socket or real account.
  await new Promise(resolve => setImmediate(resolve));
  return {
    adapter, bm, fallback, methods, onStatus, agentId, get attempts() { return attempts; },
    send: (text = "synthetic once", key = "same-key") => bm.sendProactive(text, agentId, { contextPolicy: "none", idempotencyKey: key }),
  };
}

beforeEach(() => {
  transport.fetch.mockReset();
  vi.spyOn(net.Socket.prototype, "connect").mockImplementation(() => { throw Error("REAL_NETWORK_FORBIDDEN"); });
  vi.stubGlobal("fetch", () => { throw Error("REAL_FETCH_FORBIDDEN"); });
});
afterEach(async () => {
  for (const clean of cleaners.splice(0)) await clean();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(platforms)("%s persistent delivery outcomes through the real Manager", platform => {
  it.each(["lost", "invalid-json", "empty", "body-reset", "server"])("retains unknown after %s and suppresses fallback and same-key replay", async failure => {
    const f = await fixture(platform, () => {
      if (failure === "lost") throw Error("synthetic response lost");
      if (failure === "invalid-json") return new Response("{");
      if (failure === "empty") return new Response("");
      if (failure === "body-reset") return new Response(new ReadableStream({ start(c) { c.error(Error("synthetic body reset")); } }));
      return rejection(platform, 503);
    });
    const first = await f.send();
    const second = await f.send();
    expect(first.deliveryUnknown).toBe(true);
    expect(first.deliveries[0].status).toBe("unknown");
    expect(first.failure.retryable).toBe(false);
    expect(second.skipped).toBe(true);
    expect(f.attempts).toBe(1);
    expect(f.fallback).not.toHaveBeenCalled();
  });

  it("retains the same key with no available fallback", async () => {
    const f = await fixture(platform, () => { throw Error("synthetic response lost"); }, { fallback: false });
    expect((await f.send()).deliveryUnknown).toBe(true);
    expect((await f.send()).skipped).toBe(true);
    expect(f.attempts).toBe(1);
  });

  it("does not retry after a dispatched send is stopped", async () => {
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const f = await fixture(platform, init => { entered(); return pending(init.signal); });
    const sending = f.send();
    await ready;
    await f.bm.stopPlatform(platform, f.agentId);
    expect((await sending).deliveryUnknown).toBe(true);
    expect((await f.send()).skipped).toBe(true);
    expect(f.attempts).toBe(1);
    expect(f.fallback).not.toHaveBeenCalled();
  });

  it("allows established fallback after a definite HTTP rejection", async () => {
    const f = await fixture(platform, () => rejection(platform));
    expect((await f.send()).deliveryUnknown).not.toBe(true);
    expect(f.fallback).toHaveBeenCalledOnce();
  });

  it("can try a fresh same-key attempt after a definite failure with no fallback", async () => {
    const f = await fixture(platform, () => rejection(platform), { fallback: false });
    expect((await f.send()).deliveryUnknown).not.toBe(true);
    const before = f.attempts;
    expect((await f.send()).skipped).not.toBe(true);
    expect(f.attempts).toBe(before * 2);
  });

  it("allows established fallback when stopped before dispatch", async () => {
    const f = await fixture(platform, () => ack(platform));
    await f.adapter.stop();
    expect((await f.send()).deliveryUnknown).not.toBe(true);
    expect(f.attempts).toBe(0);
    expect(f.fallback).toHaveBeenCalledOnce();
  });

  it("keeps acknowledged sends successful and deduplicates their key", async () => {
    const f = await fixture(platform, () => ack(platform));
    expect((await f.send()).deliveries[0].status).toBe("sent");
    expect((await f.send()).skipped).toBe(true);
    expect(f.attempts).toBe(1);
    expect(f.fallback).not.toHaveBeenCalled();
  });

  it("does not resend the whole text after an acknowledged chunk and a rejected chunk", async () => {
    const f = await fixture(platform, (_init, attempt) => attempt === 1 ? ack(platform) : rejection(platform));
    expect((await f.send("x ".repeat(7_000))).deliveryUnknown).toBe(true);
    expect((await f.send("x ".repeat(7_000))).skipped).toBe(true);
    expect(f.attempts).toBe(2);
    expect(f.fallback).not.toHaveBeenCalled();
  });

  it("does not replay a concurrent same-key call", async () => {
    let entered!: () => void;
    let finish!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const f = await fixture(platform, () => new Promise((_, reject) => { entered(); finish = () => reject(Error("synthetic response lost")); }));
    const first = f.send();
    await ready;
    const duplicate = f.send();
    finish();
    const result = await first;
    expect(result.deliveryUnknown).toBe(true);
    expect(await duplicate).toEqual(result);
    expect((await f.send()).skipped).toBe(true);
    expect(f.attempts).toBe(1);
    expect(f.fallback).not.toHaveBeenCalled();
  });
});

describe("definite pre-send and business failures", () => {
  it.each(["qq", "dingtalk"] as Platform[])("%s token failure allows fallback without dispatch", async platform => {
    const f = await fixture(platform, () => ack(platform), { badToken: true });
    expect((await f.send()).deliveryUnknown).not.toBe(true);
    expect(f.attempts).toBe(0);
    expect(f.fallback).toHaveBeenCalledOnce();
  });
  it("WeChat missing context allows fallback without dispatch", async () => {
    const f = await fixture("wechat", () => ack("wechat"), { noContext: true });
    expect((await f.send()).deliveryUnknown).not.toBe(true);
    expect(f.attempts).toBe(0);
    expect(f.fallback).toHaveBeenCalledOnce();
  });
  it.each(platforms)("%s explicit business rejection allows fallback", async platform => {
    const f = await fixture(platform, () => platform === "telegram" ? Response.json({ ok: false, error_code: 400, description: "rejected" })
      : platform === "wechat" ? Response.json({ ret: -14 }) : Response.json({ code: 42, message: "rejected" }));
    expect((await f.send()).deliveryUnknown).not.toBe(true);
    expect(f.fallback).toHaveBeenCalledOnce();
  });
});

describe("DingTalk send acknowledgement shape", () => {
  it.each(["{", "", "[]", '"accepted"', "null", "{}", '{"code":0}', '{"code":{}}', '{"processQueryKey":null}'])("does not treat %s as sent", async body => {
    const f = await fixture("dingtalk", () => new Response(body));
    expect((await f.send()).deliveryUnknown).toBe(true);
    expect(f.fallback).not.toHaveBeenCalled();
    expect(f.attempts).toBe(1);
  });
  it.each(["dm", "group"])("accepts a %s processQueryKey without a code field", async targetScope => {
    const f = await fixture("dingtalk", () => ack("dingtalk"));
    await expect((f.adapter as ReturnType<typeof createDingTalkAdapter>).sendReply("synthetic-owner", "hello", { targetScope })).resolves.toEqual({ processQueryKey: "synthetic-receipt" });
    expect(f.attempts).toBe(1);
  });
});

describe("media, body budgets and safe unknown diagnostics", () => {
  it.each(["qq", "wechat"] as Platform[])("%s preserves unknown at the final media message boundary", async platform => {
    const f = await fixture(platform, () => { throw Error("synthetic response lost"); });
    const sending = platform === "qq"
      ? (f.adapter as ReturnType<typeof createQQAdapter>).sendMedia("synthetic-owner", "https://synthetic.invalid/image.png", { isGroup: false })
      : (f.adapter as ReturnType<typeof createWechatAdapter>).sendMediaBuffer("synthetic-owner", Buffer.from("synthetic bytes"), { mime: "image/png", filename: "synthetic.png" });
    await expect(sending).rejects.toMatchObject({ deliveryUnknown: true, retryable: false });
    expect(f.attempts).toBe(1);
  });
  it.each(["qq", "wechat"] as Platform[])("%s leaves upload failure definite before a media message exists", async platform => {
    const f = await fixture(platform, () => ack(platform), { uploadFailure: true });
    const sending = platform === "qq"
      ? (f.adapter as ReturnType<typeof createQQAdapter>).sendMedia("synthetic-owner", "https://synthetic.invalid/image.png", { isGroup: false })
      : (f.adapter as ReturnType<typeof createWechatAdapter>).sendMediaBuffer("synthetic-owner", Buffer.from("synthetic bytes"), { mime: "image/png", filename: "synthetic.png" });
    expect(unknownDeliveryFailure(await sending.catch(error => error))).toBeNull();
    expect(f.attempts).toBe(0);
  });
  it.each(["dingtalk", "wechat"] as Platform[])("%s body timeout stays unknown and cancels the reader", async platform => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const f = await fixture(platform, () => new Response(body));
    vi.useFakeTimers();
    const sending = f.send();
    await vi.advanceTimersByTimeAsync(10_001);
    expect((await sending).deliveryUnknown).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(f.attempts).toBe(1);
    expect(f.fallback).not.toHaveBeenCalled();
  });
  it.each(["dingtalk", "wechat"] as Platform[])("%s oversized body stays unknown", async platform => {
    const f = await fixture(platform, () => new Response("x".repeat(1024 * 1024 + 1)));
    expect((await f.send()).deliveryUnknown).toBe(true);
    expect(f.attempts).toBe(1);
    expect(f.fallback).not.toHaveBeenCalled();
  });
  it.each(platforms)("%s does not expose opaque bodies or credentials through unknown diagnostics", async platform => {
    const f = await fixture(platform, () => new Response(`{${TOKEN} ${CONTEXT} SYNTHETIC_BODY_PRIVATE`, { status: 503 }));
    const result = await f.send();
    expect(result.deliveryUnknown).toBe(true);
    expect(JSON.stringify([result, f.onStatus.mock.calls])).not.toMatch(/SYNTHETIC_TOKEN_PRIVATE|SYNTHETIC_CONTEXT_PRIVATE|SYNTHETIC_BODY_PRIVATE/);
  });
});

describe("Telegram HTTP evidence through the installed SDK and real Manager", () => {
  describe.each([400, 401, 403, 404, 429])("HTTP %i rejection", status => {
    it.each(["{}", "{", "string-code"])("retains fallback with %s and deduplicates its successful result", async body => {
      const payload = body === "string-code" ? JSON.stringify({ ok: false, error_code: String(status) }) : body;
      const f = await fixture("telegram", () => new Response(payload, { status }));
      const first = await f.send();
      expect(first.deliveryUnknown).not.toBe(true);
      expect(first.deliveries.map(({ platform, status }) => ({ platform, status }))).toEqual([{ platform: "dingtalk", status: "sent" }]);
      expect((await f.send()).skipped).toBe(true);
      expect(f.attempts).toBe(1);
      expect(f.fallback).toHaveBeenCalledOnce();
    });
    it.each(["{}", "{", "string-code"])("allows a new same-key attempt with %s and no fallback", async body => {
      const payload = body === "string-code" ? JSON.stringify({ ok: false, error_code: String(status) }) : body;
      const f = await fixture("telegram", () => new Response(payload, { status }), { fallback: false });
      const first = await f.send();
      const second = await f.send();
      expect(first.deliveryUnknown).not.toBe(true);
      expect(first.deliveries[0].status).toBe("failed");
      expect(second.deliveryUnknown).not.toBe(true);
      expect(second.skipped).not.toBe(true);
      expect(f.attempts).toBe(2);
      expect(f.fallback).not.toHaveBeenCalled();
    });
  });

  it.each([200, 408, 499, 503])("retains unknown for HTTP %i without rejection evidence", async status => {
    const f = await fixture("telegram", () => Response.json({}, { status }));
    expect((await f.send()).deliveryUnknown).toBe(true);
    expect((await f.send()).skipped).toBe(true);
    expect(f.attempts).toBe(1);
    expect(f.fallback).not.toHaveBeenCalled();
  });

  it("does not let a contradictory body error code override observed HTTP 503", async () => {
    const f = await fixture("telegram", () => Response.json({ ok: false, error_code: 400, description: "contradictory error" }, { status: 503 }));
    expect((await f.send()).deliveryUnknown).toBe(true);
    expect((await f.send()).skipped).toBe(true);
    expect(f.attempts).toBe(1);
    expect(f.fallback).not.toHaveBeenCalled();
  });

  it.each([400, 403, 429])("preserves an acknowledged send despite HTTP %i", async status => {
    const f = await fixture("telegram", () => Response.json({ ok: true, result: { message_id: 1 } }, { status }));
    expect((await f.send()).deliveries[0].status).toBe("sent");
    expect((await f.send()).skipped).toBe(true);
    expect(f.attempts).toBe(1);
    expect(f.fallback).not.toHaveBeenCalled();
  });

  it.each([400, 403, 429])("keeps partial delivery unknown when a later chunk gets HTTP %i without a valid envelope", async status => {
    const f = await fixture("telegram", (_init, attempt) => attempt === 1 ? ack("telegram") : Response.json({}, { status }));
    expect((await f.send("x ".repeat(7_000))).deliveryUnknown).toBe(true);
    expect((await f.send("x ".repeat(7_000))).skipped).toBe(true);
    expect(f.attempts).toBe(2);
    expect(f.fallback).not.toHaveBeenCalled();
  });

  it.each([400, 403, 429, 200, 408, 503])("keeps HTTP %i evidence when stop interrupts the response body", async status => {
    let entered!: () => void;
    const reading = new Promise<void>(resolve => { entered = resolve; });
    const f = await fixture("telegram", init => new class extends Response {
      override async text() {
        entered();
        await pending(init.signal);
        return "";
      }
    }("", { status }));
    const sending = f.send();
    await reading;
    await f.adapter.stop();
    const result = await sending;
    if ([400, 403, 429].includes(status)) {
      expect(result.deliveryUnknown).not.toBe(true);
      expect(result.deliveries.map(({ platform, status }) => ({ platform, status }))).toEqual([{ platform: "dingtalk", status: "sent" }]);
      expect(f.fallback).toHaveBeenCalledOnce();
    } else {
      expect(result.deliveryUnknown).toBe(true);
      expect(f.fallback).not.toHaveBeenCalled();
    }
    expect((await f.send()).skipped).toBe(true);
    expect(f.attempts).toBe(1);
  });

  it.each(["sendPhoto", "sendVideo", "sendAudio", "sendDocument", "sendRichMessage"])("retains a malformed HTTP 403 rejection for %s", async method => {
    const f = await fixture("telegram", () => Response.json({}, { status: 403 }));
    const adapter = f.adapter as ReturnType<typeof createTelegramAdapter>;
    const ext = { sendPhoto: "png", sendVideo: "mp4", sendAudio: "mp3", sendDocument: "pdf" }[method];
    const error = await (method === "sendRichMessage" ? adapter.sendRichReply("synthetic-owner", "final") : adapter.sendMedia("synthetic-owner", `https://synthetic.invalid/media.${ext}`)).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(unknownDeliveryFailure(error)).toBeNull();
    expect(f.methods.filter(value => value === method)).toHaveLength(1);
  });

  it("keeps distinct concurrent calls and their keys isolated when responses finish in reverse order", async () => {
    let entered!: () => void;
    let finishFirst!: (response: Response) => void;
    const reading = new Promise<void>(resolve => { entered = resolve; });
    const f = await fixture("telegram", (_init, attempt) => {
      if (attempt === 1) {
        entered();
        return new Promise(resolve => { finishFirst = resolve; });
      }
      return Response.json({}, { status: attempt === 2 ? 200 : 400 });
    }, { fallback: false });
    const first = f.send("A", "key-A");
    await reading;
    const second = await f.send("B", "key-B");
    finishFirst(Response.json({}, { status: 400 }));
    const firstResult = await first;
    expect(second.deliveryUnknown).toBe(true);
    expect(firstResult.deliveryUnknown).not.toBe(true);
    expect((await f.send("A", "key-A")).skipped).not.toBe(true);
    expect((await f.send("B", "key-B")).skipped).toBe(true);
    expect(f.attempts).toBe(3);
    expect(f.fallback).not.toHaveBeenCalled();
  });
});

describe("Telegram SDK preparation and transient operations", () => {
  it("does not classify an abort during SDK parameter preparation as a dispatched write", async () => {
    const f = await fixture("telegram", () => ack("telegram"));
    const sending = f.adapter.sendReply("synthetic-owner", "hello").catch(error => error);
    const stopped = f.adapter.stop();
    expect(unknownDeliveryFailure(await sending)).toBeNull();
    await stopped;
    expect(f.attempts).toBe(0);
  });
  it.each(["sendPhoto", "sendVideo", "sendAudio", "sendDocument", "sendRichMessage"])("preserves unknown for stopped %s", async method => {
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const f = await fixture("telegram", init => { entered(); return pending(init.signal); });
    const adapter = f.adapter as ReturnType<typeof createTelegramAdapter>;
    const ext = { sendPhoto: "png", sendVideo: "mp4", sendAudio: "mp3", sendDocument: "pdf" }[method];
    const sending = (method === "sendRichMessage" ? adapter.sendRichReply("synthetic-owner", "final") : adapter.sendMedia("synthetic-owner", `https://synthetic.invalid/media.${ext}`)).catch(error => error);
    await ready;
    await adapter.stop();
    expect(unknownDeliveryFailure(await sending)?.deliveryUnknown).toBe(true);
    expect(f.methods.filter(value => value === method)).toHaveLength(1);
  });
  it.each(["sendMessageDraft", "sendRichMessageDraft"])("keeps %s network failure transient", async method => {
    const f = await fixture("telegram", () => { throw Error("synthetic response lost"); });
    const adapter = f.adapter as ReturnType<typeof createTelegramAdapter>;
    const error = await (method === "sendMessageDraft" ? adapter.sendDraft("synthetic-owner", "draft", { draftId: 1 }) : adapter.sendRichDraft("synthetic-owner", "draft", { draftId: 1 })).catch(error => error);
    expect(unknownDeliveryFailure(error)).toBeNull();
  });
  it("keeps typing best-effort", async () => {
    const f = await fixture("telegram", () => { throw Error("synthetic response lost"); });
    await expect((f.adapter as ReturnType<typeof createTelegramAdapter>).sendTypingIndicator("synthetic-owner")).resolves.toBeUndefined();
    expect(f.attempts).toBe(0);
  });
  it("does not turn a stopped persistent rich completion into plain fallback", async () => {
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const f = await fixture("telegram", (init, _attempt, method) => {
      if (method.includes("Draft")) return ack("telegram");
      entered(); return pending(init.signal);
    });
    const stream = f.bm._createStreamDelivery({ adapter: f.adapter, chatId: "synthetic-owner", isGroup: false, platform: "telegram", messageThreadId: undefined, replyContext: null });
    const sending = stream.finish("final text").catch(error => error);
    await ready;
    await f.adapter.stop();
    expect(unknownDeliveryFailure(await sending)?.deliveryUnknown).toBe(true);
    expect(f.methods.filter(method => method === "sendRichMessage")).toHaveLength(1);
    expect(f.methods).not.toContain("sendMessage");
  });
});

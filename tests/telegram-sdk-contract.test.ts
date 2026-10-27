import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { createTelegramAdapter } from "../lib/bridge/telegram-adapter.ts";
import { telegramFixture as fixture, telegramOk as ok, telegramPending as pending, stopTelegramFixtures, registerTelegramFixture } from "./helpers/telegram-sdk-harness.ts";

const require = createRequire(import.meta.url);
afterEach(stopTelegramFixtures);

describe("Telegram 2.1 published SDK through the actual adapter", () => {
  it("loads named CJS/ESM exports and starts Context polling after getMe", async () => {
    const cjs = require("node-telegram-bot-api");
    const esm = await import("node-telegram-bot-api");
    for (const name of ["Bot", "Api", "InputFile", "Context"]) {
      expect(typeof cjs[name]).toBe("function");
      expect(typeof esm[name]).toBe("function");
    }
    const f = fixture();
    await vi.waitFor(() => expect(f.calls.map(c => c.method)).toEqual(["getMe", "getUpdates"]));
    expect(f.onStatus).toHaveBeenCalledWith("connected");
  });

  it("sends HTML/topic and structured rich drafts without double encoding", async () => {
    const f = fixture();
    await f.adapter.sendReply("123", "**bold**", { messageThreadId: 7 });
    await f.adapter.sendDraft("123", "stream", { draftId: 11, messageThreadId: 7 });
    await f.adapter.sendRichDraft("123", "**rich**", { draftId: 12 });
    await f.adapter.sendRichReply("123", "# Final");
    const params = (method: string) => Object.fromEntries(f.calls.find(c => c.method === method)!.params);
    expect(params("sendMessage")).toMatchObject({ chat_id: "123", text: "<b>bold</b>", parse_mode: "HTML", message_thread_id: "7" });
    expect(params("sendMessageDraft")).toMatchObject({ text: "stream", draft_id: "11", message_thread_id: "7" });
    expect(JSON.parse(params("sendRichMessageDraft").rich_message)).toEqual({ markdown: "**rich**" });
    expect(JSON.parse(params("sendRichMessage").rich_message)).toEqual({ markdown: "# Final" });
  });
});

describe("Telegram polling and send lifecycle", () => {
  it.each([401, 403, 409])("exits on %d without resetting webhook or retrying", async error_code => {
    const f = fixture({ getUpdates: () => Response.json({ ok: false, error_code, description: "synthetic failure" }, { status: error_code }) });
    await vi.waitFor(() => expect(f.onStatus).toHaveBeenCalledWith("error", expect.stringContaining(String(error_code))));
    await f.adapter.stop();
    expect(f.calls.filter(c => c.method === "getUpdates")).toHaveLength(1);
    expect(f.calls.map(c => c.method)).not.toContain("deleteWebhook");
    expect(f.calls.map(c => c.method)).not.toContain("setWebhook");
    await expect(f.adapter.sendReply("1", "late")).rejects.toThrow();
  });
  it("does not announce connected when getMe fails", async () => {
    const f = fixture({ getMe: () => Response.json({ ok: false, error_code: 401, description: "invalid" }, { status: 401 }) });
    await vi.waitFor(() => expect(f.onStatus).toHaveBeenCalledWith("error", expect.any(String)));
    expect(f.onStatus).not.toHaveBeenCalledWith("connected");
    expect(f.calls.map(c => c.method)).toEqual(["getMe"]);
  });
  it.each([429, 500, "network", "timeout", "body"])("never retries sends after %s; preserves safe classification", async failure => {
    const f = fixture({ sendMessage: () => {
      if (failure === "network") throw new Error("synthetic socket reset");
      if (failure === "timeout") throw new DOMException("synthetic timeout", "TimeoutError");
      if (failure === "body") return new Response(new ReadableStream({ start(c) { c.error(new Error("synthetic body reset")); } }));
      return Response.json({ ok: false, error_code: failure, description: "synthetic API error", parameters: { retry_after: 7 } }, { status: failure as number });
    } });
    const error = await f.adapter.sendReply("123", "once").catch(e => e);
    expect(error).toBeInstanceOf(Error);
    expect(f.calls.filter(c => c.method === "sendMessage")).toHaveLength(1);
    if (failure === 429) expect(error).toMatchObject({ errorCode: 429, retryAfter: 7 });
    if (failure === "timeout") expect(error.code).toBe("ETIMEOUT");
    if (failure === "network" || failure === "body") expect(error.code).toBe("EFETCH");
  });
  it("polls safely again after 429 and keeps offset unchanged", async () => {
    let count = 0;
    const f = fixture({ getUpdates: (_p, init) => ++count === 1
      ? Response.json({ ok: false, error_code: 429, description: "flood", parameters: { retry_after: 0 } }, { status: 429 })
      : count === 2 ? ok([]) : pending(init.signal) });
    await vi.waitFor(() => expect(count).toBe(3));
    expect(f.calls.filter(c => c.method === "getUpdates").map(c => c.params.get("offset"))).toEqual([null, null, null]);
    expect(f.onStatus).toHaveBeenCalledWith("connecting", expect.stringContaining("retry_after=0s"));
    expect(f.onStatus.mock.calls.at(-1)).toEqual(["connected"]);
  });
  it.each([500, "network", "timeout"])("recovers a transient polling %s failure", async failure => {
    let count = 0;
    const f = fixture({ getUpdates: (_p, init) => {
      if (++count !== 1) return pending(init.signal);
      if (failure === "network") throw new Error("synthetic reset");
      if (failure === "timeout") throw new DOMException("synthetic timeout", "TimeoutError");
      return Response.json({ ok: false, error_code: 500, description: "server error" }, { status: 500 });
    } });
    await vi.waitFor(() => expect(count).toBe(2), { timeout: 2000 });
    expect(f.onStatus).toHaveBeenCalledWith("connecting", expect.any(String));
  });
  it("aborts pending getUpdates and body reads before stop resolves", async () => {
    const f = fixture();
    await vi.waitFor(() => expect(f.calls.some(c => c.method === "getUpdates")).toBe(true));
    const signal = f.calls.find(c => c.method === "getUpdates")!.init.signal!;
    await f.adapter.stop();
    expect(signal.aborted).toBe(true);
    let bodyAborted = false;
    const g = fixture({ getUpdates: (_p, init) => new Response(new ReadableStream({ start(controller) {
      init.signal!.addEventListener("abort", () => { bodyAborted = true; controller.error(init.signal!.reason); }, { once: true });
    } })) });
    await vi.waitFor(() => expect(g.calls.some(c => c.method === "getUpdates")).toBe(true));
    await g.adapter.stop();
    expect(bodyAborted).toBe(true);
  });
  it("aborts a pending file body and prevents later sends and block delay", async () => {
    let cancelled = false;
    const f = fixture({ getFile: () => ok({ file_path: "files/pending" }), pending: () => new Response(new ReadableStream({ cancel() { cancelled = true; } })) });
    const download = f.adapter.downloadFileByRef("file").catch(e => e);
    await f.adapter.sendBlockReply("1", "first");
    const delayed = f.adapter.sendBlockReply("1", "never").catch(e => e);
    await vi.waitFor(() => expect(f.calls.some(c => c.method === "pending")).toBe(true));
    await f.adapter.stop();
    expect(await download).toBeInstanceOf(Error);
    expect(await delayed).toBeInstanceOf(Error);
    expect(cancelled).toBe(true);
    expect(f.calls.filter(c => c.method === "sendMessage")).toHaveLength(1);
  });
  it("does not hand off a message if stopped during profile resolution", async () => {
    const f = fixture({
      getUpdates: () => ok([{ update_id: 11, message: { text: "late", chat: { id: 1, type: "private" }, from: { id: 2 } } }]),
      getUserProfilePhotos: (_p, init) => pending(init.signal),
    });
    await vi.waitFor(() => expect(f.calls.some(c => c.method === "getUserProfilePhotos")).toBe(true));
    await f.adapter.stop();
    expect(f.onMessage).not.toHaveBeenCalled();
  });
  it("waits for the previous poller to exit on same-key restart and preserves accepted offset", async () => {
    let count = 0;
    let finishOld!: (response: Response) => void;
    const f = fixture({ getUpdates: () => ++count === 1
      ? ok([{ update_id: 41, message: { text: "first", chat: { id: 1, type: "private" } } }])
      : new Promise(resolve => { finishOld = resolve; }) });
    await vi.waitFor(() => expect(f.onMessage).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(finishOld).toBeTypeOf("function"));
    const nextFetch = vi.fn(async (_url, init) => String(_url).endsWith("getMe") ? ok({ id: 1 }) : pending(init.signal));
    const next = registerTelegramFixture(createTelegramAdapter({ ...f.options, fetch: nextFetch }));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(nextFetch).not.toHaveBeenCalled();
    finishOld(ok([{ update_id: 42, message: { text: "old-late", chat: { id: 1, type: "private" } } }]));
    await vi.waitFor(() => expect(nextFetch).toHaveBeenCalledTimes(2));
    const params = nextFetch.mock.calls.find(([url]) => String(url).endsWith("getUpdates"))![1].body as URLSearchParams;
    expect(params.get("offset")).toBe("42");
    expect(f.onMessage).toHaveBeenCalledOnce();
    await next.stop();
  });
  it("releases a pending handed-off handler on stop, retaining its accepted cursor", async () => {
    let count = 0;
    const f = fixture({ getUpdates: (_p, init) => ++count === 1 ? ok([{ update_id: 21, message: { text: "accepted", chat: { id: 1, type: "private" } } }]) : pending(init.signal) });
    f.onMessage.mockImplementation(() => new Promise(() => {}));
    await vi.waitFor(() => expect(f.onMessage).toHaveBeenCalledOnce());
    await f.adapter.stop();
    const nextFetch = vi.fn(async (url, init) => String(url).endsWith("getMe") ? ok({ id: 1 }) : pending(init.signal));
    registerTelegramFixture(createTelegramAdapter({ ...f.options, fetch: nextFetch }));
    await vi.waitFor(() => expect(nextFetch).toHaveBeenCalledTimes(2));
    expect((nextFetch.mock.calls[1][1].body as URLSearchParams).get("offset")).toBe("22");
  });
  it("sanitizes SDK descriptions and causes before surfacing errors", async () => {
    const f = fixture();
    f.fetch.mockImplementation(async () => Response.json({ ok: false, error_code: 400, description: `bad https://api.telegram.org/bot${f.options.token}/sendMessage ${f.options.token}` }));
    const error = await f.adapter.sendReply("1", "message").catch(e => e);
    expect(error.message).not.toContain(f.options.token);
    expect(JSON.stringify(error)).not.toContain(f.options.token);
    expect(error.cause).toBeUndefined();
  });
});

describe("Telegram replacement credentials", () => {
  it("waits for the old same-agent poller even if token changes, without carrying its offset", async () => {
    let finishOld!: (response: Response) => void;
    const f = fixture({ getUpdates: () => new Promise(resolve => { finishOld = resolve; }) });
    await vi.waitFor(() => expect(finishOld).toBeTypeOf("function"));
    const nextFetch = vi.fn(async (url, init) => String(url).endsWith("getMe") ? ok({ id: 1 }) : pending(init.signal));
    registerTelegramFixture(createTelegramAdapter({ ...f.options, token: "98765:SYNTHETIC_NEW_TOKEN", fetch: nextFetch }));
    try {
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(nextFetch).not.toHaveBeenCalled();
    } finally { const stopped = f.adapter.stop(); finishOld(ok([])); await stopped; }
    await vi.waitFor(() => expect(nextFetch).toHaveBeenCalledTimes(2));
    expect((nextFetch.mock.calls[1][1].body as URLSearchParams).get("offset")).toBeNull();
  });
});

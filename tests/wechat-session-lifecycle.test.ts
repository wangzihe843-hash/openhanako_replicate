import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWechatAdapter } from "../lib/bridge/wechat-adapter.ts";

// Every transport is replaced before construction. These are synthetic tokens;
// even requests named after iLink/CDN endpoints never reach a network service.
const adapters: ReturnType<typeof createWechatAdapter>[] = [];
const homes: string[] = [];
const TOKEN = "SYNTHETIC_WX_TOKEN";
const CONTEXT = "SYNTHETIC_CONTEXT";
const USER = "synthetic-user";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function inbound(context = CONTEXT, text = "hello") {
  return { from_user_id: USER, context_token: context, item_list: [{ type: 1, text_item: { text } }] };
}

async function flush() {
  // Drain only microtasks: no fake deadlines, retries or long polls are advanced.
  for (let count = 0; count < 30; count++) await Promise.resolve();
}

function home() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hana-wechat-session-"));
  homes.push(directory);
  return directory;
}

function setup(handler?: (endpoint: string, options: RequestInit) => Promise<Response> | Response | undefined, hanaHome?: string) {
  const pendingPoll = deferred<Response>();
  let polls = 0;
  const fetchMock = vi.fn<typeof fetch>(async (input, options = {}) => {
    const url = String(input);
    if (url.endsWith("/getupdates")) {
      polls++;
      if (polls === 1) return json({ ret: 0, msgs: [inbound()], get_updates_buf: "synthetic-cursor" });
      if (polls === 2) return pendingPoll.promise;
      return new Promise<Response>(() => {});
    }
    const endpoint = url.includes("/ilink/bot/") ? url.split("/ilink/bot/")[1] : url;
    const handled = handler?.(endpoint, options);
    if (handled !== undefined) return handled;
    if (endpoint === "getconfig") return json({ ret: 0, typing_ticket: "SYNTHETIC_TICKET" });
    if (endpoint === "getuploadurl") return json({ ret: 0, upload_param: "SYNTHETIC_UPLOAD" });
    if (url.includes("/c2c/upload")) return new Response(null, { headers: { "x-encrypted-param": "SYNTHETIC_DOWNLOAD" } });
    if (endpoint === "sendmessage" || endpoint === "sendtyping") return json({ ret: 0 });
    throw new Error(`Unexpected offline request: ${endpoint}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const onStatus = vi.fn();
  const onMessage = vi.fn();
  const adapter = createWechatAdapter({ botToken: TOKEN, hanaHome, agentId: "hana", onStatus, onMessage });
  adapters.push(adapter);
  return { adapter, fetchMock, pendingPoll, onStatus, onMessage };
}

function endpointCalls(fetchMock: ReturnType<typeof setup>["fetchMock"], endpoint: string) {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes(`/ilink/bot/${endpoint}`));
}

async function assertNoNewOutbound(fixture: ReturnType<typeof setup>) {
  const { adapter, fetchMock } = fixture;
  const previous = fetchMock.mock.calls.length;
  expect(adapter.canReply(USER)).toBe(false);
  for (const action of [
    () => adapter.sendReply(USER, "retry"),
    () => adapter.sendReply(USER, ""),
    () => adapter.sendTypingIndicator(USER),
    () => adapter.cancelTypingIndicator(USER),
    () => adapter.sendMedia(USER, "https://synthetic.invalid/image.png"),
    () => adapter.sendMediaBuffer(USER, Buffer.from("media"), { mime: "image/png", filename: "synthetic.png" }),
    () => adapter.getMe(),
  ]) await expect(action()).rejects.toThrow();
  expect(fetchMock).toHaveBeenCalledTimes(previous);
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  for (const adapter of adapters.splice(0)) adapter.stop();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const directory of homes.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("WeChat terminal session state", () => {
  it.each([
    { ret: -14 },
    { ret: -14, errcode: 0 },
    { ret: 0, errcode: -14 },
    { errcode: -14 },
    { ret: 7, errcode: -14 },
    { ret: -14, errcode: "0" },
    { ret: "0", errcode: -14 },
  ])("invalidates all outbound entry points for a numeric getupdates session error: %j", async codes => {
    const fixture = setup();
    await flush();
    expect(fixture.adapter.canReply(USER)).toBe(true);
    fixture.pendingPoll.resolve(json({ ...codes, errmsg: "context_token=SYNTHETIC_ERROR_CONTEXT" }));
    await flush();
    expect(fixture.onStatus.mock.calls).toEqual([["connected"], ["error", "session expired"]]);
    await assertNoNewOutbound(fixture);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(endpointCalls(fixture.fetchMock, "getupdates")).toHaveLength(2);
    expect(fixture.onStatus.mock.calls).toEqual([["connected"], ["error", "session expired"]]);
  });

  it("makes stop terminal for this adapter without deleting persisted context or cursor", async () => {
    const directory = home();
    const fixture = setup(undefined, directory);
    await flush();
    const cacheDirectory = path.join(directory, "bridge", "wechat");
    const before = fs.readdirSync(cacheDirectory).map(name => [name, fs.readFileSync(path.join(cacheDirectory, name), "utf8")]);
    fixture.adapter.stop();
    fixture.adapter.stop();
    await assertNoNewOutbound(fixture);
    expect(fixture.onStatus.mock.calls).toEqual([["connected"], ["disconnected"]]);
    expect(fs.readdirSync(cacheDirectory).map(name => [name, fs.readFileSync(path.join(cacheDirectory, name), "utf8")])).toEqual(before);
  });

  it.each(["expired", "stopped"])("does not start CDN attachment reads after %s", async terminal => {
    const fixture = setup();
    await flush();
    if (terminal === "stopped") fixture.adapter.stop();
    else { fixture.pendingPoll.resolve(json({ ret: -14 })); await flush(); }
    const calls = fixture.fetchMock.mock.calls.length;
    const ref = JSON.stringify({ encrypt_query_param: "SYNTHETIC_HISTORY" });
    await expect(fixture.adapter.downloadFileByRef(ref)).rejects.toThrow();
    await expect(fixture.adapter.downloadImage(ref)).rejects.toThrow();
    expect(fixture.fetchMock).toHaveBeenCalledTimes(calls);
  });

  it.each([
    ["getconfig", "typing"],
    ["getconfig", "identity"],
    ["sendmessage", "text"],
    ["sendtyping", "typing"],
    ["getuploadurl", "media"],
  ] as const)("invalidates when %s returns ret=-14 through %s", async (endpoint, action) => {
    const fixture = setup(requested => requested === endpoint ? json({ ret: -14, errmsg: "bot_token=SYNTHETIC_ECHO" }) : undefined);
    await flush();
    const attempt = action === "identity" ? fixture.adapter.getMe()
      : action === "typing" ? fixture.adapter.sendTypingIndicator(USER)
        : action === "media" ? fixture.adapter.sendMediaBuffer(USER, Buffer.from("media"), { mime: "image/png", filename: "image.png" })
          : fixture.adapter.sendReply(USER, "first attempt");
    await expect(attempt).rejects.toThrow();
    expect(fixture.onStatus.mock.calls).toEqual([["connected"], ["error", "session expired"]]);
    await assertNoNewOutbound(fixture);
    expect(endpointCalls(fixture.fetchMock, endpoint)).toHaveLength(1);
  });

  it.each(["getconfig", "sendmessage", "sendtyping", "getuploadurl"])("does not invent an errcode contract for %s", async endpoint => {
    const fixture = setup(requested => requested === endpoint
      ? json({ ret: 0, errcode: -14, typing_ticket: "SYNTHETIC_TICKET", upload_param: "SYNTHETIC_UPLOAD" })
      : undefined);
    await flush();
    await fixture.adapter.sendReply(USER, "still valid");
    await fixture.adapter.sendTypingIndicator(USER);
    await fixture.adapter.sendMediaBuffer(USER, Buffer.from("media"), { mime: "image/png", filename: "image.png" });
    expect(fixture.adapter.canReply(USER)).toBe(true);
    expect(fixture.onStatus.mock.calls).toEqual([["connected"]]);
  });

  it("invalidates once for concurrent outbound errors and discards a late successful poll", async () => {
    const directory = home();
    const pendingSends = [deferred<Response>(), deferred<Response>()];
    let sends = 0;
    const fixture = setup(endpoint => endpoint === "sendmessage" ? pendingSends[sends++].promise : undefined, directory);
    await flush();
    const cacheDirectory = path.join(directory, "bridge", "wechat");
    const before = fs.readdirSync(cacheDirectory).map(name => [name, fs.readFileSync(path.join(cacheDirectory, name), "utf8")]);
    const first = fixture.adapter.sendReply(USER, "first").catch(error => error);
    const second = fixture.adapter.sendReply(USER, "second").catch(error => error);
    await flush();
    expect(sends).toBe(2);
    pendingSends[0].resolve(json({ ret: -14 }));
    expect(await first).toBeInstanceOf(Error);
    pendingSends[1].resolve(json({ ret: -14 }));
    expect(await second).toBeInstanceOf(Error);
    fixture.pendingPoll.resolve(json({ ret: 0, msgs: [inbound("SYNTHETIC_STALE_CONTEXT", "stale")], get_updates_buf: "stale-cursor" }));
    await flush();
    expect(fixture.onStatus.mock.calls).toEqual([["connected"], ["error", "session expired"]]);
    expect(fixture.onMessage).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(cacheDirectory).map(name => [name, fs.readFileSync(path.join(cacheDirectory, name), "utf8")])).toEqual(before);
    await assertNoNewOutbound(fixture);
  });
});

describe("WeChat ordinary errors and recovery", () => {
  it.each([
    () => json({ ret: 7, errmsg: "ordinary failure with text ret=-14" }),
    () => json({ ret: "-14" }),
    () => json({ ret: 0, errcode: "-14" }),
    () => new Response("ret=-14 bot_token=SYNTHETIC_HTTP", { status: 401 }),
    () => new Response("errcode=-14 context_token=SYNTHETIC_HTTP", { status: 503 }),
    () => new Response("not JSON ret=-14"),
  ])("keeps non-session poll failures on the existing retry path: %s", async response => {
    const fixture = setup();
    await flush();
    fixture.pendingPoll.resolve(response());
    await flush();
    expect(fixture.adapter.canReply(USER)).toBe(true);
    expect(fixture.onStatus.mock.calls).toEqual([["connected"]]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(endpointCalls(fixture.fetchMock, "getupdates")).toHaveLength(3);
    await fixture.adapter.sendReply(USER, "ordinary error does not disable replies");
    expect(endpointCalls(fixture.fetchMock, "sendmessage")).toHaveLength(1);
    expect(fixture.onStatus.mock.calls).toEqual([["connected"]]);
  });

  it("keeps outbound ordinary failures retryable and preserves request credentials", async () => {
    let attempts = 0;
    const fixture = setup((endpoint, options) => {
      if (endpoint !== "sendmessage") return undefined;
      expect(new Headers(options.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
      expect(JSON.parse(String(options.body)).msg.context_token).toBe(CONTEXT);
      attempts++;
      return attempts === 1 ? json({ ret: 7, errmsg: "context_token=SYNTHETIC_ECHO ret=-14" }) : json({ ret: 0 });
    });
    await flush();
    await expect(fixture.adapter.sendReply(USER, "first")).rejects.toThrow();
    expect(fixture.adapter.canReply(USER)).toBe(true);
    await fixture.adapter.sendReply(USER, "manual retry");
    expect(attempts).toBe(2);
    expect(fixture.onStatus.mock.calls).toEqual([["connected"]]);
  });

  it.each(["stopped", "expired"])("restores a valid new adapter from files while %s callbacks cannot overwrite it", async terminal => {
    const directory = home();
    const pendingIdentity = deferred<Response>();
    const old = setup(endpoint => endpoint === "getconfig" ? pendingIdentity.promise : undefined, directory);
    await flush();
    const oldIdentity = old.adapter.getMe().catch(error => error);
    await flush();
    if (terminal === "stopped") old.adapter.stop();
    else {
      old.pendingPoll.resolve(json({ ret: 0, errcode: -14 }));
      await flush();
    }

    const onStatus = vi.fn();
    const onMessage = vi.fn();
    let polls = 0;
    const newFetch = vi.fn<typeof fetch>(async (url, options: RequestInit = {}) => {
      if (String(url).endsWith("/getupdates")) {
        polls++;
        if (polls === 1) {
          expect(JSON.parse(String(options.body)).get_updates_buf).toBe("synthetic-cursor");
          return json({ ret: 0, msgs: [inbound("SYNTHETIC_FRESH_CONTEXT", "fresh")], get_updates_buf: "fresh-cursor" });
        }
        return new Promise<Response>(() => {});
      }
      expect(String(url)).toContain("/sendmessage");
      expect(JSON.parse(String(options.body)).msg.context_token).toBe("SYNTHETIC_FRESH_CONTEXT");
      return json({ ret: 0 });
    });
    vi.stubGlobal("fetch", newFetch);
    const fresh = createWechatAdapter({ botToken: TOKEN, hanaHome: directory, agentId: "hana", onStatus, onMessage });
    adapters.push(fresh);
    expect(fresh.canReply(USER)).toBe(true);
    await flush();
    old.pendingPoll.resolve(json({ ret: 0, msgs: [inbound("SYNTHETIC_OLD_CONTEXT", "old")], get_updates_buf: "old-cursor" }));
    pendingIdentity.resolve(json({ ret: -14 }));
    expect(await oldIdentity).toBeInstanceOf(Error);
    await flush();
    expect(old.onStatus.mock.calls).toEqual(terminal === "stopped"
      ? [["connected"], ["disconnected"]]
      : [["connected"], ["error", "session expired"]]);
    expect(old.onMessage).toHaveBeenCalledTimes(1);
    expect(onStatus.mock.calls).toEqual([["connected"]]);
    expect(onMessage).toHaveBeenCalledTimes(1);
    await fresh.sendReply(USER, "new session");
    const tokenHash = crypto.createHash("sha256").update(TOKEN).digest("hex").slice(0, 8);
    const cacheDirectory = path.join(directory, "bridge", "wechat");
    expect(JSON.parse(fs.readFileSync(path.join(cacheDirectory, `sync-${tokenHash}.json`), "utf8")).get_updates_buf).toBe("fresh-cursor");
    expect(JSON.parse(fs.readFileSync(path.join(cacheDirectory, `context-${tokenHash}.json`), "utf8")).entries[USER].token).toBe("SYNTHETIC_FRESH_CONTEXT");
  });
});

describe("WeChat pending outbound stages", () => {
  it("does not create a retry timer after an error callback stops the adapter", async () => {
    const fixture = setup();
    await flush();
    fixture.onStatus.mockImplementation(status => { if (status === "error") fixture.adapter.stop(); });
    // Every subsequent response fails, reaching the original third-failure status.
    fixture.fetchMock.mockImplementation(async () => json({ ret: 7 }));
    fixture.pendingPoll.resolve(json({ ret: 7 }));
    await vi.advanceTimersByTimeAsync(7_000);
    expect(fixture.onStatus.mock.calls.map(call => call[0])).toEqual(["connected", "error", "disconnected"]);
    expect(vi.getTimerCount()).toBe(0);
    const calls = fixture.fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fixture.fetchMock).toHaveBeenCalledTimes(calls);
  });
  for (const terminal of ["expired", "stopped"] as const) {
    it.each(["text chunk", "typing ticket", "upload URL", "CDN upload", "remote source", "remote body"])(
      `does not continue %s after the session is ${terminal}`,
      async stage => {
        const pending = deferred<Response>();
        const pendingBody = deferred<ArrayBuffer>();
        const fixture = setup(endpoint => {
          if (stage === "text chunk" && endpoint === "sendmessage") return pending.promise;
          if (stage === "typing ticket" && endpoint === "getconfig") return pending.promise;
          if (stage === "upload URL" && endpoint === "getuploadurl") return pending.promise;
          if (stage === "CDN upload" && endpoint.includes("/c2c/upload")) return pending.promise;
          if (stage === "remote source" && endpoint === "https://source.example.com/image.png") return pending.promise;
          if (stage === "remote body" && endpoint === "https://source.example.com/image.png") {
            let cancelled = false;
            return new Response(new ReadableStream({
              async pull(controller) {
                const bytes = await pendingBody.promise;
                if (!cancelled) { controller.enqueue(new Uint8Array(bytes)); controller.close(); }
              },
              cancel() { cancelled = true; },
            }), { headers: { "content-type": "image/png" } });
          }
          return undefined;
        });
        await flush();
        const action = stage === "text chunk" ? fixture.adapter.sendReply(USER, "x".repeat(4_001))
          : stage === "typing ticket" ? fixture.adapter.sendTypingIndicator(USER)
            : stage.startsWith("remote") ? fixture.adapter.sendMedia(USER, "https://source.example.com/image.png")
              : fixture.adapter.sendMediaBuffer(USER, Buffer.from("media"), { mime: "image/png", filename: "image.png" });
        // Attach rejection handling before invalidating concurrent work.
        const result = action.catch(error => error);
        await flush();
        if (terminal === "expired") fixture.pendingPoll.resolve(json({ ret: 0, errcode: -14 }));
        else fixture.adapter.stop();
        await flush();
        const callsAtInvalidation = fixture.fetchMock.mock.calls.length;
        if (stage === "remote body") pendingBody.resolve(new Uint8Array([1, 2, 3]).buffer);
        else if (stage === "remote source") pending.resolve(new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }));
        else if (stage === "CDN upload") pending.resolve(new Response(null, { headers: { "x-encrypted-param": "SYNTHETIC_DOWNLOAD" } }));
        else if (stage === "upload URL") pending.resolve(json({ ret: 0, upload_param: "SYNTHETIC_UPLOAD" }));
        else if (stage === "typing ticket") pending.resolve(json({ ret: 0, typing_ticket: "SYNTHETIC_TICKET" }));
        else pending.resolve(json({ ret: 0 }));
        expect(await result).toBeInstanceOf(Error);
        expect(fixture.fetchMock).toHaveBeenCalledTimes(callsAtInvalidation);
        expect(fixture.onStatus.mock.calls).toEqual(terminal === "expired"
          ? [["connected"], ["error", "session expired"]]
          : [["connected"], ["disconnected"]]);
        if (stage === "text chunk") expect(endpointCalls(fixture.fetchMock, "sendmessage")).toHaveLength(1);
        else expect(endpointCalls(fixture.fetchMock, "sendmessage")).toHaveLength(0);
        if (stage === "typing ticket") expect(endpointCalls(fixture.fetchMock, "sendtyping")).toHaveLength(0);
        if (stage.startsWith("remote")) expect(endpointCalls(fixture.fetchMock, "getuploadurl")).toHaveLength(0);
      },
    );
  }

  it("does not deliver a poll result when the connected callback stops this adapter", async () => {
    const directory = home();
    const fixture = setup(undefined, directory);
    fixture.onStatus.mockImplementation(status => {
      if (status === "connected") fixture.adapter.stop();
    });
    await flush();
    expect(fixture.onMessage).not.toHaveBeenCalled();
    expect(fixture.adapter.canReply(USER)).toBe(false);
    expect(fixture.onStatus.mock.calls).toEqual([["connected"], ["disconnected"]]);
    expect(endpointCalls(fixture.fetchMock, "getupdates")).toHaveLength(1);
    expect(fs.readdirSync(path.join(directory, "bridge", "wechat"))).toEqual([]);
  });

  it("stops consuming a poll batch after an inbound callback stops this adapter", async () => {
    const fixture = setup();
    await flush();
    fixture.onMessage.mockImplementation(() => fixture.adapter.stop());
    fixture.pendingPoll.resolve(json({ ret: 0, msgs: [inbound(CONTEXT, "first"), inbound("SYNTHETIC_UNUSED", "second")] }));
    await flush();
    expect(fixture.onMessage).toHaveBeenCalledTimes(2); // initial message plus first item only
    expect(fixture.onMessage.mock.calls[1][0].text).toBe("first");
    expect(fixture.onStatus.mock.calls).toEqual([["connected"], ["disconnected"]]);
    expect(endpointCalls(fixture.fetchMock, "getupdates")).toHaveLength(2);
  });
});

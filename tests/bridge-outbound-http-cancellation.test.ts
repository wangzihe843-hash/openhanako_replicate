import { getEventListeners } from "node:events";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fetch as undiciFetch, Response } from "undici";
import { BridgeHttpError, createBridgeOutboundHttp } from "../lib/bridge/outbound-http.ts";
import { readDingTalkResponse } from "../lib/bridge/dingtalk-api.ts";
import { bridgeHttpLoopback } from "./fixtures/bridge-http-loopback.ts";

const direct = () => ({ dispatcher: null, proxyUrl: "" });
const options = { stage: "token", url: "https://synthetic.invalid/token", idempotent: true };
const stopped = () => new DOMException("Synthetic caller cancelled", "AbortError");

function pendingFetch() {
  return vi.fn<typeof undiciFetch>((_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(new TypeError("fetch failed", {
      cause: new Error("transport wrapper", { cause: init!.signal!.reason }),
    })), { once: true });
  }));
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("Bridge caller cancellation", () => {
  it.each(["qq", "dingtalk"])("%s pre-aborted signal performs zero requests or proxy resolution", async platform => {
    const caller = new AbortController();
    const reason = stopped();
    caller.abort(reason);
    const fetchImpl = vi.fn(async () => new Response("{}"));
    const resolveDispatcher = vi.fn(direct);
    const http = createBridgeOutboundHttp({ platform, fetchImpl: fetchImpl as typeof undiciFetch, resolveDispatcher });
    await expect(http.request({ ...options, signal: caller.signal })).rejects.toBe(reason);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(resolveDispatcher).not.toHaveBeenCalled();
  });

  it.each(["token", "gateway", "send_reply", "send_media_message", "robot_send", "upload_part_put"])("cancels pending %s without retry", async stage => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const reason = stopped();
    const fetchImpl = pendingFetch();
    const sleep = vi.fn(async () => {});
    const http = createBridgeOutboundHttp({ platform: "qq", fetchImpl: fetchImpl as typeof undiciFetch, resolveDispatcher: direct, sleep });
    const result = http.request({ ...options, stage, signal: caller.signal }).catch(error => error);
    caller.abort(reason);
    expect(await result).toBe(reason);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
  });

  it.each([429, 503, "network"])("cancels %s backoff and disposes its timer/listener", async failure => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const fetchImpl = vi.fn(async () => {
      if (failure === "network") throw new TypeError("fetch failed", { cause: new Error("ECONNRESET") });
      return new Response("temporary failure", { status: failure as number });
    });
    const http = createBridgeOutboundHttp({ platform: "qq", fetchImpl: fetchImpl as typeof undiciFetch, resolveDispatcher: direct });
    const result = http.request({ ...options, timeoutMs: 50, signal: caller.signal }).catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // Only backoff remains; the request/header deadline must already be gone.
    expect(vi.getTimerCount()).toBe(1);
    const reason = stopped();
    caller.abort(reason);
    expect(await result).toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry an AbortError nested in transport causes, including cyclic causes", async () => {
    const abort = Object.assign(new Error("cancelled"), { code: "ABORT_ERR", cause: undefined as unknown });
    const error = new TypeError("fetch failed", { cause: new Error("wrapper", { cause: abort }) });
    abort.cause = error;
    const fetchImpl = vi.fn(async () => { throw error; });
    const sleep = vi.fn(async () => {});
    const http = createBridgeOutboundHttp({ platform: "dingtalk", fetchImpl: fetchImpl as typeof undiciFetch, resolveDispatcher: direct, sleep });
    await expect(http.request(options)).rejects.toBe(error);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("preserves timeout retries and does not abort the caller", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const fetchImpl = pendingFetch();
    const http = createBridgeOutboundHttp({ platform: "qq", fetchImpl: fetchImpl as typeof undiciFetch, resolveDispatcher: direct });
    const result = http.request({ ...options, signal: caller.signal, timeoutMs: 20 }).catch(error => error);
    await vi.runAllTimersAsync();
    expect(await result).toBeInstanceOf(BridgeHttpError);
    expect(await result).toMatchObject({ timedOut: true, attempts: 3 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(caller.signal.aborted).toBe(false);
    expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans a completed backoff before returning a successful retry", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const fetchImpl = vi.fn(async () => new Response("{}", { status: fetchImpl.mock.calls.length === 1 ? 429 : 200 }));
    const http = createBridgeOutboundHttp({ platform: "qq", fetchImpl: fetchImpl as typeof undiciFetch, resolveDispatcher: direct });
    const result = http.request({ ...options, signal: caller.signal });
    await vi.runAllTimersAsync();
    expect((await result).status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(caller.signal.aborted).toBe(false);
    expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains ordinary network retry classification through a cyclic non-abort cause", async () => {
    const error = new TypeError("fetch failed", { cause: new Error("ordinary failure") });
    (error.cause as Error).cause = error;
    const fetchImpl = vi.fn(async () => { throw error; });
    const sleep = vi.fn(async () => {});
    const http = createBridgeOutboundHttp({ platform: "qq", fetchImpl: fetchImpl as typeof undiciFetch, resolveDispatcher: direct, sleep });
    await expect(http.request(options)).rejects.toMatchObject({ name: "BridgeHttpError", timedOut: false, attempts: 3 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("checks cancellation again when proxy resolution aborts the caller", async () => {
    const caller = new AbortController();
    const reason = stopped();
    const fetchImpl = vi.fn(async () => new Response("{}"));
    const http = createBridgeOutboundHttp({
      platform: "qq", fetchImpl: fetchImpl as typeof undiciFetch,
      resolveDispatcher: () => { caller.abort(reason); return direct(); },
    });
    await expect(http.request({ ...options, signal: caller.signal })).rejects.toBe(reason);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("lets caller cancellation win a same-tick response race", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const reason = stopped();
    const fetchImpl = vi.fn(async () => { caller.abort(reason); return new Response(null); });
    const http = createBridgeOutboundHttp({ platform: "qq", fetchImpl: fetchImpl as typeof undiciFetch, resolveDispatcher: direct });
    await expect(http.request({ ...options, signal: caller.signal })).rejects.toBe(reason);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps shared caller cancellation independent of per-request completion", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const hanging = pendingFetch();
    const fetchImpl = vi.fn<typeof undiciFetch>((url, init) => String(url).endsWith("/done")
      ? Promise.resolve(new Response("done")) : hanging(url, init));
    const http = createBridgeOutboundHttp({ platform: "qq", fetchImpl: fetchImpl as typeof undiciFetch, resolveDispatcher: direct });
    const done = await http.request({ ...options, url: options.url + "/done", signal: caller.signal });
    expect(await done.text()).toBe("done");
    const requests = [1, 2].map(() => http.request({ ...options, signal: caller.signal }).catch(error => error));
    const reason = stopped();
    caller.abort(reason);
    expect(await Promise.all(requests)).toEqual([reason, reason]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not retain caller listeners or timers after repeated completed requests", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const fetchImpl = vi.fn(async () => new Response("{}"));
    const http = createBridgeOutboundHttp({ platform: "qq", fetchImpl: fetchImpl as typeof undiciFetch, resolveDispatcher: direct });
    for (let i = 0; i < 30; i++) {
      const response = await http.request({ ...options, signal: caller.signal });
      expect(await response.json()).toEqual({});
    }
    expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    caller.abort();
    await vi.runAllTimersAsync();
    expect(fetchImpl).toHaveBeenCalledTimes(30);
  });
});

describe("Bridge caller cancellation over real loopback transport", () => {
  let loop: Awaited<ReturnType<typeof bridgeHttpLoopback>>;
  beforeAll(async () => { loop = await bridgeHttpLoopback(); });
  afterAll(async () => { await loop?.close(); });

  for (const fetchImpl of [undiciFetch, globalThis.fetch]) {
    const name = fetchImpl === undiciFetch ? "undici" : "native";
    const http = () => createBridgeOutboundHttp({
      platform: "dingtalk", fetchImpl: fetchImpl as typeof undiciFetch,
      resolveDispatcher: () => ({ dispatcher: loop.agent, proxyUrl: "" }),
    });

    it(`${name} sends no request for a pre-aborted caller`, async () => {
      loop.reset();
      const caller = new AbortController();
      caller.abort();
      await expect(http().request({ ...options, url: loop.source, signal: caller.signal })).rejects.toMatchObject({ name: "AbortError" });
      expect(loop.sourceRequests).toHaveLength(0);
      expect(loop.sinkRequests).toHaveLength(0);
    });

    it(`${name} aborts an established request before response headers`, async () => {
      loop.reset();
      const caller = new AbortController();
      const received = Promise.withResolvers<void>();
      loop.respond(() => { received.resolve(); });
      const result = http().request({ ...options, url: loop.source, signal: caller.signal }).catch(error => error);
      try {
        await received.promise;
        const reason = stopped();
        caller.abort(reason);
        expect(await result).toBe(reason);
        expect(loop.sourceRequests).toHaveLength(1);
        expect(loop.sinkRequests).toHaveLength(0);
      } finally { caller.abort(); }
    });

    it(`${name} keeps cancellation connected after headers into the U05 bounded body reader`, async () => {
      loop.reset();
      const caller = new AbortController();
      loop.respond((_request, response) => { response.writeHead(200); response.write('{"synthetic":'); });
      const response = await http().request({ ...options, url: loop.source, signal: caller.signal, timeoutMs: 200 });
      const result = readDingTalkResponse(response, { timeoutMs: 2_000, stage: "stream_open" }).catch(error => error);
      try {
        // Header deadline is over; caller cancellation must still reach the body.
        await new Promise(resolve => setTimeout(resolve, 225));
        caller.abort();
        expect(await result).toMatchObject({ name: "AbortError" });
        expect(loop.sourceRequests).toHaveLength(1);
        expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
      } finally { caller.abort(); }
    });

    it(`${name} preserves normal response identity/body completion before a later abort`, async () => {
      loop.reset();
      loop.respond((_request, response) => { response.end('{"ok":true}'); });
      const caller = new AbortController();
      const response = await http().request({ ...options, url: loop.source, signal: caller.signal });
      expect(response.status).toBe(200);
      expect(response.url).toBe(loop.source + "/");
      expect(await readDingTalkResponse(response)).toEqual({ ok: true });
      caller.abort();
      expect(response.bodyUsed).toBe(true);
      expect(loop.sourceRequests).toHaveLength(1);
      expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
    });
  }
});

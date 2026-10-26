import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDingTalkAdapter, DINGTALK_BOT_CALLBACK_TOPIC } from "../lib/bridge/dingtalk-adapter.ts";

class Socket extends EventEmitter {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: Socket[] = [];
  readyState = 0;
  sent: string[] = [];
  closeCalls = 0;
  terminateCalls = 0;
  constructor(public url: string, public options: Record<string, unknown>) {
    super(); Socket.instances.push(this);
  }
  open() { this.readyState = 1; this.emit("open"); }
  send(value: string) { this.sent.push(value); }
  close() { this.closeCalls++; this.readyState = 3; this.emit("close"); }
  terminate() { this.terminateCalls++; this.close(); }
}
const credentials = { corpId: "synthetic-corp", clientId: "synthetic-client", clientSecret: "synthetic-secret", robotCode: "synthetic-robot", agentId: "synthetic-agent" };
const registration = (n = 1) => Response.json({ endpoint: `wss://synthetic.invalid/connect?region=${n}`, ticket: `synthetic-ticket-${n}` });
const token = () => Response.json({ access_token: "synthetic-token", expires_in: 7200 });
const tick = () => vi.advanceTimersByTimeAsync(0);
const adapters: ReturnType<typeof createDingTalkAdapter>[] = [];
const releases: (() => void)[] = [];
function fixture(fetchImpl: (url: string, init: RequestInit) => Promise<unknown>) {
  const onStatus = vi.fn(); const onMessage = vi.fn();
  const adapter = createDingTalkAdapter({ ...credentials, fetchImpl, WebSocketImpl: Socket, onStatus, onMessage });
  adapters.push(adapter);
  return { adapter, onStatus, onMessage };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function frame(topic = DINGTALK_BOT_CALLBACK_TOPIC) {
  return JSON.stringify({ type: topic === DINGTALK_BOT_CALLBACK_TOPIC ? "CALLBACK" : "SYSTEM", headers: { topic, messageId: "synthetic-envelope" }, data: JSON.stringify({ msgId: "synthetic-msg", conversationType: "1", senderStaffId: "synthetic-user", msgtype: "text", text: { content: "hello" }, opaque: "opaque" }) });
}
function outcome(promise: Promise<unknown>) {
  const result: { value?: unknown; error?: unknown; settled: boolean } = { settled: false };
  void promise.then(value => { result.value = value; result.settled = true; }, error => { result.error = error; result.settled = true; });
  return result;
}
beforeEach(() => { vi.useFakeTimers(); Socket.instances = []; });
afterEach(async () => {
  for (const a of adapters.splice(0)) a.stop();
  for (const release of releases.splice(0)) release();
  await tick(); vi.clearAllTimers(); vi.restoreAllMocks(); vi.useRealTimers();
});

describe("DingTalk adapter lifetime and production HTTP cancellation", () => {
  it.each(["stream", "token", "send"])("aborts pending %s headers without late status, send or reconnect", async stage => {
    let heldSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn((url: string, init: RequestInit) => {
      const current = url.includes("/connections/open") ? "stream" : url.includes("/oauth2/") ? "token" : "send";
      if (current !== stage) return Promise.resolve(current === "stream" ? registration() : token());
      heldSignal = init.signal!;
      return new Promise<Response>((resolve, reject) => {
        const abort = () => reject(init.signal!.reason);
        init.signal!.addEventListener("abort", abort, { once: true });
        releases.push(() => { init.signal!.removeEventListener("abort", abort); resolve(current === "stream" ? registration() : token()); });
      });
    });
    const { adapter, onStatus } = fixture(fetchImpl);
    await tick();
    const pending = stage === "stream" ? null : outcome(adapter.sendReply("synthetic-user", "hello"));
    await tick();
    adapter.stop();
    expect(heldSignal?.aborted).toBe(true);
    await tick();
    if (pending) expect(pending).toMatchObject({ settled: true, error: { name: "AbortError" } });
    expect(onStatus.mock.calls.at(-1)).toEqual(["disconnected"]);
    const calls = fetchImpl.mock.calls.length;
    await vi.advanceTimersByTimeAsync(100_000);
    expect(fetchImpl).toHaveBeenCalledTimes(calls);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["stream", "token", "send"])("cancels a stalled %s body, releases its reader and removes its deadline", async stage => {
    const cancel = vi.fn(); const body = new ReadableStream<Uint8Array>({ cancel });
    const fetchImpl = vi.fn(async (url: string) => {
      const current = url.includes("/connections/open") ? "stream" : url.includes("/oauth2/") ? "token" : "send";
      return current === stage ? new Response(body) : current === "stream" ? registration() : token();
    });
    const { adapter, onStatus } = fixture(fetchImpl); await tick();
    const pending = stage === "stream" ? null : outcome(adapter.sendReply("synthetic-user", "hello"));
    await tick(); expect(body.locked).toBe(true);
    adapter.stop(); await tick();
    expect(cancel).toHaveBeenCalledOnce(); expect(body.locked).toBe(false);
    if (pending) expect(pending).toMatchObject({ settled: true, error: { name: "AbortError" } });
    expect(vi.getTimerCount()).toBe(0);
    expect(onStatus.mock.calls.at(-1)).toEqual(["disconnected"]);
  });

  it.each(["stream", "token"])("interrupts %s retry backoff without another fetch", async stage => {
    const fetchImpl = vi.fn(async (url: string) => url.includes("/connections/open") && stage === "token" ? registration() : new Response("busy", { status: 503 }));
    const { adapter, onStatus } = fixture(fetchImpl); await tick();
    const pending = stage === "stream" ? null : outcome(adapter.sendReply("synthetic-user", "hello"));
    await tick(); const calls = fetchImpl.mock.calls.length;
    adapter.stop(); await tick();
    if (pending) expect(pending).toMatchObject({ settled: true, error: { name: "AbortError" } });
    await vi.advanceTimersByTimeAsync(100_000);
    expect(fetchImpl).toHaveBeenCalledTimes(calls); expect(vi.getTimerCount()).toBe(0);
    expect(onStatus.mock.calls.at(-1)).toEqual(["disconnected"]);
  });

  it("rejects sends after stop before requesting a token", async () => {
    const fetchImpl = vi.fn(async () => registration()); const { adapter } = fixture(fetchImpl);
    await tick(); adapter.stop();
    await expect(adapter.sendReply("synthetic-user", "hello")).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("does not send the next text chunk when stop occurs inside a successful response", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/connections/open")) return registration();
      if (url.includes("/oauth2/")) return token();
      return { ok: true, status: 200, text: async () => { adapter.stop(); return "{}"; } };
    });
    const { adapter } = fixture(fetchImpl); await tick();
    await expect(adapter.sendReply("synthetic-user", "你".repeat(5000))).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("single-flights concurrent token refresh without retrying sends", async () => {
    const held = deferred<Response>(); releases.push(() => held.resolve(token()));
    const fetchImpl = vi.fn(async (url: string) => url.includes("/connections/open") ? registration() : url.includes("/oauth2/") ? held.promise : Response.json({ ok: true }));
    const { adapter } = fixture(fetchImpl); await tick();
    const one = adapter.sendReply("one", "hello"); const two = adapter.sendReply("two", "hello"); await tick();
    expect(fetchImpl.mock.calls.filter(([url]) => url.includes("/oauth2/"))).toHaveLength(1);
    held.resolve(token()); await Promise.all([one, two]);
    expect(fetchImpl.mock.calls.filter(([url]) => url.includes("/robot/"))).toHaveLength(2);
  });

  it.each(["headers", "body"])("ignores late registration %s across stop-start and preserves the new instance", async stage => {
    const held = deferred<Response | string>(); releases.push(() => held.resolve(stage === "headers" ? registration() : JSON.stringify({ endpoint: "wss://old.invalid", ticket: "old" })));
    const oldFetch = vi.fn(async () => stage === "headers" ? held.promise : { ok: true, status: 200, text: () => held.promise });
    const old = fixture(oldFetch); await tick(); old.adapter.stop();
    const fresh = fixture(vi.fn(async () => registration(2))); await tick();
    const socket = Socket.instances[0]; socket.open();
    held.resolve(stage === "headers" ? registration() : JSON.stringify({ endpoint: "wss://old.invalid", ticket: "old" })); await tick();
    expect(Socket.instances).toHaveLength(1);
    expect(old.onStatus.mock.calls).toEqual([["disconnected"]]);
    expect(fresh.onStatus.mock.calls.at(-1)).toEqual(["connected"]);
    old.adapter.stop(); expect(socket.closeCalls).toBe(0);
  });
});

describe("DingTalk connection generations", () => {
  it("sets a finite handshake budget below the single-use ticket lifetime and cancels a pending socket", async () => {
    const { adapter, onStatus } = fixture(vi.fn(async () => registration())); await tick();
    const socket = Socket.instances[0];
    expect(socket.options.handshakeTimeout).toBe(30_000);
    adapter.stop(); expect(socket.terminateCalls).toBe(1);
    socket.open(); socket.emit("message", frame()); await tick();
    expect(onStatus.mock.calls).toEqual([["disconnected"]]);
    expect(socket.eventNames()).toEqual([]); expect(vi.getTimerCount()).toBe(0);
  });

  it("retires error-only sockets and schedules one reconnect across error, close and old events", async () => {
    let n = 0; const fetchImpl = vi.fn(async () => registration(++n));
    const { adapter, onStatus, onMessage } = fixture(fetchImpl); await tick();
    const old = Socket.instances[0]; old.open();
    const saved = Object.fromEntries(["open", "message", "error", "close"].map(name => [name, old.listeners(name).slice()]));
    old.emit("error", new Error(`failed ${old.url}`)); await tick();
    expect(old.terminateCalls).toBe(1); expect(vi.getTimerCount()).toBe(1);
    for (const f of saved.close) f();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const fresh = Socket.instances[1]; fresh.open(); const statuses = onStatus.mock.calls.slice();
    for (const f of saved.open) f();
    for (const f of saved.message) { f(frame()); f(frame("disconnect")); f(frame("ping")); }
    for (const f of saved.error) f(new Error("obsolete"));
    for (const f of saved.close) f();
    expect(fresh.closeCalls).toBe(0); expect(fresh.sent).toEqual([]);
    expect(onMessage).not.toHaveBeenCalled(); expect(onStatus.mock.calls).toEqual(statuses);
    expect(JSON.stringify(statuses)).not.toContain("synthetic-ticket");
    fresh.emit("message", frame()); expect(onMessage).toHaveBeenCalledOnce();
    expect(JSON.parse(fresh.sent[0])).toMatchObject({ code: 200, headers: { messageId: "synthetic-envelope" }, data: "{}" });
    adapter.stop(); expect(vi.getTimerCount()).toBe(0); expect(old.eventNames()).toEqual([]); expect(fresh.eventNames()).toEqual([]);
  });

  it("clears the only reconnect timer on stop and never reuses a ticket", async () => {
    let n = 0; const fetchImpl = vi.fn(async () => registration(++n));
    const { adapter } = fixture(fetchImpl); await tick();
    Socket.instances[0].open(); Socket.instances[0].emit("message", frame("disconnect"));
    expect(Socket.instances[0].sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(Socket.instances.map(s => new URL(s.url).searchParams.get("ticket"))).toEqual(["synthetic-ticket-1", "synthetic-ticket-2"]);
    Socket.instances[1].close(); adapter.stop(); await vi.advanceTimersByTimeAsync(100_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });
});

it.each(["stream", "token"])("keeps the existing bounded header timeout and ordinary-error retries for %s", async stage => {
  const fetchImpl = vi.fn((url: string, init: RequestInit) => {
    if (url.includes("/connections/open") && stage === "token") return Promise.resolve(registration());
    return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true }));
  });
  const { adapter, onStatus } = fixture(fetchImpl); await tick();
  const pending = stage === "stream" ? null : outcome(adapter.sendReply("synthetic-user", "hello"));
  await vi.advanceTimersByTimeAsync(93_000);
  expect(fetchImpl).toHaveBeenCalledTimes(stage === "stream" ? 3 : 4);
  if (pending) expect(pending).toMatchObject({ settled: true, error: { name: "DingTalkApiError" } });
  expect(onStatus).toHaveBeenCalledWith("error", expect.stringContaining("timed out after 30000ms"));
  adapter.stop(); expect(vi.getTimerCount()).toBe(0);
});

it("retries ordinary registration faults but does not retry a non-idempotent send", async () => {
  let registrationCalls = 0;
  const fetchImpl = vi.fn(async (url: string) => {
    if (url.includes("/connections/open")) {
      registrationCalls++;
      if (registrationCalls < 3) throw new Error("synthetic ECONNRESET");
      return registration();
    }
    if (url.includes("/oauth2/")) return token();
    throw new Error("synthetic send ECONNRESET");
  });
  const { adapter } = fixture(fetchImpl); await vi.advanceTimersByTimeAsync(3000);
  expect(registrationCalls).toBe(3); expect(Socket.instances).toHaveLength(1);
  await expect(adapter.sendReply("synthetic-user", "hello")).rejects.toThrow("synthetic send ECONNRESET");
  expect(fetchImpl.mock.calls.filter(([url]) => url.includes("/robot/"))).toHaveLength(1);
});

it.each(["token", "send"])("does not commit a late %s body or emit an error after stop-start", async stage => {
  const held = deferred<string>(); releases.push(() => held.resolve(stage === "token" ? JSON.stringify({ access_token: "late-token", expires_in: 7200 }) : "{}"));
  const fetchImpl = vi.fn(async (url: string) => {
    if (url.includes("/connections/open")) return registration();
    if (url.includes("/oauth2/") && stage === "send") return token();
    return { ok: true, status: 200, text: () => held.promise };
  });
  const old = fixture(fetchImpl); await tick();
  const pending = outcome(old.adapter.sendReply("synthetic-user", "你".repeat(5000))); await tick(); old.adapter.stop();
  const fresh = fixture(vi.fn(async () => registration(2))); await tick(); Socket.instances.at(-1)!.open();
  held.resolve(stage === "token" ? JSON.stringify({ access_token: "late-token", expires_in: 7200 }) : "{}"); await tick();
  expect(pending).toMatchObject({ settled: true, error: { name: "AbortError" } });
  expect(old.onStatus.mock.calls).toEqual([["disconnected"]]);
  expect(fetchImpl).toHaveBeenCalledTimes(stage === "token" ? 2 : 3);
  expect(fresh.onStatus.mock.calls.at(-1)).toEqual(["connected"]);
});

it.each([0, 2, 3])("does not ACK or deliver CALLBACK frames from a non-OPEN socket (%s)", async state => {
  const { onMessage } = fixture(vi.fn(async () => registration())); await tick();
  const socket = Socket.instances[0]; socket.readyState = state;
  socket.emit("message", frame()); expect(socket.sent).toEqual([]); expect(onMessage).not.toHaveBeenCalled();
});

it("contains ACK send errors, closes only their socket and reconnects once", async () => {
  const { onMessage, onStatus } = fixture(vi.fn(async () => registration())); await tick();
  const socket = Socket.instances[0]; socket.open();
  socket.send = () => { throw new Error("synthetic ACK failure"); };
  expect(() => socket.emit("message", frame())).not.toThrow();
  expect(onMessage).not.toHaveBeenCalled();
  expect(onStatus).toHaveBeenCalledWith("error", "synthetic ACK failure");
  expect(socket.terminateCalls).toBe(1); expect(vi.getTimerCount()).toBe(1);
});

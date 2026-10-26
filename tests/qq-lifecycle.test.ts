import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface SentFrame { op: number; d?: Record<string, unknown> | number | null }
interface TestSocket extends EventEmitter {
  url: string; options: Record<string, unknown>; readyState: number; sent: SentFrame[]; terminated: number;
  open(): void; send(value: string): void; close(code?: number): void; terminate(): void;
  frame(op: number, data?: unknown, seq?: number, type?: string): void;
}
const transport = vi.hoisted(() => ({ fetch: vi.fn(), sockets: [] as TestSocket[] }));
vi.mock("undici", async original => ({ ...await original<typeof import("undici")>(), fetch: transport.fetch }));
vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  class Socket extends EventEmitter {
    static OPEN = 1; static CLOSED = 3;
    readyState = 0; sent: SentFrame[] = []; terminated = 0;
    constructor(public url: string, public options: Record<string, unknown>) { super(); transport.sockets.push(this); }
    open() { this.readyState = 1; this.emit("open"); }
    send(data: string) { this.sent.push(JSON.parse(data)); }
    close(code = 1000) { this.readyState = 3; this.emit("close", code, Buffer.from("synthetic-private-reason")); }
    terminate() { this.terminated++; this.close(1006); }
    frame(op: number, d?: unknown, s?: number, t?: string) { this.emit("message", Buffer.from(JSON.stringify({ op, d, s, t }))); }
  }
  return { default: Socket };
});
vi.mock("../lib/debug-log.ts", () => ({ debugLog: () => null, createModuleLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
import { createQQAdapter } from "../lib/bridge/qq-adapter.ts";

const adapters: ReturnType<typeof createQQAdapter>[] = [];
const releases: (() => void)[] = [];
const tick = () => vi.advanceTimersByTimeAsync(0);
const token = () => Response.json({ access_token: "synthetic-access-token", expires_in: 7200 });
const gateway = () => Response.json({ url: "wss://synthetic.invalid/qq?ticket=synthetic-ws-secret" });
function fixture() {
  const onStatus = vi.fn(); const onMessage = vi.fn();
  const adapter = createQQAdapter({ appID: "synthetic-app", appSecret: "synthetic-secret", agentId: "synthetic-agent", onMessage, onStatus, dmGuildMap: undefined, onDmGuildDiscovered: undefined });
  adapters.push(adapter); return { adapter, onStatus, onMessage };
}
function hello(socket = transport.sockets.at(-1)) { socket.open(); socket.frame(10, { heartbeat_interval: 60_000 }); return socket; }
function ready(socket = transport.sockets.at(-1), seq = 12) { hello(socket); socket.frame(0, { session_id: "synthetic-session" }, seq, "READY"); return socket; }
beforeEach(() => {
  vi.useFakeTimers(); transport.sockets = [];
  transport.fetch.mockReset().mockImplementation(async (url: string) => url.includes("getAppAccessToken") ? token() : url.endsWith("/gateway") ? gateway() : Response.json({}));
});
afterEach(async () => {
  adapters.splice(0).forEach(a => a.stop()); releases.splice(0).forEach(f => f());
  await tick(); vi.clearAllTimers(); vi.restoreAllMocks(); vi.useRealTimers();
});

describe("QQ lifecycle baseline regressions", () => {
  it.each([4006, 4007])("clears stale session and sequence after %i", async code => {
    fixture(); await tick(); ready().close(code);
    await vi.advanceTimersByTimeAsync(1_000); const next = transport.sockets.at(-1);
    next.open(); next.frame(10, { heartbeat_interval: 1_000 });
    expect(next.sent.at(-1)).toMatchObject({ op: 2 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(next.sent.at(-1)).toEqual({ op: 1, d: null });
  });
  it.each([4914, 4915])("stops all automatic work after terminal %i", async code => {
    const { onStatus } = fixture(); await tick(); ready().close(code);
    const count = transport.fetch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(transport.fetch).toHaveBeenCalledTimes(count);
    expect(onStatus.mock.calls.at(-1)).toEqual(["error", expect.stringContaining(String(code))]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not create a socket when token resolves after stop", async () => {
    let resolve!: (r: Response) => void;
    transport.fetch.mockImplementationOnce(() => new Promise<Response>(r => { resolve = r; }));
    const { adapter } = fixture(); await tick(); adapter.stop(); resolve(token()); await tick();
    expect(transport.sockets).toHaveLength(0);
    expect(transport.fetch).toHaveBeenCalledOnce();
  });
  it("rejects a send after stop before any HTTP", async () => {
    const { adapter } = fixture(); await tick(); adapter.stop(); const count = transport.fetch.mock.calls.length;
    await expect(adapter.sendReply("synthetic-user", "hello", { targetType: "user" })).rejects.toMatchObject({ name: "AbortError" });
    expect(transport.fetch).toHaveBeenCalledTimes(count);
  });
  it("keeps stale socket callbacks from changing the replacement", async () => {
    const { onMessage, onStatus } = fixture(); await tick(); const old = ready();
    const saved = Object.fromEntries(["open", "message", "error", "close"].map(event => [event, (old as EventEmitter).listeners(event)]));
    old.close(4009); await vi.advanceTimersByTimeAsync(1_000); const fresh = hello();
    fresh.frame(0, "", 15, "RESUMED"); const status = onStatus.mock.calls.slice();
    for (const f of saved.message) f(Buffer.from(JSON.stringify({ op: 9, d: false })));
    for (const f of saved.close) f(4915);
    for (const f of saved.open) f();
    for (const f of saved.error) f(new Error("synthetic-secret"));
    expect(fresh.readyState).toBe(1); expect(onMessage).not.toHaveBeenCalled(); expect(onStatus.mock.calls).toEqual(status);
  });
});

function observed(promise: Promise<unknown>) {
  const result: { settled: boolean; error?: unknown; value?: unknown } = { settled: false };
  void promise.then(value => { result.value = value; result.settled = true; }, error => { result.error = error; result.settled = true; });
  return result;
}
function stageFor(url: string) {
  return url.includes("getAppAccessToken") ? "token" : url.endsWith("/gateway") ? "gateway" : "send";
}
function responseFor(stage: string) { return stage === "token" ? token() : stage === "gateway" ? gateway() : Response.json({}); }

describe("QQ official close codes and handshake state", () => {
  it.each([4001, 4002, 4010, 4011, 4012, 4013, 4014, 4914, 4915])("terminates for documented nonretryable %i without exposing the close reason", async code => {
    const { adapter, onStatus } = fixture(); await tick(); const socket = ready(); socket.close(code);
    const calls = transport.fetch.mock.calls.length; await vi.advanceTimersByTimeAsync(3_600_000);
    expect(transport.fetch).toHaveBeenCalledTimes(calls); expect(vi.getTimerCount()).toBe(0);
    expect(onStatus.mock.calls.at(-1)).toEqual(["error", expect.stringContaining(String(code))]);
    expect(JSON.stringify(onStatus.mock.calls)).not.toContain("synthetic-private-reason");
    await expect(adapter.sendMedia("u", "https://synthetic.invalid/file", { kind: "image" })).rejects.toMatchObject({ name: "AbortError" });
    expect(socket.eventNames()).toEqual([]);
  });
  it.each(Array.from({ length: 14 }, (_, i) => 4900 + i))("re-identifies on internal error %i", async code => {
    fixture(); await tick(); ready().close(code); await vi.advanceTimersByTimeAsync(1_000);
    const socket = hello(); expect(socket.sent[0]).toMatchObject({ op: 2 });
  });
  it.each([1000, 1001, 1006, 4009, 4999])("preserves Resume on recoverable or unknown %i (unknown codes use a bounded local policy)", async code => {
    fixture(); await tick(); ready().close(code); await vi.advanceTimersByTimeAsync(1_000);
    expect(hello().sent[0]).toEqual({ op: 6, d: { token: "QQBot synthetic-access-token", session_id: "synthetic-session", seq: 12 } });
  });
  it("waits at least a minute after 4008, then resumes", async () => {
    fixture(); await tick(); ready().close(4008);
    await vi.advanceTimersByTimeAsync(59_999); expect(transport.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); expect(hello().sent[0].op).toBe(6);
  });
  it("refreshes rejected token on 4004 and does not reset the budget merely on open", async () => {
    const { onStatus } = fixture(); await tick();
    const delays = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000, 60_000, 60_000, 60_000, 60_000];
    for (const delay of delays) {
      hello().close(4004); await vi.advanceTimersByTimeAsync(delay);
    }
    hello().close(4004); await tick();
    expect(transport.sockets).toHaveLength(11);
    expect(transport.fetch.mock.calls.filter(([url]) => stageFor(url) === "token")).toHaveLength(11);
    expect(onStatus.mock.calls.at(-1)).toEqual(["error", expect.stringContaining("exhausted")]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["READY", "RESUMED"])("resets the retry budget only at %s and retains the correct session and sequence including zero", async event => {
    const { onStatus } = fixture(); await tick(); const first = ready();
    first.close(4009); await vi.advanceTimersByTimeAsync(1_000);
    hello().close(4009); await vi.advanceTimersByTimeAsync(2_000);
    const socket = hello(); const count = onStatus.mock.calls.filter(([s]) => s === "connected").length;
    expect(count).toBe(1);
    socket.frame(0, event === "READY" ? { session_id: "synthetic-new-session" } : "", event === "READY" ? 0 : 20, event);
    expect(onStatus.mock.calls.at(-1)).toEqual(["connected"]);
    socket.close(4009); await vi.advanceTimersByTimeAsync(999); expect(transport.sockets).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(hello().sent[0]).toMatchObject({ op: 6, d: { session_id: event === "READY" ? "synthetic-new-session" : "synthetic-session", seq: event === "READY" ? 0 : 20 } });
  });
  it.each(["upgrade", "hello", "ready"])("bounds a stalled %s handshake and terminates the socket before reconnect", async stage => {
    fixture(); await tick(); const socket = transport.sockets[0];
    expect(socket.options.handshakeTimeout).toBe(30_000);
    if (stage !== "upgrade") socket.open();
    if (stage === "ready") socket.frame(10, { heartbeat_interval: 60_000 });
    await vi.advanceTimersByTimeAsync(30_000); expect(socket.terminated).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000); expect(transport.sockets).toHaveLength(2);
  });
  it("preserves heartbeat sequence and ACK watchdog and reconnects exactly once on a missing ACK", async () => {
    fixture(); await tick(); const socket = transport.sockets[0]; socket.open();
    socket.frame(10, { heartbeat_interval: 1_000 }); socket.frame(0, { session_id: "s" }, 0, "READY");
    await vi.advanceTimersByTimeAsync(1_000); expect(socket.sent.at(-1)).toEqual({ op: 1, d: 0 });
    socket.frame(11); await vi.advanceTimersByTimeAsync(1_000); expect(socket.terminated).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000); expect(socket.terminated).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000); expect(transport.sockets).toHaveLength(2);
  });
  it.each([[7, undefined, 6], [9, true, 6], [9, false, 2]])("handles op %i with d=%s without a second timer", async (op, data, expected) => {
    fixture(); await tick(); const socket = ready(); socket.frame(op as number, data); socket.frame(op as number, data);
    await vi.advanceTimersByTimeAsync(1_000); expect(transport.sockets).toHaveLength(2); expect(hello().sent[0].op).toBe(expected);
  });
  it("ignores duplicate Hello and suppresses event-ID replays within one adapter while retaining passive sequence", async () => {
    const { adapter, onMessage } = fixture(); await tick(); const socket = ready();
    socket.frame(10, { heartbeat_interval: 10 }); expect(socket.sent).toHaveLength(1);
    const data = { id: "synthetic-event", content: "hi", author: { user_openid: "synthetic-user" } };
    socket.frame(0, data, 13, "C2C_MESSAGE_CREATE"); socket.frame(0, data, 14, "C2C_MESSAGE_CREATE");
    expect(onMessage).toHaveBeenCalledOnce();
    socket.close(4009); await vi.advanceTimersByTimeAsync(1_000); const next = hello();
    expect((next.sent[0].d as { seq: number }).seq).toBe(14); next.frame(0, data, 13, "C2C_MESSAGE_CREATE"); next.frame(0, "", 15, "RESUMED");
    expect(onMessage).toHaveBeenCalledOnce();
    await adapter.sendReply("synthetic-user", "x".repeat(2001), { targetType: "user", messageId: data.id });
    const sent = transport.fetch.mock.calls.filter(([url]) => url.endsWith("/messages"));
    expect(sent.map(([, init]) => JSON.parse(init.body).msg_seq)).toEqual([1, 2]);
  });
});

describe("QQ lifetime cancellation through the real U09 helper", () => {
  it.each(["token", "gateway", "send"])("aborts pending %s headers without late stages", async stage => {
    let heldSignal: AbortSignal | undefined;
    transport.fetch.mockImplementation((url: string, init: RequestInit) => {
      const current = stageFor(url);
      if (current !== stage) return Promise.resolve(responseFor(current));
      heldSignal = init.signal!;
      return new Promise<Response>((resolve, reject) => {
        const abort = () => reject(init.signal!.reason); init.signal!.addEventListener("abort", abort, { once: true });
        releases.push(() => { init.signal!.removeEventListener("abort", abort); resolve(responseFor(current)); });
      });
    });
    const { adapter, onStatus } = fixture(); await tick();
    const pending = stage === "send" ? observed(adapter.sendReply("u", "x".repeat(2001))) : null; await tick();
    adapter.stop(); expect(heldSignal?.aborted).toBe(true); await tick();
    if (pending) expect(pending).toMatchObject({ settled: true, error: { name: "AbortError" } });
    const count = transport.fetch.mock.calls.length; await vi.advanceTimersByTimeAsync(3_600_000);
    expect(transport.fetch).toHaveBeenCalledTimes(count); expect(onStatus.mock.calls.at(-1)).toEqual(["disconnected"]); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["token", "gateway", "send"])("cancels a stalled %s response body and releases its reader", async stage => {
    const cancel = vi.fn(); const body = new ReadableStream<Uint8Array>({ cancel });
    transport.fetch.mockImplementation(async (url: string) => stageFor(url) === stage ? new Response(body) : responseFor(stageFor(url)));
    const { adapter } = fixture(); await tick();
    const pending = stage === "send" ? observed(adapter.sendReply("u", "hi")) : null; await tick(); expect(body.locked).toBe(true);
    adapter.stop(); await tick(); expect(cancel).toHaveBeenCalledOnce(); expect(body.locked).toBe(false);
    if (pending) expect(pending).toMatchObject({ settled: true, error: { name: "AbortError" } });
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["token", "gateway"])("interrupts %s HTTP backoff", async stage => {
    transport.fetch.mockImplementation(async (url: string) => stageFor(url) === stage ? new Response("busy", { status: 503 }) : responseFor(stageFor(url)));
    const { adapter } = fixture(); await tick(); const count = transport.fetch.mock.calls.length;
    adapter.stop(); await vi.advanceTimersByTimeAsync(3_600_000); expect(transport.fetch).toHaveBeenCalledTimes(count); expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels block-send pacing and a reconnect wait", async () => {
    const { adapter } = fixture(); await tick(); ready();
    await adapter.sendBlockReply("u", "first", { targetType: "user" });
    const pending = observed(adapter.sendBlockReply("u", "second", { targetType: "user" })); await tick();
    const count = transport.fetch.mock.calls.length; adapter.stop(); await tick();
    expect(pending).toMatchObject({ settled: true, error: { name: "AbortError" } });
    await vi.advanceTimersByTimeAsync(60_000); expect(transport.fetch).toHaveBeenCalledTimes(count); expect(vi.getTimerCount()).toBe(0);
    const second = fixture(); await tick(); ready().close(4009); second.adapter.stop(); await vi.advanceTimersByTimeAsync(60_000);
    expect(transport.sockets).toHaveLength(2); expect(vi.getTimerCount()).toBe(0);
  });
  it("single-flights initial and hourly token refresh and ignores refresh completion after stop", async () => {
    const { adapter } = fixture(); const sends = [adapter.sendReply("u", "one"), adapter.sendReply("u", "two")];
    await Promise.all(sends); await tick(); const socket = ready();
    expect(transport.fetch.mock.calls.filter(([url]) => stageFor(url) === "token")).toHaveLength(1);
    // Keep the socket healthy during the hourly timer.
    const send = socket.send.bind(socket); socket.send = (raw: string) => { send(raw); if (JSON.parse(raw).op === 1) socket.frame(11); };
    let release!: (r: Response) => void;
    transport.fetch.mockImplementationOnce(() => new Promise<Response>(r => { release = r; }));
    await vi.advanceTimersByTimeAsync(3_600_000); adapter.stop(); release(token()); await tick();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels an in-flight send on disconnect and never carries it into the next connection", async () => {
    const { adapter } = fixture(); await tick(); const socket = ready();
    const cancel = vi.fn(); const body = new ReadableStream<Uint8Array>({ cancel });
    transport.fetch.mockImplementationOnce(async () => new Response(body));
    const pending = observed(adapter.sendReply("u", "x".repeat(2001))); await tick(); socket.close(4009); await tick();
    expect(pending).toMatchObject({ settled: true, error: { name: "AbortError" } }); expect(cancel).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000); hello().frame(0, "", 15, "RESUMED");
    expect(transport.fetch.mock.calls.filter(([url]) => url.endsWith("/messages"))).toHaveLength(1);
  });
  it.each(["reply", "url-media"])("never probes another target after an uncertain %s send", async kind => {
    const { adapter } = fixture(); await tick(); ready();
    transport.fetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/files")) return Response.json({ file_info: "synthetic-file" });
      throw new TypeError("synthetic unknown outcome");
    });
    await expect(kind === "reply" ? adapter.sendReply("u", "hi") : adapter.sendMedia("u", "https://synthetic.invalid/p.png", { kind: "image" })).rejects.toThrow();
    expect(transport.fetch.mock.calls.filter(([url]) => url.endsWith("/messages"))).toHaveLength(1);
  });
});

describe("QQ U11 upload cancellation at every stage", () => {
  let directory: string;
  let file: string;
  beforeEach(async () => {
    const fs = await import("node:fs/promises"); const os = await import("node:os"); const path = await import("node:path");
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "qq-lifecycle-upload-")); file = path.join(directory, "synthetic.png");
    await fs.writeFile(file, "abcdefgh");
    transport.fetch.mockImplementation(async (url: string) => uploadResponse(uploadStage(url)));
  });
  afterEach(async () => { await (await import("node:fs/promises")).rm(directory, { recursive: true, force: true }); });
  function uploadStage(url: string) {
    if (url.includes("/part-")) return "put";
    if (url.endsWith("/upload_prepare")) return "prepare";
    if (url.endsWith("/upload_part_finish")) return "finish";
    if (url.endsWith("/files")) return "merge";
    return stageFor(url);
  }
  function uploadResponse(stage: string): Response {
    if (stage === "prepare") return Response.json({
      upload_id: "synthetic-upload", block_size: "4",
      parts: [0, 1].map(index => ({ index, block_size: "4", presigned_url: `https://storage.synthetic.invalid/part-${index}?signature=synthetic-signed-secret` })),
      upload_config: { concurrency: 2, retry_timeout: 3, retry_delay: 1 },
    });
    if (stage === "merge") return Response.json({ file_info: "synthetic-file-info" });
    if (stage === "put" || stage === "finish") return new Response("");
    return responseFor(stage);
  }
  it.each(["prepare", "put", "finish", "merge", "send"])("stops during pending %s headers, aborts siblings, closes the file and never sends twice", async stage => {
    const { adapter } = fixture(); await tick(); ready(); let started = 0; const signals: AbortSignal[] = [];
    transport.fetch.mockImplementation((url: string, init: RequestInit) => {
      if (uploadStage(url) !== stage) return Promise.resolve(uploadResponse(uploadStage(url)));
      started++; signals.push(init.signal!);
      return new Promise<Response>((resolve, reject) => {
        const abort = () => reject(init.signal!.reason); init.signal!.addEventListener("abort", abort, { once: true });
        releases.push(() => { init.signal!.removeEventListener("abort", abort); resolve(uploadResponse(stage)); });
      });
    });
    const pending = observed(adapter.sendMediaFile("u", file, { kind: "image", isGroup: false }));
    await vi.waitFor(() => expect(started).toBeGreaterThan(0)); adapter.stop();
    await vi.waitFor(() => expect(pending.settled).toBe(true)); expect(pending.error).toMatchObject({ name: "AbortError" });
    expect(signals.every(s => s.aborted)).toBe(true);
    const calls = transport.fetch.mock.calls.length; await vi.advanceTimersByTimeAsync(60_000);
    expect(transport.fetch).toHaveBeenCalledTimes(calls); expect(vi.getTimerCount()).toBe(0);
    expect(transport.fetch.mock.calls.filter(([url]) => uploadStage(url) === "send")).toHaveLength(stage === "send" ? 1 : 0);
  });
  it.each(["prepare", "finish", "merge", "send"])("stops while reading %s body with no reader or later-message residue", async stage => {
    const { adapter } = fixture(); await tick(); ready(); const bodies: ReadableStream[] = []; const cancels: ReturnType<typeof vi.fn>[] = [];
    transport.fetch.mockImplementation(async (url: string) => {
      if (uploadStage(url) !== stage) return uploadResponse(uploadStage(url));
      const cancel = vi.fn(); const body = new ReadableStream<Uint8Array>({ cancel }); bodies.push(body); cancels.push(cancel); return new Response(body);
    });
    const pending = observed(adapter.sendMediaFile("u", file, { kind: "image" }));
    await vi.waitFor(() => expect(bodies.some(b => b.locked)).toBe(true)); adapter.stop();
    await vi.waitFor(() => expect(pending.settled).toBe(true));
    expect(pending.error).toMatchObject({ name: "AbortError" }); expect(bodies.every(b => !b.locked)).toBe(true);
    for (const cancel of cancels) expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(transport.fetch.mock.calls.filter(([url]) => uploadStage(url) === "send")).toHaveLength(stage === "send" ? 1 : 0);
  });
  it.each(["put", "finish"])("cancels %s retry backoff without any retry or merge", async stage => {
    const { adapter } = fixture(); await tick(); ready(); let hits = 0;
    transport.fetch.mockImplementation(async (url: string) => {
      if (uploadStage(url) === stage) { hits++; return stage === "put" ? new Response("busy", { status: 503 }) : Response.json({ code: 40093001 }); }
      return uploadResponse(uploadStage(url));
    });
    const pending = observed(adapter.sendMediaFile("u", file, { kind: "image" }));
    await vi.waitFor(() => expect(hits).toBe(2)); adapter.stop(); await vi.waitFor(() => expect(pending.settled).toBe(true));
    const calls = transport.fetch.mock.calls.length; await vi.advanceTimersByTimeAsync(60_000);
    expect(transport.fetch).toHaveBeenCalledTimes(calls); expect(pending.error).toMatchObject({ name: "AbortError" }); expect(vi.getTimerCount()).toBe(0);
    expect(transport.fetch.mock.calls.some(([url]) => ["merge", "send"].includes(uploadStage(url)))).toBe(false);
  });
  it.each(["stop", "disconnect", "caller"])("cancels at a successful merge boundary via %s before the final media message", async action => {
    const { adapter } = fixture(); await tick(); const socket = ready(); const caller = new AbortController();
    transport.fetch.mockImplementation(async (url: string) => {
      const stage = uploadStage(url);
      if (stage === "merge") {
        if (action === "stop") adapter.stop(); else if (action === "disconnect") socket.close(4009); else caller.abort();
      }
      return uploadResponse(stage);
    });
    const pending = observed(adapter.sendMediaFile("u", file, { kind: "image", signal: caller.signal }));
    await vi.waitFor(() => expect(pending.settled).toBe(true)); expect(pending.error).toMatchObject({ name: "AbortError" });
    expect(transport.fetch.mock.calls.filter(([url]) => uploadStage(url) === "merge")).toHaveLength(1);
    expect(transport.fetch.mock.calls.some(([url]) => uploadStage(url) === "send")).toBe(false);
    if (action === "disconnect") {
      await vi.advanceTimersByTimeAsync(1_000); hello().frame(0, "", 20, "RESUMED");
      expect(transport.fetch.mock.calls.some(([url]) => uploadStage(url) === "send")).toBe(false);
    }
  });
  it("rejects a pre-aborted upload before opening its file or starting HTTP", async () => {
    const { adapter } = fixture(); await tick(); const caller = new AbortController(); caller.abort(); const calls = transport.fetch.mock.calls.length;
    await expect(adapter.sendMediaFile("u", "/nonexistent/synthetic.png", { kind: "image", signal: caller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(transport.fetch).toHaveBeenCalledTimes(calls);
  });
});

it("retires an error-only socket and schedules only one reconnect across its later close", async () => {
  const { adapter, onStatus } = fixture(); await tick(); const socket = ready(); const lateClose = socket.listeners("close").slice();
  socket.emit("error", new Error(`failed ${socket.url} synthetic-secret synthetic-access-token synthetic-session`));
  expect(socket.terminated).toBe(1); expect(socket.eventNames()).toEqual([]);
  for (const f of lateClose) f(4009);
  await vi.advanceTimersByTimeAsync(999); expect(transport.sockets).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1); expect(transport.sockets).toHaveLength(2);
  expect(JSON.stringify(onStatus.mock.calls)).not.toMatch(/synthetic-secret|synthetic-access-token|synthetic-session|synthetic-ws-secret/);
  adapter.stop(); await tick(); expect(vi.getTimerCount()).toBe(0);
});

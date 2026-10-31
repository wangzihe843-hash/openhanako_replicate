import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { EventEmitter } from "node:events";
import type { FeishuCallFrame, FeishuParentFrame, FeishuProxySnapshot } from "../lib/bridge/feishu-worker-protocol.ts";

type MockWorkerOptions = { workerData: { generation: string }; stdout: boolean; stderr: boolean };
type MockWorker = EventEmitter & {
  stdout: EventEmitter; stderr: EventEmitter; sent: FeishuParentFrame[];
  sequence: number; autoExit: boolean; url: URL; options: MockWorkerOptions;
  postMessage: Mock<(frame: FeishuParentFrame) => void>;
  terminate: Mock<() => Promise<number>>;
  frame: (type: string, extra?: Record<string, unknown>) => void;
};
type ProxyListener = (snapshot: FeishuProxySnapshot) => void;
const fixture = vi.hoisted((): {
  workers: MockWorker[]; diagnostics: string[]; listeners: Set<ProxyListener>;
  version: number; config: FeishuProxySnapshot["config"]; constructorError: Error | null;
} => ({ workers: [], diagnostics: [], listeners: new Set(), version: 0, config: { mode: "direct" }, constructorError: null }));
vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  class Worker extends EventEmitter {
    stdout = new EventEmitter(); stderr = new EventEmitter();
    sent: FeishuParentFrame[] = []; sequence = 0; autoExit = true;
    postMessage = vi.fn((frame: FeishuParentFrame) => { this.sent.push(structuredClone(frame)); });
    terminate = vi.fn(() => {
      if (this.autoExit) queueMicrotask(() => this.emit("exit", 1));
      return Promise.resolve(1);
    });
    constructor(public url: URL, public options: MockWorkerOptions) {
      super();
      if (fixture.constructorError) throw fixture.constructorError;
      fixture.workers.push(this);
    }
    frame(type: string, extra = {}) { this.emit("message", { v: 1, generation: this.options.workerData.generation, seq: ++this.sequence, type, ...extra }); }
  }
  return { Worker };
});
vi.mock("../lib/net/outbound-proxy.ts", () => ({
  getOutboundProxySnapshot: () => ({ version: fixture.version, config: fixture.config }),
  subscribeOutboundProxyConfig: (listener: ProxyListener) => { fixture.listeners.add(listener); return () => fixture.listeners.delete(listener); },
}));
vi.mock("../lib/debug-log.ts", () => ({
  debugLog: () => null,
  createModuleLogger: () => Object.fromEntries(["log", "warn", "error"].map(level => [level, (...args: unknown[]) => fixture.diagnostics.push(args.join(" "))])),
}));
import { createFeishuWorkerAdapter, resolveFeishuWorkerUrl } from "../lib/bridge/feishu-worker-adapter.ts";
import { FEISHU_RPC_TIMEOUT_MS, FEISHU_EXIT_TIMEOUT_MS } from "../lib/bridge/feishu-worker-protocol.ts";

const adapters: ReturnType<typeof createFeishuWorkerAdapter>[] = [];
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
type AdapterOptions = Partial<Parameters<typeof createFeishuWorkerAdapter>[0]>;
function create(options: AdapterOptions = {}) {
  const adapter = createFeishuWorkerAdapter({ appId: "synthetic-app", appSecret: "secret-sentinel", agentId: "synthetic-agent", onMessage: vi.fn(), ...options });
  adapters.push(adapter); return adapter;
}
async function running(options: AdapterOptions = {}) {
  const adapter = create(options); await tick();
  const worker = fixture.workers.at(-1); worker.frame("ready"); return { adapter, worker };
}
function calls(worker: MockWorker) {
  return worker.sent.filter((frame): frame is FeishuCallFrame => frame.type === "call");
}
function bytes(value: unknown) {
  if (!(value instanceof Uint8Array)) throw new Error("Expected cloned media bytes");
  return value;
}
beforeEach(() => { fixture.workers.length = 0; fixture.diagnostics.length = 0; fixture.listeners.clear(); fixture.version = 0; fixture.config = { mode: "direct" }; fixture.constructorError = null; });
afterEach(async () => {
  for (const worker of fixture.workers) { worker.autoExit = true; worker.emit("exit", 1); }
  await Promise.allSettled(adapters.splice(0).map(adapter => adapter.stop()));
  vi.useRealTimers();
});

describe("Feishu worker binding lifecycle", () => {
  it("keeps the fixed source entry and factory lazy; stop before init creates no worker", async () => {
    expect(fixture.workers).toHaveLength(0);
    expect(resolveFeishuWorkerUrl().pathname).toMatch(/\/lib\/bridge\/feishu-worker\.ts$/);
    const adapter = create();
    await adapter.stop(); await tick();
    expect(fixture.workers).toHaveLength(0);
    await expect(adapter.sendReply("chat", "after stop")).rejects.toMatchObject({ deliveryUnknown: false });
  });
  it("waits physical previous exit; a stopped replacement never starts", async () => {
    let release!: () => void;
    const previous = new Promise<void>(resolve => { release = resolve; });
    const a = create({ waitForPreviousExit: previous });
    const b = create({ waitForPreviousExit: previous });
    await tick(); expect(fixture.workers).toHaveLength(0);
    await a.stop(); release(); await tick();
    expect(fixture.workers).toHaveLength(1);
    expect(b.stop()).toBe(b.stop());
  });
  it("does not start after a rejected predecessor and reports a sanitized failure", async () => {
    const onStatus = vi.fn();
    create({ onStatus, waitForPreviousExit: Promise.reject(new Error("secret-sentinel")) });
    await tick(); expect(fixture.workers).toHaveLength(0);
    expect(onStatus).toHaveBeenCalledWith("error", "[redacted]");
  });
  it("invalidates immediately, rejects pending once, and resolves stop only after exit", async () => {
    const { adapter, worker } = await running(); worker.autoExit = false;
    const rejected = vi.fn(); const result = adapter.sendReply("chat", "hello").catch(rejected);
    const stop = adapter.stop(); expect(adapter.stop()).toBe(stop);
    let closed = false; void stop.then(() => { closed = true; });
    await tick(); expect(closed).toBe(false); expect(rejected).toHaveBeenCalledOnce();
    worker.frame("result", { id: 1, value: "late" });
    worker.emit("exit", 1); await stop; await result;
    expect(rejected).toHaveBeenCalledOnce(); expect(fixture.listeners.size).toBe(0);
    expect(worker.listenerCount("message")).toBe(0);
  });
  it.each(["error", "messageerror", "exit"])("fails the binding on worker %s without replay", async event => {
    const { adapter, worker } = await running();
    const write = adapter.sendReply("chat", "hello").catch(error => error);
    const read = adapter.downloadFile("message", "file").catch(error => error);
    worker.emit(event, event === "exit" ? 7 : new Error("secret-sentinel"));
    expect(await write).toMatchObject({ deliveryUnknown: true });
    expect(await read).toMatchObject({ deliveryUnknown: false });
    await adapter.stop(); expect(calls(worker)).toHaveLength(2);
  });
  it("fails before dispatch when the fixed Worker entry cannot be constructed", async () => {
    fixture.constructorError = Object.assign(new Error("synthetic Worker entry is missing"), { code: "MODULE_NOT_FOUND" });
    const onStatus = vi.fn(); const adapter = create({ onStatus });
    const write = adapter.sendReply("chat", "queued").catch(error => error);
    await tick();
    expect(fixture.workers).toHaveLength(0);
    expect(onStatus).toHaveBeenCalledWith("error", "synthetic Worker entry is missing");
    expect(await write).toMatchObject({ deliveryUnknown: false });
    await adapter.stop(); expect(fixture.listeners.size).toBe(0);
  });
  it("preserves a rejected terminate promise and clears its deadline without claiming exit", async () => {
    vi.useFakeTimers(); const { adapter, worker } = await running(); worker.autoExit = false;
    worker.terminate.mockRejectedValueOnce(new Error("secret-sentinel"));
    const stop = adapter.stop();
    await expect(stop).rejects.toMatchObject({ code: "FEISHU_WORKER_TERMINATE_FAILED" });
    expect(vi.getTimerCount()).toBe(0); expect(adapter.stop()).toBe(stop);
    worker.emit("exit", 1);
    await expect(adapter.stop()).rejects.toMatchObject({ code: "FEISHU_WORKER_TERMINATE_FAILED" });
  });
  it("does not label a write still queued before ready as delivered", async () => {
    const adapter = create(); await tick();
    const result = adapter.sendReply("chat", "queued").catch(error => error);
    await adapter.stop(); expect(await result).toMatchObject({ deliveryUnknown: false });
    expect(calls(fixture.workers[0])).toHaveLength(0);
  });
  it("hard RPC deadline terminates the whole binding including concurrent read", async () => {
    vi.useFakeTimers(); const { adapter, worker } = await running();
    const write = adapter.sendReply("chat", "pending").catch(error => error);
    const read = adapter.downloadFile("message", "file").catch(error => error);
    await vi.advanceTimersByTimeAsync(FEISHU_RPC_TIMEOUT_MS);
    expect(await write).toMatchObject({ code: "FEISHU_WORKER_TIMEOUT", deliveryUnknown: true });
    expect(await read).toMatchObject({ code: "FEISHU_WORKER_TIMEOUT", deliveryUnknown: false });
    expect(worker.terminate).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps a failed termination barrier rejected rather than declaring cleanup", async () => {
    vi.useFakeTimers(); const { adapter, worker } = await running(); worker.autoExit = false;
    const result = adapter.stop().catch(error => error);
    await vi.advanceTimersByTimeAsync(FEISHU_EXIT_TIMEOUT_MS);
    expect(await result).toMatchObject({ code: "FEISHU_WORKER_EXIT_TIMEOUT" });
    worker.emit("exit", 1);
    await expect(adapter.stop()).rejects.toMatchObject({ code: "FEISHU_WORKER_EXIT_TIMEOUT" });
  });
  it("drops stale generation and duplicate event IDs while callback does not block RPC", async () => {
    const onMessage = vi.fn(() => new Promise<never>(() => { /* The parent engine turn deliberately remains pending. */ }));
    const { adapter, worker } = await running({ onMessage });
    worker.frame("message", { generation: "old", message: { text: "old" } });
    worker.frame("message", { message: { text: "current" } });
    worker.frame("message", { seq: worker.sequence, message: { text: "duplicate" } });
    expect(onMessage).toHaveBeenCalledTimes(1);
    const sent = adapter.sendReply("chat", "reply while callback pending");
    worker.frame("result", { id: calls(worker).at(-1).id }); await sent;
  });
});

describe("Feishu worker protocol state, bytes and diagnostics", () => {
  it("releases only owned handles once after already dispatched updates", async () => {
    const { adapter, worker } = await running();
    const other = await running();
    const started = adapter.startStreamReply("chat", "hello");
    worker.frame("result", { id: 1, streamId: 17, value: { messageId: "message" } });
    const state = await started;
    other.adapter.releaseStreamReply(state);
    adapter.releaseStreamReply({ ...state });
    expect(worker.sent.filter(frame => frame.type === "release")).toHaveLength(0);
    const update = adapter.updateStreamReply("chat", state, "updated");
    adapter.releaseStreamReply(state);
    adapter.releaseStreamReply(state);
    expect(worker.sent.slice(-2)).toMatchObject([{ type: "call", streamId: 17 }, { type: "release", streamId: 17 }]);
    expect(worker.sent.filter(frame => frame.type === "release")).toHaveLength(1);
    worker.frame("result", { id: 2 });
    await update;
    await expect(adapter.updateStreamReply("chat", state, "late")).rejects.toMatchObject({ code: "FEISHU_STREAM_INVALID" });
    await adapter.stop();
    expect(() => adapter.releaseStreamReply(state)).not.toThrow();
  });
  it("fails the binding without throwing from release when its frame cannot be sent", async () => {
    const { adapter, worker } = await running();
    const started = adapter.startStreamReply("chat", "hello");
    worker.frame("result", { id: 1, streamId: 17, value: { messageId: "message" } });
    const state = await started;
    const pending = adapter.sendReply("chat", "pending").catch(error => error);
    worker.postMessage.mockImplementationOnce(() => { throw new Error("secret-sentinel"); });
    expect(() => adapter.releaseStreamReply(state)).not.toThrow();
    expect(await pending).toMatchObject({ deliveryUnknown: true });
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(fixture.diagnostics.join(" ")).not.toContain("secret-sentinel");
  });
  it("updates the caller's stream state on success and error without sending stale copies back", async () => {
    const { adapter, worker } = await running();
    const started = adapter.startRichStreamReply("chat", "hello");
    worker.frame("result", { id: 1, streamId: 17, value: { cardId: "card", elementId: "element", sequence: 2 } });
    const state = await started;
    const update = adapter.updateRichStreamReply("chat", state, "updated").catch(error => error);
    expect(calls(worker)[1]).toMatchObject({ streamId: 17, args: ["chat", null, "updated"] });
    worker.frame("result", { id: 2, state: { ...state, sequence: 3 }, error: { name: "FeishuBusinessError", message: "rejected", code: 42 } });
    expect(await update).toMatchObject({ code: 42 }); expect(state.sequence).toBe(3);
    await expect(adapter.updateRichStreamReply("chat", { ...state }, "forged")).rejects.toMatchObject({ code: "FEISHU_STREAM_INVALID" });
  });
  it("copies only the supplied Buffer view and returns a Buffer without detaching caller data", async () => {
    const { adapter, worker } = await running(); const backing = Buffer.from("prefixIMAGEsuffix"); const view = backing.subarray(6, 11);
    const send = adapter.sendMediaBuffer("chat", view, { mime: "image/png" });
    expect(Buffer.from(bytes(calls(worker)[0].args[1])).toString()).toBe("IMAGE"); expect(backing.toString()).toBe("prefixIMAGEsuffix");
    worker.frame("result", { id: 1 }); await send;
    const download = adapter.downloadFile("message", "file"); worker.frame("result", { id: 2, value: new Uint8Array([1, 2, 3]) });
    expect(Buffer.isBuffer(await download)).toBe(true);
    await expect(adapter.sendMediaBuffer("chat", Buffer.alloc(10 * 1024 * 1024 + 1), { mime: "image/png" })).rejects.toThrow("10 MiB");
  });
  it("bounds queued calls and removes every request on stop", async () => {
    const adapter = create(); await tick();
    const results = Array.from({ length: 64 }, () => adapter.sendReply("chat", "pending").catch(error => error));
    await expect(adapter.sendReply("chat", "overflow")).rejects.toMatchObject({ code: "FEISHU_QUEUE_FULL" });
    await adapter.stop(); expect(await Promise.all(results)).toHaveLength(64);
  });
  it("forwards monotonic effective proxy snapshots and unsubscribes on stop", async () => {
    const { adapter, worker } = await running();
    for (const listener of fixture.listeners) {
      listener({ version: 2, config: { mode: "direct" } });
      listener({ version: 1, config: { mode: "manual", httpProxy: "http://old.invalid" } });
    }
    expect(worker.sent.filter(f => f.type === "config").map(f => f.snapshot.version)).toEqual([2]);
    await adapter.stop(); expect(fixture.listeners.size).toBe(0);
  });
  it("drops arbitrary raw stdout chunks and redacts structured diagnostics/errors", async () => {
    const onStatus = vi.fn(); const { adapter, worker } = await running({ onStatus });
    expect(worker.options).toMatchObject({ stdout: true, stderr: true });
    worker.stdout.emit("data", Buffer.from("secret-")); worker.stdout.emit("data", Buffer.from("sentinel"));
    worker.stderr.emit("data", Buffer.alloc(100_000, "x"));
    worker.frame("log", { level: "error", message: "secret-sentinel Authorization: Bearer token-sentinel" });
    worker.frame("status", { status: "error", error: "secret-sentinel" });
    const result = adapter.sendReply("chat", "hello").catch(error => error);
    worker.frame("result", { id: 1, error: { name: "FeishuMessageTooLargeError", message: "too large", code: "FEISHU_MESSAGE_TOO_LARGE", operation: "create", actualBytes: 30001, maxBytes: 30000, config: { appSecret: "secret-sentinel" }, cause: { headers: "token-sentinel" } } });
    expect(await result).toMatchObject({ code: "FEISHU_MESSAGE_TOO_LARGE", actualBytes: 30001, maxBytes: 30000 });
    expect(await result).not.toHaveProperty("config"); expect(await result).not.toHaveProperty("cause");
    expect(JSON.stringify([fixture.diagnostics, onStatus.mock.calls])).not.toMatch(/secret-sentinel|token-sentinel|x{10}/);
  });
});

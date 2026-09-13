import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChatRoute } from "../server/routes/chat.ts";
import { AgentReviewTurnCoordinator } from "../lib/agent-review/turn-coordinator.ts";
import { errorBus } from "../shared/error-bus.ts";

type Payload = Record<string, unknown>;
type Socket = { readyState: number; send: ReturnType<typeof vi.fn> };
type Handlers = {
  onOpen: (event: object, ws: Socket) => void;
  onMessage: (event: { data: string }, ws: Socket) => void;
  onClose: (event: object, ws: Socket) => void;
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const closeRoutes: Array<() => void> = [];
function mount(streaming = true) {
  let factory!: (context: object) => Handlers;
  let subscriber!: (event: Payload, path: string) => void;
  const sessionPath = "/test/abort-errors.jsonl";
  const hub = {
    subscribe: vi.fn((fn: typeof subscriber) => { subscriber = fn; }),
    send: vi.fn(async () => undefined),
    abort: vi.fn(async () => false),
    eventBus: { emit: vi.fn() },
  };
  const engine = {
    agentName: "Hana",
    abortAllStreaming: vi.fn(async () => undefined),
    getSessionByPath: vi.fn(() => ({ entries: [] })),
    isSessionStreaming: vi.fn(() => false),
    isSessionSwitching: vi.fn(() => false),
    steerSession: vi.fn(() => false),
    slashDispatcher: null,
  };
  createChatRoute(engine, hub, { upgradeWebSocket: (fn: typeof factory) => {
    factory = fn;
    return () => new Response(null);
  } });
  const ws = { readyState: 1, send: vi.fn() };
  const handlers = factory({});
  handlers.onOpen({}, ws);
  closeRoutes.push(() => handlers.onClose({}, ws));
  const events = (): Payload[] => ws.send.mock.calls.map(([raw]) => JSON.parse(String(raw)) as Payload);
  const emit = (event: Payload) => subscriber(event, sessionPath);
  const start = () => {
    emit({ type: "session_status", isStreaming: true });
    return events().filter(e => e.type === "status" && e.isStreaming === true).at(-1)?.streamId;
  };
  const abort = (streamId: unknown = startId) => handlers.onMessage({
    data: JSON.stringify({ type: "abort", sessionPath, streamId }),
  }, ws);
  const startId = streaming ? start() : null;
  ws.send.mockClear();
  return { hub, emit, start, abort, events, ws, startId };
}
const results = (fixture: ReturnType<typeof mount>) => fixture.events().filter(e => e.type === "abort_result");

beforeEach(() => {
  vi.stubEnv("HANA_WS_DISCONNECT_ABORT_GRACE_MS", "0");
  vi.stubEnv("HANA_TURN_STALL_ABORT_MS", "0");
  vi.spyOn(AgentReviewTurnCoordinator.prototype, "cancelByParent").mockResolvedValue(false);
  vi.spyOn(errorBus, "report").mockImplementation(() => undefined);
});
afterEach(() => {
  for (const close of closeRoutes.splice(0)) close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("chat abort failure contract", () => {
  it.each([false, true])("reports review failure and still attempts hub cancellation (hub=%s)", async accepted => {
    const error = new Error("review cancel failed");
    vi.mocked(AgentReviewTurnCoordinator.prototype.cancelByParent).mockRejectedValue(error);
    const f = mount();
    f.hub.abort.mockResolvedValue(accepted);
    f.abort();
    await vi.waitFor(() => expect(results(f)).toHaveLength(1));
    expect(f.hub.abort).toHaveBeenCalledTimes(1);
    expect(results(f)[0]).toMatchObject({ status: "rejected", reason: "cancel_failed", streamId: f.startId });
    expect(errorBus.report).toHaveBeenCalledWith(error, expect.objectContaining({ context: expect.objectContaining({ operation: "cancelByParent" }) }));
    expect(f.events()).toContainEqual(expect.objectContaining({ type: "error", code: "abort_failed" }));
    expect(f.events().some(e => e.type === "status" && e.isStreaming === false)).toBe(false);
  });

  it("reports both failures and restores isAborted so an ordinary empty turn still reports an error", async () => {
    const reviewError = new Error("review failed");
    const hubError = new Error("hub failed");
    vi.mocked(AgentReviewTurnCoordinator.prototype.cancelByParent).mockRejectedValue(reviewError);
    const f = mount();
    f.hub.abort.mockRejectedValue(hubError);
    f.abort();
    await vi.waitFor(() => expect(results(f)).toHaveLength(1));
    expect(errorBus.report).toHaveBeenCalledTimes(2);
    expect(results(f)[0]).toMatchObject({ status: "rejected", reason: "cancel_failed" });
    f.ws.send.mockClear();
    f.emit({ type: "turn_end" });
    expect(f.events()).toContainEqual(expect.objectContaining({ type: "error" }));
  });

  it("a hub exception leaves the stream alive and allows a later stop retry", async () => {
    const f = mount();
    f.hub.abort.mockRejectedValueOnce(new Error("hub failed")).mockResolvedValueOnce(true);
    f.abort();
    await vi.waitFor(() => expect(results(f)).toHaveLength(1));
    expect(results(f)[0]).toMatchObject({ status: "rejected", reason: "cancel_failed" });
    f.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "still running" } });
    expect(f.events()).toContainEqual(expect.objectContaining({ type: "text_delta", streamId: f.startId }));
    f.abort();
    await vi.waitFor(() => expect(results(f)).toHaveLength(2));
    expect(results(f)[1]).toMatchObject({ status: "accepted" });
  });

  it("coalesces concurrent failed stops and restores the original abort flag", async () => {
    const pending = deferred<boolean>();
    const f = mount();
    f.hub.abort.mockReturnValue(pending.promise);
    f.abort();
    f.abort();
    await vi.waitFor(() => expect(f.hub.abort).toHaveBeenCalledTimes(1));
    pending.reject(new Error("cancel failed"));
    await vi.waitFor(() => expect(results(f)).toHaveLength(2));
    expect(results(f).every(e => e.reason === "cancel_failed")).toBe(true);
    f.ws.send.mockClear();
    f.emit({ type: "turn_end" });
    expect(f.events()).toContainEqual(expect.objectContaining({ type: "error" }));
  });

  it("does not leave an abort marker after a failure without an active stream", async () => {
    const f = mount(false);
    f.hub.abort.mockRejectedValue(new Error("idle cleanup failed"));
    f.abort();
    await vi.waitFor(() => expect(results(f)).toHaveLength(1));
    expect(results(f)[0]).toMatchObject({ status: "rejected", reason: "cancel_failed" });
    f.ws.send.mockClear();
    f.emit({ type: "turn_end" });
    expect(f.events()).toContainEqual(expect.objectContaining({ type: "error" }));
  });

  it("coalesces concurrent successful stops and acknowledges both requests", async () => {
    const pending = deferred<boolean>();
    const f = mount();
    f.hub.abort.mockReturnValue(pending.promise);
    f.abort();
    f.abort();
    await vi.waitFor(() => expect(f.hub.abort).toHaveBeenCalledTimes(1));
    pending.resolve(true);
    await vi.waitFor(() => expect(results(f)).toHaveLength(2));
    expect(results(f).every(e => e.status === "accepted")).toBe(true);
  });

  it("does not finish a new stream when an old hub stop resolves false", async () => {
    const pending = deferred<boolean>();
    const f = mount();
    f.hub.abort.mockReturnValue(pending.promise);
    f.abort();
    await vi.waitFor(() => expect(f.hub.abort).toHaveBeenCalledTimes(1));
    f.emit({ type: "turn_end", aborted: true });
    const nextId = f.start();
    pending.resolve(false);
    await vi.waitFor(() => expect(results(f)).toHaveLength(1));
    expect(results(f)[0]).toMatchObject({ status: "rejected", reason: "stale_stream" });
    expect(f.events().some(e => e.type === "status" && e.isStreaming === false && e.streamId === nextId)).toBe(false);
  });

  it("does not clear a prior accepted abort flag when a second stop fails", async () => {
    const f = mount();
    f.hub.abort.mockResolvedValueOnce(true).mockRejectedValueOnce(new Error("second stop failed"));
    f.abort();
    await vi.waitFor(() => expect(results(f)).toHaveLength(1));
    f.abort();
    await vi.waitFor(() => expect(results(f)).toHaveLength(2));
    f.ws.send.mockClear();
    f.emit({ type: "turn_end" });
    expect(f.events().some(e => e.type === "error")).toBe(false);
  });

  it("keeps accepted cancellation compatible with synchronous terminal events", async () => {
    const f = mount();
    f.hub.abort.mockImplementation(async () => { f.emit({ type: "turn_end" }); return true; });
    f.abort();
    await vi.waitFor(() => expect(results(f)).toHaveLength(1));
    expect(results(f)[0]).toMatchObject({ status: "accepted" });
    expect(f.events().some(e => e.type === "error")).toBe(false);
  });

  it("keeps review success and repeated already-stopped requests compatible", async () => {
    const f = mount();
    vi.mocked(AgentReviewTurnCoordinator.prototype.cancelByParent).mockResolvedValueOnce(true);
    f.abort();
    await vi.waitFor(() => expect(results(f)).toHaveLength(1));
    expect(results(f)[0]).toMatchObject({ status: "accepted" });
    expect(f.hub.abort).not.toHaveBeenCalled();
    f.abort();
    await vi.waitFor(() => expect(results(f)).toHaveLength(2));
    expect(results(f)[1]).toMatchObject({ status: "already_stopped" });
    f.abort();
    await vi.waitFor(() => expect(results(f)).toHaveLength(3));
    expect(results(f)[2]).toMatchObject({ status: "already_stopped" });
    f.ws.send.mockClear();
    f.emit({ type: "turn_end" });
    expect(f.events().some(e => e.type === "error")).toBe(false);
  });

  it("rejects stale requests without calling either canceller", async () => {
    const f = mount();
    f.abort("old-stream");
    await vi.waitFor(() => expect(results(f)).toHaveLength(1));
    expect(results(f)[0]).toMatchObject({ status: "rejected", reason: "stale_stream" });
    expect(f.events()).toContainEqual(expect.objectContaining({ type: "abort_rejected", reason: "stale_stream" }));
    expect(f.hub.abort).not.toHaveBeenCalled();
    expect(AgentReviewTurnCoordinator.prototype.cancelByParent).not.toHaveBeenCalled();
  });

  it("does not send an old fallback cancellation to a replacement stream", async () => {
    const pending = deferred<boolean>();
    vi.mocked(AgentReviewTurnCoordinator.prototype.cancelByParent).mockReturnValueOnce(pending.promise);
    const f = mount();
    f.abort();
    f.emit({ type: "turn_end", aborted: true });
    const nextId = f.start();
    expect(nextId).not.toBe(f.startId);
    pending.resolve(false);
    await vi.waitFor(() => expect(results(f)).toHaveLength(1));
    expect(f.hub.abort).not.toHaveBeenCalled();
    expect(results(f)[0]).toMatchObject({ status: "rejected", reason: "stale_stream" });
    expect(f.events().some(e => e.type === "status" && e.isStreaming === false && e.streamId === nextId)).toBe(false);
  });

  it("does not roll back a replacement stream's accepted abort after an old failure", async () => {
    const pending = deferred<boolean>();
    const f = mount();
    f.hub.abort.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(true);
    f.abort();
    await vi.waitFor(() => expect(f.hub.abort).toHaveBeenCalledTimes(1));
    f.emit({ type: "turn_end", aborted: true });
    const nextId = f.start();
    f.abort(nextId);
    await vi.waitFor(() => expect(results(f)).toHaveLength(1));
    pending.reject(new Error("old abort failed"));
    await vi.waitFor(() => expect(results(f)).toHaveLength(2));
    f.ws.send.mockClear();
    f.emit({ type: "turn_end" });
    expect(f.events().some(e => e.type === "error")).toBe(false);
  });
});
